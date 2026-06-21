using System;
using System.Collections.Generic;
using UnityEngine;

namespace DaHilg
{
    public sealed class DaHilgGameManager : MonoBehaviour
    {
        const float k_StartShieldSeconds = 3f;
        const float k_StuckTime = 0.6f;

        // Buried-TIME overwhelm: a tier-weighted load that builds while you're piled and bleeds
        // when light, so being swarmed is a felt 2-3s arc with a GUARANTEED thrash-out — never a
        // frame-perfect freeze. Replaces the old instantaneous attached-count cliffs.
        const float k_BuriedFallT = 2.6f;  // crawl-only gate
        const float k_BuriedStopT = 5.6f;  // pinned (heavy trudge) gate
        const float k_BuriedMax = 7.2f;    // meter ceiling
        float m_BuriedLoad;
        float m_Struggle;

        // True when the page loaded the mobile path (touch device -> forced ?level=house). Available
        // eagerly (before SetWebTouchMode arrives) so graphics downgrades apply before the first frame.
        public static bool MobileWeb => Application.absoluteURL != null && Application.absoluteURL.Contains("level=house");

        readonly List<DaHilgActor> m_Actors = new List<DaHilgActor>(4);
        readonly List<DaHilgNibblerAgent> m_Nibblers = new List<DaHilgNibblerAgent>(32);
        readonly List<DaHilgAnimalAgent> m_Animals = new List<DaHilgAnimalAgent>(8);
        readonly string[] m_Emotes = { "Dance", "Wave", "Cheer", "Attack" };
        readonly Dictionary<DaHilgActor, NpcStuckState> m_StuckStates = new Dictionary<DaHilgActor, NpcStuckState>();

        Transform m_LevelRoot;
        bool m_LevelLoading;
        Transform m_NibblerRoot;
        Transform m_AnimalRoot;
        DaHilgActor m_ActiveActor;
        DaHilgActor m_NearbyGreetable;
        DaHilgLevelProfile m_CurrentLevel;
        float m_ModeStartedAt;
        float m_NextNibblerSpawn;
        float m_MarkedUntil;
        float m_AttachFlashUntil;
        float m_LastRollAt = -999f;
        float m_PendingMeleeHitAt = -1f;
        int m_LastAttachedCount;
        int m_LastRollCrushCount;
        int m_CrushedNibblerTotal;
        bool m_Paused;
        bool m_Won;

        public DaHilgGameSettings Settings;
        public DaHilgInputRouter Input;
        public DaHilgCameraRig CameraRig;
        public DaHilgHud Hud;
        public DaHilgGameMode Mode { get; private set; }
        public int Score { get; private set; } // at-risk score this sortie (banked at safe zones)
        int m_Banked;
        int m_HighScore;
        float m_Combo = 1f;
        float m_ComboUntil;
        bool m_WasInSafe;
        float m_SafeBannerUntil;
        int m_LastBank;
        public int Banked => m_Banked;
        public int HighScore => m_HighScore;
        public float ComboMultiplier => Time.time < m_ComboUntil ? m_Combo : 1f;
        public bool ShowSafeBanner => Time.time < m_SafeBannerUntil;
        public int LastBank => m_LastBank;
        public IReadOnlyList<DaHilgActor> Actors => m_Actors;
        public IReadOnlyList<DaHilgNibblerAgent> Nibblers => m_Nibblers;
        public IReadOnlyList<DaHilgAnimalAgent> Animals => m_Animals;
        public DaHilgActor ActiveActor => m_ActiveActor;
        public DaHilgLevelProfile CurrentLevel => m_CurrentLevel;
        public DaHilgActor NearbyGreetable => m_NearbyGreetable;
        public int AttachedNibblerCount { get; private set; }
        public bool PlayerMarked => Mode == DaHilgGameMode.Nibblers && Time.time < m_MarkedUntil;
        public float Marked01 => Settings != null ? Mathf.Clamp01((m_MarkedUntil - Time.time) / Mathf.Max(0.1f, Settings.MarkedDuration)) : 0f;
        // 0..1 toward a full pin — the HUD's headline "buried" gauge binds to this.
        public float BuriedLoad01 => Mathf.Clamp01(m_BuriedLoad / k_BuriedStopT);
        public float AttachmentFlash01 => Settings != null ? Mathf.Clamp01((m_AttachFlashUntil - Time.time) / Mathf.Max(0.1f, Settings.AttachmentFlashDuration)) : 0f;
        public bool RollReady => m_ActiveActor == null || m_ActiveActor.RollReady(Time.time);
        public float RollCooldownRemaining => m_ActiveActor != null ? m_ActiveActor.RollCooldownRemaining(Time.time) : 0f;
        public float RollCooldown01 => Settings != null ? Mathf.Clamp01(1f - RollCooldownRemaining / Mathf.Max(0.1f, Settings.RollCooldown)) : 1f;
        public int LastRollCrushCount => Time.time - m_LastRollAt <= 1.25f ? m_LastRollCrushCount : 0;
        public int CrushedNibblerTotal => m_CrushedNibblerTotal;
        bool StartShieldActive => Mode == DaHilgGameMode.Nibblers && Time.time - m_ModeStartedAt < k_StartShieldSeconds;

        void Awake()
        {
            if (Input == null) Input = GetComponent<DaHilgInputRouter>();
            if (Input == null) Input = gameObject.AddComponent<DaHilgInputRouter>();
        }

        void Start()
        {
            m_HighScore = PlayerPrefs.GetInt("DaHilgHighScore", 0);
            if (MobileWeb) QualitySettings.globalTextureMipmapLimit = 1; // half texture VRAM on phones
            if (Settings == null)
            {
                Debug.LogError("[DaHilg] Missing game settings.");
                enabled = false;
                return;
            }

            if (CameraRig == null) CameraRig = Camera.main != null ? Camera.main.GetComponent<DaHilgCameraRig>() : null;
            if (CameraRig != null) CameraRig.Initialize(Settings);

            Mode = Settings.DefaultMode;
            m_ModeStartedAt = Time.time;
            Cursor.lockState = CursorLockMode.None;
            Cursor.visible = true;
            Debug.Log("[DaHilg] Runtime start.");
            BeginLoadLevel(ResolveLevelSlug(), () =>
            {
                SpawnActors();
                SwitchTo(Settings.DefaultCharacterId);
                BuildNibblerPool();
                SpawnAnimals();
                Debug.Log("[DaHilg] Runtime ready: level=" + (m_CurrentLevel != null ? m_CurrentLevel.Slug : "none")
                    + ", actors=" + m_Actors.Count
                    + ", active=" + (m_ActiveActor != null ? m_ActiveActor.Id : "none")
                    + ", hud=" + (Hud != null));
            });

            if (Hud != null) Hud.Initialize(this, Input);
        }

        void Update()
        {
            // A streamed (outdoor) level loads asynchronously via glTFast; hold gameplay until the
            // level root + actors exist so nothing falls through a not-yet-loaded ground.
            if (m_LevelLoading)
            {
                Hud?.Refresh();
                return;
            }

            float dt = Mathf.Min(Time.deltaTime, 1f / 30f);
            Input.Tick(Settings);
            bool menuConsumedInput = Hud != null && Hud.TickMenuInput(Input);

            if (Input.PausePressed)
            {
                m_Paused = !m_Paused;
                Cursor.lockState = CursorLockMode.None;
                Cursor.visible = true;
            }

            if (m_Paused)
            {
                Hud?.Refresh();
                return;
            }

            CameraRig?.AddLook(Input.LookDelta, Settings);

            if (Input.CameraPressed) CameraRig?.CycleMode();
            if (Input.ToggleModePressed) ToggleMode();
            if (Input.SwitchPressed) CycleActor(1);
            if (Input.PreviousSwitchPressed) CycleActor(-1);
            if (Input.EmotePressed >= 0 && Input.EmotePressed < m_Emotes.Length) m_ActiveActor?.PlayEmote(m_Emotes[Input.EmotePressed], true);
            if (!menuConsumedInput && Input.RollPressed) TryFallRoll();
            if (!menuConsumedInput && Input.AttackPressed) TryMelee();
            if (m_PendingMeleeHitAt >= 0f && Time.time >= m_PendingMeleeHitAt)
            {
                DoMeleeHits();
                m_PendingMeleeHitAt = -1f;
            }

            UpdateBuriedLoad(dt);
            bool crawlOnly = Mode == DaHilgGameMode.Nibblers && m_BuriedLoad >= k_BuriedFallT;
            bool pinned = Mode == DaHilgGameMode.Nibblers && m_BuriedLoad >= k_BuriedStopT;
            if (m_ActiveActor != null)
            {
                m_ActiveActor.StepPlayer(Input.Move, Input.RunHeld, !menuConsumedInput && Input.JumpPressed, CameraRig != null ? CameraRig.Yaw : 0f, Settings, dt, Time.time, crawlOnly, pinned);
                m_ActiveActor.TickHitMotion(dt, Time.time);
            }

            for (int i = 0; i < m_Actors.Count; i++)
            {
                DaHilgActor actor = m_Actors[i];
                if (actor == m_ActiveActor) continue;
                TickNpc(actor, dt);
                actor.TickHitMotion(dt, Time.time);
            }
            for (int i = 0; i < m_Animals.Count; i++) m_Animals[i].Tick(dt);

            ClampToLevelBounds();

            if (Mode == DaHilgGameMode.Nibblers) TickNibblers(dt);
            else TickGreetMode(menuConsumedInput);

            Hud?.Refresh();
        }

        void LateUpdate()
        {
            CameraRig?.Follow(Settings, Mathf.Min(Time.deltaTime, 1f / 30f));
        }

        public void SwitchTo(string actorId)
        {
            if (string.IsNullOrEmpty(actorId)) return;

            DaHilgActor next = m_Actors.Find(a => a.Id == actorId);
            if (next == null || next == m_ActiveActor) return;

            if (m_ActiveActor != null) m_ActiveActor.SetRole(DaHilgActorRole.Npc, Time.time);
            m_ActiveActor = next;
            m_ActiveActor.SetRole(DaHilgActorRole.Player, Time.time);
            if (CameraRig != null)
            {
                CameraRig.Target = m_ActiveActor;
                CameraRig.Yaw = m_ActiveActor.FacingYaw;
            }
            for (int i = 0; i < m_Nibblers.Count; i++) m_Nibblers[i].SetPlayer(m_ActiveActor.transform);
        }

        public void CycleActor(int direction)
        {
            if (m_Actors.Count == 0 || m_ActiveActor == null) return;
            int index = m_Actors.IndexOf(m_ActiveActor);
            int next = (index + direction) % m_Actors.Count;
            if (next < 0) next += m_Actors.Count;
            SwitchTo(m_Actors[next].Id);
        }

        public void ToggleMode()
        {
            Mode = Mode == DaHilgGameMode.Greet ? DaHilgGameMode.Nibblers : DaHilgGameMode.Greet;
            m_ModeStartedAt = Time.time;
            m_NextNibblerSpawn = 0f;
            AttachedNibblerCount = 0;
            m_LastAttachedCount = 0;
            m_MarkedUntil = 0f;
            m_AttachFlashUntil = 0f;
            for (int i = 0; i < m_Nibblers.Count; i++) m_Nibblers[i].Despawn();
        }

        public void SetCameraMode(DaHilgCameraMode mode)
        {
            CameraRig?.SetMode(mode);
        }

        public void SetLevel(string slug)
        {
            if (Settings == null || Settings.FindLevel(slug) == null) return;
            if (m_CurrentLevel != null && m_CurrentLevel.Slug == slug) return;

            PlayerPrefs.SetString("dahilg:level", slug);
            PlayerPrefs.Save();

            // Bank any unbanked at-risk score before switching levels — don't destroy a run.
            if (Score > 0)
            {
                m_Banked += Score;
                if (m_Banked > m_HighScore)
                {
                    m_HighScore = m_Banked;
                    PlayerPrefs.SetInt("DaHilgHighScore", m_HighScore);
                    PlayerPrefs.Save();
                }
            }
            Score = 0;
            m_Combo = 1f; m_ComboUntil = 0f; m_WasInSafe = false;
            m_Won = false;
            AttachedNibblerCount = 0;
            m_ModeStartedAt = Time.time;
            m_NextNibblerSpawn = 0f;
            m_LastAttachedCount = 0;
            m_MarkedUntil = 0f;
            m_AttachFlashUntil = 0f;
            m_CrushedNibblerTotal = 0;
            for (int i = 0; i < m_Nibblers.Count; i++) m_Nibblers[i].Despawn();

            BeginLoadLevel(slug, () =>
            {
                SpawnActors();
                SwitchTo(Settings.DefaultCharacterId);
                BuildNibblerPool();
                SpawnAnimals();
                Hud?.Refresh();
            });
        }

        public void RequestGreet()
        {
            if (m_NearbyGreetable == null || m_ActiveActor == null) return;

            bool first = !m_NearbyGreetable.Greeted;
            m_NearbyGreetable.Greeted = true;
            m_NearbyGreetable.PlayEmote(first ? "Cheer" : "Wave", false, m_ActiveActor.FeetPosition);
            if (first) Score += 100;

            bool allGreeted = true;
            for (int i = 0; i < m_Actors.Count; i++)
            {
                if (m_Actors[i] != m_ActiveActor && !m_Actors[i].Greeted) allGreeted = false;
            }

            if (allGreeted)
            {
                m_Won = true;
            }
        }

        public bool PlayerInSafeZone()
        {
            if (m_ActiveActor == null || m_CurrentLevel == null) return false;
            DaHilgBoxZone[] zones = Mode == DaHilgGameMode.Nibblers ? m_CurrentLevel.NibblerSafeZones : m_CurrentLevel.GreetSafeZones;
            Vector3 p = m_ActiveActor.FeetPosition;
            for (int i = 0; i < zones.Length; i++)
            {
                if (zones[i].Contains(p)) return true;
            }
            return false;
        }

        public bool PlayerInDangerZone()
        {
            if (m_ActiveActor == null || m_CurrentLevel == null || m_CurrentLevel.DangerZones == null) return false;
            Vector3 p = m_ActiveActor.FeetPosition;
            for (int i = 0; i < m_CurrentLevel.DangerZones.Length; i++)
            {
                if (m_CurrentLevel.DangerZones[i].Contains(p)) return true;
            }
            return false;
        }

        public bool IsPaused() => m_Paused;
        public bool HasWon() => m_Won;

        // Loads a level then runs onComplete once its root + colliders exist. Outdoor levels are
        // streamed from StreamingAssets via glTFast (LevelPrefab is null for them, so they are NOT
        // baked into the WebGL data file) and resolve asynchronously; the small interior ('house')
        // stays baked and resolves synchronously. The post-load spawn sequence must run from
        // onComplete so it never executes before the ground colliders are ready.
        void BeginLoadLevel(string slug, Action onComplete)
        {
            m_CurrentLevel = Settings.FindLevel(slug);
            if (m_CurrentLevel == null)
            {
                Debug.LogError("[DaHilg] No level profile for '" + slug + "'.");
                onComplete?.Invoke();
                return;
            }

            if (m_LevelRoot != null) { Destroy(m_LevelRoot.gameObject); m_LevelRoot = null; }

            if (DaHilgLevelRuntime.IsStreamedLevel(slug))
            {
                m_LevelLoading = true;
                StartCoroutine(DaHilgLevelRuntime.LoadStreamedLevel(m_CurrentLevel, root =>
                {
                    m_LevelRoot = root != null ? root.transform : null;
                    m_LevelLoading = false;
                    Debug.Log("[DaHilg] Streamed level ready: " + m_CurrentLevel.Slug + " (root=" + (root != null) + ").");
                    onComplete?.Invoke();
                }));
                return;
            }

            // Baked interior level — synchronous instantiate.
            if (m_CurrentLevel.LevelPrefab == null)
            {
                Debug.LogError("[DaHilg] No baked level prefab available for '" + slug + "'.");
                onComplete?.Invoke();
                return;
            }
            GameObject level = Instantiate(m_CurrentLevel.LevelPrefab);
            level.name = "Level_" + m_CurrentLevel.Slug;
            DaHilgLevelRuntime.ApplyLevelOffset(level, m_CurrentLevel);
            m_LevelRoot = level.transform;
            DaHilgLevelRuntime.PrepareLevelColliders(level);
            Debug.Log("[DaHilg] Level loaded: " + m_CurrentLevel.Slug + ".");
            onComplete?.Invoke();
        }

        void SpawnActors()
        {
            for (int i = 0; i < m_Actors.Count; i++)
            {
                if (m_Actors[i] != null) Destroy(m_Actors[i].gameObject);
            }
            m_Actors.Clear();

            Vector3[] playerSpawns = m_CurrentLevel != null && m_CurrentLevel.PlayerSpawns.Length > 0 ? m_CurrentLevel.PlayerSpawns : new[] { Vector3.zero };
            Vector3[] npcSpawns = m_CurrentLevel != null ? m_CurrentLevel.NpcSpawns : Array.Empty<Vector3>();
            int npcIndex = 0;

            for (int i = 0; i < Settings.Characters.Length; i++)
            {
                DaHilgCharacterSlot slot = Settings.Characters[i];
                if (slot.Prefab == null) continue;

                GameObject root = new GameObject("Actor_" + slot.Label);
                try
                {
                    root.tag = "Player";
                }
                catch (UnityException)
                {
                    Debug.LogWarning("[DaHilg] Player tag is missing; camera obstacle ignores will fall back to layer filtering.");
                }
                root.transform.SetParent(transform);
                DaHilgActor actor = root.AddComponent<DaHilgActor>();
                actor.Initialize(slot, ResolveAnimator(slot), Settings);

                Vector3 spawn = slot.Id == Settings.DefaultCharacterId
                    ? playerSpawns[0]
                    : (npcIndex < npcSpawns.Length ? npcSpawns[npcIndex++] : playerSpawns[0] + UnityEngine.Random.insideUnitSphere * 6f);
                actor.Teleport(DaHilgLevelRuntime.GroundSpawn(spawn));
                actor.SetRole(DaHilgActorRole.Npc, Time.time);
                m_Actors.Add(actor);
            }
            Debug.Log("[DaHilg] Actors spawned: " + m_Actors.Count + ".");
        }

        void TickNpc(DaHilgActor actor, float dt)
        {
            if (m_ActiveActor == null) return;

            // Staggered NPCs play their hit animation and only take knockback motion
            // (applied separately via TickHitMotion); suppress wander/chase this frame.
            if (actor.Staggered(Time.time)) return;

            Vector3 toPlayer = m_ActiveActor.FeetPosition - actor.FeetPosition;
            toPlayer.y = 0f;
            float dist = toPlayer.magnitude;
            bool safe = PlayerInSafeZone();
            float now = Time.time;

            if (Mode == DaHilgGameMode.Nibblers)
            {
                if (safe)
                {
                    actor.StepNpc(Vector3.zero, false, Settings, dt, now);
                    return;
                }
                TickPesterNpc(actor, toPlayer, dist, dt);
                return;
            }

            if (safe && (actor.NpcState == DaHilgNpcState.Chase || actor.NpcState == DaHilgNpcState.Touch))
            {
                actor.NpcState = DaHilgNpcState.Retreat;
                actor.StateUntil = now + Settings.RetreatSeconds;
            }

            switch (actor.NpcState)
            {
                case DaHilgNpcState.Idle:
                    if (!safe && dist <= Settings.NoticeRadius)
                    {
                        actor.NpcState = DaHilgNpcState.Chase;
                        break;
                    }
                    if (now >= actor.StateUntil)
                    {
                        actor.WanderTarget = PickWander(actor.Home);
                        actor.NpcState = DaHilgNpcState.Wander;
                        actor.StateUntil = now + 7f;
                    }
                    actor.StepNpc(Vector3.zero, false, Settings, dt, now);
                    break;

                case DaHilgNpcState.Wander:
                    if (!safe && dist <= Settings.NoticeRadius)
                    {
                        actor.NpcState = DaHilgNpcState.Chase;
                        break;
                    }
                    Vector3 toWander = actor.WanderTarget - actor.FeetPosition;
                    toWander.y = 0f;
                    if (toWander.magnitude < 1.2f || now >= actor.StateUntil)
                    {
                        actor.NpcState = DaHilgNpcState.Idle;
                        actor.StateUntil = now + UnityEngine.Random.Range(1.5f, 4.5f);
                        actor.PlayEmote(UnityEngine.Random.value < 0.25f ? "Wave" : "Idle");
                    }
                    actor.StepNpc(toWander.normalized * 0.65f, false, Settings, dt, now);
                    break;

                case DaHilgNpcState.Chase:
                    if (safe || dist > Settings.NoticeRadius * 1.35f)
                    {
                        actor.NpcState = DaHilgNpcState.Retreat;
                        actor.StateUntil = now + Settings.RetreatSeconds;
                        break;
                    }
                    if (dist <= Settings.TouchDistance)
                    {
                        actor.NpcState = DaHilgNpcState.Touch;
                        actor.StateUntil = now + 0.6f;
                        actor.PlayEmote("Cheer", false, m_ActiveActor.FeetPosition);
                        break;
                    }
                    actor.StepNpc(SeekDirection(actor, toPlayer, true, 1f, dt), true, Settings, dt, now);
                    break;

                case DaHilgNpcState.Touch:
                    actor.StepNpc(Vector3.zero, false, Settings, dt, now);
                    if (now >= actor.StateUntil)
                    {
                        actor.NpcState = DaHilgNpcState.Retreat;
                        actor.StateUntil = now + Settings.RetreatSeconds;
                    }
                    break;

                case DaHilgNpcState.Retreat:
                    Vector3 away = actor.FeetPosition - m_ActiveActor.FeetPosition;
                    away.y = 0f;
                    actor.StepNpc(away.normalized, false, Settings, dt, now);
                    if (now >= actor.StateUntil)
                    {
                        actor.NpcState = DaHilgNpcState.Cooldown;
                        actor.StateUntil = now + Settings.CooldownSeconds;
                    }
                    break;

                default:
                    actor.StepNpc(Vector3.zero, false, Settings, dt, now);
                    if (now >= actor.StateUntil)
                    {
                        actor.NpcState = DaHilgNpcState.Idle;
                        actor.StateUntil = now + UnityEngine.Random.Range(1.5f, 4.5f);
                    }
                    break;
            }
        }

        void TickPesterNpc(DaHilgActor actor, Vector3 toPlayer, float dist, float dt)
        {
            float notice = actor.Id == "drew" ? 90f : 55f;
            float danceDist = actor.Id == "drew" ? 3.6f : 2.8f;
            if (dist > notice)
            {
                actor.StepNpc(SeekDirection(actor, toPlayer, false, 0.45f, dt), false, Settings, dt, Time.time);
                return;
            }

            if (dist <= danceDist)
            {
                actor.StepNpc(Vector3.zero, false, Settings, dt, Time.time);
                if (Time.time >= actor.StateUntil)
                {
                    actor.PlayEmote(actor.Id == "drew" && UnityEngine.Random.value < 0.5f ? "Dance" : "Cheer", false, m_ActiveActor.FeetPosition);
                    actor.StateUntil = Time.time + UnityEngine.Random.Range(1.8f, 3.0f);
                }
                return;
            }

            actor.StepNpc(SeekDirection(actor, toPlayer, true, 1f, dt), true, Settings, dt, Time.time);
        }

        sealed class NpcStuckState
        {
            public float StuckTimer;
            public float StuckSign;
        }

        // Stuck-escape: when an NPC wants to move but its realized speed has stalled
        // below desired for a while, it's wedged on a corner — rotate the heading 90°
        // for a brief burst to slide around it, then decay and re-aim at the real goal.
        // Ported from the web seek() in src/da-hilg/systems/npcAi.js.
        Vector3 SeekDirection(DaHilgActor actor, Vector3 desiredDirection, bool run, float frac, float dt)
        {
            desiredDirection.y = 0f;
            Vector3 dir = desiredDirection.sqrMagnitude > 1e-8f ? desiredDirection.normalized : Vector3.zero;

            if (!m_StuckStates.TryGetValue(actor, out NpcStuckState state))
            {
                state = new NpcStuckState();
                m_StuckStates[actor] = state;
            }

            bool wantsToMove = dir.sqrMagnitude > 1e-8f && frac > 0f;
            if (wantsToMove)
            {
                float cap = run ? Settings.RunSpeed : Settings.WalkSpeed;
                float desiredSpeed = cap * frac;
                if (actor.Speed < 0.3f * desiredSpeed) state.StuckTimer += dt;
                else state.StuckTimer = 0f;

                if (state.StuckTimer > k_StuckTime)
                {
                    if (state.StuckSign == 0f) state.StuckSign = UnityEngine.Random.value < 0.5f ? 1f : -1f;
                    Vector3 nudged = new Vector3(dir.z * state.StuckSign, 0f, -dir.x * state.StuckSign);
                    dir = nudged;
                    state.StuckTimer -= dt * 2f; // burst, then re-seek
                    if (state.StuckTimer <= 0f)
                    {
                        state.StuckTimer = 0f;
                        state.StuckSign = 0f; // pick a fresh side next time we wedge
                    }
                }
            }
            else
            {
                state.StuckTimer = 0f;
            }

            return dir * frac;
        }

        void TickGreetMode(bool menuConsumedInput)
        {
            m_NearbyGreetable = null;
            if (m_ActiveActor == null) return;

            float best = float.MaxValue;
            for (int i = 0; i < m_Actors.Count; i++)
            {
                DaHilgActor actor = m_Actors[i];
                if (actor == m_ActiveActor) continue;
                float d = Vector3.Distance(actor.FeetPosition, m_ActiveActor.FeetPosition);
                float score = d + (actor.Greeted ? 1000f : 0f);
                if (d <= Settings.GreetDistance && score < best)
                {
                    best = score;
                    m_NearbyGreetable = actor;
                }
            }

            if (!menuConsumedInput && Input.InteractPressed) RequestGreet();
        }

        void BuildNibblerPool()
        {
            if (m_NibblerRoot != null) Destroy(m_NibblerRoot.gameObject);
            m_NibblerRoot = new GameObject("Nibblers").transform;
            m_NibblerRoot.SetParent(transform);
            m_Nibblers.Clear();

            if (Settings.Characters.Length == 0 || m_ActiveActor == null) return;
            // On mobile cap the pool hard so phones don't instantiate 36 skinned-character clones
            // upfront and OOM iOS Safari. Desktop neighborhoods keep the full pool.
            int poolSize = MobileWeb ? Mathf.Min(Settings.NibblerPoolSize, 10) : Settings.NibblerPoolSize;
            for (int i = 0; i < poolSize; i++)
            {
                DaHilgCharacterSlot slot = Settings.Characters[i % Settings.Characters.Length];
                if (slot.Prefab == null) continue;
                m_Nibblers.Add(new DaHilgNibblerAgent(slot.Prefab, m_NibblerRoot, m_ActiveActor.transform, ResolveAnimator(slot), Settings.NibblerScale, i));
            }
        }

        void SpawnAnimals()
        {
            if (m_AnimalRoot != null) Destroy(m_AnimalRoot.gameObject);
            m_AnimalRoot = new GameObject("Animals").transform;
            m_AnimalRoot.SetParent(transform);
            m_Animals.Clear();

            if (m_CurrentLevel == null || m_CurrentLevel.AnimalSpawns == null) return;

            for (int i = 0; i < m_CurrentLevel.AnimalSpawns.Length; i++)
            {
                DaHilgAnimalSpawn spawn = m_CurrentLevel.AnimalSpawns[i];
                if (spawn.Prefab == null || spawn.Count <= 0) continue;
                for (int n = 0; n < spawn.Count; n++)
                {
                    GameObject root = new GameObject("Animal_" + spawn.Label + "_" + n);
                    root.transform.SetParent(m_AnimalRoot);
                    DaHilgAnimalAgent agent = root.AddComponent<DaHilgAnimalAgent>();
                    DaHilgAnimalSpawn instance = spawn;
                    instance.Home += new Vector3(UnityEngine.Random.Range(-1.5f, 1.5f), 0f, UnityEngine.Random.Range(-1.2f, 1.2f));
                    agent.Initialize(instance, n);
                    m_Animals.Add(agent);
                }
            }
        }

        RuntimeAnimatorController ResolveAnimator(DaHilgCharacterSlot slot)
        {
            return slot.AnimatorController != null ? slot.AnimatorController : Settings.CharacterAnimator;
        }

        void TickNibblers(float dt)
        {
            bool safe = PlayerInSafeZone() || StartShieldActive;
            bool danger = !safe && PlayerInDangerZone();
            if (m_ActiveActor == null) return;

            // Bank the at-risk score the moment you reach safety — the "one more run" payoff.
            bool inSafeZone = PlayerInSafeZone();
            if (inSafeZone && !m_WasInSafe && Score > 0)
            {
                m_LastBank = Score;
                m_Banked += Score;
                Score = 0;
                m_Combo = 1f; m_ComboUntil = 0f;
                m_SafeBannerUntil = Time.time + 2.2f;
                if (m_Banked > m_HighScore)
                {
                    m_HighScore = m_Banked;
                    PlayerPrefs.SetInt("DaHilgHighScore", m_HighScore);
                    PlayerPrefs.Save();
                }
            }
            m_WasInSafe = inSafeZone;

            if (danger) MarkPlayer();

            if (safe)
            {
                if (StartShieldActive) m_MarkedUntil = 0f;
                m_NextNibblerSpawn = Mathf.Max(m_NextNibblerSpawn, Time.time + Settings.NormalSpawnInterval);
                m_ActiveActor.Health = Mathf.Min(100f, m_ActiveActor.Health + Settings.HealthRegen * dt);
            }
            else if (Time.time >= m_NextNibblerSpawn)
            {
                int baseTarget = Mathf.Clamp(8 + Mathf.FloorToInt((Time.time - m_ModeStartedAt) / 3f), 8, Settings.NibblerPoolSize);
                bool marked = danger || PlayerMarked;
                int target = Mathf.Clamp(baseTarget + (marked ? Settings.DangerNibblerBonus : 0), 8, Settings.NibblerPoolSize);
                int active = ActiveNibblerCount();
                int spawnBudget = Mathf.Min(marked ? 4 : 2, Mathf.Max(0, target - active));
                for (int i = 0; i < spawnBudget; i++)
                {
                    if (ActiveNibblerCount() >= target) break;
                    SpawnNibbler();
                }
                m_NextNibblerSpawn = Time.time + (marked ? Settings.DangerSpawnInterval : Settings.NormalSpawnInterval);
            }

            bool jumpHit = Input.JumpPressed || m_ActiveActor.WasJumpStartedThisFrame;
            if (m_BuriedLoad >= k_BuriedStopT)
            {
                // Pinned: a GUARANTEED thrash-out — auto-struggle plus mash-to-go-faster, so you
                // are never hard-locked. Each completed struggle flings a batch off and bleeds load.
                m_Struggle += dt * 0.85f + (jumpHit ? 0.5f : 0f);
                if (m_Struggle >= 1f)
                {
                    ShedAttached(5);
                    m_BuriedLoad = Mathf.Max(0f, m_BuriedLoad - 1.6f);
                    m_Struggle = 0f;
                    // The stake: clawing out of a pin costs unbanked score + breaks the combo.
                    Score = Mathf.Max(0, Score - 25);
                    m_Combo = 1f; m_ComboUntil = 0f;
                }
            }
            else
            {
                m_Struggle = 0f;
                if (jumpHit && AttachedNibblerCount > 0)
                {
                    // Jump is the radial PEEL: a heavy pile loses ~40% in one pop.
                    int shed = AttachedNibblerCount >= Settings.OverwhelmStagger
                        ? Mathf.Clamp(Mathf.RoundToInt(0.40f * AttachedNibblerCount), 1, AttachedNibblerCount)
                        : Mathf.Clamp(AttachedNibblerCount / 3, 1, AttachedNibblerCount);
                    ShedAttached(shed);
                }
            }

            int attached = 0;
            for (int i = 0; i < m_Nibblers.Count; i++)
            {
                if (m_Nibblers[i].Tick(m_ActiveActor, Settings, dt, safe)) attached++;
            }
            AttachedNibblerCount = attached;
            m_ActiveActor.AttachedNibblers = attached;
            if (attached > m_LastAttachedCount)
            {
                // Flash the new-attach cue, but DON'T re-mark — marking now only happens on
                // danger-zone entry, so "marked" stays a real spike instead of constant wallpaper.
                m_AttachFlashUntil = Time.time + Settings.AttachmentFlashDuration;
            }
            m_LastAttachedCount = attached;

            if (!safe && attached > 0)
            {
                float drain = Mathf.Min(Settings.NibblerHealthDrainCap, attached * Settings.NibblerHealthDrainPerAttached);
                m_ActiveActor.Health = Mathf.Max(0f, m_ActiveActor.Health - drain * dt);
            }
        }

        void TryFallRoll()
        {
            if (m_ActiveActor == null) return;
            if (!m_ActiveActor.StartFallRoll(Input.Move, CameraRig != null ? CameraRig.Yaw : 0f, Settings, Time.time)) return;

            m_LastRollAt = Time.time;
            m_LastRollCrushCount = Mode == DaHilgGameMode.Nibblers ? CrushNibblersByRoll() : 0;
            if (m_LastRollCrushCount > 0)
            {
                AwardCrush(m_LastRollCrushCount);
                CrushImpact(m_LastRollCrushCount);
                m_AttachFlashUntil = Time.time + Settings.AttachmentFlashDuration;
                AttachedNibblerCount = CountAttachedNibblers();
                m_ActiveActor.AttachedNibblers = AttachedNibblerCount;
                m_LastAttachedCount = AttachedNibblerCount;
            }
        }

        void TryMelee()
        {
            if (m_ActiveActor == null) return;
            if (m_ActiveActor.StartMelee(Time.time)) m_PendingMeleeHitAt = Time.time + 0.12f;
        }

        // Resolves a single melee swing: a short forward cone in front of the active actor.
        // Works in both modes — punches NPCs, crushes nibblers, knocks animals back.
        void DoMeleeHits()
        {
            DaHilgActor a = m_ActiveActor;
            if (a == null) return;

            Vector3 fwd = Quaternion.Euler(0f, a.FacingYaw, 0f) * Vector3.forward;
            float reach = a.BodyRadius + 1.8f;
            int hits = 0;

            for (int i = 0; i < m_Actors.Count; i++)
            {
                DaHilgActor target = m_Actors[i];
                if (target == a) continue;
                if (InMeleeCone(a.FeetPosition, fwd, reach, target.FeetPosition))
                {
                    target.TakeHit(a.FeetPosition, 20f, 6.5f, false, Time.time);
                    Score += 5;
                    hits++;
                }
            }

            int crushed = 0;
            for (int i = 0; i < m_Nibblers.Count; i++)
            {
                DaHilgNibblerAgent nibbler = m_Nibblers[i];
                if (!nibbler.Active) continue;
                if (!InMeleeCone(a.FeetPosition, fwd, reach, nibbler.Position)) continue;
                if (nibbler.CrushByMelee(a.FeetPosition))
                {
                    crushed++;
                    hits++;
                }
            }
            if (crushed > 0)
            {
                AwardCrush(crushed);
                CrushImpact(crushed);
                m_AttachFlashUntil = Time.time + Settings.AttachmentFlashDuration;
                AttachedNibblerCount = CountAttachedNibblers();
                m_ActiveActor.AttachedNibblers = AttachedNibblerCount;
                m_LastAttachedCount = AttachedNibblerCount;
            }

            for (int i = 0; i < m_Animals.Count; i++)
            {
                DaHilgAnimalAgent animal = m_Animals[i];
                if (!InMeleeCone(a.FeetPosition, fwd, reach, animal.Position)) continue;
                Vector3 away = animal.Position - a.FeetPosition;
                away.y = 0f;
                away = away.sqrMagnitude > 0.0001f ? away.normalized : fwd;
                animal.Teleport(DaHilgLevelRuntime.GroundSpawn(animal.Position + away * 2.5f));
                Score += 1;
                hits++;
            }
        }

        static bool InMeleeCone(Vector3 origin, Vector3 forward, float reach, Vector3 targetPos)
        {
            Vector3 to = targetPos - origin;
            to.y = 0f;
            float d = to.magnitude;
            if (d > reach || d <= 0.01f) return false;
            return Vector3.Dot(to / d, forward) >= 0.25f;
        }

        int CrushNibblersByRoll()
        {
            if (m_ActiveActor == null) return 0;
            // When you're loaded, the crush is an omnidirectional NOVA centered on the body so it
            // actually clears all sides; when light, it's the lopsided roll-side sweep.
            bool omni = AttachedNibblerCount >= Settings.OverwhelmStagger;
            Vector3 center = omni ? m_ActiveActor.FeetPosition + Vector3.up * 0.26f : m_ActiveActor.RollCrushCenter(Settings);
            float side = m_ActiveActor.RollSideSign;
            // A fatter pile pops a bigger ring (capped so some always survive the blast).
            float radius = Mathf.Min(2.2f, Settings.RollCrushRadius + 0.04f * AttachedNibblerCount);
            int crushed = 0;
            for (int i = 0; i < m_Nibblers.Count; i++)
            {
                if (m_Nibblers[i].TryCrushByRoll(m_ActiveActor, center, side, radius, omni, Settings)) crushed++;
            }
            return crushed;
        }

        // Crushes feed an at-risk score with a decaying combo on consecutive pops (banked at safe
        // zones). A fat clear (>=8) gets a flat bonus — no runaway multiplier that inverts the game.
        void AwardCrush(int count)
        {
            if (count <= 0) return;
            m_Combo = Time.time < m_ComboUntil ? Mathf.Min(5f, m_Combo + 0.5f) : 1f;
            m_ComboUntil = Time.time + 2.5f;
            Score += Mathf.RoundToInt(count * Mathf.Max(1, Settings.RollCrushScore) * m_Combo);
            if (count >= 8) Score += 50;
            m_CrushedNibblerTotal += count;
        }

        // Count-scaled crush firework: shake + FOV punch. A 12+ clear is a full-power finale.
        void CrushImpact(int count)
        {
            if (CameraRig == null || count <= 0) return;
            float power = Mathf.Clamp01(count / 12f);
            CameraRig.Punch(0.04f + 0.14f * power, 2f + 6f * power);
        }

        int CountAttachedNibblers()
        {
            int count = 0;
            for (int i = 0; i < m_Nibblers.Count; i++)
            {
                if (m_Nibblers[i].Active && m_Nibblers[i].Attached) count++;
            }
            return count;
        }

        void UpdateBuriedLoad(float dt)
        {
            // During mode/level start grace there's no pressure; otherwise build by tier and bleed
            // when light. tierMul: pinned-band fills fast, down-band steady, stagger-band slow rise.
            if (Mode != DaHilgGameMode.Nibblers || StartShieldActive) { m_BuriedLoad = 0f; m_Struggle = 0f; return; }
            int n = AttachedNibblerCount;
            float tierMul = n >= Settings.OverwhelmStop ? 2.2f
                          : n >= Settings.OverwhelmDown ? 1.0f
                          : n >= Settings.OverwhelmStagger ? 0.35f
                          : -1.8f;
            m_BuriedLoad = Mathf.Clamp(m_BuriedLoad + dt * tierMul, 0f, k_BuriedMax);
        }

        void ShedAttached(int count)
        {
            for (int i = 0; i < m_Nibblers.Count && count > 0; i++)
            {
                if (m_Nibblers[i].Active && m_Nibblers[i].Attached)
                {
                    m_Nibblers[i].Scatter(m_ActiveActor.FeetPosition);
                    count--;
                }
            }
        }

        void MarkPlayer()
        {
            m_MarkedUntil = Mathf.Max(m_MarkedUntil, Time.time + Settings.MarkedDuration);
        }

        void SpawnNibbler()
        {
            DaHilgNibblerAgent agent = null;
            for (int i = 0; i < m_Nibblers.Count; i++)
            {
                if (!m_Nibblers[i].Active)
                {
                    agent = m_Nibblers[i];
                    break;
                }
            }
            if (agent == null || m_ActiveActor == null) return;

            // Bias spawns AWAY from the camera line (the camera sits behind the player in 3rd-person):
            // prefer angles toward the player's front/sides so nibblers don't sprint THROUGH the
            // camera to reach the player (that read as a giant nibbler filling the lens).
            float angle = UnityEngine.Random.Range(0f, Mathf.PI * 2f);
            if (CameraRig != null && (CameraRig.Mode == DaHilgCameraMode.ThirdPerson
                || CameraRig.Mode == DaHilgCameraMode.Shoulder || CameraRig.Mode == DaHilgCameraMode.High))
            {
                Vector3 camForward = Quaternion.Euler(0f, CameraRig.Yaw, 0f) * Vector3.forward;
                for (int attempt = 0; attempt < 4; attempt++)
                {
                    Vector3 dir = new Vector3(Mathf.Cos(angle), 0f, Mathf.Sin(angle));
                    // Reject the rear cone (toward the camera); keep front/side spawns.
                    if (Vector3.Dot(dir, camForward) >= -0.35f) break;
                    angle = UnityEngine.Random.Range(0f, Mathf.PI * 2f);
                }
            }
            float radius = UnityEngine.Random.Range(Settings.NibblerSpawnMinRadius, Settings.NibblerSpawnMaxRadius);
            Vector3 pos = m_ActiveActor.FeetPosition + new Vector3(Mathf.Cos(angle) * radius, 0.8f, Mathf.Sin(angle) * radius);
            agent.Spawn(DaHilgLevelRuntime.GroundSpawn(pos));
        }

        int ActiveNibblerCount()
        {
            int count = 0;
            for (int i = 0; i < m_Nibblers.Count; i++)
            {
                if (m_Nibblers[i].Active) count++;
            }
            return count;
        }

        Vector3 PickWander(Vector3 home)
        {
            Vector2 r = UnityEngine.Random.insideUnitCircle * Settings.WanderRadius;
            Vector3 p = home + new Vector3(r.x, 0f, r.y);
            return DaHilgLevelRuntime.GroundSpawn(p);
        }

        void ClampToLevelBounds()
        {
            if (m_CurrentLevel == null || m_ActiveActor == null) return;
            Bounds b = m_CurrentLevel.PlayBounds;
            for (int i = 0; i < m_Actors.Count; i++)
            {
                DaHilgActor actor = m_Actors[i];
                if (actor == null) continue;
                Vector3 p = actor.FeetPosition;
                if (b.Contains(p)) continue;

                Vector3 clamped = b.ClosestPoint(p);
                clamped.y = Mathf.Max(clamped.y, 0.05f);
                actor.Teleport(DaHilgLevelRuntime.GroundSpawn(clamped));
            }
        }

        string ResolveLevelSlug()
        {
            string slug = Settings.DefaultLevelSlug;

            if (!string.IsNullOrEmpty(Application.absoluteURL))
            {
                Uri uri;
                if (Uri.TryCreate(Application.absoluteURL, UriKind.Absolute, out uri))
                {
                    string query = uri.Query;
                    const string key = "level=";
                    int index = query.IndexOf(key, StringComparison.OrdinalIgnoreCase);
                    if (index >= 0)
                    {
                        int start = index + key.Length;
                        int end = query.IndexOf('&', start);
                        slug = Uri.UnescapeDataString(end >= 0 ? query.Substring(start, end - start) : query.Substring(start));
                    }
                }
            }
            else if (PlayerPrefs.HasKey("dahilg:level"))
            {
                slug = PlayerPrefs.GetString("dahilg:level", slug);
            }

            return slug;
        }
    }
}
