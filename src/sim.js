// The simulator. It owns one iframe, loads the app under test into it with the
// runtime injected, and drives it one step at a time.
//
// A step is plain data, so a run is just a list of steps plus a seed:
//   { t: 'click',   sel, label }          click an element
//   { t: 'input',   sel, value, label }   set a text field to an absolute value
//   { t: 'select',  sel, value, label }   pick an option
//   { t: 'tick',    ms }                  advance virtual time, firing due timers
//   { t: 'arrive',  key, n }              request #n of `key` reaches the server
//   { t: 'respond', key, n }              its response reaches the page
//   { t: 'fail',    key, n }              the network drops it (fault injection)
// A step that no longer makes sense during a replay (the element is gone, the
// request was never sent) is skipped. That is what lets the shrinker delete
// steps freely.

import { rng, pick, weighted } from './prng.js';
import { ddmin } from './ddmin.js';

const EPOCH = Date.UTC(2026, 0, 1, 9, 0, 0);
const TICKS = [[3, 16], [3, 50], [3, 150], [2, 400], [2, 1000], [1, 5000], [0.6, 30000]];
const INTERACTIVE = 'button, a[href], input, select, textarea, [role=button]';

export function flush() {
  // One real macrotask: every microtask queued by the page has run by then.
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(0);
  });
}

async function settle() { await flush(); await flush(); }

export class Simulator {
  constructor(iframe, appUrl) {
    this.iframe = iframe;
    this.appUrl = new URL(appUrl, location.href).href;
  }

  async init() {
    const cfgMod = await import(new URL('racehound.config.js', this.appUrl).href);
    this.cfg = cfgMod.default;
    const [html, runtime] = await Promise.all([
      fetch(new URL(this.cfg.entry || 'index.html', this.appUrl)).then((r) => r.text()),
      fetch(new URL('./runtime.js', import.meta.url)).then((r) => r.text()),
    ]);
    const head = `<base href="${this.appUrl}"><script>${runtime}<\/script>`;
    this.html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + head) : head + html;
    this.variants = this.cfg.variants || { default: {} };
    return this;
  }

  // ---------- lifecycle ----------

  async boot(seed, variant) {
    const server = this.cfg.server ? this.cfg.server() : { state: {}, routes: {} };
    const v = this.variants[variant] || {};
    this.server = server;
    this.iframe.__rh = {
      random: rng((seed ^ 0x5eed) >>> 0),
      epoch: EPOCH,
      base: this.appUrl,
      routes: server.routes,
      globals: v.globals || {},
    };
    await new Promise((resolve) => {
      this.iframe.onload = resolve;
      this.iframe.srcdoc = this.html;
    });
    this.win = this.iframe.contentWindow;
    this.doc = this.iframe.contentDocument;
    this.world = this.iframe.__rh.world;
    await settle();
  }

  // ---------- inspection ----------

  elements() {
    const out = [];
    for (const el of this.doc.querySelectorAll(INTERACTIVE)) {
      if (el.disabled || el.closest('[data-rh-ignore]') || !el.getClientRects().length) continue;
      if (el.type === 'hidden') continue;
      out.push(el);
    }
    return out;
  }

  pending() {
    return this.world.reqs.filter((q) => !q.done && !(q.aborted && q.arrived));
  }

  findReq(key, n) {
    return this.world.reqs.find((q) => q.key === key && q.n === n);
  }

  // ---------- actions ----------

  async exec(step) {
    const W = this.world;
    switch (step.t) {
      case 'click': {
        const el = this.doc.querySelector(step.sel);
        if (!el || el.disabled || !el.getClientRects().length) return false;
        el.click();
        break;
      }
      case 'input': {
        const el = this.doc.querySelector(step.sel);
        if (!el || el.disabled || el.value === step.value) return false;
        el.value = step.value;
        el.dispatchEvent(new this.win.Event('input', { bubbles: true }));
        break;
      }
      case 'select': {
        const el = this.doc.querySelector(step.sel);
        if (!el || el.disabled || el.value === step.value) return false;
        el.value = step.value;
        el.dispatchEvent(new this.win.Event('change', { bubbles: true }));
        break;
      }
      case 'tick': {
        const target = W.now + step.ms;
        for (let t = W.nextTimer(); t && t.at <= target; t = W.nextTimer()) {
          W.fire(t);
          await settle();
        }
        W.now = target;
        break;
      }
      case 'arrive': {
        const q = this.findReq(step.key, step.n);
        if (!q || q.arrived || q.failed) return false;
        W.arrive(q);
        break;
      }
      case 'respond': {
        const q = this.findReq(step.key, step.n);
        if (!q || !q.arrived || q.done || q.aborted) return false;
        W.respond(q);
        break;
      }
      case 'fail': {
        const q = this.findReq(step.key, step.n);
        if (!q || q.done || q.aborted) return false;
        W.fail(q);
        break;
      }
      default:
        return false;
    }
    await settle();
    return true;
  }

  // Pick the next step at random. Every choice comes from `r`, so a seed fully
  // determines the run.
  choose(r) {
    const W = this.world;
    const cats = [];
    const els = this.elements();
    if (els.length) cats.push([4, 'ui']);
    cats.push([2.5, 'tick']);
    const arrivable = W.reqs.filter((q) => !q.arrived && !q.failed);
    const respondable = W.reqs.filter((q) => q.arrived && !q.done && !q.aborted);
    if (arrivable.length) cats.push([1.75, 'arrive']);
    if (respondable.length) cats.push([1.75, 'respond']);
    if (this.cfg.faults && (arrivable.length || respondable.length)) cats.push([0.3, 'fail']);

    switch (weighted(r, cats)) {
      case 'ui': return this.uiStep(r, pick(r, els));
      case 'tick': {
        const t = W.nextTimer();
        const ms = t && r() < 0.5 ? Math.max(1, t.at - W.now) : weighted(r, TICKS);
        return { t: 'tick', ms };
      }
      case 'arrive': { const q = pick(r, arrivable); return { t: 'arrive', key: q.key, n: q.n }; }
      case 'respond': { const q = pick(r, respondable); return { t: 'respond', key: q.key, n: q.n }; }
      case 'fail': {
        const q = pick(r, arrivable.concat(respondable));
        return { t: 'fail', key: q.key, n: q.n };
      }
    }
  }

  uiStep(r, el) {
    const sel = selectorFor(el);
    const label = labelFor(el);
    const tag = el.tagName;
    if (tag === 'SELECT') {
      const opts = [...el.options].map((o) => o.value);
      return { t: 'select', sel, value: pick(r, opts), label };
    }
    const textual = tag === 'TEXTAREA' || (tag === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'reset'].includes(el.type));
    if (!textual) return { t: 'click', sel, label };

    const words = (this.cfg.inputs && this.cfg.inputs[sel]) || ['a', 'ab', 'hello', 'test'];
    const cur = el.value;
    const longer = words.filter((w) => w.length > cur.length && w.startsWith(cur));
    const x = r();
    let value;
    if (x < 0.45 && longer.length) value = cur + pick(r, longer)[cur.length];
    else if (x < 0.6 && cur) value = cur.slice(0, -1);
    else if (x < 0.85) value = pick(r, words);
    else { const w = pick(r, words); value = w.slice(0, 1 + Math.floor(r() * w.length)); }
    return { t: 'input', sel, value, label };
  }

  // Deliver everything still in flight and run timers up to a horizon, in a
  // fixed order. Used at the end of a run so "eventually" invariants can be
  // checked against a settled page.
  async drain() {
    const W = this.world;
    const horizon = W.now + (this.cfg.settle ?? 5000);
    for (let i = 0; i < 2000; i++) {
      const a = W.reqs.find((q) => !q.arrived && !q.failed);
      if (a) { W.arrive(a); await settle(); continue; }
      const p = W.reqs.find((q) => q.arrived && !q.done && !q.aborted);
      if (p) { W.respond(p); await settle(); continue; }
      const t = W.nextTimer();
      if (t && t.at <= horizon) { W.fire(t); await settle(); continue; }
      break;
    }
  }

  // ---------- checking ----------

  check(kind) {
    if (kind === 'always') {
      const b = builtins(this.world, this.doc);
      if (b) return { kind: 'built-in', ...b };
    }
    const ctx = {
      doc: this.doc,
      win: this.win,
      server: this.server.state,
      world: this.world,
      $: (s) => this.doc.querySelector(s),
      $$: (s) => [...this.doc.querySelectorAll(s)],
    };
    for (const [name, fn] of Object.entries(this.cfg[kind] || {})) {
      let r;
      try { r = fn(ctx); } catch (e) { r = String(e && e.message || e); }
      if (r === true || r === undefined || r === null) continue;
      return { kind, name, message: typeof r === 'string' ? r : 'returned false' };
    }
    return null;
  }

  // ---------- runs ----------

  async run({ seed, variant = 'default', maxSteps = 150, schedule = null, watch = null }) {
    const started = performance.now();
    await this.boot(seed, variant);
    const r = rng(seed);
    const steps = [];
    let failure = null;
    const total = schedule ? schedule.length : maxSteps;

    for (let i = 0; i < total; i++) {
      const step = schedule ? schedule[i] : this.choose(r);
      if (watch?.before) await watch.before(step, steps.length, this);
      if (!(await this.exec(step))) continue;
      steps.push(step);
      if (watch?.after) await watch.after(step, steps.length, this);
      failure = this.check('always');
      if (failure) { failure.phase = 'during the run'; break; }
    }
    if (!failure) {
      if (watch?.beforeDrain) await watch.beforeDrain(this);
      await this.drain();
      failure = this.check('always') || this.check('eventually');
      if (failure) failure.phase = 'after everything settled';
    }
    if (failure) failure.atStep = steps.length;
    return { seed, variant, steps, failure, virtualMs: this.world.now, ms: performance.now() - started };
  }

  async shrink(found, onProgress) {
    const name = found.failure.name;
    const t0 = performance.now();
    let replays = 0;
    const test = async (cand) => {
      replays++;
      const res = await this.run({ seed: found.seed, variant: found.variant, schedule: cand });
      return res.failure && res.failure.name === name ? mergeTicks(res.steps) : null;
    };
    let { steps } = await ddmin(mergeTicks(found.steps), test, onProgress);

    // Try to fold all waiting into a single wait, at each possible position.
    const ticks = steps.filter((s) => s.t === 'tick');
    if (ticks.length > 1) {
      const total = ticks.reduce((n, s) => n + s.ms, 0);
      const rest = steps.filter((s) => s.t !== 'tick');
      for (let i = 0; i <= rest.length; i++) {
        const cand = [...rest.slice(0, i), { t: 'tick', ms: total }, ...rest.slice(i)];
        const r = await test(cand);
        if (r) { steps = r; break; }
      }
      steps = (await ddmin(steps, test, onProgress)).steps;
    }

    // Then make each wait as short as it can be while the bug still shows up.
    for (let i = 0; i < steps.length; i++) {
      if (steps[i].t !== 'tick' || steps[i].ms <= 1) continue;
      let lo = 1, hi = steps[i].ms;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        const cand = steps.map((s, j) => (j === i ? { t: 'tick', ms: mid } : s));
        if (await test(cand)) hi = mid; else lo = mid + 1;
        await onProgress?.({ tests: replays, size: steps.length });
      }
      steps = steps.map((s, j) => (j === i ? { t: 'tick', ms: hi } : s));
    }

    const final = await this.run({ seed: found.seed, variant: found.variant, schedule: steps });
    return {
      seed: found.seed,
      variant: found.variant,
      originalSteps: found.steps.length,
      steps: final.steps,
      failure: final.failure,
      replays: replays + 1,
      shrinkMs: performance.now() - t0,
    };
  }

  // Run seeds until `runs` are done. Every new kind of failure is shrunk and
  // reported once.
  async hunt({ from = 1, runs = 200, maxSteps = 150, variant = 'default', stopAtFirst = false, onRun, onFound, onShrink, onShrunk, shouldStop } = {}) {
    const seen = new Set();
    const bugs = [];
    let steps = 0;
    for (let seed = from; seed < from + runs; seed++) {
      if (shouldStop?.()) break;
      const res = await this.run({ seed, variant, maxSteps });
      steps += res.steps.length;
      await onRun?.(res, steps);
      if (!res.failure || seen.has(res.failure.name)) continue;
      seen.add(res.failure.name);
      onFound?.(res);
      const min = await this.shrink(res, onShrink);
      bugs.push(min);
      onShrunk?.(min);
      if (stopAtFirst) return { bugs, runs: seed - from + 1, steps, nextSeed: seed + 1 };
    }
    return { bugs, runs, steps, nextSeed: from + runs };
  }
}

// Two waits in a row are the same as one longer wait: timers fire in the same
// order either way. Merging them lets the shrinker treat time as one step.
export function mergeTicks(steps) {
  const out = [];
  for (const s of steps) {
    const last = out[out.length - 1];
    if (s.t === 'tick' && last && last.t === 'tick') out[out.length - 1] = { t: 'tick', ms: last.ms + s.ms };
    else out.push(s);
  }
  return out;
}

// ---------- oracles that need no configuration ----------

const SUSPICIOUS = /(^|[^A-Za-z])(NaN|undefined|\[object Object\]|Infinity)(?![A-Za-z])/;

export function builtins(world, doc) {
  if (world.errors.length) {
    const e = world.errors[0];
    return { name: e.kind, message: e.message };
  }
  const text = doc.body ? doc.body.innerText : '';
  const m = text.match(SUSPICIOUS);
  if (m) {
    const line = text.split('\n').find((l) => SUSPICIOUS.test(l)).trim();
    return { name: `page shows ${m[2]}`, message: `the page says "${line.slice(0, 80)}"` };
  }
  return null;
}

// ---------- describing elements and steps ----------

export function selectorFor(el) {
  if (el.id) return '#' + CSS.escape(el.id);
  const tid = el.getAttribute('data-testid');
  if (tid) return `[data-testid="${tid}"]`;
  const parts = [];
  for (let e = el; e && e.nodeType === 1 && e.tagName !== 'BODY'; e = e.parentElement) {
    if (e.id) { parts.unshift('#' + CSS.escape(e.id)); break; }
    const same = [...e.parentElement.children].filter((c) => c.tagName === e.tagName);
    parts.unshift(e.tagName.toLowerCase() + (same.length > 1 ? `:nth-of-type(${same.indexOf(e) + 1})` : ''));
  }
  return parts.join(' > ');
}

export function labelFor(el) {
  const t = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.textContent || el.name || el.tagName;
  return t.replace(/\s+/g, ' ').trim().slice(0, 40);
}

export function describe(step) {
  switch (step.t) {
    case 'click': return `click "${step.label}"`;
    case 'input': return `type "${step.value}" into ${step.label}`;
    case 'select': return `choose "${step.value}" in ${step.label}`;
    case 'tick': return `wait ${fmtMs(step.ms)}`;
    case 'arrive': return `server receives ${step.key} #${step.n}`;
    case 'respond': return `response to ${step.key} #${step.n} reaches the page`;
    case 'fail': return `network drops ${step.key} #${step.n}`;
  }
  return JSON.stringify(step);
}

export function fmtMs(ms) {
  if (ms >= 3600000) return `${+(ms / 3600000).toFixed(1)} h`;
  if (ms >= 60000) return `${+(ms / 60000).toFixed(1)} min`;
  return ms >= 1000 ? `${+(ms / 1000).toFixed(2)} s` : `${ms} ms`;
}
