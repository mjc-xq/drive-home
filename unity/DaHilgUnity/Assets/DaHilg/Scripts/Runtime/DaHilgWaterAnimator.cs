using UnityEngine;

namespace DaHilg
{
    public sealed class DaHilgWaterAnimator : MonoBehaviour
    {
        static readonly int s_BaseMapStId = Shader.PropertyToID("_BaseMap_ST");
        static readonly int s_MainTexStId = Shader.PropertyToID("_MainTex_ST");
        static readonly int s_BaseColorId = Shader.PropertyToID("_BaseColor");
        static readonly int s_ColorId = Shader.PropertyToID("_Color");
        static readonly int s_EmissionId = Shader.PropertyToID("_EmissionColor");

        Renderer m_Renderer;
        MaterialPropertyBlock m_Block;
        Vector4 m_Tiling = new Vector4(1f, 1f, 0f, 0f);
        Vector2 m_Offset;
        bool m_HasBaseMapSt;
        bool m_HasMainTexSt;

        void Awake()
        {
            m_Renderer = GetComponent<Renderer>();
            if (m_Renderer == null) return;

            // Drive the scroll/tint through a MaterialPropertyBlock so we never
            // instantiate a per-renderer material clone (avoids leak + preserves batching).
            m_Block = new MaterialPropertyBlock();
            m_Renderer.GetPropertyBlock(m_Block);

            Material shared = m_Renderer.sharedMaterial;
            if (shared != null)
            {
                m_HasBaseMapSt = shared.HasProperty(s_BaseMapStId);
                m_HasMainTexSt = shared.HasProperty(s_MainTexStId);

                if (m_HasBaseMapSt) m_Tiling = shared.GetVector(s_BaseMapStId);
                else if (m_HasMainTexSt) m_Tiling = shared.GetVector(s_MainTexStId);

                Color c = shared.color;
                c.a = 1f;
                if (shared.HasProperty(s_BaseColorId)) m_Block.SetColor(s_BaseColorId, c);
                if (shared.HasProperty(s_ColorId)) m_Block.SetColor(s_ColorId, c);
            }

            m_Renderer.SetPropertyBlock(m_Block);
        }

        void Update()
        {
            if (m_Renderer == null || m_Block == null) return;

            m_Renderer.GetPropertyBlock(m_Block);

            // Scroll the texture if the material has one (real flow on textured water).
            if (m_HasBaseMapSt || m_HasMainTexSt)
            {
                m_Offset.x += Time.deltaTime * 0.048f;
                m_Offset.y += Time.deltaTime * 0.022f;
                m_Tiling.z = m_Offset.x;
                m_Tiling.w = m_Offset.y;
                if (m_HasBaseMapSt) m_Block.SetVector(s_BaseMapStId, m_Tiling);
                if (m_HasMainTexSt) m_Block.SetVector(s_MainTexStId, m_Tiling);
            }

            // The creek water is a flat, textureless surface — a moving emission shimmer makes it read
            // as live, flowing water instead of a static blue slab (two offset sines = rippling sparkle).
            float shimmer = 0.5f + 0.34f * Mathf.Sin(Time.time * 1.8f) + 0.22f * Mathf.Sin(Time.time * 3.3f + 1.3f);
            float t = Mathf.Clamp01(shimmer);
            Color surface = Color.Lerp(new Color(0.10f, 0.42f, 0.74f, 1f), new Color(0.28f, 0.76f, 1f, 1f), t);
            Color glow = Color.Lerp(new Color(0.04f, 0.22f, 0.36f), new Color(0.22f, 0.62f, 0.95f), t);
            m_Block.SetColor(s_BaseColorId, surface);
            m_Block.SetColor(s_ColorId, surface);
            m_Block.SetColor(s_EmissionId, glow);

            m_Renderer.SetPropertyBlock(m_Block);
        }
    }
}
