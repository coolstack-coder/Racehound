// End-to-end: drive the real UI in headless Chrome against the demo app.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLI = path.resolve('bin/racehound.mjs');
const run = (...a) => {
  try { return { code: 0, out: execFileSync('node', [CLI, ...a], { encoding: 'utf8' }) }; }
  catch (e) { return { code: e.status, out: e.stdout }; }
};

let dir;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-')); });
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('finds and shrinks all three bugs in the buggy version', () => {
  const { code, out } = run('hunt', 'demo/pantry', '--variant', 'buggy', '--runs', '60', '--out', dir);
  assert.equal(code, 1, out);
  for (const name of ['results match the search box', 'cart matches the server', 'page shows NaN']) {
    assert.match(out, new RegExp('BUG  ' + name));
  }
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 3);
  for (const f of files) {
    const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    assert.ok(r.steps.length <= 6, `${f} has ${r.steps.length} steps`);
  }
});

test('a saved repro replays the same failure', () => {
  for (const f of fs.readdirSync(dir)) {
    const { code, out } = run('replay', path.join(dir, f));
    assert.equal(code, 1, out);
    assert.match(out, /still fails/);
  }
});

test('the same repro passes against the fixed version', () => {
  for (const f of fs.readdirSync(dir)) {
    const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    r.variant = 'fixed';
    const p = path.join(dir, 'fixed-' + f);
    fs.writeFileSync(p, JSON.stringify(r));
    const { code, out } = run('replay', p);
    assert.equal(code, 0, out);
    fs.rmSync(p);
  }
});

test('the naive fix still loses cart updates', () => {
  const { code, out } = run('hunt', 'demo/pantry', '--variant', 'naive', '--runs', '100');
  assert.equal(code, 1, out);
  assert.match(out, /BUG  cart matches the server/);
  assert.doesNotMatch(out, /BUG  results match the search box/);
});

test('the fixed version survives 200 runs', () => {
  const { code, out } = run('hunt', 'demo/pantry', '--variant', 'fixed', '--runs', '200');
  assert.equal(code, 0, out);
  assert.match(out, /no bugs found/);
});
