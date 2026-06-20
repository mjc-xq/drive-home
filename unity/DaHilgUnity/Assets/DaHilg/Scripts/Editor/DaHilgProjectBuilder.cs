using System;
using System.Collections.Generic;
using System.IO;
using System.Text.RegularExpressions;
using DaHilg;
using Unity.Cinemachine;
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
        const string k_CharacterControllerDir = k_SettingsDir + "/CharacterControllers";
        const string k_PanelSettingsPath = k_Root + "/UI/DaHilgPanelSettings.asset";
        const string k_GeneratedAnimationDir = k_SettingsDir + "/GeneratedAnimations";
        static readonly string[] s_CharacterAnimationStates =
        {
            "Idle",
            "Walk",
            "Run",
            "Jump",
            "Dance",
            "Wave",
            "Cheer",
            "Attack",
            "Hit",
            "Knockdown",
            "Crawl",
            "Stumble",
            "Climb"
        };
        static readonly HashSet<string> s_GroundedHipClips = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "Idle",
            "Walk",
            "Run",
            "Dance",
            "Wave",
            "Cheer",
            "Attack",
            "Hit",
            "Stumble"
        };

        [MenuItem("Da Hilg/Rebuild Unity Scene")]
        public static void RebuildUnityScene()
        {
            EnsureFolders();
            Dictionary<string, AnimatorController> controllers = BuildAnimatorControllers();
            DaHilgLevelProfile[] levels = BuildLevelProfiles();
            DaHilgGameSettings settings = BuildSettings(levels, controllers);
            BuildScene(settings);
            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();
            Debug.Log("[DaHilg] Unity scene rebuilt.");
        }

        [MenuItem("Da Hilg/Build WebGL Export")]
        public static void BuildWebGLExport()
        {
            RebuildUnityScene();
            ValidateSpawnGroundingAssets();
            ValidateCharacterAnimationAssets();

            string projectRoot = Directory.GetParent(Application.dataPath)!.FullName;
            string repoRoot = Directory.GetParent(Directory.GetParent(projectRoot)!.FullName)!.FullName;
            string output = Path.Combine(repoRoot, "public/unity/da-hilg");
            if (Directory.Exists(output))
            {
                Directory.Delete(output, true);
            }
            Directory.CreateDirectory(output);

            EditorUserBuildSettings.SwitchActiveBuildTarget(BuildTargetGroup.WebGL, BuildTarget.WebGL);
            PlayerSettings.productName = "Da Hilg Unity";
            PlayerSettings.companyName = "Da Hilg";
            PlayerSettings.SetApplicationIdentifier(NamedBuildTarget.WebGL, "com.dahilg.unity");
            PlayerSettings.WebGL.compressionFormat = WebGLCompressionFormat.Brotli;
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

        [MenuItem("Da Hilg/Validate Spawn Grounding")]
        public static void ValidateSpawnGrounding()
        {
            RebuildUnityScene();
            ValidateSpawnGroundingAssets();
        }

        [MenuItem("Da Hilg/Validate Character Animations")]
        public static void ValidateCharacterAnimations()
        {
            RebuildUnityScene();
            ValidateCharacterAnimationAssets();
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

            string loaderUrl = FindBuildFile(output, "da-hilg.loader.js");
            string dataUrl = FindBuildFile(output, "da-hilg.data");
            string frameworkUrl = FindBuildFile(output, "da-hilg.framework.js");
            string codeUrl = FindBuildFile(output, "da-hilg.wasm");

            string html = @"<!DOCTYPE html>
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
      <canvas id=""unity-canvas"" width=""1280"" height=""720"" tabindex=""0""></canvas>
      <div id=""unity-loading-bar"">
        <div id=""unity-logo""></div>
        <div id=""unity-progress-bar-empty"">
          <div id=""unity-progress-bar-full""></div>
        </div>
      </div>
      <div id=""unity-warning""></div>
    </div>
    <script>
      const canvas = document.querySelector('#unity-canvas');
      const getCanvasContext = canvas.getContext.bind(canvas);
      canvas.getContext = (contextType, attributes) => {
        if (contextType === 'webgl' || contextType === 'webgl2') {
          attributes = {
            ...attributes,
            alpha: false,
            premultipliedAlpha: false,
            preserveDrawingBuffer: true
          };
        }
        return getCanvasContext(contextType, attributes);
      };

      function releasePointerLock() {
        if (document.pointerLockElement && document.exitPointerLock) {
          document.exitPointerLock();
        }
      }

      document.addEventListener('pointerlockchange', () => window.setTimeout(releasePointerLock, 0));
      document.addEventListener('webkitpointerlockchange', () => window.setTimeout(releasePointerLock, 0));

      function focusCanvas() {
        try {
          canvas.focus({ preventScroll: true });
        } catch (_) {
          canvas.focus();
        }
      }

      canvas.addEventListener('pointerdown', focusCanvas);

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

      const config = {
        arguments: [],
        dataUrl: '__DATA_URL__',
        frameworkUrl: '__FRAMEWORK_URL__',
        codeUrl: '__CODE_URL__',
        streamingAssetsUrl: 'StreamingAssets',
        companyName: 'Da Hilg',
        productName: 'Da Hilg Unity',
        productVersion: '1.2',
        webglContextAttributes: { alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: true, powerPreference: 2 },
        showBanner: unityShowBanner
      };

      config.devicePixelRatio = Math.min(window.devicePixelRatio || 1, 1.75);
      document.querySelector('#unity-loading-bar').style.display = 'grid';

      const script = document.createElement('script');
      script.src = '__LOADER_URL__';
      script.onload = () => {
        createUnityInstance(canvas, config, (progress) => {
          document.querySelector('#unity-progress-bar-full').style.width = `${100 * progress}%`;
        }).then((unityInstance) => {
          document.querySelector('#unity-loading-bar').style.display = 'none';
          if (unityInstance.Module && unityInstance.Module.WebGLInput) {
            unityInstance.Module.WebGLInput._stickyCursorLock = false;
          }
          releasePointerLock();
          focusCanvas();
        }).catch((message) => {
          alert(message);
        });
      };

      document.body.appendChild(script);
    </script>
  </body>
</html>
";

            html = html
                .Replace("__LOADER_URL__", JsString(loaderUrl))
                .Replace("__DATA_URL__", JsString(dataUrl))
                .Replace("__FRAMEWORK_URL__", JsString(frameworkUrl))
                .Replace("__CODE_URL__", JsString(codeUrl));

            File.WriteAllText(Path.Combine(output, "index.html"), html);

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

");
        }

        static string FindBuildFile(string output, string fileName)
        {
            string buildDir = Path.Combine(output, "Build");
            string[] suffixes = { "", ".gz", ".br", ".unityweb" };
            foreach (string suffix in suffixes)
            {
                string path = Path.Combine(buildDir, fileName + suffix);
                if (File.Exists(path)) return "Build/" + fileName + suffix;
            }
            throw new FileNotFoundException("Unity WebGL build file not found.", fileName);
        }

        static string JsString(string value)
        {
            return value.Replace("\\", "\\\\").Replace("'", "\\'");
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
                k_SettingsDir,
                k_CharacterControllerDir,
                k_GeneratedAnimationDir
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

        static Dictionary<string, AnimatorController> BuildAnimatorControllers()
        {
            Dictionary<string, AnimationClip> clips = LoadAnimationClips();
            Dictionary<string, AnimatorController> controllers = new Dictionary<string, AnimatorController>();
            string[] characterIds = { "mike", "kelli", "cece", "drew" };

            for (int i = 0; i < s_CharacterAnimationStates.Length; i++)
            {
                AssetDatabase.DeleteAsset(k_GeneratedAnimationDir + "/" + s_CharacterAnimationStates[i] + ".anim");
            }

            for (int i = 0; i < characterIds.Length; i++)
            {
                string id = characterIds[i];
                GameObject targetPrefab = AssetDatabase.LoadAssetAtPath<GameObject>(k_Root + "/Art/Characters/" + id + ".glb");
                if (targetPrefab == null)
                {
                    throw new InvalidOperationException("Missing Da Hilg character prefab for animation retargeting: " + id + ".");
                }

                string controllerPath = id == "cece"
                    ? k_ControllerPath
                    : k_CharacterControllerDir + "/" + id + ".controller";
                controllers[id] = BuildAnimatorController(id, targetPrefab, clips, controllerPath);
            }

            return controllers;
        }

        static AnimatorController BuildAnimatorController(string characterId, GameObject targetPrefab, Dictionary<string, AnimationClip> clips, string controllerPath)
        {
            AnimatorController controller = AssetDatabase.LoadAssetAtPath<AnimatorController>(controllerPath);
            if (controller == null)
            {
                controller = AnimatorController.CreateAnimatorControllerAtPath(controllerPath);
            }

            AnimatorStateMachine machine = controller.layers[0].stateMachine;
            ClearStates(machine);

            AnimatorState idle = null;
            for (int i = 0; i < s_CharacterAnimationStates.Length; i++)
            {
                string stateName = s_CharacterAnimationStates[i];
                AnimatorState state = machine.AddState(stateName, new Vector3(260f, 60f + i * 48f, 0f));
                if (clips.TryGetValue(stateName.ToLowerInvariant(), out AnimationClip clip))
                {
                    state.motion = RetargetAnimationClip(characterId, stateName, clip, targetPrefab);
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

        static AnimationClip RetargetAnimationClip(string characterId, string stateName, AnimationClip source, GameObject targetPrefab)
        {
            GameObject sourcePrefab = AssetDatabase.LoadAssetAtPath<GameObject>(k_Root + "/Art/Animations/" + stateName.ToLowerInvariant() + ".glb");
            if (sourcePrefab == null)
            {
                throw new InvalidOperationException("Missing source animation rig for " + stateName + ".");
            }

            string assetPath = k_GeneratedAnimationDir + "/" + characterId + "_" + stateName + ".anim";
            AnimationClip clip = AssetDatabase.LoadAssetAtPath<AnimationClip>(assetPath);
            if (clip == null)
            {
                clip = new AnimationClip();
                AssetDatabase.CreateAsset(clip, assetPath);
            }

            clip.name = characterId + "_" + stateName;
            clip.ClearCurves();
            clip.frameRate = source.frameRate;
            clip.wrapMode = source.wrapMode;
            clip.legacy = false;

            AnimationClipSettings settings = AnimationUtility.GetAnimationClipSettings(source);
            AnimationUtility.SetAnimationClipSettings(clip, settings);

            Dictionary<string, AnimationCurve[]> rotationCurves = new Dictionary<string, AnimationCurve[]>();
            Dictionary<string, AnimationCurve[]> positionCurves = new Dictionary<string, AnimationCurve[]>();
            EditorCurveBinding[] bindings = AnimationUtility.GetCurveBindings(source);
            for (int i = 0; i < bindings.Length; i++)
            {
                EditorCurveBinding binding = bindings[i];
                AnimationCurve curve = AnimationUtility.GetEditorCurve(source, binding);
                if (curve == null) continue;

                if (binding.propertyName.StartsWith("m_LocalRotation.", StringComparison.Ordinal))
                {
                    int component = RotationComponent(binding.propertyName);
                    if (component >= 0)
                    {
                        if (!rotationCurves.TryGetValue(binding.path, out AnimationCurve[] curves))
                        {
                            curves = new AnimationCurve[4];
                            rotationCurves[binding.path] = curves;
                        }
                        curves[component] = curve;
                    }
                    continue;
                }

                if (binding.propertyName.StartsWith("m_LocalPosition.", StringComparison.Ordinal))
                {
                    int component = VectorComponent(binding.propertyName);
                    if (component >= 0)
                    {
                        if (!positionCurves.TryGetValue(binding.path, out AnimationCurve[] curves))
                        {
                            curves = new AnimationCurve[3];
                            positionCurves[binding.path] = curves;
                        }
                        curves[component] = curve;
                    }
                    continue;
                }

                if (binding.propertyName.StartsWith("m_LocalScale.", StringComparison.Ordinal))
                {
                    continue;
                }
            }

            foreach (KeyValuePair<string, AnimationCurve[]> pair in rotationCurves)
            {
                if (!TryFindRetargetBones(sourcePrefab.transform, targetPrefab.transform, pair.Key, out Transform sourceBone, out Transform targetBone)) continue;
                AnimationCurve[] curves = pair.Value;
                if (curves[0] == null || curves[1] == null || curves[2] == null || curves[3] == null) continue;

                AnimationCurve[] retargeted = RetargetRotationCurves(curves, sourceBone.localRotation, targetBone.localRotation);
                string path = RetargetBindingPath(pair.Key);
                SetTransformCurves(clip, path, "m_LocalRotation.", retargeted);
            }

            foreach (KeyValuePair<string, AnimationCurve[]> pair in positionCurves)
            {
                if (!IsHipsPath(pair.Key)) continue;
                if (!TryFindRetargetBones(sourcePrefab.transform, targetPrefab.transform, pair.Key, out Transform sourceBone, out Transform targetBone)) continue;
                AnimationCurve[] curves = pair.Value;
                if (curves[0] == null || curves[1] == null || curves[2] == null) continue;

                AnimationCurve[] retargeted = RetargetHipPositionCurves(stateName, curves, sourceBone.localPosition, targetBone.localPosition);
                string path = RetargetBindingPath(pair.Key);
                SetTransformCurves(clip, path, "m_LocalPosition.", retargeted);
            }

            AnimationUtility.SetAnimationEvents(clip, AnimationUtility.GetAnimationEvents(source));
            EditorUtility.SetDirty(clip);
            return clip;
        }

        static bool TryFindRetargetBones(Transform sourceRoot, Transform targetRoot, string sourcePath, out Transform sourceBone, out Transform targetBone)
        {
            string boneName = LastPathSegment(sourcePath);
            sourceBone = FindDeepChild(sourceRoot, boneName);
            targetBone = FindDeepChild(targetRoot, boneName);
            return sourceBone != null && targetBone != null;
        }

        static AnimationCurve[] RetargetRotationCurves(AnimationCurve[] sourceCurves, Quaternion sourceRest, Quaternion targetRest)
        {
            List<float> times = CollectKeyTimes(sourceCurves);
            AnimationCurve[] result = NewCurveSet(4);
            Quaternion previous = Quaternion.identity;
            bool hasPrevious = false;

            for (int i = 0; i < times.Count; i++)
            {
                float time = times[i];
                Quaternion sourceAnimated = NormalizeQuaternion(new Quaternion(
                    sourceCurves[0].Evaluate(time),
                    sourceCurves[1].Evaluate(time),
                    sourceCurves[2].Evaluate(time),
                    sourceCurves[3].Evaluate(time)));
                Quaternion delta = Quaternion.Inverse(sourceRest) * sourceAnimated;
                Quaternion targetAnimated = NormalizeQuaternion(targetRest * delta);
                if (hasPrevious && Quaternion.Dot(previous, targetAnimated) < 0f)
                {
                    targetAnimated = new Quaternion(-targetAnimated.x, -targetAnimated.y, -targetAnimated.z, -targetAnimated.w);
                }

                AddQuaternionKeys(result, time, targetAnimated);
                previous = targetAnimated;
                hasPrevious = true;
            }

            SmoothCurves(result);
            return result;
        }

        static AnimationCurve[] RetargetHipPositionCurves(string stateName, AnimationCurve[] sourceCurves, Vector3 sourceRest, Vector3 targetRest)
        {
            List<float> times = CollectKeyTimes(sourceCurves);
            AnimationCurve[] result = NewCurveSet(3);
            bool flattenY = s_GroundedHipClips.Contains(stateName);

            for (int i = 0; i < times.Count; i++)
            {
                float time = times[i];
                Vector3 sourceAnimated = new Vector3(
                    sourceCurves[0].Evaluate(time),
                    sourceCurves[1].Evaluate(time),
                    sourceCurves[2].Evaluate(time));
                Vector3 targetAnimated = targetRest + (sourceAnimated - sourceRest);
                if (flattenY) targetAnimated.y = targetRest.y;
                else if (stateName.Equals("Knockdown", StringComparison.OrdinalIgnoreCase)) targetAnimated.y = Mathf.Min(targetAnimated.y, targetRest.y);

                result[0].AddKey(time, targetAnimated.x);
                result[1].AddKey(time, targetAnimated.y);
                result[2].AddKey(time, targetAnimated.z);
            }

            SmoothCurves(result);
            return result;
        }

        static AnimationCurve[] NewCurveSet(int count)
        {
            AnimationCurve[] curves = new AnimationCurve[count];
            for (int i = 0; i < count; i++) curves[i] = new AnimationCurve();
            return curves;
        }

        static void AddQuaternionKeys(AnimationCurve[] curves, float time, Quaternion q)
        {
            curves[0].AddKey(time, q.x);
            curves[1].AddKey(time, q.y);
            curves[2].AddKey(time, q.z);
            curves[3].AddKey(time, q.w);
        }

        static void SmoothCurves(AnimationCurve[] curves)
        {
            for (int i = 0; i < curves.Length; i++)
            {
                for (int j = 0; j < curves[i].length; j++)
                {
                    curves[i].SmoothTangents(j, 0f);
                }
            }
        }

        static List<float> CollectKeyTimes(AnimationCurve[] curves)
        {
            List<float> times = new List<float>();
            for (int i = 0; i < curves.Length; i++)
            {
                if (curves[i] == null) continue;
                Keyframe[] keys = curves[i].keys;
                for (int j = 0; j < keys.Length; j++)
                {
                    if (!times.Contains(keys[j].time)) times.Add(keys[j].time);
                }
            }
            times.Sort();
            if (times.Count == 0) times.Add(0f);
            return times;
        }

        static Quaternion NormalizeQuaternion(Quaternion q)
        {
            float mag = Mathf.Sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
            if (mag <= 0.00001f) return Quaternion.identity;
            float inv = 1f / mag;
            return new Quaternion(q.x * inv, q.y * inv, q.z * inv, q.w * inv);
        }

        static void SetTransformCurves(AnimationClip clip, string path, string propertyPrefix, AnimationCurve[] curves)
        {
            string[] suffixes = curves.Length == 4 ? new[] { "x", "y", "z", "w" } : new[] { "x", "y", "z" };
            for (int i = 0; i < curves.Length; i++)
            {
                EditorCurveBinding binding = EditorCurveBinding.FloatCurve(path, typeof(Transform), propertyPrefix + suffixes[i]);
                AnimationUtility.SetEditorCurve(clip, binding, curves[i]);
            }
        }

        static string RetargetBindingPath(string path)
        {
            const string prefix = "Armature/";
            return path.StartsWith(prefix, StringComparison.Ordinal) ? path.Substring(prefix.Length) : path;
        }

        static bool IsHipsPath(string path)
        {
            return LastPathSegment(path) == "Hips";
        }

        static string LastPathSegment(string path)
        {
            int slash = path.LastIndexOf('/');
            return slash >= 0 ? path.Substring(slash + 1) : path;
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
            profile.LevelOffset = ExtractFirstVector(json, "offset");
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
                new DaHilgBoxZone { Id = "danger_drive", Label = "Driveway Swarm", Center = new Vector3(24f, 6f, 24f), Size = new Vector3(78f, 18f, 76f) },
                new DaHilgBoxZone { Id = "danger_front", Label = "Front Lawn Swarm", Center = new Vector3(0f, 6f, 62f), Size = new Vector3(88f, 18f, 64f) },
                new DaHilgBoxZone { Id = "danger_south", Label = "South Ambush", Center = new Vector3(-20f, 6f, -70f), Size = new Vector3(92f, 18f, 92f) },
                new DaHilgBoxZone { Id = "danger_east", Label = "East Road Swarm", Center = new Vector3(80f, 6f, 0f), Size = new Vector3(104f, 18f, 82f) },
                new DaHilgBoxZone { Id = "danger_west", Label = "West Road Swarm", Center = new Vector3(-80f, 6f, 40f), Size = new Vector3(104f, 18f, 92f) }
            };
            profile.PlayBounds = new Bounds(Vector3.zero, slug == "dahill" ? new Vector3(230f, 120f, 230f) : new Vector3(420f, 160f, 420f));
            EditorUtility.SetDirty(profile);
            return profile;
        }

        static DaHilgGameSettings BuildSettings(DaHilgLevelProfile[] levels, Dictionary<string, AnimatorController> controllers)
        {
            DaHilgGameSettings settings = AssetDatabase.LoadAssetAtPath<DaHilgGameSettings>(k_SettingsPath);
            if (settings == null)
            {
                settings = ScriptableObject.CreateInstance<DaHilgGameSettings>();
                AssetDatabase.CreateAsset(settings, k_SettingsPath);
            }

            settings.Levels = levels;
            settings.CharacterAnimator = controllers.TryGetValue("cece", out AnimatorController defaultController) ? defaultController : null;
            settings.DefaultCharacterId = "cece";
            settings.DefaultLevelSlug = "dahill";
            settings.DefaultCameraMode = DaHilgCameraMode.ThirdPerson;
            settings.CameraSensitivity = 0.09f;
            settings.TouchSensitivity = 0.11f;
            settings.ControllerSkinWidth = 0.06f;
            settings.GroundProbeHeight = 3.4f;
            settings.GroundSnapDistance = 1.55f;
            settings.GroundSkin = 0.05f;
            settings.DangerNibblerBonus = 8;
            settings.DangerSpawnInterval = 0.12f;
            settings.NormalSpawnInterval = 0.35f;
            settings.Characters = new[]
            {
                Character("mike", "Mike", "Dad", new Color(0.36f, 0.68f, 1f), 0f, controllers),
                Character("kelli", "Kelli", "Mom", new Color(1f, 0.67f, 0.35f), 0f, controllers),
                Character("cece", "Cece", "Kid", new Color(1f, 0.45f, 0.76f), 0f, controllers),
                Character("drew", "Drew", "Kid", new Color(0.42f, 1f, 0.58f), 0f, controllers)
            };
            EditorUtility.SetDirty(settings);
            return settings;
        }

        static DaHilgCharacterSlot Character(string id, string label, string blurb, Color accent, float yawOffset, Dictionary<string, AnimatorController> controllers)
        {
            return new DaHilgCharacterSlot
            {
                Id = id,
                Label = label,
                Blurb = blurb,
                Accent = accent,
                VisualYawOffset = yawOffset,
                Prefab = AssetDatabase.LoadAssetAtPath<GameObject>(k_Root + "/Art/Characters/" + id + ".glb"),
                AnimatorController = controllers.TryGetValue(id, out AnimatorController controller) ? controller : null
            };
        }

        static void BuildScene(DaHilgGameSettings settings)
        {
            Scene scene = EditorSceneManagerShim.NewScene();
            scene.name = "DaHilg";

            RenderSettings.ambientMode = UnityEngine.Rendering.AmbientMode.Trilight;
            RenderSettings.ambientSkyColor = new Color(0.54f, 0.62f, 0.68f);
            RenderSettings.ambientEquatorColor = new Color(0.32f, 0.36f, 0.36f);
            RenderSettings.ambientGroundColor = new Color(0.20f, 0.22f, 0.18f);

            GameObject sun = new GameObject("Sun");
            Light light = sun.AddComponent<Light>();
            light.type = LightType.Directional;
            light.intensity = 0.82f;
            light.shadows = LightShadows.Soft;
            sun.transform.rotation = Quaternion.Euler(48f, -38f, 0f);

            GameObject cameraObject = new GameObject("Main Camera");
            cameraObject.tag = "MainCamera";
            Camera camera = cameraObject.AddComponent<Camera>();
            camera.clearFlags = CameraClearFlags.SolidColor;
            camera.backgroundColor = new Color(0.47f, 0.66f, 0.84f, 1f);
            camera.nearClipPlane = 0.1f;
            camera.farClipPlane = 600f;
            cameraObject.AddComponent<AudioListener>();
            CinemachineBrain brain = cameraObject.AddComponent<CinemachineBrain>();
            brain.UpdateMethod = CinemachineBrain.UpdateMethods.SmartUpdate;
            brain.BlendUpdateMethod = CinemachineBrain.BrainUpdateMethods.LateUpdate;
            brain.DefaultBlend = new CinemachineBlendDefinition(CinemachineBlendDefinition.Styles.EaseInOut, 0.18f);
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

        static Vector3 ExtractFirstVector(string json, string key)
        {
            Vector3[] vectors = ExtractVectorArray(json, key);
            return vectors.Length > 0 ? vectors[0] : Vector3.zero;
        }

        static void ValidateSpawnGroundingAssets()
        {
            DaHilgGameSettings settings = AssetDatabase.LoadAssetAtPath<DaHilgGameSettings>(k_SettingsPath);
            if (settings == null) throw new InvalidOperationException("Da Hilg settings asset was not built.");

            int checkedSpawns = 0;
            for (int i = 0; i < settings.Levels.Length; i++)
            {
                DaHilgLevelProfile profile = settings.Levels[i];
                if (profile == null || profile.LevelPrefab == null) continue;

                GameObject level = PrefabUtility.InstantiatePrefab(profile.LevelPrefab) as GameObject;
                if (level == null) level = UnityEngine.Object.Instantiate(profile.LevelPrefab);
                level.name = "SpawnValidation_" + profile.Slug;
                try
                {
                    DaHilgLevelRuntime.ApplyLevelOffset(level, profile);
                    DaHilgLevelRuntime.PrepareLevelColliders(level);
                    ValidateSpawnArray(profile, profile.PlayerSpawns, "player", ref checkedSpawns);
                    ValidateSpawnArray(profile, profile.NpcSpawns, "npc", ref checkedSpawns);
                }
                finally
                {
                    UnityEngine.Object.DestroyImmediate(level);
                }
            }

            if (checkedSpawns == 0) throw new InvalidOperationException("No Da Hilg spawn points were checked.");
            Debug.Log("[DaHilg] Spawn grounding validated for " + checkedSpawns + " spawn points.");
        }

        static void ValidateCharacterAnimationAssets()
        {
            DaHilgGameSettings settings = AssetDatabase.LoadAssetAtPath<DaHilgGameSettings>(k_SettingsPath);
            if (settings == null) throw new InvalidOperationException("Da Hilg settings asset was not built.");

            int checkedControllers = 0;
            for (int i = 0; i < settings.Characters.Length; i++)
            {
                DaHilgCharacterSlot slot = settings.Characters[i];
                if (slot.Prefab == null) continue;
                ValidateAnimatorController(slot.Id, slot.AnimatorController != null ? slot.AnimatorController : settings.CharacterAnimator);
                checkedControllers++;
            }

            if (checkedControllers == 0) throw new InvalidOperationException("No Da Hilg character animation controllers were checked.");
            ValidateCharacterPrefabAnimationBindings(settings);

            Debug.Log("[DaHilg] Character animations validated for " + checkedControllers + " controllers and " + s_CharacterAnimationStates.Length + " states.");
        }

        static AnimatorStateMachine ValidateAnimatorController(string owner, RuntimeAnimatorController runtimeController)
        {
            AnimatorController controller = runtimeController as AnimatorController;
            if (controller == null) throw new InvalidOperationException("Da Hilg animation controller was not built for " + owner + ".");
            if (controller.layers.Length == 0) throw new InvalidOperationException("Da Hilg animation controller for " + owner + " has no layers.");

            AnimatorStateMachine machine = controller.layers[0].stateMachine;
            if (machine.defaultState == null || machine.defaultState.name != "Idle")
            {
                throw new InvalidOperationException("Da Hilg animation controller for " + owner + " must default to Idle.");
            }

            GameObject probe = new GameObject("DaHilgAnimatorValidation_" + owner);
            Animator animator = probe.AddComponent<Animator>();
            animator.runtimeAnimatorController = controller;
            try
            {
                for (int i = 0; i < s_CharacterAnimationStates.Length; i++)
                {
                    string stateName = s_CharacterAnimationStates[i];
                    AnimatorState state = FindAnimatorState(machine, stateName);
                    if (state == null)
                    {
                        throw new InvalidOperationException("Da Hilg animation state is missing for " + owner + ": " + stateName + ".");
                    }

                    if (state.motion == null)
                    {
                        throw new InvalidOperationException("Da Hilg animation state has no motion clip for " + owner + ": " + stateName + ".");
                    }

                    int hash = Animator.StringToHash("Base Layer." + stateName);
                    if (!animator.HasState(0, hash))
                    {
                        throw new InvalidOperationException("Da Hilg animation state cannot be resolved by runtime hash for " + owner + ": Base Layer." + stateName + ".");
                    }
                }
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(probe);
            }

            return machine;
        }

        static void ValidateCharacterPrefabAnimationBindings(DaHilgGameSettings settings)
        {
            int checkedCharacters = 0;
            for (int i = 0; i < settings.Characters.Length; i++)
            {
                DaHilgCharacterSlot slot = settings.Characters[i];
                if (slot.Prefab == null) continue;

                AnimatorController controller = (slot.AnimatorController != null ? slot.AnimatorController : settings.CharacterAnimator) as AnimatorController;
                if (controller == null) throw new InvalidOperationException(slot.Id + " animation controller is missing.");
                AnimatorStateMachine machine = controller.layers[0].stateMachine;
                AnimatorState run = FindAnimatorState(machine, "Run");
                if (run == null || run.motion is not AnimationClip runClip)
                {
                    throw new InvalidOperationException(slot.Id + " Run animation clip is missing.");
                }

                GameObject character = PrefabUtility.InstantiatePrefab(slot.Prefab) as GameObject;
                if (character == null) character = UnityEngine.Object.Instantiate(slot.Prefab);
                character.name = "AnimationValidation_" + slot.Id;

                try
                {
                    Transform bindingRoot = FindAnimationBindingRoot(character.transform, runClip);
                    Animator animator = bindingRoot.GetComponent<Animator>();
                    if (animator == null) animator = bindingRoot.gameObject.AddComponent<Animator>();
                    animator.applyRootMotion = false;
                    animator.cullingMode = AnimatorCullingMode.AlwaysAnimate;
                    animator.runtimeAnimatorController = controller;

                    float t1 = 0.2f;
                    float t2 = 0.65f;
                    int runHash = Animator.StringToHash("Base Layer.Run");
                    animator.Rebind();
                    animator.Update(0f);
                    animator.Play(runHash, 0, t1);
                    animator.Update(0f);
                    Quaternion[] q1 = CaptureBoneRotations(bindingRoot);
                    animator.Play(runHash, 0, t2);
                    animator.Update(0f);
                    Quaternion[] q2 = CaptureBoneRotations(bindingRoot);
                    float maxAngle = 0f;
                    for (int j = 0; j < q1.Length && j < q2.Length; j++)
                    {
                        maxAngle = Mathf.Max(maxAngle, Quaternion.Angle(q1[j], q2[j]));
                    }

                    if (maxAngle < 2f)
                    {
                        string firstBinding = FirstBindingPath(runClip);
                        string firstTransformPath = FirstBindingTransformPath(runClip);
                        float maxCurveAngle = MaxRotationCurveAngle(runClip, t1, t2);
                        throw new InvalidOperationException(slot.Id + " Run clip did not move sampled bones from binding root "
                            + TransformPath(character.transform, bindingRoot) + ". Max sampled angle: " + maxAngle.ToString("0.###")
                            + ". Max curve angle: " + maxCurveAngle.ToString("0.###")
                            + ". Clip length: " + runClip.length.ToString("0.###")
                            + ". Binding count: " + AnimationUtility.GetCurveBindings(runClip).Length
                            + ". First transform exists: " + (bindingRoot.Find(firstTransformPath) != null)
                            + ". Hierarchy: " + HierarchyPreview(bindingRoot, 28)
                            + ". Bindings: " + BindingPreview(runClip)
                            + ". First binding path: " + firstBinding + ".");
                    }

                    checkedCharacters++;
                }
                finally
                {
                    UnityEngine.Object.DestroyImmediate(character);
                }
            }

            if (checkedCharacters == 0) throw new InvalidOperationException("No Da Hilg character prefabs were checked for animation bindings.");
            Debug.Log("[DaHilg] Character prefab animation bindings validated for " + checkedCharacters + " characters.");
        }

        static Transform FindAnimationBindingRoot(Transform characterRoot, AnimationClip clip)
        {
            EditorCurveBinding[] bindings = AnimationUtility.GetCurveBindings(clip);
            if (bindings.Length == 0 || string.IsNullOrEmpty(bindings[0].path)) return characterRoot;

            string path = bindings[0].path;
            int slash = path.IndexOf('/');
            string firstSegment = slash >= 0 ? path.Substring(0, slash) : path;
            Transform root = FindTransformWithDirectChild(characterRoot, firstSegment);
            return root != null ? root : characterRoot;
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

        static Quaternion[] CaptureBoneRotations(Transform root)
        {
            string[] names = { "Hips", "Spine", "LeftArm", "RightArm", "LeftForeArm", "RightForeArm", "LeftLeg", "RightLeg", "LeftFoot", "RightFoot" };
            List<Quaternion> rotations = new List<Quaternion>(names.Length);
            for (int i = 0; i < names.Length; i++)
            {
                Transform bone = FindDeepChild(root, names[i]);
                if (bone != null) rotations.Add(bone.localRotation);
            }

            if (rotations.Count == 0)
            {
                throw new InvalidOperationException("No Da Hilg bones were found for animation binding validation.");
            }

            return rotations.ToArray();
        }

        static float MaxRotationCurveAngle(AnimationClip clip, float t1, float t2)
        {
            EditorCurveBinding[] bindings = AnimationUtility.GetCurveBindings(clip);
            Dictionary<string, AnimationCurve[]> curvesByPath = new Dictionary<string, AnimationCurve[]>();
            for (int i = 0; i < bindings.Length; i++)
            {
                EditorCurveBinding binding = bindings[i];
                int component = RotationComponent(binding.propertyName);
                if (component < 0) continue;

                if (!curvesByPath.TryGetValue(binding.path, out AnimationCurve[] curves))
                {
                    curves = new AnimationCurve[4];
                    curvesByPath[binding.path] = curves;
                }
                curves[component] = AnimationUtility.GetEditorCurve(clip, binding);
            }

            float maxAngle = 0f;
            foreach (AnimationCurve[] curves in curvesByPath.Values)
            {
                if (curves[0] == null || curves[1] == null || curves[2] == null || curves[3] == null) continue;
                Quaternion q1 = new Quaternion(curves[0].Evaluate(t1), curves[1].Evaluate(t1), curves[2].Evaluate(t1), curves[3].Evaluate(t1));
                Quaternion q2 = new Quaternion(curves[0].Evaluate(t2), curves[1].Evaluate(t2), curves[2].Evaluate(t2), curves[3].Evaluate(t2));
                maxAngle = Mathf.Max(maxAngle, Quaternion.Angle(q1, q2));
            }

            return maxAngle;
        }

        static int RotationComponent(string propertyName)
        {
            if (propertyName.EndsWith(".x", StringComparison.Ordinal)) return 0;
            if (propertyName.EndsWith(".y", StringComparison.Ordinal)) return 1;
            if (propertyName.EndsWith(".z", StringComparison.Ordinal)) return 2;
            if (propertyName.EndsWith(".w", StringComparison.Ordinal)) return 3;
            return -1;
        }

        static int VectorComponent(string propertyName)
        {
            if (propertyName.EndsWith(".x", StringComparison.Ordinal)) return 0;
            if (propertyName.EndsWith(".y", StringComparison.Ordinal)) return 1;
            if (propertyName.EndsWith(".z", StringComparison.Ordinal)) return 2;
            return -1;
        }

        static string TransformPath(Transform root, Transform child)
        {
            if (root == child) return root.name;
            List<string> parts = new List<string>();
            Transform current = child;
            while (current != null && current != root)
            {
                parts.Add(current.name);
                current = current.parent;
            }
            parts.Add(root.name);
            parts.Reverse();
            return string.Join("/", parts);
        }

        static Transform FindDeepChild(Transform parent, string childName)
        {
            if (parent.name == childName) return parent;
            for (int i = 0; i < parent.childCount; i++)
            {
                Transform found = FindDeepChild(parent.GetChild(i), childName);
                if (found != null) return found;
            }
            return null;
        }

        static string FirstBindingPath(AnimationClip clip)
        {
            EditorCurveBinding[] bindings = AnimationUtility.GetCurveBindings(clip);
            return bindings.Length > 0 ? bindings[0].path + "." + bindings[0].propertyName : "<none>";
        }

        static string FirstBindingTransformPath(AnimationClip clip)
        {
            EditorCurveBinding[] bindings = AnimationUtility.GetCurveBindings(clip);
            return bindings.Length > 0 ? bindings[0].path : string.Empty;
        }

        static string HierarchyPreview(Transform root, int maxItems)
        {
            List<string> paths = new List<string>(maxItems);
            CollectHierarchyPaths(root, root, paths, maxItems);
            return string.Join(", ", paths);
        }

        static void CollectHierarchyPaths(Transform root, Transform current, List<string> paths, int maxItems)
        {
            if (paths.Count >= maxItems) return;
            paths.Add(TransformPath(root, current));
            for (int i = 0; i < current.childCount && paths.Count < maxItems; i++)
            {
                CollectHierarchyPaths(root, current.GetChild(i), paths, maxItems);
            }
        }

        static string BindingPreview(AnimationClip clip)
        {
            EditorCurveBinding[] bindings = AnimationUtility.GetCurveBindings(clip);
            int count = Mathf.Min(bindings.Length, 12);
            string[] preview = new string[count];
            for (int i = 0; i < count; i++)
            {
                preview[i] = bindings[i].path + "." + bindings[i].propertyName;
            }
            return string.Join(", ", preview);
        }

        static AnimatorState FindAnimatorState(AnimatorStateMachine machine, string stateName)
        {
            foreach (ChildAnimatorState child in machine.states)
            {
                if (child.state != null && child.state.name == stateName) return child.state;
            }

            foreach (ChildAnimatorStateMachine child in machine.stateMachines)
            {
                AnimatorState state = FindAnimatorState(child.stateMachine, stateName);
                if (state != null) return state;
            }

            return null;
        }

        static void ValidateSpawnArray(DaHilgLevelProfile profile, Vector3[] spawns, string group, ref int checkedSpawns)
        {
            for (int i = 0; i < spawns.Length; i++)
            {
                Vector3 spawn = spawns[i];
                if (!DaHilgLevelRuntime.TryFindSpawnGround(spawn, out RaycastHit hit))
                {
                    throw new InvalidOperationException(profile.Slug + " " + group + " spawn " + i + " has no ground below " + spawn + ".");
                }

                if (!profile.PlayBounds.Contains(hit.point))
                {
                    throw new InvalidOperationException(profile.Slug + " " + group + " spawn " + i + " resolves outside play bounds at " + hit.point + ".");
                }

                checkedSpawns++;
            }
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
