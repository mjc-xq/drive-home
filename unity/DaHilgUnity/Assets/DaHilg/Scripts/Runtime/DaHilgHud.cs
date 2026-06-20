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
        VisualElement m_CharacterBar;
        VisualElement m_Joy;
        VisualElement m_Knob;
        int m_JoyPointer = -1;
        int m_LookPointer = -1;
        Vector2 m_JoyCenter;
        Vector2 m_LookLast;
        readonly List<Button> m_CharacterButtons = new List<Button>(4);

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
            else if (m_Manager.Mode == DaHilgGameMode.Nibblers && actor.AttachedNibblers >= m_Manager.Settings.OverwhelmStop) m_Prompt.text = "Pinned · jump to shake loose";
            else if (m_Manager.Mode == DaHilgGameMode.Nibblers && actor.AttachedNibblers >= m_Manager.Settings.OverwhelmDown) m_Prompt.text = "Downed · crawl and jump";
            else m_Prompt.text = "WASD move · mouse look · Space jump · Tab switch · V camera · N mode";

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
            }
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

            VisualElement top = Panel();
            top.style.left = 18;
            top.style.top = 18;
            top.style.width = 270;
            m_Root.Add(top);

            m_Title = Label("Da Hilg", 20, FontStyle.Bold);
            top.Add(m_Title);
            VisualElement row = new VisualElement { style = { flexDirection = FlexDirection.Row, marginTop = 8 } };
            top.Add(row);
            m_Mode = Chip("GREET");
            m_Score = Chip("000");
            row.Add(m_Mode);
            row.Add(m_Score);
            m_State = Label("", 13, FontStyle.Normal);
            m_State.style.marginTop = 8;
            top.Add(m_State);

            VisualElement health = new VisualElement();
            health.style.height = 8;
            health.style.marginTop = 8;
            health.style.backgroundColor = new Color(0f, 0f, 0f, 0.45f);
            health.style.borderTopLeftRadius = 4;
            health.style.borderTopRightRadius = 4;
            health.style.borderBottomLeftRadius = 4;
            health.style.borderBottomRightRadius = 4;
            top.Add(health);
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
            top.Add(m_Attached);

            m_Prompt = Label("", 13, FontStyle.Bold);
            m_Prompt.style.position = Position.Absolute;
            m_Prompt.style.left = Length.Percent(50);
            m_Prompt.style.bottom = 96;
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
            BuildTouchControls();
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
            for (int i = 0; i < m_Manager.Settings.Characters.Length; i++)
            {
                DaHilgCharacterSlot slot = m_Manager.Settings.Characters[i];
                Button button = new Button(() => m_Manager.SwitchTo(slot.Id)) { text = slot.Label };
                button.userData = slot.Id;
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
            }
        }

        void BuildTouchControls()
        {
            VisualElement lookPad = new VisualElement();
            lookPad.style.position = Position.Absolute;
            lookPad.style.right = 0;
            lookPad.style.top = 0;
            lookPad.style.bottom = 0;
            lookPad.style.width = Length.Percent(52);
            lookPad.pickingMode = PickingMode.Position;
            lookPad.RegisterCallback<PointerDownEvent>(e =>
            {
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
            m_Root.Add(lookPad);

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
            jump.style.right = 34;
            jump.style.bottom = 34;
            jump.clicked += () => m_Input.QueueTouchJump();
            m_Root.Add(jump);

            Button run = TouchButton("RUN");
            run.style.right = 34;
            run.style.bottom = 98;
            run.RegisterCallback<PointerDownEvent>(_ => m_Input.SetTouchRun(true));
            run.RegisterCallback<PointerUpEvent>(_ => m_Input.SetTouchRun(false));
            m_Root.Add(run);
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
