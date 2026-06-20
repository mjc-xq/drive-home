using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.UIElements;

namespace DaHilg
{
    [RequireComponent(typeof(UIDocument))]
    public sealed class DaHilgHud : MonoBehaviour
    {
        DaHilgGameManager m_Manager;
        DaHilgInputRouter m_Input;
        VisualElement m_Root;
        Label m_Title;
        Label m_State;
        Label m_Score;
        Label m_Prompt;
        Label m_Mode;
        Label m_Attached;
        VisualElement m_HealthFill;
        VisualElement m_TopPanel;
        DaHilgMinimapElement m_Minimap;
        VisualElement m_CharacterBar;
        VisualElement m_EmoteBar;
        VisualElement m_CameraBar;
        VisualElement m_LevelBar;
        VisualElement m_Joy;
        VisualElement m_Knob;
        Button m_RunButton;
        Button m_JumpButton;
        int m_JoyPointer = -1;
        int m_LookPointer = -1;
        Vector2 m_JoyCenter;
        Vector2 m_LookLast;
        readonly List<Button> m_CharacterButtons = new List<Button>(4);
        readonly List<Button> m_EmoteButtons = new List<Button>(4);
        readonly List<Button> m_CameraButtons = new List<Button>(5);
        readonly List<Button> m_LevelButtons = new List<Button>(4);
        readonly List<MenuEntry> m_MenuEntries = new List<MenuEntry>(16);
        int m_SelectedMenuIndex = -1;
        bool m_MenuFocused;

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
            m_Score.text = m_Manager.Score.ToString("000");
            m_Attached.text = m_Manager.Mode == DaHilgGameMode.Nibblers
                ? actor.AttachedNibblers + " attached"
                : (m_Manager.HasWon() ? "all greeted" : "family nearby");
            m_State.text = actor.Label + " · " + Mathf.RoundToInt(actor.Health) + "%";
            m_HealthFill.style.width = Length.Percent(Mathf.Clamp(actor.Health, 0f, 100f));

            if (m_Manager.IsPaused()) m_Prompt.text = "Paused";
            else if (m_Manager.Mode == DaHilgGameMode.Greet && m_Manager.NearbyGreetable != null) m_Prompt.text = "E greet " + m_Manager.NearbyGreetable.Label;
            else if (m_Manager.Mode == DaHilgGameMode.Nibblers && m_Manager.PlayerInSafeZone()) m_Prompt.text = "Safe zone";
            else if (m_Manager.Mode == DaHilgGameMode.Nibblers && m_Manager.PlayerInDangerZone()) m_Prompt.text = "Danger zone · nibblers incoming";
            else if (m_Manager.Mode == DaHilgGameMode.Nibblers && actor.AttachedNibblers >= m_Manager.Settings.OverwhelmStop) m_Prompt.text = "Pinned · jump to shake loose";
            else if (m_Manager.Mode == DaHilgGameMode.Nibblers && actor.AttachedNibblers >= m_Manager.Settings.OverwhelmDown) m_Prompt.text = "Downed · crawl and jump";
            else m_Prompt.text = ShouldShowTouchControls()
                ? "Stick move · drag look · jump · emotes"
                : "WASD move · right-drag look · Space jump · Tab switch · C/V camera · N mode";

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
                button.style.backgroundColor = active ? new Color(0.16f, 0.46f, 0.92f, 0.88f) : new Color(1f, 1f, 1f, 0.12f);
                button.style.borderTopColor = active ? Color.white : new Color(1f, 1f, 1f, 0.22f);
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
                button.style.backgroundColor = active ? new Color(0.12f, 0.56f, 0.38f, 0.88f) : new Color(1f, 1f, 1f, 0.12f);
                button.style.borderTopColor = active ? Color.white : new Color(1f, 1f, 1f, 0.22f);
                button.style.borderBottomColor = button.style.borderTopColor.value;
                button.style.borderLeftColor = button.style.borderTopColor.value;
                button.style.borderRightColor = button.style.borderTopColor.value;
                button.style.borderTopWidth = active ? 2 : 1;
                button.style.borderBottomWidth = button.style.borderTopWidth.value;
                button.style.borderLeftWidth = button.style.borderTopWidth.value;
                button.style.borderRightWidth = button.style.borderTopWidth.value;
            }

            RefreshResponsiveControls();
            EnsureMenuSelection();
            ApplyMenuSelectionStyles();
            m_Minimap?.SetManager(m_Manager);
        }

        public bool TickMenuInput(DaHilgInputRouter input)
        {
            if (input == null || m_MenuEntries.Count == 0) return false;

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

        void Build()
        {
            UIDocument doc = GetComponent<UIDocument>();
            m_Root = doc.rootVisualElement;
            m_Root.Clear();
            m_Root.style.position = Position.Absolute;
            m_Root.style.left = 0;
            m_Root.style.right = 0;
            m_Root.style.top = 0;
            m_Root.style.bottom = 0;
            m_Root.style.color = Color.white;
            m_Root.pickingMode = PickingMode.Position;

            m_TopPanel = Panel();
            m_TopPanel.style.left = 18;
            m_TopPanel.style.top = 18;
            m_TopPanel.style.width = 270;
            m_Root.Add(m_TopPanel);

            m_Title = Label("Da Hilg", 20, FontStyle.Bold);
            m_TopPanel.Add(m_Title);
            VisualElement row = new VisualElement { style = { flexDirection = FlexDirection.Row, marginTop = 8 } };
            m_TopPanel.Add(row);
            m_Mode = Chip("GREET");
            m_Score = Chip("000");
            row.Add(m_Mode);
            row.Add(m_Score);
            m_State = Label("", 13, FontStyle.Normal);
            m_State.style.marginTop = 8;
            m_TopPanel.Add(m_State);

            VisualElement health = new VisualElement();
            health.style.height = 8;
            health.style.marginTop = 8;
            health.style.backgroundColor = new Color(0f, 0f, 0f, 0.45f);
            health.style.borderTopLeftRadius = 4;
            health.style.borderTopRightRadius = 4;
            health.style.borderBottomLeftRadius = 4;
            health.style.borderBottomRightRadius = 4;
            m_TopPanel.Add(health);
            m_HealthFill = new VisualElement();
            m_HealthFill.style.height = Length.Percent(100);
            m_HealthFill.style.width = Length.Percent(100);
            m_HealthFill.style.backgroundColor = new Color(0.18f, 0.91f, 0.31f, 1f);
            m_HealthFill.style.borderTopLeftRadius = 4;
            m_HealthFill.style.borderTopRightRadius = 4;
            m_HealthFill.style.borderBottomLeftRadius = 4;
            m_HealthFill.style.borderBottomRightRadius = 4;
            health.Add(m_HealthFill);

            m_Attached = Label("", 12, FontStyle.Normal);
            m_Attached.style.marginTop = 8;
            m_TopPanel.Add(m_Attached);

            m_Prompt = Label("", 13, FontStyle.Bold);
            m_Prompt.style.position = Position.Absolute;
            m_Prompt.style.left = Length.Percent(50);
            m_Prompt.style.bottom = 126;
            m_Prompt.style.translate = new Translate(Length.Percent(-50), 0);
            m_Prompt.style.paddingLeft = 14;
            m_Prompt.style.paddingRight = 14;
            m_Prompt.style.paddingTop = 8;
            m_Prompt.style.paddingBottom = 8;
            m_Prompt.style.backgroundColor = new Color(0.03f, 0.04f, 0.06f, 0.72f);
            m_Prompt.style.borderTopLeftRadius = 8;
            m_Prompt.style.borderTopRightRadius = 8;
            m_Prompt.style.borderBottomLeftRadius = 8;
            m_Prompt.style.borderBottomRightRadius = 8;
            m_Root.Add(m_Prompt);

            VisualElement cross = new VisualElement();
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
            cross.style.borderTopLeftRadius = 4;
            cross.style.borderTopRightRadius = 4;
            cross.style.borderBottomLeftRadius = 4;
            cross.style.borderBottomRightRadius = 4;
            m_Root.Add(cross);

            BuildCharacterBar();
            BuildMinimap();
            BuildTouchControls();
            BuildEmoteBar();
            BuildCameraBar();
            BuildLevelBar();
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
            m_CharacterBar.style.backgroundColor = new Color(0.03f, 0.04f, 0.06f, 0.62f);
            m_CharacterBar.style.paddingLeft = 6;
            m_CharacterBar.style.paddingRight = 6;
            m_CharacterBar.style.paddingTop = 6;
            m_CharacterBar.style.paddingBottom = 6;
            m_CharacterBar.style.borderTopLeftRadius = 8;
            m_CharacterBar.style.borderTopRightRadius = 8;
            m_CharacterBar.style.borderBottomLeftRadius = 8;
            m_CharacterBar.style.borderBottomRightRadius = 8;
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
                button.style.borderTopLeftRadius = 6;
                button.style.borderTopRightRadius = 6;
                button.style.borderBottomLeftRadius = 6;
                button.style.borderBottomRightRadius = 6;
                m_CharacterBar.Add(button);
                m_CharacterButtons.Add(button);
                RegisterMenuButton(button, 0, i, activate);
            }
        }

        void BuildTouchControls()
        {
            VisualElement lookPad = new VisualElement();
            lookPad.style.position = Position.Absolute;
            lookPad.style.left = 0;
            lookPad.style.right = 0;
            lookPad.style.top = 0;
            lookPad.style.bottom = 0;
            lookPad.pickingMode = PickingMode.Position;
            lookPad.RegisterCallback<PointerDownEvent>(e =>
            {
                if (m_LookPointer >= 0) return;
                m_LookPointer = e.pointerId;
                m_LookLast = e.position;
                lookPad.CapturePointer(e.pointerId);
            });
            lookPad.RegisterCallback<PointerMoveEvent>(e =>
            {
                if (m_LookPointer != e.pointerId) return;
                Vector2 p = e.position;
                m_Input.AddTouchLook(p - m_LookLast);
                m_LookLast = p;
            });
            lookPad.RegisterCallback<PointerUpEvent>(e =>
            {
                if (m_LookPointer != e.pointerId) return;
                m_LookPointer = -1;
                lookPad.ReleasePointer(e.pointerId);
            });
            lookPad.RegisterCallback<PointerCancelEvent>(e =>
            {
                if (m_LookPointer != e.pointerId) return;
                m_LookPointer = -1;
            });
            m_Root.Add(lookPad);
            lookPad.SendToBack();

            m_Joy = new VisualElement();
            m_Joy.style.position = Position.Absolute;
            m_Joy.style.left = 32;
            m_Joy.style.bottom = 34;
            m_Joy.style.width = 118;
            m_Joy.style.height = 118;
            m_Joy.style.backgroundColor = new Color(0f, 0f, 0f, 0.24f);
            m_Joy.style.borderTopLeftRadius = 59;
            m_Joy.style.borderTopRightRadius = 59;
            m_Joy.style.borderBottomLeftRadius = 59;
            m_Joy.style.borderBottomRightRadius = 59;
            m_Root.Add(m_Joy);

            m_Knob = new VisualElement();
            m_Knob.style.position = Position.Absolute;
            m_Knob.style.left = 39;
            m_Knob.style.top = 39;
            m_Knob.style.width = 40;
            m_Knob.style.height = 40;
            m_Knob.style.backgroundColor = new Color(1f, 1f, 1f, 0.75f);
            m_Knob.style.borderTopLeftRadius = 20;
            m_Knob.style.borderTopRightRadius = 20;
            m_Knob.style.borderBottomLeftRadius = 20;
            m_Knob.style.borderBottomRightRadius = 20;
            m_Joy.Add(m_Knob);

            m_Joy.RegisterCallback<PointerDownEvent>(OnJoyDown);
            m_Joy.RegisterCallback<PointerMoveEvent>(OnJoyMove);
            m_Joy.RegisterCallback<PointerUpEvent>(OnJoyUp);

            Button jump = TouchButton("JUMP");
            m_JumpButton = jump;
            jump.style.right = 34;
            jump.style.bottom = 34;
            jump.RegisterCallback<PointerDownEvent>(_ => m_Input.QueueTouchJump());
            jump.clicked += () => m_Input.QueueTouchJump();
            m_Root.Add(jump);

            Button run = TouchButton("RUN");
            m_RunButton = run;
            run.style.right = 34;
            run.style.bottom = 98;
            run.RegisterCallback<PointerDownEvent>(_ => m_Input.SetTouchRun(true));
            run.RegisterCallback<PointerUpEvent>(_ => m_Input.SetTouchRun(false));
            run.RegisterCallback<PointerCancelEvent>(_ => m_Input.SetTouchRun(false));
            run.RegisterCallback<PointerLeaveEvent>(_ => m_Input.SetTouchRun(false));
            m_Root.Add(run);

            RefreshResponsiveControls();
        }

        void RefreshResponsiveControls()
        {
            bool touch = ShouldShowTouchControls();
            bool landscape = touch && Screen.width > Screen.height;
            DisplayStyle display = touch ? DisplayStyle.Flex : DisplayStyle.None;
            if (m_Joy != null) m_Joy.style.display = display;
            if (m_RunButton != null) m_RunButton.style.display = display;
            if (m_JumpButton != null) m_JumpButton.style.display = display;

            if (landscape)
            {
                SetPanelFrame(m_TopPanel, 12, StyleKeyword.Auto, 12, StyleKeyword.Auto, 224, StyleKeyword.Auto);
                SetPanelFrame(m_Minimap, StyleKeyword.Auto, 12, 12, StyleKeyword.Auto, 190, 132);
                SetBarFrame(m_CharacterBar, StyleKeyword.Auto, 12, 152, StyleKeyword.Auto, new Translate(0, 0));
                SetBarFrame(m_EmoteBar, StyleKeyword.Auto, 12, 198, StyleKeyword.Auto, new Translate(0, 0));
                SetBarFrame(m_CameraBar, StyleKeyword.Auto, 12, 244, StyleKeyword.Auto, new Translate(0, 0));
                SetBarFrame(m_LevelBar, StyleKeyword.Auto, 12, 290, StyleKeyword.Auto, new Translate(0, 0));
                SetPromptFrame(Length.Percent(50), StyleKeyword.Auto, 14, StyleKeyword.Auto, new Translate(Length.Percent(-50), 0), 300, 12);

                if (m_Joy != null)
                {
                    m_Joy.style.left = 24;
                    m_Joy.style.bottom = 132;
                }
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
            }
            else if (touch)
            {
                SetPanelFrame(m_TopPanel, 18, StyleKeyword.Auto, 18, StyleKeyword.Auto, 252, StyleKeyword.Auto);
                SetPanelFrame(m_Minimap, StyleKeyword.Auto, 18, 154, StyleKeyword.Auto, 150, 136);
                SetBarFrame(m_CharacterBar, Length.Percent(50), StyleKeyword.Auto, StyleKeyword.Auto, 24, new Translate(Length.Percent(-50), 0));
                SetBarFrame(m_EmoteBar, Length.Percent(50), StyleKeyword.Auto, StyleKeyword.Auto, 72, new Translate(Length.Percent(-50), 0));
                SetBarFrame(m_CameraBar, Length.Percent(50), StyleKeyword.Auto, StyleKeyword.Auto, 118, new Translate(Length.Percent(-50), 0));
                SetBarFrame(m_LevelBar, Length.Percent(50), StyleKeyword.Auto, StyleKeyword.Auto, 166, new Translate(Length.Percent(-50), 0));
                SetPromptFrame(Length.Percent(50), StyleKeyword.Auto, StyleKeyword.Auto, 258, new Translate(Length.Percent(-50), 0), 340, 13);

                if (m_Joy != null)
                {
                    m_Joy.style.left = 32;
                    m_Joy.style.bottom = 34;
                }
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
            }
            else
            {
                SetPanelFrame(m_TopPanel, 18, StyleKeyword.Auto, 18, StyleKeyword.Auto, 270, StyleKeyword.Auto);
                SetPanelFrame(m_Minimap, StyleKeyword.Auto, 18, 18, StyleKeyword.Auto, 220, 168);
                SetBarFrame(m_CharacterBar, Length.Percent(50), StyleKeyword.Auto, StyleKeyword.Auto, 24, new Translate(Length.Percent(-50), 0));
                SetBarFrame(m_EmoteBar, Length.Percent(50), StyleKeyword.Auto, StyleKeyword.Auto, 72, new Translate(Length.Percent(-50), 0));
                SetBarFrame(m_CameraBar, Length.Percent(50), StyleKeyword.Auto, StyleKeyword.Auto, 116, new Translate(Length.Percent(-50), 0));
                SetBarFrame(m_LevelBar, Length.Percent(50), StyleKeyword.Auto, 18, StyleKeyword.Auto, new Translate(Length.Percent(-50), 0));
                SetPromptFrame(Length.Percent(50), StyleKeyword.Auto, StyleKeyword.Auto, 164, new Translate(Length.Percent(-50), 0), 680, 13);
            }
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
            return Application.isMobilePlatform || Mathf.Min(Screen.width, Screen.height) < 720;
        }

        void BuildEmoteBar()
        {
            m_EmoteBar = new VisualElement();
            m_EmoteBar.style.position = Position.Absolute;
            m_EmoteBar.style.left = Length.Percent(50);
            m_EmoteBar.style.bottom = 72;
            m_EmoteBar.style.translate = new Translate(Length.Percent(-50), 0);
            m_EmoteBar.style.flexDirection = FlexDirection.Row;
            m_EmoteBar.style.backgroundColor = new Color(0.03f, 0.04f, 0.06f, 0.5f);
            m_EmoteBar.style.paddingLeft = 5;
            m_EmoteBar.style.paddingRight = 5;
            m_EmoteBar.style.paddingTop = 5;
            m_EmoteBar.style.paddingBottom = 5;
            m_EmoteBar.style.borderTopLeftRadius = 8;
            m_EmoteBar.style.borderTopRightRadius = 8;
            m_EmoteBar.style.borderBottomLeftRadius = 8;
            m_EmoteBar.style.borderBottomRightRadius = 8;

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
                button.style.backgroundColor = new Color(1f, 1f, 1f, 0.12f);
                button.style.color = Color.white;
                button.style.borderTopLeftRadius = 6;
                button.style.borderTopRightRadius = 6;
                button.style.borderBottomLeftRadius = 6;
                button.style.borderBottomRightRadius = 6;
                m_EmoteBar.Add(button);
                m_EmoteButtons.Add(button);
                RegisterMenuButton(button, 1, i, activate);
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
            m_CameraBar.style.backgroundColor = new Color(0.03f, 0.04f, 0.06f, 0.55f);
            m_CameraBar.style.paddingLeft = 5;
            m_CameraBar.style.paddingRight = 5;
            m_CameraBar.style.paddingTop = 5;
            m_CameraBar.style.paddingBottom = 5;
            m_CameraBar.style.borderTopLeftRadius = 8;
            m_CameraBar.style.borderTopRightRadius = 8;
            m_CameraBar.style.borderBottomLeftRadius = 8;
            m_CameraBar.style.borderBottomRightRadius = 8;

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
            m_LevelBar.style.backgroundColor = new Color(0.03f, 0.04f, 0.06f, 0.55f);
            m_LevelBar.style.paddingLeft = 5;
            m_LevelBar.style.paddingRight = 5;
            m_LevelBar.style.paddingTop = 5;
            m_LevelBar.style.paddingBottom = 5;
            m_LevelBar.style.borderTopLeftRadius = 8;
            m_LevelBar.style.borderTopRightRadius = 8;
            m_LevelBar.style.borderBottomLeftRadius = 8;
            m_LevelBar.style.borderBottomRightRadius = 8;

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
            button.style.backgroundColor = new Color(1f, 1f, 1f, 0.12f);
            button.style.color = Color.white;
            button.style.borderTopWidth = 1;
            button.style.borderBottomWidth = 1;
            button.style.borderLeftWidth = 1;
            button.style.borderRightWidth = 1;
            button.style.borderTopLeftRadius = 6;
            button.style.borderTopRightRadius = 6;
            button.style.borderBottomLeftRadius = 6;
            button.style.borderBottomRightRadius = 6;
            m_CameraBar.Add(button);
            m_CameraButtons.Add(button);
            RegisterMenuButton(button, 2, column, activate);
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
            button.style.backgroundColor = new Color(1f, 1f, 1f, 0.12f);
            button.style.color = Color.white;
            button.style.borderTopWidth = 1;
            button.style.borderBottomWidth = 1;
            button.style.borderLeftWidth = 1;
            button.style.borderRightWidth = 1;
            button.style.borderTopLeftRadius = 6;
            button.style.borderTopRightRadius = 6;
            button.style.borderBottomLeftRadius = 6;
            button.style.borderBottomRightRadius = 6;
            m_LevelBar.Add(button);
            m_LevelButtons.Add(button);
            RegisterMenuButton(button, 3, column, activate);
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
            entry.Activate?.Invoke();
            ApplyMenuSelectionStyles();
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

                Color border = selected
                    ? new Color(1f, 0.78f, 0.22f, 1f)
                    : (activeCharacter || activeCamera || activeLevel ? Color.white : new Color(1f, 1f, 1f, 0.24f));
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
            m_JoyPointer = e.pointerId;
            Rect r = m_Joy.worldBound;
            m_JoyCenter = new Vector2(r.x + r.width * 0.5f, r.y + r.height * 0.5f);
            m_Joy.CapturePointer(e.pointerId);
            UpdateJoy(e.position);
        }

        void OnJoyMove(PointerMoveEvent e)
        {
            if (m_JoyPointer != e.pointerId) return;
            UpdateJoy(e.position);
        }

        void OnJoyUp(PointerUpEvent e)
        {
            if (m_JoyPointer != e.pointerId) return;
            m_JoyPointer = -1;
            m_Input.SetTouchMove(Vector2.zero, false);
            m_Knob.style.left = 39;
            m_Knob.style.top = 39;
            m_Joy.ReleasePointer(e.pointerId);
        }

        void UpdateJoy(Vector2 pointer)
        {
            Vector2 v = pointer - m_JoyCenter;
            v.y = -v.y;
            Vector2 n = Vector2.ClampMagnitude(v / 48f, 1f);
            m_Input.SetTouchMove(n, true);
            m_Knob.style.left = 39 + n.x * 38f;
            m_Knob.style.top = 39 - n.y * 38f;
        }

        static VisualElement Panel()
        {
            VisualElement panel = new VisualElement();
            panel.style.position = Position.Absolute;
            panel.style.paddingLeft = 14;
            panel.style.paddingRight = 14;
            panel.style.paddingTop = 12;
            panel.style.paddingBottom = 12;
            panel.style.backgroundColor = new Color(0.03f, 0.04f, 0.06f, 0.68f);
            panel.style.borderTopLeftRadius = 8;
            panel.style.borderTopRightRadius = 8;
            panel.style.borderBottomLeftRadius = 8;
            panel.style.borderBottomRightRadius = 8;
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

        static Label Chip(string text)
        {
            Label label = Label(text, 12, FontStyle.Bold);
            label.style.marginRight = 8;
            label.style.paddingLeft = 8;
            label.style.paddingRight = 8;
            label.style.paddingTop = 4;
            label.style.paddingBottom = 4;
            label.style.backgroundColor = new Color(1f, 1f, 1f, 0.12f);
            label.style.borderTopLeftRadius = 6;
            label.style.borderTopRightRadius = 6;
            label.style.borderBottomLeftRadius = 6;
            label.style.borderBottomRightRadius = 6;
            return label;
        }

        static Button TouchButton(string text)
        {
            Button button = new Button { text = text };
            button.style.position = Position.Absolute;
            button.style.width = 58;
            button.style.height = 48;
            button.style.backgroundColor = new Color(0.18f, 0.55f, 1f, 0.82f);
            button.style.color = Color.white;
            button.style.unityFontStyleAndWeight = FontStyle.Bold;
            button.style.borderTopLeftRadius = 8;
            button.style.borderTopRightRadius = 8;
            button.style.borderBottomLeftRadius = 8;
            button.style.borderBottomRightRadius = 8;
            return button;
        }
    }
}
