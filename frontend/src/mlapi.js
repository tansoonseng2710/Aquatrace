/* ============================================================
   AquaTrace — online ML API client
   The screening model runs as an online service (folder ml_api/, FastAPI).
   This page:
   1. finds the service: Settings, ?mlapi=<url>, ml_api_config.js, then http://localhost:7860 on a laptop;
   2. downloads the model from it (GET /model-package), so every reading on the map and charts is scored
      with exactly the online model;
   3. asks it directly (POST /predict, /predict/batch) on the Estimation model page.
   If the service cannot be reached, the copy bundled in models/ is used and the page says so.
   ============================================================ */
const ASK_KEYS = ['ph', 'temp', 'conductivity', 'turbidity', 'do'];
const MLAPI = {
  base: '', state: 'idle', health: null, pkg: null, saved: null, evaluation: null, lastMs: null, err: '', tried: [], retries: 0, timer: null,
  candidates(){
    const out = []; const add = u => { u = String(u || '').trim().replace(/\/+$/, ''); if(u && !out.includes(u)) out.push(u); };
    try{ add(new URLSearchParams(location.search).get('mlapi')); }catch(e){}
    try{ add(localStorage.getItem('aquatrace.mlapi')); }catch(e){}
    add(window.AQUATRACE_ML_API);
    const onLaptop = location.protocol === 'file:' || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
    if(onLaptop) add('http://localhost:7860');
    return out;
  },
  isLocal(u){ return /\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(u); },
  async req(base, path, opt = {}){
    const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), opt.timeout || 15000); const t0 = performance.now();
    try{
      const r = await fetch(base + path, {method: opt.body ? 'POST' : 'GET', headers: opt.body ? {'Content-Type': 'application/json'} : {},
        body: opt.body ? JSON.stringify(opt.body) : undefined, signal: ctl.signal, cache: 'no-store'});
      if(!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
      const j = await r.json(); MLAPI.lastMs = performance.now() - t0; return j;
    } finally { clearTimeout(to); }
  },
  async connect(urls, auto){
    clearTimeout(MLAPI.timer); MLAPI.timer = null;
    const list = urls || MLAPI.candidates(); MLAPI.tried = list; MLAPI.err = '';
    if(!list.length){ MLAPI.state = 'unset'; mlApiShow(); await mlApiUseSaved(); return false; }
    if(!auto || MLAPI.state !== 'offline'){ MLAPI.state = 'checking'; mlApiShow(); }   // background retries keep the badge still
    for(const b of list){
      try{
        const h = await MLAPI.req(b, '/health', {timeout: MLAPI.isLocal(b) ? 3000 : 25000});
        if(!h || h.status !== 'ok' || h.service !== 'aquatrace-ml-api') throw new Error('this address is not the AquaTrace ML API');
        const pkg = await MLAPI.req(b, '/model-package', {timeout: 60000});
        MLAPI.base = b; MLAPI.health = h; MLAPI.pkg = pkg; MLAPI.state = 'online'; MLAPI.retries = 0;
        try{ MLAPI.evaluation = await MLAPI.req(b, '/evaluation', {timeout: 15000}); }catch(e){}
        mlApiApply(); mlApiShow(); if(auto) toast('Connected to the ML API: the page now uses the online model'); return true;
      }catch(e){ MLAPI.err = `${b}: ${e.name === 'AbortError' ? 'no answer in time' : e.message}`; }
    }
    MLAPI.base = ''; MLAPI.state = 'offline';
    // Keep trying for a few minutes: the laptop API may still be starting (first run installs FastAPI),
    // and a free cloud server may be asleep and need about a minute to wake.
    if(MLAPI.retries < 12){ MLAPI.retries++; MLAPI.timer = setTimeout(() => MLAPI.connect(urls, true), list.some(u => !MLAPI.isLocal(u)) ? 30000 : 10000); }
    mlApiShow(); await mlApiUseSaved();
    return false;
  },
  predict(readings, compounds){ return MLAPI.req(MLAPI.base, '/predict', {body: {readings, compounds: compounds || null}, timeout: 30000}); },
  batch(items, compounds){ return MLAPI.req(MLAPI.base, '/predict/batch', {body: {items, compounds: compounds || null}, timeout: 90000}); },
};

/* Load the online model into the page (after boot, and again whenever the page reloads its data). */
function mlApiApply(){
  let ch = null; try{ ch = stuChosenPkg(); }catch(e){}   // a version picked on the Select model page
  const online = ch ? ch.via === 'online' : !!(MLAPI.state === 'online' && MLAPI.pkg), pkg = ch ? ch.pkg : (online ? MLAPI.pkg : MLAPI.saved);
  if(!pkg || !S.readings.length) return [];
  const ids = loadModelPackage(pkg);
  for(const id of ids){ S.models[id].via = ch ? ch.via : (online ? 'online' : 'saved'); S.models[id].apiBase = online ? MLAPI.base : ''; }
  rescoreAll();
  try{ stuBars(); }catch(e){}   // AI screening pages (studio.js) may not be ready yet
  if(typeof VIEW !== 'undefined' && ['ml', 'hplc', 'database', 'live', 'upload', 'models', 'results'].includes(VIEW)) renderView(true);
  return ids;
}
/* The copy of the model saved in models/ (and its evaluation), used while the ML API cannot be reached. */
async function mlApiUseSaved(){
  try{
    if(!MLAPI.saved) MLAPI.saved = await getBundled('models/aquatrace_colab_model.json', 'models/aquatrace_colab_model.js', 'AQUATRACE_MODEL', false);
    if(!MLAPI.evaluation) MLAPI.evaluation = await getBundled('models/aquatrace_evaluation.json', 'models/aquatrace_evaluation.js', 'AQUATRACE_EVALUATION', false);
  }catch(e){}
  if(MLAPI.state !== 'online' && !mlModelIds().length) mlApiApply();
  else if(typeof VIEW !== 'undefined' && VIEW === 'ml') renderMlAlgos();
}
function mlModelIds(){ return Object.keys(S.models).filter(c => S.models[c] && S.models[c].external); }
function mlShortName(id){ return (S.compounds[id]?.name || MLAPI.pkg?.models?.[id]?.name || id).replace(' (US model)', ''); }

/* ---------- status: top bar badge, Estimation model page, Settings ---------- */
function mlApiShow(){
  try{ stuBars(); }catch(e){}   // AI screening pages (studio.js) may not be ready yet
  const st = MLAPI.state, b = MLAPI.base, h = MLAPI.health;
  const badge = $('#mlBadge');
  if(badge){
    badge.className = 'mode ' + (st === 'online' ? 'live' : st === 'checking' ? '' : 'demo');
    badge.textContent = st === 'online' ? 'Model: online' : st === 'checking' ? 'Model: connecting…' : 'Model: offline copy';
    badge.title = st === 'online' ? `Screening model served by ${b}` : 'The online ML API is not connected. Click for details.';
  }
  const pill = $('#mlApiPill'), msg = $('#mlApiMsg'), docs = $('#mlApiDocs');
  if(pill){
    pill.className = 'pill ' + (st === 'online' ? 'ok' : st === 'checking' ? '' : 'warn');
    pill.innerHTML = `<span class="dot"></span>${st === 'online' ? 'Online' : st === 'checking' ? 'Connecting…' : st === 'unset' ? 'Not set up' : 'Not reachable'}`;
  }
  if(docs){ docs.hidden = st !== 'online'; if(b) docs.href = b + '/docs'; }
  if(msg){
    msg.innerHTML = st === 'online'
      ? `Connected to <b class="mono">${esc(b)}</b> · model built ${esc(fmtT(Date.parse(h?.model_created || MLAPI.pkg?.created)))} · ${(h?.models || []).length} medicine models · answered in ${Math.round(MLAPI.lastMs || 0)} ms. Every screening score on this site now comes from this model.`
      : st === 'checking' ? `Looking for the ML API at ${MLAPI.tried.map(u => `<span class="mono">${esc(u)}</span>`).join(', ')}…`
      : st === 'unset' ? 'No ML API address set. Add your online address in <a href="#settings">Settings</a>, or start it on this laptop with <span class="mono">run_ml_api_local.bat</span>.'
      : `Could not reach ${MLAPI.tried.map(u => `<span class="mono">${esc(u)}</span>`).join(' or ')}${MLAPI.err ? ` (${esc(MLAPI.err.split(': ').slice(1).join(': '))})` : ''}. `
        + `On this laptop, start it with <span class="mono">run_ml_api_local.bat</span>. A free online server can take about a minute to wake up${MLAPI.timer && MLAPI.retries ? '; trying again automatically' : ''}. `
        + `Until then the page uses the copy of the model saved in <span class="mono">models/</span>.`;
  }
  const set = $('#mlApiSetMsg');
  if(set) set.innerHTML = st === 'online' ? `Connected: <span class="mono">${esc(b)}</span>` : st === 'checking' ? 'Connecting…' : esc(MLAPI.err || 'Not connected');
}

/* ---------- Estimation model page: "Ask the online model" ---------- */
function mlAskPrefill(force){
  const r = typeof latest === 'function' ? latest() : null; if(!r) return;
  for(const k of ASK_KEYS){ const el = $('#ask_' + k); if(!el || (el.value !== '' && !force)) continue;
    const v = r[k]; el.value = v != null && isFinite(v) ? +(+v).toFixed(k === 'conductivity' ? 0 : 2) : ''; }
}
function mlAskRows(results, how){
  const pct = v => (v * 100).toFixed(v < 0.1 ? 1 : 0) + '%';
  const sorted = results.slice().sort((a, b) => (b.ok - a.ok) || ((b.p_high || 0) - (a.p_high || 0)));
  $('#mlAskTable').innerHTML = sorted.map(o => {
    const name = esc(mlShortName(o.compound));
    const sens = (o.sensors_used || []).map(f => esc(PARAMS[f]?.short || PARAMS[f]?.label || f)).join(', ');
    if(!o.ok) return `<tr><td><b>${name}</b></td><td>${sens}</td><td colspan="4" class="muted">${esc(o.message || 'Missing readings')}</td></tr>`;
    const est = o.estimate, unit = est.unit || 'µg/L', f = v => S.compounds[o.compound] ? fmtConc(v, o.compound) : `${(+v).toPrecision(2)} ${unit}`;
    return `<tr><td><b>${name}</b></td><td>${sens}</td><td class="n"><b>${pct(o.p_high)}</b> <span class="tiny">flag at ${pct(o.flag_line)}</span></td>
      <td><span class="pill ${o.flag ? 'bad' : 'ok'}">${o.flag ? 'Send to lab' : 'No test needed'}</span></td>
      <td class="n">${f(est.value)} <span class="tiny">${f(est.low)}–${f(est.high)}</span></td>
      <td><span class="pill ${o.confidence === 'High' ? 'ok' : o.confidence === 'Medium' ? 'warn' : 'bad'}" title="${esc((o.reasons || []).join('; '))}">${esc(o.confidence)}</span></td></tr>`;
  }).join('');
  const n = results.filter(o => o.ok && o.flag).length;
  $('#mlAskMeta').innerHTML = `${how} · ${n ? `<b>${n} of ${results.length}</b> medicines flagged: send this sample to the lab for ${results.filter(o => o.ok && o.flag).map(o => esc(mlShortName(o.compound))).join(', ')}` : 'no medicine flagged: no lab test needed for this sample'}. The level is a rough estimate; the lab result is the reference.`;
}
function mlAskLocal(readings){   // same model, run in this browser: used when the online API is not reachable
  return mlModelIds().map(id => {
    const m = S.models[id]; const missing = m.feats.filter(f => readings[f] == null || !isFinite(readings[f]));
    const base = {compound: id, name: S.compounds[id]?.name, sensors_used: m.feats};
    if(missing.length) return {...base, ok: false, message: 'Needs ' + missing.map(f => PARAMS[f]?.label || f).join(', ')};
    const e = predictWithUncertainty(m, m.feats.map(f => readings[f]));
    return {...base, ok: true, p_high: e.p, flag: e.flag, flag_line: m.pThr, confidence: e.conf, reasons: e.reasons,
      estimate: {value: e.mu, low: e.lo, high: e.hi, unit: S.compounds[id]?.unit || 'µg/L'}};
  });
}
async function mlAsk(){
  const readings = {}; for(const k of ASK_KEYS){ const v = $('#ask_' + k).value; readings[k] = v === '' ? null : +v; }
  if(!ASK_KEYS.some(k => readings[k] != null)) return $('#mlAskMeta').textContent = 'Enter at least one sensor reading.';
  const btn = $('#mlAskBtn'); btn.disabled = true; btn.textContent = 'Asking…';
  try{
    if(MLAPI.state === 'online'){
      try{ const r = await MLAPI.predict(readings); mlAskRows(r.results, `Answered online by <span class="mono">${esc(MLAPI.base)}</span> in ${Math.round(MLAPI.lastMs)} ms`); return; }
      catch(e){ MLAPI.err = `${MLAPI.base}: ${e.message}`; MLAPI.state = 'offline'; mlApiShow(); }
    }
    if(!mlModelIds().length) await loadBundledModel();
    mlAskRows(mlAskLocal(readings), '<span style="color:var(--warn)">Online ML API not reachable: computed in this browser with the saved copy of the same model</span>');
  }catch(e){ $('#mlAskMeta').textContent = 'Could not get an answer: ' + e.message; }
  finally{ btn.disabled = false; btn.textContent = 'Ask the model'; }
}

/* Current reading on the Estimation model page: confirm the in-browser score with the online answer. */
let mlNowKey = '';
async function mlApiNow(comp){
  const el = $('#mlNowApi'); if(!el) return;
  const m = S.models[comp], r = latest();
  if(!m || !m.external || !r){ el.textContent = '–'; return; }
  if(MLAPI.state !== 'online'){ el.innerHTML = '<span class="tiny">not connected: score computed in this browser</span>'; return; }
  const x = m.feats.map(f => r[f]); if(!x.every(v => v != null && isFinite(v))){ el.textContent = 'needs ' + m.feats.join(', '); return; }
  const key = comp + '|' + r.ts; if(key === mlNowKey && el.dataset.done) return; mlNowKey = key;
  el.innerHTML = '<span class="tiny">asking…</span>';
  try{
    const res = (await MLAPI.predict(Object.fromEntries(m.feats.map(f => [f, r[f]])), [comp])).results[0];
    const local = m.final.screen(x), same = Math.abs(local - res.p_high) < 2e-6;
    el.dataset.done = '1';
    el.innerHTML = `<span class="pill ${res.flag ? 'bad' : 'ok'}">${res.flag ? 'Send to lab' : 'No test needed'}</span> <span class="tiny">P(high) ${(res.p_high * 100).toFixed(1)}% · ${Math.round(MLAPI.lastMs)} ms${same ? ' · same as this page ✓' : ' · differs from this page: reload the model'}</span>`;
  }catch(e){ el.innerHTML = `<span class="tiny">online check failed: ${esc(e.message)}</span>`; }
}

/* Check every testing-set lab result through the online model. */
async function mlVerify(){
  const out = $('#mlVerifyMsg');
  if(MLAPI.state !== 'online'){ out.textContent = 'Connect to the online ML API first.'; return; }
  const btn = $('#mlVerify'); btn.disabled = true; out.textContent = 'Sending the testing-set lab results to the online model…';
  try{
    const csv = await getBundled('models/crosscheck_lab_results.csv', 'models/crosscheck_lab_results.js', 'AQUATRACE_CROSSCHECK_CSV', true);
    const rows = Papa.parse(csv, {header: true, skipEmptyLines: true}).data; const t0 = performance.now();
    let n = 0, same = 0, maxd = 0; const cm = {tp: 0, fp: 0, fn: 0, tn: 0}, ref = {tp: 0, fp: 0, fn: 0, tn: 0};
    for(const cid of Object.keys(MLAPI.pkg.models)){
      const m = S.models[cid], pm = MLAPI.pkg.models[cid]; if(!m) continue;
      const R = rows.filter(r => r.compound === cid);
      const items = R.map(r => Object.fromEntries(m.feats.map(f => [f, r[f] === '' || r[f] == null ? null : +r[f]])));
      for(let i = 0; i < items.length; i += 5000){
        const res = (await MLAPI.batch(items.slice(i, i + 5000), [cid])).results;
        res.forEach((o, k) => { const it = items[i + k], row = R[i + k]; if(!o[0].ok) return;
          const d = Math.abs(m.final.screen(m.feats.map(f => it[f])) - o[0].p_high); maxd = Math.max(maxd, d); n++; if(d < 2e-6) same++;
          const high = row.concentration !== '<LOD' && +row.concentration >= pm.threshold, flag = o[0].flag;
          cm[flag ? (high ? 'tp' : 'fp') : (high ? 'fn' : 'tn')]++; });
      }
      for(const k of Object.keys(ref)) ref[k] += +(pm.screen_holdout?.[k] || 0);
      out.textContent = `Checked ${n.toLocaleString()} lab results…`;
    }
    const match = Object.keys(cm).every(k => cm[k] === ref[k]);
    const prec = cm.tp / Math.max(1, cm.tp + cm.fp), base = (cm.tp + cm.fn) / Math.max(1, n);
    out.innerHTML = `<b>${same.toLocaleString()} of ${n.toLocaleString()}</b> testing-set lab results got the same score online as in this page (largest difference ${maxd.toExponential(1)}), in ${((performance.now() - t0) / 1000).toFixed(1)} s. `
      + `Online confusion matrix: TP ${cm.tp} · FP ${cm.fp} · FN ${cm.fn} · TN ${cm.tn.toLocaleString()} ${match ? '<span class="pill ok">same as Colab ✓</span>' : '<span class="pill warn">differs from Colab</span>'} · precision ${(prec * 100).toFixed(0)}% vs ${(base * 100).toFixed(0)}% at random.`;
  }catch(e){ out.textContent = 'Check failed: ' + e.message; }
  finally{ btn.disabled = false; }
}

/* ---------- "Which algorithm? 7 compared" (from GET /evaluation, or the saved copy) ---------- */
function renderMlAlgos(tb = '#mlAlgoTable', noteSel = '#mlAlgoNote'){
  const box = $(tb); if(!box) return;
  const ac = MLAPI.evaluation?.algorithm_comparison;
  if(!ac || !ac.results?.length){ box.innerHTML = '<tr><td colspan="8" class="muted">Comparison not loaded yet.</td></tr>'; return; }
  const max = Math.max(...ac.results.map(r => (r.cv_mAP || 0) + (r.cv_mAP_spread || 0))) * 1.05;
  const pct = v => v == null ? '–' : (v * 100).toFixed(0) + '%', n2 = v => v == null ? '–' : v.toFixed(2);
  box.innerHTML = ac.results.map(r => {
    const dummy = /dummy/i.test(r.algorithm), col = r.chosen ? 'var(--accent)' : dummy ? 'var(--bad)' : 'var(--fg-3)';
    const w = (r.cv_mAP || 0) / max * 100, lo = Math.max(0, (r.cv_mAP - (r.cv_mAP_spread || 0))) / max * 100, hi = (r.cv_mAP + (r.cv_mAP_spread || 0)) / max * 100;
    return `<tr${r.chosen ? ' class="sel"' : ''}><td><b>${esc(r.algorithm)}</b> ${r.chosen ? '<span class="pill ok">chosen</span>' : ''}</td>
      <td style="min-width:200px"><div style="position:relative;height:16px;background:var(--panel-2);border-radius:4px">
        <i style="position:absolute;left:0;top:0;bottom:0;width:${w}%;background:${col};border-radius:4px;opacity:.85"></i>
        <i style="position:absolute;left:${lo}%;width:${hi - lo}%;top:7px;height:2px;background:var(--fg)"></i></div></td>
      <td class="n"><b>${n2(r.cv_mAP)}</b> <span class="tiny">± ${n2(r.cv_mAP_spread)}</span></td>
      <td class="n"${dummy ? ' style="color:var(--bad);font-weight:700"' : ''}>${pct(r.test_accuracy)}</td><td class="n">${pct(r.test_precision)}</td>
      <td class="n">${pct(r.test_recall)}</td><td class="n">${n2(r.test_f1)}</td><td class="n">${n2(r.test_mAP)}</td></tr>`;
  }).join('');
  const src = MLAPI.state === 'online' ? `from the online ML API (<span class="mono">${esc(MLAPI.base)}</span>)` : 'from the saved copy in models/';
  const nt = $(noteSel); if(nt) nt.innerHTML = `${esc(ac.how || '')} Shown ${src}.`;
}

/* ---------- wiring ---------- */
$('#mlBadge')?.addEventListener('click', () => { location.hash = 'ml'; });
$('#mlApiRetry')?.addEventListener('click', () => { MLAPI.retries = 0; MLAPI.connect(); });
$('#mlAlgoJump')?.addEventListener('click', () => $('#mlAlgoPanel')?.scrollIntoView({behavior: 'smooth'}));
$('#mlAskForm')?.addEventListener('submit', e => { e.preventDefault(); mlAsk(); });
$('#mlAskLatest')?.addEventListener('click', () => mlAskPrefill(true));
$('#mlVerify')?.addEventListener('click', mlVerify);
$('#mlApiSave')?.addEventListener('click', () => {
  const u = $('#mlApiUrl').value.trim().replace(/\/+$/, '');
  if(!/^https?:\/\//.test(u)) return $('#mlApiSetMsg').textContent = 'Enter a full address starting with https:// (or http://localhost:7860).';
  try{ localStorage.setItem('aquatrace.mlapi', u); }catch(e){}
  MLAPI.retries = 0; MLAPI.connect([u]);
});
$('#mlApiReset')?.addEventListener('click', () => { try{ localStorage.removeItem('aquatrace.mlapi'); }catch(e){} $('#mlApiUrl').value = ''; MLAPI.retries = 0; MLAPI.connect(); });
function renderMlApiSettings(){ const el = $('#mlApiUrl'); if(!el) return; let saved = ''; try{ saved = localStorage.getItem('aquatrace.mlapi') || ''; }catch(e){}
  el.value = saved; el.placeholder = window.AQUATRACE_ML_API || 'https://your-name-aquatrace-ml-api.hf.space'; mlApiShow(); }
mlApiShow();
MLAPI.connect();
