import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/nunito/latin-400.css';
import '@fontsource/nunito/latin-ext-400.css';
import '@fontsource/nunito/vietnamese-400.css';
import './index.css';
import App from './App.tsx';
import { initializeEditorSession } from './state/editorStartup';
// Fork-only side effect: Souv cloud (login-gated save/export) + WebMCP host.
// No-op unless VITE_CLOUD_SAVE=1 / WebMCP present. See `src/cloud/README.md`.
import './cloud/mount.tsx';

initializeEditorSession();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
