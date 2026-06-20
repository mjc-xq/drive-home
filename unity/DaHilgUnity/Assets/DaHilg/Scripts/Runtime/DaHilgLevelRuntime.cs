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
                ? new Color(0.28f, 0.55f, 0.68f, 0.72f)
                : (isRoad ? new Color(0.46f, 0.47f, 0.43f, 1f) : new Color(0.58f, 0.66f, 0.48f, 1f));

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
