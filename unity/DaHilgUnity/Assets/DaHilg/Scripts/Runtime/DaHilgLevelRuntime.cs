using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using GLTFast;
using UnityEngine;
using UnityEngine.Rendering;

namespace DaHilg
{
    public static class DaHilgLevelRuntime
    {
        const float k_SpawnProbeHeight = 80f;
        const float k_SpawnProbeDistance = 220f;
        const float k_SpawnGroundSkin = 0.08f;
        static readonly int s_BaseColorId = Shader.PropertyToID("_BaseColor");
        static readonly int s_ColorId = Shader.PropertyToID("_Color");
        static readonly int s_BaseMapId = Shader.PropertyToID("_BaseMap");
        static readonly int s_MainTexId = Shader.PropertyToID("_MainTex");
        // URP/Built-in surface property ids for the terrain detail-normal + window-glass pass.
        // Both pipelines name these the same on their Lit/Standard shaders; all writes are guarded
        // by Material.HasProperty so a foreign glTFast shader without a slot is simply skipped.
        static readonly int s_DetailNormalMapId = Shader.PropertyToID("_DetailNormalMap");
        static readonly int s_DetailNormalMapScaleId = Shader.PropertyToID("_DetailNormalMapScale");
        static readonly int s_DetailAlbedoMapId = Shader.PropertyToID("_DetailAlbedoMap");
        static readonly int s_MetallicId = Shader.PropertyToID("_Metallic");
        static readonly int s_SmoothnessId = Shader.PropertyToID("_Smoothness");
        static readonly int s_GlossinessId = Shader.PropertyToID("_Glossiness");
        static readonly int s_SurfaceId = Shader.PropertyToID("_Surface");
        static readonly int s_BlendId = Shader.PropertyToID("_Blend");
        static readonly int s_SrcBlendId = Shader.PropertyToID("_SrcBlend");
        static readonly int s_DstBlendId = Shader.PropertyToID("_DstBlend");
        static readonly int s_ZWriteId = Shader.PropertyToID("_ZWrite");
        static readonly int s_CutoffId = Shader.PropertyToID("_Cutoff");
        static readonly int s_AlphaClipId = Shader.PropertyToID("_AlphaClip");
        static readonly int s_ModeId = Shader.PropertyToID("_Mode");
        // glTFast 6.14.1 Built-in (GLTFAST_BUILTIN_RP) material property ids. The Built-in
        // glTF shaders expose baseColorFactor/alphaCutoff/baseColorTexture (NOT _BaseColor/_Cutoff),
        // so the _-prefixed writes above silently no-op on them. These are the real slots.
        static readonly int s_GltfBaseColorId = Shader.PropertyToID("baseColorFactor");
        static readonly int s_GltfAlphaCutoffId = Shader.PropertyToID("alphaCutoff");
        static readonly HashSet<Collider> s_LevelColliders = new HashSet<Collider>();
        static readonly HashSet<Material> s_ConfiguredVegetationMaterials = new HashSet<Material>();
        static readonly HashSet<Material> s_DetailNormaledTerrainMaterials = new HashSet<Material>();
        static readonly HashSet<Material> s_ConfiguredGlassMaterials = new HashSet<Material>();
        static readonly Dictionary<Mesh, Mesh> s_ColliderMeshCache = new Dictionary<Mesh, Mesh>();
        // Renderers of the SVFacade_page* photo-overlay nodes — toggled as a group by
        // SetFacadesVisible (mirrors the web showFacades). Default visible (photo mode on).
        static readonly List<Renderer> s_FacadeRenderers = new List<Renderer>();
        static Texture2D s_DetailNormalTexture;
        static readonly RaycastHit[] s_GroundHits = new RaycastHit[64];
        static readonly RaycastHit[] s_SphereHits = new RaycastHit[32];
        static readonly Collider[] s_OverlapHits = new Collider[32];
        static Texture2D s_WaterFlowTexture;
        static bool s_ProceduralCreekWaterActive;
        static int s_SurfaceMaskN;
        static Rect s_SurfaceMaskBounds;
        static byte[] s_SurfaceMaskRoad;
        static byte[] s_SurfaceMaskDrive;
        static byte[] s_SurfaceMaskWalk;
        static byte[] s_SurfaceMaskCurb;
        static byte[] s_SurfaceMaskLine;
        static byte[] s_SurfaceMaskWater;

        // Heavy outdoor levels stream their GLB from StreamingAssets at level-select instead of
        // being baked into the WebGL data file. Mirrors the staged set in DaHilgProjectBuilder.
        static readonly HashSet<string> s_StreamedLevelSlugs = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "dahill",
            "canyon",
            "stanton",
            "meemaw",
            "xq"
        };

        // CPU-side buffers from the active streamed import; disposed when the next level loads so
        // switching levels frees the previous GLB's memory (the instantiated GameObjects are owned
        // by the caller's level root and destroyed alongside it).
        static GltfImport s_ActiveImport;
        static GltfImport s_ActiveOverlayImport;

        public static bool IsStreamedLevel(string slug)
        {
            return !string.IsNullOrEmpty(slug) && s_StreamedLevelSlugs.Contains(slug);
        }

        // StreamingAssets URL for a level's GLB. On WebGL Application.streamingAssetsPath is an
        // http(s) URL, on desktop a file path; the URL-based GltfImport.Load handles both.
        public static string StreamGlbUrl(string slug)
        {
            string file = slug + ".glb";
#if UNITY_WEBGL && !UNITY_EDITOR
            // glTFast needs an ABSOLUTE url to fetch on WebGL. Application.streamingAssetsPath may be
            // relative ("StreamingAssets") or root-relative ("/.../StreamingAssets"); resolve it
            // against the page URL so the GLB is actually requested (a file:// prefix or a bare
            // relative path never fetched).
            string sap = Application.streamingAssetsPath;
            string candidate = sap + "/" + file;
            if (candidate.Contains("://")) return candidate;
            string page = Application.absoluteURL;
            int cut = page.IndexOfAny(new[] { '?', '#' });
            if (cut >= 0) page = page.Substring(0, cut);
            int lastSlash = page.LastIndexOf('/');
            string baseDir = lastSlash >= 0 ? page.Substring(0, lastSlash + 1) : page + "/";
            if (sap.StartsWith("/"))
            {
                int se = baseDir.IndexOf("://");
                int oe = se >= 0 ? baseDir.IndexOf('/', se + 3) : -1;
                string origin = oe >= 0 ? baseDir.Substring(0, oe) : baseDir;
                return origin + sap + "/" + file;
            }
            return baseDir + sap + "/" + file;
#else
            string path = Application.streamingAssetsPath + "/" + file;
            return path.Contains("://") ? path : "file://" + path;
#endif
        }

        // Dispose the previously streamed import's CPU buffers. Safe to call when none is active.
        public static void ReleaseStreamedImport()
        {
            if (s_ActiveOverlayImport != null) { s_ActiveOverlayImport.Dispose(); s_ActiveOverlayImport = null; }
            if (s_ActiveImport == null) return;
            s_ActiveImport.Dispose();
            s_ActiveImport = null;
        }

        // Coroutine: stream a level's GLB via glTFast under a fresh root, run the standard
        // collider/material prep, and invoke onReady(root) once instantiated. On any failure, falls
        // back to the baked LevelPrefab (if present) so a missing/corrupt stream still yields a
        // playable level. The caller owns the returned root (it must Destroy it on the next switch);
        // this only frees the prior streamed import. Run via StartCoroutine on the game manager.
        public static IEnumerator LoadStreamedLevel(DaHilgLevelProfile profile, Action<GameObject> onReady)
        {
            if (profile == null)
            {
                onReady?.Invoke(null);
                yield break;
            }

            ReleaseStreamedImport();

            // Dedicated container so the streamed scene root is unambiguous (no reliance on sibling
            // ordering) and the caller can Destroy it cleanly on the next switch.
            GameObject root = new GameObject("Level_" + profile.Slug);
            Task<GltfImport> task = LoadStreamedGltfAsync(profile.Slug, root.transform);
            while (!task.IsCompleted) yield return null;

            GltfImport import = task.IsFaulted ? null : task.Result;
            if (import != null && root != null)
            {
                s_ActiveImport = import;
                ApplyLevelOffset(root, profile);
                PrepareLevelColliders(root);
                BuildPavedOverlay(root, profile);

                // Layer the vegetation/water overlay (creek + instanced trees/grass that the
                // single-surface env drops) on top, parented UNDER root so it inherits the same
                // offset. Optional: a missing/failed overlay just leaves the bare env.
                GameObject overlayRoot = new GameObject("Overlay");
                overlayRoot.transform.SetParent(root.transform, false);
                Task<GltfImport> overlayTask = LoadStreamedGltfAsync(profile.Slug + "_overlay", overlayRoot.transform);
                while (!overlayTask.IsCompleted) yield return null;
                GltfImport overlayImport = overlayTask.IsFaulted ? null : overlayTask.Result;
                if (overlayImport != null)
                {
                    s_ActiveOverlayImport = overlayImport;
                    PrepareLevelColliders(overlayRoot, addColliders: false); // visual only: animates water, tunes trees/grass
                    GroundVegetationOverlay(overlayRoot, profile.WaterHeightOffset); // snap trees/grass/water onto the re-grounded env
                }
                else if (overlayRoot != null)
                {
                    UnityEngine.Object.Destroy(overlayRoot);
                }

                onReady?.Invoke(root);
                yield break;
            }

            // Stream failed: dispose any partial import + container, fall back to the baked prefab.
            import?.Dispose();
            if (root != null) UnityEngine.Object.Destroy(root);
            if (profile.LevelPrefab != null)
            {
                Debug.LogWarning("[DaHilg] Streamed load failed for '" + profile.Slug + "'; falling back to baked prefab.");
                GameObject baked = UnityEngine.Object.Instantiate(profile.LevelPrefab);
                baked.name = "Level_" + profile.Slug;
                ApplyLevelOffset(baked, profile);
                PrepareLevelColliders(baked);
                BuildPavedOverlay(baked, profile);
                onReady?.Invoke(baked);
            }
            else
            {
                Debug.LogError("[DaHilg] Streamed load failed for '" + profile.Slug + "' and no baked fallback prefab is available.");
                onReady?.Invoke(null);
            }
        }

        static async Task<GltfImport> LoadStreamedGltfAsync(string slug, Transform parent)
        {
            string url = StreamGlbUrl(slug);
            GltfImport import = null;
            try
            {
                // Attach glTFast's ConsoleLogger so its own failure reason surfaces in the browser console.
                import = new GltfImport(null, null, null, new GLTFast.Logging.ConsoleLogger());
                bool loaded = await import.Load(url);
                if (!loaded)
                {
                    import.Dispose();
                    return null;
                }

                bool instantiated = await import.InstantiateMainSceneAsync(parent);
                if (!instantiated)
                {
                    import.Dispose();
                    return null;
                }

                return import;
            }
            catch (Exception e)
            {
                Debug.LogError("[DaHilg] glTFast stream load failed for '" + slug + "' at " + url + ": " + e.GetType().Name + ": " + e.Message);
                import?.Dispose();
                return null;
            }
        }

        public static void ApplyLevelOffset(GameObject level, DaHilgLevelProfile profile)
        {
            if (level == null || profile == null) return;
            level.transform.position = -profile.LevelOffset;
        }

        public static void PrepareLevelColliders(GameObject level, bool addColliders = true)
        {
            if (level == null) return;
            if (addColliders)
            {
                // Fresh level load: reset the collider + facade registries (the previous level's
                // entries belong to a now-destroyed root). The vegetation overlay reuses this method
                // with addColliders=false and must NOT wipe these — clearing the level-collider
                // registry (read at line ~659 for the ground check) makes actors fall through.
                s_LevelColliders.Clear();
                s_FacadeRenderers.Clear();
                s_ConfiguredVegetationMaterials.Clear();
                s_DetailNormaledTerrainMaterials.Clear();
                s_ConfiguredGlassMaterials.Clear();
                s_ProceduralCreekWaterActive = false;
                ClearSurfaceMasks();
            }

            MeshFilter[] filters = level.GetComponentsInChildren<MeshFilter>(true);

            // Profile-relative scale so the overhang cull thresholds (tuned for the home
            // neighborhood) don't misfire on larger levels (canyon/stanton).
            float levelScale = ComputeLevelScale(level);
            bool hasCollisionProxy = false;
            for (int i = 0; i < filters.Length; i++)
            {
                string lower = filters[i].name.ToLowerInvariant();
                if (lower.StartsWith("collision_") && !lower.Contains("trees"))
                {
                    hasCollisionProxy = true;
                    break;
                }
            }

            for (int i = 0; i < filters.Length; i++)
            {
                MeshFilter filter = filters[i];
                if (filter.sharedMesh == null) continue;

                string lower = filter.name.ToLowerInvariant();
                bool isCollisionProxy = lower.StartsWith("collision_");
                bool isTreeCollision = isCollisionProxy && lower.Contains("trees");
                // Only the actual water SURFACE is water. Creek_Banks/Rocks/Reeds also contain "creek"
                // but must NOT get the blue water tint + flow animator (that's why the banks read teal).
                bool isWater = (lower.Contains("water") || lower.Contains("creek_sanlorenzo") || lower.Contains("river"))
                               && !lower.Contains("bank") && !lower.Contains("rock") && !lower.Contains("reed")
                               && !lower.Contains("flowline") && !lower.Contains("flow_line") && !lower.Contains("line");
                // Walls must be SOLID even with a collision proxy (the building proxy floats ~1.5m off
                // the ground, so you could walk under/through walls). Doors stay collider-free = walkable.
                bool isDoor = lower.Contains("door");
                // Only WALLS are solid. Roofs were also solid, but the camera deoccluder then collided
                // with the dense overhanging eaves and jammed a wall across the screen at spawn (you
                // can't reach a roof anyway, so dropping its collider has no gameplay cost).
                bool isSolidWall = !isDoor && lower.EndsWith("_walls");
                // The vegetation/water overlay is VISUAL ONLY — the single-surface env owns collision.
                // (Baking MeshColliders on the merged trees/grass made a 2M-tri collider that ejected
                //  the player.) addColliders=false => tune materials + animate water, add no colliders.
                bool useCollider = addColliders && (hasCollisionProxy ? (isCollisionProxy && !isTreeCollision) || isSolidWall : !isWater);

                if (isCollisionProxy && filter.TryGetComponent(out Renderer renderer))
                {
                    renderer.enabled = false;
                }

                Collider levelCollider = filter.GetComponent<Collider>();
                if (useCollider && levelCollider == null)
                {
                    Mesh shared = filter.sharedMesh;
                    // glTFast strips mesh CPU data after GPU upload unless GLTFAST_KEEP_MESH_DATA
                    // is defined; baking a MeshCollider from a non-readable mesh yields an EMPTY
                    // collider and actors fall through the streamed terrain. Fail loud, don't bake.
                    if (shared == null || !shared.isReadable)
                    {
                        Debug.LogError("[DaHilg] Level mesh '" + filter.name +
                            "' is not readable; skipping its MeshCollider (set GLTFAST_KEEP_MESH_DATA). " +
                            "Actors could fall through this surface.");
                    }
                    else
                    {
                        Mesh colliderMesh = ColliderMeshFor(filter.name, shared);
                        GameObject colliderObject = filter.gameObject;
                        if (colliderMesh != shared)
                        {
                            colliderObject = new GameObject(filter.name + "_ColliderLOD");
                            colliderObject.transform.SetParent(filter.transform, false);
                            colliderObject.isStatic = true;
                        }
                        MeshCollider collider = colliderObject.AddComponent<MeshCollider>();
                        collider.sharedMesh = colliderMesh;
                        collider.convex = false;
                        levelCollider = collider;
                    }
                }
                else if (useCollider)
                {
                    levelCollider = filter.GetComponent<Collider>();
                }

                if (useCollider && levelCollider != null)
                {
                    levelCollider.isTrigger = false;
                    s_LevelColliders.Add(levelCollider);
                }

                if (isWater && filter.GetComponent<DaHilgWaterAnimator>() == null)
                {
                    filter.gameObject.AddComponent<DaHilgWaterAnimator>();
                }

                TuneLevelSurface(filter, lower, isWater, isCollisionProxy, levelScale, addColliders);

                // Single-surface rendering passes (mirror the web Level.jsx tuning):
                //   - the welded 'Terrain' material gets a tiling detail-normal so asphalt/concrete
                //     read as a surface (not flat paint) at the driving camera;
                //   - window-glass nodes get a glassy (low-roughness/metallic) material;
                //   - Buildings_facade_page* (older builds: SVFacade_page*) photo renderers are
                //     collected for SetFacadesVisible (left visible by default — photo mode on).
                if (!isCollisionProxy)
                {
                    string fname = filter.name;
                    if (lower.StartsWith("terrain")) ApplyTerrainDetailNormal(filter);
                    if (lower.Contains("window")) ApplyGlassSurface(filter);
                    if ((fname.StartsWith("Buildings_facade", StringComparison.OrdinalIgnoreCase)
                         || fname.StartsWith("SVFacade", StringComparison.OrdinalIgnoreCase))
                        && filter.TryGetComponent(out Renderer facadeRenderer))
                    {
                        s_FacadeRenderers.Add(facadeRenderer);
                    }
                }

                filter.gameObject.isStatic = true;
            }

            // Additive perf: don't draw foliage/small props across the full 600m+ frustum.
            ConfigureCameraCullDistances(Camera.main);
        }

        public static void BuildPavedOverlay(GameObject levelRoot, DaHilgLevelProfile profile)
        {
            if (levelRoot == null || profile == null || profile.Minimap == null || string.IsNullOrEmpty(profile.Minimap.text)) return;

            string json = profile.Minimap.text;
            int n = Mathf.RoundToInt(ExtractFloat(json, "fillN", 0f));
            if (n <= 0 || n > 512) return;

            float minX = ExtractFloat(json, "minX", profile.PlayBounds.min.x);
            float minZ = ExtractFloat(json, "minZ", profile.PlayBounds.min.z);
            float maxX = ExtractFloat(json, "maxX", profile.PlayBounds.max.x);
            float maxZ = ExtractFloat(json, "maxZ", profile.PlayBounds.max.z);
            if (maxX <= minX || maxZ <= minZ) return;

            s_SurfaceMaskN = n;
            s_SurfaceMaskBounds = new Rect(minX, minZ, maxX - minX, maxZ - minZ);
            s_SurfaceMaskRoad = ExtractBase64(json, "fillRoad");
            s_SurfaceMaskDrive = ExtractBase64(json, "fillDrive");
            s_SurfaceMaskWalk = ExtractBase64(json, "fillWalk");
            s_SurfaceMaskCurb = ExtractBase64(json, "fillCurb");
            s_SurfaceMaskLine = ExtractBase64(json, "fillLine");
            s_SurfaceMaskWater = ExtractBase64(json, "fillWater");

            BuildMaskSurfaceOverlay(levelRoot, "PavedOverlay_Roads", s_SurfaceMaskRoad, n, minX, minZ, maxX, maxZ,
                0.050f, new Color(0.235f, 0.245f, 0.255f, 1f), 0.42f, (int)RenderQueue.Geometry + 25, false);
            BuildMaskSurfaceOverlay(levelRoot, "PavedOverlay_Driveways", s_SurfaceMaskDrive, n, minX, minZ, maxX, maxZ,
                0.054f, new Color(0.285f, 0.295f, 0.305f, 1f), 0.36f, (int)RenderQueue.Geometry + 26, false);
            BuildMaskSurfaceOverlay(levelRoot, "PavedOverlay_Sidewalks", s_SurfaceMaskWalk, n, minX, minZ, maxX, maxZ,
                0.064f, new Color(0.62f, 0.60f, 0.54f, 1f), 0.32f, (int)RenderQueue.Geometry + 27, false);
            BuildMaskSurfaceOverlay(levelRoot, "PavedOverlay_Curbs", s_SurfaceMaskCurb, n, minX, minZ, maxX, maxZ,
                0.074f, new Color(0.78f, 0.77f, 0.70f, 1f), 0.28f, (int)RenderQueue.Geometry + 28, false);
            BuildMaskSurfaceOverlay(levelRoot, "PavedOverlay_Lines", s_SurfaceMaskLine, n, minX, minZ, maxX, maxZ,
                0.084f, new Color(0.95f, 0.72f, 0.18f, 1f), 0.20f, (int)RenderQueue.Geometry + 29, false);
            // Procedural creek: a FLAT waterline filling the channel (computed inside the builder from
            // the channel-floor distribution), not a sheet draped over the floor. The `lift` arg is
            // ignored for water. dahill-only: gated by fillWater cells, so other levels (0 water cells ->
            // BuildMaskSurfaceOverlay returns false) cannot regress.
            bool water = BuildMaskSurfaceOverlay(levelRoot, "ProceduralCreekWater", s_SurfaceMaskWater, n, minX, minZ, maxX, maxZ,
                0f, new Color(0.10f, 0.46f, 0.78f, 0.96f), 0.88f,
                (int)RenderQueue.Geometry + 35, true);
            s_ProceduralCreekWaterActive = water;
        }

        static void ClearSurfaceMasks()
        {
            s_SurfaceMaskN = 0;
            s_SurfaceMaskBounds = default;
            s_SurfaceMaskRoad = null;
            s_SurfaceMaskDrive = null;
            s_SurfaceMaskWalk = null;
            s_SurfaceMaskCurb = null;
            s_SurfaceMaskLine = null;
            s_SurfaceMaskWater = null;
        }

        public static bool IsGeneratedPavedOrWater(Vector3 worldPoint)
        {
            if (s_SurfaceMaskN <= 0 || s_SurfaceMaskBounds.width <= 0f || s_SurfaceMaskBounds.height <= 0f) return false;
            float u = (worldPoint.x - s_SurfaceMaskBounds.xMin) / s_SurfaceMaskBounds.width;
            float v = (worldPoint.z - s_SurfaceMaskBounds.yMin) / s_SurfaceMaskBounds.height;
            if (u < 0f || u > 1f || v < 0f || v > 1f) return false;
            int col = Mathf.Clamp(Mathf.FloorToInt(u * s_SurfaceMaskN), 0, s_SurfaceMaskN - 1);
            int row = Mathf.Clamp(Mathf.FloorToInt(v * s_SurfaceMaskN), 0, s_SurfaceMaskN - 1);
            return RoadBit(s_SurfaceMaskRoad, s_SurfaceMaskN, col, row)
                || RoadBit(s_SurfaceMaskDrive, s_SurfaceMaskN, col, row)
                || RoadBit(s_SurfaceMaskWalk, s_SurfaceMaskN, col, row)
                || RoadBit(s_SurfaceMaskCurb, s_SurfaceMaskN, col, row)
                || RoadBit(s_SurfaceMaskLine, s_SurfaceMaskN, col, row)
                || RoadBit(s_SurfaceMaskWater, s_SurfaceMaskN, col, row);
        }

        static bool BuildMaskSurfaceOverlay(GameObject levelRoot, string name, byte[] bits, int n,
            float minX, float minZ, float maxX, float maxZ, float lift, Color color, float smoothness,
            int renderQueue, bool water)
        {
            if (bits == null || bits.Length == 0) return false;

            // Creek water surface. "Da Hill": the creek descends a long hillside (bed spans tens of metres),
            // so a single flat plane floats in mid-air and a thin bed-hugging drape is invisible. Build a
            // LOCALLY-flat fill instead: each water cell's surface = (lowest bed in a small neighbourhood =
            // the channel bottom) + a few-feet depth. That fills the channel flat ACROSS its width while
            // stepping DOWN the slope along the flow. Shared corner heights are averaged so the surface is
            // continuous (no terracing). Logged for in-engine tuning.
            Dictionary<int, float> waterCornerY = null;
            const float k_WaterDepth = 0.7f;
            int stride = n + 1;
            if (water)
            {
                Dictionary<int, float> bed = new Dictionary<int, float>(2048);
                for (int wr = 0; wr < n; wr++)
                    for (int wc = 0; wc < n; wc++)
                        if (RoadBit(bits, n, wc, wr))
                        {
                            float cx = Mathf.Lerp(minX, maxX, (wc + 0.5f) / n);
                            float cz = Mathf.Lerp(minZ, maxZ, (wr + 0.5f) / n);
                            bed[wr * n + wc] = GroundSpawn(new Vector3(cx, 0f, cz)).y;
                        }
                if (bed.Count == 0) return false;
                const int R = 3;
                Dictionary<int, float> level = new Dictionary<int, float>(bed.Count);
                foreach (KeyValuePair<int, float> kv in bed)
                {
                    int wr = kv.Key / n, wc = kv.Key % n;
                    float localMin = float.PositiveInfinity;
                    for (int dr = -R; dr <= R; dr++)
                        for (int dc = -R; dc <= R; dc++)
                            if (bed.TryGetValue((wr + dr) * n + (wc + dc), out float b) && b < localMin) localMin = b;
                    level[kv.Key] = localMin + k_WaterDepth;
                }
                Dictionary<int, float> sum = new Dictionary<int, float>(level.Count * 2);
                Dictionary<int, int> cnt = new Dictionary<int, int>(level.Count * 2);
                void Acc(int k, float y)
                {
                    sum[k] = (sum.TryGetValue(k, out float s) ? s : 0f) + y;
                    cnt[k] = (cnt.TryGetValue(k, out int c) ? c : 0) + 1;
                }
                foreach (KeyValuePair<int, float> kv in level)
                {
                    int wr = kv.Key / n, wc = kv.Key % n; float y = kv.Value;
                    Acc(wr * stride + wc, y); Acc(wr * stride + wc + 1, y);
                    Acc((wr + 1) * stride + wc, y); Acc((wr + 1) * stride + wc + 1, y);
                }
                waterCornerY = new Dictionary<int, float>(sum.Count);
                foreach (KeyValuePair<int, float> kv in sum) waterCornerY[kv.Key] = kv.Value / cnt[kv.Key];
                List<float> bv = new List<float>(bed.Values); bv.Sort();
                List<float> lv = new List<float>(level.Values); lv.Sort();
                Debug.Log($"[DaHilg] Creek water: cells={bed.Count} bed[min={bv[0]:F2} med={bv[bv.Count / 2]:F2} max={bv[bv.Count - 1]:F2}] level[min={lv[0]:F2} med={lv[lv.Count / 2]:F2} max={lv[lv.Count - 1]:F2}] depth={k_WaterDepth:F2}");
            }

            List<Vector3> vertices = new List<Vector3>(8192);
            List<int> triangles = new List<int>(12288);
            if (water)
            {
                // one quad per water cell using the shared averaged corner heights -> continuous fill
                for (int row = 0; row < n; row++)
                    for (int col = 0; col < n; col++)
                    {
                        if (!RoadBit(bits, n, col, row)) continue;
                        float x0 = Mathf.Lerp(minX, maxX, col / (float)n);
                        float x1 = Mathf.Lerp(minX, maxX, (col + 1) / (float)n);
                        float z0 = Mathf.Lerp(minZ, maxZ, row / (float)n);
                        float z1 = Mathf.Lerp(minZ, maxZ, (row + 1) / (float)n);
                        float y00 = waterCornerY[row * stride + col];
                        float y10 = waterCornerY[row * stride + col + 1];
                        float y01 = waterCornerY[(row + 1) * stride + col];
                        float y11 = waterCornerY[(row + 1) * stride + col + 1];
                        AddSurfaceQuad(vertices, triangles,
                            new Vector3(x0, y00, z0), new Vector3(x1, y10, z0),
                            new Vector3(x1, y11, z1), new Vector3(x0, y01, z1));
                    }
            }
            else
            {
                for (int row = 0; row < n; row++)
                {
                    int col = 0;
                    while (col < n)
                    {
                        while (col < n && !RoadBit(bits, n, col, row)) col++;
                        if (col >= n) break;
                        int start = col;
                        while (col < n && RoadBit(bits, n, col, row)) col++;
                        int end = col;

                        float x0 = Mathf.Lerp(minX, maxX, start / (float)n);
                        float x1 = Mathf.Lerp(minX, maxX, end / (float)n);
                        float z0 = Mathf.Lerp(minZ, maxZ, row / (float)n);
                        float z1 = Mathf.Lerp(minZ, maxZ, (row + 1) / (float)n);

                        AddSurfaceQuad(vertices, triangles,
                            GroundSpawn(new Vector3(x0, 0f, z0)) + Vector3.up * lift,
                            GroundSpawn(new Vector3(x1, 0f, z0)) + Vector3.up * lift,
                            GroundSpawn(new Vector3(x1, 0f, z1)) + Vector3.up * lift,
                            GroundSpawn(new Vector3(x0, 0f, z1)) + Vector3.up * lift);
                    }
                }
            }

            if (vertices.Count == 0) return false;

            Mesh mesh = new Mesh
            {
                name = name + "Mesh",
                indexFormat = vertices.Count > 65000 ? IndexFormat.UInt32 : IndexFormat.UInt16
            };
            mesh.SetVertices(vertices);
            if (water)
            {
                // Planar world-XZ UVs so the scrolling creek-flow texture (set in ConfigureWaterMaterial,
                // stretched 5.5x1.6 = ripples elongated along flow) actually maps and animates. Without
                // UVs the flow texture sampled (0,0) everywhere and the creek read as a dead blue slab.
                Vector2[] uv = new Vector2[vertices.Count];
                for (int i = 0; i < vertices.Count; i++) uv[i] = new Vector2(vertices[i].x * 0.05f, vertices[i].z * 0.05f);
                mesh.SetUVs(0, uv);
            }
            mesh.SetTriangles(triangles, 0, true);
            mesh.RecalculateBounds();
            mesh.RecalculateNormals();

            GameObject overlay = new GameObject(name);
            overlay.transform.SetParent(levelRoot.transform, true);
            MeshFilter filter = overlay.AddComponent<MeshFilter>();
            filter.sharedMesh = mesh;
            MeshRenderer renderer = overlay.AddComponent<MeshRenderer>();
            Material material = CreateOverlayMaterial(levelRoot, name + "_mat", color, smoothness, renderQueue, water);
            if (material == null)
            {
                UnityEngine.Object.Destroy(overlay);
                return false;
            }
            renderer.sharedMaterial = material;
            renderer.shadowCastingMode = ShadowCastingMode.Off;
            renderer.receiveShadows = false;
            if (water) overlay.AddComponent<DaHilgWaterAnimator>();
            return true;
        }

        static Material CreateOverlayMaterial(GameObject levelRoot, string name, Color color, float smoothness, int renderQueue, bool water)
        {
            Material source = FindLevelMaterial(levelRoot);
            Material material = null;
            if (source != null && source.shader != null)
            {
                material = new Material(source) { name = name };
            }
            else
            {
                Shader shader = Shader.Find("Universal Render Pipeline/Lit");
                if (shader == null) shader = Shader.Find("Standard");
                if (shader == null) shader = Shader.Find("Unlit/Color");
                if (shader != null) material = new Material(shader) { name = name };
            }

            if (material == null)
            {
                Debug.LogWarning("[DaHilg] Paved overlay skipped: no compatible material/shader was available.");
                return null;
            }

            if (material.HasProperty("_BaseMap")) material.SetTexture("_BaseMap", null);
            if (material.HasProperty("_MainTex")) material.SetTexture("_MainTex", null);
            if (material.HasProperty(s_BaseColorId)) material.SetColor(s_BaseColorId, color);
            if (material.HasProperty(s_ColorId)) material.SetColor(s_ColorId, color);
            if (material.HasProperty(s_MetallicId)) material.SetFloat(s_MetallicId, 0.0f);
            if (material.HasProperty(s_SmoothnessId)) material.SetFloat(s_SmoothnessId, smoothness);
            if (material.HasProperty(s_GlossinessId)) material.SetFloat(s_GlossinessId, smoothness);
            if (water)
            {
                ConfigureWaterMaterial(material);
                if (material.HasProperty(s_BaseColorId)) material.SetColor(s_BaseColorId, color);
                if (material.HasProperty(s_ColorId)) material.SetColor(s_ColorId, color);
                material.EnableKeyword("_EMISSION");
                if (material.HasProperty("_EmissionColor")) material.SetColor("_EmissionColor", new Color(0.04f, 0.23f, 0.40f));
            }
            material.renderQueue = renderQueue;
            material.enableInstancing = true;
            return material;
        }

        static Material FindLevelMaterial(GameObject levelRoot)
        {
            if (levelRoot == null) return null;
            Renderer[] renderers = levelRoot.GetComponentsInChildren<Renderer>(true);
            for (int i = 0; i < renderers.Length; i++)
            {
                Renderer renderer = renderers[i];
                if (renderer == null || renderer.sharedMaterial == null) continue;
                string lower = renderer.name.ToLowerInvariant();
                if (lower.StartsWith("collision_")) continue;
                return renderer.sharedMaterial;
            }
            return null;
        }

        static void AddSurfaceQuad(List<Vector3> vertices, List<int> triangles, Vector3 a, Vector3 b, Vector3 c, Vector3 d)
        {
            int v = vertices.Count;
            vertices.Add(a);
            vertices.Add(b);
            vertices.Add(c);
            vertices.Add(d);
            triangles.Add(v);
            triangles.Add(v + 1);
            triangles.Add(v + 2);
            triangles.Add(v);
            triangles.Add(v + 2);
            triangles.Add(v + 3);
        }

        static bool RoadBit(byte[] bits, int n, int col, int row)
        {
            if (col < 0 || col >= n || row < 0 || row >= n) return false;
            int cell = row * n + col;
            int byteIndex = cell >> 3;
            if (byteIndex < 0 || byteIndex >= bits.Length) return false;
            return (bits[byteIndex] & (1 << (cell & 7))) != 0;
        }

        static Mesh ColliderMeshFor(string objectName, Mesh source)
        {
            if (source == null) return null;
            string lower = objectName != null ? objectName.ToLowerInvariant() : string.Empty;
            if (!lower.Contains("collision_terrain") || source.vertexCount < 100000) return source;
            if (s_ColliderMeshCache.TryGetValue(source, out Mesh cached) && cached != null) return cached;

            Mesh simplified = BuildSimplifiedGridColliderMesh(source, 160);
            if (simplified == null) return source;
            s_ColliderMeshCache[source] = simplified;
            return simplified;
        }

        static Mesh BuildSimplifiedGridColliderMesh(Mesh source, int targetSide)
        {
            Vector3[] srcVertices = source.vertices;
            Dictionary<long, Vector3> byCoord = new Dictionary<long, Vector3>(srcVertices.Length);
            HashSet<int> xSet = new HashSet<int>();
            HashSet<int> zSet = new HashSet<int>();
            for (int i = 0; i < srcVertices.Length; i++)
            {
                Vector3 v = srcVertices[i];
                int qx = Mathf.RoundToInt(v.x * 1000f);
                int qz = Mathf.RoundToInt(v.z * 1000f);
                xSet.Add(qx);
                zSet.Add(qz);
                byCoord[CoordKey(qx, qz)] = v;
            }

            List<int> xs = new List<int>(xSet);
            List<int> zs = new List<int>(zSet);
            xs.Sort();
            zs.Sort();
            if (xs.Count < 8 || zs.Count < 8 || xs.Count * zs.Count != srcVertices.Length) return null;

            List<int> sampleX = SampleAxis(xs, targetSide);
            List<int> sampleZ = SampleAxis(zs, targetSide);
            int width = sampleX.Count;
            int height = sampleZ.Count;
            Vector3[] vertices = new Vector3[width * height];
            int vOut = 0;
            for (int row = 0; row < height; row++)
            {
                int qz = sampleZ[row];
                for (int col = 0; col < width; col++)
                {
                    if (!byCoord.TryGetValue(CoordKey(sampleX[col], qz), out Vector3 sampled)) return null;
                    vertices[vOut++] = sampled;
                }
            }

            int[] triangles = new int[(width - 1) * (height - 1) * 6];
            int t = 0;
            for (int row = 0; row < height - 1; row++)
            {
                for (int col = 0; col < width - 1; col++)
                {
                    int a = row * width + col;
                    int b = a + 1;
                    int c = a + width;
                    int d = c + 1;
                    triangles[t++] = a;
                    triangles[t++] = c;
                    triangles[t++] = b;
                    triangles[t++] = b;
                    triangles[t++] = c;
                    triangles[t++] = d;
                }
            }

            if (triangles.Length >= 3)
            {
                Vector3 normal = Vector3.Cross(vertices[triangles[1]] - vertices[triangles[0]], vertices[triangles[2]] - vertices[triangles[0]]);
                if (normal.y < 0f)
                {
                    for (int i = 0; i < triangles.Length; i += 3)
                    {
                        int swap = triangles[i + 1];
                        triangles[i + 1] = triangles[i + 2];
                        triangles[i + 2] = swap;
                    }
                }
            }

            Mesh mesh = new Mesh { name = source.name + "_ColliderLOD" };
            mesh.indexFormat = vertices.Length > 65000 ? IndexFormat.UInt32 : IndexFormat.UInt16;
            mesh.vertices = vertices;
            mesh.triangles = triangles;
            mesh.RecalculateBounds();
            return mesh;
        }

        static List<int> SampleAxis(List<int> values, int targetSide)
        {
            int count = values.Count;
            int side = Mathf.Clamp(targetSide, 8, count);
            int step = Mathf.Max(1, Mathf.CeilToInt((count - 1) / (float)(side - 1)));
            List<int> samples = new List<int>(side);
            for (int i = 0; i < count; i += step) samples.Add(values[i]);
            if (samples[samples.Count - 1] != values[count - 1]) samples.Add(values[count - 1]);
            return samples;
        }

        static long CoordKey(int qx, int qz)
        {
            return ((long)qx << 32) ^ (uint)qz;
        }

        static float ExtractFloat(string json, string key, float fallback)
        {
            Match match = Regex.Match(json, "\"" + Regex.Escape(key) + "\"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)");
            if (match.Success && float.TryParse(match.Groups[1].Value, NumberStyles.Float, CultureInfo.InvariantCulture, out float value)) return value;
            return fallback;
        }

        static byte[] ExtractBase64(string json, string key)
        {
            Match match = Regex.Match(json, "\"" + Regex.Escape(key) + "\"\\s*:\\s*\"([A-Za-z0-9+/=]*)\"");
            if (!match.Success) return null;
            try { return Convert.FromBase64String(match.Groups[1].Value); }
            catch { return null; }
        }

        // Layer indices used for per-layer cull distances. Resolved by name so missing
        // layers degrade gracefully (no-op) instead of breaking existing mask logic.
        const float k_FoliageCullDistance = 180f;
        const float k_PropCullDistance = 240f;

        public static void ConfigureCameraCullDistances(Camera camera)
        {
            if (camera == null) return;

            float[] distances = camera.layerCullDistances;
            if (distances == null || distances.Length != 32) distances = new float[32];

            ApplyLayerCull(distances, "Foliage", k_FoliageCullDistance);
            ApplyLayerCull(distances, "Vegetation", k_FoliageCullDistance);
            ApplyLayerCull(distances, "Props", k_PropCullDistance);
            ApplyLayerCull(distances, "SmallProps", k_PropCullDistance);

            camera.layerCullDistances = distances;
            camera.layerCullSpherical = true;
        }

        static void ApplyLayerCull(float[] distances, string layerName, float distance)
        {
            int layer = LayerMask.NameToLayer(layerName);
            if (layer >= 0 && layer < distances.Length) distances[layer] = distance;
        }

        // Reference span of the tuned-for level (home neighborhood). Used to normalize the
        // overhang-cull thresholds against arbitrarily sized levels.
        const float k_ReferenceLevelSpan = 220f;

        static float ComputeLevelScale(GameObject level)
        {
            Renderer[] renderers = level.GetComponentsInChildren<Renderer>(true);
            if (renderers.Length == 0) return 1f;

            Bounds bounds = renderers[0].bounds;
            for (int i = 1; i < renderers.Length; i++)
            {
                bounds.Encapsulate(renderers[i].bounds);
            }

            Vector3 size = bounds.size;
            if (!IsFinite(size.x) || !IsFinite(size.z)) return 1f;
            float span = Mathf.Max(size.x, size.z);
            if (span <= 0.01f) return 1f;
            return Mathf.Max(1f, span / k_ReferenceLevelSpan);
        }

        static void TuneLevelSurface(MeshFilter filter, string lowerName, bool isWater, bool isCollisionProxy, float levelScale, bool cullOverhang)
        {
            if (isCollisionProxy) return;
            if (!filter.TryGetComponent(out Renderer renderer) || renderer.sharedMaterial == null) return;

            string materialName = renderer.sharedMaterial.name.ToLowerInvariant();
            string key = lowerName + " " + materialName;
            bool isVegetation = ContainsAny(key, "tree_", "trees", "grassclump", "grass_wind", "shrub", "shrubs", "reeds");
            if (isVegetation)
            {
                TuneVegetationSurface(renderer, ContainsAny(key, "tree_", "trees"), true, levelScale, cullOverhang);
                return;
            }

            // The single-surface level welds roads/sidewalks/curbs into the ONE textured terrain,
            // so there are no separate coplanar road meshes to z-fight — the old per-road
            // renderQueue+5 / double-sided ConfigureRoadMaterial firefighting is obsolete and
            // removed. `isRoad` only classifies the (rare) road-named material for tinting now.
            // Creek banks/rocks: earthy, not the teal "green curbs" the master ships them as.
            if (ContainsAny(key, "bank", "rock"))
            {
                MaterialPropertyBlock bankBlock = new MaterialPropertyBlock();
                renderer.GetPropertyBlock(bankBlock);
                Color earth = new Color(0.34f, 0.28f, 0.19f, 1f);
                if (renderer.sharedMaterial.HasProperty(s_BaseColorId)) bankBlock.SetColor(s_BaseColorId, earth);
                if (renderer.sharedMaterial.HasProperty(s_ColorId)) bankBlock.SetColor(s_ColorId, earth);
                renderer.SetPropertyBlock(bankBlock);
                return;
            }

            bool isRoad = ContainsAny(key, "road", "street", "drive", "asphalt", "curb");
            bool isGround = isRoad || ContainsAny(key, "ground", "terrain", "grass", "yard", "walk", "sidewalk", "landscape", "dirt", "soil");
            if (!isGround && !isWater) return;

            if (!isWater && HasUsefulBaseTexture(renderer.sharedMaterial))
            {
                MaterialPropertyBlock photoBlock = new MaterialPropertyBlock();
                renderer.GetPropertyBlock(photoBlock);
                if (renderer.sharedMaterial.HasProperty(s_BaseColorId)) photoBlock.SetColor(s_BaseColorId, Color.white);
                if (renderer.sharedMaterial.HasProperty(s_ColorId)) photoBlock.SetColor(s_ColorId, Color.white);
                renderer.SetPropertyBlock(photoBlock);
                return;
            }

            MaterialPropertyBlock block = new MaterialPropertyBlock();
            renderer.GetPropertyBlock(block);
            Color tint = isWater
                ? new Color(0.16f, 0.55f, 0.92f, 0.96f)
                : (isRoad ? new Color(0.22f, 0.23f, 0.22f, 1f) : new Color(0.28f, 0.40f, 0.22f, 1f));

            if (renderer.sharedMaterial.HasProperty(s_BaseColorId)) block.SetColor(s_BaseColorId, tint);
            if (renderer.sharedMaterial.HasProperty(s_ColorId)) block.SetColor(s_ColorId, tint);
            // Water reads as a dark channel in shadow with base color alone; give it a blue self-glow so
            // the creek stays visibly water-blue regardless of the baked lighting on the bed.
            if (isWater)
            {
                Material wm = renderer.sharedMaterial;
                ConfigureWaterMaterial(wm);
                wm.EnableKeyword("_EMISSION");
                wm.globalIlluminationFlags = MaterialGlobalIlluminationFlags.RealtimeEmissive;
                if (wm.HasProperty("_EmissionColor")) wm.SetColor("_EmissionColor", new Color(0.07f, 0.28f, 0.46f));
            }
            renderer.SetPropertyBlock(block);
        }

        static void ConfigureWaterMaterial(Material material)
        {
            if (material == null || !Application.isPlaying) return;

            // Keep the creek reliable in WebGL/iOS: transparent sorting on the giant creek mesh can
            // make it vanish against the bed. The mesh is lifted slightly above ground, so opaque
            // smooth blue water reads better and draws consistently.
            material.SetOverrideTag("RenderType", "Opaque");
            if (material.HasProperty(s_SurfaceId)) material.SetFloat(s_SurfaceId, 0f);
            if (material.HasProperty(s_BlendId)) material.SetFloat(s_BlendId, 0f);
            if (material.HasProperty(s_SrcBlendId)) material.SetInt(s_SrcBlendId, (int)BlendMode.One);
            if (material.HasProperty(s_DstBlendId)) material.SetInt(s_DstBlendId, (int)BlendMode.Zero);
            if (material.HasProperty(s_ZWriteId)) material.SetInt(s_ZWriteId, 1);
            if (material.HasProperty(s_MetallicId)) material.SetFloat(s_MetallicId, 0.02f);
            if (material.HasProperty(s_SmoothnessId)) material.SetFloat(s_SmoothnessId, 0.86f);
            if (material.HasProperty(s_GlossinessId)) material.SetFloat(s_GlossinessId, 0.86f);
            Texture2D flow = GetWaterFlowTexture();
            if (material.HasProperty(s_BaseMapId))
            {
                material.SetTexture(s_BaseMapId, flow);
                material.SetTextureScale(s_BaseMapId, new Vector2(5.5f, 1.6f));
            }
            if (material.HasProperty(s_MainTexId))
            {
                material.SetTexture(s_MainTexId, flow);
                material.SetTextureScale(s_MainTexId, new Vector2(5.5f, 1.6f));
            }
            material.DisableKeyword("_SURFACE_TYPE_TRANSPARENT");
            material.renderQueue = (int)RenderQueue.Geometry + 20;
        }

        static Texture2D GetWaterFlowTexture()
        {
            if (s_WaterFlowTexture != null) return s_WaterFlowTexture;

            const int width = 96;
            const int height = 32;
            Texture2D tex = new Texture2D(width, height, TextureFormat.RGBA32, true, false)
            {
                name = "DaHilgCreekFlow",
                wrapMode = TextureWrapMode.Repeat,
                filterMode = FilterMode.Bilinear
            };

            Color32[] pixels = new Color32[width * height];
            for (int y = 0; y < height; y++)
            {
                for (int x = 0; x < width; x++)
                {
                    float u = x / (float)width;
                    float v = y / (float)height;
                    float streak = 0.5f + 0.5f * Mathf.Sin((u * 7.5f + v * 1.6f) * Mathf.PI * 2f);
                    float ripple = Mathf.PerlinNoise(u * 9f, v * 5f);
                    float foam = Mathf.Clamp01((streak * 0.55f + ripple * 0.45f - 0.54f) * 2.4f);
                    Color c = Color.Lerp(new Color(0.08f, 0.35f, 0.62f, 1f), new Color(0.42f, 0.83f, 1f, 1f), foam);
                    pixels[y * width + x] = c;
                }
            }

            tex.SetPixels32(pixels);
            tex.Apply(true, false);
            s_WaterFlowTexture = tex;
            return s_WaterFlowTexture;
        }

        static bool HasUsefulBaseTexture(Material material)
        {
            if (material == null) return false;
            if (material.mainTexture != null) return true;
            if (material.HasProperty("_BaseMap") && material.GetTexture("_BaseMap") != null) return true;
            if (material.HasProperty("_MainTex") && material.GetTexture("_MainTex") != null) return true;
            return false;
        }

        // The vegetation overlay keeps the rich master's vertex heights (placed on the original hilly
        // terrain, y 33->94), but the single-surface env was re-grounded/flattened — so trees float
        // ~12m and grass ~20m above the new ground (off the top of the view => "no trees/grass").
        // Raycast each plant's base onto the env ground collider and snap it down. Creek/banks/rocks
        // are the riverbed surface itself — never lift them.
        static void GroundVegetationOverlay(GameObject overlayRoot, float waterHeightOffset)
        {
            if (overlayRoot == null) return;
            Renderer[] rends = overlayRoot.GetComponentsInChildren<Renderer>(true);
            for (int i = 0; i < rends.Length; i++)
            {
                Renderer r = rends[i];
                if (r == null) continue;
                string lower = r.gameObject.name.ToLowerInvariant();
                bool isVeg = lower.Contains("tree") || lower.Contains("grass") || lower.Contains("clump")
                             || lower.Contains("shrub") || lower.Contains("reed") || lower.Contains("bush");
                // Snap the creek too (water/banks/rocks) — it floats above the re-grounded env like the
                // trees did, which is why it reads as a tiny puddle instead of a creek in its bed.
                bool isCreek = lower.Contains("creek") || lower.Contains("water") || lower.Contains("river")
                               || lower.Contains("bank") || lower.Contains("rock");
                bool isWaterSurface = (lower.Contains("creek_sanlorenzo") || lower.Contains("water") || lower.Contains("river"))
                                      && !lower.Contains("bank") && !lower.Contains("rock") && !lower.Contains("reed")
                                      && !lower.Contains("flowline") && !lower.Contains("flow_line") && !lower.Contains("line");
                if (!isVeg && !isCreek) continue;
                if (isWaterSurface && s_ProceduralCreekWaterActive)
                {
                    r.enabled = false;
                    continue;
                }
                if (isWaterSurface && ConformWaterSurfaceToGround(r, waterHeightOffset)) continue;

                Bounds b = r.bounds;
                Vector3 worldBase = isWaterSurface
                    ? new Vector3(b.center.x, b.center.y, b.center.z)
                    : new Vector3(b.center.x, b.min.y, b.center.z);
                // Wide probe (up 90, down 400): the master's hilly veg can sit far above OR below the
                // re-grounded env; snap each plant's base onto the ground so none float or sink under terrain.
                if (TryFindGround(worldBase, out RaycastHit hit, 90f, 400f))
                {
                    float lift = isWaterSurface ? Mathf.Max(0.06f, waterHeightOffset) : 0.03f;
                    float dy = hit.point.y + lift - worldBase.y;
                    if (isWaterSurface || dy < -0.05f || dy > 0.05f) r.transform.position += new Vector3(0f, dy, 0f);
                }
            }
        }

        static bool ConformWaterSurfaceToGround(Renderer renderer, float waterHeightOffset)
        {
            if (renderer == null || !renderer.TryGetComponent(out MeshFilter filter)) return false;
            Mesh source = filter.sharedMesh;
            if (source == null || !source.isReadable) return false;

            Mesh mesh = UnityEngine.Object.Instantiate(source);
            mesh.name = source.name + "_CreekGrounded";
            Vector3[] vertices = mesh.vertices;
            if (vertices == null || vertices.Length == 0)
            {
                UnityEngine.Object.Destroy(mesh);
                return false;
            }

            Transform t = filter.transform;
            float lift = Mathf.Clamp(waterHeightOffset, 0.045f, 0.12f);
            int grounded = 0;
            for (int i = 0; i < vertices.Length; i++)
            {
                Vector3 world = t.TransformPoint(vertices[i]);
                if (!TryFindGround(world, out RaycastHit hit, 90f, 420f)) continue;
                world.y = hit.point.y + lift;
                vertices[i] = t.InverseTransformPoint(world);
                grounded++;
            }

            if (grounded == 0)
            {
                UnityEngine.Object.Destroy(mesh);
                return false;
            }

            mesh.vertices = vertices;
            mesh.RecalculateBounds();
            mesh.RecalculateNormals();
            filter.sharedMesh = mesh;
            return true;
        }

        static void TuneVegetationSurface(Renderer renderer, bool isTree, bool useCutout, float levelScale, bool cullOverhang)
        {
            // Trees cast shadows (grounds them in the scene); billboards still skip
            // receiving shadows to avoid lighting artifacts on flat cards.
            renderer.shadowCastingMode = isTree ? ShadowCastingMode.On : ShadowCastingMode.Off;
            renderer.receiveShadows = false;

            // Configure EVERY submaterial (e.g. the acacia's separate leaf material), not just
            // sharedMaterial[0]; de-duped via the shared set so each is configured once per session.
            Material[] materials = renderer.sharedMaterials;
            if (materials != null)
            {
                foreach (Material m in materials)
                {
                    if (m != null && s_ConfiguredVegetationMaterials.Add(m))
                        ConfigureVegetationMaterial(m, useCutout);
                }
            }
            Material material = renderer.sharedMaterial;

            // The overhang cull (absolute-y thresholds tuned for the baked env, whose ground sits
            // near y=0 after its huge span inflates levelScale) WRONGLY hides EVERY overlay tree:
            // this level's ground is at y~33 and the overlay's levelScale is small, so max.y>18*s
            // fires for all of them. The overlay's trees are curated — never overhang-cull them.
            if (cullOverhang && isTree && IsOverhangingTreeRenderer(renderer, levelScale))
            {
                renderer.enabled = false;
                return;
            }

            // Grass clumps ship tiny + sparse, so they read as bare ground ("where is the grass?").
            // Fatten each clump (taller than wide) so the field actually registers; GroundVegetationOverlay
            // re-grounds it afterwards by its new bounds, so it never floats or sinks.
            if (!isTree)
            {
                string nm = renderer.name.ToLowerInvariant();
                if (nm.Contains("grass") || nm.Contains("clump"))
                {
                    Transform t = renderer.transform;
                    t.localScale = Vector3.Scale(t.localScale, new Vector3(1.8f, 2.6f, 1.8f));
                }
            }

            MaterialPropertyBlock block = new MaterialPropertyBlock();
            renderer.GetPropertyBlock(block);
            Color tint = isTree ? new Color(0.20f, 0.42f, 0.16f, 1f) : new Color(0.30f, 0.55f, 0.20f, 1f);
            if (material != null && material.HasProperty(s_BaseColorId)) block.SetColor(s_BaseColorId, tint);
            if (material != null && material.HasProperty(s_ColorId)) block.SetColor(s_ColorId, tint);
            // glTFast Built-in trees use baseColorFactor, not _BaseColor/_Color. GATE the tint to
            // dahill's TEXTURED trees only (material carries a baseColorTexture): tinting the other
            // 4 levels' solid-color placeholder trees would wrongly recolor them.
            if (material != null && material.HasProperty(s_GltfBaseColorId)
                && material.HasProperty("baseColorTexture") && material.GetTexture("baseColorTexture") != null)
                block.SetColor(s_GltfBaseColorId, tint);
            renderer.SetPropertyBlock(block);
        }

        static bool IsOverhangingTreeRenderer(Renderer renderer, float levelScale)
        {
            Bounds bounds = renderer.bounds;
            Vector3 size = bounds.size;
            if (!IsFinite(size.x) || !IsFinite(size.y) || !IsFinite(size.z)) return false;

            // Thresholds are profile-relative: scale the home-neighborhood magic numbers by
            // the level span so legit large trees in canyon/stanton aren't silently culled.
            float s = Mathf.Max(1f, levelScale);
            if (bounds.max.y > 18f * s || bounds.center.y > 11f * s) return true;
            return size.x > 13f * s || size.z > 13f * s || size.y > 15f * s;
        }

        static bool IsFinite(float value)
        {
            return !float.IsNaN(value) && !float.IsInfinity(value);
        }

        static void ConfigureVegetationMaterial(Material material, bool useCutout)
        {
            // Non-destructive guard: only mutate the shared material at play time. Tree/grass cards
            // rely on alpha cutout; forcing them fully opaque turns every card into a giant solid
            // polygon that can cover the camera.
            if (!Application.isPlaying) return;

            material.SetOverrideTag("RenderType", useCutout ? "TransparentCutout" : "Opaque");
            if (material.HasProperty(s_ModeId)) material.SetFloat(s_ModeId, useCutout ? 1f : 0f); // Built-in Standard: Cutout/Opaque
            if (material.HasProperty("_Surface")) material.SetFloat("_Surface", 0f);
            if (material.HasProperty("_Blend")) material.SetFloat("_Blend", 0f);
            if (material.HasProperty("_SrcBlend")) material.SetInt("_SrcBlend", (int)BlendMode.One);
            if (material.HasProperty("_DstBlend")) material.SetInt("_DstBlend", (int)BlendMode.Zero);
            if (material.HasProperty("_ZWrite")) material.SetInt("_ZWrite", 1);
            if (material.HasProperty(s_AlphaClipId)) material.SetFloat(s_AlphaClipId, useCutout ? 1f : 0f);
            if (material.HasProperty(s_CutoffId)) material.SetFloat(s_CutoffId, useCutout ? 0.38f : 0.5f);
            // glTFast Built-in trees use the alphaCutoff slot, not _Cutoff (the write above no-ops
            // on them). Safe on textureless trees too: their alpha samples to 1.0 so clip never fires.
            if (material.HasProperty(s_GltfAlphaCutoffId)) material.SetFloat(s_GltfAlphaCutoffId, useCutout ? 0.4f : 0.5f);
            material.DisableKeyword("_SURFACE_TYPE_TRANSPARENT");
            if (useCutout) material.EnableKeyword("_ALPHATEST_ON");
            else material.DisableKeyword("_ALPHATEST_ON");
            material.renderQueue = useCutout ? (int)RenderQueue.AlphaTest : (int)RenderQueue.Geometry;
        }

        // ---- single-surface render passes (mirror src/da-hilg/level/Level.jsx) ----------------

        // Detail-normal on the welded 'Terrain' material. The single-surface ground bakes
        // roads/sidewalks/curbs as a FLAT painted texture, so at the driving camera the asphalt
        // and concrete read as paper. A tiling secondary detail-normal (modest scale) restores a
        // surface micro-relief so they look like a real ground plane. Built-in Standard and URP Lit
        // both expose _DetailNormalMap/_DetailNormalMapScale + the _DETAIL_MULX2 keyword; all writes
        // are HasProperty-guarded so a shader without the slot is skipped (never throws). Per-material
        // once (the shared Terrain material is configured a single time per session).
        static void ApplyTerrainDetailNormal(MeshFilter filter)
        {
            if (!Application.isPlaying) return;   // never persist into the imported project asset
            if (!filter.TryGetComponent(out Renderer renderer)) return;
            Material material = renderer.sharedMaterial;
            if (material == null || !s_DetailNormaledTerrainMaterials.Add(material)) return;
            if (!material.HasProperty(s_DetailNormalMapId)) return;

            material.SetTexture(s_DetailNormalMapId, GetDetailNormalTexture());
            if (material.HasProperty(s_DetailNormalMapScaleId)) material.SetFloat(s_DetailNormalMapScaleId, 0.5f);
            // Secondary UV tiling: repeat the detail map densely over the big ground so the
            // micro-relief is fine-grained, not stretched. The detail set uses UV0 by default.
            material.SetTextureScale(s_DetailNormalMapId, new Vector2(120f, 120f));
            // A neutral detail-albedo (mid-grey) so _DETAIL_MULX2 doesn't tint the ground when the
            // keyword turns on (MULX2 multiplies by 2*detailAlbedo; 0.5 grey == identity).
            if (material.HasProperty(s_DetailAlbedoMapId) && material.GetTexture(s_DetailAlbedoMapId) == null)
            {
                material.SetTexture(s_DetailAlbedoMapId, Texture2D.grayTexture);
            }
            material.EnableKeyword("_DETAIL_MULX2");
            material.EnableKeyword("_NORMALMAP");
        }

        // Glassy material for window nodes (name contains 'window'): low roughness + some metalness,
        // like the web (roughness 0.2 / metalness 0.45). Built-in Standard uses _Metallic/_Glossiness,
        // URP Lit uses _Metallic/_Smoothness; set whichever the shader exposes. Per-material once.
        static void ApplyGlassSurface(MeshFilter filter)
        {
            if (!Application.isPlaying) return;
            if (!filter.TryGetComponent(out Renderer renderer)) return;
            Material material = renderer.sharedMaterial;
            if (material == null || !s_ConfiguredGlassMaterials.Add(material)) return;

            if (material.HasProperty(s_MetallicId)) material.SetFloat(s_MetallicId, 0.45f);
            if (material.HasProperty(s_SmoothnessId)) material.SetFloat(s_SmoothnessId, 0.8f);   // URP (1 - roughness)
            if (material.HasProperty(s_GlossinessId)) material.SetFloat(s_GlossinessId, 0.8f);   // Built-in Standard
        }

        // Lazily build a small tiling detail-normal texture (a soft, isotropic bump) once. A
        // procedural map avoids shipping an art asset and tiles cleanly via _DetailNormalMap scale.
        static Texture2D GetDetailNormalTexture()
        {
            if (s_DetailNormalTexture != null) return s_DetailNormalTexture;

            const int size = 64;
            Texture2D tex = new Texture2D(size, size, TextureFormat.RGBA32, true, true)
            {
                name = "DaHilgTerrainDetailNormal",
                wrapMode = TextureWrapMode.Repeat,
                filterMode = FilterMode.Bilinear,
            };

            // Build a height field from two phase-shifted sine ridges, derive the normal from its
            // finite-difference gradient, and encode it tangent-space (xyz -> 0.5+0.5). Subtle
            // amplitude so the asphalt/concrete gets tooth without looking embossed.
            const float amp = 0.35f;
            float Height(int x, int y)
            {
                float u = (x / (float)size) * Mathf.PI * 2f;
                float v = (y / (float)size) * Mathf.PI * 2f;
                return Mathf.Sin(u * 3f) * 0.5f + Mathf.Sin(v * 3f + 1.7f) * 0.5f
                    + Mathf.Sin((u + v) * 5f) * 0.25f;
            }

            Color32[] pixels = new Color32[size * size];
            for (int y = 0; y < size; y++)
            {
                for (int x = 0; x < size; x++)
                {
                    float dx = (Height((x + 1) % size, y) - Height((x - 1 + size) % size, y)) * amp;
                    float dy = (Height(x, (y + 1) % size) - Height(x, (y - 1 + size) % size)) * amp;
                    Vector3 n = new Vector3(-dx, -dy, 1f).normalized;
                    pixels[y * size + x] = new Color32(
                        (byte)Mathf.Clamp(Mathf.RoundToInt((n.x * 0.5f + 0.5f) * 255f), 0, 255),
                        (byte)Mathf.Clamp(Mathf.RoundToInt((n.y * 0.5f + 0.5f) * 255f), 0, 255),
                        (byte)Mathf.Clamp(Mathf.RoundToInt((n.z * 0.5f + 0.5f) * 255f), 0, 255),
                        255);
                }
            }
            tex.SetPixels32(pixels);
            tex.Apply(true, false);
            s_DetailNormalTexture = tex;
            return tex;
        }

        // Runtime toggle for the SVFacade_page* photo overlays (mirrors the web showFacades). ON
        // (default) the Street-View photos cover the windowed-stucco walls; OFF reveals the walls
        // underneath (no geometry vanishes). No-op when no facade overlays are present in the level.
        public static void SetFacadesVisible(bool visible)
        {
            for (int i = 0; i < s_FacadeRenderers.Count; i++)
            {
                Renderer renderer = s_FacadeRenderers[i];
                if (renderer != null) renderer.enabled = visible;
            }
        }

        static bool ContainsAny(string value, params string[] needles)
        {
            for (int i = 0; i < needles.Length; i++)
            {
                if (value.Contains(needles[i])) return true;
            }
            return false;
        }

        public static Vector3 GroundSpawn(Vector3 spawn)
        {
            if (TryFindGround(spawn, out RaycastHit hit))
            {
                return hit.point + Vector3.up * k_SpawnGroundSkin;
            }

            return new Vector3(spawn.x, Mathf.Max(spawn.y, k_SpawnGroundSkin), spawn.z);
        }

        public static bool TryFindSpawnGround(Vector3 spawn, out RaycastHit bestHit)
        {
            return TryFindGround(spawn, out bestHit);
        }

        public static bool TryFindGround(Vector3 point, out RaycastHit bestHit, float probeHeight = k_SpawnProbeHeight, float probeDistance = k_SpawnProbeDistance, float maxAbovePoint = float.PositiveInfinity)
        {
            Vector3 origin = point + Vector3.up * Mathf.Max(0.01f, probeHeight);
            int count = Physics.RaycastNonAlloc(origin, Vector3.down, s_GroundHits, Mathf.Max(0.01f, probeDistance), Physics.DefaultRaycastLayers, QueryTriggerInteraction.Ignore);
            bestHit = default;
            float bestScore = float.MaxValue;
            float bestDistance = float.MaxValue;

            for (int i = 0; i < count; i++)
            {
                RaycastHit hit = s_GroundHits[i];
                if (!IsLevelCollider(hit.collider)) continue;
                if (hit.normal.y < 0.35f) continue;
                if (!float.IsInfinity(maxAbovePoint) && !float.IsNaN(maxAbovePoint) && hit.point.y - point.y > maxAbovePoint) continue;

                float heightScore = Mathf.Abs(hit.point.y - point.y);
                if (heightScore < bestScore || (Mathf.Approximately(heightScore, bestScore) && hit.distance < bestDistance))
                {
                    bestScore = heightScore;
                    bestDistance = hit.distance;
                    bestHit = hit;
                }
            }

            return bestScore < float.MaxValue;
        }

        public static bool SphereCastLevel(Vector3 origin, float radius, Vector3 direction, out RaycastHit bestHit, float distance)
        {
            int count = Physics.SphereCastNonAlloc(origin, radius, direction, s_SphereHits, distance, Physics.DefaultRaycastLayers, QueryTriggerInteraction.Ignore);
            bestHit = default;
            float bestDistance = float.MaxValue;
            for (int i = 0; i < count; i++)
            {
                RaycastHit hit = s_SphereHits[i];
                if (!IsLevelCollider(hit.collider)) continue;
                if (hit.distance < bestDistance)
                {
                    bestDistance = hit.distance;
                    bestHit = hit;
                }
            }

            return bestDistance < float.MaxValue;
        }

        public static bool HasLevelClearance(Vector3 feet, float radius, float height)
        {
            float r = Mathf.Max(0.05f, radius);
            float h = Mathf.Max(r * 2f + 0.05f, height);
            Vector3 bottom = feet + Vector3.up * (r + 0.08f);
            Vector3 top = feet + Vector3.up * Mathf.Max(r + 0.1f, h - r);
            int count = Physics.OverlapCapsuleNonAlloc(bottom, top, r, s_OverlapHits, Physics.DefaultRaycastLayers, QueryTriggerInteraction.Ignore);
            for (int i = 0; i < count; i++)
            {
                Collider c = s_OverlapHits[i];
                s_OverlapHits[i] = null;
                if (!IsLevelCollider(c)) continue;
                return false;
            }
            return true;
        }

        public static bool IsLevelCollider(Collider collider)
        {
            if (collider == null || collider.isTrigger) return false;
            if (collider is CharacterController || collider.GetComponentInParent<CharacterController>() != null) return false;
            if (s_LevelColliders.Count > 0) return s_LevelColliders.Contains(collider);
            return collider.gameObject.isStatic;
        }
    }
}
