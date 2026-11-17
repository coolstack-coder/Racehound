// Small seeded PRNG (sfc32, seeded through splitmix32). Same seed, same stream,
// on every machine and every browser.

export function rng(seed) {
  let s = seed >>> 0;
  const mix = () => {
    s = (s + 0x9e3779b9) | 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
  let a = mix(), b = mix(), c = mix(), d = mix();
  const next = () => {
    a |= 0; b |= 0; c |= 0; d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 12; i++) next();
  return next;
}

export const pick = (r, arr) => arr[Math.floor(r() * arr.length)];

// items: [[weight, value], ...]
export function weighted(r, items) {
  let total = 0;
  for (const [w] of items) total += w;
  let x = r() * total;
  for (const [w, v] of items) {
    if ((x -= w) < 0) return v;
  }
  return items[items.length - 1][1];
}
