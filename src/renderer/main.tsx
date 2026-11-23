import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initializeLanguage } from './i18n';
import './styles.css';

document.documentElement.dataset.platform = window.mockManager?.platform ?? 'other';
void initializeLanguage().then(() => createRoot(document.getElementById('root')!).render(<App />));
