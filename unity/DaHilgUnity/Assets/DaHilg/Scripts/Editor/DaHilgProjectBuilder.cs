using System;
using System.Collections.Generic;
using System.IO;
using System.Text.RegularExpressions;
using DaHilg;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Animations;
using UnityEditor.Build.Reporting;
using UnityEngine;
using UnityEngine.SceneManagement;
using UnityEngine.UIElements;

namespace DaHilg.Editor
{
    public static class DaHilgProjectBuilder
    {
        const string k_Root = "Assets/DaHilg";
        const string k_SettingsDir = k_Root + "/Settings";
        const string k_ScenePath = k_Root + "/Scenes/DaHilg.unity";
        const string k_SettingsPath = k_SettingsDir + "/DaHilgGameSettings.asset";
        const string k_ControllerPath = k_SettingsDir + "/DaHilgCharacter.controller";
        const string k_PanelSettingsPath = k_Root + "/UI/DaHilgPanelSettings.asset";

        [MenuItem("Da Hilg/Rebuild Unity Scene")]
        public static void RebuildUnityScene()
        {
            EnsureFolders();
            AnimatorController controller = BuildAnimatorController();
            DaHilgLevelProfile[] levels = BuildLevelProfiles();
            DaHilgGameSettings settings = BuildSettings(levels, controller);
            BuildScene(settings);
            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();
            Debug.Log("[DaHilg] Unity scene rebuilt.");
        }

        [MenuItem("Da Hilg/Build WebGL Export")]
        public static void BuildWebGLExport()
        {
            RebuildUnityScene();

            string projectRoot = Directory.GetParent(Application.dataPath)!.FullName;
            string repoRoot = Directory.GetParent(Directory.GetParent(projectRoot)!.FullName)!.FullName;
            string output = Path.Combine(repoRoot, "public/unity/da-hilg");
            Directory.CreateDirectory(output);

            EditorUserBuildSettings.SwitchActiveBuildTarget(BuildTargetGroup.WebGL, BuildTarget.WebGL);
            PlayerSettings.productName = "Da Hilg Unity";
            PlayerSettings.companyName = "Da Hilg";
            PlayerSettings.SetApplicationIdentifier(NamedBuildTarget.WebGL, "com.dahilg.unity");
            PlayerSettings.WebGL.compressionFormat = WebGLCompressionFormat.Disabled;
            PlayerSettings.WebGL.dataCaching = true;
            PlayerSettings.WebGL.decompressionFallback = true;
            PlayerSettings.WebGL.threadsSupport = false;

            BuildPlayerOptions options = new BuildPlayerOptions
            {
                scenes = new[] { k_ScenePath },
                locationPathName = output,
                target = BuildTarget.WebGL,
                options = BuildOptions.None
            };

            BuildReport report = BuildPipeline.BuildPlayer(options);
            if (report.summary.result != BuildResult.Succeeded)
            {
                throw new InvalidOperationException("WebGL build failed: " + report.summary.result);
            }

            CustomizeWebGLExport(output);
            CleanupGeneratedBuildSidecars(projectRoot, output);
            Debug.Log("[DaHilg] WebGL export built at " + output);
        }

        static void CleanupGeneratedBuildSidecars(string projectRoot, string output)
        {
            foreach (string dir in Directory.GetDirectories(output, "*BurstDebugInformation*DoNotShip*", SearchOption.TopDirectoryOnly))
            {
                Directory.Delete(dir, true);
            }

            string generatedPlugins = Path.Combine(projectRoot, "Data/Plugins");
            if (!Directory.Exists(generatedPlugins)) return;

            foreach (string file in Directory.GetFiles(generatedPlugins, "lib_burst_generated.*", SearchOption.TopDirectoryOnly))
            {
                File.Delete(file);
            }

            DeleteIfEmpty(generatedPlugins);
            DeleteIfEmpty(Path.Combine(projectRoot, "Data"));
        }

        static void DeleteIfEmpty(string dir)
        {
            if (Directory.Exists(dir)
                && Directory.GetFiles(dir, "*", SearchOption.AllDirectories).Length == 0
                && Directory.GetDirectories(dir, "*", SearchOption.AllDirectories).Length == 0)
            {
                Directory.Delete(dir);
            }
        }

        static void CustomizeWebGLExport(string output)
        {
            string templateData = Path.Combine(output, "TemplateData");
            Directory.CreateDirectory(templateData);

            File.WriteAllText(Path.Combine(output, "index.html"), @"<!DOCTYPE html>
<html lang=""en-us"">
  <head>
    <meta charset=""utf-8"">
    <meta http-equiv=""Content-Type"" content=""text/html; charset=utf-8"">
    <meta name=""viewport"" content=""width=device-width, height=device-height, initial-scale=1.0, user-scalable=no, shrink-to-fit=yes"">
    <title>Da Hilg Unity</title>
    <link rel=""shortcut icon"" href=""TemplateData/favicon.ico"">
    <link rel=""stylesheet"" href=""TemplateData/style.css"">
  </head>
  <body>
    <div id=""unity-container"">
      <canvas id=""unity-canvas"" width=""1280"" height=""720"" tabindex=""-1""></canvas>
      <div id=""unity-loading-bar"">
        <div id=""unity-logo""></div>
        <div id=""unity-progress-bar-empty"">
          <div id=""unity-progress-bar-full""></div>
        </div>
      </div>
      <div id=""unity-warning""></div>
      <div id=""unity-footer"">
        <div id=""unity-fullscreen-button"" title=""Fullscreen""></div>
        <div id=""unity-build-title"">Da Hilg Unity</div>
      </div>
    </div>
    <script>
      const canvas = document.querySelector('#unity-canvas');

      function unityShowBanner(msg, type) {
        const warningBanner = document.querySelector('#unity-warning');
        const div = document.createElement('div');
        div.textContent = msg;
        div.className = type === 'error' ? 'unity-error' : type === 'warning' ? 'unity-warning-line' : 'unity-message';
        warningBanner.appendChild(div);
        warningBanner.style.display = 'block';
        if (type !== 'error') {
          setTimeout(() => {
            warningBanner.removeChild(div);
            warningBanner.style.display = warningBanner.children.length ? 'block' : 'none';
          }, 5000);
        }
      }

      const buildUrl = 'Build';
      const loaderUrl = buildUrl + '/da-hilg.loader.js';
      const config = {
        arguments: [],
        dataUrl: buildUrl + '/da-hilg.data',
        frameworkUrl: buildUrl + '/da-hilg.framework.js',
        codeUrl: buildUrl + '/da-hilg.wasm',
        streamingAssetsUrl: 'StreamingAssets',
        companyName: 'Da Hilg',
        productName: 'Da Hilg Unity',
        productVersion: '1.0',
        showBanner: unityShowBanner
      };

      config.devicePixelRatio = Math.min(window.devicePixelRatio || 1, 1.75);
      document.querySelector('#unity-loading-bar').style.display = 'grid';

      const script = document.createElement('script');
      script.src = loaderUrl;
      script.onload = () => {
        createUnityInstance(canvas, config, (progress) => {
          document.querySelector('#unity-progress-bar-full').style.width = `${100 * progress}%`;
        }).then((unityInstance) => {
          document.querySelector('#unity-loading-bar').style.display = 'none';
          document.querySelector('#unity-fullscreen-button').onclick = () => {
            unityInstance.SetFullscreen(1);
          };
        }).catch((message) => {
          alert(message);
        });
      };

      document.body.appendChild(script);
    </script>
  </body>
</html>
");

            File.WriteAllText(Path.Combine(templateData, "style.css"), @"html,
body {
  width: 100%;
  height: 100%;
  padding: 0;
  margin: 0;
  overflow: hidden;
  background: #05070b;
}

#unity-container {
  position: fixed;
  inset: 0;
  background: #05070b;
}

#unity-canvas {
  display: block;
  width: 100%;
  height: 100%;
  background: #05070b;
}

#unity-loading-bar {
  position: absolute;
  inset: 0;
  display: none;
  place-items: center;
  gap: 12px;
  background: radial-gradient(circle at 50% 38%, rgba(42, 63, 91, 0.72), rgba(5, 7, 11, 0.94) 58%);
}

#unity-logo {
  width: 154px;
  height: 130px;
  background: url('unity-logo-dark.png') no-repeat center;
}

#unity-progress-bar-empty {
  width: 180px;
  height: 8px;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.16);
}

#unity-progress-bar-full {
  width: 0%;
  height: 100%;
  background: #9fc2ff;
}

#unity-footer {
  position: absolute;
  right: 14px;
  bottom: 12px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  color: rgba(255, 255, 255, 0.82);
  font-family: Arial, sans-serif;
  font-size: 13px;
  background: rgba(4, 6, 10, 0.48);
  backdrop-filter: blur(10px);
}

#unity-fullscreen-button {
  width: 24px;
  height: 24px;
  cursor: pointer;
  background: url('fullscreen-button.png') no-repeat center / contain;
}

#unity-warning {
  position: absolute;
  left: 50%;
  top: 14px;
  z-index: 2;
  display: none;
  min-width: min(640px, calc(100vw - 32px));
  transform: translateX(-50%);
  font-family: Arial, sans-serif;
}

#unity-warning > div {
  margin-bottom: 8px;
  padding: 10px 12px;
  color: #101216;
  background: #fff3ad;
}

#unity-warning > .unity-error {
  color: #fff;
  background: #b00020;
}

@media (max-width: 720px) {
  #unity-footer {
    display: none;
  }
}
");
        }

        [MenuItem("Da Hilg/Sync Source Assets From Web")]
        public static void SyncSourceAssets()
        {
            string projectRoot = Directory.GetParent(Application.dataPath)!.FullName;
            string repoRoot = Directory.GetParent(Directory.GetParent(projectRoot)!.FullName)!.FullName;
            string source = Path.Combine(repoRoot, "public/da-hilg");
            if (!Directory.Exists(source))
            {
                Debug.LogWarning("[DaHilg] Source asset folder not found: " + source);
                return;
            }

            CopyFiles(source, Path.Combine(Application.dataPath, "DaHilg/Art/Characters"), "*.glb", "drew", "cece", "mike", "kelli");
            CopyFiles(source, Path.Combine(Application.dataPath, "DaHilg/Art/Levels"), "*.glb", "level", "canyon", "stanton");
            CopyFiles(Path.Combine(source, "anims"), Path.Combine(Application.dataPath, "DaHilg/Art/Animations"), "*.glb");
            CopyFiles(source, Path.Combine(Application.dataPath, "DaHilg/Data"), "*.json");
            CopyFiles(source, Path.Combine(Application.dataPath, "DaHilg/Art/Textures"), "sun.png");
            AssetDatabase.Refresh();
            Debug.Log("[DaHilg] Source assets synced.");
        }

        static void EnsureFolders()
        {
            string[] folders =
            {
                k_Root,
                k_Root + "/Art",
                k_Root + "/Art/Characters",
                k_Root + "/Art/Levels",
                k_Root + "/Art/Animations",
                k_Root + "/Data",
                k_Root + "/Scenes",
                k_Root + "/Scripts",
                k_Root + "/UI",
                k_SettingsDir
            };

            foreach (string folder in folders)
            {
                if (!AssetDatabase.IsValidFolder(folder))
                {
                    string parent = Path.GetDirectoryName(folder)!.Replace("\\", "/");
                    string name = Path.GetFileName(folder);
                    AssetDatabase.CreateFolder(parent, name);
                }
            }
        }

        static AnimatorController BuildAnimatorController()
        {
            AnimatorController controller = AssetDatabase.LoadAssetAtPath<AnimatorController>(k_ControllerPath);
            if (controller == null)
            {
                controller = AnimatorController.CreateAnimatorControllerAtPath(k_ControllerPath);
            }

            AnimatorStateMachine machine = controller.layers[0].stateMachine;
            ClearStates(machine);

            Dictionary<string, AnimationClip> clips = LoadAnimationClips();
            string[] stateOrder = { "Idle", "Walk", "Run", "Jump", "Dance", "Wave", "Cheer", "Attack", "Hit", "Knockdown", "Crawl", "Stumble", "Climb" };
            AnimatorState idle = null;
            for (int i = 0; i < stateOrder.Length; i++)
            {
                string stateName = stateOrder[i];
                AnimatorState state = machine.AddState(stateName, new Vector3(260f, 60f + i * 48f, 0f));
                if (clips.TryGetValue(stateName.ToLowerInvariant(), out AnimationClip clip))
                {
                    state.motion = clip;
                }
                state.writeDefaultValues = true;
                if (stateName == "Idle") idle = state;
            }

            if (idle != null) machine.defaultState = idle;
            EditorUtility.SetDirty(controller);
            return controller;
        }

        static void ClearStates(AnimatorStateMachine machine)
        {
            foreach (ChildAnimatorState state in machine.states)
            {
                machine.RemoveState(state.state);
            }
            foreach (ChildAnimatorStateMachine child in machine.stateMachines)
            {
                machine.RemoveStateMachine(child.stateMachine);
            }
        }

        static Dictionary<string, AnimationClip> LoadAnimationClips()
        {
            Dictionary<string, AnimationClip> clips = new Dictionary<string, AnimationClip>();
            string[] guids = AssetDatabase.FindAssets("t:AnimationClip", new[] { k_Root + "/Art/Animations" });
            foreach (string guid in guids)
            {
                string path = AssetDatabase.GUIDToAssetPath(guid);
                string key = Path.GetFileNameWithoutExtension(path).ToLowerInvariant();
                UnityEngine.Object[] assets = AssetDatabase.LoadAllAssetsAtPath(path);
                foreach (UnityEngine.Object asset in assets)
                {
                    if (asset is AnimationClip clip && !clip.name.StartsWith("__", StringComparison.Ordinal))
                    {
                        clips[key] = clip;
                        break;
                    }
                }
            }
            return clips;
        }

        static DaHilgLevelProfile[] BuildLevelProfiles()
        {
            return new[]
            {
                BuildLevel("dahill", "1840 Dahill", "Home neighborhood", "level", "level.meta", "minimap"),
                BuildLevel("canyon", "Canyon Middle", "Castro Valley", "canyon", "canyon.meta", "canyon.minimap"),
                BuildLevel("stanton", "Stanton Elementary", "Castro Valley", "stanton", "stanton.meta", "stanton.minimap")
            };
        }

        static DaHilgLevelProfile BuildLevel(string slug, string label, string subLabel, string glbName, string metaName, string minimapName)
        {
            string assetPath = k_SettingsDir + "/Level_" + slug + ".asset";
            DaHilgLevelProfile profile = AssetDatabase.LoadAssetAtPath<DaHilgLevelProfile>(assetPath);
            if (profile == null)
            {
                profile = ScriptableObject.CreateInstance<DaHilgLevelProfile>();
                AssetDatabase.CreateAsset(profile, assetPath);
            }

            profile.Slug = slug;
            profile.Label = label;
            profile.SubLabel = subLabel;
            profile.LevelPrefab = AssetDatabase.LoadAssetAtPath<GameObject>(k_Root + "/Art/Levels/" + glbName + ".glb");
            profile.SourceMeta = AssetDatabase.LoadAssetAtPath<TextAsset>(k_Root + "/Data/" + metaName + ".json");
            profile.Minimap = AssetDatabase.LoadAssetAtPath<TextAsset>(k_Root + "/Data/" + minimapName + ".json");

            string json = profile.SourceMeta != null ? profile.SourceMeta.text : string.Empty;
            Vector3[] spawns = ExtractVectorArray(json, "spawns");
            Vector3[] npcSpawns = ExtractVectorArray(json, "npcSpawns");
            if (spawns.Length == 0) spawns = new[] { new Vector3(0f, 0.05f, 12f) };
            if (npcSpawns.Length == 0)
            {
                npcSpawns = new[]
                {
                    spawns[0] + new Vector3(6f, 0f, 6f),
                    spawns[0] + new Vector3(-6f, 0f, 6f),
                    spawns[0] + new Vector3(6f, 0f, -6f)
                };
            }

            profile.PlayerSpawns = spawns;
            profile.NpcSpawns = npcSpawns;
            Bounds house = ExtractHouseBounds(json);
            profile.GreetSafeZones = new[]
            {
                new DaHilgBoxZone
                {
                    Id = "home_safe",
                    Label = "Home",
                    Center = house.center,
                    Size = house.size + new Vector3(10f, 4f, 10f)
                }
            };
            profile.NibblerSafeZones = new[]
            {
                new DaHilgBoxZone { Id = "safe_home", Label = "Home", Center = spawns[0] + Vector3.up * 4f, Size = new Vector3(40f, 400f, 40f) },
                new DaHilgBoxZone { Id = "safe_creek", Label = "Creek Landing", Center = new Vector3(-60f, 6f, -120f), Size = new Vector3(22f, 12f, 22f) },
                new DaHilgBoxZone { Id = "safe_overlook", Label = "East Overlook", Center = new Vector3(130f, 8f, 40f), Size = new Vector3(22f, 12f, 22f) }
            };
            profile.DangerZones = new[]
            {
                new DaHilgBoxZone { Id = "danger_drive", Label = "Driveway Swarm", Center = new Vector3(26f, 5f, 24f), Size = new Vector3(30f, 10f, 30f) },
                new DaHilgBoxZone { Id = "danger_south", Label = "South Ambush", Center = new Vector3(-20f, 5f, -70f), Size = new Vector3(44f, 12f, 44f) },
                new DaHilgBoxZone { Id = "danger_east", Label = "East Road Swarm", Center = new Vector3(80f, 6f, 0f), Size = new Vector3(50f, 12f, 40f) },
                new DaHilgBoxZone { Id = "danger_west", Label = "West Road Swarm", Center = new Vector3(-80f, 6f, 40f), Size = new Vector3(50f, 12f, 44f) }
            };
            profile.PlayBounds = new Bounds(Vector3.zero, slug == "dahill" ? new Vector3(230f, 120f, 230f) : new Vector3(420f, 160f, 420f));
            EditorUtility.SetDirty(profile);
            return profile;
        }

        static DaHilgGameSettings BuildSettings(DaHilgLevelProfile[] levels, RuntimeAnimatorController controller)
        {
            DaHilgGameSettings settings = AssetDatabase.LoadAssetAtPath<DaHilgGameSettings>(k_SettingsPath);
            if (settings == null)
            {
                settings = ScriptableObject.CreateInstance<DaHilgGameSettings>();
                AssetDatabase.CreateAsset(settings, k_SettingsPath);
            }

            settings.Levels = levels;
            settings.CharacterAnimator = controller;
            settings.DefaultCharacterId = "cece";
            settings.DefaultLevelSlug = "dahill";
            settings.Characters = new[]
            {
                Character("mike", "Mike", "Dad", new Color(0.36f, 0.68f, 1f), 180f),
                Character("kelli", "Kelli", "Mom", new Color(1f, 0.67f, 0.35f), 180f),
                Character("cece", "Cece", "Kid", new Color(1f, 0.45f, 0.76f), 180f),
                Character("drew", "Drew", "Kid", new Color(0.42f, 1f, 0.58f), 180f)
            };
            EditorUtility.SetDirty(settings);
            return settings;
        }

        static DaHilgCharacterSlot Character(string id, string label, string blurb, Color accent, float yawOffset)
        {
            return new DaHilgCharacterSlot
            {
                Id = id,
                Label = label,
                Blurb = blurb,
                Accent = accent,
                VisualYawOffset = yawOffset,
                Prefab = AssetDatabase.LoadAssetAtPath<GameObject>(k_Root + "/Art/Characters/" + id + ".glb")
            };
        }

        static void BuildScene(DaHilgGameSettings settings)
        {
            Scene scene = EditorSceneManagerShim.NewScene();
            scene.name = "DaHilg";

            RenderSettings.ambientMode = UnityEngine.Rendering.AmbientMode.Trilight;
            RenderSettings.ambientSkyColor = new Color(0.72f, 0.82f, 0.92f);
            RenderSettings.ambientEquatorColor = new Color(0.42f, 0.48f, 0.50f);
            RenderSettings.ambientGroundColor = new Color(0.28f, 0.30f, 0.25f);

            GameObject sun = new GameObject("Sun");
            Light light = sun.AddComponent<Light>();
            light.type = LightType.Directional;
            light.intensity = 1.25f;
            light.shadows = LightShadows.Soft;
            sun.transform.rotation = Quaternion.Euler(48f, -38f, 0f);

            GameObject cameraObject = new GameObject("Main Camera");
            cameraObject.tag = "MainCamera";
            Camera camera = cameraObject.AddComponent<Camera>();
            camera.clearFlags = CameraClearFlags.Skybox;
            camera.nearClipPlane = 0.1f;
            camera.farClipPlane = 600f;
            cameraObject.AddComponent<AudioListener>();
            DaHilgCameraRig rig = cameraObject.AddComponent<DaHilgCameraRig>();

            GameObject managerObject = new GameObject("DaHilgGame");
            DaHilgInputRouter input = managerObject.AddComponent<DaHilgInputRouter>();
            DaHilgGameManager manager = managerObject.AddComponent<DaHilgGameManager>();
            manager.Settings = settings;
            manager.Input = input;
            manager.CameraRig = rig;

            GameObject hudObject = new GameObject("DaHilgHUD");
            UIDocument doc = hudObject.AddComponent<UIDocument>();
            PanelSettings panel = LoadOrCreatePanelSettings();
            doc.panelSettings = panel;
            DaHilgHud hud = hudObject.AddComponent<DaHilgHud>();
            manager.Hud = hud;

            EditorBuildSettings.scenes = new[] { new EditorBuildSettingsScene(k_ScenePath, true) };
            UnityEditor.SceneManagement.EditorSceneManager.SaveScene(scene, k_ScenePath);
        }

        static PanelSettings LoadOrCreatePanelSettings()
        {
            PanelSettings panel = AssetDatabase.LoadAssetAtPath<PanelSettings>(k_PanelSettingsPath);
            if (panel == null)
            {
                panel = ScriptableObject.CreateInstance<PanelSettings>();
                AssetDatabase.CreateAsset(panel, k_PanelSettingsPath);
            }

            panel.scaleMode = PanelScaleMode.ScaleWithScreenSize;
            panel.referenceResolution = new Vector2Int(1280, 720);
            panel.match = 0.5f;
            EditorUtility.SetDirty(panel);
            return panel;
        }

        static Vector3[] ExtractVectorArray(string json, string key)
        {
            string block = ExtractArrayBlock(json, key);
            if (string.IsNullOrEmpty(block)) return Array.Empty<Vector3>();

            MatchCollection matches = Regex.Matches(block, @"-?\d+(?:\.\d+)?");
            List<float> nums = new List<float>(matches.Count);
            foreach (Match match in matches)
            {
                if (float.TryParse(match.Value, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out float value))
                {
                    nums.Add(value);
                }
            }

            List<Vector3> vectors = new List<Vector3>();
            for (int i = 0; i + 2 < nums.Count; i += 3)
            {
                vectors.Add(new Vector3(nums[i], nums[i + 1], nums[i + 2]));
            }
            return vectors.ToArray();
        }

        static Bounds ExtractHouseBounds(string json)
        {
            string block = ExtractObjectBlock(json, "houseBox");
            Vector3[] min = ExtractVectorArray(block, "min");
            Vector3[] max = ExtractVectorArray(block, "max");
            if (min.Length > 0 && max.Length > 0)
            {
                Bounds bounds = new Bounds();
                bounds.SetMinMax(min[0], max[0]);
                return bounds;
            }
            return new Bounds(new Vector3(0f, 3f, 0f), new Vector3(26f, 6f, 26f));
        }

        static string ExtractArrayBlock(string json, string key)
        {
            int keyIndex = json.IndexOf('"' + key + '"', StringComparison.Ordinal);
            if (keyIndex < 0) return string.Empty;
            int start = json.IndexOf('[', keyIndex);
            if (start < 0) return string.Empty;
            int depth = 0;
            for (int i = start; i < json.Length; i++)
            {
                if (json[i] == '[') depth++;
                else if (json[i] == ']')
                {
                    depth--;
                    if (depth == 0) return json.Substring(start, i - start + 1);
                }
            }
            return string.Empty;
        }

        static string ExtractObjectBlock(string json, string key)
        {
            int keyIndex = json.IndexOf('"' + key + '"', StringComparison.Ordinal);
            if (keyIndex < 0) return string.Empty;
            int start = json.IndexOf('{', keyIndex);
            if (start < 0) return string.Empty;
            int depth = 0;
            for (int i = start; i < json.Length; i++)
            {
                if (json[i] == '{') depth++;
                else if (json[i] == '}')
                {
                    depth--;
                    if (depth == 0) return json.Substring(start, i - start + 1);
                }
            }
            return string.Empty;
        }

        static void CopyFiles(string source, string dest, string pattern, params string[] basenames)
        {
            Directory.CreateDirectory(dest);
            if (!Directory.Exists(source)) return;

            foreach (string file in Directory.GetFiles(source, pattern))
            {
                if (basenames.Length > 0)
                {
                    string name = Path.GetFileNameWithoutExtension(file);
                    bool keep = false;
                    for (int i = 0; i < basenames.Length; i++)
                    {
                        if (name == basenames[i])
                        {
                            keep = true;
                            break;
                        }
                    }
                    if (!keep) continue;
                }
                File.Copy(file, Path.Combine(dest, Path.GetFileName(file)), true);
            }
        }
    }

    static class EditorSceneManagerShim
    {
        public static Scene NewScene()
        {
            return UnityEditor.SceneManagement.EditorSceneManager.NewScene(
                UnityEditor.SceneManagement.NewSceneSetup.EmptyScene,
                UnityEditor.SceneManagement.NewSceneMode.Single);
        }
    }
}
