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
        int m_TouchEmoteQueued = -1;

        public Vector2 Move { get; private set; }
        public Vector2 LookDelta { get; private set; }
        public bool RunHeld { get; private set; }
        public bool JumpPressed { get; private set; }
        public bool InteractPressed { get; private set; }
        public bool SwitchPressed { get; private set; }
        public bool PreviousSwitchPressed { get; private set; }
        public bool CameraPressed { get; private set; }
        public bool PausePressed { get; private set; }
        public bool ToggleModePressed { get; private set; }
        public int EmotePressed { get; private set; } = -1;

        public void Tick(DaHilgGameSettings settings)
        {
            JumpPressed = false;
            InteractPressed = false;
            SwitchPressed = false;
            PreviousSwitchPressed = false;
            CameraPressed = false;
            PausePressed = false;
            ToggleModePressed = false;
            EmotePressed = -1;
            LookDelta = Vector2.zero;
            RunHeld = false;

            Vector2 keyboardMove = Vector2.zero;
            Keyboard keyboard = Keyboard.current;
            if (keyboard != null)
            {
                keyboardMove.x = (keyboard.dKey.isPressed || keyboard.rightArrowKey.isPressed ? 1f : 0f)
                    - (keyboard.aKey.isPressed || keyboard.leftArrowKey.isPressed ? 1f : 0f);
                keyboardMove.y = (keyboard.wKey.isPressed || keyboard.upArrowKey.isPressed ? 1f : 0f)
                    - (keyboard.sKey.isPressed || keyboard.downArrowKey.isPressed ? 1f : 0f);

                RunHeld = keyboard.leftShiftKey.isPressed || keyboard.rightShiftKey.isPressed;
                JumpPressed = keyboard.spaceKey.wasPressedThisFrame;
                InteractPressed = keyboard.eKey.wasPressedThisFrame;
                SwitchPressed = keyboard.tabKey.wasPressedThisFrame;
                PreviousSwitchPressed = keyboard.backquoteKey.wasPressedThisFrame;
                CameraPressed = keyboard.vKey.wasPressedThisFrame;
                PausePressed = keyboard.escapeKey.wasPressedThisFrame;
                ToggleModePressed = keyboard.nKey.wasPressedThisFrame;

                if (keyboard.digit1Key.wasPressedThisFrame) EmotePressed = 0;
                else if (keyboard.digit2Key.wasPressedThisFrame) EmotePressed = 1;
                else if (keyboard.digit3Key.wasPressedThisFrame) EmotePressed = 2;
                else if (keyboard.digit4Key.wasPressedThisFrame) EmotePressed = 3;
            }

            Mouse mouse = Mouse.current;
            if (mouse != null)
            {
                if (mouse.leftButton.wasPressedThisFrame && Cursor.lockState != CursorLockMode.Locked)
                {
                    Cursor.lockState = CursorLockMode.Locked;
                    Cursor.visible = false;
                }

                if (Cursor.lockState == CursorLockMode.Locked || mouse.rightButton.isPressed || mouse.leftButton.isPressed)
                {
                    LookDelta += mouse.delta.ReadValue() * settings.CameraSensitivity;
                }
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

        public void QueueTouchEmote(int index)
        {
            m_TouchEmoteQueued = Mathf.Clamp(index, 0, 3);
        }
    }
}
