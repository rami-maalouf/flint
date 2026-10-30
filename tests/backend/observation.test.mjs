import assert from 'node:assert/strict';
import { test } from 'node:test';
import { observeRevisions } from '../../src/platform/backend/observation.ts';

test('reconciles changes during subscription setup and ignores duplicate snapshots', () => {
  let listener;
  let data;
  let calls = 0;
  let current = true;
  let closed = false;
  const stop = observeRevisions({
    getSnapshot: () => ({ data }),
    subscribe: receive => { listener = receive; return () => { listener = undefined; }; },
    close: () => { closed = true; },
  }, () => current, () => { calls++; });
  data = { revision: 3 }; listener();
  assert.equal(calls, 1);
  listener(); assert.equal(calls, 1);
  data = { revision: 4 }; listener(); assert.equal(calls, 2);
  current = false;
  data = { revision: 5 }; listener(); assert.equal(calls, 2);
  stop(); assert.ok(closed); assert.equal(listener, undefined);
});
