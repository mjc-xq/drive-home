using System.Collections.Generic;
using UnityEngine;

namespace DaHilg
{
    public sealed class DaHilgNibblerAgent
    {
        static readonly List<DaHilgNibblerAgent> s_Active = new List<DaHilgNibblerAgent>(32);
        static readonly string[] s_IdleEmotes = { "Dance", "Wave", "Cheer" };

        enum NibblerState
        {
            Chase,
            Lunge,
            Climb,
            Attached,
            Scatter,
            Crushed
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
        readonly string m_EmoteClip;
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
            m_ClingClip = index % 3 == 0 ? "Attack" : "Hit";
            m_EmoteClip = s_IdleEmotes[index % s_IdleEmotes.Length];

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
            m_Controller.skinWidth = Mathf.Max(0.01f, m_Controller.radius * 0.2f);
            m_Controller.enableOverlapRecovery = true;

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
            if (!s_Active.Contains(this)) s_Active.Add(this);
            m_State = NibblerState.Chase;
            Root.SetActive(true);
            Root.transform.localScale = Vector3.one * m_Scale;
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
            s_Active.Remove(this);
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
                case NibblerState.Crushed:
                    TickCrushed(settings, dt);
                    return false;
                default:
                    TickChase(player, settings, dt, safe);
                    return false;
            }
        }

        void TickChase(DaHilgActor player, DaHilgGameSettings settings, float dt, bool safe)
        {
            // Aim for a point on a ring around the player (per-seed angle) so the swarm
            // surrounds rather than stacking on the identical center point.
            float ringAngle = m_Seed * Mathf.PI * 2f + m_Index * 2.39996f;
            float ringRadius = Mathf.Max(0.6f, settings.NibblerAttachDistance * 0.85f);
            Vector3 ringTarget = player.FeetPosition + Vector3.up * 0.25f
                + new Vector3(Mathf.Cos(ringAngle), 0f, Mathf.Sin(ringAngle)) * ringRadius;

            Vector3 toPlayer = ringTarget - Root.transform.position;
            Vector3 planar = new Vector3(toPlayer.x, 0f, toPlayer.z);
            float dist = planar.magnitude;

            // Use the true player distance for the lunge/despawn gates, not the ring target.
            Vector3 toCenter = player.FeetPosition + Vector3.up * 0.25f - Root.transform.position;
            float centerDist = new Vector3(toCenter.x, 0f, toCenter.z).magnitude;

            if (!safe && centerDist < Mathf.Max(k_JumpRadius, settings.NibblerAttachDistance + k_AttachPad) && m_JumpCooldown <= 0f)
            {
                StartLunge(player, settings);
                return;
            }

            if (centerDist > 45f)
            {
                Despawn();
                return;
            }

            Vector3 dir = dist > 0.001f ? planar / dist : Vector3.zero;
            Vector3 side = Vector3.Cross(Vector3.up, dir);
            float weave = Mathf.Sin(Time.time * (2.8f + m_Seed * 1.8f) + m_Index * 0.73f) * 0.42f;
            Vector3 separation = ComputeSeparation();
            Vector3 desired = (dir + side * weave + separation * 0.6f).normalized;
            float speed = settings.NibblerRunSpeed * (0.82f + m_Seed * 0.36f);
            Vector3 targetVelocity = desired * speed;
            m_Velocity.x = Mathf.Lerp(m_Velocity.x, targetVelocity.x, 1f - Mathf.Exp(-10f * dt));
            m_Velocity.z = Mathf.Lerp(m_Velocity.z, targetVelocity.z, 1f - Mathf.Exp(-10f * dt));
            m_Velocity.y += settings.Gravity * dt;
            if (m_Velocity.y < settings.MaxFallSpeed) m_Velocity.y = settings.MaxFallSpeed;

            CollisionFlags flags = m_Controller.Move(m_Velocity * dt);
            if ((flags & CollisionFlags.Below) != 0 && m_Velocity.y < 0f) m_Velocity.y = -1f;
            else if (m_Velocity.y <= 0f && SnapToLevelGround(settings)) flags |= CollisionFlags.Below;

            Vector3 facing = new Vector3(m_Velocity.x, 0f, m_Velocity.z);
            if (facing.sqrMagnitude > 0.02f)
            {
                Root.transform.rotation = Quaternion.Slerp(Root.transform.rotation, Quaternion.LookRotation(facing, Vector3.up), 1f - Mathf.Exp(-18f * dt));
            }

            Play((flags & CollisionFlags.Below) == 0 && m_Velocity.y > 0.3f ? "Jump" : m_RunClip, 0.1f);
        }

        Vector3 ComputeSeparation()
        {
            float neighborRadius = Mathf.Max(0.3f, m_Controller.radius) * 1.2f;
            float sqrRadius = neighborRadius * neighborRadius;
            Vector3 selfPos = Root.transform.position;
            Vector3 push = Vector3.zero;
            for (int i = 0; i < s_Active.Count; i++)
            {
                DaHilgNibblerAgent other = s_Active[i];
                if (other == this || !other.Active || other.Attached) continue;
                Vector3 offset = selfPos - other.Root.transform.position;
                offset.y = 0f;
                float sqr = offset.sqrMagnitude;
                if (sqr < 0.0001f || sqr > sqrRadius) continue;
                push += offset / Mathf.Sqrt(sqr);
            }
            return push.sqrMagnitude > 0.0001f ? push.normalized : Vector3.zero;
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
                float bob = Mathf.Sin(Time.time * (3.2f + m_Seed) + m_Index) * 0.008f;
                local = new Vector3(local.x, m_AttachY + bob, local.z);
            }

            Root.transform.position = m_Player.TransformPoint(local);
            FaceBody(player, dt);
        }

        void TickScatter(DaHilgActor player, DaHilgGameSettings settings, float dt)
        {
            m_Velocity.y += settings.Gravity * dt;
            if (m_Velocity.y < settings.MaxFallSpeed) m_Velocity.y = settings.MaxFallSpeed;
            CollisionFlags flags = m_Controller.Move(m_Velocity * dt);
            bool grounded = (flags & CollisionFlags.Below) != 0 && m_Velocity.y < 0f;
            if (grounded)
            {
                m_Velocity.y = -1f;
                // Brake the launch so the nibbler can settle and play a per-seed idle emote.
                m_Velocity.x = Mathf.Lerp(m_Velocity.x, 0f, 1f - Mathf.Exp(-9f * dt));
                m_Velocity.z = Mathf.Lerp(m_Velocity.z, 0f, 1f - Mathf.Exp(-9f * dt));
                // Hold a varied emote (Dance/Wave/Cheer) for a moment before resuming the chase.
                float emoteHold = 0.6f + m_Seed * 0.7f;
                if (m_StateTime > 0.28f) Play(m_EmoteClip, 0.18f);
                if (m_StateTime > 0.28f + emoteHold)
                {
                    m_State = NibblerState.Chase;
                    m_StateTime = 0f;
                    m_JumpCooldown = 0.45f + m_Seed * 0.8f;
                    Play(m_RunClip, 0.12f);
                }
            }
            else if (m_Velocity.y <= 0f)
            {
                SnapToLevelGround(settings);
            }

            Vector3 flat = new Vector3(m_Velocity.x, 0f, m_Velocity.z);
            if (!grounded && flat.sqrMagnitude > 0.02f)
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

        public bool TryCrushByRoll(DaHilgActor player, Vector3 crushCenter, float sideSign, DaHilgGameSettings settings)
        {
            if (!Active || player == null || settings == null) return false;

            float side = sideSign >= 0f ? 1f : -1f;
            bool bodySideHit = false;
            if (Attached || m_State == NibblerState.Climb || m_State == NibblerState.Lunge)
            {
                float anchorSide = m_AttachBaseLocal.x >= 0f ? 1f : -1f;
                float maxCrushY = Mathf.Min(player.BodyHeight, settings.RollCrushBodyHeight);
                bodySideHit = Mathf.Approximately(anchorSide, side) && m_AttachY <= maxCrushY;
            }

            Vector3 toCenter = Root.transform.position - crushCenter;
            float planarDistance = new Vector2(toCenter.x, toCenter.z).magnitude;
            bool groundHit = planarDistance <= settings.RollCrushRadius
                && Root.transform.position.y <= crushCenter.y + Mathf.Max(0.45f, settings.RollCrushBodyHeight);

            if (!bodySideHit && !groundHit) return false;

            Crush(crushCenter);
            return true;
        }

        public bool CrushByMelee(Vector3 from)
        {
            if (!Active) return false;
            Crush(from);
            return true;
        }

        void Crush(Vector3 from)
        {
            Attached = false;
            m_State = NibblerState.Crushed;
            m_StateTime = 0f;
            if (!m_Controller.enabled) m_Controller.enabled = true;
            Vector3 away = Root.transform.position - from;
            away.y = 0f;
            if (away.sqrMagnitude < 0.1f)
            {
                away = Random.insideUnitSphere;
                away.y = 0f;
            }
            away.Normalize();
            m_Velocity = away * (4.8f + m_Seed * 1.8f) + Vector3.up * (1.8f + m_Seed * 0.8f);
            Play("Knockdown", 0.04f);
        }

        void TickCrushed(DaHilgGameSettings settings, float dt)
        {
            m_Velocity.y += settings.Gravity * dt;
            if (m_Velocity.y < settings.MaxFallSpeed) m_Velocity.y = settings.MaxFallSpeed;
            CollisionFlags flags = m_Controller.Move(m_Velocity * dt);
            if ((flags & CollisionFlags.Below) != 0 && m_Velocity.y < 0f)
            {
                m_Velocity.y = -1f;
                m_Velocity.x = Mathf.Lerp(m_Velocity.x, 0f, 1f - Mathf.Exp(-12f * dt));
                m_Velocity.z = Mathf.Lerp(m_Velocity.z, 0f, 1f - Mathf.Exp(-12f * dt));
            }
            else if (m_Velocity.y <= 0f)
            {
                SnapToLevelGround(settings);
            }

            Root.transform.localScale = Vector3.one * m_Scale * Mathf.Lerp(1f, 0.58f, Mathf.Clamp01(m_StateTime / 0.38f));
            if (m_StateTime > 0.46f) Despawn();
        }

        bool SnapToLevelGround(DaHilgGameSettings settings)
        {
            if (m_Controller == null || !m_Controller.enabled) return false;

            float probeHeight = Mathf.Max(settings.GroundProbeHeight, m_Controller.height * 4f);
            float probeDistance = probeHeight + Mathf.Max(settings.GroundSnapDistance, settings.StepOffset);
            float maxAbove = Mathf.Max(settings.GroundSnapDistance * 1.2f, settings.StepOffset + 0.28f);
            if (!DaHilgLevelRuntime.TryFindGround(Root.transform.position, out RaycastHit hit, probeHeight, probeDistance, maxAbove)) return false;

            float targetY = hit.point.y + Mathf.Max(0.018f, settings.GroundSkin * 0.5f);
            float deltaY = targetY - Root.transform.position.y;
            float maxLift = Mathf.Max(settings.GroundSnapDistance * 1.8f, settings.StepOffset);
            float maxDrop = Mathf.Max(settings.StepOffset, 0.45f);
            if (deltaY > maxLift || deltaY < -maxDrop) return false;
            if (Mathf.Abs(deltaY) <= 0.01f) return true;

            m_Controller.Move(Vector3.up * deltaY);
            if (m_Velocity.y < 0f) m_Velocity.y = -1f;
            return true;
        }

        void ChooseAttachAnchor(DaHilgActor player, DaHilgGameSettings settings)
        {
            // Distribute by a live count of nibblers already on the body so simultaneous
            // lunges claim distinct consecutive slots instead of reusing pooled indices.
            int slot = CountAttachedSlots();
            int col = slot % k_ClingAngularSlots;
            int layer = slot / k_ClingAngularSlots;
            float angle = (col / (float)k_ClingAngularSlots) * Mathf.PI * 2f + layer * 2.39996f + (m_Seed - 0.5f) * 0.6f;
            float heightFrac = Mathf.Repeat((col + layer * 0.5f + m_Seed) / k_ClingAngularSlots, 1f);
            float radius = Mathf.Max(player.BodyRadius, settings.PlayerRadius) + 0.02f + layer * k_ClingLayerStep;
            m_AttachBaseLocal = new Vector3(Mathf.Cos(angle) * radius, k_ClingBottom, Mathf.Sin(angle) * radius);
            m_AttachTargetY = Mathf.Lerp(k_ClingBottom, Mathf.Min(k_ClingTop, player.BodyHeight), heightFrac);
            m_ClimbSpeed = 0.62f + m_Seed * 0.38f;
        }

        int CountAttachedSlots()
        {
            int count = 0;
            for (int i = 0; i < s_Active.Count; i++)
            {
                DaHilgNibblerAgent other = s_Active[i];
                if (other == this || !other.Active) continue;
                if (other.Attached
                    || other.m_State == NibblerState.Climb
                    || other.m_State == NibblerState.Lunge)
                {
                    count++;
                }
            }
            return count;
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
