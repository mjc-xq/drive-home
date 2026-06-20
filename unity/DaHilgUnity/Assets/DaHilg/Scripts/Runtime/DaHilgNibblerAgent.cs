using UnityEngine;

namespace DaHilg
{
    public sealed class DaHilgNibblerAgent
    {
        readonly Transform m_Player;
        readonly Animator m_Animator;
        readonly CharacterController m_Controller;
        readonly float m_Scale;
        Vector3 m_Velocity;
        Vector3 m_AttachLocal;
        string m_Anim;

        public GameObject Root { get; }
        public bool Active { get; private set; }
        public bool Attached { get; private set; }

        public DaHilgNibblerAgent(GameObject prefab, Transform parent, Transform player, RuntimeAnimatorController animatorController, float scale, int index)
        {
            m_Player = player;
            m_Scale = scale;
            Root = Object.Instantiate(prefab, parent);
            Root.name = "Nibbler_" + index.ToString("00");
            Root.transform.localScale = Vector3.one * scale;

            m_Controller = Root.AddComponent<CharacterController>();
            m_Controller.height = 1.7f * scale;
            m_Controller.radius = 0.3f * scale;
            m_Controller.center = new Vector3(0f, 0.85f * scale, 0f);
            m_Controller.stepOffset = 0.15f;

            Transform animatorRoot = ResolveAnimatorRoot(Root.transform);
            m_Animator = animatorRoot.GetComponent<Animator>();
            if (m_Animator == null) m_Animator = animatorRoot.gameObject.AddComponent<Animator>();
            foreach (Animator childAnimator in Root.GetComponentsInChildren<Animator>(true))
            {
                if (childAnimator != m_Animator) childAnimator.enabled = false;
            }
            m_Animator.applyRootMotion = false;
            m_Animator.cullingMode = AnimatorCullingMode.AlwaysAnimate;
            if (animatorController != null) m_Animator.runtimeAnimatorController = animatorController;

            Root.SetActive(false);
        }

        static Transform ResolveAnimatorRoot(Transform visualRoot)
        {
            if (visualRoot.Find("Armature") != null) return visualRoot;
            Transform root = FindTransformWithDirectChild(visualRoot, "Armature");
            return root != null ? root : visualRoot;
        }

        static Transform FindTransformWithDirectChild(Transform parent, string childName)
        {
            if (parent.Find(childName) != null) return parent;
            for (int i = 0; i < parent.childCount; i++)
            {
                Transform found = FindTransformWithDirectChild(parent.GetChild(i), childName);
                if (found != null) return found;
            }
            return null;
        }

        public void Spawn(Vector3 position)
        {
            Active = true;
            Attached = false;
            Root.SetActive(true);
            Root.transform.position = position;
            m_Velocity = Vector3.zero;
            Play("Run");
        }

        public void Despawn()
        {
            Active = false;
            Attached = false;
            Root.SetActive(false);
        }

        public bool Tick(DaHilgActor player, DaHilgGameSettings settings, float dt, bool safe)
        {
            if (!Active) return false;

            if (safe)
            {
                Scatter(player.FeetPosition);
            }

            if (Attached)
            {
                Root.transform.position = m_Player.TransformPoint(m_AttachLocal);
                Root.transform.rotation = Quaternion.LookRotation((m_Player.position - Root.transform.position).normalized, Vector3.up);
                Play("Climb");
                return true;
            }

            Vector3 toPlayer = player.FeetPosition + Vector3.up * 0.2f - Root.transform.position;
            toPlayer.y = 0f;
            float dist = toPlayer.magnitude;
            if (dist < settings.NibblerAttachDistance && !safe)
            {
                Attach(player);
                return true;
            }

            if (dist > 45f)
            {
                Despawn();
                return false;
            }

            Vector3 dir = dist > 0.001f ? toPlayer / dist : Vector3.zero;
            Vector3 targetVelocity = dir * settings.NibblerRunSpeed;
            m_Velocity = Vector3.Lerp(m_Velocity, targetVelocity, 1f - Mathf.Exp(-10f * dt));
            m_Velocity.y += settings.Gravity * dt;
            if (m_Velocity.y < settings.MaxFallSpeed) m_Velocity.y = settings.MaxFallSpeed;

            CollisionFlags flags = m_Controller.Move(m_Velocity * dt);
            if ((flags & CollisionFlags.Below) != 0 && m_Velocity.y < 0f) m_Velocity.y = -1f;
            if (dir.sqrMagnitude > 0.01f) Root.transform.rotation = Quaternion.LookRotation(dir, Vector3.up);
            Play("Run");
            return false;
        }

        public void Scatter(Vector3 from)
        {
            if (!Active) return;
            Attached = false;
            Vector3 away = Root.transform.position - from;
            away.y = 0f;
            if (away.sqrMagnitude < 0.1f) away = Random.insideUnitSphere;
            away.y = 0f;
            away.Normalize();
            m_Velocity = away * 8f + Vector3.up * 3f;
            Play("Jump");
        }

        void Attach(DaHilgActor player)
        {
            Attached = true;
            float angle = Random.Range(0f, Mathf.PI * 2f);
            float radius = 0.35f + Random.Range(0f, 0.16f);
            float y = Random.Range(0.2f, 1.55f);
            Vector3 world = player.FeetPosition + new Vector3(Mathf.Cos(angle) * radius, y, Mathf.Sin(angle) * radius);
            m_AttachLocal = m_Player.InverseTransformPoint(world);
            Play("Climb");
        }

        void Play(string state)
        {
            if (m_Animator == null || m_Anim == state) return;
            int hash = Animator.StringToHash("Base Layer." + state);
            if (m_Animator.HasState(0, hash))
            {
                m_Animator.CrossFade(hash, 0.12f);
                m_Anim = state;
            }
        }
    }
}
