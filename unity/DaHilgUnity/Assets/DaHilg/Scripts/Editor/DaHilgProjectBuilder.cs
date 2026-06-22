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
        const string k_AnimalControllerDir = k_SettingsDir + "/AnimalControllers";
        const string k_PanelSettingsPath = k_Root + "/UI/DaHilgPanelSettings.asset";
        const string k_GeneratedAnimationDir = k_SettingsDir + "/GeneratedAnimations";
        // Heavy outdoor levels stream from StreamingAssets via glTFast at level-select instead
        // of being baked into the single WebGL data file (drops the initial download from ~75MB).
        // Keyed by slug; the runtime resolves "<slug>.glb" under Application.streamingAssetsPath.
        static readonly HashSet<string> s_StreamedLevelSlugs = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "dahill",
            "canyon",
            "stanton",
            "meemaw",
            "xq"
        };
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
        static readonly HashSet<string> s_StationaryHipClips = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "Idle",
            "Dance",
            "Wave",
            "Cheer",
            "Attack",
            "Hit"
        };
        static readonly string[] s_FootPinnedClips =
        {
            "Idle",
            "Dance",
            "Wave",
            "Cheer",
            "Attack"
        };

        [MenuItem("Da Hilg/Rebuild Unity Scene")]
        public static void RebuildUnityScene()
        {
            EnsureFolders();
            SyncSourceAssets();
            SyncSupplementalSourceAssets();
            Dictionary<string, AnimatorController> controllers = BuildAnimatorControllers();
            Dictionary<string, AnimatorController> animalControllers = BuildAnimalControllers();
            DaHilgLevelProfile[] levels = BuildLevelProfiles(animalControllers);
            DaHilgGameSettings settings = BuildSettings(levels, controllers);
            BuildScene(settings);
            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();
            Debug.Log("[DaHilg] Unity scene rebuilt.");
        }

        [MenuItem("Da Hilg/Build WebGL Export")]
        public static void BuildWebGLExport()
        {
            string projectRoot = Directory.GetParent(Application.dataPath)!.FullName;
            string repoRoot = Directory.GetParent(Directory.GetParent(projectRoot)!.FullName)!.FullName;
            string output = Path.Combine(repoRoot, "public/unity/da-hilg");
            bool scriptsOnly = Environment.GetEnvironmentVariable("DAHILG_UNITY_BUILD_SCRIPTS_ONLY") == "1";

            if (!scriptsOnly)
            {
                RebuildUnityScene();
                ValidateSpawnGroundingAssets();
                ValidateCharacterAnimationAssets();
                ValidateAnimalAnimationAssets();
            }
            else if (!Directory.Exists(output))
            {
                throw new InvalidOperationException("Scripts-only WebGL build requires an existing full export at " + output);
            }

            if (!scriptsOnly && Directory.Exists(output))
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
                options = scriptsOnly ? BuildOptions.BuildScriptsOnly : BuildOptions.None
            };

            BuildReport report = BuildPipeline.BuildPlayer(options);
            if (report.summary.result != BuildResult.Succeeded)
            {
                throw new InvalidOperationException("WebGL build failed: " + report.summary.result);
            }

            CustomizeWebGLExport(output);
            CleanupGeneratedBuildSidecars(projectRoot, output);
            Debug.Log("[DaHilg] WebGL export built at " + output + (scriptsOnly ? " (scripts only)." : "."));
        }

        // Secondary target: a local macOS .app for quick testing/playing. Web (WebGL) stays the
        // primary, shipped target — this just mirrors the same scene + StreamingAssets + scripting
        // defines (GLTFAST_BUILTIN_RP for the Built-in RP, GLTFAST_KEEP_MESH_DATA so streamed-level
        // MeshColliders bake) so the game behaves locally the way it does on the web. Streamed
        // levels resolve via DaHilgLevelRuntime.StreamGlbUrl's file:// branch on Standalone.
        [MenuItem("Da Hilg/Build Mac Standalone (local)")]
        public static void BuildMacStandalone()
        {
            string projectRoot = Directory.GetParent(Application.dataPath)!.FullName;
            string repoRoot = Directory.GetParent(Directory.GetParent(projectRoot)!.FullName)!.FullName;
            string output = Path.Combine(repoRoot, "build/DaHilg-Mac/DaHilg.app");
            bool scriptsOnly = Environment.GetEnvironmentVariable("DAHILG_UNITY_BUILD_SCRIPTS_ONLY") == "1";

            if (!scriptsOnly)
            {
                RebuildUnityScene();
                ValidateSpawnGroundingAssets();
                ValidateCharacterAnimationAssets();
                ValidateAnimalAnimationAssets();
            }

            string outDir = Path.GetDirectoryName(output);
            if (!string.IsNullOrEmpty(outDir)) Directory.CreateDirectory(outDir);

            EditorUserBuildSettings.SwitchActiveBuildTarget(BuildTargetGroup.Standalone, BuildTarget.StandaloneOSX);
            PlayerSettings.productName = "Da Hilg Unity";
            PlayerSettings.companyName = "Da Hilg";
            PlayerSettings.SetApplicationIdentifier(NamedBuildTarget.Standalone, "com.dahilg.unity");
            PlayerSettings.SetScriptingDefineSymbols(NamedBuildTarget.Standalone, "GLTFAST_BUILTIN_RP;GLTFAST_KEEP_MESH_DATA");

            BuildPlayerOptions options = new BuildPlayerOptions
            {
                scenes = new[] { k_ScenePath },
                locationPathName = output,
                target = BuildTarget.StandaloneOSX,
                options = scriptsOnly ? BuildOptions.BuildScriptsOnly : BuildOptions.None
            };

            BuildReport report = BuildPipeline.BuildPlayer(options);
            if (report.summary.result != BuildResult.Succeeded)
            {
                throw new InvalidOperationException("Mac standalone build failed: " + report.summary.result);
            }

            Debug.Log("[DaHilg] Mac standalone built at " + output + ".");
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

        [MenuItem("Da Hilg/Validate Animal Animations")]
        public static void ValidateAnimalAnimations()
        {
            RebuildUnityScene();
            ValidateAnimalAnimationAssets();
        }

        static void CleanupGeneratedBuildSidecars(string projectRoot, string output)
        {
            foreach (string dir in Directory.GetDirectories(output, "*", SearchOption.TopDirectoryOnly))
            {
                if (Path.GetFileName(dir).IndexOf("DoNotShip", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    Directory.Delete(dir, true);
                }
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

            // Cache-bust: the Build files have FIXED names but vercel.json serves them with an
            // immutable 1-year cache, so a redeploy reusing those names can hand a browser/CDN a
            // MISMATCHED old framework + new wasm -> "call_indirect signature mismatch" at load.
            // A per-build version query makes every build a fresh URL (and keeps immutable safe).
            string cacheBust = "?v=" + System.DateTime.UtcNow.Ticks.ToString("x");
            loaderUrl += cacheBust;
            dataUrl += cacheBust;
            frameworkUrl += cacheBust;
            codeUrl += cacheBust;

            string html = @"<!DOCTYPE html>
<html lang=""en-us"">
  <head>
    <meta charset=""utf-8"">
    <meta http-equiv=""Content-Type"" content=""text/html; charset=utf-8"">
    <meta name=""viewport"" content=""width=device-width, height=device-height, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover"">
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
            preserveDrawingBuffer: false
          };
        }
        return getCanvasContext(contextType, attributes);
      };

      function releasePointerLock() {
        if (document.pointerLockElement && document.exitPointerLock) {
          document.exitPointerLock();
        }
      }

      // NOTE: do NOT auto-release pointer lock on pointerlockchange — that cancelled the
      // right-click mouse-look on desktop the instant Unity acquired the lock. The input router
      // keeps the lock for continuous aim; Esc/browser unlock releases it.

      function focusCanvas() {
        try {
          canvas.focus({ preventScroll: true });
        } catch (_) {
          canvas.focus();
        }
      }

      function requestPointerLockFromGesture(event) {
        focusCanvas();
        if (!event || event.pointerType === 'touch') return;
        if (event.button !== 2 || document.pointerLockElement === canvas || !canvas.requestPointerLock) return;
        try {
          canvas.requestPointerLock();
        } catch (_) {
          // Unity's Cursor.lockState path is still attempted from C#; ignore browser denials here.
        }
      }

      window.__dahilg = {
        hudTapCount: 0,
        hudCommandCount: 0,
        hudErrors: [],
        lastHudPayload: null,
        lastHudCommand: null,
        unityReady: false
      };
      let unityInstanceRef = null;
      let lastHudTapKey = '';
      let lastHudTapTime = 0;

      function rememberHudError(error) {
        window.__dahilg.hudErrors.push(String(error && error.message ? error.message : error));
        if (window.__dahilg.hudErrors.length > 12) window.__dahilg.hudErrors.shift();
      }

      function compactCommandFromTap(x, y, width) {
        if (y < 0 || y > 76 || width <= 1) return null;
        const mobileScale = width < 900;
        const scale = mobileScale ? 0.62 : 1;
        const rightInset = mobileScale ? 8 : 18;
        const fromRight = width - x - rightInset;
        if (fromRight < 0) return null;
        const action = 90 * scale;
        const level = 96 * scale;
        const player = 106 * scale;
        const camera = 100 * scale;
        if (fromRight > action + level + player + camera) return null;
        if (fromRight <= action) return 'actions';
        if (fromRight <= action + level) return 'level';
        if (fromRight <= action + level + player) return 'player';
        return 'camera';
      }

      function sendHudCommand(command) {
        if (!unityInstanceRef || !command) return false;
        try {
          unityInstanceRef.SendMessage('DaHilgHUD', 'HandleWebHudCommand', command);
          window.__dahilg.hudCommandCount += 1;
          window.__dahilg.lastHudCommand = command;
          return true;
        } catch (error) {
          rememberHudError(error);
          return false;
        }
      }

      function sendHudTap(clientX, clientY, source) {
        if (!unityInstanceRef || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return;
        const rect = canvas.getBoundingClientRect();
        if (rect.width <= 1 || rect.height <= 1) return;
        const x = clientX - rect.left;
        const y = clientY - rect.top;
        if (x < 0 || y < 0 || x > rect.width || y > rect.height) return;
        const tapKey = `${Math.round(x)},${Math.round(y)}`;
        const now = performance.now();
        if (tapKey === lastHudTapKey && now - lastHudTapTime < 80) return;
        lastHudTapKey = tapKey;
        lastHudTapTime = now;

        focusCanvas();
        const command = compactCommandFromTap(x, y, rect.width);
        if (command && sendHudCommand(command)) return;

        const payload = [x, y, rect.width, rect.height]
          .map((value) => Number(value).toFixed(2))
          .join(',');
        try {
          unityInstanceRef.SendMessage('DaHilgHUD', 'HandleWebTouchTap', payload);
          window.__dahilg.hudTapCount += 1;
          window.__dahilg.lastHudPayload = `${source || 'touch'}:${payload}`;
        } catch (error) {
          rememberHudError(error);
        }
      }

      canvas.addEventListener('contextmenu', (event) => event.preventDefault());
      canvas.addEventListener('pointerdown', requestPointerLockFromGesture);
      // Keep the canvas focused for mouse-look across the gestures that commonly steal focus.
      window.addEventListener('focus', focusCanvas);
      window.addEventListener('pointerup', focusCanvas);
      document.addEventListener('click', focusCanvas);
      document.addEventListener('pointerlockchange', focusCanvas);
      function handleHudTouchStart(event) {
        if (event.changedTouches && event.changedTouches.length) {
          const touch = event.changedTouches[0];
          sendHudTap(touch.clientX, touch.clientY, 'touchstart');
        }
      }
      function handleHudPointerDown(event) {
        if (event.pointerType === 'touch') {
          sendHudTap(event.clientX, event.clientY, 'pointerdown');
        }
      }
      canvas.addEventListener('touchstart', handleHudTouchStart, { passive: true });
      canvas.addEventListener('pointerdown', handleHudPointerDown, { passive: true });
      document.addEventListener('touchstart', handleHudTouchStart, { capture: true, passive: true });
      document.addEventListener('pointerdown', handleHudPointerDown, { capture: true, passive: true });

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

      // Reliable browser touch verdict (mobile web). Used by Unity to select the mobile budgets and
      // to drive the on-screen controls. Do not redirect phones to the house: the intended default
      // spawn is outdoors on the street in front of the Dahill house.
      var __dahilgTouch = (navigator.maxTouchPoints > 0 || 'ontouchstart' in window)
        && !(window.matchMedia && window.matchMedia('(any-pointer:fine)').matches);
      window.__dahilg.touchMode = __dahilgTouch;
      try {
        if (__dahilgTouch) {
          var touchUrl = new URL(location.href);
          if (touchUrl.searchParams.get('dahilgTouch') !== '1') {
            touchUrl.searchParams.set('dahilgTouch', '1');
            history.replaceState(null, '', touchUrl.toString());
          }
        }
      } catch (lvlErr) { rememberHudError(lvlErr); }

      const config = {
        arguments: [],
        dataUrl: '__DATA_URL__',
        frameworkUrl: '__FRAMEWORK_URL__',
        codeUrl: '__CODE_URL__',
        streamingAssetsUrl: 'StreamingAssets',
        companyName: 'Da Hilg',
        productName: 'Da Hilg Unity',
        productVersion: '1.2',
        webglContextAttributes: { alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 2 },
        showBanner: unityShowBanner
      };

      // Cap the framebuffer hard on mobile: a 3x retina iPhone at DPR 1.75 renders ~3x the pixels
      // and OOM-crashes Safari. DPR 1 on touch devices is a large memory saving; desktop keeps 1.75.
      config.devicePixelRatio = __dahilgTouch ? 1 : Math.min(window.devicePixelRatio || 1, 1.75);
      document.querySelector('#unity-loading-bar').style.display = 'grid';

      const script = document.createElement('script');
      script.src = '__LOADER_URL__';
      script.onload = () => {
        createUnityInstance(canvas, config, (progress) => {
          document.querySelector('#unity-progress-bar-full').style.width = `${100 * progress}%`;
        }).then((unityInstance) => {
          unityInstanceRef = unityInstance;
          window.__dahilg.unityInstance = unityInstance;
          window.__dahilg.unityReady = true;
          document.querySelector('#unity-loading-bar').style.display = 'none';
          try {
            // Authoritative touch detection from the BROWSER (reliable on mobile web, unlike
            // Unity's WebGL device detection which can't tell a phone from a desktop). A touch
            // device has touch points and no fine pointer (mouse/trackpad). Drives the on-screen
            // joystick/look/buttons so the game is playable on a phone.
            var touchDevice = (navigator.maxTouchPoints > 0 || 'ontouchstart' in window)
              && !(window.matchMedia && window.matchMedia('(any-pointer:fine)').matches);
            window.__dahilg.touchMode = touchDevice;
            unityInstance.SendMessage('DaHilgHUD', 'SetWebTouchMode', touchDevice ? 1 : 0);
          } catch (touchErr) { rememberHudError(touchErr); }
          // Bind keyboard to the WHOLE document, not just the focused canvas. Without this, real
          // WASD/arrow keys are silently dropped on desktop whenever the canvas loses focus (which
          // it does constantly). This is the actual reason desktop controls 'didn't work'.
          if (unityInstance.Module) {
            unityInstance.Module.WebGLInput = unityInstance.Module.WebGLInput || {};
            unityInstance.Module.WebGLInput.captureAllKeyboardInput = true;
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
            string webSource = Path.Combine(repoRoot, "public/da-hilg");
            if (!Directory.Exists(webSource))
            {
                Debug.LogWarning("[DaHilg] Source asset folder not found: " + webSource);
                return;
            }

            BuildUnitySourceAssetBridge(repoRoot);
            string source = Path.Combine(projectRoot, "Library/DaHilgUnitySource");
            if (!Directory.Exists(source))
            {
                throw new DirectoryNotFoundException("Unity source asset bridge did not produce " + source);
            }

            CopyFiles(source, Path.Combine(Application.dataPath, "DaHilg/Art/Characters"), "*.glb", "drew", "cece", "mike", "kelli");
            CopyFiles(source, Path.Combine(Application.dataPath, "DaHilg/Art/Levels"), "*.glb", "level", "canyon", "stanton", "meemaw", "xq");
            CopyFiles(source, Path.Combine(Application.dataPath, "DaHilg/Art"), "*.glb", "sun3d");
            CopyFiles(Path.Combine(source, "anims"), Path.Combine(Application.dataPath, "DaHilg/Art/Animations"), "*.glb");
            CopyFiles(source, Path.Combine(Application.dataPath, "DaHilg/Data"), "*.json");
            CopyFiles(source, Path.Combine(Application.dataPath, "DaHilg/Art/Textures"), "sun.png");
            AssetDatabase.Refresh();
            Debug.Log("[DaHilg] Source assets synced.");
        }

        static void BuildUnitySourceAssetBridge(string repoRoot)
        {
            string script = Path.Combine(repoRoot, "scripts/build_dahilg_unity_assets.mjs");
            if (!File.Exists(script))
            {
                throw new FileNotFoundException("Missing Unity asset bridge script.", script);
            }

            System.Diagnostics.ProcessStartInfo startInfo = new System.Diagnostics.ProcessStartInfo
            {
                FileName = "/usr/bin/env",
                Arguments = "node " + QuoteArg(script),
                WorkingDirectory = repoRoot,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };

            using System.Diagnostics.Process process = System.Diagnostics.Process.Start(startInfo);
            string output = process!.StandardOutput.ReadToEnd();
            string error = process.StandardError.ReadToEnd();
            process.WaitForExit();
            if (!string.IsNullOrWhiteSpace(output)) Debug.Log("[DaHilg] Unity asset bridge:\n" + output.Trim());
            if (!string.IsNullOrWhiteSpace(error)) Debug.LogWarning("[DaHilg] Unity asset bridge warnings:\n" + error.Trim());
            if (process.ExitCode != 0)
            {
                throw new InvalidOperationException("Unity asset bridge failed with exit code " + process.ExitCode);
            }
        }

        static string QuoteArg(string value)
        {
            return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
        }

        [MenuItem("Da Hilg/Sync Supplemental Assets From Web")]
        public static void SyncSupplementalSourceAssets()
        {
            string projectRoot = Directory.GetParent(Application.dataPath)!.FullName;
            string repoRoot = Directory.GetParent(Directory.GetParent(projectRoot)!.FullName)!.FullName;
            string sourceAssets = Path.Combine(repoRoot, "src/assets");
            if (!Directory.Exists(sourceAssets))
            {
                Debug.LogWarning("[DaHilg] Supplemental asset folder not found: " + sourceAssets);
                return;
            }

            CopyFiles(sourceAssets, Path.Combine(Application.dataPath, "DaHilg/Art/Animals"), "*.glb", "pig", "duck");
            AssetDatabase.Refresh();
            Debug.Log("[DaHilg] Supplemental source assets synced.");
        }

        static void EnsureFolders()
        {
            string[] folders =
            {
                k_Root,
                k_Root + "/Art",
                k_Root + "/Art/Characters",
                k_Root + "/Art/Levels",
                k_Root + "/Art/Animals",
                k_Root + "/Art/Animations",
                k_Root + "/Data",
                k_Root + "/Scenes",
                k_Root + "/Scripts",
                k_Root + "/UI",
                k_SettingsDir,
                k_CharacterControllerDir,
                k_AnimalControllerDir,
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

        static Dictionary<string, AnimatorController> BuildAnimalControllers()
        {
            Dictionary<string, AnimatorController> controllers = new Dictionary<string, AnimatorController>();
            controllers["pig"] = BuildAnimalController("pig");
            controllers["duck"] = BuildAnimalController("duck");
            return controllers;
        }

        static AnimatorController BuildAnimalController(string id)
        {
            string modelPath = k_Root + "/Art/Animals/" + id + ".glb";
            GameObject model = AssetDatabase.LoadAssetAtPath<GameObject>(modelPath);
            if (model == null)
            {
                throw new InvalidOperationException("Missing Da Hilg animal prefab: " + id + ".");
            }

            AnimationClip clip = FirstAnimationClip(modelPath);
            if (clip == null)
            {
                throw new InvalidOperationException("Missing Da Hilg animal animation clip: " + id + ".");
            }

            string controllerPath = k_AnimalControllerDir + "/" + id + ".controller";
            AnimatorController controller = AssetDatabase.LoadAssetAtPath<AnimatorController>(controllerPath);
            if (controller != null && (controller.layers == null || controller.layers.Length == 0))
            {
                AssetDatabase.DeleteAsset(controllerPath);
                controller = null;
            }
            if (controller == null)
            {
                controller = AnimatorController.CreateAnimatorControllerAtPath(controllerPath);
            }

            AnimatorStateMachine machine = controller.layers[0].stateMachine;
            ClearStates(machine);
            AnimatorState move = machine.AddState("Move", new Vector3(260f, 80f, 0f));
            move.motion = clip;
            move.writeDefaultValues = true;
            machine.defaultState = move;
            EditorUtility.SetDirty(controller);
            return controller;
        }

        static AnimationClip FirstAnimationClip(string assetPath)
        {
            UnityEngine.Object[] assets = AssetDatabase.LoadAllAssetsAtPath(assetPath);
            for (int i = 0; i < assets.Length; i++)
            {
                if (assets[i] is AnimationClip clip && !clip.name.StartsWith("__", StringComparison.Ordinal))
                {
                    return clip;
                }
            }
            return null;
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
            bool lockPlanar = s_StationaryHipClips.Contains(stateName);

            for (int i = 0; i < times.Count; i++)
            {
                float time = times[i];
                Vector3 sourceAnimated = new Vector3(
                    sourceCurves[0].Evaluate(time),
                    sourceCurves[1].Evaluate(time),
                    sourceCurves[2].Evaluate(time));
                Vector3 targetAnimated = targetRest + (sourceAnimated - sourceRest);
                if (lockPlanar)
                {
                    targetAnimated.x = targetRest.x;
                    targetAnimated.z = targetRest.z;
                }
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

        static DaHilgLevelProfile[] BuildLevelProfiles(Dictionary<string, AnimatorController> animalControllers)
        {
            return new[]
            {
                BuildLevel("dahill", "1840 Dahill", "Home neighborhood", "level", "level.meta", "minimap", animalControllers),
                BuildLevel("canyon", "Canyon Middle", "Castro Valley", "canyon", "canyon.meta", "canyon.minimap", animalControllers),
                BuildLevel("stanton", "Stanton Elementary", "Castro Valley", "stanton", "stanton.meta", "stanton.minimap", animalControllers),
                BuildLevel("meemaw", "Meemaw's", "Castro Valley", "meemaw", "meemaw.meta", "meemaw.minimap", animalControllers),
                BuildLevel("xq", "XQ", "807 Broadway, Oakland", "xq", "xq.meta", "xq.minimap", animalControllers),
                BuildInteriorLevel()
            };
        }

        static DaHilgLevelProfile BuildLevel(string slug, string label, string subLabel, string glbName, string metaName, string minimapName, Dictionary<string, AnimatorController> animalControllers)
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
            string levelGlbPath = k_Root + "/Art/Levels/" + glbName + ".glb";
            GameObject levelPrefab = AssetDatabase.LoadAssetAtPath<GameObject>(levelGlbPath);
            if (s_StreamedLevelSlugs.Contains(slug))
            {
                // Ship this level's GLB as a standalone StreamingAssets file (loaded at runtime
                // via glTFast) and clear the baked prefab reference so Unity does NOT bake the
                // mesh into the WebGL data file. Geometry validation falls back to the prefab.
                StageStreamingLevelGlb(slug, levelGlbPath);
                StageStreamingOverlayGlb(slug);
                profile.LevelPrefab = null;
            }
            else
            {
                profile.LevelPrefab = levelPrefab;
            }
            if (levelPrefab == null)
            {
                Debug.LogWarning("Da Hilg level '" + slug + "' is missing its prefab at " + levelGlbPath + "; building profile without geometry.");
            }
            profile.SourceMeta = AssetDatabase.LoadAssetAtPath<TextAsset>(k_Root + "/Data/" + metaName + ".json");
            profile.Minimap = AssetDatabase.LoadAssetAtPath<TextAsset>(k_Root + "/Data/" + minimapName + ".json");

            string json = profile.SourceMeta != null ? profile.SourceMeta.text : string.Empty;
            profile.LevelOffset = ExtractFirstVector(json, "offset");
            Vector3[] spawns = ExtractVectorArray(json, "spawns");
            Vector3[] npcSpawns = ExtractVectorArray(json, "npcSpawns");
            if (spawns.Length == 0) spawns = new[] { new Vector3(0f, 0.05f, 12f) };
            // Street-front spawn and facing are computed per level in build_dahilg_overlay from
            // road geometry. Keep that authoring direction so the first frame starts oriented
            // toward the intended route instead of re-inferring from the house bounds.
            if (json.IndexOf("\"streetSpawn\"", StringComparison.Ordinal) >= 0)
            {
                List<Vector3> ordered = new List<Vector3>(spawns.Length + 1) { ExtractFirstVector(json, "streetSpawn") };
                ordered.AddRange(spawns);
                spawns = ordered.ToArray();
            }
            profile.HasPlayerSpawnYaw = TryExtractFloat(json, "facing", out float facing);
            profile.PlayerSpawnYaw = profile.HasPlayerSpawnYaw ? facing : 0f;
            profile.WaterHeightOffset = TryExtractFloat(json, "waterHeightOffset", out float waterHeightOffset)
                ? Mathf.Clamp(waterHeightOffset, 0.045f, 0.16f)
                : 0.1f;
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
                new DaHilgBoxZone { Id = "safe_start", Label = "Start", Center = new Vector3(spawns[0].x, 6f, spawns[0].z), Size = new Vector3(36f, 18f, 36f) },
                new DaHilgBoxZone { Id = "safe_home", Label = "Home", Center = new Vector3(house.center.x, 4f, house.center.z), Size = new Vector3(44f, 400f, 44f) },
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
            profile.AnimalSpawns = slug == "dahill" ? BuildDahillAnimalSpawns(animalControllers) : Array.Empty<DaHilgAnimalSpawn>();
            profile.PlayBounds = new Bounds(Vector3.zero, slug == "dahill" ? new Vector3(230f, 120f, 230f) : new Vector3(420f, 160f, 420f));
            EditorUtility.SetDirty(profile);
            return profile;
        }

        static DaHilgLevelProfile BuildInteriorLevel()
        {
            const string slug = "house";
            string assetPath = k_SettingsDir + "/Level_" + slug + ".asset";
            DaHilgLevelProfile profile = AssetDatabase.LoadAssetAtPath<DaHilgLevelProfile>(assetPath);
            if (profile == null)
            {
                profile = ScriptableObject.CreateInstance<DaHilgLevelProfile>();
                AssetDatabase.CreateAsset(profile, assetPath);
            }

            profile.Slug = slug;
            profile.Label = "Inside House";
            profile.SubLabel = "Scoop interior";
            profile.LevelPrefab = AssetDatabase.LoadAssetAtPath<GameObject>(k_Root + "/Art/Levels/house-interior.glb");
            if (profile.LevelPrefab == null)
            {
                throw new InvalidOperationException("Missing Da Hilg house interior prefab.");
            }
            profile.SourceMeta = null;
            profile.Minimap = null;
            profile.LevelOffset = new Vector3(0.045f, -1.402f, -0.063f);
            profile.PlayerSpawns = new[] { new Vector3(0f, 0.08f, 0f) };
            profile.HasPlayerSpawnYaw = true;
            profile.PlayerSpawnYaw = 180f;
            profile.WaterHeightOffset = 0f;
            profile.NpcSpawns = new[]
            {
                new Vector3(1.9f, 0.08f, 2.4f),
                new Vector3(-1.8f, 0.08f, 2.0f),
                new Vector3(1.6f, 0.08f, -2.5f)
            };
            profile.GreetSafeZones = new[]
            {
                new DaHilgBoxZone { Id = "house_living", Label = "Living Room", Center = new Vector3(0f, 1.2f, 0f), Size = new Vector3(5.2f, 3f, 5.8f) }
            };
            profile.NibblerSafeZones = new[]
            {
                new DaHilgBoxZone { Id = "house_entry", Label = "Entry", Center = new Vector3(0f, 1.4f, -6.2f), Size = new Vector3(4.8f, 3f, 3.8f) }
            };
            profile.DangerZones = new[]
            {
                new DaHilgBoxZone { Id = "house_kitchen", Label = "Kitchen Swarm", Center = new Vector3(0f, 1.4f, 4.6f), Size = new Vector3(8.8f, 3.2f, 7.4f) },
                new DaHilgBoxZone { Id = "house_hall", Label = "Hallway Swarm", Center = new Vector3(0f, 1.4f, -1.9f), Size = new Vector3(7.6f, 3.2f, 7.6f) },
                new DaHilgBoxZone { Id = "house_rooms", Label = "Room Swarm", Center = new Vector3(0f, 1.4f, 1.2f), Size = new Vector3(9.6f, 3.2f, 5.8f) }
            };
            profile.AnimalSpawns = Array.Empty<DaHilgAnimalSpawn>();
            profile.PlayBounds = new Bounds(new Vector3(0f, 2f, 0f), new Vector3(18f, 8f, 34f));
            EditorUtility.SetDirty(profile);
            return profile;
        }

        static DaHilgAnimalSpawn[] BuildDahillAnimalSpawns(Dictionary<string, AnimatorController> animalControllers)
        {
            animalControllers.TryGetValue("pig", out AnimatorController pigController);
            animalControllers.TryGetValue("duck", out AnimatorController duckController);
            return new[]
            {
                new DaHilgAnimalSpawn
                {
                    Id = "pig",
                    Label = "Pig",
                    Prefab = AssetDatabase.LoadAssetAtPath<GameObject>(k_Root + "/Art/Animals/pig.glb"),
                    AnimatorController = pigController,
                    Count = 5,
                    Home = new Vector3(7.5f, 0.1f, 55f),
                    WanderRadius = 5.5f,
                    Speed = 0.55f,
                    Scale = 0.13f,
                    VisualYawOffset = 90f
                },
                new DaHilgAnimalSpawn
                {
                    Id = "duck",
                    Label = "Duck",
                    Prefab = AssetDatabase.LoadAssetAtPath<GameObject>(k_Root + "/Art/Animals/duck.glb"),
                    AnimatorController = duckController,
                    Count = 2,
                    Home = new Vector3(4f, 0.1f, 50.3f),
                    WanderRadius = 4.5f,
                    Speed = 0.8f,
                    Scale = 0.16f,
                    VisualYawOffset = 90f
                }
            };
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
            settings.DefaultMode = DaHilgGameMode.Nibblers;
            settings.DefaultCameraMode = DaHilgCameraMode.ThirdPerson;
            settings.CameraSensitivity = 0.09f;
            settings.TouchSensitivity = 0.11f;
            settings.ThirdPersonDistance = 5.2f;
            settings.ThirdPersonMinDistance = 0.82f;
            settings.ThirdPersonPivotHeight = 1.62f;
            settings.ShoulderOffset = new Vector2(0.38f, 0.08f);
            settings.ControllerSkinWidth = 0.06f;
            settings.GroundProbeHeight = 3.4f;
            settings.GroundSnapDistance = 1.55f;
            settings.GroundSkin = 0.05f;
            settings.NibblerPoolSize = 36;
            settings.OverwhelmStagger = 7;
            settings.OverwhelmDown = 15;
            settings.OverwhelmStop = 24;
            settings.DangerNibblerBonus = 9;
            settings.DangerSpawnInterval = 0.14f;
            settings.NormalSpawnInterval = 0.48f;
            settings.MarkedDuration = 3.1f;
            settings.AttachmentFlashDuration = 0.58f;
            settings.RollCooldown = 1.55f;
            settings.RollDuration = 0.78f;
            settings.RollSpeed = 5.7f;
            settings.RollCrushRadius = 1.38f;
            settings.RollCrushBodyHeight = 1.08f;
            settings.RollCrushScore = 35;
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

            Color skyTint = new Color(0.55f, 0.72f, 0.92f);
            Material skybox = LoadOrCreateSkyboxMaterial(skyTint);
            RenderSettings.skybox = skybox;

            RenderSettings.ambientMode = UnityEngine.Rendering.AmbientMode.Skybox;
            RenderSettings.ambientIntensity = 0.78f;   // was 1.15 — over-bright skybox ambient washed out the textures (esp. with the pale ETC1S textures); lower restores contrast/saturation
            RenderSettings.ambientSkyColor = new Color(0.62f, 0.70f, 0.74f);
            RenderSettings.ambientEquatorColor = new Color(0.42f, 0.46f, 0.44f);
            RenderSettings.ambientGroundColor = new Color(0.24f, 0.26f, 0.20f);

            RenderSettings.fog = true;
            RenderSettings.fogMode = FogMode.Linear;
            RenderSettings.fogColor = skyTint;
            RenderSettings.fogStartDistance = 120f;
            RenderSettings.fogEndDistance = 520f;

            GameObject sun = new GameObject("Sun");
            Light light = sun.AddComponent<Light>();
            light.type = LightType.Directional;
            light.intensity = 1.1f;
            light.color = new Color(1f, 0.96f, 0.86f);
            light.shadows = LightShadows.Soft;
            light.shadowStrength = 0.72f;
            sun.transform.rotation = Quaternion.Euler(48f, -38f, 0f);
            // Drive the Skybox/Procedural sun disk from this light so the sky's sun and
            // the directional lighting agree (otherwise Unity uses the brightest light).
            RenderSettings.sun = light;
            // Bake skybox-based ambient now that the sun (which positions the sky disk) is set.
            DynamicGI.UpdateEnvironment();

            // Custom 3D SUN model (sun3d.glb) hung far in the sky along the sun direction, so the
            // real authored sun is visible (matches the web build) on top of the procedural disk.
            // Auto-scaled to a consistent on-sky size regardless of the source model's units, and
            // forced emissive + shadowless so it reads as a glowing sun rather than a lit object.
            GameObject sunPrefab = AssetDatabase.LoadAssetAtPath<GameObject>(k_Root + "/Art/sun3d.glb");
            if (sunPrefab != null)
            {
                GameObject sunModel = (GameObject)UnityEngine.Object.Instantiate(sunPrefab);
                sunModel.name = "Sun3D";
                Renderer[] sunRenderers = sunModel.GetComponentsInChildren<Renderer>();
                if (sunRenderers.Length > 0)
                {
                    Bounds b = sunRenderers[0].bounds;
                    for (int i = 1; i < sunRenderers.Length; i++) b.Encapsulate(sunRenderers[i].bounds);
                    float dia = Mathf.Max(0.01f, b.size.magnitude);
                    sunModel.transform.localScale *= 46f / dia;   // ~46 m across at 480 m -> a believable sky sun
                }
                Vector3 sunDir = -light.transform.forward;        // up into the sky, opposite the light travel
                sunModel.transform.position = sunDir * 480f;
                sunModel.transform.rotation = Quaternion.LookRotation(-sunDir, Vector3.up);
                foreach (Renderer r in sunRenderers)
                {
                    r.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
                    r.receiveShadows = false;
                    foreach (Material m in r.sharedMaterials)
                    {
                        if (m == null) continue;
                        m.EnableKeyword("_EMISSION");
                        m.globalIlluminationFlags = MaterialGlobalIlluminationFlags.RealtimeEmissive;
                        m.SetColor("_EmissionColor", new Color(1f, 0.94f, 0.72f) * 2.4f);
                    }
                }
            }

            GameObject cameraObject = new GameObject("Main Camera");
            cameraObject.tag = "MainCamera";
            Camera camera = cameraObject.AddComponent<Camera>();
            camera.clearFlags = CameraClearFlags.Skybox;
            camera.backgroundColor = skyTint;
            camera.nearClipPlane = 0.1f;
            camera.farClipPlane = RenderSettings.fogEndDistance + 40f;
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

        static Material LoadOrCreateSkyboxMaterial(Color skyTint)
        {
            const string skyboxPath = k_Root + "/Settings/DaHilgSkybox.mat";
            Material skybox = AssetDatabase.LoadAssetAtPath<Material>(skyboxPath);
            if (skybox == null)
            {
                Shader shader = Shader.Find("Skybox/Procedural");
                skybox = new Material(shader);
                AssetDatabase.CreateAsset(skybox, skyboxPath);
            }

            // _SunDisk = 2 (high quality) renders an actual sun disk; without it _SunSize
            // is ignored and no sun is drawn. The disk sits where RenderSettings.sun points.
            skybox.SetFloat("_SunDisk", 2f);
            skybox.SetFloat("_SunSize", 0.045f);
            skybox.SetFloat("_SunSizeConvergence", 5f);
            skybox.SetFloat("_AtmosphereThickness", 0.85f);
            skybox.SetColor("_SkyTint", skyTint);
            skybox.SetColor("_GroundColor", new Color(0.42f, 0.46f, 0.4f));
            skybox.SetFloat("_Exposure", 1.25f);
            EditorUtility.SetDirty(skybox);
            return skybox;
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

        static bool TryExtractFloat(string json, string key, out float value)
        {
            value = 0f;
            if (string.IsNullOrEmpty(json)) return false;

            Match match = Regex.Match(json, "\"" + Regex.Escape(key) + "\"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)");
            return match.Success
                && float.TryParse(match.Groups[1].Value, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out value);
        }

        static void ValidateSpawnGroundingAssets()
        {
            DaHilgGameSettings settings = AssetDatabase.LoadAssetAtPath<DaHilgGameSettings>(k_SettingsPath);
            if (settings == null) throw new InvalidOperationException("Da Hilg settings asset was not built.");

            int checkedSpawns = 0;
            for (int i = 0; i < settings.Levels.Length; i++)
            {
                DaHilgLevelProfile profile = settings.Levels[i];
                if (profile == null) continue;

                // Streamed levels carry a null baked prefab (mesh ships in StreamingAssets), so
                // load the source GLB straight from the asset path for editor-time validation.
                GameObject validationPrefab = profile.LevelPrefab != null
                    ? profile.LevelPrefab
                    : LoadStreamingLevelPrefab(profile.Slug);
                if (validationPrefab == null) continue;

                GameObject level = PrefabUtility.InstantiatePrefab(validationPrefab) as GameObject;
                if (level == null) level = UnityEngine.Object.Instantiate(validationPrefab);
                level.name = "SpawnValidation_" + profile.Slug;
                try
                {
                    DaHilgLevelRuntime.ApplyLevelOffset(level, profile);
                    DaHilgLevelRuntime.PrepareLevelColliders(level);
                    ValidateSpawnArray(profile, profile.PlayerSpawns, "player", ref checkedSpawns);
                    ValidateSpawnArray(profile, profile.NpcSpawns, "npc", ref checkedSpawns);
                    ValidateAnimalSpawnArray(profile, ref checkedSpawns);
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

        static void ValidateAnimalAnimationAssets()
        {
            DaHilgGameSettings settings = AssetDatabase.LoadAssetAtPath<DaHilgGameSettings>(k_SettingsPath);
            if (settings == null) throw new InvalidOperationException("Da Hilg settings asset was not built.");

            int checkedAnimals = 0;
            for (int i = 0; i < settings.Levels.Length; i++)
            {
                DaHilgLevelProfile profile = settings.Levels[i];
                if (profile == null || profile.AnimalSpawns == null) continue;

                for (int n = 0; n < profile.AnimalSpawns.Length; n++)
                {
                    DaHilgAnimalSpawn spawn = profile.AnimalSpawns[n];
                    if (spawn.Count <= 0) continue;
                    if (spawn.Prefab == null) throw new InvalidOperationException("Da Hilg animal prefab is missing for " + spawn.Id + ".");

                    AnimatorController controller = spawn.AnimatorController as AnimatorController;
                    if (controller == null) throw new InvalidOperationException("Da Hilg animal animation controller is missing for " + spawn.Id + ".");
                    if (controller.layers.Length == 0) throw new InvalidOperationException("Da Hilg animal animation controller has no layers for " + spawn.Id + ".");

                    AnimatorStateMachine machine = controller.layers[0].stateMachine;
                    if (machine == null || machine.defaultState == null || machine.defaultState.motion == null)
                    {
                        throw new InvalidOperationException("Da Hilg animal animation controller has no default motion for " + spawn.Id + ".");
                    }

                    checkedAnimals++;
                }
            }

            if (checkedAnimals == 0) throw new InvalidOperationException("No Da Hilg animal animation controllers were checked.");
            Debug.Log("[DaHilg] Animal animations validated for " + checkedAnimals + " spawn groups.");
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

                    ValidateGroundedEmoteFooting(slot.Id, bindingRoot, animator, machine);
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

        static void ValidateGroundedEmoteFooting(string owner, Transform bindingRoot, Animator animator, AnimatorStateMachine machine)
        {
            Transform leftFoot = FindDeepChild(bindingRoot, "LeftFoot");
            Transform rightFoot = FindDeepChild(bindingRoot, "RightFoot");
            if (leftFoot == null || rightFoot == null)
            {
                throw new InvalidOperationException(owner + " missing LeftFoot/RightFoot bones for grounded emote validation.");
            }

            float[] samples = { 0f, 0.16f, 0.33f, 0.5f, 0.66f, 0.84f };
            for (int i = 0; i < s_FootPinnedClips.Length; i++)
            {
                string stateName = s_FootPinnedClips[i];
                AnimatorState state = FindAnimatorState(machine, stateName);
                if (state == null || state.motion is not AnimationClip) continue;

                int hash = Animator.StringToHash("Base Layer." + stateName);
                animator.Rebind();
                animator.Update(0f);
                animator.Play(hash, 0, 0f);
                animator.Update(0f);
                float rest = MinFootY(leftFoot, rightFoot);
                float maxLift = 0f;
                float maxSink = 0f;

                for (int s = 0; s < samples.Length; s++)
                {
                    animator.Play(hash, 0, samples[s]);
                    animator.Update(0f);
                    float y = MinFootY(leftFoot, rightFoot);
                    maxLift = Mathf.Max(maxLift, y - rest);
                    maxSink = Mathf.Max(maxSink, rest - y);
                }

                if (maxLift > 0.52f || maxSink > 0.42f)
                {
                    throw new InvalidOperationException(owner + " " + stateName + " emote foot grounding drift is too high. Lift="
                        + maxLift.ToString("0.###") + " sink=" + maxSink.ToString("0.###") + ".");
                }
            }
        }

        static float MinFootY(Transform leftFoot, Transform rightFoot)
        {
            return Mathf.Min(leftFoot.position.y, rightFoot.position.y);
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

        static void ValidateAnimalSpawnArray(DaHilgLevelProfile profile, ref int checkedSpawns)
        {
            if (profile.AnimalSpawns == null) return;

            for (int i = 0; i < profile.AnimalSpawns.Length; i++)
            {
                DaHilgAnimalSpawn spawn = profile.AnimalSpawns[i];
                if (spawn.Count <= 0) continue;
                ValidateSpawnArray(profile, new[] { spawn.Home }, "animal " + spawn.Id, ref checkedSpawns);
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

        // Source GLB basename for a streamed level slug. Matches the slug-to-glbName mapping in
        // BuildLevelProfiles (only "dahill" diverges, sourced from level.glb).
        static string StreamingLevelGlbName(string slug)
        {
            return string.Equals(slug, "dahill", StringComparison.OrdinalIgnoreCase) ? "level" : slug;
        }

        static string StreamingLevelUnitySourceName(string slug)
        {
            return string.Equals(slug, "dahill", StringComparison.OrdinalIgnoreCase)
                ? "dahill-single.glb"
                : slug + "-single.glb";
        }

        // Copy a streamed level's source GLB into the project StreamingAssets folder as
        // "<slug>.glb" so it ships as a standalone file under the WebGL build's StreamingAssets
        // URL (resolved at runtime by DaHilgLevelRuntime), rather than baked into the data file.
        static void StageStreamingLevelGlb(string slug, string sourceAssetPath)
        {
            // Prefer the Unity-streaming GLB built by scripts/build_dahilg_unity_assets.mjs: it keeps
            // meshopt geometry compression but preserves JPEG/PNG textures. The streets, sidewalks,
            // and photo facades are texture-baked into the single-surface level, so streaming the
            // public KTX2 web GLB makes the level unreadable whenever Unity/WebGL/iOS KTX import fails.
            // Fall back to raw exports/<slug>-single.glb, then the public web GLB, then the decoded
            // Asset copy so ad-hoc editor builds still work.
            string projectRoot = Directory.GetParent(Application.dataPath)!.FullName;
            string repoRoot = Directory.GetParent(Directory.GetParent(projectRoot)!.FullName)!.FullName;
            string unityOptimized = Path.Combine(projectRoot, "Library", "DaHilgUnitySource", "Streaming", slug + ".glb");
            string rawSingle = Path.Combine(repoRoot, "exports", StreamingLevelUnitySourceName(slug));
            string webCompressed = Path.Combine(repoRoot, "public", "da-hilg", StreamingLevelGlbName(slug) + ".glb");
            string decodedAsset = Path.Combine(projectRoot, sourceAssetPath.Replace('/', Path.DirectorySeparatorChar));
            string sourceFull = File.Exists(unityOptimized) ? unityOptimized
                : File.Exists(rawSingle) ? rawSingle
                : File.Exists(webCompressed) ? webCompressed
                : decodedAsset;
            if (!File.Exists(sourceFull))
            {
                Debug.LogWarning("[DaHilg] Streamed level GLB missing for '" + slug + "'; skipping StreamingAssets stage.");
                return;
            }

            // Filename = "<slug>.glb" at the StreamingAssets root; the runtime resolves it as
            // Application.streamingAssetsPath + "/" + slug + ".glb" (see DaHilgLevelRuntime).
            string streamingDir = Application.streamingAssetsPath;
            Directory.CreateDirectory(streamingDir);
            File.Copy(sourceFull, Path.Combine(streamingDir, slug + ".glb"), true);
            string sourceKind = sourceFull == unityOptimized ? "Unity stream GLB"
                : sourceFull == rawSingle ? "raw single-surface GLB"
                : sourceFull == webCompressed ? "compressed web GLB fallback"
                : "decoded asset";
            Debug.Log("[DaHilg] Staged streamed level '" + slug + "' (" + sourceKind + ").");
        }

        // Ship the vegetation+water OVERLAY GLB (public/da-hilg/<name>_overlay.glb: creek + instanced
        // trees/grass that the single-surface env drops) to StreamingAssets/<slug>_overlay.glb. The
        // runtime loads it on top of the env at the same offset. Optional — absent overlay is fine.
        static void StageStreamingOverlayGlb(string slug)
        {
            string projectRoot = Directory.GetParent(Application.dataPath)!.FullName;
            string repoRoot = Directory.GetParent(Directory.GetParent(projectRoot)!.FullName)!.FullName;
            string overlay = Path.Combine(repoRoot, "public", "da-hilg", StreamingLevelGlbName(slug) + "_overlay.glb");
            if (!File.Exists(overlay)) return;
            string streamingDir = Application.streamingAssetsPath;
            Directory.CreateDirectory(streamingDir);
            File.Copy(overlay, Path.Combine(streamingDir, slug + "_overlay.glb"), true);
            Debug.Log("[DaHilg] Staged vegetation/water overlay for '" + slug + "'.");
        }

        // Load a streamed level's source GLB prefab straight from Assets (used for editor-time
        // validation, since the baked LevelPrefab reference is intentionally null for streamed levels).
        static GameObject LoadStreamingLevelPrefab(string slug)
        {
            if (!s_StreamedLevelSlugs.Contains(slug)) return null;
            return AssetDatabase.LoadAssetAtPath<GameObject>(k_Root + "/Art/Levels/" + StreamingLevelGlbName(slug) + ".glb");
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
