import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rng, weighted } from '../src/prng.js';
import { ddmin, split } from '../src/ddmin.js';
import { mergeTicks } from '../src/sim.js';

test('same seed gives the same stream', () => {
  const a = rng(42), b = rng(42), c = rng(43);
  const xs = Array.from({ length: 5 }, a);
  assert.deepEqual(xs, Array.from({ length: 5 }, b));
  assert.notDeepEqual(xs, Array.from({ length: 5 }, c));
  assert.ok(xs.every((x) => x >= 0 && x < 1));
});

test('weighted choice respects weights', () => {
  const r = rng(1);
  const n = { a: 0, b: 0 };
  for (let i = 0; i < 10000; i++) n[weighted(r, [[9, 'a'], [1, 'b']])]++;
  assert.ok(n.a > 8500 && n.a < 9500, JSON.stringify(n));
});

test('split covers every element once', () => {
  const xs = [...Array(11).keys()];
  for (const n of [2, 3, 4, 11]) assert.deepEqual(split(xs, n).flat(), xs);
});

test('ddmin finds the two steps that matter', async () => {
  const steps = [...Array(40).keys()];
  const fails = async (s) => (s.includes(7) && s.includes(31) ? s : null);
  const { steps: min } = await ddmin(steps, fails);
  assert.deepEqual(min, [7, 31]);
});

test('ddmin result is 1-minimal for an order-dependent bug', async () => {
  const steps = [...Array(30).keys()];
  // fails if 3 comes before 20 and 25 is present
  const fails = async (s) => (s.includes(3) && s.includes(20) && s.includes(25) && s.indexOf(3) < s.indexOf(20) ? s : null);
  const { steps: min } = await ddmin(steps, fails);
  assert.deepEqual(min, [3, 20, 25]);
});

test('adjacent waits merge, others stay', () => {
  const s = [{ t: 'tick', ms: 5 }, { t: 'tick', ms: 10 }, { t: 'click', sel: '#a' }, { t: 'tick', ms: 1 }];
  assert.deepEqual(mergeTicks(s), [{ t: 'tick', ms: 15 }, { t: 'click', sel: '#a' }, { t: 'tick', ms: 1 }]);
});
