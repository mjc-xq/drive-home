using UnityEngine;

namespace DaHilg
{
    public sealed class DaHilgWaterAnimator : MonoBehaviour
    {
        Renderer m_Renderer;
        Material m_Material;
        Vector2 m_Offset;

        void Awake()
        {
            m_Renderer = GetComponent<Renderer>();
            if (m_Renderer != null)
            {
                m_Material = m_Renderer.material;
                Color c = m_Material.color;
                c.a = Mathf.Min(c.a, 0.72f);
                m_Material.color = c;
            }
        }

        void Update()
        {
            if (m_Material == null) return;
            m_Offset.x += Time.deltaTime * 0.025f;
            m_Offset.y += Time.deltaTime * 0.012f;
            m_Material.mainTextureOffset = m_Offset;
        }
    }
}
