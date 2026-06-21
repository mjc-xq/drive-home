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
        const float k_GroundedTolerance = 0.14f;

        CharacterController m_Controller;
        Transform m_VisualRoot;
        Transform m_LeftFoot;
        Transform m_RightFoot;
        Animator m_Animator;
        RuntimeAnimatorController m_AnimatorController;
        DaHilgGameSettings m_Settings;
        Vector3 m_HorizontalVelocity;
        Vector3 m_GroundNormal = Vector3.up;
        float m_VerticalVelocity;
        float m_LastGroundedTime;
        float m_JumpQueuedTime = -100f;
        float m_FacingYaw;
        float m_VisualYawOffset;
        float m_BodyHeight = 1.7f;
        float m_BodyRadius = 0.3f;
        float m_VisualGroundOffset;
        string m_CurrentAnim;
        float m_EmoteUntil;
        float m_RollUntil;
        float m_RollStartedAt;
        float m_NextRollAt;
        float m_RollSide = 1f;
        Vector3 m_RollDirection;
        float m_NextMeleeAt;
        float m_MeleeActiveUntil;
        int m_ComboStep;
        float m_StaggerUntil;
        Vector3 m_HitVel;
        float m_HitVelUntil;

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
        public bool Rolling => Time.time < m_RollUntil;
        public float RollSideSign => m_RollSide >= 0f ? 1f : -1f;

        public void Initialize(DaHilgCharacterSlot slot, RuntimeAnimatorController animatorController, DaHilgGameSettings settings)
        {
            Id = slot.Id;
            Label = slot.Label;
            m_VisualYawOffset = slot.VisualYawOffset;
            m_AnimatorController = animatorController;
            m_Settings = settings;
            m_BodyHeight = settings.PlayerHeight;
            m_BodyRadius = settings.PlayerRadius;

            m_Controller = GetComponent<CharacterController>();
            m_Controller.height = settings.PlayerHeight;
            m_Controller.radius = settings.PlayerRadius;
            m_Controller.center = new Vector3(0f, settings.PlayerHeight * 0.5f, 0f);
            m_Controller.stepOffset = settings.StepOffset;
            m_Controller.slopeLimit = settings.SlopeLimit;
            m_Controller.minMoveDistance = 0f;
            m_Controller.skinWidth = Mathf.Max(0.035f, settings.ControllerSkinWidth, settings.PlayerRadius * 0.12f);
            m_Controller.enableOverlapRecovery = true;

            if (slot.Prefab != null)
            {
                GameObject visual = Instantiate(slot.Prefab, transform);
                visual.name = slot.Label + "_Model";
                visual.transform.localPosition = Vector3.zero;
                visual.transform.localRotation = Quaternion.identity;
                m_VisualRoot = visual.transform;
                Transform animatorRoot = ResolveAnimatorRoot(visual.transform);
                m_Animator = animatorRoot.GetComponent<Animator>();
                m_LeftFoot = FindDeepChild(visual.transform, "LeftFoot");
                m_RightFoot = FindDeepChild(visual.transform, "RightFoot");
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

        static Transform FindDeepChild(Transform parent, string childName)
        {
            if (parent == null) return null;
            if (parent.name == childName) return parent;
            for (int i = 0; i < parent.childCount; i++)
            {
                Transform found = FindDeepChild(parent.GetChild(i), childName);
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
                m_RollUntil = 0f;
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
            m_RollUntil = 0f;
            m_VisualGroundOffset = 0f;
            if (m_VisualRoot != null) m_VisualRoot.localPosition = Vector3.zero;
        }

        void LateUpdate()
        {
            StabilizeVisualGrounding(Time.deltaTime);
        }

        public void QueueJump(float now)
        {
            m_JumpQueuedTime = now;
        }

        public bool RollReady(float now)
        {
            return now >= m_NextRollAt;
        }

        public float RollCooldownRemaining(float now)
        {
            return Mathf.Max(0f, m_NextRollAt - now);
        }

        public bool StartFallRoll(Vector2 inputMove, float cameraYaw, DaHilgGameSettings settings, float now)
        {
            if (settings == null || now < m_NextRollAt || Health <= 0f) return false;

            Quaternion cameraRot = Quaternion.Euler(0f, cameraYaw, 0f);
            Vector3 forward = cameraRot * Vector3.forward;
            Vector3 right = cameraRot * Vector3.right;
            m_RollSide = inputMove.x < -0.12f ? -1f : 1f;
            Vector3 side = right * m_RollSide;
            Vector3 push = side + forward * Mathf.Clamp(inputMove.y * 0.35f, -0.2f, 0.45f);
            if (inputMove.sqrMagnitude > 0.16f)
            {
                Vector3 desired = forward * inputMove.y + right * inputMove.x;
                desired.y = 0f;
                if (desired.sqrMagnitude > 0.04f) push = Vector3.Lerp(side, desired.normalized, 0.35f);
            }

            push.y = 0f;
            m_RollDirection = push.sqrMagnitude > 0.001f ? push.normalized : side;
            m_RollStartedAt = now;
            m_RollUntil = now + Mathf.Max(0.2f, settings.RollDuration);
            m_NextRollAt = now + Mathf.Max(settings.RollCooldown, settings.RollDuration + 0.15f);
            m_JumpQueuedTime = -100f;
            m_EmoteUntil = 0f;
            if (m_VerticalVelocity < 0f) m_VerticalVelocity = -2f;
            SetAnimatorSpeed(1.18f, Time.deltaTime);
            PlayAnim("Stumble", 0.05f);
            return true;
        }

        public Vector3 RollCrushCenter(DaHilgGameSettings settings)
        {
            float radius = settings != null ? settings.RollCrushRadius : 1.1f;
            Vector3 right = Quaternion.Euler(0f, m_FacingYaw, 0f) * Vector3.right;
            return FeetPosition
                + right * RollSideSign * Mathf.Max(m_BodyRadius + radius * 0.32f, 0.62f)
                + Vector3.up * 0.26f;
        }

        public bool StartMelee(float now)
        {
            if (Health <= 0f || Rolling || now < m_NextMeleeAt || now < m_StaggerUntil) return false;

            m_NextMeleeAt = now + 0.42f;
            m_MeleeActiveUntil = now + 0.45f;
            m_ComboStep = (m_ComboStep + 1) % 3;
            m_EmoteUntil = 0f;
            SetAnimatorSpeed(m_ComboStep == 2 ? 1.18f : 1f, Time.deltaTime);
            PlayAnim("Attack", 0.05f);
            return true;
        }

        public bool MeleeActive(float now) => now < m_MeleeActiveUntil;

        public bool Staggered(float now) => now < m_StaggerUntil;

        public void TakeHit(Vector3 fromPos, float damage, float knockback, bool heavy, float now)
        {
            if (Health <= 0f) return;

            Health = Mathf.Max(0f, Health - damage);

            Vector3 dir = FeetPosition - fromPos;
            dir.y = 0f;
            if (dir.sqrMagnitude < 0.0001f)
            {
                dir = -(Quaternion.Euler(0f, m_FacingYaw, 0f) * Vector3.forward);
            }
            dir.Normalize();

            m_HitVel = dir * knockback;
            m_HitVelUntil = now + 0.30f;
            m_StaggerUntil = now + (heavy ? 1.1f : 0.45f);
            m_EmoteUntil = 0f;

            // Face the attacker so the hit reads as a reaction.
            Vector3 toAttacker = fromPos - FeetPosition;
            toAttacker.y = 0f;
            if (toAttacker.sqrMagnitude > 0.0001f)
            {
                m_FacingYaw = Quaternion.LookRotation(toAttacker.normalized, Vector3.up).eulerAngles.y;
            }

            SetAnimatorSpeed(1f, Time.deltaTime);
            PlayAnim(heavy ? "Knockdown" : "Stumble", 0.06f);
        }

        public void TickHitMotion(float dt, float now)
        {
            if (m_Controller == null || !m_Controller.enabled) return;
            if (now >= m_HitVelUntil)
            {
                m_HitVel = Vector3.zero;
                return;
            }

            Vector3 horizontal = new Vector3(m_HitVel.x, 0f, m_HitVel.z) * dt;
            if (horizontal.sqrMagnitude > 0f) m_Controller.Move(horizontal);
            if (m_Settings != null) SnapToLevelGround(m_Settings, now);
            m_HitVel = Vector3.Lerp(m_HitVel, Vector3.zero, dt * 6f);
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
            if (pinned && !Rolling) cap = 0f;

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

            Grounded = m_Controller.isGrounded || IsCloseToLevelGround(settings);
            if (Grounded) m_LastGroundedTime = now;

            desiredDirection.y = 0f;
            if (desiredDirection.sqrMagnitude > 1f) desiredDirection.Normalize();

            bool rolling = now < m_RollUntil;
            if (rolling)
            {
                desiredDirection = m_RollDirection.sqrMagnitude > 0.001f ? m_RollDirection : desiredDirection;
                speedCap = Mathf.Max(speedCap, settings.RollSpeed);
                m_EmoteUntil = 0f;
            }

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
            else if (!WasJumpStartedThisFrame && m_VerticalVelocity <= 0f && SnapToLevelGround(settings, now))
            {
                Grounded = true;
            }

            Vector3 delta = transform.position - before;
            Vector3 planar = new Vector3(delta.x, 0f, delta.z);
            Speed = planar.magnitude / Mathf.Max(dt, 0.0001f);
            UpdateGroundNormal(settings, dt);

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
                Quaternion rollTilt = Quaternion.identity;
                if (rolling)
                {
                    float u = Mathf.InverseLerp(m_RollStartedAt, Mathf.Max(m_RollStartedAt + 0.01f, m_RollUntil), now);
                    float recover = Mathf.SmoothStep(0f, 1f, Mathf.InverseLerp(0.62f, 1f, u));
                    float sideAngle = Mathf.Lerp(76f, 18f, recover);
                    float tumbleAngle = Mathf.Sin(u * Mathf.PI * 2f) * 16f;
                    rollTilt = Quaternion.Euler(0f, 0f, -(sideAngle + tumbleAngle) * RollSideSign);
                }
                m_VisualRoot.rotation = Quaternion.Slerp(m_VisualRoot.rotation, groundTilt * yaw * rollTilt, 1f - Mathf.Exp(18f * -dt));
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
            if (Rolling) return;
            if (!Grounded && (m_Settings == null || !IsCloseToLevelGround(m_Settings))) return;
            m_EmoteUntil = Time.time + EmoteDuration(emote);
            SetAnimatorSpeed(1f, Time.deltaTime);
            PlayAnim(emote, 0.12f);
        }

        void StabilizeVisualGrounding(float dt)
        {
            if (m_VisualRoot == null || m_Settings == null) return;

            bool canPin = Grounded && !Rolling && !WasJumpStartedThisFrame && m_VerticalVelocity <= 0.1f;
            if (!canPin)
            {
                m_VisualGroundOffset = Mathf.Lerp(m_VisualGroundOffset, 0f, 1f - Mathf.Exp(-16f * Mathf.Max(0f, dt)));
                Vector3 local = m_VisualRoot.localPosition;
                local.x = 0f;
                local.y = m_VisualGroundOffset;
                local.z = 0f;
                m_VisualRoot.localPosition = local;
                return;
            }

            bool hasFoot = false;
            float minFootY = float.PositiveInfinity;
            if (m_LeftFoot != null)
            {
                minFootY = Mathf.Min(minFootY, m_LeftFoot.position.y);
                hasFoot = true;
            }
            if (m_RightFoot != null)
            {
                minFootY = Mathf.Min(minFootY, m_RightFoot.position.y);
                hasFoot = true;
            }
            if (!hasFoot) return;

            float targetY = FeetPosition.y + Mathf.Max(0.012f, m_Settings.GroundSkin * 0.35f);
            float correction = targetY - minFootY;
            float desiredOffset = Mathf.Clamp(m_VisualGroundOffset + correction, -0.34f, 0.34f);
            float k = 1f - Mathf.Exp(-24f * Mathf.Max(0f, dt));
            m_VisualGroundOffset = Mathf.Lerp(m_VisualGroundOffset, desiredOffset, k);

            Vector3 adjusted = m_VisualRoot.localPosition;
            adjusted.x = 0f;
            adjusted.y = m_VisualGroundOffset;
            adjusted.z = 0f;
            m_VisualRoot.localPosition = adjusted;
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

        bool IsCloseToLevelGround(DaHilgGameSettings settings)
        {
            if (m_VerticalVelocity > 0.1f) return false;
            if (!TryFindLevelGround(settings, out RaycastHit hit)) return false;

            float targetY = hit.point.y + Mathf.Max(0.01f, settings.GroundSkin);
            float deltaY = targetY - transform.position.y;
            return deltaY >= -Mathf.Max(k_GroundedTolerance, settings.StepOffset)
                && deltaY <= Mathf.Max(settings.GroundSnapDistance, settings.StepOffset);
        }

        bool SnapToLevelGround(DaHilgGameSettings settings, float now)
        {
            if (m_Controller == null || !m_Controller.enabled) return false;
            if (!TryFindLevelGround(settings, out RaycastHit hit)) return false;

            float targetY = hit.point.y + Mathf.Max(0.01f, settings.GroundSkin);
            float deltaY = targetY - transform.position.y;
            float maxLift = Mathf.Max(settings.GroundSnapDistance * 1.8f, settings.StepOffset + settings.ControllerSkinWidth);
            float maxDrop = Mathf.Max(settings.StepOffset + settings.ControllerSkinWidth, 0.55f);
            if (deltaY > maxLift || deltaY < -maxDrop) return false;

            if (Mathf.Abs(deltaY) > 0.012f)
            {
                CollisionFlags flags = m_Controller.Move(Vector3.up * deltaY);
                if (deltaY < 0f && (flags & CollisionFlags.Below) == 0) return false;
            }

            if (m_VerticalVelocity < 0f) m_VerticalVelocity = 0f;
            Grounded = true;
            m_LastGroundedTime = now;
            return true;
        }

        bool TryFindLevelGround(DaHilgGameSettings settings, out RaycastHit hit)
        {
            float probeHeight = Mathf.Max(settings.GroundProbeHeight, m_BodyHeight * 1.5f);
            float probeDistance = probeHeight + Mathf.Max(settings.GroundSnapDistance, settings.StepOffset + settings.ControllerSkinWidth);
            float maxAbove = Mathf.Max(settings.GroundSnapDistance * 1.2f, settings.StepOffset + settings.ControllerSkinWidth + 0.35f);
            return DaHilgLevelRuntime.TryFindGround(transform.position, out hit, probeHeight, probeDistance, maxAbove);
        }

        void UpdateGroundNormal(DaHilgGameSettings settings, float dt)
        {
            if (TryFindLevelGround(settings, out RaycastHit hit))
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
            if (Rolling)
            {
                SetAnimatorSpeed(1.12f, dt);
                PlayAnim(Speed > 0.1f ? "Stumble" : "Knockdown", 0.08f);
                return;
            }

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
