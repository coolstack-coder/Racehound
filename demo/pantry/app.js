// Pantry: a small grocery storefront with the kind of async code most of us
// ship. PANTRY_MODE picks which version of the code runs:
//   buggy  - what a first draft usually looks like
//   naive  - the obvious fixes
//   fixed  - fixes that survive any message order
(function () {
  var MODE = window.PANTRY_MODE || 'buggy';

  var CATALOG = [
    { sku: 'oat-milk', name: 'Oat milk', price: 189, color: '#c9a66b' },
    { sku: 'sourdough', name: 'Sourdough loaf', price: 240, color: '#a8743f' },
    { sku: 'mangoes', name: 'Alphonso mangoes', price: 450, color: '#e3a21a' },
    { sku: 'paneer', name: 'Fresh paneer', price: 120, color: '#b9b29a' },
    { sku: 'coffee', name: 'Filter coffee', price: 310, color: '#6b4a35' },
    { sku: 'honey', name: 'Wild honey', price: 275, color: '#d08a1c' },
  ];
  var COUPONS = { SAVE10: { pct: 10 } };

  var state = {
    cart: {},          // sku -> qty, what the page believes
    cartVersion: 0,    // fixed mode: newest server version applied
    lastSent: {},      // naive mode: newest request id per sku
    coupon: null,
    promo: { code: 'SAVE10', endsAt: Date.now() + 30000, expired: false },
  };

  var $ = function (s) { return document.querySelector(s); };
  var money = function (n) { return '₹' + Math.round(n).toLocaleString('en-IN'); };

  // ---------------- search with a debounce ----------------
  var debounce = null;
  var inflight = null;

  $('#search').addEventListener('input', function (e) {
    var q = e.target.value.trim();
    clearTimeout(debounce);
    debounce = setTimeout(function () { search(q); }, 150);
  });

  function search(q) {
    if (MODE !== 'buggy' && inflight) inflight.abort();
    inflight = null;
    if (!q) { renderResults('', null); return; }
    var opts;
    if (MODE !== 'buggy') { inflight = new AbortController(); opts = { signal: inflight.signal }; }
    $('#results').classList.add('loading');
    fetch('/api/search?q=' + encodeURIComponent(q), opts)
      .then(function (r) { return r.json(); })
      .then(function (data) { renderResults(q, data.items); })
      .catch(function (err) { if (err.name !== 'AbortError') renderResults(q, []); });
  }

  function renderResults(q, items) {
    var box = $('#results');
    box.classList.remove('loading');
    box.dataset.query = q;
    $('#results-title').textContent = q ? 'Results for "' + q + '"' : 'Popular right now';
    var list = items || CATALOG.slice(0, 3);
    $('#results-list').innerHTML = list.length
      ? list.map(function (p) { return '<li>' + p.name + '</li>'; }).join('')
      : '<li>No matches</li>';
  }

  // ---------------- cart with optimistic updates ----------------
  function change(sku, delta) {
    var before = state.cart[sku] || 0;
    var next = Math.max(0, before + delta);
    if (next === before) return;
    state.cart[sku] = next;              // show it right away
    render();

    var id = (state.lastSent[sku] = (state.lastSent[sku] || 0) + 1);
    fetch('/api/cart', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sku: sku, delta: delta }),
    })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (MODE === 'naive' && id !== state.lastSent[sku]) return;   // ignore older replies
        if (MODE === 'fixed') {
          if (res.version <= state.cartVersion) return;               // ignore older server states
          state.cartVersion = res.version;
          state.cart = Object.assign({}, res.cart);
        } else {
          state.cart[sku] = res.qty;                                   // trust the server
        }
        render();
      })
      .catch(function () { state.cart[sku] = before; render(); });
  }

  // ---------------- coupon with a countdown ----------------
  setInterval(function () {
    var left = Math.max(0, Math.ceil((state.promo.endsAt - Date.now()) / 1000));
    if (left) $('#promo-time').textContent = '0:' + String(left).padStart(2, '0');
    if (!left && !state.promo.expired) {
      state.promo.expired = true;
      delete COUPONS[state.promo.code];
      $('#promo').classList.add('expired');
      $('#promo').innerHTML = '<b>SAVE10</b> has expired';
    }
  }, 1000);

  $('#apply').addEventListener('click', function () {
    var code = $('#coupon').value.trim().toUpperCase();
    var msg = $('#coupon-msg');
    if (code !== state.promo.code) { msg.textContent = 'That code is not valid'; return; }
    if (MODE !== 'buggy' && state.promo.expired) { msg.textContent = 'This coupon has expired'; return; }
    state.coupon = MODE === 'buggy' ? code : { code: code, pct: COUPONS[code].pct };
    msg.textContent = code + ' applied';
    render();
  });

  function discountFor(subtotal) {
    if (!state.coupon) return 0;
    var pct = MODE === 'buggy' ? (COUPONS[state.coupon] || {}).pct : state.coupon.pct;
    return subtotal * pct / 100;
  }

  // ---------------- rendering ----------------
  $('#grid').innerHTML = CATALOG.map(function (p) {
    return '<div class="card">' +
      '<div class="thumb" style="background:' + p.color + '">' + p.name[0] + '</div>' +
      '<div class="name">' + p.name + '</div>' +
      '<div class="price">' + money(p.price) + '</div>' +
      '<div class="qty">' +
      '<button data-testid="remove-' + p.sku + '" aria-label="Remove ' + p.name + '">−</button>' +
      '<span data-qty-for="' + p.sku + '">0</span>' +
      '<button data-testid="add-' + p.sku + '" aria-label="Add ' + p.name + '">+</button>' +
      '</div></div>';
  }).join('');

  CATALOG.forEach(function (p) {
    $('[data-testid="add-' + p.sku + '"]').addEventListener('click', function () { change(p.sku, +1); });
    $('[data-testid="remove-' + p.sku + '"]').addEventListener('click', function () { change(p.sku, -1); });
  });

  function render() {
    var count = 0, subtotal = 0, lines = [];
    CATALOG.forEach(function (p) {
      var q = state.cart[p.sku] || 0;
      $('[data-qty-for="' + p.sku + '"]').textContent = q;
      $('[data-testid="remove-' + p.sku + '"]').disabled = q === 0;
      if (!q) return;
      count += q;
      subtotal += q * p.price;
      lines.push('<li><span>' + p.name + ' × ' + q + '</span><span>' + money(q * p.price) + '</span></li>');
    });
    var discount = discountFor(subtotal);
    $('#badge').textContent = count;
    $('#lines').innerHTML = lines.join('') || '<li class="empty">Nothing here yet</li>';
    $('#subtotal').textContent = money(subtotal);
    $('#discount').textContent = discount ? '−' + money(discount) : money(0);
    $('#total').textContent = money(subtotal - discount);
  }

  renderResults('', null);
  render();
})();
