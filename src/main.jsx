import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './register-sw.js';
import './styles.css';

// No StrictMode: the engine builds the entire WebGL world in its mount effect
// and must not be constructed twice.
createRoot(document.getElementById('root')).render(<App />);
