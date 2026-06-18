import { EngineProvider, useEngine } from './lib/engine-context.jsx';
import MenuPage from './pages/MenuPage.jsx';
import DrivePage from './pages/DrivePage.jsx';
import ScoopPage from './pages/ScoopPage.jsx';

// The app shell is deliberately tiny: it boots the ONE shared engine
// (EngineProvider) and owns the only persistent DOM the engine needs — the
// loading veil and the WebGL <canvas>. Everything else is the active route's
// page, each of which owns its own HUD chrome and game state so /drive and
// /scoop can grow independently. See src/lib/engine-context.jsx for the
// route↔mode wiring.
export default function App() {
  return (
    <EngineProvider>
      <Shell />
    </EngineProvider>
  );
}

function Shell() {
  const { canvasRef, route, engineError, booted, starting } = useEngine();
  return (
    <div id="appShell">
      <div id="loading" className={engineError ? 'error' : (booted && !starting) ? 'done' : ''}>
        <div className="loadInner">
          <div className="loadKick">Welcome home</div>
          <div className="loadTitle">Neighborhood<br />Drive</div>
          {!engineError && <div className="loadBar"><i /></div>}
          <div className="loadSub">{engineError || (starting ? 'Starting…' : 'Building the neighborhood…')}</div>
        </div>
      </div>
      <canvas
        id="scene" ref={canvasRef} tabIndex={0}
        aria-label="Interactive 3D model of a drivable neighborhood"
      />
      {route === 'menu' && <MenuPage />}
      {route === 'drive' && <DrivePage />}
      {route === 'scoop' && <ScoopPage />}
    </div>
  );
}
