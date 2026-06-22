using System.Collections.Generic;
using UnityEngine;

namespace DaHilg
{
    public sealed class DaHilgNibblerAgent
    {
        static readonly List<DaHilgNibblerAgent> s_Active = new List<DaHilgNibblerAgent>(32);
        // One warning per missing state per session so a wrong/unwired nibbler controller (e.g. a
        // Crawl/Bite/Climb clip that never got converted) surfaces in the log instead of silently no-oping.
        static readonly HashSet<string> s_WarnedMissingState = new HashSet<string>();

        enum NibblerState
        {
            Chase,
            Orbit,
            Windup,
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
        const float k_OrbitEnterRadius = 3.6f;
        const float k_OrbitExitRadius = 5.8f;

        Transform m_Player;
        readonly Animator m_Animator;
        readonly CharacterController m_Controller;
        readonly float m_Scale;
        Vector3 m_BaseScale = Vector3.one;
        Vector3 m_AppliedScale = Vector3.one;
        Transform m_VisualT;
        Transform m_LeftFoot;
        Transform m_RightFoot;
        readonly int m_Index;
        readonly float m_Seed;
        readonly float m_WeaveAmp;
        readonly float m_RunSpeedMul;
        readonly float m_SeparationMul;
        readonly float m_OrbitDir;
        readonly float m_OrbitDistance;
        readonly float m_Reactiveness;
        readonly string m_PrimaryMoveClip;
        readonly string m_SecondaryMoveClip;
        string m_CurrentMoveClip;
        string m_ClingClip;
        NibblerState m_State;
        Vector3 m_Velocity;
        Vector3 m_LungeStart;
        Vector3 m_LungeTarget;
        Vector3 m_AttachBaseLocal;
        float m_AttachY;
        float m_AttachTargetY;
        float m_VisualGroundOffset;
        Transform m_NibblerRoot;        // the pool root we live under when free (not attached)
        int m_BoneSlot;                 // which player bone slot this nibbler clings to
        Transform m_AttachedParent;     // the player bone we're childed to (null when free)
        int m_AttachGen;                // player.VisualGeneration at attach (detects a re-rig/char switch)
        float m_StateTime;
        float m_OrbitDuration;
        float m_AvoidUntil;
        float m_AvoidSign;
        float m_StuckTimer;
        float m_NextMoveClipSwap;
        float m_LungeDuration;
        float m_JumpCooldown;
        float m_ClimbSpeed;
        float m_CrushSpin;
        float m_CrushDuration;
        float m_CrushSquash;
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
            m_WeaveAmp = Mathf.Lerp(0.18f, 0.68f, Hash01(index, 3.17f));
            m_RunSpeedMul = Mathf.Lerp(0.78f, 1.22f, Hash01(index, 7.91f));
            m_SeparationMul = Mathf.Lerp(0.78f, 1.35f, Hash01(index, 4.63f));
            m_OrbitDir = Hash01(index, 12.7f) < 0.5f ? -1f : 1f;
            m_OrbitDistance = Mathf.Lerp(1.75f, 2.75f, Hash01(index, 19.3f));
            m_Reactiveness = Mathf.Lerp(0.75f, 1.35f, Hash01(index, 31.1f));
            // Nibbler swarm = zombie body: ground locomotion is the zombie CRAWL; a 1-in-4 seed keeps a
            // little RUN variety so the swarm doesn't read as one looped clip. ATTACHED nibblers BITE
            // (the player's flesh) instead of the old player Attack/Hit. These names map to the nibbler
            // controller's distinct state set (Idle/Run/Crawl/Climb/Bite/Jump/Knockdown).
            m_PrimaryMoveClip = m_Seed < 0.68f ? "Crawl" : "Run";
            m_SecondaryMoveClip = m_PrimaryMoveClip == "Crawl" ? "Run" : "Crawl";
            m_CurrentMoveClip = m_PrimaryMoveClip;
            m_ClingClip = m_Seed < 0.24f ? "Climb" : "Bite";

            // Controller root stays UNSCALED; the character is a CHILD that we scale. This matches the
            // player (capsule in metres on a scale-1 transform + native-scaled visual child) and avoids
            // the tiny-lossyScale CharacterController.Move failure that made nibblers run in place. We
            // MULTIPLY the GLB's native import scale (~0.01) by 0.32 — never overwrite it with an absolute
            // 0.32 (which made them ~32x giant) — so a nibbler is a true fraction of the real human size.
            Root = new GameObject("Nibbler_" + index.ToString("00"));
            SetLayerRecursive(Root, LayerMask.NameToLayer("Ignore Raycast"));
            m_NibblerRoot = parent;
            Root.transform.SetParent(parent, false);
            GameObject visual = Object.Instantiate(prefab, Root.transform);
            SetLayerRecursive(visual, LayerMask.NameToLayer("Ignore Raycast"));
            visual.transform.localPosition = Vector3.zero;
            m_VisualT = visual.transform;
            m_LeftFoot = FindDeepChild(m_VisualT, "LeftFoot");
            m_RightFoot = FindDeepChild(m_VisualT, "RightFoot");
            m_BaseScale = m_VisualT.localScale;
            m_AppliedScale = m_BaseScale * scale;
            m_VisualT.localScale = m_AppliedScale;

            // Capsule in metres on the unscaled root: ~0.55m tall, sits ON the ground.
            m_Controller = Root.AddComponent<CharacterController>();
            m_Controller.height = 1.7f * scale;
            m_Controller.radius = 0.3f * scale;
            m_Controller.center = new Vector3(0f, 0.85f * scale, 0f);
            m_Controller.stepOffset = 0.15f * scale;
            m_Controller.slopeLimit = 55f;
            m_Controller.minMoveDistance = 0f;
            m_Controller.skinWidth = Mathf.Max(0.01f, m_Controller.radius * 0.2f);
            m_Controller.enableOverlapRecovery = true;

            Transform animatorRoot = ResolveAnimatorRoot(m_VisualT);
            m_Animator = animatorRoot.GetComponent<Animator>();
            if (m_Animator == null) m_Animator = animatorRoot.gameObject.AddComponent<Animator>();
            foreach (Animator childAnimator in Root.GetComponentsInChildren<Animator>(true))
            {
                if (childAnimator != m_Animator) childAnimator.enabled = false;
            }
            m_Animator.applyRootMotion = false;
            m_Animator.cullingMode = AnimatorCullingMode.CullUpdateTransforms; // don't animate the off-screen swarm
            m_Animator.speed = 0.78f + m_Seed * 0.62f;
            if (animatorController != null) m_Animator.runtimeAnimatorController = animatorController;

            WarnIfStateMissing("Crawl");
            WarnIfStateMissing("Bite");
            WarnIfStateMissing("Climb");

            Root.SetActive(false);
        }

        static Transform ResolveAnimatorRoot(Transform visualRoot)
        {
            // Clips are authored relative to the bone root (paths start at "Hips"; RetargetBindingPath
            // strips the "Armature/" prefix), so the Animator must sit on the node whose DIRECT child is
            // "Hips" — matching the build's FindAnimationBindingRoot. Re-exported rigs add an "Armature"
            // wrapper; the old "Armature" lookup returned its parent → clip paths didn't resolve → T-pose.
            Transform root = FindTransformWithDirectChild(visualRoot, "Hips");
            return root != null ? root : visualRoot;
        }

        static void SetLayerRecursive(GameObject root, int layer)
        {
            if (root == null || layer < 0) return;
            root.layer = layer;
            for (int i = 0; i < root.transform.childCount; i++)
            {
                SetLayerRecursive(root.transform.GetChild(i).gameObject, layer);
            }
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

        public void SetPlayer(Transform player)
        {
            // Character switch rebuilds the player's rig — drop off the old (now-dead) bones cleanly.
            if (m_AttachedParent != null && player != m_Player)
            {
                ReparentToWorld();
                Scatter(m_Player != null ? m_Player.position : Root.transform.position);
            }
            m_Player = player;
        }

        // Childed to a player bone -> back under the pool root at our current world pose, upright,
        // own scale restored, ready to resume ground AI. Every attach exit funnels through this.
        void ReparentToWorld()
        {
            if (m_AttachedParent == null) return;
            Vector3 worldPos = Root.transform.position;
            float yaw = Root.transform.eulerAngles.y;
            Root.transform.SetParent(m_NibblerRoot, true);
            Root.transform.position = worldPos;
            Root.transform.rotation = Quaternion.Euler(0f, yaw, 0f);
            Root.transform.localScale = Vector3.one; // undo the bone counter-scale
            m_VisualT.localScale = m_AppliedScale;
            m_AttachedParent = null;
        }

        public void Spawn(Vector3 position)
        {
            Active = true;
            Attached = false;
            if (!s_Active.Contains(this)) s_Active.Add(this);
            m_State = NibblerState.Chase;
            Root.SetActive(true);
            m_VisualT.localScale = m_AppliedScale;
            m_VisualGroundOffset = 0f;
            m_VisualT.localPosition = Vector3.zero;
            Root.transform.position = position;
            Root.transform.rotation = Quaternion.Euler(0f, Random.Range(0f, 360f), 0f);
            m_Controller.enabled = true;
            m_Velocity = Vector3.zero;
            m_StuckTimer = 0f;
            m_AvoidUntil = 0f;
            m_StateTime = 0f;
            m_JumpCooldown = 0.25f + m_Seed * 0.85f;
            Play(PickMoveClip(true), 0.08f);
        }

        public void Despawn()
        {
            ReparentToWorld();
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

            if (safe && m_State != NibblerState.Scatter && m_State != NibblerState.Crushed)
            {
                Scatter(player.FeetPosition);
            }

            switch (m_State)
            {
                case NibblerState.Windup:
                    return TickWindup(player, settings, dt);
                case NibblerState.Orbit:
                    TickOrbit(player, settings, dt, safe);
                    return false;
                case NibblerState.Lunge:
                    return TickLunge(player, settings, dt);
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
            float ringRadius = 0.15f + m_Seed * 0.35f; // small per-seed jitter; the doughnut emerges from separation
            // Aim at the player's torso (not the feet) so the swarm visibly climbs the body
            // instead of orbiting a point on the ground (which reads as "off the player").
            float aimY = player.BodyHeight * 0.5f;
            Vector3 ringTarget = player.FeetPosition + Vector3.up * aimY
                + new Vector3(Mathf.Cos(ringAngle), 0f, Mathf.Sin(ringAngle)) * ringRadius;

            Vector3 toPlayer = ringTarget - Root.transform.position;
            Vector3 planar = new Vector3(toPlayer.x, 0f, toPlayer.z);
            float dist = planar.magnitude;

            // Use the true player distance for the lunge/despawn gates, not the ring target.
            Vector3 toCenter = player.FeetPosition + Vector3.up * aimY - Root.transform.position;
            float centerDist = new Vector3(toCenter.x, 0f, toCenter.z).magnitude;

            if (!safe && centerDist < Mathf.Max(k_JumpRadius, settings.NibblerAttachDistance + k_AttachPad) && m_JumpCooldown <= 0f)
            {
                StartLunge(player, settings);
                return;
            }

            if (!safe
                && centerDist < k_OrbitEnterRadius
                && centerDist > settings.NibblerAttachDistance + k_AttachPad
                && m_JumpCooldown <= 0f
                && m_StateTime > 0.18f)
            {
                StartOrbit(player);
                return;
            }

            if (centerDist > 45f)
            {
                Despawn();
                return;
            }

            Vector3 dir = dist > 0.001f ? planar / dist : Vector3.zero;
            Vector3 side = Vector3.Cross(Vector3.up, dir);
            float weave = Mathf.Sin(Time.time * (2.4f + m_Seed * 2.6f) + m_Index * 0.73f) * m_WeaveAmp;
            Vector3 desired = (dir + side * weave).normalized;
            if (Time.time < m_AvoidUntil)
            {
                desired = (desired + side * m_AvoidSign * 1.25f).normalized;
            }
            else if (desired.sqrMagnitude > 0.001f && NeedsAvoidance(settings, desired))
            {
                BeginAvoidance();
                desired = (desired + side * m_AvoidSign * 1.35f).normalized;
            }
            // Gentle catch-up only: a small lead from far away so a runner isn't immortal, but
            // nowhere near the old 1.7x that made the swarm sprint through the camera and pin instantly.
            float lead = Mathf.Lerp(1.0f, 1.12f, Mathf.InverseLerp(k_JumpRadius, 14f, centerDist));
            float speed = settings.NibblerRunSpeed * m_RunSpeedMul * lead;
            // Separation is applied AFTER the seek (un-normalized) so a dense pile spreads into a
            // readable, aimable doughnut instead of collapsing onto one mushy point.
            Vector3 targetVelocity = desired * speed + ComputeSeparation() * (3.0f * m_SeparationMul);
            m_Velocity.x = Mathf.Lerp(m_Velocity.x, targetVelocity.x, 1f - Mathf.Exp(-10f * dt));
            m_Velocity.z = Mathf.Lerp(m_Velocity.z, targetVelocity.z, 1f - Mathf.Exp(-10f * dt));
            m_Velocity.y += settings.Gravity * dt;
            if (m_Velocity.y < settings.MaxFallSpeed) m_Velocity.y = settings.MaxFallSpeed;

            Vector3 before = Root.transform.position;
            CollisionFlags flags = m_Controller.Move(m_Velocity * dt);
            if ((flags & CollisionFlags.Below) != 0 && m_Velocity.y < 0f) m_Velocity.y = -1f;
            else if (m_Velocity.y <= 0f && SnapToLevelGround(settings)) flags |= CollisionFlags.Below;
            DetectStuckOrBlocked(flags, before, speed, dt);

            Vector3 facing = new Vector3(m_Velocity.x, 0f, m_Velocity.z);
            if (facing.sqrMagnitude > 0.02f)
            {
                Root.transform.rotation = Quaternion.Slerp(Root.transform.rotation, Quaternion.LookRotation(facing, Vector3.up), 1f - Mathf.Exp(-18f * dt));
            }

            StabilizeGrounding(settings, dt, (flags & CollisionFlags.Below) != 0);
            Play((flags & CollisionFlags.Below) == 0 && m_Velocity.y > 0.3f ? "Jump" : PickMoveClip(false), 0.1f);
        }

        Vector3 ComputeSeparation()
        {
            const float neighborRadius = 0.6f; // absolute spacing — wide enough to form a legible shape
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
                float w = 1f - sqr / sqrRadius;              // soft falloff: closer = stronger push
                push += (offset / Mathf.Sqrt(sqr)) * w;
            }
            return push; // NOT normalized — strength scales with how crowded it is here
        }

        void StartLunge(DaHilgActor player, DaHilgGameSettings settings)
        {
            // Enter a brief WIND-UP first: a readable squash tell the player can roll/strafe-juke
            // before the ballistic lunge actually fires.
            Attached = false;
            m_State = NibblerState.Windup;
            m_StateTime = 0f;
            ChooseAttachAnchor(player, settings);
            m_AttachY = k_ClingBottom;
            FaceBody(player, 1f);
            Play("Jump", 0.05f);
        }

        void StartOrbit(DaHilgActor player)
        {
            Attached = false;
            m_State = NibblerState.Orbit;
            m_StateTime = 0f;
            m_OrbitDuration = Mathf.Lerp(0.22f, 0.72f, Hash01(m_Index, Time.time * 0.37f + 5.1f));
            ChooseAttachAnchor(player, null);
            FaceBody(player, 1f);
            Play(PickMoveClip(true), 0.08f);
        }

        void TickOrbit(DaHilgActor player, DaHilgGameSettings settings, float dt, bool safe)
        {
            if (safe)
            {
                Scatter(player.FeetPosition);
                return;
            }

            Vector3 center = player.FeetPosition;
            Vector3 offset = Root.transform.position - center;
            offset.y = 0f;
            float dist = Mathf.Max(0.001f, offset.magnitude);
            Vector3 radial = offset / dist;
            Vector3 tangent = Vector3.Cross(Vector3.up, radial) * m_OrbitDir;
            float radialCorrection = Mathf.Clamp(dist - m_OrbitDistance, -1.2f, 1.2f);
            Vector3 desired = (tangent * (1.0f + m_Seed * 0.8f) - radial * radialCorrection * 0.95f).normalized;

            float speed = settings.NibblerRunSpeed * (0.72f + m_Seed * 0.32f);
            Vector3 targetVelocity = desired * speed + ComputeSeparation() * (2.2f * m_SeparationMul);
            m_Velocity.x = Mathf.Lerp(m_Velocity.x, targetVelocity.x, 1f - Mathf.Exp(-12f * dt));
            m_Velocity.z = Mathf.Lerp(m_Velocity.z, targetVelocity.z, 1f - Mathf.Exp(-12f * dt));
            m_Velocity.y += settings.Gravity * dt;
            if (m_Velocity.y < settings.MaxFallSpeed) m_Velocity.y = settings.MaxFallSpeed;

            CollisionFlags flags = m_Controller.Move(m_Velocity * dt);
            if ((flags & CollisionFlags.Below) != 0 && m_Velocity.y < 0f) m_Velocity.y = -1f;
            else if (m_Velocity.y <= 0f && SnapToLevelGround(settings)) flags |= CollisionFlags.Below;

            FaceBody(player, dt);
            StabilizeGrounding(settings, dt, (flags & CollisionFlags.Below) != 0);
            Play(PickMoveClip(false), 0.12f);

            Vector3 toPlayer = player.FeetPosition - Root.transform.position;
            toPlayer.y = 0f;
            float d = toPlayer.magnitude;
            if (m_StateTime >= m_OrbitDuration || d > k_OrbitExitRadius)
            {
                if (d <= k_OrbitExitRadius) StartLunge(player, settings);
                else
                {
                    m_State = NibblerState.Chase;
                    m_StateTime = 0f;
                    m_JumpCooldown = 0.22f + m_Seed * 0.35f;
                }
            }
        }

        bool TickWindup(DaHilgActor player, DaHilgGameSettings settings, float dt)
        {
            // Telegraph: squash/bulge so the commit is visible. Hold position (the controller stays
            // enabled but un-moved) so a kiting player can step out of the strike.
            float u = Mathf.Clamp01(m_StateTime / 0.18f);
            m_VisualT.localScale = m_AppliedScale * (1f + 0.15f * Mathf.Sin(u * Mathf.PI));
            FaceBody(player, dt);
            if (u >= 1f) BeginBallisticLunge(player);
            return false;
        }

        void BeginBallisticLunge(DaHilgActor player)
        {
            // Capture the strike point in WORLD space NOW — if the player dodges, we arc to empty air.
            m_State = NibblerState.Lunge;
            m_StateTime = 0f;
            m_LungeDuration = 0.30f + m_Seed * 0.12f;
            m_LungeStart = Root.transform.position;
            m_LungeTarget = m_Player.TransformPoint(new Vector3(m_AttachBaseLocal.x, m_AttachY, m_AttachBaseLocal.z));
            m_VisualT.localScale = m_AppliedScale;
            if (!m_Controller.enabled) m_Controller.enabled = true;
            Play("Jump", 0.04f);
        }

        bool TickLunge(DaHilgActor player, DaHilgGameSettings settings, float dt)
        {
            float u = Mathf.Clamp01(m_StateTime / Mathf.Max(0.05f, m_LungeDuration));
            // Ballistic arc toward the CAPTURED launch point (not homing). Move via the controller
            // so the lunge respects geometry.
            Vector3 desiredPos = Vector3.Lerp(m_LungeStart, m_LungeTarget, Smooth01(u)) + Vector3.up * Mathf.Sin(u * Mathf.PI) * k_LungeArc;
            if (m_Controller.enabled) m_Controller.Move(desiredPos - Root.transform.position);
            else Root.transform.position = desiredPos;
            FaceBody(player, dt);

            // Per-frame grab: if we actually reach the player's CURRENT body, latch on early.
            Vector3 toPlayer = player.FeetPosition + Vector3.up * (player.BodyHeight * 0.5f) - Root.transform.position;
            float planar = new Vector2(toPlayer.x, toPlayer.z).magnitude;
            if (planar <= settings.NibblerAttachDistance + k_AttachPad
                && Root.transform.position.y <= player.FeetPosition.y + player.BodyHeight + 0.2f)
            {
                if (m_Controller.enabled) m_Controller.enabled = false;
                AttachToBone(player); // the player becomes this nibbler's surface from here
                Attached = true;
                m_State = NibblerState.Climb;
                m_StateTime = 0f;
                Play("Climb", 0.08f);
                return true;
            }

            if (u >= 1f)
            {
                // WHIFF — the player juked out of the strike. Recover and chase again.
                m_State = NibblerState.Chase;
                m_StateTime = 0f;
                m_JumpCooldown = 0.6f + m_Seed * 0.3f;
                Play(PickMoveClip(true), 0.1f);
            }
            return false;
        }

        bool TickClimb(DaHilgActor player, DaHilgGameSettings settings, float dt)
        {
            if (m_AttachedParent == null) { m_State = NibblerState.Chase; return false; }
            DaHilgActor.BoneAnchor a = player.GetNibblerBone(m_BoneSlot);
            Vector3 rest = DaHilgActor.DivScale(a.LocalOffset, a.Bone.lossyScale);
            // Slide from the grab pose to the bone-local rest spot (the "climb on" settle), in bone space.
            Root.transform.localPosition = Vector3.MoveTowards(Root.transform.localPosition, rest, (m_ClimbSpeed + 0.6f) * dt);
            Root.transform.localRotation = Quaternion.Slerp(Root.transform.localRotation, ClingLocalRotation(player, m_AttachedParent), 1f - Mathf.Exp(-14f * dt));
            Play("Climb", 0.12f);
            if (Vector3.Distance(Root.transform.localPosition, rest) < 0.01f) { m_State = NibblerState.Attached; m_StateTime = 0f; }
            return true;
        }

        bool TickAttached(DaHilgActor player, DaHilgGameSettings settings, float dt)
        {
            // Childed to the bone -> Unity carries us with the animated body (move/fall/jump/bend/emote)
            // for free. Drop off cleanly if the rig was rebuilt (character switch) or the bone vanished.
            if (m_AttachedParent == null || player.VisualGeneration != m_AttachGen)
            {
                ReparentToWorld();
                Scatter(player.FeetPosition);
                return false;
            }
            DaHilgActor.BoneAnchor a = player.GetNibblerBone(m_BoneSlot);
            Vector3 rest = DaHilgActor.DivScale(a.LocalOffset, a.Bone.lossyScale);
            // Gravity-cling: a small "downward" (world) bias projected to bone-local so they hug the body
            // and a fast bend tugs them onto the surface instead of flinging them off.
            Vector3 gravLocal = m_AttachedParent.InverseTransformDirection(Vector3.down) * 0.01f;
            Vector3 bob = gravLocal * (0.5f + 0.5f * Mathf.Sin(Time.time * (3.2f + m_Seed) + m_Index));
            Root.transform.localPosition = Vector3.Lerp(Root.transform.localPosition, rest + bob, 1f - Mathf.Exp(-18f * dt));
            Root.transform.localRotation = Quaternion.Slerp(Root.transform.localRotation, ClingLocalRotation(player, m_AttachedParent), 1f - Mathf.Exp(-10f * dt));
            if (m_StateTime > 0.8f && Mathf.Sin(Time.time * (1.5f + m_Seed) + m_Index) > 0.82f)
            {
                m_ClingClip = m_ClingClip == "Bite" ? "Climb" : "Bite";
            }
            Play(m_ClingClip, 0.16f);
            return true;
        }

        // Child the nibbler to the chosen player BONE so the player becomes its surface: the animated
        // bone carries it through move/fall/jump/bend/emote for free. Counter the bone's world scale so
        // the nibbler keeps its own size (the load-bearing gotcha — bones live under the scaled visual).
        void AttachToBone(DaHilgActor player)
        {
            DaHilgActor.BoneAnchor a = player.GetNibblerBone(m_BoneSlot);
            m_AttachedParent = a.Bone;
            m_AttachGen = player.VisualGeneration;
            Root.transform.SetParent(a.Bone, true); // keep current world pose (no pop); slide in TickClimb
            Vector3 ls = a.Bone.lossyScale;
            Root.transform.localScale = new Vector3(1f / Mathf.Max(1e-4f, ls.x), 1f / Mathf.Max(1e-4f, ls.y), 1f / Mathf.Max(1e-4f, ls.z));
            m_VisualT.localScale = m_AppliedScale;
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
                // Brake the launch so the nibbler can settle briefly before resuming the chase.
                m_Velocity.x = Mathf.Lerp(m_Velocity.x, 0f, 1f - Mathf.Exp(-9f * dt));
                m_Velocity.z = Mathf.Lerp(m_Velocity.z, 0f, 1f - Mathf.Exp(-9f * dt));
                float settleHold = 0.55f + m_Seed * 0.45f;
                if (m_StateTime > 0.28f) Play("Idle", 0.18f);
                if (m_StateTime > 0.28f + settleHold)
                {
                    m_State = NibblerState.Chase;
                    m_StateTime = 0f;
                    m_JumpCooldown = 0.45f + m_Seed * 0.8f;
                    Play(PickMoveClip(true), 0.12f);
                }
            }
            else if (m_Velocity.y <= 0f)
            {
                SnapToLevelGround(settings);
            }
            StabilizeGrounding(settings, dt, grounded);

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
            ReparentToWorld(); // un-child from the player bone FIRST so ground AI resumes at our world pose
            m_VisualT.localScale = m_AppliedScale; // clear any Windup squash leak
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

        public bool TryCrushByRoll(DaHilgActor player, Vector3 crushCenter, float sideSign, float radius, bool omni, DaHilgGameSettings settings)
        {
            if (!Active || player == null || settings == null) return false;

            float side = sideSign >= 0f ? 1f : -1f;
            bool bodySideHit = false;
            if (Attached || m_State == NibblerState.Climb || m_State == NibblerState.Lunge)
            {
                float maxCrushY = Mathf.Min(player.BodyHeight, settings.RollCrushBodyHeight);
                if (omni)
                {
                    // Loaded: a 360 nova clears clingers on EVERY side, not just the roll side.
                    bodySideHit = m_AttachY <= maxCrushY;
                }
                else
                {
                    float anchorSide = m_AttachBaseLocal.x >= 0f ? 1f : -1f;
                    bodySideHit = Mathf.Approximately(anchorSide, side) && m_AttachY <= maxCrushY;
                }
            }

            Vector3 toCenter = Root.transform.position - crushCenter;
            float planarDistance = new Vector2(toCenter.x, toCenter.z).magnitude;
            bool groundHit = planarDistance <= radius
                && Root.transform.position.y <= crushCenter.y + Mathf.Max(0.45f, settings.RollCrushBodyHeight);

            if (!bodySideHit && !groundHit) return false;

            Crush(crushCenter, true);
            return true;
        }

        public bool CrushByMelee(Vector3 from)
        {
            if (!Active) return false;
            Crush(from, false);
            return true;
        }

        void Crush(Vector3 from, bool rolled)
        {
            ReparentToWorld(); // un-child from the player bone FIRST
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
            // Juicy launch + tumble so a hit reads as a reaction, not a quiet fade.
            float sideKick = rolled ? 5.2f : 8.0f;
            float upKick = rolled ? 2.2f : 4.4f;
            m_Velocity = away * (sideKick + m_Seed * 2.2f) + Vector3.up * (upKick + m_Seed * 1.2f);
            m_CrushSpin = (m_Seed < 0.5f ? -1f : 1f) * (rolled ? 720f : 1180f) * (0.75f + m_Seed * 0.55f);
            m_CrushDuration = rolled ? Random.Range(0.36f, 0.54f) : Random.Range(0.46f, 0.72f);
            m_CrushSquash = rolled ? 0.28f : 0.12f;
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

            // Pop/squash, then ease fully to 0 while tumbling. Roll hits flatten more;
            // melee hits fly longer and shrink after the airborne read.
            float dur = Mathf.Max(0.12f, m_CrushDuration);
            float u = Mathf.Clamp01(m_StateTime / dur);
            float pop = u < 0.18f ? Mathf.Lerp(1f, 1.26f, u / 0.18f) : Mathf.Lerp(1.26f, 0f, (u - 0.18f) / 0.82f);
            float squash = 1f - m_CrushSquash * Mathf.Sin(Mathf.Clamp01(u * 2f) * Mathf.PI);
            m_VisualT.localScale = new Vector3(
                m_AppliedScale.x * pop * (2f - squash),
                m_AppliedScale.y * pop * squash,
                m_AppliedScale.z * pop * (2f - squash));
            Root.transform.Rotate(Vector3.up, m_CrushSpin * dt, Space.World);
            if (m_StateTime > dur) Despawn();
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
            // Pick a distinct body BONE slot (live count so simultaneous lunges spread over the whole
            // body — back/head/shoulders/hips/legs/feet — not piled on the front face).
            int boneCount = Mathf.Max(1, player.NibblerBoneCount);
            m_BoneSlot = (CountAttachedSlots() * 5 + m_Index * 3) % boneCount;
            DaHilgActor.BoneAnchor a = player.GetNibblerBone(m_BoneSlot);
            // The lunge homes to this bone's CURRENT world spot, expressed in the player-root frame so
            // the existing ballistic-lunge math (BeginBallisticLunge/TickLunge) is unchanged.
            Vector3 boneWorld = a.Bone.TransformPoint(DaHilgActor.DivScale(a.LocalOffset, a.Bone.lossyScale));
            m_AttachBaseLocal = player.transform.InverseTransformPoint(boneWorld);
            m_AttachY = m_AttachBaseLocal.y;
            m_AttachTargetY = m_AttachBaseLocal.y;
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

        // While clinging, orient the nibbler FEET-TOWARD-BODY (its up/head points radially OUTWARD
        // from the player's vertical axis) so it grips the surface like a climbing creature — on the
        // back, chest, hip or leg alike — instead of snapping to the attach bone's arbitrary local
        // axis (which differs per bone on the Mixamo rig). Computed in WORLD, returned in the parent
        // bone's local space so it composes with the childed transform.
        Quaternion ClingLocalRotation(DaHilgActor player, Transform bone)
        {
            float h = Mathf.Clamp(Root.transform.position.y - player.FeetPosition.y, 0.1f, Mathf.Max(0.2f, player.BodyHeight));
            Vector3 axisPoint = player.FeetPosition + Vector3.up * h;
            Vector3 outward = Root.transform.position - axisPoint;
            outward.y *= 0.25f; // mostly horizontal — hug the roughly cylindrical torso
            if (outward.sqrMagnitude < 1e-4f) outward = -(Quaternion.Euler(0f, player.FacingYaw, 0f) * Vector3.forward);
            outward.Normalize();
            Vector3 forward = Vector3.Cross(outward, Vector3.up);
            if (forward.sqrMagnitude < 1e-4f) forward = Vector3.Cross(outward, Vector3.forward);
            forward.Normalize();
            Quaternion world = Quaternion.LookRotation(forward, outward); // up = outward => head out, feet on body
            return Quaternion.Inverse(bone.rotation) * world;
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

        string PickMoveClip(bool forceNew)
        {
            if (forceNew || Time.time >= m_NextMoveClipSwap)
            {
                m_CurrentMoveClip = Random.value < Mathf.Lerp(0.2f, 0.62f, m_Seed) ? m_SecondaryMoveClip : m_PrimaryMoveClip;
                m_NextMoveClipSwap = Time.time + Random.Range(1.3f, 4.2f);
            }
            return m_CurrentMoveClip;
        }

        void BeginAvoidance()
        {
            m_AvoidSign = Random.value < 0.5f ? -1f : 1f;
            m_AvoidUntil = Time.time + Random.Range(0.22f, 0.55f) * m_Reactiveness;
            m_StuckTimer = 0f;
        }

        bool NeedsAvoidance(DaHilgGameSettings settings, Vector3 desired)
        {
            if (settings == null || desired.sqrMagnitude < 0.001f) return false;
            Vector3 probe = Root.transform.position + desired.normalized * Mathf.Max(0.35f, m_Controller.radius * 2.6f);
            if (!DaHilgLevelRuntime.TryFindGround(probe, out RaycastHit hit, Mathf.Max(1.2f, settings.GroundProbeHeight), 8f, 1.2f)) return true;
            return hit.point.y - Root.transform.position.y > Mathf.Max(0.35f, settings.StepOffset * 0.9f);
        }

        void DetectStuckOrBlocked(CollisionFlags flags, Vector3 before, float desiredSpeed, float dt)
        {
            if ((flags & CollisionFlags.Sides) != 0)
            {
                BeginAvoidance();
                return;
            }

            Vector3 delta = Root.transform.position - before;
            delta.y = 0f;
            float actualSpeed = delta.magnitude / Mathf.Max(0.0001f, dt);
            if (desiredSpeed > 0.2f && actualSpeed < desiredSpeed * 0.18f) m_StuckTimer += dt;
            else m_StuckTimer = Mathf.Max(0f, m_StuckTimer - dt * 2f);

            if (m_StuckTimer > 0.26f / m_Reactiveness)
            {
                BeginAvoidance();
            }
        }

        void StabilizeGrounding(DaHilgGameSettings settings, float dt, bool grounded)
        {
            if (m_VisualT == null || m_LeftFoot == null || m_RightFoot == null || m_AttachedParent != null) return;
            if (!grounded)
            {
                m_VisualGroundOffset = Mathf.Lerp(m_VisualGroundOffset, 0f, 1f - Mathf.Exp(-14f * Mathf.Max(0f, dt)));
            }
            else
            {
                float minFootY = Mathf.Min(m_LeftFoot.position.y, m_RightFoot.position.y);
                float skin = settings != null ? Mathf.Max(0.008f, settings.GroundSkin * 0.22f) : 0.01f;
                float correction = Root.transform.position.y + skin - minFootY;
                m_VisualGroundOffset = Mathf.Clamp(m_VisualGroundOffset + correction, -0.18f, 0.18f);
            }

            Vector3 local = m_VisualT.localPosition;
            local.x = 0f;
            local.y = Mathf.Lerp(local.y, m_VisualGroundOffset, 1f - Mathf.Exp(-22f * Mathf.Max(0f, dt)));
            local.z = 0f;
            m_VisualT.localPosition = local;
        }

        static float Hash01(int index, float salt)
        {
            return Mathf.Repeat(Mathf.Sin((index + 1) * (12.9898f + salt)) * 43758.5453f, 1f);
        }

        void WarnIfStateMissing(string state)
        {
            if (m_Animator == null || m_Animator.runtimeAnimatorController == null) return;
            if (m_Animator.HasState(0, Animator.StringToHash("Base Layer." + state))) return;
            if (s_WarnedMissingState.Add(state))
            {
                Debug.LogWarning("[DaHilgNibblerAgent] Nibbler controller is missing state '" + state
                    + "' — that motion will no-op (check the nibbler animator / converted clip).");
            }
        }

        static float Smooth01(float t)
        {
            return t * t * (3f - 2f * t);
        }
    }
}
