using System.Collections.Generic;
using Unity.Cinemachine;
using UnityEngine;

namespace DaHilg
{
    [RequireComponent(typeof(Camera))]
    public sealed class DaHilgCameraRig : MonoBehaviour
    {
        [Tooltip("Rate at which yaw slowly recenters behind the player after look input goes idle (0 = off).")]
        [SerializeField] float m_RecenterRate = 2f;
        static readonly DaHilgCameraMode[] s_ModeCycle =
        {
            DaHilgCameraMode.ThirdPerson,
            DaHilgCameraMode.Shoulder,
            DaHilgCameraMode.High,
            DaHilgCameraMode.TopDown,
            DaHilgCameraMode.FirstPerson
        };

        Camera m_Camera;
        CinemachineBrain m_Brain;
        CinemachineCamera m_VirtualCamera;
        CinemachineThirdPersonFollow m_ThirdPersonFollow;
#if CINEMACHINE_PHYSICS
        CinemachineDeoccluder m_Deoccluder;
        CinemachineDecollider m_Decollider;
#endif
        Transform m_FollowTarget;
        DaHilgActor m_Target;
        float m_CurrentDistance;
        Vector3 m_CurrentShoulder;
        float m_CurrentArm;
        Vector3 m_LastPivot;
        Quaternion m_LastPivotRotation = Quaternion.identity;
        float m_IdleLookTime;
        float m_ShakeAmp;   // decaying positional shake (crush juice)
        float m_FovPunch;   // decaying FOV zoom-in punch (crush juice)
        readonly List<Renderer> m_VisualOcclusionCandidates = new List<Renderer>(256);
        readonly List<Renderer> m_HiddenVisualOccluders = new List<Renderer>(24);
        readonly HashSet<Renderer> m_NextHiddenVisualOccluders = new HashSet<Renderer>();
        float m_VisualOcclusionRefreshAt;
        float m_VisualOcclusionPollAt;
        const float k_BaseFov = 68f;
        const float k_VisualOcclusionRefreshInterval = 1.25f;
        const float k_VisualOcclusionPollInterval = 0.08f;
        const int k_MaxVisualOccludersHidden = 20;

        public DaHilgActor Target
        {
            get => m_Target;
            set
            {
                if (m_Target != value) RestoreVisualOccluders();
                m_Target = value;
                if (m_Target != null && m_FollowTarget != null)
                {
                    Vector3 pivot = m_Target.FeetPosition + Vector3.up * 1.5f;
                    m_FollowTarget.SetPositionAndRotation(pivot, Quaternion.Euler(Pitch, Yaw, 0f));
                    m_VirtualCamera?.OnTargetObjectWarped(m_FollowTarget, Vector3.zero);
                }
            }
        }

        public DaHilgCameraMode Mode { get; private set; }
        public float Yaw { get; set; }
        public float Pitch { get; set; } = 12f;

        // Force the camera to cut cleanly behind the target NOW. At spawn the deoccluder otherwise
        // resolves once while occluded (PullCameraForward pins it against a wall) and stays pinned until
        // the target moves — so the first second framed a wall. Invalidating the vcam state makes
        // Cinemachine re-resolve from scratch (no stale damping/occlusion carry-over).
        public void SnapToTarget()
        {
            if (m_Target == null || m_FollowTarget == null) return;
            CameraPreset preset = PresetFor(Mode, null);
            m_CurrentDistance = preset.Distance;
            Vector3 pivot = m_Target.FeetPosition + Vector3.up * preset.PivotHeight;
            m_FollowTarget.SetPositionAndRotation(pivot, Quaternion.Euler(Pitch, Yaw, 0f));
            if (m_VirtualCamera != null)
            {
                m_VirtualCamera.OnTargetObjectWarped(m_FollowTarget, Vector3.zero);
                m_VirtualCamera.PreviousStateIsValid = false;
            }
        }

        public void Initialize(DaHilgGameSettings settings)
        {
            m_Camera = GetComponent<Camera>();
            if (m_Camera != null)
            {
                m_Camera.clearFlags = CameraClearFlags.SolidColor;
                m_Camera.backgroundColor = new Color(0.47f, 0.66f, 0.84f, 1f);
                m_Camera.fieldOfView = 68f;
                m_Camera.nearClipPlane = 0.06f;
                m_Camera.farClipPlane = 650f;
                if (DaHilgGameManager.MobileWeb)
                {
                    // No FP16 HDR full-screen RT + no MSAA on phones — the single biggest iOS GPU saving.
                    m_Camera.allowHDR = false;
                    m_Camera.allowMSAA = false;
                }
            }

            EnsureCinemachine(settings);
            Mode = settings.DefaultCameraMode;
            CameraPreset preset = PresetFor(Mode, settings);
            Pitch = Mode == DaHilgCameraMode.High ? 42f : Mathf.Clamp(Pitch, preset.MinPitch, preset.MaxPitch);
            m_CurrentDistance = preset.Distance;
            m_CurrentShoulder = preset.ShoulderOffset;
            m_CurrentArm = preset.VerticalArm;
            ApplyPreset(preset, 0f);
        }

        void EnsureCinemachine(DaHilgGameSettings settings)
        {
            if (m_Camera == null) m_Camera = GetComponent<Camera>();
            m_Brain = GetComponent<CinemachineBrain>();
            if (m_Brain == null) m_Brain = gameObject.AddComponent<CinemachineBrain>();
            m_Brain.UpdateMethod = CinemachineBrain.UpdateMethods.SmartUpdate;
            m_Brain.BlendUpdateMethod = CinemachineBrain.BrainUpdateMethods.LateUpdate;
            m_Brain.DefaultBlend = new CinemachineBlendDefinition(CinemachineBlendDefinition.Styles.EaseInOut, 0.18f);

            if (m_FollowTarget == null)
            {
                GameObject target = new GameObject("DaHilg_CinemachineTarget");
                m_FollowTarget = target.transform;
            }

            if (m_VirtualCamera == null)
            {
                GameObject vcamObject = new GameObject("DaHilg_CinemachineCamera");
                m_VirtualCamera = vcamObject.AddComponent<CinemachineCamera>();
                m_VirtualCamera.Lens.FieldOfView = 68f;
                m_VirtualCamera.Lens.NearClipPlane = 0.06f;
                m_VirtualCamera.Lens.FarClipPlane = 650f;
            }

            m_VirtualCamera.Follow = m_FollowTarget;
            m_VirtualCamera.LookAt = m_FollowTarget;
            m_ThirdPersonFollow = m_VirtualCamera.GetComponent<CinemachineThirdPersonFollow>();
            if (m_ThirdPersonFollow == null) m_ThirdPersonFollow = m_VirtualCamera.gameObject.AddComponent<CinemachineThirdPersonFollow>();
#if CINEMACHINE_PHYSICS
            ConfigureCameraObstacleHandling(settings);
#endif
        }

#if CINEMACHINE_PHYSICS
        void ConfigureCameraObstacleHandling(DaHilgGameSettings settings)
        {
            if (m_VirtualCamera == null || m_ThirdPersonFollow == null) return;

            LayerMask defaultLayers = Physics.DefaultRaycastLayers;
            m_ThirdPersonFollow.AvoidObstacles = new CinemachineThirdPersonFollow.ObstacleSettings
            {
                Enabled = true,
                CollisionFilter = defaultLayers,
                IgnoreTag = "Player",
                CameraRadius = 0.26f,
                DampingIntoCollision = 0.03f,
                DampingFromCollision = 0.11f
            };

            m_Deoccluder = m_VirtualCamera.GetComponent<CinemachineDeoccluder>();
            if (m_Deoccluder == null) m_Deoccluder = m_VirtualCamera.gameObject.AddComponent<CinemachineDeoccluder>();
            m_Deoccluder.CollideAgainst = defaultLayers;
            m_Deoccluder.IgnoreTag = "Player";
            // In tight exterior gaps, forcing a large minimum distance leaves the camera on the wrong
            // side of a wall. Allow it to collapse almost to first-person until line of sight clears.
            float deocclusionMin = settings != null ? settings.ThirdPersonMinDistance * 0.28f : 0.18f;
            m_Deoccluder.MinimumDistanceFromTarget = Mathf.Clamp(deocclusionMin, 0.08f, 0.35f);
            m_Deoccluder.AvoidObstacles = new CinemachineDeoccluder.ObstacleAvoidance
            {
                Enabled = true,
                DistanceLimit = 0f,
                MinimumOcclusionTime = 0f,
                CameraRadius = 0.26f,
                // Pull the camera toward the player whenever anything occludes the view (instead of
                // orbiting to preserve distance, which jams/clips in tight rooms + near buildings).
                // Keeps the player visible in EVERY camera mode + level.
                Strategy = CinemachineDeoccluder.ObstacleAvoidance.ResolutionStrategy.PullCameraForward,
                MaximumEffort = 6,
                SmoothingTime = 0.02f,
                Damping = 0.12f,
                DampingWhenOccluded = 0.0f,
                UseFollowTarget = new CinemachineDeoccluder.ObstacleAvoidance.FollowTargetSettings
                {
                    Enabled = true,
                    YOffset = 1.15f
                }
            };

            m_Decollider = m_VirtualCamera.GetComponent<CinemachineDecollider>();
            if (m_Decollider == null) m_Decollider = m_VirtualCamera.gameObject.AddComponent<CinemachineDecollider>();
            m_Decollider.CameraRadius = 0.26f;
            m_Decollider.Decollision = new CinemachineDecollider.DecollisionSettings
            {
                Enabled = true,
                ObstacleLayers = defaultLayers,
                Damping = 0.1f,
                SmoothingTime = 0.02f,
                UseFollowTarget = new CinemachineDecollider.DecollisionSettings.FollowTargetSettings
                {
                    Enabled = true,
                    YOffset = 1.15f
                }
            };
            m_Decollider.TerrainResolution = new CinemachineDecollider.TerrainSettings
            {
                Enabled = true,
                TerrainLayers = defaultLayers,
                MaximumRaycast = 5f,
                Damping = 0.12f
            };
        }
#endif

        public void ToggleMode()
        {
            CycleMode();
        }

        public void CycleMode()
        {
            int index = 0;
            for (int i = 0; i < s_ModeCycle.Length; i++)
            {
                if (s_ModeCycle[i] == Mode)
                {
                    index = i;
                    break;
                }
            }

            SetMode(s_ModeCycle[(index + 1) % s_ModeCycle.Length]);
        }

        public void SetMode(DaHilgCameraMode mode)
        {
            Mode = mode;
            CameraPreset preset = PresetFor(Mode, null);
            Pitch = Mathf.Clamp(Pitch, preset.MinPitch, preset.MaxPitch);
        }

        public string ModeLabel()
        {
            switch (Mode)
            {
                case DaHilgCameraMode.Shoulder: return "CLOSE";
                case DaHilgCameraMode.High: return "HIGH";
                case DaHilgCameraMode.TopDown: return "TOP";
                case DaHilgCameraMode.FirstPerson: return "EYES";
                default: return "FOLLOW";
            }
        }

        public void AddLook(Vector2 delta, DaHilgGameSettings settings)
        {
            if (delta.sqrMagnitude > 0f) m_IdleLookTime = 0f;
            Yaw += delta.x;
            CameraPreset preset = PresetFor(Mode, settings);
            Pitch = Mathf.Clamp(Pitch - delta.y, preset.MinPitch, preset.MaxPitch);
        }

        // Crush juice: a one-shot additive screen shake + FOV punch that decay inside Follow().
        // Applied to the follow TARGET (upstream of the deoccluder) + the vcam lens, so it never
        // fights Cinemachine's transform resolution. No Time.timeScale.
        public void Punch(float shakeAmp, float fovPunch)
        {
            m_ShakeAmp = Mathf.Max(m_ShakeAmp, shakeAmp);
            if (Mode != DaHilgCameraMode.FirstPerson && Mode != DaHilgCameraMode.TopDown)
                m_FovPunch = Mathf.Max(m_FovPunch, fovPunch);
        }

        public void Follow(DaHilgGameSettings settings, float dt)
        {
            if (Target == null || m_FollowTarget == null || m_ThirdPersonFollow == null) return;

            CameraPreset preset = PresetFor(Mode, settings);
            Pitch = Mathf.Clamp(Pitch, preset.MinPitch, preset.MaxPitch);

            m_IdleLookTime += dt;
            bool recenterAllowed = m_RecenterRate > 0f
                && Mode != DaHilgCameraMode.FirstPerson
                && Mode != DaHilgCameraMode.Shoulder;
            if (recenterAllowed && m_IdleLookTime > 1f && Target.Speed > 0.5f)
            {
                Yaw = Mathf.LerpAngle(Yaw, Target.FacingYaw, 1f - Mathf.Exp(-m_RecenterRate * dt));
            }

            Vector3 pivot = Target.FeetPosition + Vector3.up * preset.PivotHeight;
            if (Mode == DaHilgCameraMode.FirstPerson)
            {
                Quaternion yawOnly = Quaternion.Euler(0f, Yaw, 0f);
                pivot = Target.FeetPosition + Vector3.up * preset.PivotHeight + yawOnly * Vector3.forward * 0.08f;
            }

            Vector3 shakeOffset = Vector3.zero;
            if (m_ShakeAmp > 0.0008f)
            {
                shakeOffset = new Vector3(Random.value - 0.5f, Random.value - 0.5f, Random.value - 0.5f) * m_ShakeAmp;
                m_ShakeAmp = Mathf.Lerp(m_ShakeAmp, 0f, 1f - Mathf.Exp(-16f * dt));
            }
            m_LastPivot = pivot;
            m_LastPivotRotation = Quaternion.Euler(Pitch, Yaw, 0f);
            m_FollowTarget.SetPositionAndRotation(pivot + shakeOffset, m_LastPivotRotation);
            ApplyPreset(preset, dt);

            if (m_VirtualCamera != null)
            {
                m_VirtualCamera.Lens.FieldOfView = k_BaseFov - m_FovPunch;
                if (m_FovPunch > 0.01f) m_FovPunch = Mathf.Lerp(m_FovPunch, 0f, 1f - Mathf.Exp(-9f * dt));
            }
        }

        void LateUpdate()
        {
            UpdateVisualDeocclusion(Time.unscaledTime);
        }

        void UpdateVisualDeocclusion(float now)
        {
            if (m_Camera == null || m_Target == null || Mode == DaHilgCameraMode.FirstPerson)
            {
                RestoreVisualOccluders();
                return;
            }

            if (now >= m_VisualOcclusionRefreshAt)
            {
                RefreshVisualOcclusionCandidates(now);
            }

            if (now < m_VisualOcclusionPollAt) return;
            m_VisualOcclusionPollAt = now + k_VisualOcclusionPollInterval;

            Vector3 cameraPos = m_Camera.transform.position;
            Vector3 targetPos = m_Target.FeetPosition + Vector3.up * 1.12f;
            Vector3 sight = targetPos - cameraPos;
            float distance = sight.magnitude;
            if (distance <= 0.2f)
            {
                RestoreVisualOccluders();
                return;
            }

            Ray sightRay = new Ray(cameraPos, sight / distance);
            m_NextHiddenVisualOccluders.Clear();
            int hiddenCount = 0;
            for (int i = 0; i < m_VisualOcclusionCandidates.Count; i++)
            {
                Renderer renderer = m_VisualOcclusionCandidates[i];
                if (renderer == null || !renderer.gameObject.activeInHierarchy) continue;
                if (!ShouldHideVisualOccluder(renderer, sightRay, cameraPos, targetPos, distance)) continue;

                m_NextHiddenVisualOccluders.Add(renderer);
                if (renderer.enabled) renderer.enabled = false;
                hiddenCount++;
                if (hiddenCount >= k_MaxVisualOccludersHidden) break;
            }

            for (int i = 0; i < m_HiddenVisualOccluders.Count; i++)
            {
                Renderer renderer = m_HiddenVisualOccluders[i];
                if (renderer != null && !m_NextHiddenVisualOccluders.Contains(renderer)) renderer.enabled = true;
            }

            m_HiddenVisualOccluders.Clear();
            foreach (Renderer renderer in m_NextHiddenVisualOccluders)
            {
                if (renderer != null) m_HiddenVisualOccluders.Add(renderer);
            }
        }

        void RefreshVisualOcclusionCandidates(float now)
        {
            m_VisualOcclusionRefreshAt = now + k_VisualOcclusionRefreshInterval;
            m_VisualOcclusionCandidates.Clear();

            Renderer[] renderers = FindObjectsByType<Renderer>(FindObjectsInactive.Exclude);
            for (int i = 0; i < renderers.Length; i++)
            {
                Renderer renderer = renderers[i];
                bool hiddenByCamera = m_HiddenVisualOccluders.Contains(renderer);
                if (renderer == null || (!renderer.enabled && !hiddenByCamera)) continue;
                if (!IsVisualOcclusionCandidate(renderer)) continue;
                m_VisualOcclusionCandidates.Add(renderer);
            }
        }

        static bool ShouldHideVisualOccluder(Renderer renderer, Ray sightRay, Vector3 cameraPos, Vector3 targetPos, float sightDistance)
        {
            Bounds bounds = renderer.bounds;
            bounds.Expand(0.75f);
            Vector3 size = bounds.size;
            if (!IsFinite(size.x) || !IsFinite(size.y) || !IsFinite(size.z)) return false;
            if (bounds.SqrDistance(targetPos) < 0.16f) return false;
            if (bounds.Contains(cameraPos)) return true;
            return bounds.IntersectRay(sightRay, out float hitDistance)
                && hitDistance > 0.08f
                && hitDistance < sightDistance - 0.22f;
        }

        static bool IsVisualOcclusionCandidate(Renderer renderer)
        {
            if (renderer == null || renderer is SkinnedMeshRenderer) return false;

            string name = renderer.name.ToLowerInvariant();
            if (name.StartsWith("collision_")
                || name.Contains("proceduralcreekwater")
                || name.Contains("pavedoverlay"))
            {
                return false;
            }

            bool relevantName = ContainsAny(name,
                "tree", "leaf", "leaves", "branch", "foliage", "bush", "shrub", "grass", "reed", "plant",
                "wall", "facade", "building", "house", "fence", "gate", "roof");
            if (!relevantName && renderer.transform.parent != null)
            {
                relevantName = ContainsAny(renderer.transform.parent.name.ToLowerInvariant(),
                    "tree", "leaf", "leaves", "branch", "foliage", "bush", "shrub", "grass", "reed", "plant",
                    "wall", "facade", "building", "house", "fence", "gate", "roof");
            }
            if (!relevantName && ContainsAny(name,
                "terrain", "ground", "road", "street", "drive", "walk", "sidewalk", "curb", "line",
                "water", "creek", "river", "pavedoverlay"))
            {
                return false;
            }

            Vector3 size = renderer.bounds.size;
            if (size.x < 0.2f || size.y < 0.2f) return false;
            return size.x <= 260f && size.y <= 180f && size.z <= 260f;
        }

        static bool IsFinite(float value)
        {
            return !float.IsNaN(value) && !float.IsInfinity(value);
        }

        static bool ContainsAny(string value, params string[] needles)
        {
            for (int i = 0; i < needles.Length; i++)
            {
                if (value.Contains(needles[i])) return true;
            }
            return false;
        }

        void RestoreVisualOccluders()
        {
            for (int i = 0; i < m_HiddenVisualOccluders.Count; i++)
            {
                Renderer renderer = m_HiddenVisualOccluders[i];
                if (renderer != null) renderer.enabled = true;
            }
            m_HiddenVisualOccluders.Clear();
            m_NextHiddenVisualOccluders.Clear();
        }

        void ApplyPreset(CameraPreset preset, float dt)
        {
            float k = dt <= 0f ? 1f : 1f - Mathf.Exp(-preset.ChangeSpeed * dt);
            float desiredDistance = ResolveObstacleDistance(preset);
            float lineOfSight01 = Mode == DaHilgCameraMode.FirstPerson || preset.Distance <= 0.1f
                ? 1f
                : Mathf.SmoothStep(0f, 1f, Mathf.InverseLerp(0.72f, preset.Distance, desiredDistance));
            Vector3 desiredShoulder = Vector3.Lerp(Vector3.zero, preset.ShoulderOffset, lineOfSight01);
            float desiredArm = Mathf.Lerp(0f, preset.VerticalArm, lineOfSight01);
            m_CurrentDistance = Mathf.Lerp(m_CurrentDistance, desiredDistance, k);
            m_CurrentShoulder = Vector3.Lerp(m_CurrentShoulder, desiredShoulder, k);
            m_CurrentArm = Mathf.Lerp(m_CurrentArm, desiredArm, k);

            m_ThirdPersonFollow.CameraDistance = Mathf.Max(0.02f, m_CurrentDistance);
            m_ThirdPersonFollow.ShoulderOffset = m_CurrentShoulder;
            m_ThirdPersonFollow.VerticalArmLength = m_CurrentArm;
            m_ThirdPersonFollow.CameraSide = preset.CameraSide;
            m_ThirdPersonFollow.Damping = preset.Damping;
#if CINEMACHINE_PHYSICS
            bool avoidObstacles = Mode != DaHilgCameraMode.FirstPerson;
            CinemachineThirdPersonFollow.ObstacleSettings followObstacles = m_ThirdPersonFollow.AvoidObstacles;
            followObstacles.Enabled = avoidObstacles;
            m_ThirdPersonFollow.AvoidObstacles = followObstacles;
            if (m_Deoccluder != null)
            {
                CinemachineDeoccluder.ObstacleAvoidance avoidance = m_Deoccluder.AvoidObstacles;
                avoidance.Enabled = avoidObstacles;
                m_Deoccluder.AvoidObstacles = avoidance;
            }
            if (m_Decollider != null)
            {
                CinemachineDecollider.DecollisionSettings decollision = m_Decollider.Decollision;
                decollision.Enabled = avoidObstacles;
                m_Decollider.Decollision = decollision;
            }
#endif
        }

        float ResolveObstacleDistance(CameraPreset preset)
        {
            if (Mode == DaHilgCameraMode.FirstPerson || m_FollowTarget == null || Target == null) return preset.Distance;

            Vector3 origin = m_LastPivot + Vector3.up * 0.15f;
            Vector3 localCamera = preset.ShoulderOffset + Vector3.up * preset.VerticalArm + Vector3.back * Mathf.Max(0.02f, preset.Distance);
            Vector3 desired = origin + m_LastPivotRotation * localCamera;
            Vector3 toCamera = desired - origin;
            float distance = toCamera.magnitude;
            if (distance <= 0.05f) return preset.Distance;

            if (!DaHilgLevelRuntime.SphereCastLevel(origin, 0.30f, toCamera / distance, out RaycastHit hit, distance)) return preset.Distance;

            // If the wall is very close to the player, a large "minimum distance" puts the camera on
            // the far side of that wall and fills the screen with geometry. Stay on the player side of
            // the hit instead; cramped spaces can go almost first-person until the line of sight clears.
            float nearSideDistance = Mathf.Max(0.05f, hit.distance - 0.30f);
            if (Mode == DaHilgCameraMode.TopDown) nearSideDistance = Mathf.Max(0.24f, hit.distance - 0.32f);
            return Mathf.Clamp(nearSideDistance, 0.05f, preset.Distance);
        }

        static CameraPreset PresetFor(DaHilgCameraMode mode, DaHilgGameSettings settings)
        {
            float thirdDistance = settings != null ? settings.ThirdPersonDistance : 3.8f;
            float pivotHeight = settings != null ? settings.ThirdPersonPivotHeight : 1.5f;
            float eyeHeight = settings != null ? settings.EyeHeight : 1.62f;
            Vector2 shoulder = settings != null ? settings.ShoulderOffset : new Vector2(0.55f, 0.06f);
            float pitchLimit = settings != null ? settings.PitchLimit : 68f;

            switch (mode)
            {
                case DaHilgCameraMode.Shoulder:
                    return new CameraPreset
                    {
                        PivotHeight = pivotHeight,
                        Distance = 2.45f,
                        ShoulderOffset = new Vector3(0.82f, shoulder.y, 0f),
                        VerticalArm = 0.18f,
                        CameraSide = 1f,
                        Damping = new Vector3(0.06f, 0.16f, 0.10f),
                        MinPitch = -24f,
                        MaxPitch = pitchLimit,
                        ChangeSpeed = 13f
                    };
                case DaHilgCameraMode.High:
                    return new CameraPreset
                    {
                        PivotHeight = pivotHeight + 0.55f,
                        Distance = Mathf.Max(6.2f, thirdDistance + 2.5f),
                        ShoulderOffset = new Vector3(0.12f, 0.42f, 0f),
                        VerticalArm = 0.36f,
                        CameraSide = 1f,
                        Damping = new Vector3(0.10f, 0.24f, 0.16f),
                        MinPitch = 34f,
                        MaxPitch = 70f,
                        ChangeSpeed = 10f
                    };
                case DaHilgCameraMode.TopDown:
                    return new CameraPreset
                    {
                        PivotHeight = pivotHeight + 0.75f,
                        Distance = 8.4f,
                        ShoulderOffset = Vector3.zero,
                        VerticalArm = 0f,
                        CameraSide = 0.5f,
                        Damping = new Vector3(0.08f, 0.18f, 0.10f),
                        MinPitch = 52f,
                        MaxPitch = 78f,
                        ChangeSpeed = 10f
                    };
                case DaHilgCameraMode.FirstPerson:
                    return new CameraPreset
                    {
                        PivotHeight = eyeHeight,
                        Distance = 0.05f,
                        ShoulderOffset = Vector3.zero,
                        VerticalArm = 0f,
                        CameraSide = 0.5f,
                        Damping = Vector3.zero,
                        MinPitch = -pitchLimit,
                        MaxPitch = pitchLimit,
                        ChangeSpeed = 22f
                    };
                default:
                    return new CameraPreset
                    {
                        PivotHeight = pivotHeight,
                        Distance = thirdDistance,
                        ShoulderOffset = new Vector3(shoulder.x, shoulder.y, 0f),
                        VerticalArm = 0.12f,
                        CameraSide = 1f,
                        Damping = new Vector3(0.08f, 0.22f, 0.14f),
                        MinPitch = -28f,
                        MaxPitch = pitchLimit,
                        ChangeSpeed = 12f
                    };
            }
        }

        struct CameraPreset
        {
            public float PivotHeight;
            public float Distance;
            public Vector3 ShoulderOffset;
            public float VerticalArm;
            public float CameraSide;
            public Vector3 Damping;
            public float MinPitch;
            public float MaxPitch;
            public float ChangeSpeed;
        }
    }
}
