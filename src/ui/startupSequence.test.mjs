import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INTRO_LINES,
  INTRO_STORAGE_KEY,
  PHASES,
  SILENT_TIMELINE,
  createIntroTones,
  createStartupSequence,
  markIntroSeen,
  shouldPlayFullIntro,
} from './startupSequence.js';

/**
 * The introduction is the one part of Aegis that plays before a user has asked
 * for anything, so what it must never do matters more than what it shows:
 * never block the console, never trap somebody who wants to skip it, never
 * hold the screen because audio was refused, and never claim to be data.
 */

/** A minimal element stand-in. */
function element(id = '') {
  const listeners = new Map();
  return {
    id,
    dataset: {},
    hidden: false,
    classList: {
      classes: new Set(),
      add(value) {
        this.classes.add(value);
      },
      contains(value) {
        return this.classes.has(value);
      },
    },
    addEventListener(type, fn) {
      listeners.set(type, fn);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
    fire(type) {
      listeners.get(type)?.();
    },
    listenerCount: () => listeners.size,
  };
}

function fixture({ speaks = true, audio = true } = {}) {
  const root = element('loading-screen');
  const skip = element('aegis-intro-skip');
  const audioButton = element('aegis-intro-audio');
  const nodes = { 'aegis-intro-skip': skip, 'aegis-intro-audio': audioButton };
  const spoken = [];
  const played = [];

  const speaker = (text, { onEnd } = {}) => {
    spoken.push(text);
    if (!speaks) return;
    // Synchronous end, so a test can drive the whole narration deterministically.
    onEnd?.();
  };

  const tones = {
    ready: () => audio,
    resume: async () => audio,
    tone: (options) => played.push(options.frequency),
    close: () => played.push('closed'),
  };

  return {
    root,
    skip,
    audioButton,
    spoken,
    played,
    doc: { getElementById: (id) => nodes[id] || null },
    speaker,
    tones,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('the phase list and the narration agree on what exists', () => {
  // A line whose phase the stylesheet does not draw would simply not animate,
  // which is the kind of failure nobody notices until a demo.
  for (const line of INTRO_LINES)
    assert.ok(PHASES.includes(line.phase), `unknown phase ${line.phase}`);
  for (const mark of SILENT_TIMELINE)
    assert.ok(PHASES.includes(mark.phase), `unknown phase ${mark.phase}`);
});

test('the silent sequence lands inside the target window', () => {
  // With no narration to listen to, an introduction is only ever something in
  // the way. The whole visual run reaches its last beat inside the four-to-six
  // second target, and is still slow enough that the wordmark can be read.
  const last = SILENT_TIMELINE[SILENT_TIMELINE.length - 1];
  assert.ok(last.at >= 3_500, `too quick to read: ${last.at}ms`);
  assert.ok(last.at <= 6_000, `too slow: ${last.at}ms`);
});

test('the beats run in order and none of them collide', () => {
  // The word assembles on a fixed schedule; two beats sharing a timestamp
  // would mean one of them never being seen.
  const times = SILENT_TIMELINE.map((mark) => mark.at);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  assert.equal(new Set(times).size, times.length);
});

test('the narration says nothing that pretends to be a measurement', () => {
  const script = INTRO_LINES.map((line) => line.text).join(' ');
  // Positioning is allowed; statistics and accolades are not, because nothing
  // in this product can substantiate one.
  for (const forbidden of [
    /\d+\s*%/,
    /\bmillions?\b/i,
    /\baward\b/i,
    /\btrusted by\b/i,
    /\bmost accurate\b/i,
  ])
    assert.ok(!forbidden.test(script), `${forbidden} appeared in the script`);
});

test('a full run narrates every line and ends', async () => {
  const f = fixture();
  const sequence = createStartupSequence({
    root: f.root,
    document: f.doc,
    full: true,
    speaker: f.speaker,
    tones: f.tones,
    canSpeak: true,
  });

  const reason = await sequence.finished;
  assert.equal(reason, 'complete');
  assert.deepEqual(
    f.spoken,
    INTRO_LINES.map((line) => line.text),
  );
  assert.equal(f.root.dataset.phase, 'done');
});

test('skipping ends the sequence at once', async () => {
  const f = fixture();
  const sequence = createStartupSequence({
    root: f.root,
    document: f.doc,
    full: true,
    speaker: () => {
      // Never calls onEnd: a narration that has stalled must still be skippable.
    },
    tones: f.tones,
    canSpeak: true,
  });

  f.skip.fire('click');
  assert.equal(await sequence.finished, 'skipped');
  assert.equal(f.root.dataset.phase, 'done');
});

test('a browser that will not speak still reaches the console', async () => {
  const f = fixture();
  const sequence = createStartupSequence({
    root: f.root,
    document: f.doc,
    full: true,
    // No speech at all, and reduced motion to keep the test quick.
    speaker: undefined,
    canSpeak: false,
    tones: { ...f.tones, resume: async () => false },
    reducedMotion: true,
  });

  assert.equal(await sequence.finished, 'complete');
  assert.equal(f.root.dataset.phase, 'done');
});

test('a refused autoplay offers audio rather than failing or stalling', async () => {
  const f = fixture({ audio: false });
  const sequence = createStartupSequence({
    root: f.root,
    document: f.doc,
    full: true,
    speaker: f.speaker,
    tones: { ...f.tones, ready: () => false, resume: async () => false },
    canSpeak: true,
  });

  await flush();
  assert.equal(
    f.audioButton.hidden,
    false,
    'the offer appears only when the browser could speak if asked',
  );
  assert.equal(await sequence.finished, 'complete');
});

test('a returning visitor gets a reconnect, not the full narration', async () => {
  const f = fixture();
  const sequence = createStartupSequence({
    root: f.root,
    document: f.doc,
    full: false,
    speaker: f.speaker,
    tones: f.tones,
    reducedMotion: true,
  });

  assert.equal(await sequence.finished, 'complete');
  assert.deepEqual(f.spoken, [], 'nothing is read out on a reconnect');
});

test('a missing overlay resolves rather than hanging the bootstrap', async () => {
  const sequence = createStartupSequence({
    root: null,
    document: { getElementById: () => null },
  });
  assert.equal(await sequence.finished, 'no-overlay');
});

test('the seen mark is session scoped and survives a hostile storage', () => {
  const store = new Map();
  const storage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
  };
  assert.equal(shouldPlayFullIntro(storage), true);
  markIntroSeen(storage);
  assert.equal(store.get(INTRO_STORAGE_KEY), 'true');
  assert.equal(shouldPlayFullIntro(storage), false);

  // Private browsing throws on access. That must mean "introduce again", not
  // "fail to start".
  const blocked = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
  };
  assert.equal(shouldPlayFullIntro(blocked), true);
  assert.doesNotThrow(() => markIntroSeen(blocked));
});

test('tones degrade to silence when the platform has no audio', async () => {
  const tones = createIntroTones(undefined);
  assert.equal(tones.ready(), false);
  assert.equal(await tones.resume(), false);
  assert.doesNotThrow(() => tones.tone({ frequency: 440 }));
  assert.doesNotThrow(() => tones.close());
});

test('destroy releases the controls it bound', async () => {
  const f = fixture();
  const sequence = createStartupSequence({
    root: f.root,
    document: f.doc,
    full: true,
    speaker: () => {},
    tones: f.tones,
    canSpeak: true,
  });
  sequence.destroy();
  assert.equal(await sequence.finished, 'destroyed');
  assert.equal(f.skip.listenerCount(), 0);
  assert.equal(f.audioButton.listenerCount(), 0);
});

test('a synthesiser that never finishes cannot hold the console back', async () => {
  // The black-screen bug. The reveal used to wait on `sequence.finished`,
  // which waited on the last utterance ending. A browser that accepts speak()
  // and then never fires onend — a backgrounded tab, a blocked autoplay
  // policy, a platform where the API exists but does nothing — left the user
  // looking at black. The visuals are the gate now; the voice is not.
  const f = fixture();
  const sequence = createStartupSequence({
    root: f.root,
    document: f.doc,
    full: true,
    // Accepts every line and never reports one finishing.
    speaker: () => {},
    canSpeak: true,
    tones: f.tones,
    reducedMotion: true,
  });

  assert.equal(await sequence.finished, 'complete');
  assert.equal(f.root.dataset.phase, 'done');
});

test('the welcome finishes over the live console rather than being cut off', async () => {
  const spoken = [];
  let advance = null;
  const f = fixture();
  const sequence = createStartupSequence({
    root: f.root,
    document: f.doc,
    full: true,
    speaker: (text, { onEnd } = {}) => {
      spoken.push(text);
      advance = onEnd;
    },
    canSpeak: true,
    tones: f.tones,
    reducedMotion: true,
  });

  await sequence.finished;
  const spokenAtHandover = spoken.length;

  // The overlay has lifted. The narration is mid-sentence and must carry on:
  // a welcome belongs over the globe, not behind a title card.
  advance?.();
  await new Promise((resolve) => setTimeout(resolve, 260));
  assert.ok(
    spoken.length > spokenAtHandover,
    `narration stopped at handover (${spoken.length} lines)`,
  );
});

test('skipping still silences the voice', async () => {
  const spoken = [];
  let advance = null;
  const f = fixture();
  const sequence = createStartupSequence({
    root: f.root,
    document: f.doc,
    full: true,
    speaker: (text, { onEnd } = {}) => {
      spoken.push(text);
      advance = onEnd;
    },
    canSpeak: true,
    tones: f.tones,
    reducedMotion: true,
  });

  f.skip.fire('click');
  assert.equal(await sequence.finished, 'skipped');

  // A skip is the user asking to get on with it, so the queue stops there.
  const atSkip = spoken.length;
  advance?.();
  await new Promise((resolve) => setTimeout(resolve, 260));
  assert.equal(spoken.length, atSkip, 'a skipped intro kept talking');
});

test('an audio resume that never settles cannot hold the screen black', async () => {
  // The Chrome black screen, exactly. An AudioContext built without a user
  // gesture starts suspended, and Chrome's resume() returns a promise that
  // does not settle until a gesture arrives — which on a freshly opened page
  // may be never. Awaiting it stopped the sequence dead on its first phase:
  // no visuals, no reveal, just the static SKIP button over black.
  const f = fixture();
  const sequence = createStartupSequence({
    root: f.root,
    document: f.doc,
    full: true,
    speaker: f.speaker,
    canSpeak: true,
    tones: {
      ...f.tones,
      // Never resolves. Ever.
      resume: () => new Promise(() => {}),
    },
    reducedMotion: true,
  });

  assert.equal(await sequence.finished, 'complete');
  assert.equal(f.root.dataset.phase, 'done');
});

test('an audio resume that rejects is not a failure either', async () => {
  const f = fixture();
  const sequence = createStartupSequence({
    root: f.root,
    document: f.doc,
    full: true,
    speaker: f.speaker,
    canSpeak: true,
    tones: {
      ...f.tones,
      resume: () => Promise.reject(new Error('NotAllowedError')),
    },
    reducedMotion: true,
  });

  assert.equal(await sequence.finished, 'complete');
  assert.equal(f.root.dataset.phase, 'done');
});

test('the visuals reach the wordmark without audio ever answering', async () => {
  // Not just "it finishes" — it must actually PLAY. A sequence that jumped
  // straight to done would pass the tests above and still show nothing.
  const f = fixture();
  const seen = [];
  const root = f.root;
  const originalDataset = root.dataset;
  root.dataset = new Proxy(originalDataset, {
    set(target, key, value) {
      if (key === 'phase') seen.push(value);
      target[key] = value;
      return true;
    },
  });

  const sequence = createStartupSequence({
    root,
    document: f.doc,
    full: true,
    speaker: f.speaker,
    canSpeak: true,
    tones: { ...f.tones, resume: () => new Promise(() => {}) },
    reducedMotion: true,
  });

  await sequence.finished;
  for (const phase of ['rule', 'fragments', 'forming', 'settled'])
    assert.ok(seen.includes(phase), `never reached ${phase}: ${seen.join(' → ')}`);
});
