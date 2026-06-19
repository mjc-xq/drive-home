import { useEngine } from '../lib/engine-context.jsx';

// The root landing view (`/`): a simple menu that links to the two mini-games.
// Tapping a card just navigates — the shared engine (already booting/idling
// behind this overlay) enters the matching mode once you land on /drive or
// /scoop. Deliberately thin: this page is a menu, nothing more.
export default function MenuPage() {
  const { navigate, poi } = useEngine();
  return (
    <div id="startMenu">
      <div className="menuSheet startSheet">
        <div className="menuHead">
          <div>
            <div className="menuKick">Welcome back</div>
            <h1 className="menuTitle">Neighborhood<br />Drive</h1>
          </div>
          {poi.found > 0 && (
            <div className="placesBadge">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--go)" strokeWidth="2.2" strokeLinecap="round"><path d="M12 21s-7-5.2-7-11a7 7 0 0 1 14 0c0 5.8-7 11-7 11z" /><circle cx="12" cy="10" r="2.2" /></svg>
              <span className="pbNum">{poi.found}<i>/{poi.total}</i></span><span className="pbLbl">places found</span>
            </div>
          )}
        </div>
        <div className="modeCards">
          <button className="modeCard drive" onClick={() => navigate('drive')}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--go)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 11l1-5h12l1 5" /><rect x="3" y="11" width="18" height="6" /><circle cx="7.5" cy="17.5" r="1.4" /><circle cx="16.5" cy="17.5" r="1.4" /></svg>
            <span className="mcTitle">Drive</span><span className="mcSub">Arcade controls</span>
          </button>
          <button className="modeCard" onClick={() => navigate('scoop')}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12a7 7 0 0 1 14 0v5H5z" /><path d="M9 17v3M15 17v3" /></svg>
            <span className="mcTitle">Scoop</span><span className="mcSub">Collect &amp; deliver</span>
          </button>
          {/* Da Hilg is a fully separate R3F game; navigate hard (not the SPA
              router) so main.jsx's root-switch mounts it and the old engine
              tears down. */}
          <button className="modeCard" onClick={() => window.location.assign('/da-hilg')}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 2 8 2 16 12 22 22 16 22 8 12 2" /><path d="M12 22V12M2 8l10 4 10-4" /></svg>
            <span className="mcTitle">Da Hilg</span><span className="mcSub">First-person · explore</span>
          </button>
        </div>
      </div>
    </div>
  );
}
