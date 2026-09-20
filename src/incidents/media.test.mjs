import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMediaService,
  createRegionalNewsProvider,
  normalizeMediaItem,
  youtubeQuery,
} from './media.js';
import { createIncident } from './model.js';

const NOW = Date.parse('2026-09-19T12:00:00Z');

const incident = createIncident({
  id: 'eq:1',
  kind: 'EARTHQUAKE',
  title: 'M5.2 earthquake',
  place: 'Kathmandu',
  location: { latitude: 27.7, longitude: 85.3 },
  source: 'USGS',
});

test('a search query is built from what the incident already knows', () => {
  assert.equal(youtubeQuery(incident), 'Kathmandu earthquake');
  assert.equal(
    youtubeQuery(
      createIncident({
        id: 'f',
        kind: 'FIRE',
        title: 'x',
        place: 'Karnataka',
        source: 'NASA FIRMS',
      }),
    ),
    'Karnataka fire',
  );
  assert.equal(youtubeQuery(null), '');
});

test('an item without a title or a link is not usable', () => {
  assert.equal(normalizeMediaItem({ title: 'x' }, 'src'), null);
  assert.equal(normalizeMediaItem({ url: 'https://x' }, 'src'), null);
});

test('every item is marked unverified, whatever the source says', () => {
  // Published material near an incident is not a confirmed observation of it.
  const item = normalizeMediaItem(
    {
      title: 'A report',
      url: 'https://example.test/a',
      publishedAt: '2026-09-19T10:00:00Z',
    },
    'Google News RSS',
  );
  assert.equal(item.verified, false);
  assert.equal(item.source, 'Google News RSS');
  assert.equal(item.publishedAt, Date.parse('2026-09-19T10:00:00Z'));
});

test('the regional provider asks about the incident’s own coordinates', async () => {
  const asked = [];
  const provider = createRegionalNewsProvider({
    fetchBrief: async (latitude, longitude) => {
      asked.push([latitude, longitude]);
      return {
        newsSource: 'Google News RSS',
        articles: [{ title: 'Report', url: 'https://example.test/1' }],
      };
    },
  });
  const items = await provider.search(incident);
  assert.deepEqual(asked, [[27.7, 85.3]]);
  assert.equal(items.length, 1);
  assert.equal(items[0].channel, 'Google News RSS');
});

test('an incident with no location asks nothing', async () => {
  let called = 0;
  const provider = createRegionalNewsProvider({
    fetchBrief: async () => {
      called += 1;
      return { articles: [] };
    },
  });
  const items = await provider.search(
    createIncident({ id: 'x', kind: 'FIRE', title: 'x', source: 'NASA FIRMS' }),
  );
  assert.deepEqual(items, []);
  assert.equal(called, 0);
});

test('no provider answering is UNAVAILABLE; answering with nothing is NO_DATA', async () => {
  const silent = createMediaService({
    providers: [
      {
        id: 'broken',
        label: 'Broken',
        search: async () => {
          throw new Error('down');
        },
      },
    ],
    now: () => NOW,
  });
  assert.equal((await silent.find(incident)).status, 'UNAVAILABLE');

  const empty = createMediaService({
    providers: [{ id: 'quiet', label: 'Quiet', search: async () => [] }],
    now: () => NOW,
  });
  assert.equal((await empty.find(incident)).status, 'NO_DATA');
});

test('one failing provider does not lose another’s results', async () => {
  const service = createMediaService({
    providers: [
      {
        id: 'broken',
        label: 'Broken',
        search: async () => {
          throw new Error('down');
        },
      },
      {
        id: 'ok',
        label: 'OK',
        search: async () => [
          normalizeMediaItem(
            { title: 'A', url: 'https://example.test/a' },
            'OK',
          ),
        ],
      },
    ],
    now: () => NOW,
  });
  const result = await service.find(incident);
  assert.equal(result.status, 'READY');
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.sources, ['OK']);
});

test('items are newest first and capped', async () => {
  const service = createMediaService({
    providers: [
      {
        id: 'many',
        label: 'Many',
        search: async () =>
          Array.from({ length: 12 }, (_, index) =>
            normalizeMediaItem(
              {
                title: `Item ${index}`,
                url: `https://example.test/${index}`,
                publishedAt: new Date(NOW - index * 60_000).toISOString(),
              },
              'Many',
            ),
          ),
      },
    ],
    now: () => NOW,
  });
  const { items } = await service.find(incident);
  assert.equal(items.length, 6);
  assert.equal(items[0].title, 'Item 0');
});

test('an answer is reused rather than asked for again', async () => {
  let calls = 0;
  const service = createMediaService({
    providers: [
      {
        id: 'counted',
        label: 'Counted',
        search: async () => {
          calls += 1;
          return [];
        },
      },
    ],
    now: () => NOW,
  });
  await service.find(incident);
  await service.find(incident);
  assert.equal(calls, 1);
});
