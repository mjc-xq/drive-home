using System.Collections.Generic;
using UnityEngine;

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
        static readonly RaycastHit[] s_GroundHits = new RaycastHit[64];
        static readonly RaycastHit[] s_SphereHits = new RaycastHit[32];

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
                if (useCollider && filter.GetComponent<Collider>() == null)
                {
                    MeshCollider collider = filter.gameObject.AddComponent<MeshCollider>();
                    collider.sharedMesh = filter.sharedMesh;
                    collider.convex = false;
                    levelCollider = collider;
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

                TuneLevelSurface(filter, lower, isWater, isCollisionProxy);
                filter.gameObject.isStatic = true;
            }
        }

        static void TuneLevelSurface(MeshFilter filter, string lowerName, bool isWater, bool isCollisionProxy)
        {
            if (isCollisionProxy) return;
            if (!filter.TryGetComponent(out Renderer renderer) || renderer.sharedMaterial == null) return;

            string materialName = renderer.sharedMaterial.name.ToLowerInvariant();
            string key = lowerName + " " + materialName;
            bool isRoad = ContainsAny(key, "road", "street", "drive", "asphalt", "curb");
            bool isGround = isRoad || ContainsAny(key, "ground", "terrain", "grass", "yard", "walk", "sidewalk", "landscape", "dirt", "soil");
            if (!isGround && !isWater) return;

            MaterialPropertyBlock block = new MaterialPropertyBlock();
            renderer.GetPropertyBlock(block);
            Color tint = isWater
                ? new Color(0.22f, 0.49f, 0.66f, 0.82f)
                : (isRoad ? new Color(0.38f, 0.40f, 0.36f, 1f) : new Color(0.42f, 0.55f, 0.32f, 1f));

            if (renderer.sharedMaterial.HasProperty(s_BaseColorId)) block.SetColor(s_BaseColorId, tint);
            if (renderer.sharedMaterial.HasProperty(s_ColorId)) block.SetColor(s_ColorId, tint);
            renderer.SetPropertyBlock(block);
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
