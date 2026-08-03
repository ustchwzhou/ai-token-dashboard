/* =============================================================
   Theme — the resolved theme is written to <html data-theme>, so a
   manual choice can override the OS instead of racing @media rules.
   ============================================================= */

import { createContext, createElement, useCallback, useContext, useEffect, useState } from 'react';

export const THEME_KEY = 'ts-theme';
const THEMES = ['light', 'dark'];
const DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * Decide which theme to show. A stored manual choice always wins;
 * otherwise follow the OS. Both inputs are passed in so the rule stays
 * pure and testable without a DOM.
 */
export function resolveTheme(stored, prefersDark) {
  if (THEMES.includes(stored)) return stored;
  return prefersDark ? 'dark' : 'light';
}

// localStorage throws in private mode / blocked-cookie setups; a missing
// preference is not worth breaking the page over.
function readStored() {
  try {
    return localStorage.getItem(THEME_KEY);
  } catch {
    return null;
  }
}

function writeStored(theme) {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* preference just won't persist */
  }
}

const ThemeContext = createContext({ theme: 'light', toggleTheme: () => {} });

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(
    () => resolveTheme(readStored(), window.matchMedia(DARK_QUERY).matches)
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // Track the OS only until the user picks a side; after that the stored
  // choice sticks even when the system flips.
  useEffect(() => {
    const query = window.matchMedia(DARK_QUERY);
    const onChange = event => {
      if (readStored()) return;
      setTheme(event.matches ? 'dark' : 'light');
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(current => {
      const next = current === 'dark' ? 'light' : 'dark';
      writeStored(next);
      return next;
    });
  }, []);

  return createElement(ThemeContext.Provider, { value: { theme, toggleTheme } }, children);
}

export function useTheme() {
  return useContext(ThemeContext);
}

/**
 * ECharts paints to canvas and cannot read CSS custom properties, so chart
 * chrome carries its own palette. Keep these in step with the `:root` and
 * `:root[data-theme="dark"]` blocks in the page stylesheets.
 */
const CHART_PALETTES = {
  light: {
    axisLine:       'oklch(0.92 0.004 80)',
    splitLine:      'oklch(0.95 0.004 80)',
    axisLabel:      'oklch(0.55 0.005 80)',
    axisLabelDim:   'oklch(0.62 0.004 80)',
    tooltipBg:      'oklch(0.995 0.004 80)',
    tooltipBorder:  'oklch(0.92 0.004 80)',
    tooltipText:    'oklch(0.18 0.005 80)',
    tooltipLabel:   'oklch(0.40 0.005 80)',
    tooltipMuted:   'oklch(0.55 0.005 80)',
    tooltipSeries:  'oklch(0.45 0.005 80)',
    markLine:       'oklch(0.72 0.005 80)',
    markLineCompare:'oklch(0.45 0.04 265)',
    crossHair:      'oklch(0.62 0.04 265 / 0.45)',
    zoomBg:         'oklch(0.97 0.004 80)',
    zoomFiller:     'oklch(0.92 0.02 265 / 0.5)',
    zoomHandle:     'oklch(0.995 0.004 80)',
    zoomHandleEdge: 'oklch(0.55 0.16 265)',
    sliceBorder:    'oklch(0.995 0.005 80)'
  },
  dark: {
    axisLine:       'oklch(0.32 0.008 60)',
    splitLine:      'oklch(0.27 0.008 60)',
    axisLabel:      'oklch(0.66 0.006 60)',
    axisLabelDim:   'oklch(0.58 0.006 60)',
    tooltipBg:      'oklch(0.26 0.010 80)',
    tooltipBorder:  'oklch(0.36 0.010 80)',
    tooltipText:    'oklch(0.95 0.005 80)',
    tooltipLabel:   'oklch(0.78 0.005 80)',
    tooltipMuted:   'oklch(0.66 0.005 80)',
    tooltipSeries:  'oklch(0.80 0.005 80)',
    markLine:       'oklch(0.50 0.008 80)',
    markLineCompare:'oklch(0.72 0.06 265)',
    crossHair:      'oklch(0.72 0.06 265 / 0.5)',
    zoomBg:         'oklch(0.24 0.008 80)',
    zoomFiller:     'oklch(0.50 0.05 265 / 0.45)',
    zoomHandle:     'oklch(0.30 0.010 80)',
    zoomHandleEdge: 'oklch(0.70 0.15 265)',
    sliceBorder:    'oklch(0.21 0.008 80)'
  }
};

export function chartPalette(theme) {
  return CHART_PALETTES[theme] || CHART_PALETTES.light;
}
