/* =============================================================
   Theme toggle — shared by both pages, so it carries its own icon
   sizing instead of relying on either page's stylesheet.
   ============================================================= */

import { useTheme } from './theme.js';

// Shows the theme it switches TO, so the icon reads as the action.
export function ThemeToggle({ className = 'btn btn-icon' }) {
  const { theme, toggleTheme } = useTheme();
  const goingDark = theme === 'light';
  const label = goingDark ? '切换到暗色主题' : '切换到亮色主题';

  return (
    <button className={className} onClick={toggleTheme} title={label} aria-label={label}>
      {goingDark ? (
        <svg className="icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M13.4 9.6A5.6 5.6 0 0 1 6.4 2.6a5.6 5.6 0 1 0 7 7Z"
            stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round"/>
        </svg>
      ) : (
        <svg className="icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="3.1" stroke="currentColor" strokeWidth="1.35"/>
          <path d="M8 1.2v1.6M8 13.2v1.6M14.8 8h-1.6M2.8 8H1.2M12.8 3.2l-1.1 1.1M4.3 11.7l-1.1 1.1M12.8 12.8l-1.1-1.1M4.3 4.3 3.2 3.2"
            stroke="currentColor" strokeWidth="1.35" strokeLinecap="round"/>
        </svg>
      )}
    </button>
  );
}
