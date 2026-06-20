using UnityEngine;

namespace DaHilg
{
    public sealed class DaHilgNibblerAgent
    {
        enum NibblerState
        {
            Chase,
            Lunge,
            Climb,
            Attached,
            Scatter
        }

        const int k_ClingAngularSlots = 7;
        const float k_ClingBottom = 0.18f;
        const float k_ClingTop = 1.68f;
        const float k_ClingLayerStep = 0.06f;
        const float k_JumpRadius = 2.05f;
        const float k_AttachPad = 0.35f;
        const float k_LungeArc = 0.68f;
        const float k_ScatterTime = 1.2f;

        Transform m_Player;
        readonly Animator m_Animator;
        readonly CharacterController m_Controller;
        readonly float m_Scale;
        readonly int m_Index;
        readonly float m_Seed;
        readonly string m_RunClip;
        readonly string m_ClingClip;
        NibblerState m_State;
        Vector3 m_Velocity;
        Vector3 m_LungeStart;
        Vector3 m_AttachBaseLocal;
        float m_AttachY;
        float m_AttachTargetY;
        float m_StateTime;
        float m_LungeDuration;
        float m_JumpCooldown;
        float m_ClimbSpeed;
        string m_Anim;

        public GameObject Root { get; }
        public bool Active { get; private set; }
        public bool Attached { get; private set; }
        public Vector3 Position => Root != null ? Root.transform.position : Vector3.zero;

        public DaHilgNibblerAgent(GameObject prefab, Transform parent, Transform player, RuntimeAnimatorController animatorController, float scale, int index)
        {
            m_Player = player;
            m_Scale = scale;
            m_Index = index;
            m_Seed = Mathf.Repeat(Mathf.Sin((index + 1) * 12.9898f) * 43758.5453f, 1f);
            m_RunClip = index % 4 == 3 ? "Walk" : "Run";
            m_ClingClip = index % 3 == 0 ? "Attack" : "Climb";

            Root = Object.Instantiate(prefab, parent);
            Root.name = "Nibbler_" + index.ToString("00");
            Root.transform.localScale = Vector3.one * scale;

            m_Controller = Root.AddComponent<CharacterController>();
            m_Controller.height = 1.7f * scale;
            m_Controller.radius = 0.3f * scale;
            m_Controller.center = new Vector3(0f, 0.85f * scale, 0f);
            m_Controller.stepOffset = 0.15f;
            m_Controller.slopeLimit = 55f;
            m_Controller.minMoveDistance = 0f;

            Transform animatorRoot = ResolveAnimatorRoot(Root.transform);
            m_Animator = animatorRoot.GetComponent<Animator>();
            if (m_Animator == null) m_Animator = animatorRoot.gameObject.AddComponent<Animator>();
            foreach (Animator childAnimator in Root.GetComponentsInChildren<Animator>(true))
            {
                if (childAnimator != m_Animator) childAnimator.enabled = false;
            }
            m_Animator.applyRootMotion = false;
            m_Animator.cullingMode = AnimatorCullingMode.AlwaysAnimate;
            m_Animator.speed = 0.86f + m_Seed * 0.46f;
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

        public void SetPlayer(Transform player)
        {
            m_Player = player;
        }

        public void Spawn(Vector3 position)
        {
            Active = true;
            Attached = false;
            m_State = NibblerState.Chase;
            Root.SetActive(true);
            Root.transform.position = position;
            Root.transform.rotation = Quaternion.Euler(0f, Random.Range(0f, 360f), 0f);
            m_Controller.enabled = true;
            m_Velocity = Vector3.zero;
            m_StateTime = 0f;
            m_JumpCooldown = 0.25f + m_Seed * 0.85f;
            Play(m_RunClip, 0.08f);
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
            if (player == null)
            {
                Despawn();
                return false;
            }

            SetPlayer(player.transform);
            m_StateTime += dt;
            m_JumpCooldown -= dt;

            if (safe && m_State != NibblerState.Scatter)
            {
                Scatter(player.FeetPosition);
            }

            switch (m_State)
            {
                case NibblerState.Lunge:
                    return TickLunge(player, dt);
                case NibblerState.Climb:
                    return TickClimb(player, settings, dt);
                case NibblerState.Attached:
                    return TickAttached(player, settings, dt);
                case NibblerState.Scatter:
                    TickScatter(player, settings, dt);
                    return false;
                default:
                    TickChase(player, settings, dt, safe);
                    return false;
            }
        }

        void TickChase(DaHilgActor player, DaHilgGameSettings settings, float dt, bool safe)
        {
            Vector3 toPlayer = player.FeetPosition + Vector3.up * 0.25f - Root.transform.position;
            Vector3 planar = new Vector3(toPlayer.x, 0f, toPlayer.z);
            float dist = planar.magnitude;

            if (!safe && dist < Mathf.Max(k_JumpRadius, settings.NibblerAttachDistance + k_AttachPad) && m_JumpCooldown <= 0f)
            {
                StartLunge(player, settings);
                return;
            }

            if (dist > 45f)
            {
                Despawn();
                return;
            }

            Vector3 dir = dist > 0.001f ? planar / dist : Vector3.zero;
            Vector3 side = Vector3.Cross(Vector3.up, dir);
            float weave = Mathf.Sin(Time.time * (2.8f + m_Seed * 1.8f) + m_Index * 0.73f) * 0.42f;
            Vector3 desired = (dir + side * weave).normalized;
            float speed = settings.NibblerRunSpeed * (0.82f + m_Seed * 0.36f);
            Vector3 targetVelocity = desired * speed;
            m_Velocity.x = Mathf.Lerp(m_Velocity.x, targetVelocity.x, 1f - Mathf.Exp(-10f * dt));
            m_Velocity.z = Mathf.Lerp(m_Velocity.z, targetVelocity.z, 1f - Mathf.Exp(-10f * dt));
            m_Velocity.y += settings.Gravity * dt;
            if (m_Velocity.y < settings.MaxFallSpeed) m_Velocity.y = settings.MaxFallSpeed;

            CollisionFlags flags = m_Controller.Move(m_Velocity * dt);
            if ((flags & CollisionFlags.Below) != 0 && m_Velocity.y < 0f) m_Velocity.y = -1f;

            Vector3 facing = new Vector3(m_Velocity.x, 0f, m_Velocity.z);
            if (facing.sqrMagnitude > 0.02f)
            {
                Root.transform.rotation = Quaternion.Slerp(Root.transform.rotation, Quaternion.LookRotation(facing, Vector3.up), 1f - Mathf.Exp(-18f * dt));
            }

            Play((flags & CollisionFlags.Below) == 0 && m_Velocity.y > 0.3f ? "Jump" : m_RunClip, 0.1f);
        }

        void StartLunge(DaHilgActor player, DaHilgGameSettings settings)
        {
            Attached = false;
            m_State = NibblerState.Lunge;
            m_StateTime = 0f;
            m_LungeStart = Root.transform.position;
            m_LungeDuration = 0.28f + m_Seed * 0.16f;
            ChooseAttachAnchor(player, settings);
            m_AttachY = k_ClingBottom;
            if (m_Controller.enabled) m_Controller.enabled = false;
            Play("Jump", 0.05f);
        }

        bool TickLunge(DaHilgActor player, float dt)
        {
            float u = Mathf.Clamp01(m_StateTime / Mathf.Max(0.05f, m_LungeDuration));
            Vector3 target = m_Player.TransformPoint(new Vector3(m_AttachBaseLocal.x, m_AttachY, m_AttachBaseLocal.z));
            Root.transform.position = Vector3.Lerp(m_LungeStart, target, Smooth01(u)) + Vector3.up * Mathf.Sin(u * Mathf.PI) * k_LungeArc;
            FaceBody(player, dt);

            if (u >= 1f)
            {
                Attached = true;
                m_State = NibblerState.Climb;
                m_StateTime = 0f;
                Play("Climb", 0.08f);
                return true;
            }
            return false;
        }

        bool TickClimb(DaHilgActor player, DaHilgGameSettings settings, float dt)
        {
            m_AttachY = Mathf.MoveTowards(m_AttachY, m_AttachTargetY, m_ClimbSpeed * dt);
            PositionOnBody(player, settings, dt);
            Play("Climb", 0.12f);
            if (Mathf.Abs(m_AttachY - m_AttachTargetY) < 0.02f)
            {
                m_State = NibblerState.Attached;
                m_StateTime = 0f;
            }
            return true;
        }

        bool TickAttached(DaHilgActor player, DaHilgGameSettings settings, float dt)
        {
            PositionOnBody(player, settings, dt);
            Play(m_ClingClip, 0.16f);
            return true;
        }

        void PositionOnBody(DaHilgActor player, DaHilgGameSettings settings, float dt)
        {
            bool pronePile = player.AttachedNibblers >= settings.OverwhelmDown;
            Vector3 local = m_AttachBaseLocal;
            if (pronePile)
            {
                float angle = (m_Index % k_ClingAngularSlots) / (float)k_ClingAngularSlots * Mathf.PI * 2f + m_Seed;
                float ring = 0.22f + (m_Index / k_ClingAngularSlots) * 0.12f;
                local = new Vector3(Mathf.Cos(angle) * ring, 0.14f + (m_Index % 3) * 0.14f, 0.35f + Mathf.Sin(angle) * ring);
            }
            else
            {
                float pulse = Mathf.Sin(Time.time * (3.2f + m_Seed) + m_Index) * 0.025f;
                local = new Vector3(local.x * (1f + pulse), m_AttachY + pulse * 0.7f, local.z * (1f + pulse));
            }

            Root.transform.position = m_Player.TransformPoint(local);
            FaceBody(player, dt);
        }

        void TickScatter(DaHilgActor player, DaHilgGameSettings settings, float dt)
        {
            m_Velocity.y += settings.Gravity * dt;
            if (m_Velocity.y < settings.MaxFallSpeed) m_Velocity.y = settings.MaxFallSpeed;
            CollisionFlags flags = m_Controller.Move(m_Velocity * dt);
            if ((flags & CollisionFlags.Below) != 0 && m_Velocity.y < 0f)
            {
                m_Velocity.y = -1f;
                if (m_StateTime > 0.28f)
                {
                    m_State = NibblerState.Chase;
                    m_StateTime = 0f;
                    m_JumpCooldown = 0.45f + m_Seed * 0.8f;
                    Play(m_RunClip, 0.12f);
                }
            }

            Vector3 flat = new Vector3(m_Velocity.x, 0f, m_Velocity.z);
            if (flat.sqrMagnitude > 0.02f)
            {
                Root.transform.rotation = Quaternion.Slerp(Root.transform.rotation, Quaternion.LookRotation(flat, Vector3.up), 1f - Mathf.Exp(-16f * dt));
            }

            if (m_StateTime > k_ScatterTime && Vector3.Distance(Root.transform.position, player.FeetPosition) > 38f)
            {
                Despawn();
            }
        }

        public void Scatter(Vector3 from)
        {
            if (!Active) return;
            Attached = false;
            m_State = NibblerState.Scatter;
            m_StateTime = 0f;
            if (!m_Controller.enabled) m_Controller.enabled = true;
            Vector3 away = Root.transform.position - from;
            away.y = 0f;
            if (away.sqrMagnitude < 0.1f) away = Random.insideUnitSphere;
            away.y = 0f;
            away.Normalize();
            m_Velocity = away * 8f + Vector3.up * (3.2f + m_Seed * 1.2f);
            Play("Jump", 0.05f);
        }

        void ChooseAttachAnchor(DaHilgActor player, DaHilgGameSettings settings)
        {
            int slot = m_Index;
            int col = slot % k_ClingAngularSlots;
            int layer = slot / k_ClingAngularSlots;
            float angle = (col / (float)k_ClingAngularSlots) * Mathf.PI * 2f + layer * 2.39996f + (m_Seed - 0.5f) * 0.6f;
            float heightFrac = Mathf.Repeat((col + layer * 0.5f + m_Seed) / k_ClingAngularSlots, 1f);
            float radius = Mathf.Max(player.BodyRadius, settings.PlayerRadius) + 0.02f + layer * k_ClingLayerStep;
            m_AttachBaseLocal = new Vector3(Mathf.Cos(angle) * radius, k_ClingBottom, Mathf.Sin(angle) * radius);
            m_AttachTargetY = Mathf.Lerp(k_ClingBottom, Mathf.Min(k_ClingTop, player.BodyHeight), heightFrac);
            m_ClimbSpeed = 0.62f + m_Seed * 0.38f;
        }

        void FaceBody(DaHilgActor player, float dt)
        {
            Vector3 center = player.FeetPosition + Vector3.up * Mathf.Clamp(m_AttachY, 0.35f, 1.25f);
            Vector3 inward = center - Root.transform.position;
            if (inward.sqrMagnitude < 0.0001f) return;
            Quaternion target = Quaternion.LookRotation(inward.normalized, Vector3.up);
            Root.transform.rotation = Quaternion.Slerp(Root.transform.rotation, target, 1f - Mathf.Exp(-22f * dt));
        }

        void Play(string state, float fade)
        {
            if (m_Animator == null || m_Anim == state) return;
            int hash = Animator.StringToHash("Base Layer." + state);
            if (m_Animator.HasState(0, hash))
            {
                m_Animator.CrossFade(hash, fade);
                m_Anim = state;
            }
        }

        static float Smooth01(float t)
        {
            return t * t * (3f - 2f * t);
        }
    }
}
