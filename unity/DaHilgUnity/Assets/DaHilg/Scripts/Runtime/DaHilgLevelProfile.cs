using System;
using UnityEngine;

namespace DaHilg
{
    [Serializable]
    public struct DaHilgAnimalSpawn
    {
        public string Id;
        public string Label;
        public GameObject Prefab;
        public RuntimeAnimatorController AnimatorController;
        public int Count;
        public Vector3 Home;
        public float WanderRadius;
        public float Speed;
        public float Scale;
        public float VisualYawOffset;
    }

    [CreateAssetMenu(menuName = "Da Hilg/Level Profile", fileName = "DaHilgLevelProfile")]
    public sealed class DaHilgLevelProfile : ScriptableObject
    {
        public string Slug = "dahill";
        public string Label = "1840 Dahill";
        public string SubLabel = "Home neighborhood";
        public GameObject LevelPrefab;
        public TextAsset SourceMeta;
        public TextAsset Minimap;
        public Vector3 LevelOffset;
        public Vector3[] PlayerSpawns = Array.Empty<Vector3>();
        public bool HasPlayerSpawnYaw;
        public float PlayerSpawnYaw;
        public float WaterHeightOffset = 0.24f;
        public Vector3[] NpcSpawns = Array.Empty<Vector3>();
        public DaHilgBoxZone[] GreetSafeZones = Array.Empty<DaHilgBoxZone>();
        public DaHilgBoxZone[] NibblerSafeZones = Array.Empty<DaHilgBoxZone>();
        public DaHilgBoxZone[] DangerZones = Array.Empty<DaHilgBoxZone>();
        public DaHilgAnimalSpawn[] AnimalSpawns = Array.Empty<DaHilgAnimalSpawn>();
        public Bounds PlayBounds = new Bounds(Vector3.zero, new Vector3(220f, 80f, 220f));
    }
}
