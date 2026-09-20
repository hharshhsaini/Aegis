import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFireOverlay,
  detectionColor,
  clusterRadiusM,
  DETAIL_ALTITUDE_M,
  MAX_LABELLED_CLUSTERS,
} from './fireOverlay.js';

/**
 * The overlay's job is to stay legible over a fire season and to keep hold of
 * what the operator selected while the data underneath it changes.
 */

function stubViewer({ height = 300_000 } = {}) {
  const added = [];
  const points = [];
  return {
    added,
    points,
    camera: { positionCartographic: { height } },
    scene: {
      requestRender() {},
      primitives: {
        add: (collection) => collection,
        remove: () => true,
      },
    },
    entities: {
      add(entity) {
        added.push(entity);
        return entity;
      },
      remove(entity) {
        const index = added.indexOf(entity);
        if (index >= 0) added.splice(index, 1);
      },
    },
  };
}

function cluster(id, latitude, longitude, detectionCount, extra = {}) {
  return {
    id,
    kind: detectionCount >= 3 ? 'CLUSTER' : 'DETECTIONS',
    detectionCount,
    center: { latitude, longitude },
    peakFrp: 45,
    detections: [],
    ...extra,
  };
}

test('a selected cluster survives a refresh that renames it', () => {
  const viewer = stubViewer();
  const overlay = createFireOverlay({ viewer });
  const before = cluster('fc:-30.607,148.041:8', -30.607, 148.041, 8);
  overlay.show({ clusters: [before] }, []);
  overlay.select(before.id);
  assert.equal(overlay.getSelected().id, before.id);

  // The next observation finds two more pixels, so the id changes.
  const after = cluster('fc:-30.610,148.044:10', -30.61, 148.044, 10);
  overlay.show({ clusters: [after] }, []);
  assert.equal(
    overlay.getSelected()?.id,
    after.id,
    'the selection follows the cluster rather than vanishing',
  );
  assert.equal(overlay.getSelected().detectionCount, 10);
});

test('a selection is dropped when its cluster is genuinely gone', () => {
  const viewer = stubViewer();
  const overlay = createFireOverlay({ viewer });
  const before = cluster('fc:-30.607,148.041:8', -30.607, 148.041, 8);
  overlay.show({ clusters: [before] }, []);
  overlay.select(before.id);

  const elsewhere = cluster('fc:10.0,20.0:6', 10, 20, 6);
  overlay.show({ clusters: [elsewhere] }, []);
  assert.equal(overlay.getSelected(), null);
});

test('only the largest clusters are labelled', () => {
  const viewer = stubViewer();
  const overlay = createFireOverlay({ viewer });
  const many = Array.from({ length: 12 }, (_, index) =>
    cluster(`fc:${index}`, index, index, 20 - index),
  );
  overlay.show({ clusters: many }, []);
  const labelled = viewer.added.filter((entity) => entity.label);
  assert.equal(labelled.length, MAX_LABELLED_CLUSTERS);
  // Every cluster still draws a ring; only the labels are rationed.
  assert.equal(viewer.added.filter((entity) => entity.ellipse).length, 12);
});

test('loose detections draw a ring but never a cluster label', () => {
  const viewer = stubViewer();
  const overlay = createFireOverlay({ viewer });
  overlay.show({ clusters: [cluster('fc:single', 1, 1, 1)] }, []);
  const [entity] = viewer.added;
  assert.ok(entity.ellipse);
  assert.equal(entity.label, undefined);
});

test('detection colour and ring size scale with what was observed', () => {
  assert.notEqual(detectionColor(5), detectionColor(600));
  assert.equal(detectionColor(null), detectionColor(0));
  const small = clusterRadiusM({ detectionCount: 4 });
  const large = clusterRadiusM({ detectionCount: 400 });
  assert.ok(large > small);
  assert.ok(large <= 60_000, 'a ring never swallows a continent');
  assert.ok(DETAIL_ALTITUDE_M > 0);
});

test('level of detail follows the camera height', () => {
  const close = createFireOverlay({ viewer: stubViewer({ height: 100_000 }) });
  const far = createFireOverlay({
    viewer: stubViewer({ height: DETAIL_ALTITUDE_M + 1 }),
  });
  assert.equal(close.isDetailVisible(), true);
  assert.equal(far.isDetailVisible(), false);
});

test('clearing removes everything the overlay drew', () => {
  const viewer = stubViewer();
  const overlay = createFireOverlay({ viewer });
  overlay.show({ clusters: [cluster('fc:a', 1, 1, 9)] }, []);
  assert.ok(viewer.added.length > 0);
  overlay.clear();
  assert.equal(viewer.added.length, 0);
  assert.equal(overlay.getSelected(), null);
  assert.throws(() => createFireOverlay({}), /viewer/);
});
