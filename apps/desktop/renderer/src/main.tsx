import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { BrowserProvider } from './state/browser-store';
import { WorkspaceProvider } from './state/workspace-store';
import './styles.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('No se encontró el contenedor raíz de la interfaz.');
}

createRoot(container).render(
  <StrictMode>
    <WorkspaceProvider>
      <BrowserProvider>
        <App />
      </BrowserProvider>
    </WorkspaceProvider>
  </StrictMode>,
);
