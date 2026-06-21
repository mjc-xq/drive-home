using UnityEngine;
using UnityEngine.InputSystem;

namespace DaHilg
{
    public sealed class DaHilgInputRouter : MonoBehaviour
    {
        Vector2 m_TouchMove;
        Vector2 m_TouchLook;
        bool m_TouchMoveActive;
        bool m_TouchRun;
        bool m_TouchJumpQueued;
        bool m_TouchRollQueued;
        bool m_TouchAttackQueued;
        int m_TouchEmoteQueued = -1;

        public Vector2 Move { get; private set; }
        public Vector2 LookDelta { get; private set; }
        public bool RunHeld { get; private set; }
        public bool JumpPressed { get; private set; }
        public bool RollPressed { get; private set; }
        public bool AttackPressed { get; private set; }
        public bool InteractPressed { get; private set; }
        public bool SwitchPressed { get; private set; }
        public bool PreviousSwitchPressed { get; private set; }
        public bool CameraPressed { get; private set; }
        public bool PausePressed { get; private set; }
        public bool ToggleModePressed { get; private set; }
        public bool MenuLeftPressed { get; private set; }
        public bool MenuRightPressed { get; private set; }
        public bool MenuUpPressed { get; private set; }
        public bool MenuDownPressed { get; private set; }
        public bool MenuActivatePressed { get; private set; }
        public bool MenuCancelPressed { get; private set; }
        public int EmotePressed { get; private set; } = -1;

        public void Tick(DaHilgGameSettings settings)
        {
            JumpPressed = false;
            RollPressed = false;
            AttackPressed = false;
            InteractPressed = false;
            SwitchPressed = false;
            PreviousSwitchPressed = false;
            CameraPressed = false;
            PausePressed = false;
            ToggleModePressed = false;
            MenuLeftPressed = false;
            MenuRightPressed = false;
            MenuUpPressed = false;
            MenuDownPressed = false;
            MenuActivatePressed = false;
            MenuCancelPressed = false;
            EmotePressed = -1;
            LookDelta = Vector2.zero;
            RunHeld = false;

            Vector2 keyboardMove = Vector2.zero;
            Keyboard keyboard = Keyboard.current;
            if (keyboard != null)
            {
                keyboardMove.x = (keyboard.dKey.isPressed ? 1f : 0f) - (keyboard.aKey.isPressed ? 1f : 0f);
                keyboardMove.y = (keyboard.wKey.isPressed ? 1f : 0f) - (keyboard.sKey.isPressed ? 1f : 0f);

                RunHeld = keyboard.leftShiftKey.isPressed || keyboard.rightShiftKey.isPressed;
                JumpPressed = keyboard.spaceKey.wasPressedThisFrame;
                RollPressed = keyboard.fKey.wasPressedThisFrame || keyboard.rKey.wasPressedThisFrame;
                AttackPressed = keyboard.qKey.wasPressedThisFrame;
                InteractPressed = keyboard.eKey.wasPressedThisFrame;
                SwitchPressed = keyboard.tabKey.wasPressedThisFrame;
                PreviousSwitchPressed = keyboard.backquoteKey.wasPressedThisFrame;
                CameraPressed = keyboard.vKey.wasPressedThisFrame || keyboard.cKey.wasPressedThisFrame;
                PausePressed = keyboard.escapeKey.wasPressedThisFrame;
                ToggleModePressed = keyboard.nKey.wasPressedThisFrame;
                MenuLeftPressed = keyboard.leftArrowKey.wasPressedThisFrame;
                MenuRightPressed = keyboard.rightArrowKey.wasPressedThisFrame;
                MenuUpPressed = keyboard.upArrowKey.wasPressedThisFrame;
                MenuDownPressed = keyboard.downArrowKey.wasPressedThisFrame;
                MenuActivatePressed = keyboard.enterKey.wasPressedThisFrame || keyboard.numpadEnterKey.wasPressedThisFrame;
                MenuCancelPressed = keyboard.backspaceKey.wasPressedThisFrame;

                if (keyboard.digit1Key.wasPressedThisFrame) EmotePressed = 0;
                else if (keyboard.digit2Key.wasPressedThisFrame) EmotePressed = 1;
                else if (keyboard.digit3Key.wasPressedThisFrame) EmotePressed = 2;
                else if (keyboard.digit4Key.wasPressedThisFrame) EmotePressed = 3;
            }

            Mouse mouse = Mouse.current;
            if (mouse != null)
            {
                if (mouse.leftButton.wasPressedThisFrame) AttackPressed = true;

                if (mouse.rightButton.wasPressedThisFrame)
                {
                    Cursor.lockState = CursorLockMode.Locked;
                    Cursor.visible = false;
                }
                else if (mouse.rightButton.wasReleasedThisFrame)
                {
                    Cursor.lockState = CursorLockMode.None;
                    Cursor.visible = true;
                }

                if (mouse.rightButton.isPressed && Cursor.lockState == CursorLockMode.Locked)
                {
                    LookDelta += mouse.delta.ReadValue() * settings.CameraSensitivity;
                }
                else if (!mouse.rightButton.isPressed && Cursor.lockState != CursorLockMode.None)
                {
                    Cursor.lockState = CursorLockMode.None;
                    Cursor.visible = true;
                }
            }

            Gamepad gamepad = Gamepad.current;
            if (gamepad != null)
            {
                Vector2 stickMove = gamepad.leftStick.ReadValue();
                if (stickMove.sqrMagnitude > keyboardMove.sqrMagnitude) keyboardMove = stickMove;

                Vector2 stickLook = gamepad.rightStick.ReadValue();
                if (stickLook.sqrMagnitude > 0.0004f)
                {
                    LookDelta += stickLook * settings.CameraSensitivity * 24f;
                }

                RunHeld = RunHeld || gamepad.leftStickButton.isPressed || gamepad.leftTrigger.ReadValue() > 0.45f;
                JumpPressed = JumpPressed || gamepad.buttonSouth.wasPressedThisFrame;
                RollPressed = RollPressed || gamepad.buttonEast.wasPressedThisFrame || gamepad.rightTrigger.wasPressedThisFrame;
                AttackPressed = AttackPressed || gamepad.buttonNorth.wasPressedThisFrame;
                InteractPressed = InteractPressed || gamepad.buttonWest.wasPressedThisFrame;
                SwitchPressed = SwitchPressed || gamepad.rightShoulder.wasPressedThisFrame;
                PreviousSwitchPressed = PreviousSwitchPressed || gamepad.leftShoulder.wasPressedThisFrame;
                CameraPressed = CameraPressed || gamepad.rightStickButton.wasPressedThisFrame;
                PausePressed = PausePressed || gamepad.startButton.wasPressedThisFrame;
                ToggleModePressed = ToggleModePressed || gamepad.selectButton.wasPressedThisFrame;
                MenuLeftPressed = MenuLeftPressed || gamepad.dpad.left.wasPressedThisFrame;
                MenuRightPressed = MenuRightPressed || gamepad.dpad.right.wasPressedThisFrame;
                MenuUpPressed = MenuUpPressed || gamepad.dpad.up.wasPressedThisFrame;
                MenuDownPressed = MenuDownPressed || gamepad.dpad.down.wasPressedThisFrame;
                MenuActivatePressed = MenuActivatePressed || gamepad.buttonSouth.wasPressedThisFrame;
                MenuCancelPressed = MenuCancelPressed || gamepad.buttonEast.wasPressedThisFrame;
            }

            if (m_TouchMoveActive)
            {
                if (Mathf.Abs(m_TouchMove.x) > Mathf.Abs(keyboardMove.x)) keyboardMove.x = m_TouchMove.x;
                if (Mathf.Abs(m_TouchMove.y) > Mathf.Abs(keyboardMove.y)) keyboardMove.y = m_TouchMove.y;
            }

            if (keyboardMove.sqrMagnitude > 1f) keyboardMove.Normalize();
            Move = keyboardMove;
            RunHeld = RunHeld || m_TouchRun;

            if (m_TouchJumpQueued)
            {
                JumpPressed = true;
                m_TouchJumpQueued = false;
            }

            if (m_TouchRollQueued)
            {
                RollPressed = true;
                m_TouchRollQueued = false;
            }

            if (m_TouchAttackQueued)
            {
                AttackPressed = true;
                m_TouchAttackQueued = false;
            }

            if (m_TouchEmoteQueued >= 0)
            {
                EmotePressed = m_TouchEmoteQueued;
                m_TouchEmoteQueued = -1;
            }

            if (m_TouchLook.sqrMagnitude > 0f)
            {
                LookDelta += m_TouchLook * settings.TouchSensitivity;
                m_TouchLook = Vector2.zero;
            }
        }

        public void SetTouchMove(Vector2 move, bool active)
        {
            m_TouchMove = Vector2.ClampMagnitude(move, 1f);
            m_TouchMoveActive = active;
        }

        public void AddTouchLook(Vector2 delta)
        {
            m_TouchLook += delta;
        }

        public void SetTouchRun(bool run)
        {
            m_TouchRun = run;
        }

        public void QueueTouchJump()
        {
            m_TouchJumpQueued = true;
        }

        public void QueueTouchRoll()
        {
            m_TouchRollQueued = true;
        }

        public void QueueTouchAttack()
        {
            m_TouchAttackQueued = true;
        }

        public void QueueTouchEmote(int index)
        {
            m_TouchEmoteQueued = Mathf.Clamp(index, 0, 3);
        }
    }
}
