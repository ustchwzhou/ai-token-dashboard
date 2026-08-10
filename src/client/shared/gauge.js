/* =============================================================
   Semicircular gauge geometry.

   The arc path and the dash length are derived from one radius, so
   the drawn fraction can never drift from the number beside it.
   ============================================================= */

export const GAUGE = {
  radius: 80,
  cx: 90,
  cy: 90,
  viewBox: '0 0 180 100'
};

/** The `d` of the half-circle both the track and the progress arc use. */
export const GAUGE_PATH =
  `M ${GAUGE.cx - GAUGE.radius} ${GAUGE.cy} `
  + `A ${GAUGE.radius} ${GAUGE.radius} 0 0 1 ${GAUGE.cx + GAUGE.radius} ${GAUGE.cy}`;

/** Length of that half-circle. */
export const GAUGE_LENGTH = Math.PI * GAUGE.radius;

/**
 * Dash pattern that fills `percent` of the arc.
 * Out-of-range input is clamped so a bad rate cannot overdraw the track.
 */
export function gaugeDash(percent) {
  const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
  return `${(clamped / 100) * GAUGE_LENGTH} ${GAUGE_LENGTH}`;
}
