import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './app/App';
import './styles/app.css';

const APPEARANCE_KEY = 'rcloneHub.appearance';

try {
  const saved = window.localStorage.getItem(APPEARANCE_KEY);
  const initialTheme = saved === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = initialTheme;
} catch {
  document.documentElement.dataset.theme = 'dark';
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
