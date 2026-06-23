using UnityEngine;
using UnityEngine.UIElements;

namespace DaHilg
{
    // ── SINGLE SOURCE OF TRUTH for the Da Hilg HUD look ──────────────────────────
    // Mirrors the driving / scoop game's HUD theme (src/styles.css `.driveHud`,
    // `.segBar`, `.actionBtn`, `.charSwitch`, `.menuItem`, `.chip`). Every HUD
    // element routes its colors, corner radius, padding, font size and touch-target
    // height through these constants so the look can never drift back into the old
    // mix of "kiddy" pastel buttons.
    //
    // Drive-game tokens (hex → Unity 0..1 RGBA), straight from styles.css :root.
    // The drive theme uses *rounded* glass chrome (10–14px radii), neutral fills for
    // controls, and reserves the bright accent colors for ACTIVE / important states
    // only — not for the resting fill of every button. That is the whole difference
    // between "childish" buttons and the clean driving-game HUD.
    static class DaHilgHudTheme
    {
        // Accent palette (--nav/--go/--coin/--reverse/--jump/--fire).
        public static readonly Color Nav = new Color(0.176f, 0.549f, 1f, 1f);      // #2D8CFF
        public static readonly Color Go = new Color(0.169f, 0.910f, 0.310f, 1f);   // #2BE84F
        public static readonly Color Coin = new Color(1f, 0.784f, 0.239f, 1f);     // #FFC83D
        public static readonly Color Reverse = new Color(1f, 0.322f, 0.278f, 1f);  // #FF5247
        public static readonly Color Jump = new Color(0.608f, 0.482f, 1f, 1f);     // #9B7BFF

        // Glass / panel surfaces (--hud-glass / --hud-line + deeper popovers).
        public static readonly Color Glass = new Color(0.031f, 0.039f, 0.055f, 0.66f);     // --hud-glass
        public static readonly Color GlassDeep = new Color(0.039f, 0.047f, 0.063f, 0.82f); // segMenuPanel-ish
        public static readonly Color PanelDeep = new Color(0.039f, 0.047f, 0.063f, 0.95f); // modal sheet
        public static readonly Color Line = new Color(1f, 1f, 1f, 0.18f);                  // --hud-line

        // ── Airy strip surfaces ──────────────────────────────────────────────────
        // UIToolkit can't backdrop-blur, so the OLD heavy opaque card read as a dark
        // slab. The drive HUD's .scoreStrip / .dashCluster are THIN translucent strips:
        // we fake the frosted lightness with a LIGHTER glass + a faint top sheen and a
        // hairline cell divider, exactly like .ssDiv / .dashDiv (rgba(255,255,255,.14)).
        public static readonly Color StripGlass = new Color(0.039f, 0.047f, 0.063f, 0.52f); // lighter than --hud-glass
        public static readonly Color StripSheen = new Color(1f, 1f, 1f, 0.05f);             // faux top-down gradient cap
        public static readonly Color CellDivider = new Color(1f, 1f, 1f, 0.14f);            // .ssDiv / .dashDiv / .segDiv
        public static readonly Color TrackBg = new Color(1f, 1f, 1f, 0.16f);                // .dashBar / .boostBar track

        // Text ramp (--txt + opacity steps used across the drive HUD).
        public static readonly Color Text = new Color(0.957f, 0.945f, 0.917f, 1f);  // --txt
        public static readonly Color TextDim = new Color(1f, 1f, 1f, 0.5f);         // kicker labels
        public static readonly Color TextFaint = new Color(1f, 1f, 1f, 0.62f);

        // Control fills. Resting controls are *neutral* translucent white, exactly like
        // `.actionBtn`/`.menuItem`/`.segBtn` — colour only appears on the active outline.
        public static readonly Color Fill = new Color(1f, 1f, 1f, 0.06f);     // .actionBtn rgba(255,255,255,.06)
        public static readonly Color FillHi = new Color(1f, 1f, 1f, 0.12f);   // :hover
        public static readonly Color FillActive = new Color(1f, 1f, 1f, 0.16f);

        // ── Shape / sizing tokens (the drive HUD uses rounded glass, not square) ──
        public const float Radius = 10f;        // .actionBtn / .menuItem corner
        public const float RadiusLg = 14f;       // .chip / panels / modal sheet
        public const float RadiusPill = 999f;    // joystick + circular discs only

        public const float TouchTarget = 44f;    // min-height for every tappable control
        public const float TouchTargetLg = 56f;   // big primary action discs

        public const int FontLabel = 13;        // button / value text
        public const int FontKicker = 9;         // tiny ALL-CAPS kicker over a value
        public const int FontTitle = 18;
        public const float KickerTracking = 1.6f; // letter-spacing for kickers (~.16em on a 9px kicker)

        // Segmented strip cell tuning (mirrors .ssCell.trip / .dashCol).
        public const int FontCellValue = 17;     // bold AGC value sitting under a kicker (.tripNum ≈ 18px)
        public const float StripRadius = 12f;     // thin strip corner — between .actionBtn(10) and .chip(14)

        // ── Top-right action chips (drive .actionBtn icon row) ───────────────────
        // Small rounded glass chips in a tight row: a glyph over a tiny ALL-CAPS label.
        // Sized for a ≥44px tap target even at the compact desktop/portrait scale.
        public const float ChipSize = 50f;        // chip height (also ~min width) — ≥44px tap target
        public const float ChipSizeTouch = 48f;    // slightly tighter on touch layouts
        public const float ChipGap = 6f;           // gap between chips in the row
        public const int FontChipGlyph = 18;      // the unicode glyph line
        public const int FontChipLabel = 8;        // the tiny ALL-CAPS label under the glyph
    }
}
