using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Rendering;

namespace DaHilg
{
    public sealed class DaHilgProceduralGrass : MonoBehaviour
    {
        const int k_TargetBladeCount = 430;
        const int k_MaxAttempts = 2600;
        const float k_Radius = 28f;
        const float k_InnerRadius = 1.4f;
        const float k_RebuildDistance = 4.5f;
        const int k_MobileBladeCount = 180;
        const int k_MobileMaxAttempts = 850;
        const float k_MobileRadius = 18f;
        const float k_MobileRebuildDistance = 8.5f;

        readonly List<Vector3> m_Vertices = new List<Vector3>(k_TargetBladeCount * 8);
        readonly List<int> m_Triangles = new List<int>(k_TargetBladeCount * 12);
        readonly List<Color32> m_Colors = new List<Color32>(k_TargetBladeCount * 8);

        Transform m_Target;
        GameObject m_RenderRoot;
        MeshFilter m_Filter;
        MeshRenderer m_Renderer;
        Mesh m_Mesh;
        Vector3 m_LastCenter;
        bool m_HasBuilt;

        public void SetTarget(Transform target)
        {
            m_Target = target;
            EnsureRenderer();
            if (m_Renderer != null) m_Renderer.enabled = target != null;
            if (target != null) Rebuild(force: true);
        }

        void LateUpdate()
        {
            if (m_Target == null || m_Renderer == null || !m_Renderer.enabled) return;
            Vector3 center = m_Target.position;
            center.y = 0f;
            float rebuildDistance = RebuildDistance;
            if (!m_HasBuilt || (center - m_LastCenter).sqrMagnitude >= rebuildDistance * rebuildDistance)
            {
                Rebuild(force: false);
            }
        }

        void EnsureRenderer()
        {
            if (m_Renderer != null) return;

            m_RenderRoot = new GameObject("DaHilg_ProceduralGrass");
            m_RenderRoot.transform.SetParent(transform, false);
            m_Filter = m_RenderRoot.AddComponent<MeshFilter>();
            m_Renderer = m_RenderRoot.AddComponent<MeshRenderer>();
            m_Renderer.shadowCastingMode = ShadowCastingMode.Off;
            m_Renderer.receiveShadows = false;
            m_Renderer.lightProbeUsage = LightProbeUsage.Off;
            m_Renderer.reflectionProbeUsage = ReflectionProbeUsage.Off;
            m_Renderer.enabled = false;

            Shader shader = Shader.Find("Universal Render Pipeline/Unlit");
            if (shader == null) shader = Shader.Find("Unlit/Color");
            if (shader == null) shader = Shader.Find("Sprites/Default");
            if (shader == null) shader = Shader.Find("Hidden/Internal-Colored");
            if (shader == null) shader = FindLoadedShader();
            if (shader == null) shader = Shader.Find("Standard");
            if (shader == null)
            {
                Debug.LogWarning("[DaHilg] Procedural grass disabled: no compatible shader found.");
                m_Renderer.enabled = false;
                return;
            }
            Material material = new Material(shader) { name = "DaHilg_ProceduralGrass_Mat" };
            if (material.HasProperty("_BaseColor")) material.SetColor("_BaseColor", new Color(0.22f, 0.55f, 0.18f, 1f));
            if (material.HasProperty("_Color")) material.SetColor("_Color", new Color(0.22f, 0.55f, 0.18f, 1f));
            m_Renderer.sharedMaterial = material;

            m_Mesh = new Mesh { name = "DaHilg_ProceduralGrass_Mesh" };
            m_Mesh.indexFormat = IndexFormat.UInt32;
            m_Mesh.MarkDynamic();
            m_Filter.sharedMesh = m_Mesh;
        }

        void Rebuild(bool force)
        {
            if (m_Target == null) return;
            EnsureRenderer();
            if (m_Mesh == null || m_RenderRoot == null) return;

            Vector3 center = m_Target.position;
            center.y = 0f;
            float rebuildDistance = RebuildDistance;
            if (!force && m_HasBuilt && (center - m_LastCenter).sqrMagnitude < rebuildDistance * rebuildDistance) return;

            m_LastCenter = center;
            m_HasBuilt = true;
            m_RenderRoot.transform.position = center;
            m_RenderRoot.transform.rotation = Quaternion.identity;

            m_Vertices.Clear();
            m_Triangles.Clear();
            m_Colors.Clear();

            int seed = QuantizedSeed(center);
            int blades = 0;
            int targetBladeCount = TargetBladeCount;
            int maxAttempts = MaxAttempts;
            float radius = Radius;
            for (int attempt = 0; attempt < maxAttempts && blades < targetBladeCount; attempt++)
            {
                float angle = Hash01(seed, attempt * 5 + 1) * Mathf.PI * 2f;
                float dist = Mathf.Sqrt(Hash01(seed, attempt * 5 + 2)) * radius;
                if (dist < k_InnerRadius) dist = k_InnerRadius + Hash01(seed, attempt * 5 + 3) * 2.5f;

                Vector3 sample = center + new Vector3(Mathf.Cos(angle) * dist, 0f, Mathf.Sin(angle) * dist);
                if (!DaHilgLevelRuntime.TryFindGround(sample, out RaycastHit hit, 80f, 220f, 8f)) continue;
                if (hit.normal.y < 0.68f || IsRejectedSurface(hit)) continue;

                float yaw = Hash01(seed, attempt * 5 + 4) * Mathf.PI * 2f;
                float height = Mathf.Lerp(0.30f, 0.68f, Hash01(seed, attempt * 5 + 5));
                float width = Mathf.Lerp(0.12f, 0.28f, Hash01(seed, attempt * 5 + 6));
                Color32 color = Color32.Lerp(
                    new Color32(52, 126, 38, 255),
                    new Color32(126, 177, 64, 255),
                    Hash01(seed, attempt * 5 + 7));

                AddGrassClump(hit.point + Vector3.up * 0.03f - center, yaw, width, height, color);
                blades++;
            }

            m_Mesh.Clear(false);
            m_Mesh.SetVertices(m_Vertices);
            m_Mesh.SetColors(m_Colors);
            m_Mesh.SetTriangles(m_Triangles, 0, true);
            m_Mesh.RecalculateBounds();
        }

        static int TargetBladeCount => DaHilgGameManager.MobileWeb ? k_MobileBladeCount : k_TargetBladeCount;
        static int MaxAttempts => DaHilgGameManager.MobileWeb ? k_MobileMaxAttempts : k_MaxAttempts;
        static float Radius => DaHilgGameManager.MobileWeb ? k_MobileRadius : k_Radius;
        static float RebuildDistance => DaHilgGameManager.MobileWeb ? k_MobileRebuildDistance : k_RebuildDistance;

        void AddGrassClump(Vector3 basePoint, float yaw, float width, float height, Color32 color)
        {
            AddGrassCard(basePoint, yaw, width, height, color);
            AddGrassCard(basePoint, yaw + Mathf.PI * 0.5f, width * 0.85f, height * 0.92f, color);
            AddGrassCard(basePoint, yaw + Mathf.PI * 0.23f, width * 0.65f, height * 1.08f, color);
        }

        void AddGrassCard(Vector3 basePoint, float yaw, float width, float height, Color32 color)
        {
            Vector3 right = new Vector3(Mathf.Cos(yaw), 0f, Mathf.Sin(yaw)) * width;
            Vector3 lean = new Vector3(Mathf.Cos(yaw + 1.1f), 0f, Mathf.Sin(yaw + 1.1f)) * (width * 0.65f);
            Vector3 top = basePoint + Vector3.up * height + lean;
            int v = m_Vertices.Count;
            m_Vertices.Add(basePoint - right);
            m_Vertices.Add(basePoint + right);
            m_Vertices.Add(top + right * 0.22f);
            m_Vertices.Add(top - right * 0.22f);
            m_Colors.Add(color);
            m_Colors.Add(color);
            m_Colors.Add(color);
            m_Colors.Add(color);
            m_Triangles.Add(v + 0);
            m_Triangles.Add(v + 2);
            m_Triangles.Add(v + 1);
            m_Triangles.Add(v + 0);
            m_Triangles.Add(v + 3);
            m_Triangles.Add(v + 2);
        }

        static bool IsRejectedSurface(RaycastHit hit)
        {
            string name = hit.collider != null ? hit.collider.name.ToLowerInvariant() : string.Empty;
            if (hit.collider != null && hit.collider.transform.parent != null)
            {
                name += " " + hit.collider.transform.parent.name.ToLowerInvariant();
            }

            return name.Contains("road")
                || name.Contains("drive")
                || name.Contains("walk")
                || name.Contains("sidewalk")
                || name.Contains("curb")
                || name.Contains("asphalt")
                || name.Contains("pave")
                || name.Contains("water")
                || name.Contains("creek")
                || name.Contains("wall")
                || name.Contains("building")
                || name.Contains("roof");
        }

        static Shader FindLoadedShader()
        {
            Renderer[] renderers = FindObjectsByType<Renderer>(FindObjectsInactive.Exclude);
            for (int i = 0; i < renderers.Length; i++)
            {
                Material material = renderers[i] != null ? renderers[i].sharedMaterial : null;
                if (material != null && material.shader != null) return material.shader;
            }
            return null;
        }

        static int QuantizedSeed(Vector3 center)
        {
            unchecked
            {
                int x = Mathf.FloorToInt(center.x * 0.25f);
                int z = Mathf.FloorToInt(center.z * 0.25f);
                return (x * 73856093) ^ (z * 19349663) ^ 0x4d3a2b1f;
            }
        }

        static float Hash01(int seed, int value)
        {
            unchecked
            {
                uint h = (uint)(seed ^ value);
                h ^= h >> 16;
                h *= 0x7feb352dU;
                h ^= h >> 15;
                h *= 0x846ca68bU;
                h ^= h >> 16;
                return (h & 0x00ffffff) / 16777215f;
            }
        }
    }
}
