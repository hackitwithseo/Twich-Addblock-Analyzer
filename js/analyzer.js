/* Twitch chat word analyzer — isolated world content script */
(() => {
  'use strict';
  if (!/(^|\.)twitch\.tv$/.test(location.hostname)) return;

  const VERSION = 'v6';
  if (window.__vtcaVersion === VERSION) return;
  window.__vtcaVersion = VERSION;
  document.querySelectorAll('.vtca-btn, .vtca-panel').forEach((n) => n.remove());

  document.documentElement.dataset.vtcaVersion = VERSION;
  console.info('[vtca] analyzer ' + VERSION);

  const MAX_STORED_WORDS = 400;
  const STOPWORDS = new Set(('a about above after again against all am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just me more most my myself no nor not now of off on once only or other our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours yourself yourselves').split(/\s+/).filter(Boolean));

  const counts = new Map();
  let totalMessages = 0;
  let totalTokens = 0;
  let channel = (location.pathname.split('/').filter(Boolean)[0] || 'unknown').toLowerCase();
  let observer = null;
  let panel = null;
  let chatEl = null;
  let columnEl = null;
  let liveTimer = null;
  let saveTimer = null;
  let placeTimer = null;
  let enabled = true;
  let renderQueued = false;
  let hiddenEls = [];
  const seen = new WeakSet();
  const opts = { topN: 15, skipCommon: false, live: true };

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => Number(n).toLocaleString('en-US');
  const key = () => 'vtca:data:' + channel;
  const TOKEN_RE = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;

  /* ---------------- storage (page localStorage, no extension API) ---------------- */

  function storeGet(k, cb) {
    let data = null;
    try {
      const raw = localStorage.getItem(k);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed) data = { [k]: parsed };
      }
    } catch (e) {}
    cb(data);
  }

  function storeSet(obj) {
    try {
      for (const k in obj) localStorage.setItem(k, JSON.stringify(obj[k]));
    } catch (e) {}
  }

  function storeRemove(k) {
    try { localStorage.removeItem(k); } catch (e) {}
  }

  /* ---------------- enabled flag ---------------- */

  function readEnabled(cb) {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; cb(v); } };
    setTimeout(() => done(true), 400);
    try {
      chrome.storage.local.get({ analyzerEnabled: true }, (cfg) => {
        try {
          if (chrome.runtime.lastError) return done(true);
          done(!cfg || cfg.analyzerEnabled !== false);
        } catch (e) {
          done(true);
        }
      });
    } catch (e) {
      done(true);
    }
  }

  /* ---------------- counting ---------------- */

  function tokenize(text) {
    const out = [];
    const m = text.toLowerCase().match(TOKEN_RE);
    if (!m) return out;
    for (const w of m) if (w.length <= 24) out.push(w);
    return out;
  }

  function recordLine(line) {
    if (!line || seen.has(line)) return;
    seen.add(line);

    const frags = line.querySelectorAll('[data-a-target="chat-line-message-body"] .text-fragment');
    let text = '';
    if (frags.length) {
      frags.forEach((f) => { text += f.textContent + ' '; });
    } else {
      const body = line.querySelector('[data-a-target="chat-line-message-body"]');
      text = body ? body.textContent : '';
    }
    if (!text.trim()) return;

    totalMessages++;
    for (const w of tokenize(text)) {
      counts.set(w, (counts.get(w) || 0) + 1);
      totalTokens++;
    }
    scheduleSave();
    if (panel) scheduleRender();
  }

  function processBacklog() {
    document.querySelectorAll('.chat-line__message').forEach(recordLine);
  }

  function onMutations(muts) {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.classList && n.classList.contains('chat-line__message')) recordLine(n);
        else if (n.querySelectorAll) n.querySelectorAll('.chat-line__message').forEach(recordLine);
      }
    }
  }

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(onMutations);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  /* ---------------- persistence ---------------- */

  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; save(); }, 4000);
  }

  function save() {
    const arr = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_STORED_WORDS);
    storeSet({ [key()]: { m: totalMessages, t: totalTokens, w: arr } });
  }

  function load(done) {
    storeGet(key(), (r) => {
      const d = r ? r[key()] : null;
      if (d) {
        totalMessages = d.m || 0;
        totalTokens = d.t || 0;
        (d.w || []).forEach(([w, c]) => counts.set(w, c));
      }
      if (panel) render();
      if (done) done();
    });
  }

  function reset() {
    counts.clear();
    totalMessages = 0;
    totalTokens = 0;
    storeRemove(key());
    render();
  }

  /* ---------------- button placement ---------------- */

  function ensureButton() {
    if (!enabled) return;
    if (document.querySelector('.vtca-btn')) return;
    const anchor = document.querySelector('[data-test-selector="community-points-summary"]')
      || document.querySelector('[data-a-target="bits-button"]')
      || document.querySelector('.chat-input__buttons-container')
      || document.querySelector('[data-test-selector="chat-input-buttons-container"]');
    if (!anchor) return;
    const btn = makeButton();
    if (anchor.matches('.chat-input__buttons-container, [data-test-selector="chat-input-buttons-container"]')) {
      anchor.appendChild(btn);
    } else {
      anchor.insertAdjacentElement('afterend', btn);
    }
  }

  function makeButton() {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'vtca-btn';
    b.title = 'Analyze chat words';
    b.innerHTML = '<svg viewBox="0 0 20 20" width="13" height="13" aria-hidden="true"><rect x="3" y="9" width="3" height="8" rx="1"></rect><rect x="8.5" y="4" width="3" height="13" rx="1"></rect><rect x="14" y="11" width="3" height="6" rx="1"></rect></svg><span>Analyze</span>';
    b.addEventListener('click', openPanel);
    return b;
  }

  /* ---------------- chat chrome hiding ---------------- */

  function hideChatChrome() {
    const sel = '[data-a-target="chat-collapse-button"], [data-test-selector="chat-collapse-button"], .stream-chat-header, .chat-header, [data-test-selector="chat-room-header"]';
    document.querySelectorAll(sel).forEach((el) => {
      if (el.dataset.vtcaPrev !== undefined) return;
      el.dataset.vtcaPrev = el.style.display || '';
      el.style.display = 'none';
      hiddenEls.push(el);
    });
  }

  function restoreChatChrome() {
    hiddenEls.forEach((el) => {
      el.style.display = el.dataset.vtcaPrev || '';
      delete el.dataset.vtcaPrev;
    });
    hiddenEls = [];
  }

  /* ---------------- panel ---------------- */

  function placePanel() {
    if (!panel) return;
    const target = columnEl || chatEl;
    if (!target) {
      Object.assign(panel.style, { left: 'auto', right: '0px', top: '0px', width: '360px', height: '100vh' });
      return;
    }
    const r = target.getBoundingClientRect();
    if (r.width < 180) {
      Object.assign(panel.style, { left: 'auto', right: '0px', top: '0px', width: '360px', height: '100vh' });
      return;
    }
    Object.assign(panel.style, {
      left: Math.max(0, r.left) + 'px',
      top: Math.max(0, r.top) + 'px',
      width: r.width + 'px',
      height: Math.max(240, r.height) + 'px',
      right: 'auto'
    });
  }

  function openPanel() {
    if (panel) return;
    chatEl = document.querySelector('.chat-shell')
      || document.querySelector('[data-test-selector="chat-room-component-layout"]')
      || document.querySelector('.right-column .chat-room');
    columnEl = chatEl ? chatEl.parentElement : null;

    panel = buildPanel();
    panel.classList.add('vtca-overlay');
    document.body.appendChild(panel);
    placePanel();

    if (chatEl) chatEl.style.display = 'none';
    hideChatChrome();

    window.addEventListener('resize', placePanel);
    document.querySelector('.vtca-btn')?.classList.add('vtca-btn-on');
    render();
    if (opts.live) startLive();
  }

  function closePanel() {
    stopLive();
    window.removeEventListener('resize', placePanel);
    if (panel) panel.remove();
    panel = null;
    if (chatEl) chatEl.style.display = '';
    chatEl = null;
    columnEl = null;
    restoreChatChrome();
    document.querySelector('.vtca-btn')?.classList.remove('vtca-btn-on');
  }

  function buildPanel() {
    const el = document.createElement('div');
    el.className = 'vtca-panel';
    el.innerHTML = `
      <div class="vtca-head">
        <div class="vtca-title">
          <span class="vtca-dot"></span>
          <div class="vtca-titles">
            <strong>Chat word analysis</strong>
            <span class="vtca-channel">#${esc(channel)}</span>
          </div>
        </div>
        <div class="vtca-head-actions">
          <button type="button" class="vtca-ghost" data-act="reset">Reset</button>
          <button type="button" class="vtca-ghost vtca-x" data-act="close" title="Back to chat">&times;</button>
        </div>
      </div>
      <div class="vtca-controls">
        <label class="vtca-check"><input type="checkbox" data-act="live" ${opts.live ? 'checked' : ''}><span>Live</span></label>
        <label class="vtca-check"><input type="checkbox" data-act="skip" ${opts.skipCommon ? 'checked' : ''}><span>Hide common words</span></label>
        <select data-act="top" title="How many words to show">
          <option value="10" ${opts.topN === 10 ? 'selected' : ''}>Top 10</option>
          <option value="15" ${opts.topN === 15 ? 'selected' : ''}>Top 15</option>
          <option value="25" ${opts.topN === 25 ? 'selected' : ''}>Top 25</option>
          <option value="50" ${opts.topN === 50 ? 'selected' : ''}>Top 50</option>
        </select>
      </div>
      <div class="vtca-stats" data-role="stats"></div>
      <div class="vtca-chart" data-role="chart"></div>
      <div class="vtca-foot" data-role="foot"></div>`;

    el.querySelector('[data-act="close"]').addEventListener('click', closePanel);
    el.querySelector('[data-act="reset"]').addEventListener('click', reset);
    el.querySelector('[data-act="live"]').addEventListener('change', (e) => {
      opts.live = e.target.checked;
      opts.live ? startLive() : stopLive();
    });
    el.querySelector('[data-act="skip"]').addEventListener('change', (e) => {
      opts.skipCommon = e.target.checked;
      render();
    });
    el.querySelector('[data-act="top"]').addEventListener('change', (e) => {
      opts.topN = Number(e.target.value) || 15;
      render();
    });

    return el;
  }

  function startLive() {
    stopLive();
    liveTimer = setInterval(render, 1200);
  }

  function stopLive() {
    if (liveTimer) clearInterval(liveTimer);
    liveTimer = null;
  }

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }

  function computeRows() {
    const entries = [];
    let total = 0;
    for (const [w, c] of counts) {
      if (opts.skipCommon && STOPWORDS.has(w)) continue;
      if (w.length < 2 && !/^\d+$/.test(w)) continue;
      entries.push([w, c]);
      total += c;
    }
    entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return { entries, total };
  }

  function render() {
    if (!panel) return;
    const stats = panel.querySelector('[data-role="stats"]');
    const chart = panel.querySelector('[data-role="chart"]');
    const foot = panel.querySelector('[data-role="foot"]');
    const { entries, total } = computeRows();

    const avg = totalMessages ? totalTokens / totalMessages : 0;
    stats.innerHTML =
      `<div class="vtca-stat"><b>${fmt(totalMessages)}</b><span>messages</span></div>` +
      `<div class="vtca-stat"><b>${fmt(totalTokens)}</b><span>words</span></div>` +
      `<div class="vtca-stat"><b>${fmt(counts.size)}</b><span>unique</span></div>` +
      `<div class="vtca-stat"><b>${avg.toFixed(1)}</b><span>per msg</span></div>`;

    if (!entries.length || !total) {
      chart.innerHTML = '<div class="vtca-empty">Waiting for chat&hellip;<br><span>Leave the stream open for a few seconds.</span></div>';
      foot.textContent = '';
      return;
    }

    const top = entries.slice(0, opts.topN);
    const max = top[0][1] || 1;

    chart.innerHTML = top.map(([w, c], i) => {
      const pct = (c / total) * 100;
      const width = (c / max) * 100;
      return `<div class="vtca-row${i < 2 ? ' vtca-row-hot' : ''}">
        <span class="vtca-rank">${i + 1}</span>
        <span class="vtca-word" title="${esc(w)}">${esc(w)}</span>
        <span class="vtca-bar"><i style="width:${width.toFixed(1)}%"></i></span>
        <span class="vtca-pct">${pct.toFixed(1)}%</span>
        <span class="vtca-count">${fmt(c)}</span>
      </div>`;
    }).join('');

    foot.textContent = `Top ${top.length} of ${entries.length} words · ${fmt(total)} counted · ${opts.skipCommon ? 'common words hidden' : 'all words'}`;
  }

  /* ---------------- lifecycle ---------------- */

  function begin() {
    load(() => {
      startObserver();
      processBacklog();
    });
    ensureButton();
    if (!placeTimer) placeTimer = setInterval(ensureButton, 800);
  }

  function boot() {
    readEnabled((on) => {
      enabled = on;
      if (!enabled) return;
      begin();
    });
  }

  function shutdown() {
    if (observer) { observer.disconnect(); observer = null; }
    if (placeTimer) { clearInterval(placeTimer); placeTimer = null; }
    document.querySelector('.vtca-btn')?.remove();
    closePanel();
    restoreChatChrome();
  }

try {
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.vtcaClear) reset();
      if (!changes.analyzerEnabled) return;
      const now = changes.analyzerEnabled.newValue !== false;
      if (now === enabled) return;
      enabled = now;
      now ? boot() : shutdown();
    });
  } catch (e) {}

  // follow channel switches inside the SPA
  setInterval(() => {
    const now = (location.pathname.split('/').filter(Boolean)[0] || '').toLowerCase();
    if (!now || now === channel) return;
    channel = now;
    counts.clear();
    totalMessages = 0;
    totalTokens = 0;
    load(() => {});
    if (panel) render();
  }, 2000);

  boot();
})();