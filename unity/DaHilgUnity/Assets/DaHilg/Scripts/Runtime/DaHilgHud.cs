using System;
using System.Collections.Generic;
using System.Globalization;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.Scripting;
using UnityEngine.UIElements;

namespace DaHilg
{
    [RequireComponent(typeof(UIDocument))]
    public sealed class DaHilgHud : MonoBehaviour
    {
        // ── Driving-game theme tokens (mirrors src/styles.css :root) ─────────────
        // Square chrome (radius 0), nav-app glass panels, AGC numbers + Chakra-style
        // kicker labels. Every color below is the hex from styles.css converted to
        // Unity's 0..1 RGBA so the Unity HUD reads as the same product.
        static readonly Color k_Nav = new Color(0.176f, 0.549f, 1f, 1f);        // --nav  #2D8CFF
        static readonly Color k_Go = new Color(0.169f, 0.910f, 0.310f, 1f);     // --go   #2BE84F
        static readonly Color k_Coin = new Color(1f, 0.784f, 0.239f, 1f);       // --coin #FFC83D
        static readonly Color k_Reverse = new Color(1f, 0.322f, 0.278f, 1f);    // --reverse #FF5247
        static readonly Color k_Jump = new Color(0.608f, 0.482f, 1f, 1f);       // --jump #9B7BFF
        static readonly Color k_Glass = new Color(0.031f, 0.039f, 0.055f, 0.66f); // --hud-glass
        static readonly Color k_GlassDeep = new Color(0.039f, 0.047f, 0.063f, 0.82f);
        static readonly Color k_PanelDeep = new Color(0.039f, 0.047f, 0.063f, 0.95f);
        static readonly Color k_Line = new Color(1f, 1f, 1f, 0.18f);            // --hud-line
        static readonly Color k_Text = new Color(0.957f, 0.945f, 0.917f, 1f);   // --txt
        static readonly Color k_TextDim = new Color(1f, 1f, 1f, 0.5f);
        static readonly Color k_TextFaint = new Color(1f, 1f, 1f, 0.62f);
        static readonly Color k_Fill = new Color(1f, 1f, 1f, 0.05f);
        static readonly Color k_FillHi = new Color(1f, 1f, 1f, 0.1f);

        DaHilgGameManager m_Manager;
        DaHilgInputRouter m_Input;
        VisualElement m_Root;
        Font m_AgcFont;
        Font m_AgcHeavyFont;
        Label m_Title;
        Label m_State;
        Label m_Score;
        Label m_Prompt;
        Label m_Mode;
        Label m_Attached;
        VisualElement m_HealthFill;
        VisualElement m_TopPanel;
        VisualElement m_TopPanelBody;
        Button m_TopCollapseButton;
        VisualElement m_TopCompactStrip;
        Label m_TopCompactLabel;
        bool m_TopPanelCollapsed;
        VisualElement m_MarkOverlay;
        Label m_MarkLabel;
        VisualElement m_NibblerMeter;
        VisualElement m_NibblerFill;
        Label m_RollState;
        DaHilgMinimapElement m_Minimap;
        VisualElement m_CharacterBar;
        VisualElement m_EmoteBar;
        VisualElement m_CameraBar;
        VisualElement m_LevelBar;
        VisualElement m_MoveZone;
        VisualElement m_LookZone;
        VisualElement m_Joy;
        VisualElement m_Knob;
        Button m_RunButton;
        Button m_JumpButton;
        Button m_RollButton;
        Button m_PunchButton;
        VisualElement m_CompactBar;
        VisualElement m_CompactPanel;
        Button m_CompactCameraButton;
        Button m_CompactPlayerButton;
        Button m_CompactLevelButton;
        Button m_CompactMenuButton;
        VisualElement m_LevelDialog;
        VisualElement m_LevelDialogPanel;
        Label m_LevelDialogTitle;
        Button m_LevelConfirmButton;
        Button m_LevelCancelButton;
        int m_JoyPointer = -1;
        int m_LookPointer = -1;
        Vector2 m_JoyCenter;
        Vector2 m_LookLast;
        readonly List<Button> m_CharacterButtons = new List<Button>(4);
        readonly List<Button> m_EmoteButtons = new List<Button>(4);
        readonly List<Button> m_CameraButtons = new List<Button>(5);
        readonly List<Button> m_LevelButtons = new List<Button>(4);
        readonly List<Button> m_CompactCharacterButtons = new List<Button>(4);
        readonly List<Button> m_CompactEmoteButtons = new List<Button>(4);
        readonly List<Button> m_CompactCameraButtons = new List<Button>(5);
        readonly List<Button> m_CompactLevelButtons = new List<Button>(4);
        readonly List<Button> m_LevelDialogButtons = new List<Button>(4);
        readonly List<MenuEntry> m_MenuEntries = new List<MenuEntry>(16);
        int m_SelectedMenuIndex = -1;
        bool m_MenuFocused;
        bool m_CompactMenuOpen;
        bool m_LevelDialogOpen;
        string m_PendingLevelSlug;
        float m_LastHudActivationTime = -10f;

        const float k_JoySize = 132f;
        const float k_JoyKnobSize = 48f;
        const float k_JoyRadius = 54f;

        struct MenuEntry
        {
            public Button Button;
            public int Row;
            public int Column;
            public Action Activate;
        }

        public void Initialize(DaHilgGameManager manager, DaHilgInputRouter input)
        {
            m_Manager = manager;
            m_Input = input;
            Build();
            Refresh();
        }

        public void Refresh()
        {
            if (m_Manager == null || m_Manager.Settings == null || m_Manager.ActiveActor == null) return;

            DaHilgActor actor = m_Manager.ActiveActor;
            m_Title.text = m_Manager.CurrentLevel != null ? m_Manager.CurrentLevel.Label : "Da Hilg";
            m_Mode.text = m_Manager.Mode == DaHilgGameMode.Nibblers ? "NIBBLERS" : "GREET";
            float combo = m_Manager.ComboMultiplier;
            m_Score.text = m_Manager.Score.ToString("000") + (combo > 1.01f ? "  x" + combo.ToString("0.#") : "");
            if (m_Manager.Mode == DaHilgGameMode.Nibblers)
            {
                int riders = actor.AttachedNibblers;
                if (riders > 0)
                {
                    // Cause ticker: explain the health drain so it never feels mysterious.
                    float drain = Mathf.Min(m_Manager.Settings.NibblerHealthDrainCap, riders * m_Manager.Settings.NibblerHealthDrainPerAttached);
                    m_Attached.text = riders + " riders  ·  -" + drain.ToString("0.0") + " HP/s";
                }
                else m_Attached.text = "BANK " + m_Manager.Banked + "  ·  BEST " + m_Manager.HighScore;
            }
            else m_Attached.text = m_Manager.HasWon() ? "all greeted" : "family nearby";
            m_State.text = actor.Label + " · " + Mathf.RoundToInt(actor.Health) + "%";

            // Horizontal health bar — go (>60) → coin (30..60) → reverse (<30), matching
            // the driving game's HealthBar fill ramp.
            float health = Mathf.Clamp(actor.Health, 0f, 100f);
            m_HealthFill.style.width = Length.Percent(health);
            m_HealthFill.style.backgroundColor = health < 30f ? k_Reverse : (health < 60f ? k_Coin : k_Go);
            RefreshNibblerStatus(actor);

            UpdateTopCompactLabel(actor, health);

            if (m_Manager.IsPaused()) m_Prompt.text = "Paused";
            else if (m_Manager.ShowSafeBanner) m_Prompt.text = "SAFE  ·  banked +" + m_Manager.LastBank;
            else if (m_Manager.Mode == DaHilgGameMode.Greet && m_Manager.NearbyGreetable != null) m_Prompt.text = "E greet " + m_Manager.NearbyGreetable.Label;
            else if (m_Manager.Mode == DaHilgGameMode.Nibblers && m_Manager.PlayerInSafeZone()) m_Prompt.text = "Safe zone";
            else if (m_Manager.Mode == DaHilgGameMode.Nibblers && m_Manager.LastRollCrushCount > 0) m_Prompt.text = "Crushed " + m_Manager.LastRollCrushCount + " nibblers";
            else if (m_Manager.Mode == DaHilgGameMode.Nibblers && m_Manager.PlayerMarked) m_Prompt.text = "Marked · swarm incoming";
            else if (m_Manager.Mode == DaHilgGameMode.Nibblers && actor.AttachedNibblers >= m_Manager.Settings.OverwhelmStop) m_Prompt.text = "Pinned · roll or jump";
            else if (m_Manager.Mode == DaHilgGameMode.Nibblers && actor.AttachedNibblers >= m_Manager.Settings.OverwhelmDown) m_Prompt.text = "Downed · roll or crawl";
            else m_Prompt.text = ShouldShowTouchControls()
                ? "Stick move · drag look · jump · roll"
                : "WASD move · right-drag look · Space jump · F roll · C/V camera";

            for (int i = 0; i < m_CharacterButtons.Count; i++)
            {
                Button button = m_CharacterButtons[i];
                string id = button.userData as string;
                bool active = id == actor.Id;
                button.EnableInClassList("active", active);
                button.style.borderTopColor = active ? Color.white : new Color(1f, 1f, 1f, 0.25f);
                button.style.borderBottomColor = button.style.borderTopColor.value;
                button.style.borderLeftColor = button.style.borderTopColor.value;
                button.style.borderRightColor = button.style.borderTopColor.value;
                button.style.borderTopWidth = active ? 2 : 1;
                button.style.borderBottomWidth = button.style.borderTopWidth.value;
                button.style.borderLeftWidth = button.style.borderTopWidth.value;
                button.style.borderRightWidth = button.style.borderTopWidth.value;
            }

            for (int i = 0; i < m_CameraButtons.Count; i++)
            {
                Button button = m_CameraButtons[i];
                bool active = m_Manager.CameraRig != null
                    && button.userData is DaHilgCameraMode mode
                    && mode == m_Manager.CameraRig.Mode;
                button.style.backgroundColor = active ? WithAlpha(k_Nav, 0.22f) : k_Fill;
                button.style.borderTopColor = active ? k_Nav : k_Line;
                button.style.borderBottomColor = button.style.borderTopColor.value;
                button.style.borderLeftColor = button.style.borderTopColor.value;
                button.style.borderRightColor = button.style.borderTopColor.value;
                button.style.borderTopWidth = active ? 2 : 1;
                button.style.borderBottomWidth = button.style.borderTopWidth.value;
                button.style.borderLeftWidth = button.style.borderTopWidth.value;
                button.style.borderRightWidth = button.style.borderTopWidth.value;
            }

            for (int i = 0; i < m_LevelButtons.Count; i++)
            {
                Button button = m_LevelButtons[i];
                string slug = button.userData as string;
                bool active = m_Manager.CurrentLevel != null && slug == m_Manager.CurrentLevel.Slug;
                button.style.backgroundColor = active ? WithAlpha(k_Go, 0.22f) : k_Fill;
                button.style.borderTopColor = active ? k_Go : k_Line;
                button.style.borderBottomColor = button.style.borderTopColor.value;
                button.style.borderLeftColor = button.style.borderTopColor.value;
                button.style.borderRightColor = button.style.borderTopColor.value;
                button.style.borderTopWidth = active ? 2 : 1;
                button.style.borderBottomWidth = button.style.borderTopWidth.value;
                button.style.borderLeftWidth = button.style.borderTopWidth.value;
                button.style.borderRightWidth = button.style.borderTopWidth.value;
            }

            RefreshResponsiveControls();
            RefreshCompactControls(actor);
            EnsureMenuSelection();
            ApplyMenuSelectionStyles();
            m_Minimap?.SetManager(m_Manager);
        }

        void UpdateTopCompactLabel(DaHilgActor actor, float health)
        {
            if (m_TopCompactLabel == null) return;
            string who = actor != null && !string.IsNullOrEmpty(actor.Label) ? actor.Label : "—";
            if (m_Manager.Mode == DaHilgGameMode.Nibblers)
            {
                m_TopCompactLabel.text = who + " · " + Mathf.RoundToInt(health) + "% · "
                    + actor.AttachedNibblers.ToString("00") + " NIB";
            }
            else
            {
                m_TopCompactLabel.text = who + " · " + Mathf.RoundToInt(health) + "% · " + m_Score.text;
            }
        }

        void RefreshNibblerStatus(DaHilgActor actor)
        {
            if (m_NibblerMeter == null || m_RollState == null) return;

            bool nibblers = m_Manager.Mode == DaHilgGameMode.Nibblers;
            // The nibbler counter chip + roll readout only matter in Nibblers mode.
            DisplayStyle nibblerDisplay = nibblers && !m_TopPanelCollapsed ? DisplayStyle.Flex : DisplayStyle.None;
            m_NibblerMeter.style.display = nibblerDisplay;
            m_RollState.style.display = nibblerDisplay;
            if (!nibblers)
            {
                if (m_MarkOverlay != null) m_MarkOverlay.style.display = DisplayStyle.None;
                if (m_MarkLabel != null) m_MarkLabel.style.display = DisplayStyle.None;
                return;
            }

            // Headline BURIED gauge: how close you are to a pin (0..1), not raw count — this is
            // the real threat the keystone overwhelm system tracks.
            float buried01 = m_Manager.BuriedLoad01;
            m_NibblerFill.style.width = Length.Percent(buried01 * 100f);
            m_NibblerFill.style.backgroundColor = buried01 > 0.66f ? k_Reverse : (buried01 > 0.33f ? k_Coin : k_Go);

            bool rollReady = m_Manager.RollReady;
            m_RollState.text = rollReady
                ? "ROLL READY  ·  " + m_Manager.CrushedNibblerTotal + " crushed"
                : "ROLL " + m_Manager.RollCooldownRemaining.ToString("0.0") + "s  ·  " + m_Manager.CrushedNibblerTotal + " crushed";
            m_RollState.style.color = rollReady ? k_Go : k_Coin;

            bool marked = m_Manager.PlayerMarked;
            float flash = Mathf.Max(m_Manager.Marked01, m_Manager.AttachmentFlash01);
            bool show = marked || flash > 0.01f || actor.AttachedNibblers >= m_Manager.Settings.OverwhelmStagger;
            if (m_MarkOverlay != null)
            {
                m_MarkOverlay.style.display = show ? DisplayStyle.Flex : DisplayStyle.None;
                float pulse = marked ? 0.018f + Mathf.PingPong(Time.time * 0.06f, 0.026f) : 0.012f;
                m_MarkOverlay.style.backgroundColor = new Color(1f, 0.03f, 0f, Mathf.Clamp01(pulse + flash * 0.045f));
            }
            if (m_MarkLabel != null)
            {
                m_MarkLabel.style.display = show ? DisplayStyle.Flex : DisplayStyle.None;
                m_MarkLabel.text = marked ? "MARKED" : (actor.AttachedNibblers > 0 ? "NIBBLERS" : string.Empty);
            }

            if (m_RollButton != null)
            {
                m_RollButton.text = rollReady ? "ROLL" : m_Manager.RollCooldownRemaining.ToString("0.0");
                m_RollButton.style.backgroundColor = rollReady ? WithAlpha(k_Nav, 0.86f) : WithAlpha(k_Coin, 0.66f);
            }
        }

        void RefreshCompactControls(DaHilgActor actor)
        {
            if (m_CompactBar == null) return;

            if (m_CompactCameraButton != null)
            {
                string camera = m_Manager.CameraRig != null ? m_Manager.CameraRig.ModeLabel() : "CAMERA";
                SetSegmentLabel(m_CompactCameraButton, "VIEW", camera);
                StyleBarSegment(m_CompactCameraButton, false, WithAlpha(k_Nav, 0.22f));
            }

            if (m_CompactPlayerButton != null)
            {
                string label = actor != null && !string.IsNullOrEmpty(actor.Label) ? actor.Label.ToUpperInvariant() : "—";
                SetSegmentLabel(m_CompactPlayerButton, "PLAYER", label);
                StyleBarSegment(m_CompactPlayerButton, false, WithAlpha(k_Nav, 0.22f));
            }

            if (m_CompactLevelButton != null)
            {
                string label = m_Manager.CurrentLevel != null
                    ? LevelButtonLabel(m_Manager.CurrentLevel).ToUpperInvariant()
                    : "LEVEL";
                SetSegmentLabel(m_CompactLevelButton, "LEVEL", label);
                StyleBarSegment(m_CompactLevelButton, m_LevelDialogOpen, WithAlpha(k_Go, 0.22f));
            }

            if (m_CompactMenuButton != null)
            {
                SetSegmentLabel(m_CompactMenuButton, m_CompactMenuOpen ? "CLOSE" : "MENU", m_CompactMenuOpen ? string.Empty : "ACTIONS");
                StyleBarSegment(m_CompactMenuButton, m_CompactMenuOpen, WithAlpha(k_Nav, 0.22f));
            }

            for (int i = 0; i < m_CompactCharacterButtons.Count; i++)
            {
                Button button = m_CompactCharacterButtons[i];
                bool active = actor != null && (button.userData as string) == actor.Id;
                Color color = active && actor != null ? CharacterAccent(actor.Id) : k_Fill;
                StyleCompactButton(button, active, color);
            }

            for (int i = 0; i < m_CompactCameraButtons.Count; i++)
            {
                Button button = m_CompactCameraButtons[i];
                bool active = m_Manager.CameraRig != null
                    && button.userData is DaHilgCameraMode mode
                    && mode == m_Manager.CameraRig.Mode;
                StyleCompactButton(button, active, WithAlpha(k_Nav, 0.26f));
            }

            for (int i = 0; i < m_CompactLevelButtons.Count; i++)
            {
                Button button = m_CompactLevelButtons[i];
                bool active = m_Manager.CurrentLevel != null && (button.userData as string) == m_Manager.CurrentLevel.Slug;
                StyleCompactButton(button, active, WithAlpha(k_Go, 0.26f));
            }

            for (int i = 0; i < m_CompactEmoteButtons.Count; i++)
            {
                StyleCompactButton(m_CompactEmoteButtons[i], false, k_Fill);
            }

            RefreshLevelDialogButtons();
        }

        // Stack a tiny kicker word over a bigger value, like the driving game's .segLab.
        static void SetSegmentLabel(Button button, string kick, string value)
        {
            if (button == null) return;
            button.text = string.IsNullOrEmpty(value) ? kick : kick + "\n" + value;
        }

        void StyleCompactButton(Button button, bool active, Color activeColor)
        {
            if (button == null) return;
            button.style.backgroundColor = active ? activeColor : k_Fill;
            Color border = active ? Color.white : k_Line;
            button.style.borderTopColor = border;
            button.style.borderBottomColor = border;
            button.style.borderLeftColor = border;
            button.style.borderRightColor = border;
            button.style.borderTopWidth = active ? 2 : 1;
            button.style.borderBottomWidth = button.style.borderTopWidth.value;
            button.style.borderLeftWidth = button.style.borderTopWidth.value;
            button.style.borderRightWidth = button.style.borderTopWidth.value;
        }

        void StyleBarSegment(Button button, bool active, Color activeColor)
        {
            if (button == null) return;
            button.style.backgroundColor = active ? activeColor : k_Fill;
            button.style.borderTopWidth = 0;
            button.style.borderBottomWidth = 0;
            button.style.borderLeftWidth = 0;
            button.style.borderRightWidth = 0;
        }

        Color CharacterAccent(string id)
        {
            if (m_Manager == null || m_Manager.Settings == null || m_Manager.Settings.Characters == null) return WithAlpha(k_Nav, 0.86f);
            for (int i = 0; i < m_Manager.Settings.Characters.Length; i++)
            {
                DaHilgCharacterSlot slot = m_Manager.Settings.Characters[i];
                if (slot.Id == id) return new Color(slot.Accent.r, slot.Accent.g, slot.Accent.b, 0.82f);
            }
            return WithAlpha(k_Nav, 0.86f);
        }

        public bool TickMenuInput(DaHilgInputRouter input)
        {
            if (input == null || m_MenuEntries.Count == 0) return false;

            if (input.MenuCancelPressed)
            {
                if (m_LevelDialogOpen)
                {
                    CloseLevelDialog();
                    return true;
                }
                if (m_CompactMenuOpen)
                {
                    m_CompactMenuOpen = false;
                    RefreshResponsiveControls();
                    RefreshCompactControls(m_Manager.ActiveActor);
                    return true;
                }
            }

            bool moved = false;
            if (input.MenuLeftPressed)
            {
                MoveMenuSelection(-1, 0);
                moved = true;
            }
            if (input.MenuRightPressed)
            {
                MoveMenuSelection(1, 0);
                moved = true;
            }
            if (input.MenuUpPressed)
            {
                MoveMenuSelection(0, 1);
                moved = true;
            }
            if (input.MenuDownPressed)
            {
                MoveMenuSelection(0, -1);
                moved = true;
            }

            if (moved)
            {
                m_MenuFocused = true;
                FocusSelectedMenuButton();
                ApplyMenuSelectionStyles();
                return false;
            }

            if (input.MenuCancelPressed && m_MenuFocused)
            {
                m_MenuFocused = false;
                ApplyMenuSelectionStyles();
                return true;
            }

            if (input.MenuActivatePressed && m_MenuFocused)
            {
                ActivateSelectedMenuEntry();
                return true;
            }

            return false;
        }

        void Update()
        {
            TickTouchHudFallback();
        }

        [Preserve]
        public void HandleWebTouchTap(string payload)
        {
            if (string.IsNullOrEmpty(payload)) return;

            string[] parts = payload.Split(',');
            if (parts.Length < 4) return;
            if (!float.TryParse(parts[0], NumberStyles.Float, CultureInfo.InvariantCulture, out float cssX)) return;
            if (!float.TryParse(parts[1], NumberStyles.Float, CultureInfo.InvariantCulture, out float cssY)) return;
            if (!float.TryParse(parts[2], NumberStyles.Float, CultureInfo.InvariantCulture, out float cssWidth)) return;
            if (!float.TryParse(parts[3], NumberStyles.Float, CultureInfo.InvariantCulture, out float cssHeight)) return;
            if (cssWidth <= 1f || cssHeight <= 1f) return;

            float x01 = Mathf.Clamp01(cssX / cssWidth);
            float y01 = Mathf.Clamp01(cssY / cssHeight);
            Vector2 screenPoint = new Vector2(x01 * Screen.width, (1f - y01) * Screen.height);
            if (!TryActivateHudButtonFromScreen(screenPoint))
            {
                TryActivateCompactTopFromCss(cssX, cssY, cssWidth);
            }
        }

        [Preserve]
        public void HandleWebHudCommand(string command)
        {
            if (string.IsNullOrEmpty(command)) return;
            if (Time.unscaledTime - m_LastHudActivationTime < 0.08f) return;

            bool activated = ActivateCompactCommand(command);
            if (!activated) return;

            m_LastHudActivationTime = Time.unscaledTime;
            Debug.Log("[DaHilg] HUD touch command: " + command);
        }

        void Build()
        {
            LoadFonts();

            UIDocument doc = GetComponent<UIDocument>();
            m_Root = doc.rootVisualElement;
            m_Root.Clear();
            m_Root.style.position = Position.Absolute;
            m_Root.style.left = 0;
            m_Root.style.right = 0;
            m_Root.style.top = 0;
            m_Root.style.bottom = 0;
            m_Root.style.color = k_Text;
            // The full-screen HUD root must pass pointer events through to the game canvas
            // (interactive children opt back into Position) — otherwise empty HUD areas eat
            // desktop clicks and block the right-click pointer-lock used for mouse-look.
            m_Root.pickingMode = PickingMode.Ignore;
            // Every label/button inherits the AGC face from the root unless overridden.
            ApplyFont(m_Root, m_AgcFont);

            m_MarkOverlay = new VisualElement();
            m_MarkOverlay.pickingMode = PickingMode.Ignore;
            m_MarkOverlay.style.position = Position.Absolute;
            m_MarkOverlay.style.left = 0;
            m_MarkOverlay.style.right = 0;
            m_MarkOverlay.style.top = 0;
            m_MarkOverlay.style.bottom = 0;
            m_MarkOverlay.style.display = DisplayStyle.None;
            m_MarkOverlay.style.borderTopWidth = 12;
            m_MarkOverlay.style.borderBottomWidth = 12;
            m_MarkOverlay.style.borderLeftWidth = 12;
            m_MarkOverlay.style.borderRightWidth = 12;
            m_MarkOverlay.style.borderTopColor = new Color(1f, 0.05f, 0f, 0.72f);
            m_MarkOverlay.style.borderBottomColor = m_MarkOverlay.style.borderTopColor.value;
            m_MarkOverlay.style.borderLeftColor = m_MarkOverlay.style.borderTopColor.value;
            m_MarkOverlay.style.borderRightColor = m_MarkOverlay.style.borderTopColor.value;
            m_Root.Add(m_MarkOverlay);

            m_MarkLabel = Label("", 18, FontStyle.Bold);
            m_MarkLabel.pickingMode = PickingMode.Ignore;
            m_MarkLabel.style.position = Position.Absolute;
            m_MarkLabel.style.left = Length.Percent(50);
            m_MarkLabel.style.top = 64;
            m_MarkLabel.style.translate = new Translate(Length.Percent(-50), 0);
            m_MarkLabel.style.paddingLeft = 14;
            m_MarkLabel.style.paddingRight = 14;
            m_MarkLabel.style.paddingTop = 7;
            m_MarkLabel.style.paddingBottom = 7;
            m_MarkLabel.style.backgroundColor = WithAlpha(k_Reverse, 0.86f);
            m_MarkLabel.style.letterSpacing = 2f;
            ApplyFont(m_MarkLabel, m_AgcHeavyFont);
            m_MarkLabel.style.display = DisplayStyle.None;
            m_Root.Add(m_MarkLabel);

            BuildTopPanel();

            m_Prompt = Label("", 13, FontStyle.Bold);
            m_Prompt.style.position = Position.Absolute;
            m_Prompt.style.left = Length.Percent(50);
            m_Prompt.style.bottom = 126;
            m_Prompt.style.translate = new Translate(Length.Percent(-50), 0);
            m_Prompt.style.paddingLeft = 16;
            m_Prompt.style.paddingRight = 16;
            m_Prompt.style.paddingTop = 9;
            m_Prompt.style.paddingBottom = 9;
            m_Prompt.style.backgroundColor = k_Glass;
            ApplyBorder(m_Prompt, k_Line, 1);
            m_Prompt.pickingMode = PickingMode.Ignore; // pure readout — must not eat desktop clicks
            m_Root.Add(m_Prompt);

            VisualElement cross = new VisualElement();
            cross.pickingMode = PickingMode.Ignore; // decorative crosshair
            cross.style.position = Position.Absolute;
            cross.style.left = Length.Percent(50);
            cross.style.top = Length.Percent(50);
            cross.style.width = 8;
            cross.style.height = 8;
            cross.style.translate = new Translate(-4, -4);
            cross.style.borderTopWidth = 1;
            cross.style.borderBottomWidth = 1;
            cross.style.borderLeftWidth = 1;
            cross.style.borderRightWidth = 1;
            cross.style.borderTopColor = new Color(1f, 1f, 1f, 0.85f);
            cross.style.borderBottomColor = cross.style.borderTopColor.value;
            cross.style.borderLeftColor = cross.style.borderTopColor.value;
            cross.style.borderRightColor = cross.style.borderTopColor.value;
            m_Root.Add(cross);

            BuildCharacterBar();
            BuildMinimap();
            BuildTouchControls();
            BuildEmoteBar();
            BuildCameraBar();
            BuildLevelBar();
            BuildCompactControls();
            BuildLevelDialog();
        }

        void LoadFonts()
        {
            // Runtime-loadable AGC faces (converted from the driving game's woff2 to TTF
            // and dropped under Assets/DaHilg/Resources/Fonts so Resources.Load works in
            // the WebGL build). Falls back to the built-in face if loading ever fails.
            m_AgcFont = Resources.Load<Font>("Fonts/AGC-Bold");
            m_AgcHeavyFont = Resources.Load<Font>("Fonts/AGC-Heavy") ?? Resources.Load<Font>("Fonts/AGC-Black") ?? m_AgcFont;
            if (m_AgcFont == null) m_AgcFont = m_AgcHeavyFont;
            if (m_AgcFont == null)
                Debug.LogError("[DaHilg] AGC font failed to load from Resources/Fonts — HUD falls back to the built-in face. Ensure AGC-*.ttf are imported under Assets/DaHilg/Resources/Fonts.");
        }

        static void ApplyFont(VisualElement element, Font font)
        {
            if (element == null || font == null) return;
            element.style.unityFontDefinition = new StyleFontDefinition(FontDefinition.FromFont(font));
        }

        void BuildTopPanel()
        {
            // ── TOP-LEFT collapsible status panel ─────────────────────────────────
            // Square nav-app glass card holding title/mode/score, the horizontal health
            // row, the nibbler counter chip and the framed minimap. A small ▾ toggle
            // collapses it to a one-line strip so the screen frees up.
            m_TopPanel = Panel();
            m_TopPanel.style.left = 18;
            m_TopPanel.style.top = 18;
            m_TopPanel.style.width = 252;
            m_Root.Add(m_TopPanel);

            // Header row: title + collapse toggle, always visible.
            VisualElement header = new VisualElement();
            header.style.flexDirection = FlexDirection.Row;
            header.style.alignItems = Align.Center;
            header.style.justifyContent = Justify.SpaceBetween;
            m_TopPanel.Add(header);

            m_Title = Label("Da Hilg", 18, FontStyle.Bold);
            ApplyFont(m_Title, m_AgcHeavyFont);
            m_Title.style.flexGrow = 1;
            m_Title.style.flexShrink = 1;
            m_Title.style.overflow = Overflow.Hidden;
            m_Title.style.textOverflow = TextOverflow.Ellipsis;
            m_Title.style.whiteSpace = WhiteSpace.NoWrap;
            header.Add(m_Title);

            m_TopCollapseButton = new Button(ToggleTopPanel) { text = "▾" };
            m_TopCollapseButton.focusable = true;
            m_TopCollapseButton.style.width = 26;
            m_TopCollapseButton.style.height = 26;
            m_TopCollapseButton.style.marginLeft = 8;
            m_TopCollapseButton.style.marginTop = 0;
            m_TopCollapseButton.style.marginBottom = 0;
            m_TopCollapseButton.style.marginRight = 0;
            m_TopCollapseButton.style.paddingLeft = 0;
            m_TopCollapseButton.style.paddingRight = 0;
            m_TopCollapseButton.style.paddingTop = 0;
            m_TopCollapseButton.style.paddingBottom = 0;
            m_TopCollapseButton.style.flexShrink = 0;
            m_TopCollapseButton.style.fontSize = 12;
            m_TopCollapseButton.style.color = k_Text;
            m_TopCollapseButton.style.backgroundColor = k_Fill;
            m_TopCollapseButton.style.unityTextAlign = TextAnchor.MiddleCenter;
            ApplyBorder(m_TopCollapseButton, k_Line, 1);
            header.Add(m_TopCollapseButton);

            // Collapsed one-line strip (hidden until collapsed).
            m_TopCompactStrip = new VisualElement();
            m_TopCompactStrip.style.flexDirection = FlexDirection.Row;
            m_TopCompactStrip.style.alignItems = Align.Center;
            m_TopCompactStrip.style.marginTop = 7;
            m_TopCompactStrip.style.display = DisplayStyle.None;
            m_TopPanel.Add(m_TopCompactStrip);
            m_TopCompactLabel = Label("", 11, FontStyle.Bold);
            m_TopCompactLabel.style.color = k_TextFaint;
            m_TopCompactLabel.style.letterSpacing = 0.5f;
            m_TopCompactStrip.Add(m_TopCompactLabel);

            // Expanded body holding all the detail widgets.
            m_TopPanelBody = new VisualElement();
            m_TopPanelBody.style.flexDirection = FlexDirection.Column;
            m_TopPanel.Add(m_TopPanelBody);

            VisualElement chipRow = new VisualElement { style = { flexDirection = FlexDirection.Row, marginTop = 9, alignItems = Align.Center } };
            m_TopPanelBody.Add(chipRow);
            m_Mode = Chip("GREET", k_Nav);
            m_Score = Chip("000", k_Coin);
            ApplyFont(m_Score, m_AgcHeavyFont);
            chipRow.Add(m_Mode);
            chipRow.Add(m_Score);

            m_State = Label("", 12, FontStyle.Normal);
            m_State.style.marginTop = 9;
            m_State.style.color = WithAlpha(Color.white, 0.82f);
            m_TopPanelBody.Add(m_State);

            // ── Compact HORIZONTAL health row: slim bar + inline % readout ─────────
            VisualElement healthRow = new VisualElement();
            healthRow.style.flexDirection = FlexDirection.Row;
            healthRow.style.alignItems = Align.Center;
            healthRow.style.marginTop = 7;
            m_TopPanelBody.Add(healthRow);

            Label healthKick = Label("HP", 8, FontStyle.Bold);
            healthKick.style.color = k_TextDim;
            healthKick.style.letterSpacing = 1.5f;
            healthKick.style.marginRight = 7;
            healthKick.style.flexShrink = 0;
            healthRow.Add(healthKick);

            VisualElement healthTrack = new VisualElement();
            healthTrack.style.flexGrow = 1;
            healthTrack.style.height = 6;
            healthTrack.style.backgroundColor = new Color(1f, 1f, 1f, 0.12f);
            ApplyBorder(healthTrack, k_Line, 1);
            healthTrack.style.overflow = Overflow.Hidden;
            healthRow.Add(healthTrack);
            m_HealthFill = new VisualElement();
            m_HealthFill.style.position = Position.Absolute;
            m_HealthFill.style.left = 0;
            m_HealthFill.style.top = 0;
            m_HealthFill.style.bottom = 0;
            m_HealthFill.style.width = Length.Percent(100);
            m_HealthFill.style.backgroundColor = k_Go;
            healthTrack.Add(m_HealthFill);

            // ── Inline nibbler counter chip (compact, only shows in Nibblers) ──────
            m_Attached = Label("", 11, FontStyle.Normal);
            m_Attached.style.marginTop = 8;
            m_Attached.style.color = WithAlpha(Color.white, 0.78f);
            m_TopPanelBody.Add(m_Attached);

            VisualElement nibRow = new VisualElement();
            nibRow.style.flexDirection = FlexDirection.Row;
            nibRow.style.alignItems = Align.Center;
            nibRow.style.marginTop = 6;
            m_TopPanelBody.Add(nibRow);

            Label nibKick = Label("SWARM", 8, FontStyle.Bold);
            nibKick.style.color = k_TextDim;
            nibKick.style.letterSpacing = 1.5f;
            nibKick.style.marginRight = 7;
            nibKick.style.flexShrink = 0;
            nibRow.Add(nibKick);

            m_NibblerMeter = new VisualElement();
            m_NibblerMeter.style.flexGrow = 1;
            m_NibblerMeter.style.height = 6;
            m_NibblerMeter.style.backgroundColor = new Color(1f, 1f, 1f, 0.12f);
            ApplyBorder(m_NibblerMeter, k_Line, 1);
            m_NibblerMeter.style.overflow = Overflow.Hidden;
            nibRow.Add(m_NibblerMeter);
            m_NibblerFill = new VisualElement();
            m_NibblerFill.style.position = Position.Absolute;
            m_NibblerFill.style.left = 0;
            m_NibblerFill.style.top = 0;
            m_NibblerFill.style.bottom = 0;
            m_NibblerFill.style.width = Length.Percent(0);
            m_NibblerFill.style.backgroundColor = k_Go;
            m_NibblerMeter.Add(m_NibblerFill);

            m_RollState = Label("", 10, FontStyle.Bold);
            m_RollState.style.marginTop = 7;
            m_RollState.style.letterSpacing = 0.5f;
            m_TopPanelBody.Add(m_RollState);
        }

        void ToggleTopPanel()
        {
            if (Time.unscaledTime - m_LastHudActivationTime < 0.08f) return;
            m_LastHudActivationTime = Time.unscaledTime;
            m_TopPanelCollapsed = !m_TopPanelCollapsed;
            if (m_TopCollapseButton != null) m_TopCollapseButton.text = m_TopPanelCollapsed ? "▸" : "▾";
            if (m_TopPanelBody != null) m_TopPanelBody.style.display = m_TopPanelCollapsed ? DisplayStyle.None : DisplayStyle.Flex;
            if (m_TopCompactStrip != null) m_TopCompactStrip.style.display = m_TopPanelCollapsed ? DisplayStyle.Flex : DisplayStyle.None;
            // Hide the framed minimap while collapsed so the compact strip stands alone.
            if (m_Minimap != null) m_Minimap.style.display = m_TopPanelCollapsed ? DisplayStyle.None : DisplayStyle.Flex;
            Refresh();
        }

        void BuildMinimap()
        {
            m_Minimap = new DaHilgMinimapElement();
            m_Minimap.style.right = 18;
            m_Minimap.style.top = 18;
            m_Minimap.style.width = 220;
            m_Minimap.style.height = 168;
            m_Root.Add(m_Minimap);
        }

        void BuildCharacterBar()
        {
            m_CharacterBar = new VisualElement();
            m_CharacterBar.style.position = Position.Absolute;
            m_CharacterBar.style.left = Length.Percent(50);
            m_CharacterBar.style.bottom = 24;
            m_CharacterBar.style.translate = new Translate(Length.Percent(-50), 0);
            m_CharacterBar.style.flexDirection = FlexDirection.Row;
            m_CharacterBar.style.backgroundColor = k_Glass;
            ApplyBorder(m_CharacterBar, k_Line, 1);
            m_CharacterBar.style.paddingLeft = 6;
            m_CharacterBar.style.paddingRight = 6;
            m_CharacterBar.style.paddingTop = 6;
            m_CharacterBar.style.paddingBottom = 6;
            m_Root.Add(m_CharacterBar);

            m_CharacterButtons.Clear();
            RemoveMenuEntriesForRow(0);
            for (int i = 0; i < m_Manager.Settings.Characters.Length; i++)
            {
                DaHilgCharacterSlot slot = m_Manager.Settings.Characters[i];
                string slotId = slot.Id;
                Action activate = () => m_Manager.SwitchTo(slotId);
                Button button = new Button(activate) { text = slot.Label };
                button.userData = slot.Id;
                button.focusable = true;
                button.tabIndex = i;
                button.style.marginLeft = 4;
                button.style.marginRight = 4;
                button.style.height = 34;
                button.style.minWidth = 66;
                button.style.unityFontStyleAndWeight = FontStyle.Bold;
                button.style.backgroundColor = new Color(slot.Accent.r, slot.Accent.g, slot.Accent.b, 0.72f);
                button.style.color = Color.white;
                button.style.borderTopWidth = 1;
                button.style.borderBottomWidth = 1;
                button.style.borderLeftWidth = 1;
                button.style.borderRightWidth = 1;
                m_CharacterBar.Add(button);
                m_CharacterButtons.Add(button);
            }
        }

        void BuildTouchControls()
        {
            m_MoveZone = new VisualElement();
            m_MoveZone.style.position = Position.Absolute;
            m_MoveZone.style.left = 0;
            m_MoveZone.style.top = 0;
            m_MoveZone.style.bottom = 0;
            m_MoveZone.style.width = Length.Percent(58);
            m_MoveZone.pickingMode = PickingMode.Position;
            m_MoveZone.RegisterCallback<PointerDownEvent>(OnJoyDown);
            m_MoveZone.RegisterCallback<PointerMoveEvent>(OnJoyMove);
            m_MoveZone.RegisterCallback<PointerUpEvent>(OnJoyUp);
            m_MoveZone.RegisterCallback<PointerCancelEvent>(OnJoyCancel);
            m_Root.Add(m_MoveZone);

            m_LookZone = new VisualElement();
            m_LookZone.style.position = Position.Absolute;
            m_LookZone.style.right = 0;
            m_LookZone.style.top = 0;
            m_LookZone.style.bottom = 0;
            m_LookZone.style.width = Length.Percent(50);
            m_LookZone.pickingMode = PickingMode.Position;
            m_LookZone.RegisterCallback<PointerDownEvent>(OnLookDown);
            m_LookZone.RegisterCallback<PointerMoveEvent>(OnLookMove);
            m_LookZone.RegisterCallback<PointerUpEvent>(OnLookUp);
            m_LookZone.RegisterCallback<PointerCancelEvent>(OnLookCancel);
            m_Root.Add(m_LookZone);

            m_MoveZone.SendToBack();
            m_LookZone.SendToBack();

            m_Joy = new VisualElement();
            m_Joy.style.position = Position.Absolute;
            m_Joy.style.left = 32;
            m_Joy.style.top = 420;
            m_Joy.style.width = k_JoySize;
            m_Joy.style.height = k_JoySize;
            m_Joy.style.opacity = 0.46f;
            m_Joy.style.backgroundColor = new Color(0.03f, 0.04f, 0.06f, 0.38f);
            m_Joy.style.borderTopWidth = 2;
            m_Joy.style.borderBottomWidth = 2;
            m_Joy.style.borderLeftWidth = 2;
            m_Joy.style.borderRightWidth = 2;
            m_Joy.style.borderTopColor = WithAlpha(k_Nav, 0.55f);
            m_Joy.style.borderBottomColor = m_Joy.style.borderTopColor.value;
            m_Joy.style.borderLeftColor = m_Joy.style.borderTopColor.value;
            m_Joy.style.borderRightColor = m_Joy.style.borderTopColor.value;
            m_Joy.style.borderTopLeftRadius = k_JoySize * 0.5f;
            m_Joy.style.borderTopRightRadius = k_JoySize * 0.5f;
            m_Joy.style.borderBottomLeftRadius = k_JoySize * 0.5f;
            m_Joy.style.borderBottomRightRadius = k_JoySize * 0.5f;
            m_Joy.pickingMode = PickingMode.Ignore;
            m_Root.Add(m_Joy);

            m_Knob = new VisualElement();
            m_Knob.style.position = Position.Absolute;
            m_Knob.style.left = (k_JoySize - k_JoyKnobSize) * 0.5f;
            m_Knob.style.top = (k_JoySize - k_JoyKnobSize) * 0.5f;
            m_Knob.style.width = k_JoyKnobSize;
            m_Knob.style.height = k_JoyKnobSize;
            m_Knob.style.backgroundColor = WithAlpha(k_Nav, 0.92f);
            m_Knob.style.borderTopLeftRadius = k_JoyKnobSize * 0.5f;
            m_Knob.style.borderTopRightRadius = k_JoyKnobSize * 0.5f;
            m_Knob.style.borderBottomLeftRadius = k_JoyKnobSize * 0.5f;
            m_Knob.style.borderBottomRightRadius = k_JoyKnobSize * 0.5f;
            m_Knob.pickingMode = PickingMode.Ignore;
            m_Joy.Add(m_Knob);

            Button jump = TouchButton("JUMP", k_Nav);
            m_JumpButton = jump;
            jump.style.right = 34;
            jump.style.bottom = 34;
            jump.RegisterCallback<PointerDownEvent>(e =>
            {
                m_Input.QueueTouchJump();
                e.StopPropagation();
            });
            jump.clicked += () => m_Input.QueueTouchJump();
            m_Root.Add(jump);

            Button roll = TouchButton("ROLL", k_Nav);
            m_RollButton = roll;
            roll.style.right = 34;
            roll.style.bottom = 162;
            roll.RegisterCallback<PointerDownEvent>(e =>
            {
                m_Input.QueueTouchRoll();
                e.StopPropagation();
            });
            roll.clicked += () => m_Input.QueueTouchRoll();
            m_Root.Add(roll);

            Button run = TouchButton("RUN", k_Nav);
            m_RunButton = run;
            run.style.right = 34;
            run.style.bottom = 98;
            run.RegisterCallback<PointerDownEvent>(e =>
            {
                m_Input.SetTouchRun(true);
                e.StopPropagation();
            });
            run.RegisterCallback<PointerUpEvent>(_ => m_Input.SetTouchRun(false));
            run.RegisterCallback<PointerCancelEvent>(_ => m_Input.SetTouchRun(false));
            run.RegisterCallback<PointerLeaveEvent>(_ => m_Input.SetTouchRun(false));
            m_Root.Add(run);

            Button punch = TouchButton("PUNCH", k_Reverse);
            m_PunchButton = punch;
            punch.style.right = 102;
            punch.style.bottom = 34;
            punch.RegisterCallback<PointerDownEvent>(e =>
            {
                m_Input.QueueTouchAttack();
                e.StopPropagation();
            });
            punch.clicked += () => m_Input.QueueTouchAttack();
            m_Root.Add(punch);

            RefreshResponsiveControls();
        }

        void RefreshResponsiveControls()
        {
            bool touch = ShouldShowTouchControls();
            bool landscape = touch && Screen.width > Screen.height;
            DisplayStyle display = touch ? DisplayStyle.Flex : DisplayStyle.None;
            DisplayStyle actionDisplay = touch && !m_CompactMenuOpen && !m_LevelDialogOpen ? DisplayStyle.Flex : DisplayStyle.None;
            DisplayStyle standardBars = DisplayStyle.None;
            if (m_MoveZone != null) m_MoveZone.style.display = display;
            if (m_LookZone != null) m_LookZone.style.display = display;
            if (m_Joy != null) m_Joy.style.display = display;
            if (m_RunButton != null) m_RunButton.style.display = actionDisplay;
            if (m_JumpButton != null) m_JumpButton.style.display = actionDisplay;
            if (m_RollButton != null) m_RollButton.style.display = actionDisplay;
            if (m_PunchButton != null) m_PunchButton.style.display = actionDisplay;
            if (m_CharacterBar != null) m_CharacterBar.style.display = standardBars;
            if (m_EmoteBar != null) m_EmoteBar.style.display = standardBars;
            if (m_CameraBar != null) m_CameraBar.style.display = standardBars;
            if (m_LevelBar != null) m_LevelBar.style.display = standardBars;
            if (m_CompactBar != null) m_CompactBar.style.display = DisplayStyle.Flex;
            if (m_CompactPanel != null) m_CompactPanel.style.display = m_CompactMenuOpen ? DisplayStyle.Flex : DisplayStyle.None;
            if (m_LevelDialog != null) m_LevelDialog.style.display = m_LevelDialogOpen ? DisplayStyle.Flex : DisplayStyle.None;
            // Minimap visibility is tied to the collapse state, not the breakpoint.
            if (m_Minimap != null) m_Minimap.style.display = m_TopPanelCollapsed ? DisplayStyle.None : DisplayStyle.Flex;

            if (landscape)
            {
                SetPanelFrame(m_TopPanel, 12, StyleKeyword.Auto, 12, StyleKeyword.Auto, 224, StyleKeyword.Auto);
                // Minimap sits just under the (collapsible) status card so they never overlap.
                SetPanelFrame(m_Minimap, 12, StyleKeyword.Auto, MinimapTop(landscape), StyleKeyword.Auto, 190, 132);
                SetBarFrame(m_CharacterBar, StyleKeyword.Auto, 12, 152, StyleKeyword.Auto, new Translate(0, 0));
                SetBarFrame(m_EmoteBar, StyleKeyword.Auto, 12, 198, StyleKeyword.Auto, new Translate(0, 0));
                SetBarFrame(m_CameraBar, StyleKeyword.Auto, 12, 244, StyleKeyword.Auto, new Translate(0, 0));
                SetBarFrame(m_LevelBar, StyleKeyword.Auto, 12, 290, StyleKeyword.Auto, new Translate(0, 0));
                SetPromptFrame(Length.Percent(50), StyleKeyword.Auto, 14, StyleKeyword.Auto, new Translate(Length.Percent(-50), 0), 300, 12);
                SetBarFrame(m_CompactBar, StyleKeyword.Auto, 12, 12, StyleKeyword.Auto, new Translate(0, 0));
                if (m_CompactBar != null) m_CompactBar.style.width = 372;
                SetBarFrame(m_CompactPanel, StyleKeyword.Auto, 12, 62, StyleKeyword.Auto, new Translate(0, 0));
                if (m_CompactPanel != null) m_CompactPanel.style.maxHeight = 178;
                if (m_LevelDialogPanel != null) m_LevelDialogPanel.style.maxWidth = 320;

                PositionJoystickGhost(true);
                if (m_RunButton != null)
                {
                    m_RunButton.style.right = 24;
                    m_RunButton.style.bottom = 204;
                }
                if (m_JumpButton != null)
                {
                    m_JumpButton.style.right = 24;
                    m_JumpButton.style.bottom = 132;
                }
                if (m_RollButton != null)
                {
                    m_RollButton.style.right = 92;
                    m_RollButton.style.bottom = 132;
                }
                if (m_PunchButton != null)
                {
                    m_PunchButton.style.right = 160;
                    m_PunchButton.style.bottom = 132;
                }
            }
            else if (touch)
            {
                SetPanelFrame(m_TopPanel, 18, StyleKeyword.Auto, 18, StyleKeyword.Auto, 234, StyleKeyword.Auto);
                SetPanelFrame(m_Minimap, 18, StyleKeyword.Auto, MinimapTop(landscape), StyleKeyword.Auto, 150, 122);
                SetBarFrame(m_CharacterBar, Length.Percent(50), StyleKeyword.Auto, StyleKeyword.Auto, 24, new Translate(Length.Percent(-50), 0));
                SetBarFrame(m_EmoteBar, Length.Percent(50), StyleKeyword.Auto, StyleKeyword.Auto, 72, new Translate(Length.Percent(-50), 0));
                SetBarFrame(m_CameraBar, Length.Percent(50), StyleKeyword.Auto, StyleKeyword.Auto, 118, new Translate(Length.Percent(-50), 0));
                SetBarFrame(m_LevelBar, Length.Percent(50), StyleKeyword.Auto, StyleKeyword.Auto, 166, new Translate(Length.Percent(-50), 0));
                SetPromptFrame(Length.Percent(50), StyleKeyword.Auto, StyleKeyword.Auto, 258, new Translate(Length.Percent(-50), 0), 340, 13);
                SetBarFrame(m_CompactBar, StyleKeyword.Auto, 18, 18, StyleKeyword.Auto, new Translate(0, 0));
                if (m_CompactBar != null) m_CompactBar.style.width = 320;
                SetBarFrame(m_CompactPanel, StyleKeyword.Auto, 18, 68, StyleKeyword.Auto, new Translate(0, 0));
                if (m_CompactPanel != null) m_CompactPanel.style.maxHeight = 430;
                if (m_LevelDialogPanel != null) m_LevelDialogPanel.style.maxWidth = 360;

                PositionJoystickGhost(false);
                if (m_RunButton != null)
                {
                    m_RunButton.style.right = 34;
                    m_RunButton.style.bottom = 98;
                }
                if (m_JumpButton != null)
                {
                    m_JumpButton.style.right = 34;
                    m_JumpButton.style.bottom = 34;
                }
                if (m_RollButton != null)
                {
                    m_RollButton.style.right = 34;
                    m_RollButton.style.bottom = 162;
                }
                if (m_PunchButton != null)
                {
                    m_PunchButton.style.right = 102;
                    m_PunchButton.style.bottom = 34;
                }
            }
            else
            {
                SetPanelFrame(m_TopPanel, 18, StyleKeyword.Auto, 18, StyleKeyword.Auto, 252, StyleKeyword.Auto);
                SetPanelFrame(m_Minimap, 18, StyleKeyword.Auto, MinimapTop(landscape), StyleKeyword.Auto, 220, 168);
                SetBarFrame(m_CharacterBar, Length.Percent(50), StyleKeyword.Auto, StyleKeyword.Auto, 24, new Translate(Length.Percent(-50), 0));
                SetBarFrame(m_EmoteBar, Length.Percent(50), StyleKeyword.Auto, StyleKeyword.Auto, 72, new Translate(Length.Percent(-50), 0));
                SetBarFrame(m_CameraBar, Length.Percent(50), StyleKeyword.Auto, StyleKeyword.Auto, 116, new Translate(Length.Percent(-50), 0));
                SetBarFrame(m_LevelBar, Length.Percent(50), StyleKeyword.Auto, 18, StyleKeyword.Auto, new Translate(Length.Percent(-50), 0));
                SetPromptFrame(Length.Percent(50), StyleKeyword.Auto, StyleKeyword.Auto, 164, new Translate(Length.Percent(-50), 0), 680, 13);
                SetBarFrame(m_CompactBar, StyleKeyword.Auto, 18, 18, StyleKeyword.Auto, new Translate(0, 0));
                if (m_CompactBar != null) m_CompactBar.style.width = 384;
                SetBarFrame(m_CompactPanel, StyleKeyword.Auto, 18, 68, StyleKeyword.Auto, new Translate(0, 0));
                if (m_CompactPanel != null) m_CompactPanel.style.maxHeight = 430;
                if (m_LevelDialogPanel != null) m_LevelDialogPanel.style.maxWidth = 360;
            }

            // Narrow screens (portrait phones / short windows): the top-right segmented bar
            // cannot sit beside the top-left status card without overlapping it. Stack the bar
            // as a full-width row at the very top and drop the status card + minimap below it.
            if (Screen.width < 720 && m_CompactBar != null)
            {
                m_CompactBar.style.left = 12;
                m_CompactBar.style.right = 12;
                m_CompactBar.style.top = 12;
                m_CompactBar.style.width = StyleKeyword.Auto;
                float panelLeft = landscape ? 12f : 18f;
                if (m_TopPanel != null)
                {
                    m_TopPanel.style.left = panelLeft;
                    m_TopPanel.style.top = 64;
                }
                if (m_Minimap != null)
                {
                    float ph = m_TopPanelCollapsed ? 56f : 188f;
                    float resolved = m_TopPanel != null ? m_TopPanel.resolvedStyle.height : float.NaN;
                    if (!float.IsNaN(resolved) && resolved > 1f) ph = resolved;
                    m_Minimap.style.left = panelLeft;
                    m_Minimap.style.top = 64f + ph + 8f;
                }
                if (m_CompactPanel != null) m_CompactPanel.style.top = 60;
            }

            m_CompactBar?.BringToFront();
            m_CompactPanel?.BringToFront();
            m_LevelDialog?.BringToFront();
        }

        // The status panel grows/shrinks with collapse; the minimap follows under it so
        // they never collide. A measured estimate of the panel's resolved height keeps
        // the gap stable across all aspect ratios; falls back to a fixed offset.
        StyleLength MinimapTop(bool landscape)
        {
            float panelTop = landscape ? 12f : 18f;
            float gap = 8f;
            float panelHeight = m_TopPanelCollapsed ? 56f : (landscape ? 150f : 188f);
            if (m_TopPanel != null)
            {
                // The measured height is valid collapsed OR expanded — use it whenever resolved.
                float resolved = m_TopPanel.resolvedStyle.height;
                if (!float.IsNaN(resolved) && resolved > 1f) panelHeight = resolved;
            }
            return panelTop + panelHeight + gap;
        }

        static void SetPanelFrame(VisualElement element, StyleLength left, StyleLength right, StyleLength top, StyleLength bottom, StyleLength width, StyleLength height)
        {
            if (element == null) return;
            element.style.left = left;
            element.style.right = right;
            element.style.top = top;
            element.style.bottom = bottom;
            element.style.width = width;
            element.style.height = height;
        }

        static void SetBarFrame(VisualElement element, StyleLength left, StyleLength right, StyleLength top, StyleLength bottom, Translate translate)
        {
            if (element == null) return;
            element.style.left = left;
            element.style.right = right;
            element.style.top = top;
            element.style.bottom = bottom;
            element.style.translate = translate;
        }

        void SetPromptFrame(StyleLength left, StyleLength right, StyleLength top, StyleLength bottom, Translate translate, StyleLength maxWidth, StyleLength fontSize)
        {
            if (m_Prompt == null) return;
            m_Prompt.style.left = left;
            m_Prompt.style.right = right;
            m_Prompt.style.top = top;
            m_Prompt.style.bottom = bottom;
            m_Prompt.style.translate = translate;
            m_Prompt.style.maxWidth = maxWidth;
            m_Prompt.style.fontSize = fontSize;
            m_Prompt.style.whiteSpace = WhiteSpace.Normal;
            m_Prompt.style.unityTextAlign = TextAnchor.MiddleCenter;
        }

        static bool ShouldShowTouchControls()
        {
            // Touch controls only when there is genuinely no mouse — never on desktop.
            // The old "Min(Screen.width, Screen.height) < 720" heuristic misfired on short
            // desktop browser windows and overlaid full-screen pointer-capturing zones that
            // killed desktop mouse-look / pointer-lock.
            if (Application.isMobilePlatform) return true;
            return Touchscreen.current != null && Mouse.current == null;
        }

        void BuildEmoteBar()
        {
            m_EmoteBar = new VisualElement();
            m_EmoteBar.style.position = Position.Absolute;
            m_EmoteBar.style.left = Length.Percent(50);
            m_EmoteBar.style.bottom = 72;
            m_EmoteBar.style.translate = new Translate(Length.Percent(-50), 0);
            m_EmoteBar.style.flexDirection = FlexDirection.Row;
            m_EmoteBar.style.backgroundColor = k_Glass;
            ApplyBorder(m_EmoteBar, k_Line, 1);
            m_EmoteBar.style.paddingLeft = 5;
            m_EmoteBar.style.paddingRight = 5;
            m_EmoteBar.style.paddingTop = 5;
            m_EmoteBar.style.paddingBottom = 5;

            m_EmoteButtons.Clear();
            RemoveMenuEntriesForRow(1);
            string[] labels = { "Dance", "Wave", "Cheer", "Tag" };
            for (int i = 0; i < labels.Length; i++)
            {
                int index = i;
                Action activate = () => m_Input.QueueTouchEmote(index);
                Button button = new Button(activate) { text = labels[i] };
                button.focusable = true;
                button.tabIndex = 10 + i;
                button.style.marginLeft = 3;
                button.style.marginRight = 3;
                button.style.height = 30;
                button.style.minWidth = 58;
                button.style.unityFontStyleAndWeight = FontStyle.Bold;
                button.style.backgroundColor = k_Fill;
                button.style.color = Color.white;
                ApplyBorder(button, k_Line, 1);
                m_EmoteBar.Add(button);
                m_EmoteButtons.Add(button);
            }

            m_Root.Add(m_EmoteBar);
        }

        void BuildCameraBar()
        {
            m_CameraBar = new VisualElement();
            m_CameraBar.style.position = Position.Absolute;
            m_CameraBar.style.left = Length.Percent(50);
            m_CameraBar.style.bottom = 116;
            m_CameraBar.style.translate = new Translate(Length.Percent(-50), 0);
            m_CameraBar.style.flexDirection = FlexDirection.Row;
            m_CameraBar.style.backgroundColor = k_Glass;
            ApplyBorder(m_CameraBar, k_Line, 1);
            m_CameraBar.style.paddingLeft = 5;
            m_CameraBar.style.paddingRight = 5;
            m_CameraBar.style.paddingTop = 5;
            m_CameraBar.style.paddingBottom = 5;

            m_CameraButtons.Clear();
            RemoveMenuEntriesForRow(2);
            AddCameraButton(DaHilgCameraMode.ThirdPerson, "Follow", 0);
            AddCameraButton(DaHilgCameraMode.Shoulder, "Close", 1);
            AddCameraButton(DaHilgCameraMode.High, "High", 2);
            AddCameraButton(DaHilgCameraMode.TopDown, "Top", 3);
            AddCameraButton(DaHilgCameraMode.FirstPerson, "Eyes", 4);

            m_Root.Add(m_CameraBar);
        }

        void BuildLevelBar()
        {
            m_LevelBar = new VisualElement();
            m_LevelBar.style.position = Position.Absolute;
            m_LevelBar.style.left = Length.Percent(50);
            m_LevelBar.style.top = 18;
            m_LevelBar.style.translate = new Translate(Length.Percent(-50), 0);
            m_LevelBar.style.flexDirection = FlexDirection.Row;
            m_LevelBar.style.backgroundColor = k_Glass;
            ApplyBorder(m_LevelBar, k_Line, 1);
            m_LevelBar.style.paddingLeft = 5;
            m_LevelBar.style.paddingRight = 5;
            m_LevelBar.style.paddingTop = 5;
            m_LevelBar.style.paddingBottom = 5;

            m_LevelButtons.Clear();
            RemoveMenuEntriesForRow(3);
            if (m_Manager.Settings != null && m_Manager.Settings.Levels != null)
            {
                for (int i = 0; i < m_Manager.Settings.Levels.Length; i++)
                {
                    DaHilgLevelProfile profile = m_Manager.Settings.Levels[i];
                    if (profile == null) continue;
                    AddLevelButton(profile, i);
                }
            }

            m_Root.Add(m_LevelBar);
        }

        void BuildCompactControls()
        {
            // ── TOP-RIGHT segmented action bar (VIEW / PLAYER / LEVEL / ACTIONS) ──
            // Square glass strip mirroring the driving game's .segBar; segments stack a
            // tiny kicker over a value.
            m_CompactBar = new VisualElement();
            m_CompactBar.style.position = Position.Absolute;
            m_CompactBar.style.right = 18;
            m_CompactBar.style.top = 18;
            m_CompactBar.style.width = 372;
            m_CompactBar.style.flexDirection = FlexDirection.Row;
            m_CompactBar.style.alignItems = Align.Stretch;
            m_CompactBar.style.backgroundColor = k_Glass;
            ApplyBorder(m_CompactBar, k_Line, 1);
            m_CompactBar.style.overflow = Overflow.Hidden;
            m_CompactBar.style.paddingLeft = 0;
            m_CompactBar.style.paddingRight = 0;
            m_CompactBar.style.paddingTop = 0;
            m_CompactBar.style.paddingBottom = 0;
            m_Root.Add(m_CompactBar);

            m_CompactCameraButton = CompactButton("VIEW", () =>
            {
                m_Manager.CameraRig?.CycleMode();
                Refresh();
            }, 92);
            MakeBarSegment(m_CompactCameraButton);
            m_CompactBar.Add(m_CompactCameraButton);
            RegisterMenuButton(m_CompactCameraButton, 0, 0, () => { m_Manager.CameraRig?.CycleMode(); Refresh(); });

            m_CompactBar.Add(SegmentDivider());

            m_CompactPlayerButton = CompactButton("PLAYER", () =>
            {
                m_Manager.CycleActor(1);
                Refresh();
            }, 96);
            MakeBarSegment(m_CompactPlayerButton);
            m_CompactBar.Add(m_CompactPlayerButton);
            RegisterMenuButton(m_CompactPlayerButton, 0, 1, () => { m_Manager.CycleActor(1); Refresh(); });

            m_CompactBar.Add(SegmentDivider());

            m_CompactLevelButton = CompactButton("LEVEL", () =>
            {
                OpenLevelDialog();
            }, 92);
            MakeBarSegment(m_CompactLevelButton);
            m_CompactBar.Add(m_CompactLevelButton);
            RegisterMenuButton(m_CompactLevelButton, 0, 2, OpenLevelDialog);

            m_CompactBar.Add(SegmentDivider());

            m_CompactMenuButton = CompactButton("ACTIONS", () =>
            {
                ToggleCompactMenu();
            }, 82);
            MakeBarSegment(m_CompactMenuButton);
            m_CompactBar.Add(m_CompactMenuButton);
            RegisterMenuButton(m_CompactMenuButton, 0, 3, () =>
            {
                ToggleCompactMenu();
            });

            ScrollView panel = new ScrollView(ScrollViewMode.Vertical);
            m_CompactPanel = panel;
            m_CompactPanel.style.position = Position.Absolute;
            m_CompactPanel.style.right = 18;
            m_CompactPanel.style.top = 68;
            m_CompactPanel.style.width = 248;
            m_CompactPanel.style.maxHeight = 430;
            m_CompactPanel.style.backgroundColor = k_GlassDeep;
            ApplyBorder(m_CompactPanel, k_Line, 1);
            m_CompactPanel.style.paddingLeft = 8;
            m_CompactPanel.style.paddingRight = 8;
            m_CompactPanel.style.paddingTop = 8;
            m_CompactPanel.style.paddingBottom = 8;
            m_CompactPanel.style.display = DisplayStyle.None;
            m_Root.Add(m_CompactPanel);

            AddCompactActionSection();
        }

        VisualElement SegmentDivider()
        {
            VisualElement divider = new VisualElement();
            divider.style.width = 1;
            divider.style.flexShrink = 0;
            divider.style.backgroundColor = new Color(1f, 1f, 1f, 0.14f);
            divider.style.marginTop = 0;
            divider.style.marginBottom = 0;
            divider.pickingMode = PickingMode.Ignore;
            return divider;
        }

        static void MakeBarSegment(Button button)
        {
            if (button == null) return;
            button.style.flexGrow = 1;
            button.style.flexBasis = 0;
            button.style.minWidth = 0;
            button.style.height = 48;
            button.style.borderTopWidth = 0;
            button.style.borderBottomWidth = 0;
            button.style.borderLeftWidth = 0;
            button.style.borderRightWidth = 0;
        }

        void AddCompactActionSection()
        {
            VisualElement section = CompactSection("ACTIONS");
            VisualElement row = CompactGrid(2);
            string[] labels = { "Dance", "Wave", "Cheer", "Tag" };
            m_CompactEmoteButtons.Clear();
            for (int i = 0; i < labels.Length; i++)
            {
                int index = i;
                Action activate = () =>
                {
                    m_Input.QueueTouchEmote(index);
                    m_CompactMenuOpen = false;
                    Refresh();
                };
                Button button = CompactButton(labels[i], activate, 96);
                StylePanelGridButton(button);
                row.Add(button);
                m_CompactEmoteButtons.Add(button);
                RegisterMenuButton(button, 2, i, activate);
            }
            section.Add(row);

            VisualElement utilityRow = CompactGrid(2);
            Action modeActivate = () =>
            {
                m_Manager.ToggleMode();
                Refresh();
            };
            Button mode = CompactButton("MODE", modeActivate, 96);
            StylePanelGridButton(mode);
            utilityRow.Add(mode);
            RegisterMenuButton(mode, 3, 0, modeActivate);

            Action jumpActivate = () =>
            {
                m_Input.QueueTouchJump();
                m_CompactMenuOpen = false;
                Refresh();
            };
            Button jump = CompactButton("JUMP", jumpActivate, 96);
            StylePanelGridButton(jump);
            utilityRow.Add(jump);
            RegisterMenuButton(jump, 3, 1, jumpActivate);

            Action rollActivate = () =>
            {
                m_Input.QueueTouchRoll();
                m_CompactMenuOpen = false;
                Refresh();
            };
            Button roll = CompactButton("ROLL", rollActivate, 96);
            StylePanelGridButton(roll);
            utilityRow.Add(roll);
            RegisterMenuButton(roll, 3, 2, rollActivate);

            section.Add(utilityRow);
            m_CompactPanel.Add(section);
        }

        void BuildLevelDialog()
        {
            m_LevelDialog = new VisualElement();
            m_LevelDialog.style.position = Position.Absolute;
            m_LevelDialog.style.left = 0;
            m_LevelDialog.style.right = 0;
            m_LevelDialog.style.top = 0;
            m_LevelDialog.style.bottom = 0;
            m_LevelDialog.style.backgroundColor = new Color(0f, 0f, 0f, 0.42f);
            m_LevelDialog.style.display = DisplayStyle.None;
            m_LevelDialog.pickingMode = PickingMode.Position;
            m_LevelDialog.RegisterCallback<PointerDownEvent>(e => e.StopPropagation());
            m_Root.Add(m_LevelDialog);

            m_LevelDialogPanel = new VisualElement();
            m_LevelDialogPanel.style.position = Position.Absolute;
            m_LevelDialogPanel.style.left = Length.Percent(50);
            m_LevelDialogPanel.style.top = Length.Percent(50);
            m_LevelDialogPanel.style.translate = new Translate(Length.Percent(-50), Length.Percent(-50));
            m_LevelDialogPanel.style.width = Length.Percent(88);
            m_LevelDialogPanel.style.maxWidth = 360;
            m_LevelDialogPanel.style.paddingLeft = 18;
            m_LevelDialogPanel.style.paddingRight = 18;
            m_LevelDialogPanel.style.paddingTop = 16;
            m_LevelDialogPanel.style.paddingBottom = 16;
            m_LevelDialogPanel.style.backgroundColor = k_PanelDeep;
            // Square sheet with a nav top accent, like the driving game's #carCard.
            m_LevelDialogPanel.style.borderTopWidth = 2;
            m_LevelDialogPanel.style.borderBottomWidth = 1;
            m_LevelDialogPanel.style.borderLeftWidth = 1;
            m_LevelDialogPanel.style.borderRightWidth = 1;
            m_LevelDialogPanel.style.borderTopColor = k_Nav;
            m_LevelDialogPanel.style.borderBottomColor = k_Line;
            m_LevelDialogPanel.style.borderLeftColor = k_Line;
            m_LevelDialogPanel.style.borderRightColor = k_Line;
            m_LevelDialog.Add(m_LevelDialogPanel);

            m_LevelDialogTitle = Label("CHANGE LEVEL", 18, FontStyle.Bold);
            ApplyFont(m_LevelDialogTitle, m_AgcHeavyFont);
            m_LevelDialogTitle.style.unityTextAlign = TextAnchor.MiddleCenter;
            m_LevelDialogTitle.style.letterSpacing = 1f;
            m_LevelDialogTitle.style.marginBottom = 14;
            m_LevelDialogPanel.Add(m_LevelDialogTitle);

            VisualElement levelList = new VisualElement();
            levelList.style.flexDirection = FlexDirection.Column;
            m_LevelDialogButtons.Clear();
            if (m_Manager.Settings != null && m_Manager.Settings.Levels != null)
            {
                for (int i = 0; i < m_Manager.Settings.Levels.Length; i++)
                {
                    DaHilgLevelProfile profile = m_Manager.Settings.Levels[i];
                    if (profile == null) continue;
                    string slug = profile.Slug;
                    Button button = CompactButton(LevelButtonLabel(profile), () =>
                    {
                        SelectPendingLevel(slug);
                    }, 0);
                    button.style.width = Length.Percent(100);
                    button.style.height = 46;
                    button.style.fontSize = 13;
                    button.style.marginBottom = 8;
                    button.userData = slug;
                    levelList.Add(button);
                    m_LevelDialogButtons.Add(button);
                    RegisterMenuButton(button, 5, i, () => SelectPendingLevel(slug));
                }
            }
            m_LevelDialogPanel.Add(levelList);

            VisualElement actions = new VisualElement();
            actions.style.flexDirection = FlexDirection.Row;
            actions.style.marginTop = 10;
            m_LevelDialogPanel.Add(actions);

            m_LevelCancelButton = CompactButton("CANCEL", CloseLevelDialog, 0);
            m_LevelCancelButton.style.flexGrow = 1;
            m_LevelCancelButton.style.flexBasis = 0;
            m_LevelCancelButton.style.height = 48;
            m_LevelCancelButton.style.fontSize = 13;
            m_LevelCancelButton.style.marginRight = 6;
            actions.Add(m_LevelCancelButton);
            RegisterMenuButton(m_LevelCancelButton, 6, 0, CloseLevelDialog);

            m_LevelConfirmButton = CompactButton("CONFIRM", ConfirmLevelChange, 0);
            m_LevelConfirmButton.style.flexGrow = 1.4f;
            m_LevelConfirmButton.style.flexBasis = 0;
            m_LevelConfirmButton.style.height = 48;
            m_LevelConfirmButton.style.fontSize = 14;
            m_LevelConfirmButton.style.marginLeft = 6;
            m_LevelConfirmButton.style.backgroundColor = WithAlpha(k_Nav, 0.95f);
            actions.Add(m_LevelConfirmButton);
            RegisterMenuButton(m_LevelConfirmButton, 6, 1, ConfirmLevelChange);
        }

        void OpenLevelDialog()
        {
            m_CompactMenuOpen = false;
            m_LevelDialogOpen = true;
            m_PendingLevelSlug = m_Manager.CurrentLevel != null ? m_Manager.CurrentLevel.Slug : null;
            RefreshResponsiveControls();
            RefreshCompactControls(m_Manager.ActiveActor);
        }

        void CloseLevelDialog()
        {
            m_LevelDialogOpen = false;
            RefreshResponsiveControls();
            RefreshCompactControls(m_Manager.ActiveActor);
        }

        void SelectPendingLevel(string slug)
        {
            m_PendingLevelSlug = slug;
            RefreshLevelDialogButtons();
        }

        void ConfirmLevelChange()
        {
            string slug = string.IsNullOrEmpty(m_PendingLevelSlug) && m_Manager.CurrentLevel != null
                ? m_Manager.CurrentLevel.Slug
                : m_PendingLevelSlug;
            CloseLevelDialog();
            if (!string.IsNullOrEmpty(slug)) m_Manager.SetLevel(slug);
        }

        void ToggleCompactMenu()
        {
            m_CompactMenuOpen = !m_CompactMenuOpen;
            m_LevelDialogOpen = false;
            RefreshResponsiveControls();
            RefreshCompactControls(m_Manager.ActiveActor);
        }

        void RefreshLevelDialogButtons()
        {
            if (m_LevelDialog == null) return;
            m_LevelDialog.style.display = m_LevelDialogOpen ? DisplayStyle.Flex : DisplayStyle.None;
            for (int i = 0; i < m_LevelDialogButtons.Count; i++)
            {
                Button button = m_LevelDialogButtons[i];
                string slug = button.userData as string;
                bool selected = !string.IsNullOrEmpty(slug) && slug == m_PendingLevelSlug;
                bool active = m_Manager.CurrentLevel != null && slug == m_Manager.CurrentLevel.Slug;
                Color color = selected
                    ? WithAlpha(k_Go, 0.26f)
                    : (active ? WithAlpha(k_Nav, 0.24f) : k_Fill);
                StyleCompactButton(button, selected || active, color);
            }
        }

        void AddCompactCharacterSection()
        {
            VisualElement section = CompactSection("FAMILY");
            m_CompactCharacterButtons.Clear();
            if (m_Manager.Settings != null && m_Manager.Settings.Characters != null)
            {
                VisualElement row = CompactGrid(2);
                for (int i = 0; i < m_Manager.Settings.Characters.Length; i++)
                {
                    DaHilgCharacterSlot slot = m_Manager.Settings.Characters[i];
                    string slotId = slot.Id;
                    Button button = CompactButton(slot.Label, () =>
                    {
                        m_Manager.SwitchTo(slotId);
                        m_CompactMenuOpen = false;
                        Refresh();
                    }, 96);
                    button.userData = slot.Id;
                    row.Add(button);
                    m_CompactCharacterButtons.Add(button);
                }
                section.Add(row);
            }
            m_CompactPanel.Add(section);
        }

        void AddCompactEmoteSection()
        {
            VisualElement section = CompactSection("EMOTES");
            VisualElement row = CompactGrid(2);
            string[] labels = { "Dance", "Wave", "Cheer", "Tag" };
            m_CompactEmoteButtons.Clear();
            for (int i = 0; i < labels.Length; i++)
            {
                int index = i;
                Button button = CompactButton(labels[i], () =>
                {
                    m_Input.QueueTouchEmote(index);
                    m_CompactMenuOpen = false;
                    Refresh();
                }, 96);
                row.Add(button);
                m_CompactEmoteButtons.Add(button);
            }
            section.Add(row);
            m_CompactPanel.Add(section);
        }

        void AddCompactCameraSection()
        {
            VisualElement section = CompactSection("CAMERA");
            VisualElement row = CompactGrid(2);
            m_CompactCameraButtons.Clear();
            AddCompactCameraButton(row, DaHilgCameraMode.ThirdPerson, "Follow");
            AddCompactCameraButton(row, DaHilgCameraMode.Shoulder, "Close");
            AddCompactCameraButton(row, DaHilgCameraMode.High, "High");
            AddCompactCameraButton(row, DaHilgCameraMode.TopDown, "Top");
            AddCompactCameraButton(row, DaHilgCameraMode.FirstPerson, "Eyes");
            section.Add(row);
            m_CompactPanel.Add(section);
        }

        void AddCompactLevelSection()
        {
            VisualElement section = CompactSection("LEVEL");
            VisualElement row = CompactGrid(2);
            m_CompactLevelButtons.Clear();
            if (m_Manager.Settings != null && m_Manager.Settings.Levels != null)
            {
                for (int i = 0; i < m_Manager.Settings.Levels.Length; i++)
                {
                    DaHilgLevelProfile profile = m_Manager.Settings.Levels[i];
                    if (profile == null) continue;
                    string slug = profile.Slug;
                    Button button = CompactButton(LevelButtonLabel(profile), () =>
                    {
                        m_Manager.SetLevel(slug);
                        m_CompactMenuOpen = false;
                        Refresh();
                    }, 96);
                    button.userData = slug;
                    row.Add(button);
                    m_CompactLevelButtons.Add(button);
                }
            }
            section.Add(row);
            m_CompactPanel.Add(section);
        }

        void AddCompactCameraButton(VisualElement row, DaHilgCameraMode mode, string label)
        {
            Button button = CompactButton(label, () =>
            {
                m_Manager.SetCameraMode(mode);
                m_CompactMenuOpen = false;
                Refresh();
            }, 96);
            button.userData = mode;
            row.Add(button);
            m_CompactCameraButtons.Add(button);
        }

        VisualElement CompactSection(string title)
        {
            VisualElement section = new VisualElement();
            section.style.flexDirection = FlexDirection.Column;
            section.style.marginBottom = 8;
            Label label = Label(title, 8, FontStyle.Bold);
            label.style.color = k_TextDim;
            label.style.letterSpacing = 1.5f;
            label.style.marginBottom = 6;
            section.Add(label);
            return section;
        }

        VisualElement CompactGrid(int columns)
        {
            VisualElement grid = new VisualElement();
            grid.style.flexDirection = FlexDirection.Row;
            grid.style.flexWrap = Wrap.Wrap;
            grid.style.justifyContent = Justify.SpaceBetween;
            return grid;
        }

        static void StylePanelGridButton(Button button)
        {
            if (button == null) return;
            button.style.flexGrow = 0;
            button.style.flexBasis = Length.Percent(48);
            button.style.minWidth = 0;
            button.style.marginBottom = 6;
        }

        Button CompactButton(string text, Action activate, float minWidth)
        {
            float lastActivation = -10f;
            void ActivateOnce()
            {
                if (Time.unscaledTime - m_LastHudActivationTime < 0.08f) return;
                if (Time.unscaledTime - lastActivation < 0.12f) return;
                lastActivation = Time.unscaledTime;
                m_LastHudActivationTime = Time.unscaledTime;
                activate?.Invoke();
            }

            Button button = new Button(ActivateOnce) { text = text };
            button.focusable = true;
            button.style.minWidth = minWidth;
            button.style.height = 44;
            button.style.marginLeft = 0;
            button.style.marginRight = 0;
            button.style.marginTop = 0;
            button.style.marginBottom = 0;
            button.style.paddingLeft = 9;
            button.style.paddingRight = 9;
            button.style.backgroundColor = k_Fill;
            button.style.color = Color.white;
            button.style.unityFontStyleAndWeight = FontStyle.Bold;
            button.style.unityTextAlign = TextAnchor.MiddleCenter;
            button.style.whiteSpace = WhiteSpace.Normal;
            button.style.fontSize = 11;
            ApplyBorder(button, k_Line, 1);
            button.RegisterCallback<PointerDownEvent>(e =>
            {
                ActivateOnce();
                e.StopPropagation();
            });
            return button;
        }

        void AddCameraButton(DaHilgCameraMode mode, string label, int column)
        {
            Action activate = () => m_Manager.SetCameraMode(mode);
            Button button = new Button(activate) { text = label };
            button.userData = mode;
            button.focusable = true;
            button.tabIndex = 20 + column;
            button.style.marginLeft = 3;
            button.style.marginRight = 3;
            button.style.height = 30;
            button.style.minWidth = 58;
            button.style.unityFontStyleAndWeight = FontStyle.Bold;
            button.style.backgroundColor = k_Fill;
            button.style.color = Color.white;
            ApplyBorder(button, k_Line, 1);
            m_CameraBar.Add(button);
            m_CameraButtons.Add(button);
        }

        void AddLevelButton(DaHilgLevelProfile profile, int column)
        {
            string slug = profile.Slug;
            Action activate = () => m_Manager.SetLevel(slug);
            Button button = new Button(activate) { text = LevelButtonLabel(profile) };
            button.userData = slug;
            button.focusable = true;
            button.tabIndex = 30 + column;
            button.style.marginLeft = 3;
            button.style.marginRight = 3;
            button.style.height = 30;
            button.style.minWidth = 68;
            button.style.unityFontStyleAndWeight = FontStyle.Bold;
            button.style.backgroundColor = k_Fill;
            button.style.color = Color.white;
            ApplyBorder(button, k_Line, 1);
            m_LevelBar.Add(button);
            m_LevelButtons.Add(button);
        }

        static string LevelButtonLabel(DaHilgLevelProfile profile)
        {
            switch (profile.Slug)
            {
                case "dahill": return "Home";
                case "house": return "House";
                case "canyon": return "Canyon";
                case "stanton": return "Stanton";
                default: return string.IsNullOrEmpty(profile.Label) ? profile.Slug : profile.Label;
            }
        }

        void RegisterMenuButton(Button button, int row, int column, Action activate)
        {
            MenuEntry entry = new MenuEntry
            {
                Button = button,
                Row = row,
                Column = column,
                Activate = activate
            };
            m_MenuEntries.Add(entry);

            button.RegisterCallback<PointerDownEvent>(_ => SelectMenuButton(button, true));
            button.RegisterCallback<PointerEnterEvent>(_ => SelectMenuButton(button, true));
            button.RegisterCallback<FocusInEvent>(_ => SelectMenuButton(button, true));
        }

        void RemoveMenuEntriesForRow(int row)
        {
            for (int i = m_MenuEntries.Count - 1; i >= 0; i--)
            {
                if (m_MenuEntries[i].Row == row) m_MenuEntries.RemoveAt(i);
            }
            m_SelectedMenuIndex = Mathf.Clamp(m_SelectedMenuIndex, -1, m_MenuEntries.Count - 1);
        }

        void EnsureMenuSelection()
        {
            if (m_SelectedMenuIndex >= 0 && m_SelectedMenuIndex < m_MenuEntries.Count) return;

            int activeCharacter = -1;
            if (m_Manager != null && m_Manager.ActiveActor != null)
            {
                for (int i = 0; i < m_MenuEntries.Count; i++)
                {
                    if (m_MenuEntries[i].Row == 0 && (m_MenuEntries[i].Button.userData as string) == m_Manager.ActiveActor.Id)
                    {
                        activeCharacter = i;
                        break;
                    }
                }
            }

            m_SelectedMenuIndex = activeCharacter >= 0 ? activeCharacter : (m_MenuEntries.Count > 0 ? 0 : -1);
        }

        void SelectMenuButton(Button button, bool focused)
        {
            for (int i = 0; i < m_MenuEntries.Count; i++)
            {
                if (m_MenuEntries[i].Button != button) continue;
                m_SelectedMenuIndex = i;
                m_MenuFocused = focused;
                ApplyMenuSelectionStyles();
                return;
            }
        }

        void MoveMenuSelection(int columnDelta, int rowDelta)
        {
            EnsureMenuSelection();
            if (m_SelectedMenuIndex < 0 || m_SelectedMenuIndex >= m_MenuEntries.Count) return;

            MenuEntry current = m_MenuEntries[m_SelectedMenuIndex];
            int targetRow = current.Row + rowDelta;
            if (!HasMenuRow(targetRow))
            {
                targetRow = rowDelta > 0 ? LowestMenuRow() : HighestMenuRow();
            }

            int targetColumn = current.Column + columnDelta;
            m_SelectedMenuIndex = FindClosestMenuEntry(targetRow, targetColumn, columnDelta);
        }

        bool HasMenuRow(int row)
        {
            for (int i = 0; i < m_MenuEntries.Count; i++)
            {
                if (m_MenuEntries[i].Row == row) return true;
            }
            return false;
        }

        int LowestMenuRow()
        {
            int row = int.MaxValue;
            for (int i = 0; i < m_MenuEntries.Count; i++) row = Mathf.Min(row, m_MenuEntries[i].Row);
            return row == int.MaxValue ? 0 : row;
        }

        int HighestMenuRow()
        {
            int row = int.MinValue;
            for (int i = 0; i < m_MenuEntries.Count; i++) row = Mathf.Max(row, m_MenuEntries[i].Row);
            return row == int.MinValue ? 0 : row;
        }

        int FindClosestMenuEntry(int row, int column, int columnDelta)
        {
            int first = -1;
            int last = -1;
            int closest = -1;
            int closestDistance = int.MaxValue;

            for (int i = 0; i < m_MenuEntries.Count; i++)
            {
                MenuEntry entry = m_MenuEntries[i];
                if (entry.Row != row) continue;
                if (first < 0 || entry.Column < m_MenuEntries[first].Column) first = i;
                if (last < 0 || entry.Column > m_MenuEntries[last].Column) last = i;

                int distance = Mathf.Abs(entry.Column - column);
                if (distance < closestDistance)
                {
                    closest = i;
                    closestDistance = distance;
                }
            }

            if (closest >= 0 && columnDelta == 0) return closest;
            if (closest >= 0 && m_MenuEntries[closest].Column == column) return closest;
            if (columnDelta > 0 && last >= 0 && column > m_MenuEntries[last].Column) return first;
            if (columnDelta < 0 && first >= 0 && column < m_MenuEntries[first].Column) return last;
            return closest >= 0 ? closest : m_SelectedMenuIndex;
        }

        void FocusSelectedMenuButton()
        {
            if (m_SelectedMenuIndex < 0 || m_SelectedMenuIndex >= m_MenuEntries.Count) return;
            m_MenuEntries[m_SelectedMenuIndex].Button.Focus();
        }

        void ActivateSelectedMenuEntry()
        {
            if (m_SelectedMenuIndex < 0 || m_SelectedMenuIndex >= m_MenuEntries.Count) return;
            MenuEntry entry = m_MenuEntries[m_SelectedMenuIndex];
            entry.Button.Focus();
            m_LastHudActivationTime = Time.unscaledTime;
            entry.Activate?.Invoke();
            ApplyMenuSelectionStyles();
        }

        void TickTouchHudFallback()
        {
            if (!ShouldShowTouchControls() || m_Root == null || m_Root.panel == null) return;

            Touchscreen touchscreen = Touchscreen.current;
            if (touchscreen == null || !touchscreen.primaryTouch.press.wasPressedThisFrame) return;

            Vector2 screenPoint = touchscreen.primaryTouch.position.ReadValue();
            TryActivateHudButtonFromScreen(screenPoint);
        }

        bool TryActivateHudButtonFromScreen(Vector2 screenPoint)
        {
            if (!ShouldShowTouchControls() || m_Root == null || m_Root.panel == null) return false;
            if (Time.unscaledTime - m_LastHudActivationTime < 0.08f) return false;

            Vector2 panelPoint = RuntimePanelUtils.ScreenToPanel(m_Root.panel, screenPoint);
            if (TryActivateHudButtonAt(panelPoint))
            {
                m_LastHudActivationTime = Time.unscaledTime;
                return true;
            }

            return false;
        }

        bool TryActivateHudButtonAt(Vector2 panelPoint)
        {
            if (m_LevelDialogOpen)
            {
                if (TryActivateButtonAt(m_LevelCancelButton, CloseLevelDialog, panelPoint)) return true;
                if (TryActivateButtonAt(m_LevelConfirmButton, ConfirmLevelChange, panelPoint)) return true;
                for (int i = m_LevelDialogButtons.Count - 1; i >= 0; i--)
                {
                    Button button = m_LevelDialogButtons[i];
                    string slug = button.userData as string;
                    if (TryActivateButtonAt(button, () => SelectPendingLevel(slug), panelPoint)) return true;
                }
                return ElementContains(m_LevelDialogPanel, panelPoint);
            }

            if (TryActivateButtonAt(m_TopCollapseButton, ToggleTopPanel, panelPoint)) return true;

            for (int i = m_MenuEntries.Count - 1; i >= 0; i--)
            {
                MenuEntry entry = m_MenuEntries[i];
                Button button = entry.Button;
                if (!ButtonContains(button, panelPoint)) continue;

                SelectMenuButton(button, true);
                entry.Activate?.Invoke();
                ApplyMenuSelectionStyles();
                return true;
            }

            return false;
        }

        bool TryActivateCompactTopFromCss(float cssX, float cssY, float cssWidth)
        {
            if (cssWidth <= 1f || cssY < 0f || cssY > 76f) return false;

            bool compactMobileScale = cssWidth < 900f;
            float scale = compactMobileScale ? 0.62f : 1f;
            float rightInset = compactMobileScale ? 8f : 18f;
            float fromRight = cssWidth - cssX - rightInset;
            if (fromRight < 0f) return false;

            float actionWidth = 90f * scale;
            float levelWidth = 96f * scale;
            float playerWidth = 106f * scale;
            float cameraWidth = 100f * scale;
            if (fromRight > actionWidth + levelWidth + playerWidth + cameraWidth) return false;

            string command;
            if (fromRight <= actionWidth) command = "actions";
            else if (fromRight <= actionWidth + levelWidth) command = "level";
            else if (fromRight <= actionWidth + levelWidth + playerWidth) command = "player";
            else command = "camera";

            bool activated = ActivateCompactCommand(command);
            if (!activated) return false;

            m_LastHudActivationTime = Time.unscaledTime;
            Debug.Log("[DaHilg] HUD touch fallback: " + command);
            return true;
        }

        bool ActivateCompactCommand(string command)
        {
            if (m_Manager == null) return false;

            switch (command.Trim().ToLowerInvariant())
            {
                case "camera":
                case "view":
                    m_Manager.CameraRig?.CycleMode();
                    Refresh();
                    return true;
                case "player":
                    m_Manager.CycleActor(1);
                    Refresh();
                    return true;
                case "level":
                    OpenLevelDialog();
                    return true;
                case "actions":
                case "menu":
                    ToggleCompactMenu();
                    return true;
                case "attack":
                case "punch":
                    m_Input?.QueueTouchAttack();
                    return true;
                default:
                    return false;
            }
        }

        bool TryActivateButtonAt(Button button, Action activate, Vector2 panelPoint)
        {
            if (!ButtonContains(button, panelPoint)) return false;
            SelectMenuButton(button, true);
            activate?.Invoke();
            ApplyMenuSelectionStyles();
            return true;
        }

        static bool ButtonContains(Button button, Vector2 panelPoint)
        {
            if (button == null) return false;
            return ElementContains(button, panelPoint);
        }

        static bool ElementContains(VisualElement element, Vector2 panelPoint)
        {
            if (element == null || element.panel == null || !element.visible) return false;
            for (VisualElement current = element; current != null; current = current.parent)
            {
                if (current.resolvedStyle.display == DisplayStyle.None) return false;
            }

            Rect bounds = element.worldBound;
            return bounds.width > 1f && bounds.height > 1f && bounds.Contains(panelPoint);
        }

        void ApplyMenuSelectionStyles()
        {
            for (int i = 0; i < m_MenuEntries.Count; i++)
            {
                MenuEntry entry = m_MenuEntries[i];
                Button button = entry.Button;
                bool selected = m_MenuFocused && i == m_SelectedMenuIndex;
                bool activeCharacter = entry.Row == 0
                    && m_Manager != null
                    && m_Manager.ActiveActor != null
                    && (button.userData as string) == m_Manager.ActiveActor.Id;
                bool activeCamera = entry.Row == 2
                    && m_Manager != null
                    && m_Manager.CameraRig != null
                    && button.userData is DaHilgCameraMode mode
                    && m_Manager.CameraRig.Mode == mode;
                bool activeLevel = entry.Row == 3
                    && m_Manager != null
                    && m_Manager.CurrentLevel != null
                    && (button.userData as string) == m_Manager.CurrentLevel.Slug;

                // Keyboard/gamepad focus uses the coin highlight; active state uses white.
                Color border = selected
                    ? k_Coin
                    : (activeCharacter || activeCamera || activeLevel ? Color.white : k_Line);
                float borderWidth = selected ? 3f : (activeCharacter || activeCamera || activeLevel ? 2f : 1f);

                button.style.borderTopColor = border;
                button.style.borderBottomColor = border;
                button.style.borderLeftColor = border;
                button.style.borderRightColor = border;
                button.style.borderTopWidth = borderWidth;
                button.style.borderBottomWidth = borderWidth;
                button.style.borderLeftWidth = borderWidth;
                button.style.borderRightWidth = borderWidth;
            }
        }

        void OnJoyDown(PointerDownEvent e)
        {
            if (!ShouldShowTouchControls() || m_JoyPointer >= 0) return;
            m_JoyPointer = e.pointerId;
            m_JoyCenter = e.position;
            PositionJoystick(m_JoyCenter, true);
            m_MoveZone.CapturePointer(e.pointerId);
            UpdateJoy(e.position);
            e.StopPropagation();
        }

        void OnJoyMove(PointerMoveEvent e)
        {
            if (m_JoyPointer != e.pointerId) return;
            UpdateJoy(e.position);
            e.StopPropagation();
        }

        void OnJoyUp(PointerUpEvent e)
        {
            if (m_JoyPointer != e.pointerId) return;
            ReleaseJoy(e.pointerId);
            e.StopPropagation();
        }

        void OnJoyCancel(PointerCancelEvent e)
        {
            if (m_JoyPointer != e.pointerId) return;
            ReleaseJoy(e.pointerId);
            e.StopPropagation();
        }

        void ReleaseJoy(int pointerId)
        {
            m_JoyPointer = -1;
            m_Input.SetTouchMove(Vector2.zero, false);
            CenterJoyKnob();
            PositionJoystickGhost(Screen.width > Screen.height);
            if (m_MoveZone != null && m_MoveZone.HasPointerCapture(pointerId)) m_MoveZone.ReleasePointer(pointerId);
        }

        void UpdateJoy(Vector2 pointer)
        {
            Vector2 delta = pointer - m_JoyCenter;
            Vector2 clamped = Vector2.ClampMagnitude(delta, k_JoyRadius);
            Vector2 n = new Vector2(clamped.x / k_JoyRadius, -clamped.y / k_JoyRadius);
            if (n.magnitude < 0.12f) n = Vector2.zero;
            m_Input.SetTouchMove(n, true);
            m_Knob.style.left = (k_JoySize - k_JoyKnobSize) * 0.5f + clamped.x;
            m_Knob.style.top = (k_JoySize - k_JoyKnobSize) * 0.5f + clamped.y;
        }

        void OnLookDown(PointerDownEvent e)
        {
            if (!ShouldShowTouchControls() || m_LookPointer >= 0) return;
            m_LookPointer = e.pointerId;
            m_LookLast = e.position;
            m_LookZone.CapturePointer(e.pointerId);
            e.StopPropagation();
        }

        void OnLookMove(PointerMoveEvent e)
        {
            if (m_LookPointer != e.pointerId) return;
            Vector2 p = e.position;
            Vector2 delta = p - m_LookLast;
            m_Input.AddTouchLook(new Vector2(delta.x, -delta.y));
            m_LookLast = p;
            e.StopPropagation();
        }

        void OnLookUp(PointerUpEvent e)
        {
            if (m_LookPointer != e.pointerId) return;
            ReleaseLook(e.pointerId);
            e.StopPropagation();
        }

        void OnLookCancel(PointerCancelEvent e)
        {
            if (m_LookPointer != e.pointerId) return;
            ReleaseLook(e.pointerId);
            e.StopPropagation();
        }

        void ReleaseLook(int pointerId)
        {
            m_LookPointer = -1;
            if (m_LookZone != null && m_LookZone.HasPointerCapture(pointerId)) m_LookZone.ReleasePointer(pointerId);
        }

        void CenterJoyKnob()
        {
            if (m_Knob == null) return;
            m_Knob.style.left = (k_JoySize - k_JoyKnobSize) * 0.5f;
            m_Knob.style.top = (k_JoySize - k_JoyKnobSize) * 0.5f;
        }

        void PositionJoystick(Vector2 center, bool active)
        {
            if (m_Joy == null) return;
            m_Joy.style.left = center.x - k_JoySize * 0.5f;
            m_Joy.style.top = center.y - k_JoySize * 0.5f;
            m_Joy.style.bottom = StyleKeyword.Auto;
            m_Joy.style.opacity = active ? 0.92f : 0.46f;
        }

        void PositionJoystickGhost(bool landscape)
        {
            if (m_Joy == null || m_JoyPointer >= 0) return;
            float h = RootHeight();
            Vector2 center = landscape
                ? new Vector2(92f, h - 98f)
                : new Vector2(98f, h - 132f);
            PositionJoystick(center, false);
        }

        float RootHeight()
        {
            if (m_Root != null)
            {
                float h = m_Root.resolvedStyle.height;
                if (!float.IsNaN(h) && h > 1f) return h;
            }
            return Mathf.Max(1f, Screen.height);
        }

        // ── Theme helpers ─────────────────────────────────────────────────────────
        static Color WithAlpha(Color c, float a)
        {
            return new Color(c.r, c.g, c.b, a);
        }

        static void ApplyBorder(VisualElement element, Color color, float width)
        {
            if (element == null) return;
            element.style.borderTopWidth = width;
            element.style.borderBottomWidth = width;
            element.style.borderLeftWidth = width;
            element.style.borderRightWidth = width;
            element.style.borderTopColor = color;
            element.style.borderBottomColor = color;
            element.style.borderLeftColor = color;
            element.style.borderRightColor = color;
        }

        static VisualElement Panel()
        {
            // Square nav-app glass card (radius 0), matching the driving game's .glass/.panel.
            VisualElement panel = new VisualElement();
            panel.style.position = Position.Absolute;
            panel.style.paddingLeft = 13;
            panel.style.paddingRight = 13;
            panel.style.paddingTop = 11;
            panel.style.paddingBottom = 12;
            panel.style.backgroundColor = k_Glass;
            ApplyBorder(panel, k_Line, 1);
            return panel;
        }

        static Label Label(string text, int size, FontStyle style)
        {
            Label label = new Label(text);
            label.style.fontSize = size;
            label.style.unityFontStyleAndWeight = style;
            label.style.color = Color.white;
            return label;
        }

        // Square pill counter chip with a colored kicker accent (mirrors .ssCell / chips).
        Label Chip(string text, Color accent)
        {
            Label label = Label(text, 12, FontStyle.Bold);
            label.style.marginRight = 8;
            label.style.paddingLeft = 9;
            label.style.paddingRight = 9;
            label.style.paddingTop = 4;
            label.style.paddingBottom = 4;
            label.style.letterSpacing = 1f;
            label.style.backgroundColor = WithAlpha(accent, 0.16f);
            ApplyBorder(label, WithAlpha(accent, 0.55f), 1);
            label.style.color = Color.white;
            return label;
        }

        Button TouchButton(string text, Color accent)
        {
            Button button = new Button { text = text };
            button.style.position = Position.Absolute;
            button.style.width = 58;
            button.style.height = 48;
            button.style.backgroundColor = WithAlpha(accent, 0.82f);
            button.style.color = Color.white;
            button.style.unityFontStyleAndWeight = FontStyle.Bold;
            ApplyBorder(button, WithAlpha(Color.white, 0.22f), 1);
            return button;
        }
    }
}
