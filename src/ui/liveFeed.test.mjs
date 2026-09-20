import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MESSAGE_KINDS,
  createLiveFeed,
  formatClock,
  kindForAnnouncement,
} from './liveFeed.js';

/**
 * The transcript replaced two buttons that made the user ask whether anything
 * had happened. What it must never become is the thing it replaced: a surface
 * that needs prompting, that persists beyond the session it describes, or that
 * fills itself with activity when nothing has actually happened.
 */

function element(id = '') {
  const listeners = new Map();
  const node = {
    id,
    children: [],
    dataset: {},
    hidden: false,
    className: '',
    textContent: '',
    type: '',
    scrollTop: 0,
    scrollHeight: 1000,
    clientHeight: 200,
    listeners,
    append(...kids) {
      this.children.push(...kids);
    },
    replaceChildren(...kids) {
      this.children = [...kids];
    },
    addEventListener(type, fn) {
      listeners.set(type, fn);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
    setAttribute() {},
    scrollIntoView() {},
    fire(type) {
      listeners.get(type)?.();
    },
  };
  return node;
}

function fixture() {
  const nodes = {
    'aegis-live-list': element('aegis-live-list'),
    'aegis-live-scroll': element('aegis-live-scroll'),
    'aegis-live-jump': element('aegis-live-jump'),
    'aegis-live-state': element('aegis-live-state'),
  };
  const opened = [];
  const doc = {
    getElementById: (id) => nodes[id] || null,
    createElement: () => element(),
  };
  const feed = createLiveFeed({
    document: doc,
    onSelect: (id) => opened.push(id),
    now: () => Date.parse('2026-09-20T09:21:00Z'),
  });
  return { feed, nodes, opened };
}

/** Find a rendered node by class, depth first. */
function find(root, className) {
  for (const child of root.children || []) {
    if (String(child.className).split(' ').includes(className)) return child;
    const found = find(child, className);
    if (found) return found;
  }
  return null;
}

test('an announcement becomes the kind of message it actually is', () => {
  // The transcript must not call a model score an update, or an update a
  // warning — the same distinction the voice makes, made visible.
  assert.equal(
    kindForAnnouncement({ provenance: 'OFFICIAL' }),
    MESSAGE_KINDS.WARNING,
  );
  assert.equal(kindForAnnouncement({ provenance: 'MODEL' }), MESSAGE_KINDS.MODEL);
  assert.equal(
    kindForAnnouncement({ provenance: 'FORECAST' }),
    MESSAGE_KINDS.MODEL,
  );
  assert.equal(
    kindForAnnouncement({ provenance: 'OBSERVED' }),
    MESSAGE_KINDS.UPDATE,
  );
  assert.equal(kindForAnnouncement({}), MESSAGE_KINDS.UPDATE);
});

test('the transcript records what was said, in order', () => {
  const { feed, nodes } = fixture();
  feed.push({ kind: MESSAGE_KINDS.MONITORING, message: 'Monitoring Bengaluru.' });
  feed.push({
    kind: MESSAGE_KINDS.UPDATE,
    message: 'M5.1 earthquake detected.',
    incidentId: 'eq:1',
  });

  assert.equal(feed.messages().length, 2);
  assert.equal(nodes['aegis-live-list'].children.length, 2);
  assert.equal(feed.messages()[1].incidentId, 'eq:1');
});

test('a message about a real incident opens it; a statement does not pretend to', () => {
  const { feed, nodes, opened } = fixture();
  feed.push({ kind: MESSAGE_KINDS.MONITORING, message: 'Monitoring.' });
  feed.push({
    kind: MESSAGE_KINDS.UPDATE,
    message: 'M5.1 earthquake detected.',
    incidentId: 'eq:1',
  });

  const [statement, update] = nodes['aegis-live-list'].children;
  assert.equal(
    find(statement, 'aegis-live-action'),
    null,
    'a monitoring note is not a door to anywhere',
  );

  const action = find(update, 'aegis-live-action');
  assert.ok(action, 'an incident message is a way into the incident');
  action.fire('click');
  assert.deepEqual(opened, ['eq:1']);
});

test('a model message offers analysis rather than an incident', () => {
  const { feed, nodes } = fixture();
  feed.push({
    kind: MESSAGE_KINDS.MODEL,
    message: 'Flood risk elevated.',
    incidentId: 'wx:flood',
    actionLabel: 'VIEW ANALYSIS',
  });
  const action = find(nodes['aegis-live-list'].children[0], 'aegis-live-action');
  assert.equal(action.textContent, 'VIEW ANALYSIS');
});

test('the line being spoken is the line that is highlighted', () => {
  const { feed, nodes } = fixture();
  const first = feed.push({ kind: MESSAGE_KINDS.UPDATE, message: 'one' });
  const second = feed.push({ kind: MESSAGE_KINDS.UPDATE, message: 'two' });

  feed.setSpeaking(second.id);
  const rendered = nodes['aegis-live-list'].children;
  assert.equal(rendered[1].dataset.speaking, 'true');
  assert.equal(rendered[0].dataset.speaking, undefined);

  feed.setSpeaking(first.id);
  assert.equal(rendered[0].dataset.speaking, 'true');
  assert.equal(rendered[1].dataset.speaking, undefined);

  feed.setSpeaking(null);
  assert.equal(rendered[0].dataset.speaking, undefined);
});

test('a reader scrolled into history is not yanked to the newest line', () => {
  const { feed, nodes } = fixture();
  const scroll = nodes['aegis-live-scroll'];

  feed.push({ kind: MESSAGE_KINDS.UPDATE, message: 'one' });

  // Scroll well away from the bottom, as somebody reading back would.
  scroll.scrollTop = 0;
  scroll.fire('scroll');
  assert.equal(nodes['aegis-live-jump'].hidden, false, 'the pill offers the way back');

  feed.push({ kind: MESSAGE_KINDS.UPDATE, message: 'two' });
  assert.equal(scroll.scrollTop, 0, 'their position is left alone');

  // Taking the offer returns them to the newest line.
  nodes['aegis-live-jump'].fire('click');
  assert.equal(scroll.scrollTop, scroll.scrollHeight);
  assert.equal(nodes['aegis-live-jump'].hidden, true);
});

test('a reader at the bottom keeps following', () => {
  const { feed, nodes } = fixture();
  const scroll = nodes['aegis-live-scroll'];
  scroll.scrollTop = scroll.scrollHeight - scroll.clientHeight;
  scroll.fire('scroll');

  feed.push({ kind: MESSAGE_KINDS.UPDATE, message: 'new' });
  assert.equal(scroll.scrollTop, scroll.scrollHeight);
  assert.equal(nodes['aegis-live-jump'].hidden, true);
});

test('the voice state is reported in words, not only as a colour', () => {
  const { feed, nodes } = fixture();
  feed.setState('SPEAKING');
  assert.equal(nodes['aegis-live-state'].textContent, 'AEGIS SPEAKING');
  assert.equal(nodes['aegis-live-state'].dataset.state, 'SPEAKING');

  feed.setState('MUTED');
  assert.equal(nodes['aegis-live-state'].textContent, 'AEGIS MUTED');
});

test('clicking a marker finds the message about that incident', () => {
  const { feed, nodes } = fixture();
  feed.push({ kind: MESSAGE_KINDS.UPDATE, message: 'one', incidentId: 'eq:1' });
  feed.push({ kind: MESSAGE_KINDS.UPDATE, message: 'two', incidentId: 'fire:2' });

  assert.equal(feed.highlightIncident('fire:2'), true);
  assert.equal(nodes['aegis-live-list'].children[1].dataset.highlighted, 'true');
  assert.equal(nodes['aegis-live-list'].children[0].dataset.highlighted, undefined);

  // An incident the transcript never mentioned is not invented a message.
  assert.equal(feed.highlightIncident('eq:never'), false);
});

test('the transcript dies with the session', () => {
  const { feed } = fixture();
  feed.push({ kind: MESSAGE_KINDS.UPDATE, message: 'one' });
  feed.destroy();
  // Nothing was written anywhere it could outlive the tab; teardown simply
  // empties it. A persisted transcript would answer a different question than
  // "what has Aegis told me while I have been watching".
  assert.deepEqual(feed.messages(), []);
});

test('clock times read as a transcript, not as a log', () => {
  const noon = Date.parse('2026-09-20T09:05:00Z');
  assert.match(formatClock(noon), /^\d{2}:\d{2}$/);
});
