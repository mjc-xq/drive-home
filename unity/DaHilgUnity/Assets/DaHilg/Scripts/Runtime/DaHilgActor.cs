using UnityEngine;

namespace DaHilg
{
    public enum DaHilgActorRole
    {
        Player,
        Npc
    }

    public enum DaHilgNpcState
    {
        Idle,
        Wander,
        Chase,
        Touch,
        Retreat,
        Cooldown,
        Pester
    }

    [RequireComponent(typeof(CharacterController))]
    public sealed class DaHilgActor : MonoBehaviour
    {
        const float k_FaceLerp = 12f;
        const float k_GroundNormalLerp = 18f;
        const float k_GroundProbeHeight = 0.45f;
        const float k_GroundProbeDistance = 1.25f;

        CharacterController m_Controller;
        Transform m_VisualRoot;
        Animator m_Animator;
        RuntimeAnimatorController m_AnimatorController;
        Vector3 m_HorizontalVelocity;
        Vector3 m_GroundNormal = Vector3.up;
        float m_VerticalVelocity;
        float m_LastGroundedTime;
        float m_JumpQueuedTime = -100f;
        float m_FacingYaw;
        float m_VisualYawOffset;
        float m_BodyHeight = 1.7f;
        float m_BodyRadius = 0.3f;
        string m_CurrentAnim;
        float m_EmoteUntil;

        public string Id { get; private set; }
        public string Label { get; private set; }
        public DaHilgActorRole Role { get; private set; }
        public DaHilgNpcState NpcState { get; set; } = DaHilgNpcState.Cooldown;
        public Vector3 Home { get; set; }
        public Vector3 WanderTarget { get; set; }
        public float StateUntil { get; set; }
        public bool Greeted { get; set; }
        public float Health { get; set; } = 100f;
        public int AttachedNibblers { get; set; }
        public Vector3 FeetPosition => transform.position;
        public float FacingYaw => m_FacingYaw;
        public float BodyHeight => m_BodyHeight;
        public float BodyRadius => m_BodyRadius;
        public bool Grounded { get; private set; } = true;
        public float Speed { get; private set; }
        public bool WasJumpStartedThisFrame { get; private set; }

        public void Initialize(DaHilgCharacterSlot slot, RuntimeAnimatorController animatorController, DaHilgGameSettings settings)
        {
            Id = slot.Id;
            Label = slot.Label;
            m_VisualYawOffset = slot.VisualYawOffset;
            m_AnimatorController = animatorController;
            m_BodyHeight = settings.PlayerHeight;
            m_BodyRadius = settings.PlayerRadius;

            m_Controller = GetComponent<CharacterController>();
            m_Controller.height = settings.PlayerHeight;
            m_Controller.radius = settings.PlayerRadius;
            m_Controller.center = new Vector3(0f, settings.PlayerHeight * 0.5f, 0f);
            m_Controller.stepOffset = settings.StepOffset;
            m_Controller.slopeLimit = settings.SlopeLimit;
            m_Controller.minMoveDistance = 0f;

            if (slot.Prefab != null)
            {
                GameObject visual = Instantiate(slot.Prefab, transform);
                visual.name = slot.Label + "_Model";
                visual.transform.localPosition = Vector3.zero;
                visual.transform.localRotation = Quaternion.identity;
                m_VisualRoot = visual.transform;
                Transform animatorRoot = ResolveAnimatorRoot(visual.transform);
                m_Animator = animatorRoot.GetComponent<Animator>();
                if (m_Animator == null) m_Animator = animatorRoot.gameObject.AddComponent<Animator>();
                foreach (Animator childAnimator in visual.GetComponentsInChildren<Animator>(true))
                {
                    if (childAnimator != m_Animator) childAnimator.enabled = false;
                }
                m_Animator.applyRootMotion = false;
                m_Animator.cullingMode = AnimatorCullingMode.AlwaysAnimate;
                if (m_AnimatorController != null) m_Animator.runtimeAnimatorController = m_AnimatorController;
            }
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

        public void SetRole(DaHilgActorRole role, float now)
        {
            Role = role;
            NpcState = role == DaHilgActorRole.Player ? DaHilgNpcState.Idle : DaHilgNpcState.Cooldown;
            StateUntil = now + 1.5f;
            if (role == DaHilgActorRole.Player)
            {
                m_HorizontalVelocity = Vector3.zero;
                m_EmoteUntil = 0f;
                PlayAnim("Idle", 0.1f);
            }
        }

        public void Teleport(Vector3 feetPosition)
        {
            if (m_Controller == null) m_Controller = GetComponent<CharacterController>();
            bool wasEnabled = m_Controller.enabled;
            m_Controller.enabled = false;
            transform.position = feetPosition;
            m_Controller.enabled = wasEnabled;
            Home = feetPosition;
            m_HorizontalVelocity = Vector3.zero;
            m_VerticalVelocity = 0f;
            Grounded = true;
            m_EmoteUntil = 0f;
        }

        public void QueueJump(float now)
        {
            m_JumpQueuedTime = now;
        }

        public void StepPlayer(Vector2 inputMove, bool run, bool jumpPressed, float cameraYaw, DaHilgGameSettings settings, float dt, float now, bool crawlOnly, bool pinned)
        {
            WasJumpStartedThisFrame = false;
            if (jumpPressed) QueueJump(now);

            Vector3 forward = Quaternion.Euler(0f, cameraYaw, 0f) * Vector3.forward;
            Vector3 right = Quaternion.Euler(0f, cameraYaw, 0f) * Vector3.right;
            Vector3 desired = forward * inputMove.y + right * inputMove.x;
            if (desired.sqrMagnitude > 1f) desired.Normalize();

            float cap = crawlOnly ? settings.CrawlSpeed : (run ? settings.RunSpeed : settings.WalkSpeed);
            if (pinned) cap = 0f;

            StepMotion(desired, cap, true, cameraYaw, settings, dt, now);
        }

        public void StepNpc(Vector3 desiredDirection, bool run, DaHilgGameSettings settings, float dt, float now)
        {
            WasJumpStartedThisFrame = false;
            float cap = run ? settings.RunSpeed : settings.WalkSpeed;
            StepMotion(desiredDirection, cap, false, m_FacingYaw, settings, dt, now);
        }

        void StepMotion(Vector3 desiredDirection, float speedCap, bool playerFacing, float playerYaw, DaHilgGameSettings settings, float dt, float now)
        {
            if (m_Controller == null) return;

            Grounded = m_Controller.isGrounded;
            if (Grounded) m_LastGroundedTime = now;

            desiredDirection.y = 0f;
            if (desiredDirection.sqrMagnitude > 1f) desiredDirection.Normalize();

            Vector3 targetVelocity = desiredDirection * speedCap;
            float accel = Grounded ? settings.GroundAcceleration : settings.AirAcceleration;
            float k = 1f - Mathf.Exp(-accel * dt);
            m_HorizontalVelocity = Vector3.Lerp(m_HorizontalVelocity, targetVelocity, k);

            bool bufferedJump = now - m_JumpQueuedTime <= settings.JumpBuffer;
            bool coyote = now - m_LastGroundedTime <= settings.CoyoteTime;
            if (bufferedJump && (Grounded || coyote))
            {
                m_EmoteUntil = 0f;
                m_VerticalVelocity = settings.JumpVelocity;
                m_JumpQueuedTime = -100f;
                Grounded = false;
                WasJumpStartedThisFrame = true;
                SetAnimatorSpeed(1f, dt);
                PlayAnim("Jump", 0.05f);
            }

            if (Grounded && m_VerticalVelocity < 0f) m_VerticalVelocity = -2f;
            m_VerticalVelocity += settings.Gravity * dt;
            if (m_VerticalVelocity < settings.MaxFallSpeed) m_VerticalVelocity = settings.MaxFallSpeed;

            Vector3 before = transform.position;
            Vector3 move = (m_HorizontalVelocity + Vector3.up * m_VerticalVelocity) * dt;
            CollisionFlags flags = m_Controller.Move(move);
            if ((flags & CollisionFlags.Below) != 0 && m_VerticalVelocity < 0f)
            {
                m_VerticalVelocity = 0f;
                Grounded = true;
                m_LastGroundedTime = now;
            }

            Vector3 delta = transform.position - before;
            Vector3 planar = new Vector3(delta.x, 0f, delta.z);
            Speed = planar.magnitude / Mathf.Max(dt, 0.0001f);
            UpdateGroundNormal(dt);

            Vector3 faceVelocity = planar.sqrMagnitude > 0.0004f ? planar / Mathf.Max(dt, 0.0001f) : m_HorizontalVelocity;
            if (faceVelocity.sqrMagnitude > 0.02f)
            {
                float targetYaw = Quaternion.LookRotation(new Vector3(faceVelocity.x, 0f, faceVelocity.z)).eulerAngles.y;
                m_FacingYaw = Mathf.LerpAngle(m_FacingYaw, targetYaw, 1f - Mathf.Exp(-k_FaceLerp * dt));
            }
            else if (playerFacing)
            {
                m_FacingYaw = Mathf.LerpAngle(m_FacingYaw, playerYaw, 1f - Mathf.Exp(-k_FaceLerp * dt));
            }

            if (m_VisualRoot != null)
            {
                Quaternion yaw = Quaternion.Euler(0f, m_FacingYaw + m_VisualYawOffset, 0f);
                Quaternion groundTilt = Quaternion.FromToRotation(Vector3.up, m_GroundNormal);
                m_VisualRoot.rotation = Quaternion.Slerp(m_VisualRoot.rotation, groundTilt * yaw, 1f - Mathf.Exp(18f * -dt));
            }

            if (Time.time < m_EmoteUntil && Grounded && Speed <= 0.2f)
            {
                return;
            }

            if (Speed > 0.2f)
            {
                m_EmoteUntil = 0f;
            }

            UpdateLocomotionAnimation(settings, dt);
        }

        public void PlayEmote(string emote)
        {
            m_EmoteUntil = Time.time + EmoteDuration(emote);
            SetAnimatorSpeed(1f, Time.deltaTime);
            PlayAnim(emote, 0.12f);
        }

        static float EmoteDuration(string emote)
        {
            switch (emote)
            {
                case "Dance": return 2.4f;
                case "Wave": return 1.45f;
                case "Cheer": return 1.6f;
                case "Attack": return 1.05f;
                default: return 1.2f;
            }
        }

        void UpdateGroundNormal(float dt)
        {
            Vector3 origin = transform.position + Vector3.up * k_GroundProbeHeight;
            if (Physics.SphereCast(origin, Mathf.Max(0.05f, m_BodyRadius * 0.75f), Vector3.down, out RaycastHit hit, k_GroundProbeDistance, ~0, QueryTriggerInteraction.Ignore))
            {
                m_GroundNormal = Vector3.Slerp(m_GroundNormal, hit.normal, 1f - Mathf.Exp(-k_GroundNormalLerp * dt));
            }
            else
            {
                m_GroundNormal = Vector3.Slerp(m_GroundNormal, Vector3.up, 1f - Mathf.Exp(-k_GroundNormalLerp * dt));
            }
        }

        void UpdateLocomotionAnimation(DaHilgGameSettings settings, float dt)
        {
            if (!Grounded && m_VerticalVelocity < -1f)
            {
                SetAnimatorSpeed(1f, dt);
                PlayAnim("Jump", 0.1f);
                return;
            }

            if (AttachedNibblers >= settings.OverwhelmDown)
            {
                SetAnimatorSpeed(Speed > 0.15f ? 0.82f : 1f, dt);
                PlayAnim(Speed > 0.15f ? "Crawl" : "Knockdown", 0.16f);
                return;
            }

            if (AttachedNibblers >= settings.OverwhelmStagger && Speed > 0.15f)
            {
                SetAnimatorSpeed(Mathf.Clamp(Speed / Mathf.Max(0.1f, settings.WalkSpeed), 0.72f, 1.15f), dt);
                PlayAnim("Stumble", 0.14f);
                return;
            }

            if (Speed > 4.5f)
            {
                SetAnimatorSpeed(Mathf.Clamp(Speed / Mathf.Max(0.1f, settings.RunSpeed), 0.78f, 1.28f), dt);
                PlayAnim("Run", 0.16f);
            }
            else if (Speed > 0.15f)
            {
                SetAnimatorSpeed(Mathf.Clamp(Speed / Mathf.Max(0.1f, settings.WalkSpeed), 0.72f, 1.22f), dt);
                PlayAnim("Walk", 0.16f);
            }
            else
            {
                SetAnimatorSpeed(0.72f, dt);
                PlayAnim("Idle", 0.18f);
            }
        }

        void SetAnimatorSpeed(float speed, float dt)
        {
            if (m_Animator == null) return;
            if (dt <= 0f) m_Animator.speed = speed;
            else m_Animator.speed = Mathf.Lerp(m_Animator.speed, speed, 1f - Mathf.Exp(-10f * dt));
        }

        void PlayAnim(string stateName, float fade)
        {
            if (m_Animator == null || string.IsNullOrEmpty(stateName) || m_CurrentAnim == stateName) return;

            int hash = Animator.StringToHash("Base Layer." + stateName);
            if (m_Animator.HasState(0, hash))
            {
                m_Animator.CrossFade(hash, fade);
                m_CurrentAnim = stateName;
            }
        }
    }
}
