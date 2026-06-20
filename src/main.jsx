import { createRoot } from 'react-dom/client';
import './register-sw.js';
import './styles.css';

// Root-switch. The /da-hilg game is a fully isolated R3F app: when the URL is in
// its subtree we mount ONLY <DaHilgApp/> and never construct the old shared 3D
// engine (EngineProvider/App), so there's exactly one WebGL context alive.
// Crossing the /da-hilg boundary is a normal full-page navigation (see MenuPage),
// which unmounts the other root and disposes its engine before this one mounts.
// Both roots are lazy so neither bundle (old engine vs R3F) ships to the other.
//
// No StrictMode: each world builds in its mount effect and must not double-construct.
const root = createRoot(document.getElementById('root'));
// A failed dynamic import (chunk fails to load on a flaky connection, or throws while
// evaluating on an old browser) would otherwise reject silently and leave a blank page.
// Re-throw so the index.html recovery surface ("Clear cache & reload") can show.
const onChunkError = (err) => {
  console.error('App failed to load:', err);
  setTimeout(() => {
    throw err;
  }, 0);
};
if (window.location.pathname.startsWith('/da-hilg')) {
  import('./da-hilg/index.js')
    .then(({ default: DaHilgApp }) => {
      root.render(<DaHilgApp />);
    })
    .catch(onChunkError);
} else {
  import('./App.jsx')
    .then(({ default: App }) => {
      root.render(<App />);
    })
    .catch(onChunkError);
}
