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
        float m_IdleLookTime;

        public DaHilgActor Target
        {
            get => m_Target;
            set
            {
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
            }

            EnsureCinemachine();
            Mode = settings.DefaultCameraMode;
            CameraPreset preset = PresetFor(Mode, settings);
            Pitch = Mode == DaHilgCameraMode.High ? 42f : Mathf.Clamp(Pitch, preset.MinPitch, preset.MaxPitch);
            m_CurrentDistance = preset.Distance;
            m_CurrentShoulder = preset.ShoulderOffset;
            m_CurrentArm = preset.VerticalArm;
            ApplyPreset(preset, 0f);
        }

        void EnsureCinemachine()
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
            ConfigureCameraObstacleHandling();
#endif
        }

#if CINEMACHINE_PHYSICS
        void ConfigureCameraObstacleHandling()
        {
            if (m_VirtualCamera == null || m_ThirdPersonFollow == null) return;

            LayerMask defaultLayers = Physics.DefaultRaycastLayers;
            m_ThirdPersonFollow.AvoidObstacles = new CinemachineThirdPersonFollow.ObstacleSettings
            {
                Enabled = true,
                CollisionFilter = defaultLayers,
                IgnoreTag = "Player",
                CameraRadius = 0.32f,
                DampingIntoCollision = 0.05f,
                DampingFromCollision = 0.34f
            };

            m_Deoccluder = m_VirtualCamera.GetComponent<CinemachineDeoccluder>();
            if (m_Deoccluder == null) m_Deoccluder = m_VirtualCamera.gameObject.AddComponent<CinemachineDeoccluder>();
            m_Deoccluder.CollideAgainst = defaultLayers;
            m_Deoccluder.IgnoreTag = "Player";
            m_Deoccluder.MinimumDistanceFromTarget = 0.42f;
            m_Deoccluder.AvoidObstacles = new CinemachineDeoccluder.ObstacleAvoidance
            {
                Enabled = true,
                DistanceLimit = 0f,
                MinimumOcclusionTime = 0f,
                CameraRadius = 0.34f,
                Strategy = CinemachineDeoccluder.ObstacleAvoidance.ResolutionStrategy.PreserveCameraDistance,
                MaximumEffort = 5,
                SmoothingTime = 0.04f,
                Damping = 0.30f,
                DampingWhenOccluded = 0.08f,
                UseFollowTarget = new CinemachineDeoccluder.ObstacleAvoidance.FollowTargetSettings
                {
                    Enabled = true,
                    YOffset = 1.15f
                }
            };

            m_Decollider = m_VirtualCamera.GetComponent<CinemachineDecollider>();
            if (m_Decollider == null) m_Decollider = m_VirtualCamera.gameObject.AddComponent<CinemachineDecollider>();
            m_Decollider.CameraRadius = 0.30f;
            m_Decollider.Decollision = new CinemachineDecollider.DecollisionSettings
            {
                Enabled = true,
                ObstacleLayers = defaultLayers,
                Damping = 0.22f,
                SmoothingTime = 0.04f,
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
                Damping = 0.18f
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

            m_FollowTarget.SetPositionAndRotation(pivot, Quaternion.Euler(Pitch, Yaw, 0f));
            ApplyPreset(preset, dt);
        }

        void ApplyPreset(CameraPreset preset, float dt)
        {
            float k = dt <= 0f ? 1f : 1f - Mathf.Exp(-preset.ChangeSpeed * dt);
            m_CurrentDistance = Mathf.Lerp(m_CurrentDistance, preset.Distance, k);
            m_CurrentShoulder = Vector3.Lerp(m_CurrentShoulder, preset.ShoulderOffset, k);
            m_CurrentArm = Mathf.Lerp(m_CurrentArm, preset.VerticalArm, k);

            m_ThirdPersonFollow.CameraDistance = Mathf.Max(0.02f, m_CurrentDistance);
            m_ThirdPersonFollow.ShoulderOffset = m_CurrentShoulder;
            m_ThirdPersonFollow.VerticalArmLength = m_CurrentArm;
            m_ThirdPersonFollow.CameraSide = preset.CameraSide;
            m_ThirdPersonFollow.Damping = preset.Damping;
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
