// FastWoWGold quote tool: static page that calls the public read-only JSON API.
(function () {
  'use strict';

  var SITE = 'https://fastwowgold.com'; // used for the Buy link, never overridden
  var params = new URLSearchParams(location.search);
  var apiParam = params.get('api');
  var API = (apiParam && /^https?:\/\//i.test(apiParam) ? apiParam : SITE).replace(/\/+$/, '');

  var $ = function (id) { return document.getElementById(id); };
  var el = {
    game: $('game'), server: $('server'), list: $('server-list'), serverHint: $('server-hint'),
    qty: $('quantity'), qtyHint: $('qty-hint'), unit: $('unit'), currency: $('currency'),
    result: $('result'), resultBox: document.querySelector('.result'), buy: $('buy')
  };

  var state = { catalog: null, game: null, server: null, quantity: null, currency: 'USD' };
  var serverTimer, quoteTimer, quoteSeq = 0, quoteAbort, searchSeq = 0, activeIdx = -1;

  // ---------- helpers ----------
  function getJson(path, opts) {
    return fetch(API + path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        if (!r.ok) { var e = new Error((body.error && body.error.message) || 'Request failed'); e.status = r.status; e.code = body.error && body.error.code; throw e; }
        return body;
      });
    });
  }
  function fmt(n, max) { return Number(n).toLocaleString('en-US', { maximumFractionDigits: max === undefined ? 2 : max }); }
  function symbolFor(code) {
    var c = state.catalog.currencies.filter(function (x) { return x.code === code; })[0];
    return c ? c.symbol : code + ' ';
  }
  function text(node, s) { node.textContent = s; }

  // ---------- persistence (localStorage + URL hash) ----------
  function save() {
    var data = { g: state.game && state.game.id, s: state.server && state.server.id, sn: state.server && state.server.name, q: state.quantity, c: state.currency };
    try { localStorage.setItem('fwg-quote', JSON.stringify(data)); } catch (e) { /* storage blocked */ }
    var h = new URLSearchParams();
    Object.keys(data).forEach(function (k) { if (data[k] != null) h.set(k, data[k]); });
    try { history.replaceState(null, '', '#' + h.toString()); } catch (e) { /* ignore */ }
  }
  function load() {
    var out = {};
    try { out = JSON.parse(localStorage.getItem('fwg-quote') || '{}') || {}; } catch (e) { out = {}; }
    var h = new URLSearchParams(location.hash.slice(1));
    ['g', 's', 'sn', 'q', 'c'].forEach(function (k) { if (h.get(k)) out[k] = h.get(k); });
    return out;
  }

  // ---------- result area ----------
  function showMessage(msg, isError) {
    el.result.innerHTML = '';
    var p = document.createElement('p');
    p.className = isError ? 'error' : 'muted';
    text(p, msg);
    el.result.appendChild(p);
    setBuy(null);
  }
  function setBuy(q) {
    if (q) {
      el.buy.href = SITE + '/?GameId=' + encodeURIComponent(q.gameId) + '&ServerId=' + encodeURIComponent(q.serverId) +
        '&Quantity=' + encodeURIComponent(q.quantity) + '&utm_source=quote-tool&utm_medium=github-pages&utm_campaign=gold-quote';
      el.buy.setAttribute('aria-disabled', 'false'); el.buy.removeAttribute('tabindex');
    } else {
      el.buy.href = '#'; el.buy.setAttribute('aria-disabled', 'true'); el.buy.tabIndex = -1;
    }
  }
  // The API prices card payment (Stripe, payment method 2) by default, fee included.
  // Cheaper methods depend on the currency: Zelle and USDC are USD only, Interac e-Transfer is CAD only.
  var CARD_METHOD_ID = 2;
  var CHEAPER_METHODS = { USD: 'crypto / Zelle', CAD: 'Interac e-Transfer' };
  function cardFeeNote(q) {
    if (q.paymentMethodId !== CARD_METHOD_ID) return '';
    var cheaper = CHEAPER_METHODS[(q.currency || '').toUpperCase()];
    return 'Includes card processing fee.' + (cheaper ? ' Lower with ' + cheaper + '.' : '');
  }
  function showQuote(q) {
    var sym = symbolFor(q.currency);
    // Only plain-unit games (unit is exactly "Gold") get a per-1,000 figure; units like "K Gold" or "M GP" are already scaled.
    var gold = /^gold$/i.test((q.unit || '').trim());
    var per = q.total / q.quantity * (gold ? 1000 : 1);
    var perText = sym + fmt(per, per < 1 ? 4 : 2) + ' per ' + (gold ? '1,000 ' : '') + q.unit;
    el.result.innerHTML = '';
    var a = document.createElement('div'); a.className = 'price'; text(a, sym + fmt(q.total));
    var b = document.createElement('p'); b.className = 'per'; text(b, perText);
    var c = document.createElement('p'); c.className = 'muted';
    text(c, fmt(q.quantity, 0) + ' ' + q.unit + ' on ' + q.serverName);
    el.result.appendChild(a); el.result.appendChild(b); el.result.appendChild(c);
    var feeNote = cardFeeNote(q);
    if (feeNote) {
      var d = document.createElement('p'); d.className = 'note fee'; text(d, feeNote);
      el.result.appendChild(d);
    }
    setBuy({ gameId: q.gameId, serverId: q.serverId, quantity: q.quantity });
  }

  // ---------- quote ----------
  function validQuantity() {
    var g = state.game, q = state.quantity;
    if (!g) return false;
    var ok = Number.isFinite(q) && q >= g.minQuantity && q <= g.maxQuantity;
    text(el.qtyHint, 'Min ' + fmt(g.minQuantity, 0) + ', max ' + fmt(g.maxQuantity, 0));
    el.qtyHint.className = 'hint' + (ok || el.qty.value === '' ? '' : ' error');
    return ok;
  }
  function scheduleQuote() {
    clearTimeout(quoteTimer);
    quoteSeq++;
    if (quoteAbort) quoteAbort.abort();
    setBuy(null);
    save();
    if (!state.game || !state.server) return showMessage('Choose a server and quantity to see a price.');
    if (!validQuantity()) return showMessage('Enter a quantity within the allowed range.');
    showMessage('Getting quote...');
    el.resultBox.classList.add('loading');
    quoteTimer = setTimeout(requestQuote, 350);
  }
  function requestQuote() {
    var seq = quoteSeq;
    quoteAbort = window.AbortController ? new AbortController() : null;
    var body = JSON.stringify({ gameId: state.game.id, serverId: state.server.id, quantity: state.quantity, currency: state.currency });
    getJson('/api/v1/quote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, signal: quoteAbort && quoteAbort.signal })
      .then(function (q) { if (seq === quoteSeq) showQuote(q); })
      .catch(function (e) {
        if (seq !== quoteSeq || e.name === 'AbortError') return;
        var msg = 'Could not get a quote. Please check your connection and try again.';
        if (e.status === 409) msg = 'No price is available for this server right now. Try another server or check back later.';
        else if (e.status === 429) msg = 'Too many requests. Please wait a moment and try again.';
        else if (e.status === 400) msg = e.message || 'Please check your selection and quantity.';
        showMessage(msg, true);
      })
      .then(function () { if (seq === quoteSeq) el.resultBox.classList.remove('loading'); });
  }

  // ---------- server search ----------
  function closeList() { el.list.hidden = true; el.server.setAttribute('aria-expanded', 'false'); el.server.removeAttribute('aria-activedescendant'); activeIdx = -1; }
  function renderServers(data) {
    el.list.innerHTML = '';
    data.servers.forEach(function (s, i) {
      var li = document.createElement('li');
      li.id = 'srv-' + i; li.setAttribute('role', 'option'); li.setAttribute('aria-selected', 'false');
      text(li, s.name);
      li.addEventListener('mousedown', function (ev) { ev.preventDefault(); pickServer(s); });
      el.list.appendChild(li);
    });
    var more = data.serversTotalMatching - data.servers.length;
    if (!data.servers.length) addInfo('No servers found');
    else if (more > 0) addInfo(more + ' more, keep typing');
    el.list.hidden = false; el.server.setAttribute('aria-expanded', 'true'); activeIdx = -1;
  }
  function addInfo(msg) {
    var li = document.createElement('li'); li.className = 'info'; li.setAttribute('role', 'presentation'); text(li, msg); el.list.appendChild(li);
  }
  function searchServers(q, silent) {
    var seq = ++searchSeq;
    return getJson('/api/v1/games/' + encodeURIComponent(state.game.id) + '?limit=50&q=' + encodeURIComponent(q || ''))
      .then(function (data) { if (seq === searchSeq && !silent) { renderServers(data); text(el.serverHint, ''); } return data; })
      .catch(function () { if (seq === searchSeq) { text(el.serverHint, 'Could not load servers.'); el.serverHint.className = 'hint error'; } });
  }
  function pickServer(s) {
    state.server = s; el.server.value = s.name; closeList(); text(el.serverHint, ''); scheduleQuote();
  }
  function moveActive(d) {
    var opts = el.list.querySelectorAll('[role=option]');
    if (!opts.length) return;
    if (activeIdx >= 0) opts[activeIdx].setAttribute('aria-selected', 'false');
    activeIdx = (activeIdx + d + opts.length) % opts.length;
    opts[activeIdx].setAttribute('aria-selected', 'true');
    opts[activeIdx].scrollIntoView({ block: 'nearest' });
    el.server.setAttribute('aria-activedescendant', opts[activeIdx].id);
  }

  // ---------- game / init ----------
  function selectGame(id, saved) {
    var g = state.catalog.games.filter(function (x) { return String(x.id) === String(id); })[0] || state.catalog.games[0];
    state.game = g; state.server = null; el.server.value = ''; closeList();
    el.server.disabled = true; el.qty.disabled = true;
    text(el.unit, '(' + g.unit + ')');
    el.qty.min = g.minQuantity; el.qty.max = g.maxQuantity; el.qty.step = 1;
    var q = saved && Number(saved.q);
    state.quantity = q >= g.minQuantity && q <= g.maxQuantity ? q : g.minQuantity;
    el.qty.value = state.quantity; el.qty.disabled = false;
    validQuantity();
    return searchServers('', true).then(function (data) {
      el.server.disabled = false;
      if (saved && saved.s && String(saved.g) === String(g.id)) {
        var found = data && data.servers.filter(function (s) { return String(s.id) === String(saved.s); })[0];
        state.server = found || { id: Number(saved.s), name: saved.sn || 'Server #' + saved.s };
        el.server.value = state.server.name;
      }
      scheduleQuote();
    });
  }
  function init() {
    var saved = load();
    getJson('/api/v1/catalog').then(function (cat) {
      state.catalog = cat;
      el.game.innerHTML = '';
      cat.games.forEach(function (g) { var o = document.createElement('option'); o.value = g.id; text(o, g.name); el.game.appendChild(o); });
      cat.currencies.forEach(function (c) { var o = document.createElement('option'); o.value = c.code; text(o, c.code + ' (' + c.symbol + ')'); el.currency.appendChild(o); });
      var has = function (code) { return cat.currencies.some(function (c) { return c.code === code; }); };
      state.currency = has(saved.c) ? saved.c : has('USD') ? 'USD' : cat.currencies[0].code;
      el.currency.value = state.currency;
      el.game.disabled = false; el.currency.disabled = false;
      var g = cat.games.filter(function (x) { return String(x.id) === String(saved.g); })[0] || cat.games[0];
      el.game.value = g.id;
      return selectGame(g.id, saved);
    }).catch(function () {
      el.game.innerHTML = '<option>Unavailable</option>';
      showMessage('Could not load game data. Please try again later.', true);
    });
  }

  // ---------- events ----------
  el.game.addEventListener('change', function () { selectGame(el.game.value, null); });
  el.currency.addEventListener('change', function () { state.currency = el.currency.value; scheduleQuote(); });
  el.qty.addEventListener('input', function () { state.quantity = el.qty.value === '' ? NaN : Number(el.qty.value); scheduleQuote(); });
  el.server.addEventListener('input', function () {
    state.server = null; scheduleQuote(); clearTimeout(serverTimer);
    serverTimer = setTimeout(function () { searchServers(el.server.value.trim()); }, 250);
  });
  el.server.addEventListener('focus', function () { if (state.game && !state.server) searchServers(el.server.value.trim()); });
  el.server.addEventListener('blur', closeList);
  el.server.addEventListener('keydown', function (ev) {
    if (ev.key === 'ArrowDown') { ev.preventDefault(); moveActive(1); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); moveActive(-1); }
    else if (ev.key === 'Enter' && activeIdx >= 0) { ev.preventDefault(); el.list.querySelectorAll('[role=option]')[activeIdx].dispatchEvent(new MouseEvent('mousedown')); }
    else if (ev.key === 'Escape') closeList();
  });
  el.buy.addEventListener('click', function (ev) { if (el.buy.getAttribute('aria-disabled') === 'true') ev.preventDefault(); });

  init();
})();
