/**
 * Prompt construction and the deterministic fallback summary.
 *
 * The model computes; the narrator describes. This module builds the prompt that
 * enforces that split — every number Bedrock may use is supplied, and it is told
 * to reuse them verbatim and to invent nothing — and it also writes the summary
 * used when Bedrock is not configured, which is assembled by template from the
 * same numbers and is labelled as such. A reader can always tell which they are
 * looking at.
 */

/** The rules Bedrock operates under. Deliberately restrictive. */
export const SYSTEM_PROMPT = [
  'You are the narration layer of Aegis, a disaster intelligence platform.',
  'You receive a deterministic seismic activity forecast and describe it for an operator.',
  '',
  'RULES:',
  '1. Use ONLY the numbers supplied. Never compute, estimate or round a new figure.',
  '2. Always state what the probability is a probability OF: the supplied target definition.',
  '3. Never predict a specific earthquake, its time, location or magnitude.',
  '4. Never say an earthquake will or will not happen.',
  '5. Never claim damage, casualties or infrastructure impact.',
  '6. Attribute observations to USGS.',
  '7. If the supplied evidence is weak or the model has low skill, say so plainly.',
  '8. Two short paragraphs maximum. No bullet lists. No headings.',
].join('\n');

/**
 * Build the user message: the complete evidence package, and nothing else.
 *
 * @param {object} input Input.
 * @param {object} input.forecast Forecast record.
 * @param {object} [input.intelligence] Current observation summary.
 * @param {object} [input.region] Region descriptor.
 * @param {string} [input.question] An operator's question, when there is one.
 * @returns {string} User message.
 */
export function buildForecastPrompt({
  forecast,
  intelligence = null,
  region = null,
  question = null,
}) {
  const lines = [];
  lines.push('SEISMIC FORECAST EVIDENCE');
  if (region?.label || region)
    lines.push(
      `Region: ${region.label || `${region.south?.toFixed?.(1)}..${region.north?.toFixed?.(1)}N, ${region.west?.toFixed?.(1)}..${region.east?.toFixed?.(1)}E`}`,
    );
  lines.push(`Target: ${forecast.targetDescription}`);
  lines.push(`Forecast window: ${forecast.forecastWindowHours}h`);
  lines.push(
    `Model probability for that target: ${forecast.probability === null ? 'unavailable' : `${(forecast.probability * 100).toFixed(0)}%`}`,
  );
  lines.push(
    `Region's own historical base rate for the same target: ${forecast.baselineProbability === null ? 'unavailable' : `${(forecast.baselineProbability * 100).toFixed(0)}%`}`,
  );
  lines.push(`Forecast direction against that baseline: ${forecast.trend}`);

  const anomaly = forecast.anomaly;
  if (anomaly)
    lines.push(
      `Activity anomaly: ${anomaly.currentCount} events in ${anomaly.windowHours}h against ${anomaly.expectedCount ?? 'unknown'} expected (${anomaly.level}). ${anomaly.note}`,
    );

  if (forecast.drivers?.length) {
    lines.push('Model drivers (already computed, do not reinterpret):');
    for (const driver of forecast.drivers) lines.push(`- ${driver.text}`);
  }

  if (intelligence) {
    lines.push(
      `USGS observations in view: ${intelligence.eventCount} events over the last ${intelligence.feedWindowHours}h; ${intelligence.sequenceCount} earthquake sequence(s).`,
    );
    if (intelligence.largestEvent?.magnitude != null)
      lines.push(
        `Largest recorded event: M${intelligence.largestEvent.magnitude} at ${intelligence.largestEvent.place}.`,
      );
  }

  if (forecast.validation)
    lines.push(
      `Model validation on held-out data: Brier ${forecast.validation.brierScore} against baseline ${forecast.validation.baselineBrierScore}, skill ${forecast.validation.brierSkillScore}, ROC-AUC ${forecast.validation.rocAuc}. ${forecast.validation.verdict}`,
    );
  lines.push(`Model: ${forecast.model?.name} ${forecast.model?.version}`);
  lines.push(`Constraint: ${forecast.disclaimer}`);
  lines.push('');
  lines.push(
    question
      ? `The operator asks: "${question}". Answer using only the evidence above.`
      : 'Write the operator summary using only the evidence above.',
  );
  return lines.join('\n');
}

/**
 * The deterministic summary used when Bedrock is not available.
 *
 * Assembled from the same numbers by template. It is not AI-generated and the
 * caller labels it accordingly, so an unconfigured deployment degrades to plain
 * prose rather than to silence or to invented narration.
 *
 * @param {object} input Input.
 * @param {object} input.forecast Forecast record.
 * @param {object} [input.intelligence] Observation summary.
 * @returns {string} Summary text.
 */
export function templateSummary({ forecast, intelligence = null }) {
  const sentences = [];
  const anomaly = forecast.anomaly;

  if (anomaly?.level === 'INSUFFICIENT_BASELINE')
    sentences.push(
      `USGS has recorded ${anomaly.currentCount} events of M${anomaly.thresholdMagnitude}+ in this region over the last ${anomaly.windowHours} hours, but there is too little history here to establish a baseline.`,
    );
  else if (anomaly)
    sentences.push(
      `USGS has recorded ${anomaly.currentCount} events of M${anomaly.thresholdMagnitude}+ in this region over the last ${anomaly.windowHours} hours, against ${anomaly.expectedCount} expected from its own 30-day history (${anomaly.label.toLowerCase()}).`,
    );

  if (forecast.status === 'READY' && forecast.probability !== null) {
    sentences.push(
      `The forecasting model estimates a ${(forecast.probability * 100).toFixed(0)}% probability of ${forecast.targetDescription} in this region, against a historical base rate of ${forecast.baselineProbability === null ? 'unknown' : `${(forecast.baselineProbability * 100).toFixed(0)}%`}.`,
    );
    if (forecast.drivers?.length)
      sentences.push(
        `The strongest signal is that ${forecast.drivers[0].text}.`,
      );
  } else {
    sentences.push(
      'No forecasting model is available, so only observed activity is reported.',
    );
  }

  if (intelligence?.sequenceCount)
    sentences.push(
      `${intelligence.sequenceCount} earthquake sequence${intelligence.sequenceCount > 1 ? 's are' : ' is'} present in the current view.`,
    );

  sentences.push(
    'This is a forecast of a defined seismic-activity outcome, not a prediction of a specific earthquake.',
  );
  return sentences.join(' ');
}
