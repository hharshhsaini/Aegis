/**
 * Phrasing for risk explanations.
 *
 * Weather does not prove a disaster. These sentences therefore describe
 * CONDITIONS and POTENTIAL, never outcomes: "conditions favor", "risk is
 * increasing", "monitoring recommended". A forecast hour is "projected" or
 * "modeled", never "will". Keeping that vocabulary in one module means a
 * future model cannot quietly introduce certainty the data does not support.
 *
 * The text is assembled from the same driver records that produced the score,
 * so an explanation can never disagree with the number it explains.
 */

/** Level-led openings, shared by every hazard. */
const LEVEL_PHRASES = Object.freeze({
  NORMAL: 'No significant {hazard} signal in current conditions',
  LOW: 'Low {hazard} signal',
  MODERATE: '{hazard} conditions are developing',
  ELEVATED: '{hazard} conditions are elevated',
  HIGH: '{hazard} conditions are strongly favorable',
});

/** Closing guidance by level. Advice is operational, never medical or legal. */
const LEVEL_GUIDANCE = Object.freeze({
  NORMAL: '',
  LOW: '',
  MODERATE: 'Monitoring recommended.',
  ELEVATED: 'Monitoring recommended.',
  HIGH: 'Close monitoring recommended.',
});

/** Direction words for a trend record. */
export const TREND_WORDS = Object.freeze({
  INCREASING: 'increasing',
  DECREASING: 'decreasing',
  STABLE: 'steady',
  UNKNOWN: 'unclear',
});

/** Arrows for compact display. */
export const TREND_ARROWS = Object.freeze({
  INCREASING: '↑',
  DECREASING: '↓',
  STABLE: '→',
  UNKNOWN: '·',
});

/**
 * Join phrases into readable prose.
 * @param {string[]} parts Phrases.
 * @returns {string} Comma-joined list with a trailing "and".
 */
export function joinPhrases(parts) {
  const items = parts.filter(Boolean);
  if (items.length <= 1) return items[0] || '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * Compose one hazard explanation.
 *
 * @param {object} input Narration input.
 * @param {string} input.hazard Hazard name as it reads mid-sentence, e.g. "Flood".
 * @param {string} input.level Risk level id.
 * @param {object[]} input.drivers Leading driver records, strongest first.
 * @param {string} [input.trend] Trend direction for this hazard.
 * @param {string} [input.qualifier] Extra clause appended before the guidance.
 * @returns {string} Explanation sentence.
 */
export function explainHazard({
  hazard,
  level,
  drivers,
  trend,
  qualifier = '',
}) {
  const opening = (LEVEL_PHRASES[level] || LEVEL_PHRASES.NORMAL).replace(
    '{hazard}',
    hazard,
  );
  // A quiet hazard needs no reasons. Listing the drivers behind a NORMAL score
  // reads as a warning — "only 0 mm of rain has fallen" is alarming prose for a
  // score of 12 — so the explanation stops at the finding.
  if (level === 'NORMAL') return `${opening}.`;
  const reasons = joinPhrases(
    drivers.map((entry) => entry.detail).filter(Boolean),
  );
  const sentences = [];
  sentences.push(reasons ? `${opening}: ${reasons}.` : `${opening}.`);
  if (qualifier) sentences.push(`${qualifier}.`);
  if (trend === 'INCREASING')
    sentences.push('The signal has strengthened over the last few hours.');
  else if (trend === 'DECREASING')
    sentences.push('The signal has weakened over the last few hours.');
  const guidance = LEVEL_GUIDANCE[level];
  if (guidance) sentences.push(guidance);
  return sentences.join(' ');
}

/**
 * Describe a projected change across a forecast horizon.
 * @param {string} hazard Hazard name.
 * @param {number} current Current score.
 * @param {number} projected Projected score.
 * @param {number} hours Horizon in hours.
 * @returns {string} Hedged projection sentence, or '' when the change is small.
 */
export function explainProjection(hazard, current, projected, hours) {
  const delta = projected - current;
  if (Math.abs(delta) < 8) return '';
  const direction = delta > 0 ? 'increase' : 'ease';
  return `${hazard} risk is projected to ${direction} over the next ${hours} hours (${current} → ${projected}).`;
}

/**
 * Monitoring priorities implied by a set of hazard assessments.
 *
 * These are a RESTATEMENT of the scored analysis, not advice added on top of
 * it. Each line names a hazard the engine actually scored above NORMAL and the
 * driver that produced that score, so nothing here can assert a condition the
 * numbers do not already carry. The verbs stay observational — monitor, track,
 * watch — because Aegis reports conditions and does not direct a response.
 *
 * A quiet picture returns one line saying so. An empty list would read as a
 * rendering failure rather than as an all-clear.
 *
 * @param {object} risks Hazard assessments keyed by id.
 * @param {number} [limit] Maximum priorities.
 * @returns {object[]} Frozen `{ hazard, level, text }` records, worst first.
 */
export function priorityActions(risks, limit = 3) {
  const active = Object.values(risks || {})
    .filter((hazard) => hazard && hazard.level !== 'NORMAL')
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  if (!active.length)
    return Object.freeze([
      Object.freeze({
        hazard: null,
        level: 'NORMAL',
        text: 'No hazard is scored above normal. Routine monitoring only.',
      }),
    ]);

  const VERBS = Object.freeze({
    LOW: 'Track',
    MODERATE: 'Monitor',
    ELEVATED: 'Prioritize monitoring of',
    HIGH: 'Prioritize monitoring of',
  });

  return Object.freeze(
    active.map((hazard) => {
      const driver = hazard.leadingDrivers?.[0];
      const verb = VERBS[hazard.level] || 'Monitor';
      const because = driver?.detail ? ` — ${driver.detail}` : '';
      return Object.freeze({
        hazard: hazard.id,
        level: hazard.level,
        text: `${verb} ${hazard.label.toLowerCase()} (${hazard.score}/100)${because}.`,
      });
    }),
  );
}
