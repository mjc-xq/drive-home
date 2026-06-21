using System;
using System.Collections;
using System.Collections.Generic;
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
        static readonly HashSet<Collider> s_LevelColliders = new HashSet<Collider>();
        static readonly HashSet<Material> s_ConfiguredVegetationMaterials = new HashSet<Material>();
        static readonly RaycastHit[] s_GroundHits = new RaycastHit[64];
        static readonly RaycastHit[] s_SphereHits = new RaycastHit[32];

        // Heavy outdoor levels stream their GLB from StreamingAssets at level-select instead of
        // being baked into the WebGL data file. Mirrors the staged set in DaHilgProjectBuilder.
        static readonly HashSet<string> s_StreamedLevelSlugs = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "dahill",
            "canyon",
            "stanton",
            "meemaw"
        };

        // CPU-side buffers from the active streamed import; disposed when the next level loads so
        // switching levels frees the previous GLB's memory (the instantiated GameObjects are owned
        // by the caller's level root and destroyed alongside it).
        static GltfImport s_ActiveImport;

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

        public static void PrepareLevelColliders(GameObject level)
        {
            if (level == null) return;
            s_LevelColliders.Clear();

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
                bool isWater = lower.Contains("water") || lower.Contains("creek") || lower.Contains("river");
                bool useCollider = hasCollisionProxy ? isCollisionProxy && !isTreeCollision : !isWater;

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
                        MeshCollider collider = filter.gameObject.AddComponent<MeshCollider>();
                        collider.sharedMesh = shared;
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

                TuneLevelSurface(filter, lower, isWater, isCollisionProxy, levelScale);
                filter.gameObject.isStatic = true;
            }

            // Additive perf: don't draw foliage/small props across the full 600m+ frustum.
            ConfigureCameraCullDistances(Camera.main);
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

        static void TuneLevelSurface(MeshFilter filter, string lowerName, bool isWater, bool isCollisionProxy, float levelScale)
        {
            if (isCollisionProxy) return;
            if (!filter.TryGetComponent(out Renderer renderer) || renderer.sharedMaterial == null) return;

            string materialName = renderer.sharedMaterial.name.ToLowerInvariant();
            string key = lowerName + " " + materialName;
            bool isVegetation = ContainsAny(key, "tree_", "trees", "grassclump", "grass_wind", "shrub", "shrubs", "reeds");
            if (isVegetation)
            {
                TuneVegetationSurface(renderer, ContainsAny(key, "tree_", "trees"), levelScale);
                return;
            }

            // The single-surface level welds roads/sidewalks/curbs into the ONE textured terrain,
            // so there are no separate coplanar road meshes to z-fight — the old per-road
            // renderQueue+5 / double-sided ConfigureRoadMaterial firefighting is obsolete and
            // removed. `isRoad` only classifies the (rare) road-named material for tinting now.
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
                ? new Color(0.16f, 0.38f, 0.52f, 0.88f)
                : (isRoad ? new Color(0.22f, 0.23f, 0.22f, 1f) : new Color(0.28f, 0.40f, 0.22f, 1f));

            if (renderer.sharedMaterial.HasProperty(s_BaseColorId)) block.SetColor(s_BaseColorId, tint);
            if (renderer.sharedMaterial.HasProperty(s_ColorId)) block.SetColor(s_ColorId, tint);
            renderer.SetPropertyBlock(block);
        }

        static bool HasUsefulBaseTexture(Material material)
        {
            if (material == null) return false;
            if (material.mainTexture != null) return true;
            if (material.HasProperty("_BaseMap") && material.GetTexture("_BaseMap") != null) return true;
            if (material.HasProperty("_MainTex") && material.GetTexture("_MainTex") != null) return true;
            return false;
        }

        static void TuneVegetationSurface(Renderer renderer, bool isTree, float levelScale)
        {
            // Trees cast shadows (grounds them in the scene); billboards still skip
            // receiving shadows to avoid lighting artifacts on flat cards.
            renderer.shadowCastingMode = isTree ? ShadowCastingMode.On : ShadowCastingMode.Off;
            renderer.receiveShadows = false;

            Material material = renderer.sharedMaterial;
            if (material != null && s_ConfiguredVegetationMaterials.Add(material))
            {
                ConfigureOpaqueMaterial(material);
            }

            if (isTree && IsOverhangingTreeRenderer(renderer, levelScale))
            {
                renderer.enabled = false;
                return;
            }

            MaterialPropertyBlock block = new MaterialPropertyBlock();
            renderer.GetPropertyBlock(block);
            Color tint = isTree ? new Color(0.20f, 0.42f, 0.16f, 1f) : new Color(0.26f, 0.48f, 0.18f, 1f);
            if (material != null && material.HasProperty(s_BaseColorId)) block.SetColor(s_BaseColorId, tint);
            if (material != null && material.HasProperty(s_ColorId)) block.SetColor(s_ColorId, tint);
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

        static void ConfigureOpaqueMaterial(Material material)
        {
            // Non-destructive guard: only mutate the shared material at play time. Editing
            // it while editing the scene (e.g. the project builder) would persist changes
            // into the imported project asset shared by every instance.
            if (!Application.isPlaying) return;

            material.SetOverrideTag("RenderType", "Opaque");
            if (material.HasProperty("_Surface")) material.SetFloat("_Surface", 0f);
            if (material.HasProperty("_Blend")) material.SetFloat("_Blend", 0f);
            if (material.HasProperty("_SrcBlend")) material.SetInt("_SrcBlend", (int)BlendMode.One);
            if (material.HasProperty("_DstBlend")) material.SetInt("_DstBlend", (int)BlendMode.Zero);
            if (material.HasProperty("_ZWrite")) material.SetInt("_ZWrite", 1);
            material.DisableKeyword("_SURFACE_TYPE_TRANSPARENT");
            material.DisableKeyword("_ALPHATEST_ON");
            material.renderQueue = (int)RenderQueue.Geometry;
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

        public static bool IsLevelCollider(Collider collider)
        {
            if (collider == null || collider.isTrigger) return false;
            if (collider is CharacterController || collider.GetComponentInParent<CharacterController>() != null) return false;
            if (s_LevelColliders.Count > 0) return s_LevelColliders.Contains(collider);
            return collider.gameObject.isStatic;
        }
    }
}
