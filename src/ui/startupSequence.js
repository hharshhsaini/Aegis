import { createSpeaker, speechAvailable } from '../alerts/speech.js';

/**
 * The Aegis introduction.
 *
 * The first thing anyone sees, and the only chance the product has to say what
 * it is before it starts behaving like it. A spinner and the words "loading"
 * say "a web page is fetching something". This says "a system is coming
 * online", which is the honest description of what is actually happening
 * underneath — Cesium, three live feeds and the alert layer all starting at
 * once.
 *
 * Four things govern the design:
 *
 *  1. IT IS A PRESENTATION LAYER, NOT A GATE. The application bootstraps at
 *     full speed behind this overlay and was already doing so before it
 *     existed. Nothing here delays Cesium, the providers or the location flow,
 *     and there is no progress bar because there is no number to show that
 *     would not be invented.
 *  2. SPEECH DRIVES THE PACE. When the browser will speak, each line advances
 *     the visuals as it ENDS, so picture and voice cannot drift apart on a slow
 *     machine or a fast one. When it will not, the same sequence runs on a
 *     timer in a little over six seconds.
 *  3. NOTHING SHOWN HERE IS DATA. The signals that appear on the globe during
 *     the sequence are system graphics on fixed marks. Inventing plausible
 *     earthquakes for a title card would be the single cheapest way to teach
 *     somebody that this console's markers cannot be trusted.
 *  4. IT EARNS ITS LENGTH ONCE. Returning within the same session gets a short
 *     reconnect, not the full narration.
 */

/** Where the "has been introduced" mark lives. Session-scoped by design. */
export const INTRO_STORAGE_KEY = 'aegis.intro.seen.v1';

/** Overlay phases, in order. Each is a `data-phase` value the stylesheet draws. */
export const PHASES = Object.freeze([
  'darkness',
  'rule',
  'fragments',
  'forming',
  'scan',
  'settled',
  'subtitle',
  'online',
  'begin',
]);

/**
 * The narration, and what each line turns into on screen.
 *
 * The text is fixed and written down here rather than generated, because it is
 * brand copy and because a line that can vary is a line nobody has reviewed.
 *
 * On "the world's first": this is positioning, not a measured claim, and it is
 * the only sentence in the product that makes one. It is confined to the
 * introduction — no panel, briefing or alert repeats it — and Aegis never
 * attaches a statistic or an accolade to it.
 */
export const INTRO_LINES = Object.freeze([
  Object.freeze({
    id: 'welcome',
    // Lands as the letters finish aligning: the name is READABLE at the moment
    // it is spoken, rather than a beat before or after it.
    phase: 'settled',
    text: 'Welcome to Aegis.',
  }),
  Object.freeze({
    id: 'positioning',
    phase: 'subtitle',
    text: "The world's first real-time disaster intelligence platform.",
  }),
  Object.freeze({
    id: 'watch',
    phase: 'online',
    text: "I watch the world, so you don't have to.",
  }),
  Object.freeze({
    id: 'watching',
    phase: 'begin',
    text: 'The world is moving. Aegis is watching.',
  }),
  Object.freeze({ id: 'begin', phase: 'begin', text: "Let's begin." }),
]);

/**
 * Visual-only pacing, in milliseconds from the start.
 *
 * Used when the browser will not speak. The same phases in the same order, run
 * against the clock instead of against the voice, and deliberately brisk: with
 * no narration to listen to, an intro is only ever something in the way.
 */
export const SILENT_TIMELINE = Object.freeze([
  Object.freeze({ at: 0, phase: 'darkness' }),
  Object.freeze({ at: 400, phase: 'rule' }),
  Object.freeze({ at: 1000, phase: 'fragments' }),
  Object.freeze({ at: 1500, phase: 'forming' }),
  Object.freeze({ at: 2400, phase: 'scan' }),
  Object.freeze({ at: 2800, phase: 'settled' }),
  Object.freeze({ at: 3200, phase: 'subtitle' }),
  Object.freeze({ at: 3800, phase: 'online' }),
  Object.freeze({ at: 4400, phase: 'begin' }),
]);

/** How long the returning-user reconnect holds before handing over. */
export const SHORT_BOOT_MS = 1400;

/** How long the opening darkness and signal run before the first line. */
const OPENING_MS = Object.freeze({
  rule: 400,
  fragments: 1000,
  forming: 1500,
  scan: 2400,
  settled: 2800,
});

/**
 * Has this browser already been introduced?
 *
 * Session-scoped: a new tab is a new arrival and gets the full sequence, while
 * a reload during the same session does not. A storage that throws — private
 * browsing, blocked site data — is treated as "not seen", because showing the
 * introduction twice is a far smaller failure than a console that will not
 * start.
 *
 * @param {object} [storage] Session storage.
 * @returns {boolean} Whether the full introduction should play.
 */
export function shouldPlayFullIntro(storage = globalThis.sessionStorage) {
  try {
    return storage?.getItem(INTRO_STORAGE_KEY) !== 'true';
  } catch {
    return true;
  }
}

/**
 * Record that the introduction has played.
 * @param {object} [storage] Session storage.
 */
export function markIntroSeen(storage = globalThis.sessionStorage) {
  try {
    storage?.setItem(INTRO_STORAGE_KEY, 'true');
  } catch {
    // A mark that cannot persist means one more introduction, not a failure.
  }
}

/**
 * Subtle synthesised tones for the sequence.
 *
 * Synthesised rather than shipped as audio files: the whole cue set is a few
 * sine tones, and a megabyte of assets for that would be a poor trade on a
 * console that is already loading terrain. Every tone is quiet by construction
 * and the voice is always the loudest thing playing.
 *
 * @param {object} [AudioContextCtor] Constructor, for tests.
 * @returns {object} Tone controller.
 */
export function createIntroTones(
  AudioContextCtor = globalThis.AudioContext || globalThis.webkitAudioContext,
) {
  let context = null;
  if (AudioContextCtor) {
    try {
      context = new AudioContextCtor();
    } catch {
      context = null;
    }
  }

  return Object.freeze({
    /** @returns {boolean} Whether audio is currently permitted to play. */
    ready: () => context?.state === 'running',
    /** Ask the browser to start audio. Resolves whether or not it agreed. */
    async resume() {
      try {
        await context?.resume?.();
      } catch {
        // Autoplay policy said no. The sequence runs silently.
      }
      return context?.state === 'running';
    },
    /**
     * Play one tone.
     *
     * @param {object} input Input.
     * @param {number} input.frequency Hertz.
     * @param {number} [input.duration] Seconds.
     * @param {number} [input.gain] Peak gain, well under 1.
     */
    tone({ frequency, duration = 0.9, gain = 0.05 }) {
      if (context?.state !== 'running') return;
      try {
        const oscillator = context.createOscillator();
        const envelope = context.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.value = frequency;
        const now = context.currentTime;
        // Ramped in and out: an abrupt start or stop on a sine wave is an
        // audible click, which is the opposite of the intended effect.
        envelope.gain.setValueAtTime(0.0001, now);
        envelope.gain.exponentialRampToValueAtTime(gain, now + 0.12);
        envelope.gain.exponentialRampToValueAtTime(0.0001, now + duration);
        oscillator.connect(envelope).connect(context.destination);
        oscillator.start(now);
        oscillator.stop(now + duration + 0.05);
      } catch {
        // A tone that will not play is not worth failing a startup over.
      }
    },
    close() {
      try {
        void context?.close?.();
      } catch {
        // Already closed.
      }
    },
  });
}

/** The tone that belongs to each phase, where one does. */
const PHASE_TONES = Object.freeze({
  rule: { frequency: 220, duration: 1.2, gain: 0.035 },
  forming: { frequency: 440, duration: 1.1, gain: 0.045 },
  scan: { frequency: 660, duration: 0.7, gain: 0.03 },
  online: { frequency: 330, duration: 0.9, gain: 0.035 },
  begin: { frequency: 528, duration: 0.8, gain: 0.04 },
});

/**
 * Run the startup sequence.
 *
 * @param {object} input Input.
 * @param {HTMLElement} input.root The overlay element.
 * @param {Document} [input.document] Document.
 * @param {boolean} [input.full] Play the full narration rather than a reconnect.
 * @param {object} [input.speaker] Speech port.
 * @param {object} [input.tones] Tone controller.
 * @param {boolean} [input.reducedMotion] Honour a motion preference.
 * @returns {object} Controller with a `finished` promise.
 */
export function createStartupSequence({
  root,
  document: doc = globalThis.document,
  full = true,
  speaker = createSpeaker(),
  tones = createIntroTones(),
  // Availability travels with the speaker rather than being read from the
  // platform separately: a caller that supplies a voice is telling us there is
  // one, and the two must not be able to disagree.
  canSpeak = speechAvailable(),
  reducedMotion = Boolean(
    globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches,
  ),
} = {}) {
  let currentLine = 0;
  // Narration outlives the handover, so it tracks its own stop condition.
  // `settled` means "the overlay has lifted", which is no longer a reason to
  // stop talking.
  let narrationStopped = false;
  const narrationTimers = new Set();
  const laterNarration = (fn, ms) => {
    const id = setTimeout(fn, ms);
    narrationTimers.add(id);
    return id;
  };

  /** Stop the narration and silence anything mid-sentence. */
  function stopNarration() {
    narrationStopped = true;
    for (const id of narrationTimers) clearTimeout(id);
    narrationTimers.clear();
    try {
      globalThis.speechSynthesis?.cancel?.();
    } catch {
      // Nothing playing.
    }
  }

  let settled = false;
  let resolveFinished;
  const finished = new Promise((resolve) => {
    resolveFinished = resolve;
  });
  const timers = new Set();
  const later = (fn, ms) => {
    const id = setTimeout(fn, ms);
    timers.add(id);
    return id;
  };

  const skipButton = doc?.getElementById?.('aegis-intro-skip');
  const audioButton = doc?.getElementById?.('aegis-intro-audio');

  /** Move the overlay to a phase and play whatever belongs to it. */
  function setPhase(phase) {
    if (settled || !root) return;
    root.dataset.phase = phase;
    const tone = PHASE_TONES[phase];
    if (tone) tones.tone(tone);
  }

  /** End the sequence, however it ended. */
  function finish(reason = 'complete') {
    if (settled) return;
    settled = true;
    for (const id of timers) clearTimeout(id);
    timers.clear();
    // A skip or a teardown silences the voice: the user has asked to get on
    // with it. A NORMAL handover does not — the welcome finishes over the live
    // console, which is exactly where a welcome belongs.
    if (reason !== 'complete') stopNarration();
    markIntroSeen();
    if (root) {
      root.dataset.phase = 'done';
      root.classList.add('aegis-intro-over');
    }
    tones.close();
    resolveFinished(reason);
  }

  const onSkip = () => finish('skipped');
  skipButton?.addEventListener('click', onSkip);

  /** Let the user grant audio after an autoplay refusal. */
  const onEnableAudio = async () => {
    if (audioButton) audioButton.hidden = true;
    await tones.resume();
    // Speech is retried from wherever the visuals have reached, rather than
    // restarting the narration over a globe that has already formed.
    if (!narrationStopped && full) narrate(currentLine);
  };
  audioButton?.addEventListener('click', onEnableAudio);

  /**
   * Speak one line, moving to the next when it ends.
   *
   * Narration NEVER gates the reveal. It used to: the overlay waited on
   * `sequence.finished`, which waited on the last utterance, so a browser that
   * accepted `speak()` and then never fired `onend` — a backgrounded tab, a
   * blocked autoplay policy, a platform where the API exists but does nothing —
   * left the user looking at a black screen for thirty seconds. Worse, even
   * when speech worked perfectly the console was held back for fourteen.
   *
   * So this runs alongside the visuals and outlives them. If the voice is
   * still talking when the console arrives, it finishes over the live globe,
   * which is what a welcome should do anyway.
   */
  function narrate(index) {
    if (narrationStopped) return;
    currentLine = index;
    const line = INTRO_LINES[index];
    if (!line) return;
    speaker(line.text, {
      queue: true,
      // Brisk but unhurried. An introduction nobody sits through is worse than
      // no introduction.
      rate: 1.06,
      onEnd: () => {
        if (narrationStopped) return;
        // A beat between lines: the script is written with pauses in it and
        // reads as a list without them.
        laterNarration(() => narrate(index + 1), 140);
      },
    });
  }

  /** Run the phases against the clock, with no voice to follow. */
  function runSilent() {
    for (const mark of SILENT_TIMELINE)
      later(() => setPhase(mark.phase), reducedMotion ? mark.at / 2 : mark.at);
    const last = SILENT_TIMELINE[SILENT_TIMELINE.length - 1];
    later(
      () => finish('complete'),
      (reducedMotion ? last.at / 2 : last.at) + 600,
    );
  }

  /** The returning-user path: a reconnect, not an introduction. */
  function runShortBoot() {
    setPhase('reconnect');
    later(() => finish('complete'), reducedMotion ? 600 : SHORT_BOOT_MS);
  }

  async function begin() {
    if (!root) {
      finish('no-overlay');
      return;
    }
    setPhase('darkness');

    if (!full) {
      runShortBoot();
      return;
    }

    // The visuals start FIRST and are never gated on audio.
    //
    // This line used to read `const audioOn = await tones.resume();`, and that
    // await was a black screen in Chrome. An AudioContext constructed without
    // a user gesture starts suspended, and Chrome's `resume()` returns a
    // promise that does not settle until a gesture arrives — which, on a page
    // the user has only just opened, may be never. `begin()` stopped dead at
    // the await: no phases, no reveal, nothing on screen but the statically
    // rendered SKIP button over black.
    //
    // Audio is a decoration on this sequence. It must never be upstream of it.
    runSilent();

    // Audio is asked for in the background. Whatever it answers — or if it
    // never answers at all — the visuals above are already running.
    void (async () => {
      let audioOn = false;
      try {
        audioOn = await tones.resume();
      } catch {
        // A refusal is not a failure; the sequence simply runs silently.
      }
      if (settled) return;
      // Offered only when this browser could speak if asked. A browser with no
      // synthesiser is never given a button that would do nothing.
      if (!audioOn && canSpeak && audioButton) audioButton.hidden = false;
    })();

    // Narration rides alongside. It starts as the wordmark finishes settling,
    // so the first line lands on a readable AEGIS, and it is allowed to run
    // past the handover rather than holding it.
    // Reduced motion shortens the ANIMATION; it is not a request for silence.
    // Gating the narration on it denied the welcome to exactly the people most
    // likely to be relying on audio.
    if (canSpeak) laterNarration(() => narrate(0), OPENING_MS.settled);
  }

  void begin();

  return Object.freeze({
    finished,
    skip: onSkip,
    /** @returns {string} The current phase. */
    phase: () => root?.dataset.phase || 'darkness',
    destroy() {
      skipButton?.removeEventListener('click', onSkip);
      audioButton?.removeEventListener('click', onEnableAudio);
      finish('destroyed');
    },
  });
}
