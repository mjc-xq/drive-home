using UnityEngine;

namespace DaHilg
{
    public sealed class DaHilgWaterAnimator : MonoBehaviour
    {
        static readonly int s_BaseMapStId = Shader.PropertyToID("_BaseMap_ST");
        static readonly int s_MainTexStId = Shader.PropertyToID("_MainTex_ST");
        static readonly int s_BaseColorId = Shader.PropertyToID("_BaseColor");
        static readonly int s_ColorId = Shader.PropertyToID("_Color");

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
                c.a = Mathf.Min(c.a, 0.72f);
                if (shared.HasProperty(s_BaseColorId)) m_Block.SetColor(s_BaseColorId, c);
                if (shared.HasProperty(s_ColorId)) m_Block.SetColor(s_ColorId, c);
            }

            m_Renderer.SetPropertyBlock(m_Block);
        }

        void Update()
        {
            if (m_Renderer == null || m_Block == null) return;
            if (!m_HasBaseMapSt && !m_HasMainTexSt) return;

            m_Offset.x += Time.deltaTime * 0.025f;
            m_Offset.y += Time.deltaTime * 0.012f;
            m_Tiling.z = m_Offset.x;
            m_Tiling.w = m_Offset.y;

            m_Renderer.GetPropertyBlock(m_Block);
            if (m_HasBaseMapSt) m_Block.SetVector(s_BaseMapStId, m_Tiling);
            if (m_HasMainTexSt) m_Block.SetVector(s_MainTexStId, m_Tiling);
            m_Renderer.SetPropertyBlock(m_Block);
        }
    }
}
