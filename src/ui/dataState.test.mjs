import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FEED_STATES,
  classifyFeedState,
  describeFeedState,
  formatAge,
  renderFeedState,
} from './dataState.js';

const HOUR = 3_600_000;
const MINUTE = 60_000;
const NOW = Date.parse('2026-09-19T12:00:00Z');

test('fresh data within the feed cadence is LIVE', () => {
  assert.equal(
    classifyFeedState({
      hasData: true,
      observedAt: NOW - 4 * MINUTE,
      now: NOW,
    }),
    FEED_STATES.LIVE,
  );
});

test('data past one cadence is RECENT, past the second is STALE', () => {
  assert.equal(
    classifyFeedState({
      hasData: true,
      observedAt: NOW - 30 * MINUTE,
      now: NOW,
    }),
    FEED_STATES.RECENT,
  );
  assert.equal(
    classifyFeedState({ hasData: true, observedAt: NOW - 2 * HOUR, now: NOW }),
    FEED_STATES.STALE,
  );
});

test('a failed refresh over held data is STALE, not UNAVAILABLE', () => {
  // The observation on screen is still a real observation. Calling it
  // unavailable would discard evidence the operator can still use.
  assert.equal(
    classifyFeedState({
      hasData: true,
      failed: true,
      observedAt: NOW - MINUTE,
      now: NOW,
    }),
    FEED_STATES.STALE,
  );
});

test('a failure with nothing held is UNAVAILABLE', () => {
  assert.equal(
    classifyFeedState({ hasData: false, failed: true, now: NOW }),
    FEED_STATES.UNAVAILABLE,
  );
});

test('a successful empty answer is NO_EVENTS, not NO_DATA or UNAVAILABLE', () => {
  // The distinction the whole module exists for. A USGS query over a quiet
  // ocean returns zero earthquakes: that is an observation, and the most
  // informative one the feed can give.
  assert.equal(
    classifyFeedState({
      hasData: true,
      empty: true,
      observedAt: NOW - MINUTE,
      now: NOW,
    }),
    FEED_STATES.NO_EVENTS,
  );
});

test('an area never observed is NO_DATA, not a successful empty answer', () => {
  assert.equal(
    classifyFeedState({ hasData: false, observedAt: NOW - HOUR, now: NOW }),
    FEED_STATES.NO_DATA,
  );
  // Nothing observed and nothing in flight yet is still LOADING, not a claim.
  assert.equal(
    classifyFeedState({ hasData: false, now: NOW }),
    FEED_STATES.LOADING,
  );
});

test('a correct empty answer never offers RETRY', () => {
  // Retrying a correct answer just asks the same question again. This is the
  // exact combination that shipped broken: chip NO DATA, a RETRY button, and
  // "last observation: just now" all describing one healthy response.
  const noEvents = describeFeedState({
    state: FEED_STATES.NO_EVENTS,
    sourceLabel: 'USGS',
    subjectPlural: 'earthquakes',
    observedAt: NOW - MINUTE,
    now: NOW,
  });
  assert.equal(noEvents.retryable, false);
  assert.equal(noEvents.label, 'NO EVENTS');
  assert.equal(
    noEvents.tone,
    'ok',
    'a healthy feed does not read as a warning',
  );
  assert.equal(noEvents.showsContent, true, 'the metrics still render');

  // A feed that actually failed does offer one.
  assert.equal(
    describeFeedState({
      state: FEED_STATES.UNAVAILABLE,
      sourceLabel: 'USGS',
      now: NOW,
    }).retryable,
    true,
  );
});

test('a processing failure is reported as itself, not as an outage', () => {
  assert.equal(
    classifyFeedState({ hasData: true, errored: true, now: NOW }),
    FEED_STATES.ERROR,
  );
  const described = describeFeedState({
    state: FEED_STATES.ERROR,
    sourceLabel: 'USGS',
    now: NOW,
  });
  assert.equal(described.headline, 'PROCESSING ERROR');
  assert.equal(described.tone, 'alert');
});

test('a refresh over existing data does not blank the panel', () => {
  assert.equal(
    classifyFeedState({
      hasData: true,
      loading: true,
      observedAt: NOW - MINUTE,
      now: NOW,
    }),
    FEED_STATES.LIVE,
  );
  assert.equal(
    classifyFeedState({ hasData: false, loading: true, now: NOW }),
    FEED_STATES.LOADING,
  );
});

test('the raw transport error never becomes the headline', () => {
  const description = describeFeedState({
    state: FEED_STATES.UNAVAILABLE,
    sourceLabel: 'NASA FIRMS',
    subjectPlural: 'fire detections',
    observedAt: NOW - 11 * MINUTE,
    now: NOW,
    detail: 'Fire intelligence unavailable (503)',
  });
  assert.equal(description.headline, 'DATA UNAVAILABLE');
  assert.ok(!description.headline.includes('503'));
  assert.ok(!description.message.includes('503'));
  assert.equal(description.detail, 'Fire intelligence unavailable (503)');
  assert.equal(description.lastObserved, '11 min ago');
  assert.equal(description.source, 'NASA FIRMS');
  assert.equal(description.retryable, true);
  assert.equal(description.showsContent, false);
});

test('an empty answer is worded as an observation, not an all-clear', () => {
  const description = describeFeedState({
    state: FEED_STATES.NO_EVENTS,
    sourceLabel: 'NASA FIRMS',
    subjectPlural: 'fire detections',
    now: NOW,
  });
  assert.equal(description.headline, 'NO RECENT FIRE DETECTIONS');
  assert.match(description.message, /not an all-clear/);
  assert.match(description.message, /current view/);
});

test('live and recent states carry no banner', () => {
  for (const state of [FEED_STATES.LIVE, FEED_STATES.RECENT]) {
    const description = describeFeedState({
      state,
      sourceLabel: 'NASA FIRMS',
      now: NOW,
    });
    assert.equal(description.headline, null);
    assert.equal(description.showsContent, true);
  }
});

test('stale keeps showing content while saying so', () => {
  const description = describeFeedState({
    state: FEED_STATES.STALE,
    sourceLabel: 'USGS',
    observedAt: NOW - 3 * HOUR,
    now: NOW,
  });
  assert.equal(description.showsContent, true);
  assert.equal(description.headline, 'STALE DATA');
  assert.equal(description.lastObserved, '3h ago');
});

test('ages read the way an operator would say them', () => {
  assert.equal(formatAge(0), 'just now');
  assert.equal(formatAge(MINUTE), '1 min ago');
  assert.equal(formatAge(11 * MINUTE), '11 min ago');
  assert.equal(formatAge(90 * MINUTE), '1h 30m ago');
  assert.equal(formatAge(2 * HOUR), '2h ago');
  assert.equal(formatAge(50 * HOUR), '2 days ago');
  assert.equal(formatAge(Number.NaN), 'just now');
});

/** The smallest document surface renderFeedState touches. */
function stubDocument() {
  const make = (tag) => ({
    tagName: tag,
    className: '',
    textContent: '',
    type: '',
    dataset: {},
    children: [],
    listeners: {},
    append(...nodes) {
      this.children.push(...nodes);
    },
    replaceChildren(...nodes) {
      this.children = nodes;
    },
    addEventListener(name, fn) {
      this.listeners[name] = fn;
    },
  });
  return { createElement: make };
}

/** Flatten a rendered tree to its text, for assertions about what is readable. */
function textOf(node) {
  return [node.textContent, ...node.children.map(textOf)].join(' ');
}

test('the rendered block puts the detail behind a disclosure', () => {
  const doc = stubDocument();
  const container = doc.createElement('div');
  let retried = 0;
  renderFeedState({
    document: doc,
    container,
    description: describeFeedState({
      state: FEED_STATES.UNAVAILABLE,
      sourceLabel: 'NASA FIRMS',
      subjectPlural: 'fire detections',
      observedAt: NOW - 11 * MINUTE,
      now: NOW,
      detail: 'Fire intelligence unavailable (503)',
    }),
    onRetry: () => retried++,
  });

  const details = container.children.find((node) => node.tagName === 'details');
  assert.ok(details, 'technical detail is rendered as a disclosure');
  assert.match(textOf(details), /503/);

  const headline = container.children[0];
  assert.equal(headline.textContent, 'DATA UNAVAILABLE');

  const retry = container.children.find(
    (node) => node.className === 'aegis-feed-state-retry',
  );
  retry.listeners.click();
  assert.equal(retried, 1);
  assert.equal(container.dataset.tone, 'alert');
});

test('a block with no detail renders no disclosure at all', () => {
  const doc = stubDocument();
  const container = doc.createElement('div');
  renderFeedState({
    document: doc,
    container,
    description: describeFeedState({
      state: FEED_STATES.NO_DATA,
      sourceLabel: 'NASA FIRMS',
      subjectPlural: 'fire detections',
      now: NOW,
    }),
  });
  assert.equal(
    container.children.filter((node) => node.tagName === 'details').length,
    0,
  );
});
