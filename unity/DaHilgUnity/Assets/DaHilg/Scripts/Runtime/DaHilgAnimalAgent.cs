using UnityEngine;

namespace DaHilg
{
    [RequireComponent(typeof(CharacterController))]
    public sealed class DaHilgAnimalAgent : MonoBehaviour
    {
        CharacterController m_Controller;
        Transform m_VisualRoot;
        Animator m_Animator;
        Animation m_Animation;
        Vector3 m_Home;
        Vector3 m_Target;
        float m_WanderRadius;
        float m_Speed;
        float m_WaitUntil;
        float m_NextGroundProbeAt;

        public string Id { get; private set; }
        public Vector3 Position => transform.position;

        public void Initialize(DaHilgAnimalSpawn spawn, int index)
        {
            Id = spawn.Id;
            m_Home = spawn.Home;
            m_WanderRadius = Mathf.Max(0.5f, spawn.WanderRadius);
            m_Speed = Mathf.Max(0.05f, spawn.Speed);

            m_Controller = GetComponent<CharacterController>();
            m_Controller.radius = Mathf.Clamp(0.32f * Mathf.Max(0.2f, spawn.Scale), 0.08f, 0.42f);
            m_Controller.height = Mathf.Clamp(1.2f * Mathf.Max(0.25f, spawn.Scale), 0.25f, 1.1f);
            m_Controller.center = Vector3.up * (m_Controller.height * 0.5f);
            m_Controller.stepOffset = Mathf.Min(0.28f, m_Controller.height * 0.35f);
            m_Controller.slopeLimit = 50f;
            m_Controller.skinWidth = Mathf.Max(0.03f, m_Controller.radius * 0.18f);
            m_Controller.minMoveDistance = 0f;
            m_Controller.enableOverlapRecovery = true;

            if (spawn.Prefab != null)
            {
                GameObject visual = Instantiate(spawn.Prefab, transform);
                visual.name = spawn.Label + "_Visual";
                m_VisualRoot = visual.transform;
                m_VisualRoot.localPosition = Vector3.zero;
                m_VisualRoot.localRotation = Quaternion.Euler(0f, spawn.VisualYawOffset, 0f);
                m_VisualRoot.localScale = Vector3.one * Mathf.Max(0.01f, spawn.Scale);
                AlignVisualToFeet();

                m_Animator = visual.GetComponentInChildren<Animator>();
                if (m_Animator != null)
                {
                    m_Animator.applyRootMotion = false;
                    m_Animator.cullingMode = AnimatorCullingMode.CullUpdateTransforms;
                    if (spawn.AnimatorController != null) m_Animator.runtimeAnimatorController = spawn.AnimatorController;
                    m_Animator.speed = Mathf.Clamp(m_Speed / 0.55f, 0.55f, 1.8f);
                }

                m_Animation = visual.GetComponentInChildren<Animation>();
                if (m_Animation != null)
                {
                    foreach (AnimationState state in m_Animation)
                    {
                        state.wrapMode = WrapMode.Loop;
                    }
                    m_Animation.Play();
                }
            }

            Teleport(DaHilgLevelRuntime.GroundSpawn(spawn.Home));
            PickTarget(index * 0.31f);
        }

        public void Teleport(Vector3 position)
        {
            if (m_Controller != null) m_Controller.enabled = false;
            transform.position = position;
            if (m_Controller != null) m_Controller.enabled = true;
            m_NextGroundProbeAt = Time.time + Random.Range(0.08f, 0.20f);
        }

        public void Tick(float dt)
        {
            if (m_Controller == null) return;

            float now = Time.time;
            Vector3 planar = m_Target - transform.position;
            planar.y = 0f;
            if (planar.magnitude < 0.45f || now >= m_WaitUntil)
            {
                PickTarget(Random.value);
                planar = m_Target - transform.position;
                planar.y = 0f;
            }

            Vector3 direction = planar.sqrMagnitude > 0.001f ? planar.normalized : Vector3.zero;
            Vector3 desired = transform.position + direction * (m_Speed * dt);
            if (now >= m_NextGroundProbeAt)
            {
                Vector3 grounded = DaHilgLevelRuntime.GroundSpawn(desired);
                m_Controller.Move(grounded - transform.position);
                m_NextGroundProbeAt = now + Random.Range(0.14f, 0.24f);
            }
            else
            {
                Vector3 planarMove = desired - transform.position;
                planarMove.y = 0f;
                m_Controller.Move(planarMove);
            }

            if (direction.sqrMagnitude > 0.001f)
            {
                Quaternion facing = Quaternion.LookRotation(direction, Vector3.up);
                transform.rotation = Quaternion.Slerp(transform.rotation, facing, 1f - Mathf.Exp(-8f * dt));
            }
        }

        void PickTarget(float seed)
        {
            float angle = (Random.value + seed) * Mathf.PI * 2f;
            float radius = Random.Range(m_WanderRadius * 0.25f, m_WanderRadius);
            Vector3 raw = m_Home + new Vector3(Mathf.Cos(angle) * radius, 0.2f, Mathf.Sin(angle) * radius);
            m_Target = DaHilgLevelRuntime.GroundSpawn(raw);
            m_WaitUntil = Time.time + Random.Range(3.0f, 7.5f);
        }

        void AlignVisualToFeet()
        {
            if (m_VisualRoot == null) return;

            Renderer[] renderers = m_VisualRoot.GetComponentsInChildren<Renderer>(true);
            if (renderers.Length == 0) return;

            Bounds bounds = renderers[0].bounds;
            for (int i = 1; i < renderers.Length; i++) bounds.Encapsulate(renderers[i].bounds);
            float bottom = bounds.min.y - transform.position.y;
            m_VisualRoot.localPosition -= Vector3.up * bottom;
        }
    }
}
