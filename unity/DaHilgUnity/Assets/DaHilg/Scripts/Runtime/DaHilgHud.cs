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
        // ── Driving-game theme tokens ─────────────────────────────────────────────
        // SINGLE SOURCE OF TRUTH lives in DaHilgHudTheme; these aliases keep the rest of
        // the file terse. The drive HUD uses rounded glass chrome + neutral control fills
        // and reserves the bright accents for ACTIVE states only — see DaHilgHudTheme.
        static readonly Color k_Nav = DaHilgHudTheme.Nav;          // --nav  #2D8CFF
        static readonly Color k_Go = DaHilgHudTheme.Go;            // --go   #2BE84F
        static readonly Color k_Coin = DaHilgHudTheme.Coin;        // --coin #FFC83D
        static readonly Color k_Reverse = DaHilgHudTheme.Reverse;  // --reverse #FF5247
        static readonly Color k_Jump = DaHilgHudTheme.Jump;        // --jump #9B7BFF
        static readonly Color k_Glass = DaHilgHudTheme.Glass;      // --hud-glass
        static readonly Color k_GlassDeep = DaHilgHudTheme.GlassDeep;
        static readonly Color k_PanelDeep = DaHilgHudTheme.PanelDeep;
        static readonly Color k_Line = DaHilgHudTheme.Line;        // --hud-line
        static readonly Color k_Text = DaHilgHudTheme.Text;        // --txt
        static readonly Color k_TextDim = DaHilgHudTheme.TextDim;
        static readonly Color k_TextFaint = DaHilgHudTheme.TextFaint;
        static readonly Color k_Fill = DaHilgHudTheme.Fill;
        static readonly Color k_FillHi = DaHilgHudTheme.FillHi;
        static readonly Color k_StripGlass = DaHilgHudTheme.StripGlass;
        static readonly Color k_StripSheen = DaHilgHudTheme.StripSheen;
        static readonly Color k_CellDivider = DaHilgHudTheme.CellDivider;
        static readonly Color k_TrackBg = DaHilgHudTheme.TrackBg;

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
        Label m_HpValue;
        Label m_SwarmValue;
        Label m_ScoreCellKick;
        VisualElement m_SwarmCell;
        VisualElement m_SwarmDivider;
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
        bool m_DidAutoCollapseForTouch;

        const float k_JoySize = 142f;
        const float k_JoyKnobSize = 54f;
        const float k_JoyRadius = 58f;

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
            // Clean tally in the SCORE cell value; the combo multiplier rides the cell's
            // ALL-CAPS kicker (SCORE / SCORE ×1.5) so the value stays a tidy number.
            m_Score.text = m_Manager.Score.ToString("000");
            m_Score.style.color = combo > 1.01f ? k_Reverse : k_Coin;
            if (m_ScoreCellKick != null) m_ScoreCellKick.text = combo > 1.01f ? "SCORE ×" + combo.ToString("0.#") : "SCORE";
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

            // HP cell — value % + thin fill ramp: go (>60) → coin (30..60) → reverse (<30),
            // matching the driving game's HealthBar fill ramp.
            float health = Mathf.Clamp(actor.Health, 0f, 100f);
            Color healthColor = health < 30f ? k_Reverse : (health < 60f ? k_Coin : k_Go);
            m_HealthFill.style.width = Length.Percent(health);
            m_HealthFill.style.backgroundColor = healthColor;
            if (m_HpValue != null)
            {
                m_HpValue.text = Mathf.RoundToInt(health) + "%";
                m_HpValue.style.color = healthColor;
            }
            RefreshNibblerStatus(actor);

            UpdateTopCompactLabel(actor, health);

            if (m_Manager.IsPaused()) m_Prompt.text = "Paused";
            else if (m_Manager.ShowSafeBanner) m_Prompt.text = "SAFE  ·  banked +" + m_Manager.LastBank;
            else if (m_Manager.Mode == DaHilgGameMode.Greet && m_Manager.NearbyGreetable != null) m_Prompt.text = "E greet " + m_Manager.NearbyGreetable.Label;
            else if (m_Manager.Mode == DaHilgGameMode.Nibblers && m_Manager.PlayerInSafeZone()) m_Prompt.text = "Safe zone";
            else if (m_Manager.LastMeleeCrushes > 0) m_Prompt.text = "Punched " + m_Manager.LastMeleeCrushes + " nibblers";
            else if (m_Manager.LastMeleeHits > 0) m_Prompt.text = "Punch hit";
            else if (m_Manager.LastMeleeMiss) m_Prompt.text = "Punch missed";
            else if (m_Manager.Mode == DaHilgGameMode.Nibblers && m_Manager.LastRollCrushCount > 0) m_Prompt.text = "Crushed " + m_Manager.LastRollCrushCount + " nibblers";
            else if (m_Manager.Mode == DaHilgGameMode.Nibblers && m_Manager.PlayerMarked) m_Prompt.text = "Marked · swarm incoming";
            else if (m_Manager.Mode == DaHilgGameMode.Nibblers && actor.AttachedNibblers >= m_Manager.Settings.OverwhelmStop) m_Prompt.text = "Pinned · roll or jump";
            else if (m_Manager.Mode == DaHilgGameMode.Nibblers && actor.AttachedNibblers >= m_Manager.Settings.OverwhelmDown) m_Prompt.text = "Downed · roll or crawl";
            else m_Prompt.text = ShouldShowTouchControls()
                ? "Stick move · drag look · punch · roll"
                : "WASD · right-click aim · Q/click punch · F roll · C/V";

            for (int i = 0; i < m_CharacterButtons.Count; i++)
            {
                Button button = m_CharacterButtons[i];
                string id = button.userData as string;
                bool active = id == actor.Id;
                button.EnableInClassList("active", active);
                // Active = tinted glass + colored accent ring (drive HUD .charOpt.on); resting
                // is plain neutral glass. Colour lives on state, not on the resting fill.
                Color accent = CharacterAccent(id);
                button.style.backgroundColor = active ? WithAlpha(accent, 0.22f) : k_Fill;
                Color border = active ? new Color(accent.r, accent.g, accent.b, 0.9f) : k_Line;
                button.style.borderTopColor = border;
                button.style.borderBottomColor = border;
                button.style.borderLeftColor = border;
                button.style.borderRightColor = border;
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
            // The SWARM cell + roll readout only matter in Nibblers mode. The SCORE cell
            // doubles as a CRUSHED tally there. Drop the SWARM cell AND its leading
            // divider together in Greet mode so the strip stays a clean HP | SCORE pair.
            DisplayStyle nibblerDisplay = nibblers ? DisplayStyle.Flex : DisplayStyle.None;
            m_SwarmCell.style.display = nibblerDisplay;
            if (m_SwarmDivider != null) m_SwarmDivider.style.display = nibblerDisplay;
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
            if (m_SwarmValue != null)
            {
                m_SwarmValue.text = actor.AttachedNibblers.ToString("00");
                m_SwarmValue.style.color = buried01 > 0.66f ? k_Reverse : (buried01 > 0.33f ? k_Coin : Color.white);
            }

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
                StyleBarSegment(m_CompactCameraButton, false, k_Nav);
            }

            if (m_CompactPlayerButton != null)
            {
                string label = actor != null && !string.IsNullOrEmpty(actor.Label) ? actor.Label.ToUpperInvariant() : "—";
                SetSegmentLabel(m_CompactPlayerButton, "PLAYER", label);
                StyleBarSegment(m_CompactPlayerButton, false, k_Nav);
            }

            if (m_CompactLevelButton != null)
            {
                string label = m_Manager.CurrentLevel != null
                    ? LevelButtonLabel(m_Manager.CurrentLevel).ToUpperInvariant()
                    : "LEVEL";
                SetSegmentLabel(m_CompactLevelButton, "LEVEL", label);
                StyleBarSegment(m_CompactLevelButton, m_LevelDialogOpen, k_Go);
            }

            if (m_CompactMenuButton != null)
            {
                SetSegmentLabel(m_CompactMenuButton, m_CompactMenuOpen ? "CLOSE" : "MENU", m_CompactMenuOpen ? string.Empty : "ACTIONS");
                StyleBarSegment(m_CompactMenuButton, m_CompactMenuOpen, k_Nav);
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

        void StyleBarSegment(Button button, bool active, Color accent)
        {
            if (button == null) return;
            // Resting = near-transparent neutral fill (airy, lets the strip glass + sheen
            // through). Active = the drive PRIMARY look: a SOLID accent fill with white
            // text — the one segment that is "on" reads boldly, the rest stay quiet.
            button.style.backgroundColor = active ? WithAlpha(accent, 0.92f) : k_Fill;
            button.style.color = Color.white;
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

            // Only CONSUME input when an overlay menu is genuinely open. The compact action bar is always
            // visible, and hovering/clicking it focus-latches m_MenuFocused — without this gate, the
            // Activate/Cancel branches below reported "consumed" during normal play, and since attack/
            // roll/jump are gated by !menuConsumedInput in DaHilgGameManager, those actions got swallowed
            // (worst on gamepad, where A=Jump=MenuActivate and B=Roll=MenuCancel share a button).
            bool menuActive = m_CompactMenuOpen || m_LevelDialogOpen;

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

            if (menuActive && input.MenuCancelPressed && m_MenuFocused)
            {
                m_MenuFocused = false;
                ApplyMenuSelectionStyles();
                return true;
            }

            if (menuActive && input.MenuActivatePressed && m_MenuFocused)
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
                TryActivateCompactTopFromCss(cssX, cssY, cssWidth, cssHeight);
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
            m_MarkLabel.style.top = Length.Percent(30); // clear of the top-left status card on narrow phones
            m_MarkLabel.style.translate = new Translate(Length.Percent(-50), 0);
            m_MarkLabel.style.paddingLeft = 14;
            m_MarkLabel.style.paddingRight = 14;
            m_MarkLabel.style.paddingTop = 7;
            m_MarkLabel.style.paddingBottom = 7;
            m_MarkLabel.style.backgroundColor = WithAlpha(k_Reverse, 0.86f);
            m_MarkLabel.style.letterSpacing = 2f;
            RoundCorners(m_MarkLabel, DaHilgHudTheme.Radius);
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
            RoundCorners(m_Prompt, DaHilgHudTheme.RadiusLg);
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
            // ── TOP-LEFT status: thin title pill + segmented strip ────────────────
            // Mirrors the drive HUD's airy top-left: a slim title/mode bar over a
            // segmented .scoreStrip (HP | SWARM | SCORE cells split by hairlines), NOT
            // a heavy opaque card. UIToolkit can't backdrop-blur, so we keep the
            // surfaces THIN and LIGHT (k_StripGlass) with a faint top sheen instead.
            // m_TopPanel is a transparent stacking column; the strips supply the glass.
            m_TopPanel = new VisualElement();
            m_TopPanel.style.position = Position.Absolute;
            m_TopPanel.style.left = 18;
            m_TopPanel.style.top = 18;
            m_TopPanel.style.width = 252;
            m_TopPanel.style.flexDirection = FlexDirection.Column;
            m_Root.Add(m_TopPanel);

            // ── Title pill: title + mode chip + collapse toggle, always visible ────
            VisualElement header = Strip();
            header.style.flexDirection = FlexDirection.Row;
            header.style.alignItems = Align.Center;
            header.style.paddingLeft = 12;
            header.style.paddingRight = 6;
            header.style.paddingTop = 5;
            header.style.paddingBottom = 5;
            m_TopPanel.Add(header);

            m_Title = Label("Da Hilg", 15, FontStyle.Bold);
            ApplyFont(m_Title, m_AgcHeavyFont);
            m_Title.style.flexGrow = 1;
            m_Title.style.flexShrink = 1;
            m_Title.style.letterSpacing = 0.4f;
            m_Title.style.overflow = Overflow.Hidden;
            m_Title.style.textOverflow = TextOverflow.Ellipsis;
            m_Title.style.whiteSpace = WhiteSpace.NoWrap;
            header.Add(m_Title);

            m_Mode = Chip("GREET", k_Nav);
            m_Mode.style.marginRight = 6;
            m_Mode.style.fontSize = 9;
            m_Mode.style.letterSpacing = DaHilgHudTheme.KickerTracking;
            header.Add(m_Mode);

            m_TopCollapseButton = new Button(ToggleTopPanel) { text = "▾" };
            m_TopCollapseButton.focusable = true;
            m_TopCollapseButton.style.width = 44;   // 44px minimum touch target
            m_TopCollapseButton.style.height = 36;
            m_TopCollapseButton.style.marginLeft = 0;
            m_TopCollapseButton.style.marginTop = 0;
            m_TopCollapseButton.style.marginBottom = 0;
            m_TopCollapseButton.style.marginRight = 0;
            m_TopCollapseButton.style.paddingLeft = 0;
            m_TopCollapseButton.style.paddingRight = 0;
            m_TopCollapseButton.style.paddingTop = 0;
            m_TopCollapseButton.style.paddingBottom = 0;
            m_TopCollapseButton.style.flexShrink = 0;
            m_TopCollapseButton.style.fontSize = 13;
            m_TopCollapseButton.style.color = k_TextFaint;
            m_TopCollapseButton.style.backgroundColor = Color.clear;
            m_TopCollapseButton.style.unityTextAlign = TextAnchor.MiddleCenter;
            ApplyBorder(m_TopCollapseButton, Color.clear, 0);
            RoundCorners(m_TopCollapseButton, 8f);
            header.Add(m_TopCollapseButton);

            // Collapsed one-line strip (hidden until collapsed): rides under the title pill.
            m_TopCompactStrip = Strip();
            m_TopCompactStrip.style.flexDirection = FlexDirection.Row;
            m_TopCompactStrip.style.alignItems = Align.Center;
            m_TopCompactStrip.style.marginTop = 7;
            m_TopCompactStrip.style.paddingLeft = 12;
            m_TopCompactStrip.style.paddingRight = 12;
            m_TopCompactStrip.style.paddingTop = 6;
            m_TopCompactStrip.style.paddingBottom = 6;
            m_TopCompactStrip.style.display = DisplayStyle.None;
            m_TopPanel.Add(m_TopCompactStrip);
            m_TopCompactLabel = Label("", 11, FontStyle.Bold);
            m_TopCompactLabel.style.color = k_TextFaint;
            m_TopCompactLabel.style.letterSpacing = 0.5f;
            m_TopCompactStrip.Add(m_TopCompactLabel);

            // ── Expanded body: the segmented status strip + roll readout ───────────
            m_TopPanelBody = new VisualElement();
            m_TopPanelBody.style.flexDirection = FlexDirection.Column;
            m_TopPanelBody.style.marginTop = 7;
            m_TopPanel.Add(m_TopPanelBody);

            // The segmented strip: HP | SWARM | SCORE cells in ONE thin glass strip,
            // divided by hairlines, each cell a tiny ALL-CAPS kicker over a value —
            // exactly the drive dash's .dashCluster / .scoreStrip cell pattern.
            VisualElement strip = Strip();
            strip.style.flexDirection = FlexDirection.Row;
            strip.style.alignItems = Align.Stretch;
            strip.style.overflow = Overflow.Hidden; // clip cells + fills to the rounded frame
            m_TopPanelBody.Add(strip);

            // HP cell — kicker over % value, with a thin fill bar pinned to the bottom.
            VisualElement hpCell = StripCell();
            m_HpValue = CellValue("100%");
            hpCell.Add(CellKicker("HP"));
            hpCell.Add(m_HpValue);
            m_HealthFill = CellTrackFill(hpCell, k_Go);
            strip.Add(hpCell);

            m_SwarmDivider = StripCellDivider();
            strip.Add(m_SwarmDivider);

            // SWARM cell — kicker over rider count, fill bar = buried-load gauge.
            m_SwarmCell = StripCell();
            m_SwarmValue = CellValue("00");
            m_SwarmCell.Add(CellKicker("SWARM"));
            m_SwarmCell.Add(m_SwarmValue);
            m_NibblerFill = CellTrackFill(m_SwarmCell, k_Go);
            m_NibblerMeter = m_SwarmCell; // back-compat alias: visibility toggled in RefreshNibblerStatus
            strip.Add(m_SwarmCell);

            strip.Add(StripCellDivider());

            // SCORE cell — kicker (SCORE / SCORE ×combo) over the bold AGC tally; the
            // crushed-nibbler count lives in the ROLL readout line below the strip.
            VisualElement scoreCell = StripCell();
            m_ScoreCellKick = CellKicker("SCORE");
            m_Score = CellValue("000");
            ApplyFont(m_Score, m_AgcHeavyFont);
            m_Score.style.color = k_Coin;
            scoreCell.Add(m_ScoreCellKick);
            scoreCell.Add(m_Score);
            strip.Add(scoreCell);

            // ROLL / status readout: a thin tracked line under the strip (drive .miniHint vibe).
            m_RollState = Label("", 10, FontStyle.Bold);
            m_RollState.style.marginTop = 6;
            m_RollState.style.marginLeft = 3;
            m_RollState.style.letterSpacing = DaHilgHudTheme.KickerTracking;
            m_TopPanelBody.Add(m_RollState);

            // Secondary cause-ticker line: rider HP-drain / BANK·BEST / greet status.
            // A thin dim line, like the drive HUD's .miniHint — not a heavy block.
            m_Attached = Label("", 10, FontStyle.Normal);
            m_Attached.style.marginTop = 4;
            m_Attached.style.marginLeft = 3;
            m_Attached.style.color = k_TextFaint;
            m_Attached.style.letterSpacing = 0.4f;
            m_TopPanelBody.Add(m_Attached);

            // m_State stays a data sink feeding the collapsed one-line strip; not rendered
            // on its own in the airy layout (the cells carry name/HP/score).
            m_State = Label("", 12, FontStyle.Normal);

            ApplyTopPanelCollapsedState();
        }

        // ── Airy-strip building blocks (mirror .scoreStrip / .dashCluster) ─────────
        // A thin, light translucent glass strip with a hairline border and a faint
        // top sheen cap — the UIToolkit stand-in for the drive HUD's frosted glass.
        VisualElement Strip()
        {
            VisualElement strip = new VisualElement();
            strip.style.backgroundColor = k_StripGlass;
            ApplyBorder(strip, k_Line, 1);
            RoundCorners(strip, DaHilgHudTheme.StripRadius);
            strip.style.overflow = Overflow.Hidden;

            // Faux top-down gradient: a faint sheen pinned to the top third lifts the
            // strip off the scene so it reads light/airy without a real blur.
            VisualElement sheen = new VisualElement();
            sheen.pickingMode = PickingMode.Ignore;
            sheen.style.position = Position.Absolute;
            sheen.style.left = 0;
            sheen.style.right = 0;
            sheen.style.top = 0;
            sheen.style.height = Length.Percent(46);
            sheen.style.backgroundColor = k_StripSheen;
            strip.Add(sheen);
            return strip;
        }

        // One segmented cell: a centered column that stacks a kicker over a value,
        // like .ssCell.trip / .dashCol. flexBasis 0 keeps the three cells even.
        static VisualElement StripCell()
        {
            VisualElement cell = new VisualElement();
            cell.style.position = Position.Relative;
            cell.style.flexGrow = 1;
            cell.style.flexBasis = 0;
            cell.style.flexDirection = FlexDirection.Column;
            cell.style.alignItems = Align.FlexStart;
            cell.style.justifyContent = Justify.Center;
            cell.style.paddingLeft = 11;
            cell.style.paddingRight = 11;
            cell.style.paddingTop = 7;
            cell.style.paddingBottom = 9;
            return cell;
        }

        Label CellKicker(string text)
        {
            Label label = Label(text, DaHilgHudTheme.FontKicker, FontStyle.Bold);
            label.style.color = k_TextDim;
            label.style.letterSpacing = DaHilgHudTheme.KickerTracking;
            label.style.marginBottom = 2;
            return label;
        }

        Label CellValue(string text)
        {
            Label label = Label(text, DaHilgHudTheme.FontCellValue, FontStyle.Bold);
            ApplyFont(label, m_AgcHeavyFont);
            label.style.color = Color.white;
            label.style.unityFontStyleAndWeight = FontStyle.Bold;
            return label;
        }

        // A thin gauge fill pinned to the cell's bottom edge (the .dashBar i / health ramp).
        VisualElement CellTrackFill(VisualElement cell, Color color)
        {
            VisualElement track = new VisualElement();
            track.pickingMode = PickingMode.Ignore;
            track.style.position = Position.Absolute;
            track.style.left = 0;
            track.style.right = 0;
            track.style.bottom = 0;
            track.style.height = 3;
            track.style.backgroundColor = k_TrackBg;
            cell.Add(track);

            VisualElement fill = new VisualElement();
            fill.pickingMode = PickingMode.Ignore;
            fill.style.position = Position.Absolute;
            fill.style.left = 0;
            fill.style.top = 0;
            fill.style.bottom = 0;
            fill.style.width = Length.Percent(100);
            fill.style.backgroundColor = color;
            track.Add(fill);
            return fill;
        }

        VisualElement StripCellDivider()
        {
            VisualElement divider = new VisualElement();
            divider.pickingMode = PickingMode.Ignore;
            divider.style.width = 1;
            divider.style.flexShrink = 0;
            divider.style.backgroundColor = k_CellDivider;
            return divider;
        }

        void ToggleTopPanel()
        {
            if (Time.unscaledTime - m_LastHudActivationTime < 0.08f) return;
            m_LastHudActivationTime = Time.unscaledTime;
            m_TopPanelCollapsed = !m_TopPanelCollapsed;
            ApplyTopPanelCollapsedState();
            Refresh();
        }

        void ApplyTopPanelCollapsedState()
        {
            if (m_TopCollapseButton != null) m_TopCollapseButton.text = m_TopPanelCollapsed ? "▸" : "▾";
            if (m_TopPanelBody != null) m_TopPanelBody.style.display = m_TopPanelCollapsed ? DisplayStyle.None : DisplayStyle.Flex;
            if (m_TopCompactStrip != null) m_TopCompactStrip.style.display = m_TopPanelCollapsed ? DisplayStyle.Flex : DisplayStyle.None;
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
            RoundCorners(m_CharacterBar, DaHilgHudTheme.RadiusLg);
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
                button.tabIndex = i;
                // Neutral glass like the drive HUD's .charSwitch — the per-character accent
                // only shows on the ACTIVE outline (set in Refresh), never as a pastel fill.
                StyleHudButton(button, DaHilgHudTheme.TouchTarget, DaHilgHudTheme.FontLabel);
                button.style.marginLeft = 4;
                button.style.marginRight = 4;
                button.style.minWidth = 66;
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
            m_MoveZone.style.width = Length.Percent(48);
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
            m_LookZone.style.width = Length.Percent(52);
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
            m_Root.Add(punch);

            RefreshResponsiveControls();
        }

        void RefreshResponsiveControls()
        {
            bool touch = ShouldShowTouchControls();
            if (touch && !m_DidAutoCollapseForTouch)
            {
                m_DidAutoCollapseForTouch = true;
                m_TopPanelCollapsed = true;
                ApplyTopPanelCollapsedState();
            }
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
            if (m_Minimap != null) m_Minimap.style.display = DisplayStyle.Flex;

            if (landscape)
            {
                ApplyCompactBarSizing(46f, 10f);
                SetPanelFrame(m_TopPanel, 12, StyleKeyword.Auto, 12, StyleKeyword.Auto, 210, StyleKeyword.Auto);
                // Minimap owns the upper-right; the segmented menu bar drops below it.
                SetPanelFrame(m_Minimap, StyleKeyword.Auto, 12, 12, StyleKeyword.Auto, 174, 120);
                SetBarFrame(m_CharacterBar, StyleKeyword.Auto, 12, 152, StyleKeyword.Auto, new Translate(0, 0));
                SetBarFrame(m_EmoteBar, StyleKeyword.Auto, 12, 198, StyleKeyword.Auto, new Translate(0, 0));
                SetBarFrame(m_CameraBar, StyleKeyword.Auto, 12, 244, StyleKeyword.Auto, new Translate(0, 0));
                SetBarFrame(m_LevelBar, StyleKeyword.Auto, 12, 290, StyleKeyword.Auto, new Translate(0, 0));
                SetPromptFrame(Length.Percent(50), StyleKeyword.Auto, 14, StyleKeyword.Auto, new Translate(Length.Percent(-50), 0), 300, 12);
                SetBarFrame(m_CompactBar, StyleKeyword.Auto, 12, 144, StyleKeyword.Auto, new Translate(0, 0));
                if (m_CompactBar != null) m_CompactBar.style.width = 336;
                SetBarFrame(m_CompactPanel, StyleKeyword.Auto, 12, 196, StyleKeyword.Auto, new Translate(0, 0));
                if (m_CompactPanel != null) m_CompactPanel.style.maxHeight = 178;
                if (m_LevelDialogPanel != null) m_LevelDialogPanel.style.maxWidth = 320;

                PositionJoystickGhost(true);
                if (m_RunButton != null)
                {
                    m_RunButton.style.right = 24;
                    m_RunButton.style.bottom = 214;
                }
                if (m_JumpButton != null)
                {
                    m_JumpButton.style.right = 24;
                    m_JumpButton.style.bottom = 132;
                }
                if (m_RollButton != null)
                {
                    m_RollButton.style.right = 104;
                    m_RollButton.style.bottom = 132;
                }
                if (m_PunchButton != null)
                {
                    m_PunchButton.style.right = 184;
                    m_PunchButton.style.bottom = 132;
                }
            }
            else if (touch)
            {
                ApplyCompactBarSizing(46f, 9.5f);
                SetPanelFrame(m_TopPanel, 16, StyleKeyword.Auto, 16, StyleKeyword.Auto, 218, StyleKeyword.Auto);
                SetPanelFrame(m_Minimap, StyleKeyword.Auto, 16, 16, StyleKeyword.Auto, 136, 108);
                SetBarFrame(m_CharacterBar, Length.Percent(50), StyleKeyword.Auto, StyleKeyword.Auto, 24, new Translate(Length.Percent(-50), 0));
                SetBarFrame(m_EmoteBar, Length.Percent(50), StyleKeyword.Auto, StyleKeyword.Auto, 72, new Translate(Length.Percent(-50), 0));
                SetBarFrame(m_CameraBar, Length.Percent(50), StyleKeyword.Auto, StyleKeyword.Auto, 118, new Translate(Length.Percent(-50), 0));
                SetBarFrame(m_LevelBar, Length.Percent(50), StyleKeyword.Auto, StyleKeyword.Auto, 166, new Translate(Length.Percent(-50), 0));
                SetPromptFrame(Length.Percent(50), StyleKeyword.Auto, StyleKeyword.Auto, 258, new Translate(Length.Percent(-50), 0), 340, 13);
                SetBarFrame(m_CompactBar, StyleKeyword.Auto, 16, 134, StyleKeyword.Auto, new Translate(0, 0));
                if (m_CompactBar != null) m_CompactBar.style.width = 300;
                SetBarFrame(m_CompactPanel, StyleKeyword.Auto, 16, 184, StyleKeyword.Auto, new Translate(0, 0));
                if (m_CompactPanel != null) m_CompactPanel.style.maxHeight = 430;
                if (m_LevelDialogPanel != null) m_LevelDialogPanel.style.maxWidth = 360;

                PositionJoystickGhost(false);
                // 66px circular discs: stack with ~8px gaps so they never overlap each other.
                if (m_JumpButton != null)
                {
                    m_JumpButton.style.right = 26;
                    m_JumpButton.style.bottom = 30;
                }
                if (m_PunchButton != null)
                {
                    m_PunchButton.style.right = 108;
                    m_PunchButton.style.bottom = 30;
                }
                if (m_RunButton != null)
                {
                    m_RunButton.style.right = 26;
                    m_RunButton.style.bottom = 110;
                }
                if (m_RollButton != null)
                {
                    m_RollButton.style.right = 26;
                    m_RollButton.style.bottom = 190;
                }
            }
            else
            {
                ApplyCompactBarSizing(50f, 11f);
                SetPanelFrame(m_TopPanel, 18, StyleKeyword.Auto, 18, StyleKeyword.Auto, 232, StyleKeyword.Auto);
                SetPanelFrame(m_Minimap, StyleKeyword.Auto, 18, 18, StyleKeyword.Auto, 190, 148);
                SetBarFrame(m_CharacterBar, Length.Percent(50), StyleKeyword.Auto, StyleKeyword.Auto, 24, new Translate(Length.Percent(-50), 0));
                SetBarFrame(m_EmoteBar, Length.Percent(50), StyleKeyword.Auto, StyleKeyword.Auto, 72, new Translate(Length.Percent(-50), 0));
                SetBarFrame(m_CameraBar, Length.Percent(50), StyleKeyword.Auto, StyleKeyword.Auto, 116, new Translate(Length.Percent(-50), 0));
                SetBarFrame(m_LevelBar, Length.Percent(50), StyleKeyword.Auto, 18, StyleKeyword.Auto, new Translate(Length.Percent(-50), 0));
                SetPromptFrame(Length.Percent(50), StyleKeyword.Auto, StyleKeyword.Auto, 164, new Translate(Length.Percent(-50), 0), 680, 13);
                // Minimap owns the top-right corner; the segmented menu bar drops below it.
                SetBarFrame(m_CompactBar, StyleKeyword.Auto, 18, 178, StyleKeyword.Auto, new Translate(0, 0));
                if (m_CompactBar != null) m_CompactBar.style.width = 344;
                SetBarFrame(m_CompactPanel, StyleKeyword.Auto, 18, 230, StyleKeyword.Auto, new Translate(0, 0));
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
                m_CompactBar.style.top = 10;
                m_CompactBar.style.width = StyleKeyword.Auto;
                float panelLeft = landscape ? 12f : 14f;
                if (m_TopPanel != null)
                {
                    m_TopPanel.style.left = panelLeft;
                    m_TopPanel.style.top = 56;
                    m_TopPanel.style.width = Mathf.Clamp(Screen.width - 170f, 176f, 218f);
                }
                if (m_Minimap != null)
                {
                    m_Minimap.style.left = StyleKeyword.Auto;
                    m_Minimap.style.right = 12;
                    m_Minimap.style.top = 56f;
                    m_Minimap.style.width = 132;
                    m_Minimap.style.height = 108;
                }
                if (m_CompactPanel != null) m_CompactPanel.style.top = 54;
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

        void ApplyCompactBarSizing(float height, float fontSize)
        {
            if (m_CompactBar != null) m_CompactBar.style.height = height;
            ApplyBarButtonSizing(m_CompactCameraButton, height, fontSize);
            ApplyBarButtonSizing(m_CompactPlayerButton, height, fontSize);
            ApplyBarButtonSizing(m_CompactLevelButton, height, fontSize);
            ApplyBarButtonSizing(m_CompactMenuButton, height, fontSize);
        }

        static void ApplyBarButtonSizing(Button button, float height, float fontSize)
        {
            if (button == null) return;
            button.style.height = height;
            button.style.fontSize = fontSize;
            button.style.paddingLeft = 4;
            button.style.paddingRight = 4;
            button.style.paddingTop = 0;
            button.style.paddingBottom = 0;
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

        static bool s_HadMouse;
        static int s_WebTouchMode = -1; // -1 unknown, 0 desktop, 1 touch — set authoritatively by the page

        // Called from index.html JS once Unity is ready, with the browser's reliable touch verdict
        // (maxTouchPoints + no fine pointer). This is what makes the PHONE actually show the
        // joystick/look/buttons, since Unity's WebGL device detection can't tell a phone from a desktop.
        [Preserve]
        public void SetWebTouchMode(int touch)
        {
            s_WebTouchMode = touch != 0 ? 1 : 0;
            if (s_WebTouchMode != 0 && !m_DidAutoCollapseForTouch)
            {
                m_DidAutoCollapseForTouch = true;
                m_TopPanelCollapsed = true;
                ApplyTopPanelCollapsedState();
            }
            else if (s_WebTouchMode == 0)
            {
                m_DidAutoCollapseForTouch = false;
            }
            RefreshResponsiveControls();
        }

        static bool ShouldShowTouchControls()
        {
            // The page's JS touch verdict is authoritative when present.
            if (s_WebTouchMode >= 0) return s_WebTouchMode != 0;
            // Fallback until it arrives: a real touchscreen wins, even with an attached iPad
            // keyboard/trackpad. Desktop without touch still locks to mouse+keyboard.
            if (Application.isMobilePlatform || Touchscreen.current != null) return true;
            if (Keyboard.current != null) return false;
            if (Mouse.current != null) s_HadMouse = true;
            return !s_HadMouse;
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
            RoundCorners(m_EmoteBar, DaHilgHudTheme.RadiusLg);
            m_EmoteBar.style.paddingLeft = 5;
            m_EmoteBar.style.paddingRight = 5;
            m_EmoteBar.style.paddingTop = 5;
            m_EmoteBar.style.paddingBottom = 5;

            m_EmoteButtons.Clear();
            RemoveMenuEntriesForRow(1);
            string[] labels = { "Dance", "Wave", "Cheer" };
            for (int i = 0; i < labels.Length; i++)
            {
                int index = i;
                Action activate = () => m_Input.QueueTouchEmote(index);
                Button button = new Button(activate) { text = labels[i] };
                button.tabIndex = 10 + i;
                StyleHudButton(button, DaHilgHudTheme.TouchTarget, 12);
                button.style.marginLeft = 3;
                button.style.marginRight = 3;
                button.style.minWidth = 58;
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
            RoundCorners(m_CameraBar, DaHilgHudTheme.RadiusLg);
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
            RoundCorners(m_LevelBar, DaHilgHudTheme.RadiusLg);
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
            // Thin, light glass strip mirroring the driving game's .segBar; segments
            // stack a tiny kicker over a value and divide on hairlines. The lighter
            // k_StripGlass + top sheen keep it airy (no real backdrop blur available).
            m_CompactBar = Strip();
            m_CompactBar.style.position = Position.Absolute;
            m_CompactBar.style.right = 18;
            m_CompactBar.style.top = 18;
            m_CompactBar.style.width = 372;
            m_CompactBar.style.flexDirection = FlexDirection.Row;
            m_CompactBar.style.alignItems = Align.Stretch;
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
            RoundCorners(m_CompactPanel, DaHilgHudTheme.RadiusLg);
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
            // Segments tile edge-to-edge inside the rounded+clipped .segBar container, so they
            // drop their own border AND radius — the outer frame supplies both.
            if (button == null) return;
            button.style.flexGrow = 1;
            button.style.flexBasis = 0;
            button.style.minWidth = 0;
            button.style.height = 50;
            button.style.minHeight = 50;
            button.style.borderTopWidth = 0;
            button.style.borderBottomWidth = 0;
            button.style.borderLeftWidth = 0;
            button.style.borderRightWidth = 0;
            RoundCorners(button, 0f);
        }

        void AddCompactActionSection()
        {
            VisualElement section = CompactSection("ACTIONS");
            VisualElement row = CompactGrid(2);
            string[] labels = { "Dance", "Wave", "Cheer" };
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
            Action punchActivate = () =>
            {
                m_Input.QueueTouchAttack();
                m_CompactMenuOpen = false;
                Refresh();
            };
            Button punch = CompactButton("PUNCH", punchActivate, 96);
            StylePanelGridButton(punch);
            utilityRow.Add(punch);
            RegisterMenuButton(punch, 3, 0, punchActivate);

            Action modeActivate = () =>
            {
                m_Manager.ToggleMode();
                Refresh();
            };
            Button mode = CompactButton("MODE", modeActivate, 96);
            StylePanelGridButton(mode);
            utilityRow.Add(mode);
            RegisterMenuButton(mode, 3, 1, modeActivate);

            Action jumpActivate = () =>
            {
                m_Input.QueueTouchJump();
                m_CompactMenuOpen = false;
                Refresh();
            };
            Button jump = CompactButton("JUMP", jumpActivate, 96);
            StylePanelGridButton(jump);
            utilityRow.Add(jump);
            RegisterMenuButton(jump, 3, 2, jumpActivate);

            Action rollActivate = () =>
            {
                m_Input.QueueTouchRoll();
                m_CompactMenuOpen = false;
                Refresh();
            };
            Button roll = CompactButton("ROLL", rollActivate, 96);
            StylePanelGridButton(roll);
            utilityRow.Add(roll);
            RegisterMenuButton(roll, 3, 3, rollActivate);

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
            // Rounded sheet with a nav top accent, like the driving game's #carCard.
            m_LevelDialogPanel.style.borderTopWidth = 2;
            m_LevelDialogPanel.style.borderBottomWidth = 1;
            m_LevelDialogPanel.style.borderLeftWidth = 1;
            m_LevelDialogPanel.style.borderRightWidth = 1;
            m_LevelDialogPanel.style.borderTopColor = k_Nav;
            m_LevelDialogPanel.style.borderBottomColor = k_Line;
            m_LevelDialogPanel.style.borderLeftColor = k_Line;
            m_LevelDialogPanel.style.borderRightColor = k_Line;
            RoundCorners(m_LevelDialogPanel, DaHilgHudTheme.RadiusLg);
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
            string[] labels = { "Dance", "Wave", "Cheer" };
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
            // Drive HUD .actionKick: a tiny ALL-CAPS tracked kicker over the grid.
            Label label = Label(title, DaHilgHudTheme.FontKicker, FontStyle.Bold);
            label.style.color = k_TextDim;
            label.style.letterSpacing = DaHilgHudTheme.KickerTracking;
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
            StyleHudButton(button, DaHilgHudTheme.TouchTarget, 12);
            button.style.minWidth = minWidth;
            button.style.marginLeft = 0;
            button.style.marginRight = 0;
            button.style.marginTop = 0;
            button.style.marginBottom = 0;
            button.style.paddingLeft = 9;
            button.style.paddingRight = 9;
            button.style.whiteSpace = WhiteSpace.Normal;
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
            button.tabIndex = 20 + column;
            StyleHudButton(button, DaHilgHudTheme.TouchTarget, 12);
            button.style.marginLeft = 3;
            button.style.marginRight = 3;
            button.style.minWidth = 58;
            m_CameraBar.Add(button);
            m_CameraButtons.Add(button);
        }

        void AddLevelButton(DaHilgLevelProfile profile, int column)
        {
            string slug = profile.Slug;
            Action activate = () => m_Manager.SetLevel(slug);
            Button button = new Button(activate) { text = LevelButtonLabel(profile) };
            button.userData = slug;
            button.tabIndex = 30 + column;
            StyleHudButton(button, DaHilgHudTheme.TouchTarget, 12);
            button.style.marginLeft = 3;
            button.style.marginRight = 3;
            button.style.minWidth = 68;
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
            // No PointerEnter hover-latch: a mere mouse-graze of the always-visible compact bar must NOT
            // flip m_MenuFocused on desktop (that, with the consume gate, was eating gameplay input).
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

        bool TryActivateCompactTopFromCss(float cssX, float cssY, float cssWidth, float cssHeight)
        {
            if (cssWidth <= 1f || cssHeight <= 1f || m_CompactBar == null) return false;

            Rect bounds = m_CompactBar.worldBound;
            if (bounds.width <= 1f || bounds.height <= 1f) return false;

            float scaleX = cssWidth / Mathf.Max(1f, Screen.width);
            float scaleY = cssHeight / Mathf.Max(1f, Screen.height);
            Rect cssBounds = new Rect(bounds.xMin * scaleX, bounds.yMin * scaleY, bounds.width * scaleX, bounds.height * scaleY);
            if (!cssBounds.Contains(new Vector2(cssX, cssY))) return false;

            float segment = cssBounds.width / 4f;
            if (segment <= 1f) return false;

            float localX = cssX - cssBounds.xMin;
            string command;
            if (localX < segment) command = "camera";
            else if (localX < segment * 2f) command = "player";
            else if (localX < segment * 3f) command = "level";
            else command = "actions";

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
            float magnitude = delta.magnitude;
            if (magnitude > k_JoyRadius)
            {
                // Floating-stick behavior: once the thumb reaches the edge, slide the base under it.
                // This keeps sustained movement smooth when the finger drifts, like common mobile
                // third-person controls, instead of feeling like it hit a hard stop.
                m_JoyCenter += delta.normalized * (magnitude - k_JoyRadius);
                PositionJoystick(m_JoyCenter, true);
                delta = pointer - m_JoyCenter;
            }
            Vector2 clamped = Vector2.ClampMagnitude(delta, k_JoyRadius);
            Vector2 n = new Vector2(clamped.x / k_JoyRadius, -clamped.y / k_JoyRadius);
            if (n.magnitude < 0.09f) n = Vector2.zero;
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

        // Rounded glass corners — the drive HUD theme rounds every control / panel
        // (10–14px). Routing this through one helper keeps the radius consistent.
        static void RoundCorners(VisualElement element, float radius)
        {
            if (element == null) return;
            element.style.borderTopLeftRadius = radius;
            element.style.borderTopRightRadius = radius;
            element.style.borderBottomLeftRadius = radius;
            element.style.borderBottomRightRadius = radius;
        }

        // The one true HUD button styling. Every interactive button (bars, menus,
        // dialog, compact panel) routes through here so they share the drive theme:
        // neutral translucent fill, rounded corners, hairline border, bold AGC text,
        // and a guaranteed ≥44px touch target.
        void StyleHudButton(Button button, float minHeight = DaHilgHudTheme.TouchTarget, int fontSize = DaHilgHudTheme.FontLabel)
        {
            if (button == null) return;
            button.focusable = true;
            button.style.minHeight = minHeight;
            button.style.height = StyleKeyword.Auto;
            button.style.backgroundColor = k_Fill;
            button.style.color = Color.white;
            button.style.unityFontStyleAndWeight = FontStyle.Bold;
            button.style.unityTextAlign = TextAnchor.MiddleCenter;
            button.style.fontSize = fontSize;
            button.style.letterSpacing = 0.4f;
            button.style.paddingLeft = 12;
            button.style.paddingRight = 12;
            button.style.paddingTop = 6;
            button.style.paddingBottom = 6;
            ApplyBorder(button, k_Line, 1);
            RoundCorners(button, DaHilgHudTheme.Radius);
            ApplyFont(button, m_AgcFont);
        }

        static VisualElement Panel()
        {
            // Rounded nav-app glass card, matching the driving game's .glass/.panel.
            VisualElement panel = new VisualElement();
            panel.style.position = Position.Absolute;
            panel.style.paddingLeft = 13;
            panel.style.paddingRight = 13;
            panel.style.paddingTop = 11;
            panel.style.paddingBottom = 12;
            panel.style.backgroundColor = k_Glass;
            ApplyBorder(panel, k_Line, 1);
            RoundCorners(panel, DaHilgHudTheme.RadiusLg);
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

        // Rounded pill counter chip with a colored accent border (mirrors .ssCell / .chip).
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
            RoundCorners(label, DaHilgHudTheme.RadiusLg);
            label.style.color = Color.white;
            return label;
        }

        Button TouchButton(string text, Color accent)
        {
            // Circular thumb disc. The drive theme keeps the resting fill NEUTRAL glass and
            // uses the accent only as a colored ring + label tint — so the on-screen action
            // pad reads as the clean driving HUD, not a row of candy buttons.
            const float d = 72f;
            Button button = new Button { text = text };
            button.focusable = true;
            button.style.position = Position.Absolute;
            button.style.width = d;
            button.style.height = d;
            RoundCorners(button, DaHilgHudTheme.RadiusPill);
            button.style.paddingLeft = 0;
            button.style.paddingRight = 0;
            button.style.paddingTop = 0;
            button.style.paddingBottom = 0;
            button.style.backgroundColor = k_Fill;
            button.style.color = Color.white;
            button.style.fontSize = 13;
            button.style.letterSpacing = 0.5f;
            button.style.unityFontStyleAndWeight = FontStyle.Bold;
            ApplyBorder(button, WithAlpha(accent, 0.8f), 2);
            ApplyFont(button, m_AgcFont);
            return button;
        }
    }
}
