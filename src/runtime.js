// Racehound in-page runtime.
//
// Injected as the first script of the page under test. It replaces every
// source of nondeterminism the page can reach (clock, timers, randomness,
// fetch, storage) with a virtual version the simulator drives one step at a
// time. Nothing here advances on its own: time moves only when the simulator
// says so, and a network message moves only when the simulator delivers it.
//
// This file is a classic script, not a module, so it runs before any app code.
(function () {
  'use strict';
  var H = window.frameElement && window.frameElement.__rh;
  if (!H) return;

  var W = {
    now: 0,          // virtual milliseconds since page start
    timers: new Map(),
    tseq: 0,
    order: 0,
    reqs: [],
    rseq: 0,
    keyN: Object.create(null),
    errors: [],
  };
  H.world = W;

  Object.keys(H.globals || {}).forEach(function (k) { window[k] = H.globals[k]; });

  // ---------- errors ----------
  function report(kind, e) {
    var msg = e && (e.message || e.reason) ? (e.message || String(e.reason)) : String(e);
    W.errors.push({ kind: kind, message: msg.split('\n')[0] });
  }
  window.addEventListener('error', function (ev) { report('uncaught error', ev.error || ev.message); });
  window.addEventListener('unhandledrejection', function (ev) { report('unhandled rejection', ev.reason); });
  var realConsoleError = console.error.bind(console);
  console.error = function () {
    W.errors.push({ kind: 'console.error', message: Array.prototype.map.call(arguments, String).join(' ') });
    realConsoleError.apply(null, arguments);
  };

  // ---------- randomness ----------
  Math.random = H.random;
  try {
    crypto.getRandomValues = function (arr) {
      var span = Math.pow(256, arr.BYTES_PER_ELEMENT || 1);
      for (var i = 0; i < arr.length; i++) arr[i] = Math.floor(H.random() * span);
      return arr;
    };
    crypto.randomUUID = function () {
      var h = '';
      for (var i = 0; i < 32; i++) h += Math.floor(H.random() * 16).toString(16);
      return h.slice(0, 8) + '-' + h.slice(8, 12) + '-4' + h.slice(13, 16) + '-a' + h.slice(17, 20) + '-' + h.slice(20, 32);
    };
  } catch (e) { /* crypto not writable: leave it */ }

  // ---------- time ----------
  var RealDate = Date;
  var EPOCH = H.epoch;
  function FakeDate() {
    var args = Array.prototype.slice.call(arguments);
    if (!new.target) return new RealDate(EPOCH + W.now).toString();
    return Reflect.construct(RealDate, args.length ? args : [EPOCH + W.now], new.target);
  }
  FakeDate.prototype = RealDate.prototype;
  FakeDate.now = function () { return EPOCH + W.now; };
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  window.Date = FakeDate;
  try { performance.now = function () { return W.now; }; } catch (e) { /* ignore */ }

  // ---------- timers ----------
  function addTimer(fn, ms, args, repeat) {
    if (typeof fn !== 'function') return 0;
    var d = Math.max(0, Number(ms) || 0);
    var id = ++W.tseq;
    W.timers.set(id, { id: id, at: W.now + d, ord: ++W.order, fn: fn, args: args, every: repeat ? Math.max(1, d) : 0 });
    return id;
  }
  function clearTimer(id) { W.timers.delete(id); }
  window.setTimeout = function (fn, ms) { return addTimer(fn, ms, Array.prototype.slice.call(arguments, 2), false); };
  window.setInterval = function (fn, ms) { return addTimer(fn, ms, Array.prototype.slice.call(arguments, 2), true); };
  window.clearTimeout = clearTimer;
  window.clearInterval = clearTimer;
  window.requestAnimationFrame = function (fn) { return addTimer(function () { fn(W.now); }, 16, [], false); };
  window.cancelAnimationFrame = clearTimer;

  W.nextTimer = function () {
    var best = null;
    W.timers.forEach(function (t) {
      if (!best || t.at < best.at || (t.at === best.at && t.ord < best.ord)) best = t;
    });
    return best;
  };
  W.fire = function (t) {
    W.timers.delete(t.id);
    if (t.at > W.now) W.now = t.at;
    // Re-arm intervals before running the callback so clearInterval inside it works.
    if (t.every) W.timers.set(t.id, { id: t.id, at: t.at + t.every, ord: ++W.order, fn: t.fn, args: t.args, every: t.every });
    try { t.fn.apply(window, t.args); } catch (e) { report('uncaught error', e); }
  };

  // ---------- storage ----------
  function memoryStorage() {
    var m = new Map();
    return {
      getItem: function (k) { k = String(k); return m.has(k) ? m.get(k) : null; },
      setItem: function (k, v) { m.set(String(k), String(v)); },
      removeItem: function (k) { m.delete(String(k)); },
      clear: function () { m.clear(); },
      key: function (i) { return Array.from(m.keys())[i] || null; },
      get length() { return m.size; },
    };
  }
  try {
    Object.defineProperty(window, 'localStorage', { value: memoryStorage(), configurable: true });
    Object.defineProperty(window, 'sessionStorage', { value: memoryStorage(), configurable: true });
  } catch (e) { /* ignore */ }

  // ---------- network ----------
  // Every fetch becomes a message with two legs that the simulator moves
  // independently: request -> server ("arrive"), response -> page ("respond").
  // Requests can reach the server in any order, and responses can come back in
  // any order. The server is the in-memory one from racehound.config.js.
  window.fetch = function (input, init) {
    init = init || {};
    var raw = typeof input === 'string' ? input : (input && input.url) || String(input);
    var u = new URL(raw, H.base);
    var method = String(init.method || (input && input.method) || 'GET').toUpperCase();
    var path = u.pathname + u.search;
    // A request is named by what it is, not by when it was sent, so deleting an
    // unrelated step during shrinking does not rename it.
    var bodyKey = typeof init.body === 'string' ? init.body.slice(0, 160) : '';
    var key = method + ' ' + path + (bodyKey ? ' ' + bodyKey : '');
    var n = (W.keyN[key] = (W.keyN[key] || 0) + 1);
    var query = {};
    u.searchParams.forEach(function (v, k) { query[k] = v; });
    var req = {
      id: ++W.rseq, key: key, n: n, method: method, path: path, pathname: u.pathname,
      query: query, body: init.body, sentAt: W.now,
      arrived: false, done: false, aborted: false, failed: false,
    };
    return new Promise(function (resolve, reject) {
      req.resolve = resolve;
      req.reject = reject;
      W.reqs.push(req);
      var sig = init.signal;
      if (sig) {
        var abort = function () {
          if (req.done || req.aborted) return;
          req.aborted = true;
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        };
        if (sig.aborted) abort(); else sig.addEventListener('abort', abort);
      }
    });
  };

  function parseBody(b) {
    if (typeof b !== 'string') return b;
    try { return JSON.parse(b); } catch (e) { return b; }
  }

  W.arrive = function (req) {
    var route = H.routes[req.method + ' ' + req.pathname];
    var status = 200, body;
    try {
      if (!route) { status = 404; body = { error: 'no route ' + req.method + ' ' + req.pathname }; }
      else {
        var r = route({ method: req.method, path: req.pathname, query: req.query, body: parseBody(req.body) });
        if (r && typeof r.status === 'number' && 'body' in r) { status = r.status; body = r.body; } else body = r;
      }
    } catch (e) { status = 500; body = { error: String(e && e.message || e) }; }
    req.arrived = true;
    req.arrivedAt = W.now;
    req.status = status;
    req.text = JSON.stringify(body === undefined ? null : body);
  };

  W.respond = function (req) {
    req.done = true;
    req.doneAt = W.now;
    var text = req.text, status = req.status;
    req.resolve({
      ok: status >= 200 && status < 300,
      status: status,
      url: req.path,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: function () { return Promise.resolve(JSON.parse(text)); },
      text: function () { return Promise.resolve(text); },
      clone: function () { return this; },
    });
  };

  W.fail = function (req) {
    req.done = true;
    req.failed = true;
    req.doneAt = W.now;
    req.reject(new TypeError('Failed to fetch'));
  };
})();
