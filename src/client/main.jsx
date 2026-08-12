import { createRoot } from 'react-dom/client';
import { App } from './dashboard/App.jsx';
import { ReviewApp } from './review/ReviewApp.jsx';
import { UsageApp } from './usage/UsageApp.jsx';
import { ThemeProvider } from './shared/theme.js';

function Root() {
  if (window.location.pathname === '/review') {
    document.title = 'AI Token 复盘 · Token Studio';
    return <ReviewApp />;
  }

  if (window.location.pathname === '/usage') {
    document.title = 'AI Token 流水 · Token Studio';
    return <UsageApp />;
  }

  document.title = 'Token Studio · AI Token Dashboard';
  return <App />;
}

createRoot(document.getElementById('root')).render(
  <ThemeProvider>
    <Root />
  </ThemeProvider>
);
