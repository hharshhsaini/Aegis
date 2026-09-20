import test from 'node:test';
import assert from 'node:assert/strict';
import { VOICE_STATES, createVoiceQueue } from './voiceQueue.js';

/**
 * The queue exists because the synthesiser's default is to CANCEL. These tests
 * hold the consequences of that: lines are read in turn, an urgent one does not
 * wait its turn, and muting silences the voice without stopping anything else.
 */

/** A speaker whose utterances are ended by hand. */
function manualSpeaker() {
  const said = [];
  let finish = null;
  return {
    said,
    speak(text, { onEnd } = {}) {
      said.push(text);
      finish = onEnd;
    },
    end() {
      const fn = finish;
      finish = null;
      fn?.();
    },
  };
}

test('lines are read one at a time, not over each other', () => {
  const speaker = manualSpeaker();
  const queue = createVoiceQueue({ speaker: speaker.speak.bind(speaker) });

  queue.enqueue({ text: 'first', id: 'a' });
  queue.enqueue({ text: 'second', id: 'b' });

  // The second must not have started: that is exactly the truncation the
  // queue exists to prevent.
  assert.deepEqual(speaker.said, ['first']);
  assert.equal(queue.state(), VOICE_STATES.SPEAKING);
  assert.equal(queue.size(), 1);

  speaker.end();
  assert.deepEqual(speaker.said, ['first', 'second']);

  speaker.end();
  assert.equal(queue.state(), VOICE_STATES.MONITORING);
  assert.equal(queue.size(), 0);
});

test('an urgent line jumps the waiting queue but never cuts one off', () => {
  const speaker = manualSpeaker();
  const queue = createVoiceQueue({ speaker: speaker.speak.bind(speaker) });

  queue.enqueue({ text: 'routine one', id: 'a' });
  queue.enqueue({ text: 'routine two', id: 'b' });
  queue.enqueue({ text: 'official warning', id: 'c', level: 'URGENT' });

  // Still reading the first: half of two sentences is worse than the second
  // half of one.
  assert.deepEqual(speaker.said, ['routine one']);

  speaker.end();
  assert.deepEqual(speaker.said, ['routine one', 'official warning']);

  speaker.end();
  assert.deepEqual(speaker.said, [
    'routine one',
    'official warning',
    'routine two',
  ]);
});

test('muting silences the voice and drops the backlog', () => {
  const speaker = manualSpeaker();
  const queue = createVoiceQueue({ speaker: speaker.speak.bind(speaker) });

  queue.enqueue({ text: 'first', id: 'a' });
  queue.enqueue({ text: 'queued', id: 'b' });
  queue.setMuted(true);

  assert.equal(queue.state(), VOICE_STATES.MUTED);
  assert.equal(queue.size(), 0, 'the backlog is dropped, not held');

  // Unmuting must not deliver what was muted: old news announced late is
  // worse than not announced at all.
  queue.setMuted(false);
  assert.deepEqual(speaker.said, ['first']);
  assert.equal(queue.state(), VOICE_STATES.MONITORING);
});

test('a muted queue accepts nothing, so nothing can leak out later', () => {
  const speaker = manualSpeaker();
  const queue = createVoiceQueue({
    speaker: speaker.speak.bind(speaker),
    muted: true,
  });

  assert.equal(queue.enqueue({ text: 'ignored', id: 'a' }), false);
  assert.deepEqual(speaker.said, []);

  queue.setMuted(false);
  assert.deepEqual(speaker.said, [], 'unmuting replays nothing');
});

test('subscribers learn which message is being read, for the highlight', () => {
  const speaker = manualSpeaker();
  const queue = createVoiceQueue({ speaker: speaker.speak.bind(speaker) });
  const seen = [];
  queue.subscribe((state) => seen.push(`${state.state}:${state.speakingId}`));

  queue.enqueue({ text: 'hello', id: 'msg:7' });
  assert.ok(seen.includes('SPEAKING:msg:7'), seen.join(' | '));

  speaker.end();
  assert.equal(seen.at(-1), 'MONITORING:null');
});

test('a speaker that never finishes cannot be mistaken for an idle voice', () => {
  const speaker = manualSpeaker();
  const queue = createVoiceQueue({ speaker: speaker.speak.bind(speaker) });
  queue.enqueue({ text: 'stalled', id: 'a' });
  assert.equal(queue.state(), VOICE_STATES.SPEAKING);
  // Destroy is the escape hatch, and it must leave nothing behind.
  queue.destroy();
  assert.equal(queue.size(), 0);
});

test('an empty line is not worth a turn', () => {
  const speaker = manualSpeaker();
  const queue = createVoiceQueue({ speaker: speaker.speak.bind(speaker) });
  assert.equal(queue.enqueue({ text: '', id: 'a' }), false);
  assert.equal(queue.enqueue({}), false);
  assert.deepEqual(speaker.said, []);
});
