using System;
using UnityEngine;

namespace DaHilg
{
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
        public Vector3[] NpcSpawns = Array.Empty<Vector3>();
        public DaHilgBoxZone[] GreetSafeZones = Array.Empty<DaHilgBoxZone>();
        public DaHilgBoxZone[] NibblerSafeZones = Array.Empty<DaHilgBoxZone>();
        public DaHilgBoxZone[] DangerZones = Array.Empty<DaHilgBoxZone>();
        public Bounds PlayBounds = new Bounds(Vector3.zero, new Vector3(220f, 80f, 220f));
    }
}
