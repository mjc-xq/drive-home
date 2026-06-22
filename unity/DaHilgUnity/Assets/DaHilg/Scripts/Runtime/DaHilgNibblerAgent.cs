using System.Collections.Generic;
using UnityEngine;

namespace DaHilg
{
    public sealed class DaHilgNibblerAgent
    {
        static readonly List<DaHilgNibblerAgent> s_Active = new List<DaHilgNibblerAgent>(32);

        enum NibblerState
        {
            Chase,
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

        Transform m_Player;
        readonly Animator m_Animator;
        readonly CharacterController m_Controller;
        readonly float m_Scale;
        Vector3 m_BaseScale = Vector3.one;
        Vector3 m_AppliedScale = Vector3.one;
        Transform m_VisualT;
        readonly int m_Index;
        readonly float m_Seed;
        readonly string m_RunClip;
        readonly string m_ClingClip;
        NibblerState m_State;
        Vector3 m_Velocity;
        Vector3 m_LungeStart;
        Vector3 m_LungeTarget;
        Vector3 m_AttachBaseLocal;
        float m_AttachY;
        float m_AttachTargetY;
        Transform m_NibblerRoot;        // the pool root we live under when free (not attached)
        int m_BoneSlot;                 // which player bone slot this nibbler clings to
        Transform m_AttachedParent;     // the player bone we're childed to (null when free)
        int m_AttachGen;                // player.VisualGeneration at attach (detects a re-rig/char switch)
        float m_StateTime;
        float m_LungeDuration;
        float m_JumpCooldown;
        float m_ClimbSpeed;
        float m_CrushSpin;
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
            m_Animator.speed = 0.86f + m_Seed * 0.46f;
            if (animatorController != null) m_Animator.runtimeAnimatorController = animatorController;

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

            if (safe && m_State != NibblerState.Scatter)
            {
                Scatter(player.FeetPosition);
            }

            switch (m_State)
            {
                case NibblerState.Windup:
                    return TickWindup(player, settings, dt);
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

            if (centerDist > 45f)
            {
                Despawn();
                return;
            }

            Vector3 dir = dist > 0.001f ? planar / dist : Vector3.zero;
            Vector3 side = Vector3.Cross(Vector3.up, dir);
            float weave = Mathf.Sin(Time.time * (2.8f + m_Seed * 1.8f) + m_Index * 0.73f) * 0.42f;
            Vector3 desired = (dir + side * weave).normalized;
            // Gentle catch-up only: a small lead from far away so a runner isn't immortal, but
            // nowhere near the old 1.7x that made the swarm sprint through the camera and pin instantly.
            float lead = Mathf.Lerp(1.0f, 1.12f, Mathf.InverseLerp(k_JumpRadius, 14f, centerDist));
            float speed = settings.NibblerRunSpeed * (0.82f + m_Seed * 0.36f) * lead;
            // Separation is applied AFTER the seek (un-normalized) so a dense pile spreads into a
            // readable, aimable doughnut instead of collapsing onto one mushy point.
            Vector3 targetVelocity = desired * speed + ComputeSeparation() * 3.0f;
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
                Play(m_RunClip, 0.1f);
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
            Root.transform.localRotation = Quaternion.Slerp(Root.transform.localRotation, Quaternion.identity, 1f - Mathf.Exp(-14f * dt));
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
            Root.transform.localRotation = Quaternion.Slerp(Root.transform.localRotation, Quaternion.identity, 1f - Mathf.Exp(-10f * dt));
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
            // Juicy launch + tumble so a crush reads as a satisfying pop, not a quiet fade.
            m_Velocity = away * (6.5f + m_Seed * 2.0f) + Vector3.up * (3.5f + m_Seed * 1.0f);
            m_CrushSpin = (m_Seed < 0.5f ? -1f : 1f) * (540f + m_Seed * 540f);
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

            // Pop: punch to 1.3x, then ease fully to 0 over ~0.30s while tumbling.
            float u = Mathf.Clamp01(m_StateTime / 0.30f);
            float pop = u < 0.12f ? Mathf.Lerp(1f, 1.3f, u / 0.12f) : Mathf.Lerp(1.3f, 0f, (u - 0.12f) / 0.88f);
            m_VisualT.localScale = m_AppliedScale * pop;
            Root.transform.Rotate(Vector3.up, m_CrushSpin * dt, Space.World);
            if (m_StateTime > 0.30f) Despawn();
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
            m_BoneSlot = CountAttachedSlots();
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
