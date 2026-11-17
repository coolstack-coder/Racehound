// Delta debugging (Zeller and Hildebrandt, 2002), followed by a one-at-a-time
// pass so the result is 1-minimal: removing any single step makes the bug go away.
//
// test(steps) replays a candidate schedule. It returns null if the bug is gone,
// or the steps that actually executed if it is still there. Steps that turned
// into no-ops during the replay are dropped, which speeds things up a lot.

export async function ddmin(steps, test, onProgress = () => {}) {
  let cur = steps.slice();
  let tests = 0;
  const attempt = async (cand) => {
    tests++;
    const r = await test(cand);
    await onProgress({ tests, size: cur.length });
    return r;
  };

  let n = 2;
  while (cur.length >= 2) {
    const chunks = split(cur, n);
    let reduced = false;

    for (const c of chunks) {
      const r = await attempt(c);
      if (r) { cur = r; n = 2; reduced = true; break; }
    }
    if (!reduced && n > 2) {
      for (let i = 0; i < chunks.length; i++) {
        const comp = chunks.filter((_, j) => j !== i).flat();
        const r = await attempt(comp);
        if (r) { cur = r; n = Math.max(n - 1, 2); reduced = true; break; }
      }
    }
    if (!reduced) {
      if (n >= cur.length) break;
      n = Math.min(cur.length, n * 2);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (let i = cur.length - 1; i >= 0; i--) {
      const r = await attempt(cur.slice(0, i).concat(cur.slice(i + 1)));
      if (r) { cur = r; changed = true; }
    }
  }
  return { steps: cur, tests };
}

export function split(arr, n) {
  const out = [];
  const size = arr.length / n;
  for (let i = 0; i < n; i++) {
    const part = arr.slice(Math.round(i * size), Math.round((i + 1) * size));
    if (part.length) out.push(part);
  }
  return out;
}
