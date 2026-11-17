// Measures the demo: for every variant, how many seeds hit each bug, whether a
// seed replays to exactly the same run, and how fast it goes.
// Writes docs/results.json.
import fs from 'node:fs';
import { openUI } from '../src/node.mjs';

const RUNS = Number(process.argv[2] || 1000);
const ui = await openUI('demo/pantry');
const results = { runsPerVariant: RUNS, stepsPerRun: 150, variants: {} };

for (const variant of ['buggy', 'naive', 'fixed']) {
  const r = await ui.page.evaluate(async (variant, RUNS) => {
    const sim = window.racehound.sim;
    const hits = {};
    let steps = 0, virtualMs = 0;
    const t0 = performance.now();
    for (let seed = 1; seed <= RUNS; seed++) {
      const res = await sim.run({ seed, variant, maxSteps: 150 });
      steps += res.steps.length;
      virtualMs += res.virtualMs;
      if (res.failure) {
        const h = (hits[res.failure.name] ??= { runs: 0, firstSeed: seed });
        h.runs++;
      }
    }
    const ms = performance.now() - t0;
    // Determinism: rerun the first 50 seeds and compare everything.
    let same = 0;
    for (let seed = 1; seed <= 50; seed++) {
      const a = await sim.run({ seed, variant, maxSteps: 150 });
      const b = await sim.run({ seed, variant, maxSteps: 150 });
      if (JSON.stringify([a.steps, a.failure, a.virtualMs]) === JSON.stringify([b.steps, b.failure, b.virtualMs])) same++;
    }
    return { hits, steps, virtualMs, ms, runsPerSec: RUNS / (ms / 1000), deterministic: `${same}/50` };
  }, variant, RUNS);
  results.variants[variant] = r;
  console.log(variant, JSON.stringify(r));
}
await ui.close();
fs.writeFileSync('docs/results.json', JSON.stringify(results, null, 2) + '\n');
