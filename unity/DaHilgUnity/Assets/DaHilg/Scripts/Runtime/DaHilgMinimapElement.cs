using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.RegularExpressions;
using UnityEngine;
using UnityEngine.UIElements;

namespace DaHilg
{
    public sealed class DaHilgMinimapElement : VisualElement
    {
        // Draw the FULL road/walk network: subsampling (the old 180/450 stride) chopped ~3000 road
        // segments into disconnected dashes that read as "dots, not streets". A 2D minimap can afford
        // to stroke them all.
        const int k_MaxSegmentsPerLayer = 6000;
        const int k_DiskSides = 14;
        const int k_RoadTextureWidth = 384;
        const float k_MinimapZoomDivisor = 3.25f;
        static readonly Vector2[] s_DiskPoints = new Vector2[k_DiskSides];

        readonly Label m_Title;
        readonly Label m_Legend;
        readonly VisualElement m_MapArea;   // holds the solid street texture (bg) + Painter2D markers (content)
        Texture2D m_RoadTex;
        Rect m_RoadViewBounds;
        int m_RoadTexHeight;
        DaHilgGameManager m_Manager;
        DaHilgLevelProfile m_Profile;
        MinimapData m_Data;

        public DaHilgMinimapElement()
        {
            pickingMode = PickingMode.Ignore;
            style.position = Position.Absolute;
            style.backgroundColor = new Color(0.025f, 0.030f, 0.038f, 0.88f);
            // Square chrome to match the AGC glass panels of the rest of the HUD (no rounded corners).
            style.borderTopLeftRadius = 0;
            style.borderTopRightRadius = 0;
            style.borderBottomLeftRadius = 0;
            style.borderBottomRightRadius = 0;
            style.borderTopWidth = 1;
            style.borderBottomWidth = 1;
            style.borderLeftWidth = 1;
            style.borderRightWidth = 1;
            style.borderTopColor = new Color(1f, 1f, 1f, 0.18f);
            style.borderBottomColor = style.borderTopColor.value;
            style.borderLeftColor = style.borderTopColor.value;
            style.borderRightColor = style.borderTopColor.value;
            style.overflow = Overflow.Hidden;

            m_Title = new Label("MAP");
            m_Title.pickingMode = PickingMode.Ignore;
            m_Title.style.position = Position.Absolute;
            m_Title.style.left = 8;
            m_Title.style.top = 5;
            m_Title.style.fontSize = 9;
            m_Title.style.unityFontStyleAndWeight = FontStyle.Bold;
            m_Title.style.color = new Color(1f, 1f, 1f, 0.88f);
            Add(m_Title);

            m_Legend = new Label("RED DANGER  GREEN SAFE");
            m_Legend.pickingMode = PickingMode.Ignore;
            m_Legend.style.position = Position.Absolute;
            m_Legend.style.left = 10;
            m_Legend.style.bottom = 6;
            m_Legend.style.fontSize = 9;
            m_Legend.style.unityFontStyleAndWeight = FontStyle.Bold;
            m_Legend.style.color = new Color(1f, 1f, 1f, 0.68f);
            m_Legend.style.display = DisplayStyle.None; // clean: green=safe / white=you is self-evident; no alarming legend
            Add(m_Legend);

            // The map area is a child so its background-image (the baked solid-road texture) draws UNDER
            // its own Painter2D content (creek + actor dots). A parent's generateVisualContent always
            // draws below its children, so the road has to live on the same element as the markers.
            m_MapArea = new VisualElement { pickingMode = PickingMode.Ignore };
            m_MapArea.style.position = Position.Absolute;
            m_MapArea.style.left = 8; m_MapArea.style.right = 8;
            m_MapArea.style.top = 20; m_MapArea.style.bottom = 8;
            m_MapArea.style.backgroundColor = new Color(0.08f, 0.12f, 0.09f, 0.90f);
            m_MapArea.generateVisualContent += OnGenerateVisualContent;
            m_MapArea.RegisterCallback<GeometryChangedEvent>(_ => RefreshRoadTextureForCurrentView(true));
            Add(m_MapArea);
        }

        public void SetManager(DaHilgGameManager manager)
        {
            m_Manager = manager;
            DaHilgLevelProfile profile = manager != null ? manager.CurrentLevel : null;
            if (profile != m_Profile)
            {
                m_Profile = profile;
                m_Data = MinimapData.FromProfile(profile);
                m_Title.text = profile != null ? "MAP · " + profile.Label.ToUpperInvariant() : "MAP";
                m_RoadViewBounds = default;
                RefreshRoadTextureForCurrentView(true);
            }
            else
            {
                RefreshRoadTextureForCurrentView(false);
            }

            MarkDirtyRepaint();
            m_MapArea?.MarkDirtyRepaint();
        }

        void RefreshRoadTextureForCurrentView(bool force)
        {
            if (m_Data == null || m_Data.FillN <= 0 || m_Data.FillRoad == null)
            {
                if (m_RoadTex != null) { UnityEngine.Object.Destroy(m_RoadTex); m_RoadTex = null; }
                if (m_MapArea != null) m_MapArea.style.backgroundImage = new StyleBackground();
                return;
            }

            Rect mapRect = m_MapArea != null ? m_MapArea.contentRect : new Rect(0f, 0f, 190f, 148f);
            float aspect = mapRect.width > 4f && mapRect.height > 4f ? mapRect.width / mapRect.height : 1.28f;
            Rect viewBounds = ViewBoundsFor(aspect);
            int texHeight = Mathf.Clamp(Mathf.RoundToInt(k_RoadTextureWidth / Mathf.Max(0.4f, aspect)), 144, 320);
            Vector2 oldCenter = m_RoadViewBounds.center;
            Vector2 newCenter = viewBounds.center;
            bool moved = (oldCenter - newCenter).sqrMagnitude > 12f * 12f;
            bool resized = Mathf.Abs(m_RoadViewBounds.width - viewBounds.width) > 0.5f
                || Mathf.Abs(m_RoadViewBounds.height - viewBounds.height) > 0.5f
                || m_RoadTexHeight != texHeight;
            if (!force && m_RoadTex != null && !moved && !resized) return;

            RebuildRoadTexture(viewBounds, texHeight);
        }

        // Bake the 1-bit road occupancy grid into a zoomed solid-street texture. The crop matches
        // WorldToMap() so the filled streets and vector strokes stay aligned.
        void RebuildRoadTexture(Rect viewBounds, int texHeight)
        {
            if (m_RoadTex != null && (m_RoadTex.width != k_RoadTextureWidth || m_RoadTex.height != texHeight))
            {
                UnityEngine.Object.Destroy(m_RoadTex);
                m_RoadTex = null;
            }

            if (m_RoadTex == null)
            {
                m_RoadTex = new Texture2D(k_RoadTextureWidth, texHeight, TextureFormat.RGBA32, false)
                {
                    filterMode = FilterMode.Bilinear,
                    wrapMode = TextureWrapMode.Clamp
                };
            }

            Color ground = new Color(0.070f, 0.115f, 0.085f, 0.96f);
            Color edge = new Color(0.175f, 0.195f, 0.205f, 1f);
            Color road = new Color(0.64f, 0.67f, 0.71f, 1f);
            Color roadHi = new Color(0.78f, 0.80f, 0.82f, 1f);
            Color32[] px = new Color32[k_RoadTextureWidth * texHeight];
            for (int row = 0; row < texHeight; row++)
            {
                float z = Mathf.Lerp(viewBounds.yMin, viewBounds.yMax, (row + 0.5f) / texHeight);
                for (int col = 0; col < k_RoadTextureWidth; col++)
                {
                    float x = Mathf.Lerp(viewBounds.xMin, viewBounds.xMax, (col + 0.5f) / k_RoadTextureWidth);
                    float alpha = SampleRoadAlpha(x, z);
                    float edge01 = Mathf.SmoothStep(0.035f, 0.28f, alpha);
                    float road01 = Mathf.SmoothStep(0.34f, 0.66f, alpha);
                    float highlight01 = Mathf.SmoothStep(0.76f, 0.96f, alpha) * 0.45f;
                    Color c = Color.Lerp(ground, edge, edge01);
                    c = Color.Lerp(c, road, road01);
                    c = Color.Lerp(c, roadHi, highlight01);
                    px[row * k_RoadTextureWidth + col] = c;
                }
            }
            m_RoadTex.SetPixels32(px);
            m_RoadTex.Apply(false, false);
            m_RoadTexHeight = texHeight;
            m_RoadViewBounds = viewBounds;
            m_MapArea.style.backgroundImage = new StyleBackground(m_RoadTex);
        }

        float SampleRoadAlpha(float x, float z)
        {
            if (m_Data == null || m_Data.RoadAlpha == null || m_Data.FillN <= 1) return 0f;
            int n = m_Data.FillN;
            Rect source = m_Data.Bounds;
            float gx = Mathf.Clamp01((x - source.xMin) / Mathf.Max(0.001f, source.width)) * (n - 1);
            float gz = Mathf.Clamp01((z - source.yMin) / Mathf.Max(0.001f, source.height)) * (n - 1);
            int x0 = Mathf.Clamp(Mathf.FloorToInt(gx), 0, n - 1);
            int z0 = Mathf.Clamp(Mathf.FloorToInt(gz), 0, n - 1);
            int x1 = Mathf.Min(n - 1, x0 + 1);
            int z1 = Mathf.Min(n - 1, z0 + 1);
            float tx = gx - x0;
            float tz = gz - z0;
            float a00 = m_Data.RoadAlpha[z0 * n + x0] / 255f;
            float a10 = m_Data.RoadAlpha[z0 * n + x1] / 255f;
            float a01 = m_Data.RoadAlpha[z1 * n + x0] / 255f;
            float a11 = m_Data.RoadAlpha[z1 * n + x1] / 255f;
            return Mathf.Lerp(Mathf.Lerp(a00, a10, tx), Mathf.Lerp(a01, a11, tx), tz);
        }

        static bool RoadBit(byte[] bits, int n, int col, int row)
        {
            if (bits == null || col < 0 || col >= n || row < 0 || row >= n) return false;
            int cell = row * n + col;
            return cell >= 0 && (cell >> 3) < bits.Length && (bits[cell >> 3] & (1 << (cell & 7))) != 0;
        }

        static byte[] BuildSmoothRoadAlpha(byte[] bits, int n)
        {
            if (bits == null || n <= 0) return null;
            float[] stage = new float[n * n];
            float[] tmp = new float[n * n];
            float[] smooth = new float[n * n];
            for (int row = 0; row < n; row++)
            {
                for (int col = 0; col < n; col++)
                {
                    bool center = RoadBit(bits, n, col, row);
                    int near1 = 0;
                    int near2 = 0;
                    for (int dz = -2; dz <= 2; dz++)
                    {
                        for (int dx = -2; dx <= 2; dx++)
                        {
                            if (!RoadBit(bits, n, col + dx, row + dz)) continue;
                            near2++;
                            if (Mathf.Abs(dx) <= 1 && Mathf.Abs(dz) <= 1) near1++;
                        }
                    }
                    float v = center ? 1f : (near1 > 0 ? 0.66f : (near2 > 0 ? 0.24f : 0f));
                    stage[row * n + col] = v;
                }
            }

            for (int pass = 0; pass < 2; pass++)
            {
                for (int row = 0; row < n; row++)
                {
                    for (int col = 0; col < n; col++)
                    {
                        float a = stage[row * n + Mathf.Max(0, col - 1)];
                        float b = stage[row * n + col];
                        float c = stage[row * n + Mathf.Min(n - 1, col + 1)];
                        tmp[row * n + col] = (a + b * 2f + c) * 0.25f;
                    }
                }
                for (int row = 0; row < n; row++)
                {
                    int row0 = Mathf.Max(0, row - 1);
                    int row1 = Mathf.Min(n - 1, row + 1);
                    for (int col = 0; col < n; col++)
                    {
                        float a = tmp[row0 * n + col];
                        float b = tmp[row * n + col];
                        float c = tmp[row1 * n + col];
                        smooth[row * n + col] = (a + b * 2f + c) * 0.25f;
                    }
                }
                float[] swap = stage;
                stage = smooth;
                smooth = swap;
            }

            byte[] alpha = new byte[n * n];
            for (int i = 0; i < alpha.Length; i++)
            {
                alpha[i] = (byte)Mathf.Clamp(Mathf.RoundToInt(stage[i] * 255f), 0, 255);
            }
            return alpha;
        }

        void OnGenerateVisualContent(MeshGenerationContext context)
        {
            // This draws on the MAP AREA child; the solid road network is its background texture, so here
            // we only paint the creek + zones + actors ON TOP of those streets (Google-Maps style).
            Rect mapRect = new Rect(0f, 0f, m_MapArea.contentRect.width, m_MapArea.contentRect.height);
            if (mapRect.width <= 20f || mapRect.height <= 20f) return;
            if (m_Data == null || !m_Data.Valid) return;
            Rect viewBounds = ViewBoundsFor(mapRect.width / Mathf.Max(1f, mapRect.height));

            Painter2D painter = context.painter2D;
            DrawStreetNetwork(painter, mapRect, viewBounds);
            DrawSegments(painter, mapRect, viewBounds, m_Data.Creek, new Color(0.03f, 0.12f, 0.20f, 0.95f), 5.6f);
            DrawSegments(painter, mapRect, viewBounds, m_Data.Creek, new Color(0.30f, 0.78f, 1f, 0.95f), 3.2f);

            if (m_Profile != null)
            {
                DaHilgBoxZone[] safeZones = m_Manager != null && m_Manager.Mode == DaHilgGameMode.Nibblers
                    ? m_Profile.NibblerSafeZones
                    : m_Profile.GreetSafeZones;
                // Only the SAFE zone gets a soft green tint — no red wash over the whole map (danger is
                // implied by "not safe" + the MARKED banner + the player pulse). Keeps the map readable.
                DrawZones(painter, mapRect, viewBounds, safeZones, new Color(0.25f, 0.9f, 0.45f, 0.10f), new Color(0.30f, 1f, 0.42f, 0.6f));
            }

            DrawNibblers(painter, mapRect, viewBounds);
            DrawActors(painter, mapRect, viewBounds);
            DrawAnimals(painter, mapRect, viewBounds);
        }

        Rect ViewBoundsFor(float aspect)
        {
            Rect full = m_Data != null && m_Data.Valid ? m_Data.Bounds : new Rect(-120f, -120f, 240f, 240f);
            float desiredWidth = Mathf.Clamp(full.width / k_MinimapZoomDivisor,
                DaHilgGameManager.MobileWeb ? 210f : 260f,
                DaHilgGameManager.MobileWeb ? 320f : 420f);
            float width = Mathf.Min(full.width, desiredWidth);
            float height = Mathf.Min(full.height, width / Mathf.Max(0.55f, aspect));
            if (height >= full.height) width = Mathf.Min(full.width, height * Mathf.Max(0.55f, aspect));

            Vector2 center = full.center;
            if (m_Manager != null && m_Manager.ActiveActor != null)
            {
                Vector3 p = m_Manager.ActiveActor.FeetPosition;
                center = new Vector2(p.x, p.z);
            }
            else if (m_Profile != null && m_Profile.PlayerSpawns != null && m_Profile.PlayerSpawns.Length > 0)
            {
                Vector3 p = m_Profile.PlayerSpawns[0];
                center = new Vector2(p.x, p.z);
            }

            float xMin = full.width <= width ? full.xMin : Mathf.Clamp(center.x - width * 0.5f, full.xMin, full.xMax - width);
            float yMin = full.height <= height ? full.yMin : Mathf.Clamp(center.y - height * 0.5f, full.yMin, full.yMax - height);
            return new Rect(xMin, yMin, width, height);
        }

        void DrawStreetNetwork(Painter2D painter, Rect rect, Rect viewBounds)
        {
            // Draw the vector street layers over the baked road-fill texture. The fill gives the
            // neighborhood mass; these strokes make actual streets, sidewalks, curbs, and lane lines
            // readable at small HUD sizes.
            DrawSegments(painter, rect, viewBounds, m_Data.Drive, new Color(0.02f, 0.025f, 0.03f, 0.95f), 7.0f);
            DrawSegments(painter, rect, viewBounds, m_Data.Road, new Color(0.02f, 0.025f, 0.03f, 0.88f), 5.4f);
            DrawSegments(painter, rect, viewBounds, m_Data.Drive, new Color(0.54f, 0.57f, 0.62f, 0.96f), 4.9f);
            DrawSegments(painter, rect, viewBounds, m_Data.Road, new Color(0.47f, 0.50f, 0.55f, 0.94f), 3.5f);
            DrawSegments(painter, rect, viewBounds, m_Data.Walk, new Color(0.80f, 0.76f, 0.64f, 0.90f), 2.2f);
            DrawSegments(painter, rect, viewBounds, m_Data.Curb, new Color(0.92f, 0.94f, 0.86f, 0.85f), 1.35f);
            DrawSegments(painter, rect, viewBounds, m_Data.Line, new Color(1f, 0.82f, 0.26f, 0.90f), 1.15f);
        }

        void DrawSegments(Painter2D painter, Rect rect, Rect viewBounds, List<Segment> segments, Color color, float width)
        {
            if (segments == null || segments.Count == 0) return;
            painter.strokeColor = color;
            painter.lineWidth = width;
            painter.BeginPath();
            for (int i = 0; i < segments.Count; i++)
            {
                Segment segment = segments[i];
                if (!SegmentTouchesBounds(segment, viewBounds)) continue;
                painter.MoveTo(WorldToMap(segment.X1, segment.Z1, rect, viewBounds));
                painter.LineTo(WorldToMap(segment.X2, segment.Z2, rect, viewBounds));
            }
            painter.Stroke();
        }

        void DrawZones(Painter2D painter, Rect rect, Rect viewBounds, DaHilgBoxZone[] zones, Color fill, Color stroke)
        {
            if (zones == null) return;
            float wToPx = rect.width / Mathf.Max(1f, viewBounds.width);
            for (int i = 0; i < zones.Length; i++)
            {
                DaHilgBoxZone zone = zones[i];
                Vector2 center = WorldToMap(zone.Center.x, zone.Center.z, rect, viewBounds);
                // Soft rounded region (a shaded blob), never a hard square outline.
                float pr = Mathf.Clamp(Mathf.Max(zone.Size.x, zone.Size.z) * 0.5f * wToPx, 7f, 64f);
                DrawDisk(painter, center, pr, fill);
                DrawDisk(painter, center, pr * 0.55f, new Color(fill.r, fill.g, fill.b, fill.a * 1.5f));
            }
        }

        void DrawNibblers(Painter2D painter, Rect rect, Rect viewBounds)
        {
            if (m_Manager == null || m_Manager.Nibblers == null) return;
            IReadOnlyList<DaHilgNibblerAgent> nibblers = m_Manager.Nibblers;
            for (int i = 0; i < nibblers.Count; i++)
            {
                DaHilgNibblerAgent nibbler = nibblers[i];
                if (nibbler == null || !nibbler.Active) continue;
                Vector3 position = nibbler.Position;
                if (!viewBounds.Contains(new Vector2(position.x, position.z))) continue;
                DrawDisk(painter, WorldToMap(position.x, position.z, rect, viewBounds), 2.3f, new Color(1f, 0.78f, 0.25f, 0.78f));
            }
        }

        void DrawActors(Painter2D painter, Rect rect, Rect viewBounds)
        {
            if (m_Manager == null || m_Manager.Actors == null) return;
            IReadOnlyList<DaHilgActor> actors = m_Manager.Actors;
            for (int i = 0; i < actors.Count; i++)
            {
                DaHilgActor actor = actors[i];
                if (actor == null) continue;
                bool active = actor == m_Manager.ActiveActor;
                Vector2 p = WorldToMap(actor.FeetPosition.x, actor.FeetPosition.z, rect, viewBounds);
                if (active && m_Manager.PlayerMarked)
                {
                    float pulse = 8.5f + Mathf.PingPong(Time.time * 8f, 4f);
                    DrawDisk(painter, p, pulse, new Color(1f, 0.05f, 0f, 0.30f));
                }
                DrawDisk(painter, p, active ? 7.0f : 5.0f, active ? new Color(1f, 1f, 1f, 0.96f) : new Color(0.08f, 0.18f, 0.28f, 0.98f));
                DrawDisk(painter, p, active ? 4.0f : 2.9f, active ? new Color(1f, 0.45f, 0.76f, 0.98f) : new Color(0.35f, 0.78f, 1f, 0.96f));
                if (active)
                {
                    Vector2 heading = new Vector2(Mathf.Sin(actor.FacingYaw * Mathf.Deg2Rad), -Mathf.Cos(actor.FacingYaw * Mathf.Deg2Rad));
                    painter.strokeColor = Color.white;
                    painter.lineWidth = 1.5f;
                    painter.BeginPath();
                    painter.MoveTo(p);
                    painter.LineTo(p + heading * 10f);
                    painter.Stroke();
                }
            }
        }

        void DrawAnimals(Painter2D painter, Rect rect, Rect viewBounds)
        {
            if (m_Manager == null || m_Manager.Animals == null) return;
            IReadOnlyList<DaHilgAnimalAgent> animals = m_Manager.Animals;
            for (int i = 0; i < animals.Count; i++)
            {
                DaHilgAnimalAgent animal = animals[i];
                if (animal == null) continue;
                if (!viewBounds.Contains(new Vector2(animal.Position.x, animal.Position.z))) continue;
                DrawDisk(painter, WorldToMap(animal.Position.x, animal.Position.z, rect, viewBounds), 3.1f, new Color(1f, 0.73f, 0.26f, 0.90f));
            }
        }

        Vector2 WorldToMap(float x, float z, Rect rect, Rect bounds)
        {
            float u = Mathf.InverseLerp(bounds.xMin, bounds.xMax, x);
            float v = Mathf.InverseLerp(bounds.yMin, bounds.yMax, z);
            return new Vector2(rect.xMin + u * rect.width, rect.yMax - v * rect.height);
        }

        static bool SegmentTouchesBounds(Segment segment, Rect bounds)
        {
            float minX = Mathf.Min(segment.X1, segment.X2);
            float maxX = Mathf.Max(segment.X1, segment.X2);
            float minZ = Mathf.Min(segment.Z1, segment.Z2);
            float maxZ = Mathf.Max(segment.Z1, segment.Z2);
            return maxX >= bounds.xMin && minX <= bounds.xMax && maxZ >= bounds.yMin && minZ <= bounds.yMax;
        }

        static void FillRect(Painter2D painter, Rect rect, Color color)
        {
            FillPolygon(painter, color,
                new Vector2(rect.xMin, rect.yMin),
                new Vector2(rect.xMax, rect.yMin),
                new Vector2(rect.xMax, rect.yMax),
                new Vector2(rect.xMin, rect.yMax));
        }

        static void FillPolygon(Painter2D painter, Color color, params Vector2[] points)
        {
            if (points.Length == 0) return;
            painter.fillColor = color;
            painter.BeginPath();
            painter.MoveTo(points[0]);
            for (int i = 1; i < points.Length; i++) painter.LineTo(points[i]);
            painter.ClosePath();
            painter.Fill();
        }

        static void StrokePolygon(Painter2D painter, Color color, float width, params Vector2[] points)
        {
            if (points.Length == 0) return;
            painter.strokeColor = color;
            painter.lineWidth = width;
            painter.BeginPath();
            painter.MoveTo(points[0]);
            for (int i = 1; i < points.Length; i++) painter.LineTo(points[i]);
            painter.ClosePath();
            painter.Stroke();
        }

        static void DrawDisk(Painter2D painter, Vector2 center, float radius, Color color)
        {
            for (int i = 0; i < k_DiskSides; i++)
            {
                float angle = i / (float)k_DiskSides * Mathf.PI * 2f;
                s_DiskPoints[i] = center + new Vector2(Mathf.Cos(angle), Mathf.Sin(angle)) * radius;
            }
            FillPolygon(painter, color, s_DiskPoints);
        }

        readonly struct Segment
        {
            public readonly float X1;
            public readonly float Z1;
            public readonly float X2;
            public readonly float Z2;

            public Segment(float x1, float z1, float x2, float z2)
            {
                X1 = x1;
                Z1 = z1;
                X2 = x2;
                Z2 = z2;
            }
        }

        sealed class MinimapData
        {
            public Rect Bounds;
            public int FillN;            // road-fill grid resolution (0 = none)
            public byte[] FillRoad;      // packed 1-bit road occupancy grid, row-major (row 0 = minZ)
            public byte[] RoadAlpha;     // smoothed 0..255 road mask for HUD rendering
            public List<Segment> Road = new List<Segment>();
            public List<Segment> Drive = new List<Segment>();
            public List<Segment> Walk = new List<Segment>();
            public List<Segment> Curb = new List<Segment>();
            public List<Segment> Line = new List<Segment>();
            public List<Segment> Creek = new List<Segment>();
            public bool Valid => Bounds.width > 0f && Bounds.height > 0f;

            public static MinimapData FromProfile(DaHilgLevelProfile profile)
            {
                MinimapData data = new MinimapData();
                if (profile == null || profile.Minimap == null || string.IsNullOrEmpty(profile.Minimap.text))
                {
                    data.Bounds = profile != null ? new Rect(profile.PlayBounds.min.x, profile.PlayBounds.min.z, profile.PlayBounds.size.x, profile.PlayBounds.size.z) : new Rect(-120f, -120f, 240f, 240f);
                    return data;
                }

                string json = profile.Minimap.text;
                float minX = ExtractFloat(json, "minX", profile.PlayBounds.min.x);
                float minZ = ExtractFloat(json, "minZ", profile.PlayBounds.min.z);
                float maxX = ExtractFloat(json, "maxX", profile.PlayBounds.max.x);
                float maxZ = ExtractFloat(json, "maxZ", profile.PlayBounds.max.z);
                data.Bounds = new Rect(minX, minZ, Mathf.Max(1f, maxX - minX), Mathf.Max(1f, maxZ - minZ));
                data.FillN = Mathf.RoundToInt(ExtractFloat(json, "fillN", 0f));
                data.FillRoad = ExtractBase64(json, "fillRoad");
                data.RoadAlpha = BuildSmoothRoadAlpha(data.FillRoad, data.FillN);
                data.Road = ExtractSegments(json, "road");
                data.Drive = ExtractSegments(json, "drive");
                data.Walk = ExtractSegments(json, "walk");
                data.Curb = ExtractSegments(json, "curb");
                data.Line = ExtractSegments(json, "line");
                data.Creek = ExtractSegments(json, "creek");
                return data;
            }

            static float ExtractFloat(string json, string key, float fallback)
            {
                Match match = Regex.Match(json, "\"" + Regex.Escape(key) + "\"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)");
                if (match.Success && float.TryParse(match.Groups[1].Value, NumberStyles.Float, CultureInfo.InvariantCulture, out float value))
                {
                    return value;
                }
                return fallback;
            }

            static byte[] ExtractBase64(string json, string key)
            {
                Match match = Regex.Match(json, "\"" + Regex.Escape(key) + "\"\\s*:\\s*\"([A-Za-z0-9+/=]*)\"");
                if (!match.Success) return null;
                try { return Convert.FromBase64String(match.Groups[1].Value); }
                catch { return null; }
            }

            static List<Segment> ExtractSegments(string json, string key)
            {
                string block = ExtractArrayBlock(json, key);
                if (string.IsNullOrEmpty(block)) return new List<Segment>();

                MatchCollection matches = Regex.Matches(block, "-?\\d+(?:\\.\\d+)?");
                int segmentCount = matches.Count / 4;
                int stride = Mathf.Max(1, Mathf.CeilToInt(segmentCount / (float)k_MaxSegmentsPerLayer));
                List<Segment> segments = new List<Segment>(Mathf.Min(segmentCount, k_MaxSegmentsPerLayer));
                for (int i = 0; i + 3 < matches.Count; i += 4)
                {
                    int segmentIndex = i / 4;
                    if (segmentIndex % stride != 0) continue;
                    float x1 = Parse(matches[i].Value);
                    float z1 = Parse(matches[i + 1].Value);
                    float x2 = Parse(matches[i + 2].Value);
                    float z2 = Parse(matches[i + 3].Value);
                    segments.Add(new Segment(x1, z1, x2, z2));
                }
                return segments;
            }

            static float Parse(string value)
            {
                return float.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out float parsed) ? parsed : 0f;
            }

            static string ExtractArrayBlock(string json, string key)
            {
                int keyIndex = json.IndexOf("\"" + key + "\"", StringComparison.Ordinal);
                if (keyIndex < 0) return string.Empty;
                int start = json.IndexOf('[', keyIndex);
                if (start < 0) return string.Empty;
                int depth = 0;
                for (int i = start; i < json.Length; i++)
                {
                    if (json[i] == '[') depth++;
                    else if (json[i] == ']')
                    {
                        depth--;
                        if (depth == 0) return json.Substring(start, i - start + 1);
                    }
                }
                return string.Empty;
            }
        }
    }
}
