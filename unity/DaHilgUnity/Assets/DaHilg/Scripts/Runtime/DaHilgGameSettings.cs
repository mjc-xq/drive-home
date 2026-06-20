using System;
using UnityEngine;

namespace DaHilg
{
    public enum DaHilgGameMode
    {
        Greet,
        Nibblers
    }

    public enum DaHilgCameraMode
    {
        ThirdPerson,
        FirstPerson
    }

    [Serializable]
    public struct DaHilgCharacterSlot
    {
        public string Id;
        public string Label;
        public string Blurb;
        public GameObject Prefab;
        public Color Accent;
        public float VisualYawOffset;
    }

    [Serializable]
    public struct DaHilgBoxZone
    {
        public string Id;
        public string Label;
        public Vector3 Center;
        public Vector3 Size;

        public bool Contains(Vector3 point)
        {
            Vector3 half = Size * 0.5f;
            return Mathf.Abs(point.x - Center.x) <= half.x
                && Mathf.Abs(point.y - Center.y) <= half.y
                && Mathf.Abs(point.z - Center.z) <= half.z;
        }
    }

    [CreateAssetMenu(menuName = "Da Hilg/Game Settings", fileName = "DaHilgGameSettings")]
    public sealed class DaHilgGameSettings : ScriptableObject
    {
        [Header("Assets")]
        public DaHilgLevelProfile[] Levels = Array.Empty<DaHilgLevelProfile>();
        public DaHilgCharacterSlot[] Characters = Array.Empty<DaHilgCharacterSlot>();
        public RuntimeAnimatorController CharacterAnimator;

        [Header("Defaults")]
        public string DefaultLevelSlug = "dahill";
        public string DefaultCharacterId = "cece";
        public DaHilgGameMode DefaultMode = DaHilgGameMode.Greet;
        public DaHilgCameraMode DefaultCameraMode = DaHilgCameraMode.ThirdPerson;

        [Header("Movement")]
        public float WalkSpeed = 4.6f;
        public float RunSpeed = 8.2f;
        public float CrawlSpeed = 1.3f;
        public float GroundAcceleration = 14f;
        public float AirAcceleration = 3f;
        public float JumpVelocity = 5.2f;
        public float Gravity = -18f;
        public float MaxFallSpeed = -40f;
        public float CoyoteTime = 0.12f;
        public float JumpBuffer = 0.1f;
        public float PlayerHeight = 1.7f;
        public float PlayerRadius = 0.3f;
        public float StepOffset = 0.5f;
        public float SlopeLimit = 50f;

        [Header("Camera")]
        public float CameraSensitivity = 0.12f;
        public float TouchSensitivity = 0.18f;
        public float PitchLimit = 68f;
        public float EyeHeight = 1.62f;
        public float ThirdPersonDistance = 3.8f;
        public float ThirdPersonMinDistance = 0.7f;
        public float ThirdPersonPivotHeight = 1.5f;
        public Vector2 ShoulderOffset = new Vector2(0.55f, 0.06f);
        public float CameraSmooth = 12f;
        public float LookSmooth = 22f;

        [Header("NPC")]
        public float NoticeRadius = 20f;
        public float TouchDistance = 1.4f;
        public float GreetDistance = 2.5f;
        public float RetreatSeconds = 3f;
        public float CooldownSeconds = 2f;
        public float WanderRadius = 12f;

        [Header("Nibblers")]
        public int NibblerPoolSize = 32;
        public float NibblerScale = 0.32f;
        public float NibblerSpawnMinRadius = 8f;
        public float NibblerSpawnMaxRadius = 16f;
        public float NibblerRunSpeed = 4.5f;
        public float NibblerAttachDistance = 0.65f;
        public float NibblerHealthDrainPerAttached = 0.09f;
        public float NibblerHealthDrainCap = 3.2f;
        public float HealthRegen = 5f;
        public int OverwhelmStagger = 5;
        public int OverwhelmDown = 11;
        public int OverwhelmStop = 18;

        public DaHilgLevelProfile FindLevel(string slug)
        {
            if (!string.IsNullOrEmpty(slug))
            {
                for (int i = 0; i < Levels.Length; i++)
                {
                    if (Levels[i] != null && Levels[i].Slug == slug) return Levels[i];
                }
            }

            for (int i = 0; i < Levels.Length; i++)
            {
                if (Levels[i] != null && Levels[i].Slug == DefaultLevelSlug) return Levels[i];
            }

            return Levels.Length > 0 ? Levels[0] : null;
        }

        public DaHilgCharacterSlot FindCharacter(string id)
        {
            for (int i = 0; i < Characters.Length; i++)
            {
                if (Characters[i].Id == id) return Characters[i];
            }

            return Characters.Length > 0 ? Characters[0] : default;
        }
    }
}
