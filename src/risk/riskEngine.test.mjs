import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticForecast } from '../weather/testSupport/syntheticWeather.mjs';
import { normalizeForecast } from '../weather/normalize.js';
import { deriveMetrics } from '../weather/derived.js';
import { analyzeSnapshot, assessHazards, overallRisk } from './riskEngine.js';
import { riskLevel } from './thresholds.js';
import { ramp, weightedScore } from './scoring.js';

const analyze = (options) =>
  analyzeSnapshot(normalizeForecast(syntheticForecast(options)));

test('a calm day scores every hazard as NORMAL', () => {
  const analysis = analyze();
  for (const [id, hazard] of Object.entries(analysis.risks))
    assert.ok(
      hazard.score <= 20,
      `${id} scored ${hazard.score} on a calm day: ${hazard.summary}`,
    );
  assert.equal(analysis.overall.level, 'NORMAL');
  // A quiet hazard explains itself as a finding, not as a warning with reasons.
  assert.match(analysis.risks.flood.summary, /^No significant Flood signal/);
  assert.doesNotMatch(analysis.risks.flood.summary, /:/);
});

test('sustained rain onto saturated ground raises flood risk above flash flood', () => {
  const analysis = analyze({
    base: {
      soil_moisture_0_to_1cm: 0.44,
      soil_moisture_1_to_3cm: 0.43,
      soil_moisture_3_to_9cm: 0.42,
      soil_moisture_9_to_27cm: 0.4,
      soil_moisture_27_to_81cm: 0.38,
      precipitation_probability: 90,
    },
    // Steady moderate rain for a day and a half: high totals, unremarkable rate.
    shape: (hour, values) => ({ ...values, precipitation: 4, rain: 4 }),
  });
  const flood = analysis.risks.flood;
  assert.ok(flood.score >= 61, `flood scored ${flood.score}`);
  assert.equal(flood.level, riskLevel(flood.score));
  // Rate is ordinary, so the rapid-onset model must stay below the slow one.
  assert.ok(
    analysis.risks.flashFlood.score < flood.score,
    'steady rain must not read as a flash flood',
  );
  const ids = flood.leadingDrivers.map((entry) => entry.id);
  assert.ok(ids.includes('soilMoisture'), `drivers were ${ids.join(', ')}`);
  assert.match(flood.summary, /Flood conditions are (elevated|strongly favorable)/);
  assert.doesNotMatch(flood.summary, /\bwill\b/);
});

test('a cloudburst on saturated ground is a flash flood, not a slow flood', () => {
  const analysis = analyze({
    base: {
      soil_moisture_0_to_1cm: 0.45,
      soil_moisture_1_to_3cm: 0.44,
      soil_moisture_3_to_9cm: 0.43,
      precipitation_probability: 95,
    },
    // Dry until the last two hours, then a violent burst that keeps going.
    shape: (hour, values) => {
      const intense = hour >= -1 && hour <= 3;
      return {
        ...values,
        precipitation: intense ? 28 : 0,
        rain: intense ? 28 : 0,
        weather_code: intense ? 82 : 1,
      };
    },
  });
  const { flashFlood, flood } = analysis.risks;
  assert.ok(flashFlood.score >= 61, `flash flood scored ${flashFlood.score}`);
  assert.ok(
    flashFlood.score > flood.score,
    `rapid onset (${flashFlood.score}) must outrank accumulation (${flood.score})`,
  );
  const ids = flashFlood.leadingDrivers.map((entry) => entry.id);
  assert.ok(ids.includes('rainRate1h') || ids.includes('rainAcceleration'));
  assert.equal(flashFlood.damped, null);
});

test('saturated ground under a dry sky is damped, not called a flash flood', () => {
  const analysis = analyze({
    base: {
      soil_moisture_0_to_1cm: 0.46,
      soil_moisture_1_to_3cm: 0.45,
      soil_moisture_3_to_9cm: 0.45,
    },
  });
  const { flashFlood } = analysis.risks;
  assert.ok(flashFlood.damped, 'a rate model with no rate must record its damping');
  assert.match(flashFlood.damped.reason, /no significant short-duration rainfall/);
  assert.ok(flashFlood.score <= 40, `flash flood scored ${flashFlood.score}`);
  // The damping stays structural here: a NORMAL hazard is reported as a finding,
  // and explaining what is NOT happening would read as a warning.
  assert.match(flashFlood.summary, /^No significant Flash flood signal/);
});

test('a deepening windstorm scores wind and storm risk together', () => {
  const analysis = analyze({
    shape: (hour, values) => ({
      ...values,
      wind_speed_10m: 62,
      wind_speed_180m: 95,
      wind_gusts_10m: 108,
      // Pressure falling steadily as the hours advance: later hours are lower.
      pressure_msl: 1012 - hour * 1.6,
      weather_code: 95,
      precipitation: 6,
      rain: 6,
    }),
  });
  const wind = analysis.risks.wind;
  assert.ok(wind.score >= 61, `wind scored ${wind.score}`);
  assert.ok(wind.storm.score >= 61, `storm scored ${wind.storm.score}`);
  const ids = wind.leadingDrivers.map((entry) => entry.id);
  assert.ok(ids.includes('gusts'), `drivers were ${ids.join(', ')}`);
  assert.match(wind.summary, /gusts are reaching 108 km\/h/);
  // Hazard language stays about conditions, never about property.
  assert.doesNotMatch(wind.summary, /damage|destroy|collapse/i);
});

test('hot, dry and windy reads as fire-spread conditions, never as a fire', () => {
  const analysis = analyze({
    base: {
      temperature_2m: 39,
      relative_humidity_2m: 11,
      dew_point_2m: 2,
      apparent_temperature: 41,
      vapour_pressure_deficit: 4.2,
      wind_speed_10m: 38,
      wind_gusts_10m: 52,
      soil_moisture_0_to_1cm: 0.05,
      soil_moisture_1_to_3cm: 0.06,
      soil_moisture_3_to_9cm: 0.07,
      soil_moisture_9_to_27cm: 0.08,
      soil_moisture_27_to_81cm: 0.1,
    },
  });
  const fire = analysis.risks.fireConditions;
  assert.ok(fire.score >= 61, `fire conditions scored ${fire.score}`);
  assert.equal(fire.label, 'Fire Spread Conditions');
  assert.match(fire.disclaimer, /not a fire detection/i);
  assert.doesNotMatch(fire.summary, /wildfire detected|fire detected|there is a fire/i);
});

test('rain suppresses fire-spread conditions whatever the other signals read', () => {
  const base = {
    temperature_2m: 36,
    relative_humidity_2m: 14,
    vapour_pressure_deficit: 3.8,
    wind_speed_10m: 34,
  };
  const dry = analyze({ base }).risks.fireConditions;
  const wet = analyze({
    base: { ...base, precipitation: 2.4, rain: 2.4 },
  }).risks.fireConditions;
  assert.ok(wet.score < dry.score, `${wet.score} should sit below ${dry.score}`);
  assert.ok(wet.damped, 'suppression must be recorded, not silent');
  assert.match(wet.summary, /Active precipitation is suppressing/);
});

test('humid heat scores above dry heat at the same air temperature', () => {
  const dry = analyze({
    base: {
      temperature_2m: 40,
      apparent_temperature: 38,
      dew_point_2m: 6,
      relative_humidity_2m: 12,
    },
  }).risks.heat;
  const humid = analyze({
    base: {
      temperature_2m: 40,
      apparent_temperature: 47,
      dew_point_2m: 27,
      relative_humidity_2m: 65,
    },
  }).risks.heat;
  assert.ok(
    humid.score > dry.score,
    `humid ${humid.score} should exceed dry ${dry.score}`,
  );
  assert.ok(humid.score >= 61);
  // Heat is an environmental statement; it must not drift into health advice.
  assert.doesNotMatch(humid.summary, /drink|hydrat|health|medical|doctor/i);
});

test('fog needs low cloud, not just a narrow dew point spread', () => {
  const aloft = analyze({
    base: { temperature_2m: 12, dew_point_2m: 11.6, cloud_cover_low: 5, visibility: 20000 },
  }).risks.visibility;
  const atSurface = analyze({
    base: {
      temperature_2m: 12,
      dew_point_2m: 11.6,
      cloud_cover_low: 95,
      visibility: 400,
      weather_code: 45,
    },
  }).risks.visibility;
  assert.ok(aloft.score <= 20, `clear-sky visibility scored ${aloft.score}`);
  assert.ok(atSurface.score >= 61, `fog scored ${atSurface.score}`);
  assert.match(atSurface.summary, /visibility is 400 m/);
});

test('forecast horizons are scored from their own hour, not extrapolated', () => {
  const analysis = analyze({
    // Dry now; a heavy band arrives between +7 h and +14 h.
    shape: (hour, values) => {
      const band = hour >= 7 && hour <= 14;
      return {
        ...values,
        precipitation: band ? 14 : 0,
        rain: band ? 14 : 0,
        precipitation_probability: band ? 95 : 10,
      };
    },
  });
  const horizons = Object.fromEntries(
    analysis.forecast.horizons.map((entry) => [entry.hours, entry]),
  );
  assert.deepEqual(Object.keys(horizons), ['3', '6', '12', '24']);
  assert.ok(
    horizons[12].scores.flood > analysis.risks.flood.score,
    'the +12 h hour sits inside the band and must score higher than now',
  );
  assert.ok(horizons[12].at.endsWith('Z'), 'horizons carry their own timestamp');
  // Projections are hedged, never stated as fact.
  for (const note of analysis.forecast.horizons.flatMap((entry) => entry.notes)) {
    assert.match(note, /projected to (increase|ease)/);
    assert.doesNotMatch(note, /\bwill\b/);
  }
});

test('trends read from the previous analysis when one exists', () => {
  const quiet = analyze();
  const wet = analyzeSnapshot(
    normalizeForecast(
      syntheticForecast({
        base: { soil_moisture_0_to_1cm: 0.42, soil_moisture_1_to_3cm: 0.42 },
        shape: (hour, values) => ({ ...values, precipitation: 6, rain: 6 }),
      }),
    ),
    { previous: quiet },
  );
  const trend = wet.risks.flood.trend;
  assert.equal(trend.source, 'observed');
  assert.equal(trend.direction, 'INCREASING');
  assert.equal(trend.previous, quiet.risks.flood.score);
  assert.equal(trend.change, wet.risks.flood.score - quiet.risks.flood.score);
  // Without a previous analysis the arrow comes from the projection, and says so.
  assert.equal(quiet.risks.flood.trend.source, 'projected');
});

test('significant changes are emitted as EventBridge-shaped records', () => {
  const before = analyze();
  const after = analyzeSnapshot(
    normalizeForecast(
      syntheticForecast({
        shape: (hour, values) => ({
          ...values,
          wind_speed_10m: hour >= -1 ? 58 : 9,
          wind_gusts_10m: hour >= -1 ? 96 : 15,
          precipitation: hour >= -1 ? 18 : 0,
          rain: hour >= -1 ? 18 : 0,
          pressure_msl: hour >= -1 ? 1001 : 1015,
        }),
      }),
    ),
    { previous: before },
  );
  const changes = after.significantChanges;
  assert.ok(changes.length > 0, 'a squall arriving must produce change events');
  const gusts = changes.find((event) => event.metric === 'wind_gusts_10m');
  assert.ok(gusts, `metrics reported: ${changes.map((c) => c.metric).join(', ')}`);
  assert.equal(gusts.type, 'WEATHER_CHANGE_DETECTED');
  assert.equal(gusts.direction, 'INCREASE');
  assert.ok(['MODERATE', 'ELEVATED', 'HIGH'].includes(gusts.severity));
  assert.equal(gusts.change, gusts.current_value - gusts.previous_value);
  assert.ok(gusts.location && gusts.timestamp);
  // Risk-score movement is itself an event, so a workflow can trigger on it.
  assert.ok(changes.some((event) => event.metric.startsWith('risk.')));
});

test('a steady state produces no change events', () => {
  const first = analyze();
  const second = analyzeSnapshot(normalizeForecast(syntheticForecast()), {
    previous: first,
  });
  assert.deepEqual(second.significantChanges, []);
});

test('overall risk follows the worst hazard rather than the average', () => {
  const risks = {
    flood: { id: 'flood', score: 90 },
    wind: { id: 'wind', score: 5 },
    heat: { id: 'heat', score: 5 },
    visibility: { id: 'visibility', score: 5 },
  };
  const overall = overallRisk(risks);
  assert.equal(overall.peak, 'flood');
  assert.ok(overall.score >= 70, `one HIGH hazard must dominate: ${overall.score}`);
  assert.equal(overall.level, riskLevel(overall.score));
});

test('missing variables lower confidence instead of inventing risk', () => {
  const payload = syntheticForecast();
  // A provider that omits soil entirely must not read as saturated ground.
  for (const key of Object.keys(payload.hourly))
    if (key.startsWith('soil_moisture'))
      payload.hourly[key] = payload.hourly[key].map(() => null);
  const analysis = analyzeSnapshot(normalizeForecast(payload));
  assert.equal(analysis.metrics.soil_moisture_index, null);
  assert.ok(analysis.risks.flood.score <= 20);
  const soil = analysis.risks.flood.drivers.find((d) => d.id === 'soilMoisture');
  assert.equal(soil.value, null);
  assert.equal(soil.intensity, 0);
});

test('scores, levels and the analysis envelope hold their contract', () => {
  const analysis = analyze({
    shape: (hour, values) => ({ ...values, precipitation: 9, rain: 9 }),
  });
  assert.equal(analysis.schemaVersion, '1.0.0');
  assert.ok(analysis.generatedAt.endsWith('Z'));
  assert.deepEqual(Object.keys(analysis.risks), [
    'flood',
    'flashFlood',
    'wind',
    'fireConditions',
    'heat',
    'visibility',
  ]);
  for (const hazard of Object.values(analysis.risks)) {
    assert.ok(Number.isInteger(hazard.score) && hazard.score >= 0 && hazard.score <= 100);
    assert.equal(hazard.level, riskLevel(hazard.score));
    assert.ok(hazard.drivers.length > 0);
    for (const entry of hazard.drivers)
      assert.ok(entry.intensity >= 0 && entry.intensity <= 1, entry.id);
    // Drivers arrive ranked by what they actually contributed.
    const contributions = hazard.drivers.map((entry) => entry.contribution);
    assert.deepEqual(contributions, [...contributions].sort((a, b) => b - a));
  }
  assert.ok(analysis.headline.hazard);
  assert.ok(JSON.parse(JSON.stringify(analysis)), 'analysis must serialize for Bedrock');
});

test('level bands match the documented thresholds exactly', () => {
  assert.equal(riskLevel(0), 'NORMAL');
  assert.equal(riskLevel(20), 'NORMAL');
  assert.equal(riskLevel(21), 'LOW');
  assert.equal(riskLevel(40), 'LOW');
  assert.equal(riskLevel(41), 'MODERATE');
  assert.equal(riskLevel(60), 'MODERATE');
  assert.equal(riskLevel(61), 'ELEVATED');
  assert.equal(riskLevel(80), 'ELEVATED');
  assert.equal(riskLevel(81), 'HIGH');
  assert.equal(riskLevel(100), 'HIGH');
});

test('ramps clamp, run downward, and refuse to score missing data', () => {
  assert.equal(ramp(5, [0, 10]), 0.5);
  assert.equal(ramp(-3, [0, 10]), 0);
  assert.equal(ramp(99, [0, 10]), 1);
  // Descending ramp: low values score high.
  assert.equal(ramp(20, [60, 10]), 0.8);
  assert.equal(ramp(null, [0, 10]), 0);
  assert.equal(ramp(undefined, [0, 10]), 0);
  // A missing signal redistributes its weight instead of dragging the score down.
  assert.equal(weightedScore([{ weight: 1, intensity: 1 }]), 100);
  assert.equal(
    weightedScore([
      { weight: 0.5, intensity: 1 },
      { weight: 0, intensity: 0 },
    ]),
    100,
  );
  assert.equal(weightedScore([]), 0);
});

test('derived windows separate observed accumulation from forecast', () => {
  const snapshot = normalizeForecast(
    syntheticForecast({
      shape: (hour, values) => ({
        ...values,
        precipitation: hour <= 0 ? 2 : 5,
        rain: hour <= 0 ? 2 : 5,
      }),
    }),
  );
  const metrics = deriveMetrics(snapshot, snapshot.currentIndex);
  assert.equal(metrics.rain_1h, 2, 'the current hour is observed, not forecast');
  assert.equal(metrics.rain_6h, 12);
  assert.equal(metrics.rain_24h, 48);
  assert.equal(metrics.forecast_rain_6h, 30, 'forecast windows look strictly forward');
  assert.equal(metrics.forecast_rain_24h, 120);
  assert.equal(metrics.anchorIndex, snapshot.currentIndex);
});

test('hazard assessment is pure: the same snapshot always scores the same', () => {
  const snapshot = normalizeForecast(
    syntheticForecast({ shape: (h, v) => ({ ...v, precipitation: 7, rain: 7 }) }),
  );
  const first = assessHazards(deriveMetrics(snapshot, snapshot.currentIndex));
  const second = assessHazards(deriveMetrics(snapshot, snapshot.currentIndex));
  assert.deepEqual(
    JSON.parse(JSON.stringify(first)),
    JSON.parse(JSON.stringify(second)),
  );
});
