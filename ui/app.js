import { Simulator, describe, fmtMs } from '../src/sim.js';

const params = new URLSearchParams(location.search);
const appUrl = params.get('app') || '../demo/pantry/';
const $ = (s) => document.querySelector(s);

const iframe = $('#app');
const sim = await new Simulator(iframe, appUrl).init();
const variants = Object.keys(sim.variants);
let variant = params.get('variant') || variants[0];
let stopFlag = false;
let busy = false;

$('#app-name').textContent = appUrl.replace(/\/$/, '').split('/').pop();

// ---------- controls ----------

function renderVariants() {
  $('#variants').innerHTML = variants
    .map((v) => `<button data-v="${v}" class="${v === variant ? 'on' : ''}">${v}</button>`)
    .join('');
}
renderVariants();
$('#variants').addEventListener('click', (e) => {
  const v = e.target.dataset.v;
  if (!v || busy) return;
  variant = v;
  renderVariants();
  boot();
});

$('#hunt').addEventListener('click', () => hunt());
$('#stop').addEventListener('click', () => { stopFlag = true; });

function setBusy(b) {
  busy = b;
  $('#hunt').disabled = b;
  $('#stop').disabled = !b;
}

// ---------- world panel ----------

const stats = { runs: 0, steps: 0, virtualMs: 0, bugs: 0, t0: 0 };

function renderStats() {
  $('#s-runs').textContent = stats.runs.toLocaleString();
  $('#s-steps').textContent = stats.steps.toLocaleString();
  const secs = (performance.now() - stats.t0) / 1000;
  $('#s-rate').textContent = stats.t0 && secs > 0.2 ? (stats.runs / secs).toFixed(1) : '0';
  $('#s-virtual').textContent = fmtMs(Math.round(stats.virtualMs)).replace(' ', ' ');
  $('#s-bugs').textContent = stats.bugs;
}

function renderWorld(highlight) {
  const W = sim.world;
  if (!W) return;
  $('#w-now').textContent = fmtMs(W.now);
  $('#clock').textContent = `t = ${(W.now / 1000).toFixed(3)} s`;
  $('#w-timers').textContent = W.timers.size;
  $('#w-flight').textContent = sim.pending().length;
  const reqs = W.reqs.slice(-6);
  $('#net').innerHTML = reqs.map((q) => {
    const hl = highlight && highlight.key === q.key && highlight.n === q.n ? 'hl' : '';
    const sent = '<i class="on">sent</i>';
    const server = q.arrived ? '<i class="on">server</i>' : '<i>server</i>';
    let back = '<i>page</i>';
    if (q.done && !q.failed) back = '<i class="done">page</i>';
    if (q.failed) back = '<i class="x">dropped</i>';
    if (q.aborted) back = '<i class="x">aborted</i>';
    return `<li class="${hl}"><span class="k">${esc(q.key)} #${q.n}</span><span class="legs">${sent}${server}${back}</span></li>`;
  }).join('') || '<li class="k" style="color:var(--dim)">no requests yet</li>';
}

function status(text) { $('#status').textContent = text; }

// ---------- bugs ----------

const bugsEl = $('#bugs');
let firstBug = true;

function bugCard(res) {
  if (firstBug) { bugsEl.innerHTML = ''; firstBug = false; }
  const el = document.createElement('div');
  el.className = 'bug';
  el.dataset.seed = res.seed;
  el.innerHTML = `
    <h5>${esc(res.failure.name)}</h5>
    <p class="msg">${esc(res.failure.message)}</p>
    <div class="meta">seed ${res.seed} · ${esc(res.variant)} · found at step ${res.steps.length}, ${esc(res.failure.phase)}</div>
    <div class="shrinkbar"><i></i></div>
    <div class="meta shrink">shrinking...</div>
    <ol class="steps"></ol>
    <div class="actions"></div>`;
  bugsEl.prepend(el);
  return el;
}

function showMinimal(el, min) {
  el.querySelector('.shrinkbar i').style.width = `${(100 * min.steps.length) / min.originalSteps}%`;
  el.querySelector('.shrink').textContent =
    `shrunk ${min.originalSteps} → ${min.steps.length} steps in ${min.replays} replays (${(min.shrinkMs / 1000).toFixed(1)} s)`;
  el.querySelector('.msg').textContent = min.failure.message;
  el.querySelector('.steps').innerHTML = min.steps
    .map((s) => `<li class="t-${s.t}">${esc(describe(s))}</li>`).join('');
  const actions = el.querySelector('.actions');
  actions.innerHTML = '<button class="primary">Replay slowly</button><button>Copy repro</button>';
  actions.children[0].onclick = () => replay(min, el);
  actions.children[1].onclick = () => navigator.clipboard.writeText(JSON.stringify(repro(min), null, 2));
}

export function repro(min) {
  return {
    app: appUrl, variant: min.variant, seed: min.seed,
    failure: { name: min.failure.name, message: min.failure.message },
    steps: min.steps,
  };
}

// ---------- hunting ----------

async function boot() {
  await sim.boot(1, variant);
  $('#frame-title').textContent = `${$('#app-name').textContent} · ${variant} · under simulation`;
  renderWorld();
}

async function hunt(opts = {}) {
  if (busy) return null;
  setBusy(true);
  stopFlag = false;
  const from = opts.from ?? Number($('#seed').value || 1);
  const runs = opts.runs ?? Number($('#runs').value || 300);
  Object.assign(stats, { runs: 0, steps: 0, virtualMs: 0, bugs: 0, t0: performance.now() });
  firstBug = true;
  bugsEl.innerHTML = '<p class="hint">hunting...</p>';
  $('#frame-title').textContent = `${$('#app-name').textContent} · ${variant} · under simulation`;
  let card = null;
  let found = null;
  status('hunting');

  const out = await sim.hunt({
    from, runs, variant,
    maxSteps: opts.maxSteps ?? 150,
    stopAtFirst: opts.stopAtFirst ?? false,
    shouldStop: () => stopFlag,
    onRun: (res, steps) => {
      stats.runs++;
      stats.steps = steps;
      stats.virtualMs += res.virtualMs;
      $('#seed').value = res.seed;
      renderStats();
      renderWorld();
      // Let the browser paint the finished run before the next one starts.
      return paint();
    },
    onFound: (res) => {
      stats.bugs++;
      renderStats();
      found = res;
      card = bugCard(res);
      status(`shrinking seed ${res.seed}`);
    },
    onShrink: ({ tests, size }) => {
      card.querySelector('.shrinkbar i').style.width = `${(100 * size) / found.steps.length}%`;
      card.querySelector('.shrink').textContent = `replay ${tests} · ${size} steps left`;
      return paint();
    },
    onShrunk: (min) => showMinimal(card, min),
  });
  if (!out.bugs.length && !stopFlag) {
    bugsEl.innerHTML = `<div class="clean">No bugs in ${stats.runs} runs (${stats.steps.toLocaleString()} steps, ${fmtMs(Math.round(stats.virtualMs))} of virtual time).</div>`;
  }
  status(stopFlag ? 'stopped' : 'done');
  $('#seed').value = out.nextSeed;
  setBusy(false);
  return out;
}

// ---------- slow replay ----------

const caption = $('#caption');

function say(html, bad = false) {
  caption.hidden = false;
  caption.className = 'caption' + (bad ? ' bad' : '');
  caption.innerHTML = html;
}

async function replay(min, cardEl, { pace = 1100 } = {}) {
  if (busy) return null;
  setBusy(true);
  status(`replaying seed ${min.seed}`);
  const items = cardEl ? [...cardEl.querySelectorAll('.steps li')] : [];
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let hlEl = null;

  const res = await sim.run({
    seed: min.seed,
    variant: min.variant,
    schedule: min.steps,
    watch: {
      before: async (step, i) => {
        items.forEach((li, j) => li.classList.toggle('cur', j === i));
        hlEl?.style.removeProperty('outline');
        hlEl = null;
        if (step.sel) {
          hlEl = sim.doc.querySelector(step.sel);
          if (hlEl) { hlEl.style.outline = '3px solid #f5a524'; hlEl.style.outlineOffset = '2px'; }
        }
        renderWorld(step.key ? step : null);
        say(`<b>${i + 1}/${min.steps.length}</b>${esc(describe(step))}`);
        await wait(pace);
      },
      after: async (step) => {
        renderWorld(step.key ? step : null);
        await wait(pace * 0.45);
      },
      beforeDrain: async () => {
        hlEl?.style.removeProperty('outline');
        items.forEach((li) => li.classList.remove('cur'));
        say('<b>settle</b>deliver what is left, in order');
        await wait(pace);
      },
    },
  });
  renderWorld();
  if (res.failure) say(`<b>${esc(res.failure.name)}</b>${esc(res.failure.message)}`, true);
  else say('<b>ok</b>no failure on replay');
  status('replayed');
  setBusy(false);
  return res;
}

// ---------- headless API (used by the CLI and the demo recorder) ----------

window.racehound = {
  sim,
  hunt,
  replay: (min, pace) => replay(min, [...bugsEl.querySelectorAll('.bug')].find((b) => b.dataset.seed == min.seed) || bugsEl.querySelector('.bug'), { pace }),
  setVariant: async (v) => { variant = v; renderVariants(); await boot(); },
  caption: say,
  hideCaption: () => { caption.hidden = true; },
  // Plain runs without touching the UI, for CI.
  async huntQuiet({ from = 1, runs = 200, maxSteps = 150, variant: v = variants[0] } = {}) {
    const out = await sim.hunt({ from, runs, maxSteps, variant: v });
    return { runs: out.runs, steps: out.steps, bugs: out.bugs.map(repro) };
  },
  async replayQuiet(r) {
    const res = await sim.run({ seed: r.seed, variant: r.variant, schedule: r.steps });
    return { failure: res.failure, steps: res.steps.length };
  },
};

// Give the browser a chance to paint. Falls back to a timer when the tab is
// hidden, where animation frames never fire.
function paint() {
  return new Promise((r) => { requestAnimationFrame(() => r()); setTimeout(r, 50); });
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

await boot();
document.body.dataset.ready = '1';
