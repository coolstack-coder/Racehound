// How Racehound should test Pantry: a fake server, the words to type, and the
// properties that must hold.

const PRODUCTS = [
  'Oat milk', 'Almond milk', 'Milk bread', 'Sourdough loaf', 'Alphonso mangoes',
  'Mango pickle', 'Fresh paneer', 'Palak', 'Filter coffee', 'Cold coffee', 'Wild honey', 'Mint leaves',
];

export default {
  entry: 'index.html',

  variants: {
    buggy: { globals: { PANTRY_MODE: 'buggy' } },
    naive: { globals: { PANTRY_MODE: 'naive' } },
    fixed: { globals: { PANTRY_MODE: 'fixed' } },
  },

  // A fresh server for every run. Its state is visible to the invariants.
  server() {
    const state = { cart: {}, version: 0 };
    return {
      state,
      routes: {
        'GET /api/search': ({ query }) => ({
          items: PRODUCTS.filter((p) => p.toLowerCase().includes((query.q || '').toLowerCase()))
            .slice(0, 5).map((name) => ({ name })),
        }),
        'POST /api/cart': ({ body }) => {
          const qty = Math.max(0, (state.cart[body.sku] || 0) + body.delta);
          state.cart[body.sku] = qty;
          state.version++;
          return { sku: body.sku, qty, version: state.version, cart: { ...state.cart } };
        },
      },
    };
  },

  inputs: {
    '#search': ['mi', 'milk', 'mango', 'pa', 'paneer', 'coffee'],
    '#coupon': ['SAVE10', 'SAVE20', 'WELCOME'],
  },

  // Checked after every step.
  always: {
    'cart badge matches the cart lines': ({ $, $$ }) => {
      const lines = $$('#lines li:not(.empty)')
        .reduce((n, li) => n + Number(li.textContent.match(/× (\d+)/)[1]), 0);
      const badge = Number($('#badge').textContent);
      return badge === lines || `badge says ${badge}, lines add up to ${lines}`;
    },
  },

  // Checked once the network is quiet and pending timers have run.
  eventually: {
    'results match the search box': ({ $ }) => {
      const box = $('#search').value.trim();
      const shown = $('#results').dataset.query;
      return box === shown || `search box says "${box}" but the list shows results for "${shown}"`;
    },
    'cart matches the server': ({ $$, server }) => {
      for (const el of $$('[data-qty-for]')) {
        const sku = el.dataset.qtyFor;
        const page = Number(el.textContent);
        const truth = server.cart[sku] || 0;
        if (page !== truth) return `page shows ${page} x ${sku}, server has ${truth}`;
      }
      return true;
    },
  },

  settle: 5000,
};
