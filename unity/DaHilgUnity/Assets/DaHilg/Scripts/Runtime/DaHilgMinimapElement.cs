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
        const int k_MaxSegmentsPerLayer = 900;

        readonly Label m_Title;
        readonly Label m_Legend;
        DaHilgGameManager m_Manager;
        DaHilgLevelProfile m_Profile;
        MinimapData m_Data;

        public DaHilgMinimapElement()
        {
            pickingMode = PickingMode.Ignore;
            style.position = Position.Absolute;
            style.backgroundColor = new Color(0.03f, 0.04f, 0.06f, 0.72f);
            style.borderTopLeftRadius = 8;
            style.borderTopRightRadius = 8;
            style.borderBottomLeftRadius = 8;
            style.borderBottomRightRadius = 8;
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
            m_Title.style.left = 10;
            m_Title.style.top = 6;
            m_Title.style.fontSize = 10;
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
            Add(m_Legend);

            generateVisualContent += OnGenerateVisualContent;
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
            }

            MarkDirtyRepaint();
        }

        void OnGenerateVisualContent(MeshGenerationContext context)
        {
            Rect full = contentRect;
            if (full.width <= 20f || full.height <= 20f) return;

            Painter2D painter = context.painter2D;
            FillRect(painter, full, new Color(0.03f, 0.05f, 0.055f, 0.86f));

            Rect mapRect = new Rect(full.xMin + 10f, full.yMin + 22f, full.width - 20f, Mathf.Max(20f, full.height - 44f));
            FillRect(painter, mapRect, new Color(0.08f, 0.10f, 0.095f, 0.72f));

            if (m_Data == null || !m_Data.Valid) return;

            DrawSegments(painter, mapRect, m_Data.Walk, new Color(0.70f, 0.74f, 0.68f, 0.28f), 0.55f);
            DrawSegments(painter, mapRect, m_Data.Road, new Color(0.55f, 0.58f, 0.56f, 0.42f), 0.8f);
            DrawSegments(painter, mapRect, m_Data.Drive, new Color(0.62f, 0.64f, 0.60f, 0.36f), 0.65f);
            DrawSegments(painter, mapRect, m_Data.Curb, new Color(0.95f, 0.91f, 0.72f, 0.34f), 0.55f);
            DrawSegments(painter, mapRect, m_Data.Line, new Color(0.95f, 0.95f, 0.88f, 0.24f), 0.45f);

            if (m_Profile != null)
            {
                DaHilgBoxZone[] safeZones = m_Manager != null && m_Manager.Mode == DaHilgGameMode.Nibblers
                    ? m_Profile.NibblerSafeZones
                    : m_Profile.GreetSafeZones;
                DrawZones(painter, mapRect, safeZones, new Color(0.20f, 0.95f, 0.38f, 0.24f), new Color(0.30f, 1f, 0.42f, 0.72f));
                DrawZones(painter, mapRect, m_Profile.DangerZones, new Color(1f, 0.12f, 0.06f, 0.24f), new Color(1f, 0.18f, 0.10f, 0.84f));
            }

            DrawActors(painter, mapRect);
        }

        void DrawSegments(Painter2D painter, Rect rect, List<Segment> segments, Color color, float width)
        {
            if (segments == null || segments.Count == 0) return;
            painter.strokeColor = color;
            painter.lineWidth = width;
            painter.BeginPath();
            for (int i = 0; i < segments.Count; i++)
            {
                Segment segment = segments[i];
                painter.MoveTo(WorldToMap(segment.X1, segment.Z1, rect));
                painter.LineTo(WorldToMap(segment.X2, segment.Z2, rect));
            }
            painter.Stroke();
        }

        void DrawZones(Painter2D painter, Rect rect, DaHilgBoxZone[] zones, Color fill, Color stroke)
        {
            if (zones == null) return;
            for (int i = 0; i < zones.Length; i++)
            {
                DaHilgBoxZone zone = zones[i];
                float hx = zone.Size.x * 0.5f;
                float hz = zone.Size.z * 0.5f;
                Vector2 a = WorldToMap(zone.Center.x - hx, zone.Center.z - hz, rect);
                Vector2 b = WorldToMap(zone.Center.x + hx, zone.Center.z - hz, rect);
                Vector2 c = WorldToMap(zone.Center.x + hx, zone.Center.z + hz, rect);
                Vector2 d = WorldToMap(zone.Center.x - hx, zone.Center.z + hz, rect);
                FillPolygon(painter, fill, a, b, c, d);
                StrokePolygon(painter, stroke, 1.2f, a, b, c, d);
            }

            IReadOnlyList<DaHilgNibblerAgent> nibblers = m_Manager.Nibblers;
            for (int i = 0; i < nibblers.Count; i++)
            {
                DaHilgNibblerAgent nibbler = nibblers[i];
                if (nibbler == null || !nibbler.Active) continue;
                Vector3 position = nibbler.Position;
                DrawDisk(painter, WorldToMap(position.x, position.z, rect), 2.4f, nibbler.Attached ? new Color(1f, 0.15f, 0.08f, 0.95f) : new Color(1f, 0.55f, 0.14f, 0.82f));
            }
        }

        void DrawActors(Painter2D painter, Rect rect)
        {
            if (m_Manager == null || m_Manager.Actors == null) return;
            IReadOnlyList<DaHilgActor> actors = m_Manager.Actors;
            for (int i = 0; i < actors.Count; i++)
            {
                DaHilgActor actor = actors[i];
                if (actor == null) continue;
                bool active = actor == m_Manager.ActiveActor;
                Vector2 p = WorldToMap(actor.FeetPosition.x, actor.FeetPosition.z, rect);
                DrawDisk(painter, p, active ? 5.2f : 3.6f, active ? Color.white : new Color(0.35f, 0.68f, 1f, 0.92f));
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

        Vector2 WorldToMap(float x, float z, Rect rect)
        {
            Rect bounds = m_Data.Bounds;
            float u = Mathf.InverseLerp(bounds.xMin, bounds.xMax, x);
            float v = Mathf.InverseLerp(bounds.yMin, bounds.yMax, z);
            return new Vector2(rect.xMin + u * rect.width, rect.yMax - v * rect.height);
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
            const int sides = 14;
            Vector2[] points = new Vector2[sides];
            for (int i = 0; i < sides; i++)
            {
                float angle = i / (float)sides * Mathf.PI * 2f;
                points[i] = center + new Vector2(Mathf.Cos(angle), Mathf.Sin(angle)) * radius;
            }
            FillPolygon(painter, color, points);
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
            public List<Segment> Road = new List<Segment>();
            public List<Segment> Drive = new List<Segment>();
            public List<Segment> Walk = new List<Segment>();
            public List<Segment> Curb = new List<Segment>();
            public List<Segment> Line = new List<Segment>();
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
                data.Road = ExtractSegments(json, "road");
                data.Drive = ExtractSegments(json, "drive");
                data.Walk = ExtractSegments(json, "walk");
                data.Curb = ExtractSegments(json, "curb");
                data.Line = ExtractSegments(json, "line");
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
