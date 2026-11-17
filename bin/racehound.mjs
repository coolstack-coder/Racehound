#!/usr/bin/env node
// racehound CLI
//
//   racehound serve                         open the UI on http://localhost:4177
//   racehound hunt <app-dir> [options]      hunt in headless Chrome, exit 1 on a bug
//   racehound replay <repro.json>           replay a saved bug, exit 1 if it still fails
//
// Options for hunt:
//   --variant <name>   which variant from racehound.config.js
//   --runs <n>         number of seeds (default 300)
//   --seed <n>         first seed (default 1)
//   --steps <n>        steps per run (default 150)
//   --out <dir>        write one repro JSON per bug
//   --expect-bugs      invert the exit code (for showing that a buggy app gets caught)

import fs from 'node:fs';
import path from 'node:path';
import { serve, openUI } from '../src/node.mjs';

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[k] = true; else { out[k] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

const fmt = (s) => {
  const d = { click: () => `click "${s.label}"`, input: () => `type "${s.value}" into ${s.label}`, select: () => `choose "${s.value}"`,
    tick: () => `wait ${s.ms} ms`, arrive: () => `server receives ${s.key} #${s.n}`,
    respond: () => `response to ${s.key} #${s.n} reaches the page`, fail: () => `network drops ${s.key} #${s.n}` };
  return (d[s.t] || (() => JSON.stringify(s)))();
};

async function main() {
  const a = args(process.argv.slice(2));
  const cmd = a._[0];

  if (cmd === 'serve') {
    const server = await serve(Number(a.port || 4177));
    console.log(`racehound UI: http://127.0.0.1:${server.address().port}/racehound/ui/index.html?app=/demo/pantry/`);
    return;
  }

  if (cmd === 'hunt') {
    const appDir = a._[1] || '.';
    const ui = await openUI(appDir);
    const t0 = Date.now();
    const out = await ui.page.evaluate((o) => window.racehound.huntQuiet(o), {
      from: Number(a.seed || 1), runs: Number(a.runs || 300), maxSteps: Number(a.steps || 150), variant: a.variant,
    });
    await ui.close();
    const secs = (Date.now() - t0) / 1000;
    console.log(`${out.runs} runs, ${out.steps} steps, ${secs.toFixed(1)} s${a.variant ? `, variant ${a.variant}` : ''}`);
    for (const b of out.bugs) {
      console.log(`\nBUG  ${b.failure.name}\n     ${b.failure.message}\n     seed ${b.seed}, ${b.steps.length} steps:`);
      b.steps.forEach((s, i) => console.log(`     ${String(i + 1).padStart(2)}. ${fmt(s)}`));
      if (a.out) {
        fs.mkdirSync(a.out, { recursive: true });
        const f = path.join(a.out, `${b.variant}-${b.failure.name.replace(/\W+/g, '-')}.json`);
        fs.writeFileSync(f, JSON.stringify(b, null, 2) + '\n');
        console.log(`     saved ${f}`);
      }
    }
    if (!out.bugs.length) console.log('no bugs found');
    const failed = a['expect-bugs'] ? out.bugs.length === 0 : out.bugs.length > 0;
    process.exit(failed ? 1 : 0);
  }

  if (cmd === 'replay') {
    const r = JSON.parse(fs.readFileSync(a._[1], 'utf8'));
    const ui = await openUI(r.app.startsWith('/') ? '.' + r.app : r.app);
    const res = await ui.page.evaluate((x) => window.racehound.replayQuiet(x), r);
    await ui.close();
    if (res.failure) {
      console.log(`still fails: ${res.failure.name}: ${res.failure.message}`);
      process.exit(1);
    }
    console.log('passes');
    return;
  }

  console.log('usage: racehound serve | hunt <app-dir> [--variant v --runs n --seed n --steps n --out dir --expect-bugs] | replay <repro.json>');
  process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(2); });
