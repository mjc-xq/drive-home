using UnityEngine;

namespace DaHilg
{
    public static class DaHilgLevelRuntime
    {
        const float k_SpawnProbeHeight = 80f;
        const float k_SpawnProbeDistance = 220f;
        const float k_SpawnGroundSkin = 0.08f;

        public static void ApplyLevelOffset(GameObject level, DaHilgLevelProfile profile)
        {
            if (level == null || profile == null) return;
            level.transform.position = -profile.LevelOffset;
        }

        public static void PrepareLevelColliders(GameObject level)
        {
            if (level == null) return;

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

                if (useCollider && filter.GetComponent<Collider>() == null)
                {
                    MeshCollider collider = filter.gameObject.AddComponent<MeshCollider>();
                    collider.sharedMesh = filter.sharedMesh;
                    collider.convex = false;
                }

                if (isWater && filter.GetComponent<DaHilgWaterAnimator>() == null)
                {
                    filter.gameObject.AddComponent<DaHilgWaterAnimator>();
                }

                filter.gameObject.isStatic = true;
            }
        }

        public static Vector3 GroundSpawn(Vector3 spawn)
        {
            if (TryFindSpawnGround(spawn, out RaycastHit hit))
            {
                return hit.point + Vector3.up * k_SpawnGroundSkin;
            }

            return new Vector3(spawn.x, Mathf.Max(spawn.y, k_SpawnGroundSkin), spawn.z);
        }

        public static bool TryFindSpawnGround(Vector3 spawn, out RaycastHit bestHit)
        {
            Vector3 origin = spawn + Vector3.up * k_SpawnProbeHeight;
            RaycastHit[] hits = Physics.RaycastAll(origin, Vector3.down, k_SpawnProbeDistance, Physics.DefaultRaycastLayers, QueryTriggerInteraction.Ignore);
            bestHit = default;
            float bestDistance = float.MaxValue;

            for (int i = 0; i < hits.Length; i++)
            {
                RaycastHit hit = hits[i];
                if (hit.collider is CharacterController) continue;

                if (hit.distance < bestDistance)
                {
                    bestDistance = hit.distance;
                    bestHit = hit;
                }
            }

            return bestDistance < float.MaxValue;
        }
    }
}
