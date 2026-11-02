import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'flag-icons/css/flag-icons.min.css';
import '../../../shared/src/index.css';
import './styles/app.css';
import App from './App.jsx';

if (import.meta.env.DEV && (new URLSearchParams(location.search).get('offline') === '1' || sessionStorage.getItem('opval-offline-preview') === '1')) {
  const { installOfflinePreview } = await import('./lib/offlinePreview');
  installOfflinePreview();
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
