using UnityEngine;

namespace DaHilg
{
    [RequireComponent(typeof(Camera))]
    public sealed class DaHilgCameraRig : MonoBehaviour
    {
        Camera m_Camera;
        Vector3 m_SmoothedLook;
        bool m_HasLook;
        float m_CurrentDistance;

        public DaHilgActor Target { get; set; }
        public DaHilgCameraMode Mode { get; private set; }
        public float Yaw { get; set; }
        public float Pitch { get; set; } = 12f;

        public void Initialize(DaHilgGameSettings settings)
        {
            m_Camera = GetComponent<Camera>();
            Mode = settings.DefaultCameraMode;
            m_CurrentDistance = settings.ThirdPersonDistance;
            if (m_Camera != null)
            {
                m_Camera.fieldOfView = 68f;
                m_Camera.nearClipPlane = 0.1f;
                m_Camera.farClipPlane = 600f;
            }
        }

        public void ToggleMode()
        {
            Mode = Mode == DaHilgCameraMode.ThirdPerson ? DaHilgCameraMode.FirstPerson : DaHilgCameraMode.ThirdPerson;
            m_HasLook = false;
        }

        public void AddLook(Vector2 delta, DaHilgGameSettings settings)
        {
            Yaw += delta.x;
            Pitch = Mathf.Clamp(Pitch - delta.y, -settings.PitchLimit, settings.PitchLimit);
        }

        public void Follow(DaHilgGameSettings settings, float dt)
        {
            if (Target == null) return;

            Vector3 feet = Target.FeetPosition;
            Quaternion lookRotation = Quaternion.Euler(Pitch, Yaw, 0f);
            Vector3 forward = lookRotation * Vector3.forward;

            if (Mode == DaHilgCameraMode.FirstPerson)
            {
                transform.SetPositionAndRotation(feet + Vector3.up * settings.EyeHeight + forward * 0.06f, lookRotation);
                m_HasLook = false;
                return;
            }

            Vector3 right = Quaternion.Euler(0f, Yaw, 0f) * Vector3.right;
            Vector3 pivot = feet + Vector3.up * settings.ThirdPersonPivotHeight + right * settings.ShoulderOffset.x;
            Vector3 look = pivot + Vector3.up * settings.ShoulderOffset.y;
            float wantedDistance = settings.ThirdPersonDistance;

            if (Physics.SphereCast(pivot, 0.18f, -forward, out RaycastHit hit, settings.ThirdPersonDistance, ~0, QueryTriggerInteraction.Ignore))
            {
                wantedDistance = Mathf.Max(settings.ThirdPersonMinDistance, hit.distance - 0.22f);
            }

            float distanceRate = wantedDistance < m_CurrentDistance ? 45f : 7f;
            m_CurrentDistance = Mathf.Lerp(m_CurrentDistance, wantedDistance, 1f - Mathf.Exp(-distanceRate * dt));

            Vector3 desired = pivot - forward * m_CurrentDistance;
            transform.position = Vector3.Lerp(transform.position, desired, 1f - Mathf.Exp(-settings.CameraSmooth * dt));

            if (!m_HasLook)
            {
                m_SmoothedLook = look;
                m_HasLook = true;
            }
            else
            {
                m_SmoothedLook = Vector3.Lerp(m_SmoothedLook, look, 1f - Mathf.Exp(-settings.LookSmooth * dt));
            }

            transform.rotation = Quaternion.LookRotation(m_SmoothedLook - transform.position, Vector3.up);
        }
    }
}
