using System;
using System.Collections.Generic;
using UnityEngine;

namespace DaHilg
{
    public sealed class DaHilgGameManager : MonoBehaviour
    {
        readonly List<DaHilgActor> m_Actors = new List<DaHilgActor>(4);
        readonly List<DaHilgNibblerAgent> m_Nibblers = new List<DaHilgNibblerAgent>(32);
        readonly string[] m_Emotes = { "Dance", "Wave", "Cheer", "Attack" };

        Transform m_LevelRoot;
        Transform m_NibblerRoot;
        DaHilgActor m_ActiveActor;
        DaHilgActor m_NearbyGreetable;
        DaHilgLevelProfile m_CurrentLevel;
        float m_ModeStartedAt;
        float m_NextNibblerSpawn;
        bool m_Paused;
        bool m_Won;

        public DaHilgGameSettings Settings;
        public DaHilgInputRouter Input;
        public DaHilgCameraRig CameraRig;
        public DaHilgHud Hud;
        public DaHilgGameMode Mode { get; private set; }
        public int Score { get; private set; }
        public IReadOnlyList<DaHilgActor> Actors => m_Actors;
        public DaHilgActor ActiveActor => m_ActiveActor;
        public DaHilgLevelProfile CurrentLevel => m_CurrentLevel;
        public DaHilgActor NearbyGreetable => m_NearbyGreetable;
        public int AttachedNibblerCount { get; private set; }

        void Awake()
        {
            if (Input == null) Input = GetComponent<DaHilgInputRouter>();
            if (Input == null) Input = gameObject.AddComponent<DaHilgInputRouter>();
        }

        void Start()
        {
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
            LoadLevel(ResolveLevelSlug());
            SpawnActors();
            SwitchTo(Settings.DefaultCharacterId);
            BuildNibblerPool();

            if (Hud != null) Hud.Initialize(this, Input);
        }

        void Update()
        {
            float dt = Mathf.Min(Time.deltaTime, 1f / 30f);
            Input.Tick(Settings);

            if (Input.PausePressed)
            {
                m_Paused = !m_Paused;
                Cursor.lockState = m_Paused ? CursorLockMode.None : Cursor.lockState;
                Cursor.visible = m_Paused;
            }

            if (m_Paused)
            {
                Hud?.Refresh();
                return;
            }

            CameraRig?.AddLook(Input.LookDelta, Settings);

            if (Input.CameraPressed) CameraRig?.ToggleMode();
            if (Input.ToggleModePressed) ToggleMode();
            if (Input.SwitchPressed) CycleActor(1);
            if (Input.PreviousSwitchPressed) CycleActor(-1);
            if (Input.EmotePressed >= 0 && Input.EmotePressed < m_Emotes.Length) m_ActiveActor?.PlayEmote(m_Emotes[Input.EmotePressed]);

            bool crawlOnly = Mode == DaHilgGameMode.Nibblers && AttachedNibblerCount >= Settings.OverwhelmDown;
            bool pinned = Mode == DaHilgGameMode.Nibblers && AttachedNibblerCount >= Settings.OverwhelmStop;
            if (m_ActiveActor != null)
            {
                m_ActiveActor.StepPlayer(Input.Move, Input.RunHeld, Input.JumpPressed, CameraRig != null ? CameraRig.Yaw : 0f, Settings, dt, Time.time, crawlOnly, pinned);
            }

            for (int i = 0; i < m_Actors.Count; i++)
            {
                DaHilgActor actor = m_Actors[i];
                if (actor == m_ActiveActor) continue;
                TickNpc(actor, dt);
            }

            ClampToLevelBounds();

            if (Mode == DaHilgGameMode.Nibblers) TickNibblers(dt);
            else TickGreetMode();

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
            for (int i = 0; i < m_Nibblers.Count; i++) m_Nibblers[i].Despawn();
        }

        public void RequestGreet()
        {
            if (m_NearbyGreetable == null || m_ActiveActor == null) return;

            bool first = !m_NearbyGreetable.Greeted;
            m_NearbyGreetable.Greeted = true;
            m_NearbyGreetable.PlayEmote(first ? "Cheer" : "Wave");
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

        public bool IsPaused() => m_Paused;
        public bool HasWon() => m_Won;

        void LoadLevel(string slug)
        {
            m_CurrentLevel = Settings.FindLevel(slug);
            if (m_CurrentLevel == null || m_CurrentLevel.LevelPrefab == null)
            {
                Debug.LogError("[DaHilg] No level prefab available.");
                return;
            }

            if (m_LevelRoot != null) Destroy(m_LevelRoot.gameObject);
            GameObject level = Instantiate(m_CurrentLevel.LevelPrefab);
            level.name = "Level_" + m_CurrentLevel.Slug;
            m_LevelRoot = level.transform;
            PrepareLevelColliders(level);
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
                root.transform.SetParent(transform);
                DaHilgActor actor = root.AddComponent<DaHilgActor>();
                actor.Initialize(slot, Settings.CharacterAnimator, Settings);

                Vector3 spawn = slot.Id == Settings.DefaultCharacterId
                    ? playerSpawns[0]
                    : (npcIndex < npcSpawns.Length ? npcSpawns[npcIndex++] : playerSpawns[0] + UnityEngine.Random.insideUnitSphere * 6f);
                spawn.y = Mathf.Max(spawn.y, 0.05f);
                actor.Teleport(spawn);
                actor.SetRole(DaHilgActorRole.Npc, Time.time);
                m_Actors.Add(actor);
            }
        }

        void TickNpc(DaHilgActor actor, float dt)
        {
            if (m_ActiveActor == null) return;

            Vector3 toPlayer = m_ActiveActor.FeetPosition - actor.FeetPosition;
            toPlayer.y = 0f;
            float dist = toPlayer.magnitude;
            bool safe = PlayerInSafeZone();
            float now = Time.time;

            if (Mode == DaHilgGameMode.Nibblers)
            {
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
                        actor.PlayEmote("Cheer");
                        break;
                    }
                    actor.StepNpc(toPlayer.normalized, true, Settings, dt, now);
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
                actor.StepNpc(toPlayer.normalized * 0.45f, false, Settings, dt, Time.time);
                return;
            }

            if (dist <= danceDist)
            {
                actor.StepNpc(Vector3.zero, false, Settings, dt, Time.time);
                if (Time.time >= actor.StateUntil)
                {
                    actor.PlayEmote(actor.Id == "drew" && UnityEngine.Random.value < 0.5f ? "Dance" : "Cheer");
                    actor.StateUntil = Time.time + UnityEngine.Random.Range(1.8f, 3.0f);
                }
                return;
            }

            actor.StepNpc(toPlayer.normalized, true, Settings, dt, Time.time);
        }

        void TickGreetMode()
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

            if (Input.InteractPressed) RequestGreet();
        }

        void BuildNibblerPool()
        {
            if (m_NibblerRoot != null) Destroy(m_NibblerRoot.gameObject);
            m_NibblerRoot = new GameObject("Nibblers").transform;
            m_NibblerRoot.SetParent(transform);
            m_Nibblers.Clear();

            if (Settings.Characters.Length == 0 || m_ActiveActor == null) return;
            for (int i = 0; i < Settings.NibblerPoolSize; i++)
            {
                DaHilgCharacterSlot slot = Settings.Characters[i % Settings.Characters.Length];
                if (slot.Prefab == null) continue;
                m_Nibblers.Add(new DaHilgNibblerAgent(slot.Prefab, m_NibblerRoot, m_ActiveActor.transform, Settings.CharacterAnimator, Settings.NibblerScale, i));
            }
        }

        void TickNibblers(float dt)
        {
            bool safe = PlayerInSafeZone();
            if (m_ActiveActor == null) return;

            if (safe)
            {
                m_ActiveActor.Health = Mathf.Min(100f, m_ActiveActor.Health + Settings.HealthRegen * dt);
            }
            else if (Time.time >= m_NextNibblerSpawn)
            {
                int target = Mathf.Clamp(2 + Mathf.FloorToInt((Time.time - m_ModeStartedAt) / 8f), 2, Settings.NibblerPoolSize);
                if (ActiveNibblerCount() < target) SpawnNibbler();
                m_NextNibblerSpawn = Time.time + 0.35f;
            }

            if (Input.JumpPressed || m_ActiveActor.WasJumpStartedThisFrame)
            {
                int shed = Mathf.Max(2, AttachedNibblerCount / 3);
                for (int i = 0; i < m_Nibblers.Count && shed > 0; i++)
                {
                    if (m_Nibblers[i].Active && m_Nibblers[i].Attached)
                    {
                        m_Nibblers[i].Scatter(m_ActiveActor.FeetPosition);
                        shed--;
                    }
                }
            }

            int attached = 0;
            for (int i = 0; i < m_Nibblers.Count; i++)
            {
                if (m_Nibblers[i].Tick(m_ActiveActor, Settings, dt, safe)) attached++;
            }
            AttachedNibblerCount = attached;
            m_ActiveActor.AttachedNibblers = attached;

            if (!safe && attached > 0)
            {
                float drain = Mathf.Min(Settings.NibblerHealthDrainCap, attached * Settings.NibblerHealthDrainPerAttached);
                m_ActiveActor.Health = Mathf.Max(0f, m_ActiveActor.Health - drain * dt);
            }
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

            float angle = UnityEngine.Random.Range(0f, Mathf.PI * 2f);
            float radius = UnityEngine.Random.Range(Settings.NibblerSpawnMinRadius, Settings.NibblerSpawnMaxRadius);
            Vector3 pos = m_ActiveActor.FeetPosition + new Vector3(Mathf.Cos(angle) * radius, 0.8f, Mathf.Sin(angle) * radius);
            if (Physics.Raycast(pos + Vector3.up * 20f, Vector3.down, out RaycastHit hit, 80f, ~0, QueryTriggerInteraction.Ignore))
            {
                pos = hit.point + Vector3.up * 0.05f;
            }
            agent.Spawn(pos);
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
            if (Physics.Raycast(p + Vector3.up * 30f, Vector3.down, out RaycastHit hit, 80f, ~0, QueryTriggerInteraction.Ignore))
            {
                p.y = hit.point.y + 0.05f;
            }
            return p;
        }

        void ClampToLevelBounds()
        {
            if (m_CurrentLevel == null || m_ActiveActor == null) return;
            Bounds b = m_CurrentLevel.PlayBounds;
            Vector3 p = m_ActiveActor.FeetPosition;
            if (b.Contains(p)) return;

            Vector3 clamped = b.ClosestPoint(p);
            clamped.y = Mathf.Max(clamped.y, 0.05f);
            m_ActiveActor.Teleport(clamped);
        }

        void PrepareLevelColliders(GameObject level)
        {
            MeshFilter[] filters = level.GetComponentsInChildren<MeshFilter>(true);
            for (int i = 0; i < filters.Length; i++)
            {
                MeshFilter filter = filters[i];
                if (filter.sharedMesh == null) continue;

                string lower = filter.name.ToLowerInvariant();
                bool isWater = lower.Contains("water") || lower.Contains("creek") || lower.Contains("river");
                if (!isWater && filter.GetComponent<Collider>() == null)
                {
                    MeshCollider collider = filter.gameObject.AddComponent<MeshCollider>();
                    collider.sharedMesh = filter.sharedMesh;
                    collider.convex = false;
                }

                if (isWater && filter.GetComponent<DaHilgWaterAnimator>() == null)
                {
                    filter.gameObject.AddComponent<DaHilgWaterAnimator>();
                }

                filter.gameObject.isStatic = true;
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
