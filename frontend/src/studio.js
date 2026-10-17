/* ============================================================
   AquaTrace — AI screening: ① Live data  ② Upload data  ③ Select model  ④ Results & figures
   Every figure is computed here, in the browser, from the model in use and the 5,248 testing-set
   lab results in models/crosscheck_lab_results.csv, so the numbers always match the loaded model.
   ============================================================ */
const STU = { uploads: [], activeId: null, off: new Set(), cross: null, evalKey: '', evalData: null, up: null, liveMed: '', resMed: 'ALL', upMed: '' };
try{ STU.off = new Set(JSON.parse(localStorage.getItem('aquatrace.medsOff') || '[]')); }catch(e){}
try{ STU.uploads = JSON.parse(localStorage.getItem('aquatrace.models') || '[]'); }catch(e){}
try{ STU.activeId = localStorage.getItem('aquatrace.activeModel') || null; }catch(e){}
const MED_COL = ['#0f7a8c', '#d0661f', '#2e8b57', '#8a55c4', '#c79100', '#c0392b'];
const SENSOR_KEYS = ['ph', 'temp', 'conductivity', 'turbidity', 'do'];
const stuShort = id => (S.compounds[id]?.name || id).replace(' (US model)', '');
const stuPct = (v, d = 0) => v == null || !isFinite(v) ? '–' : (v * 100).toFixed(d) + '%';
const stuSafe = (k, v) => { try{ v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); return true; }catch(e){ return false; } };

/* ---------- model versions (like model versions in Roboflow) ---------- */
function stuPackages(){
  const out = [];
  if(MLAPI.pkg) out.push({id: 'online', name: 'Online ML API', source: 'online', pkg: MLAPI.pkg, where: MLAPI.base || 'last connection'});
  if(MLAPI.saved) out.push({id: 'saved', name: 'Saved copy', source: 'saved', pkg: MLAPI.saved, where: 'models/ folder of the website'});
  for(const u of STU.uploads) out.push({id: u.id, name: u.name, source: 'upload', pkg: u.pkg, where: 'uploaded ' + fmtT(u.addedAt)});
  return out;
}
function stuActiveEntry(){
  const L = stuPackages();
  return L.find(e => e.id === STU.activeId) || L.find(e => e.id === (MLAPI.state === 'online' ? 'online' : 'saved')) || L[0] || null;
}
function stuChosenPkg(){   // used by mlApiApply(): the version the user picked, if any
  if(!STU.activeId) return null;
  const e = stuPackages().find(x => x.id === STU.activeId); if(!e) return null;
  return {pkg: e.pkg, via: e.source === 'online' ? (MLAPI.state === 'online' ? 'online' : 'saved') : e.source};
}
function stuEngine(){
  const e = stuActiveEntry();
  return MLAPI.state === 'online' && MLAPI.pkg && e && e.pkg.created === MLAPI.pkg.created ? 'api' : 'browser';
}
function stuIds(){ return mlModelIds().filter(id => !STU.off.has(id)); }
function stuActivate(id){
  STU.activeId = id; stuSafe('aquatrace.activeModel', id);
  const e = stuPackages().find(x => x.id === id); if(!e) return;
  for(const old of mlModelIds()) if(!e.pkg.models[old]){ delete S.models[old]; delete S.compounds[old]; }
  mlApiApply(); STU.evalKey = ''; stuBars();
  toast(`Now using: ${e.name} (built ${fmtT(Date.parse(e.pkg.created))})`);
  renderView(true);
}
function stuBars(){
  const e = stuActiveEntry(), ids = mlModelIds(), on = stuIds(), eng = stuEngine();
  const html = !e ? '<span class="muted">No model loaded yet.</span>' :
    `<span>🧠 Model in use: <b>${esc(e.name)}</b> · built ${esc(fmtT(Date.parse(e.pkg.created)))}</span><span>Random forest (chosen from 7)</span>`
    + `<span>${on.length} of ${ids.length} medicines on</span>`
    + `<span>Runs: <span class="pill ${eng === 'api' ? 'ok' : 'warn'}">${eng === 'api' ? 'online ML API' : 'in this browser'}</span></span><a href="#models">Change model</a>`;
  for(const s of ['#liveModelBar', '#upModelBar', '#resModelBar']){ const el = $(s); if(el) el.innerHTML = html; }
  const w = $('#waysNote'); if(w) w.innerHTML = e ? `Model in use: ${esc(e.name)} · ${eng === 'api' ? 'online' : 'in this browser'}` : '';
}

/* ---------- predictions ---------- */
function stuLocal(rd, ids){
  return ids.map(id => {
    const m = S.models[id]; const miss = m.feats.filter(f => rd[f] == null || !isFinite(rd[f]));
    const base = {compound: id, sensors_used: m.feats};
    if(miss.length) return {...base, ok: false, message: 'Needs ' + miss.map(f => PARAMS[f]?.short || PARAMS[f]?.label || f).join(', ')};
    const e = predictWithUncertainty(m, m.feats.map(f => rd[f]));
    return {...base, ok: true, p_high: e.p, flag: e.flag, flag_line: m.pThr, confidence: e.conf, reasons: e.reasons,
      estimate: {value: e.mu, low: e.lo, high: e.hi, unit: S.compounds[id]?.unit || 'µg/L'}};
  });
}
async function stuPredictMany(items, ids, onProgress){
  if(stuEngine() === 'api'){
    try{
      const out = [];
      for(let i = 0; i < items.length; i += 5000){ out.push(...(await MLAPI.batch(items.slice(i, i + 5000), ids)).results); onProgress && onProgress(out.length); }
      return {res: out, how: 'api'};
    }catch(e){ toast('Online ML API failed (' + e.message + '): using this browser instead'); }
  }
  const out = [];
  for(let i = 0; i < items.length; i++){ out.push(stuLocal(items[i], ids)); if(i % 400 === 399){ onProgress && onProgress(i + 1); await new Promise(r => setTimeout(r, 0)); } }
  return {res: out, how: 'browser'};
}

/* ---------- metrics (same formulas as the Colab notebook / scikit-learn) ---------- */
function stuCurves(y, p){
  const idx = [...p.keys()].sort((a, b) => p[b] - p[a]); const P = y.filter(Boolean).length, N = y.length - P;
  let tp = 0, fp = 0, ap = 0, prevR = 0, auc = 0, pF = 0, pT = 0; const pr = [], roc = [[0, 0]];
  for(let k = 0; k < idx.length;){
    const s = p[idx[k]];
    while(k < idx.length && p[idx[k]] === s){ if(y[idx[k]]) tp++; else fp++; k++; }
    const prec = tp / (tp + fp), rec = P ? tp / P : 0, fpr = N ? fp / N : 0;
    ap += (rec - prevR) * prec; prevR = rec; pr.push([rec, prec]);
    auc += (fpr - pF) * (rec + pT) / 2; pF = fpr; pT = rec; roc.push([fpr, rec]);
  }
  return {ap, auc, pr, roc};
}
function stuCm(y, f){
  let tp = 0, fp = 0, fn = 0, tn = 0; y.forEach((h, i) => { if(f[i]){ h ? tp++ : fp++; } else { h ? fn++ : tn++; } });
  return {tp, fp, fn, tn};
}
function stuScores(c){
  const n = c.tp + c.fp + c.fn + c.tn, P = c.tp + c.fp ? c.tp / (c.tp + c.fp) : 0, R = c.tp + c.fn ? c.tp / (c.tp + c.fn) : 0;
  const b = (c.tp + c.fn) / n, f = (c.tp + c.fp) / n;
  return {n, precision: P, recall: R, f1: P + R ? 2 * P * R / (P + R) : 0, accuracy: (c.tp + c.tn) / n, base: b,
    rand: {accuracy: f * b + (1 - f) * (1 - b), precision: b, recall: f, f1: b + f ? 2 * b * f / (b + f) : 0}};
}
const thin = (pts, k = 260) => pts.length <= k ? pts : pts.filter((_, i) => i % Math.ceil(pts.length / k) === 0 || i === pts.length - 1);

/* ---------- testing-set lab results, scored with the model in use ---------- */
async function stuCross(){
  if(!STU.cross){
    const csv = await getBundled('models/crosscheck_lab_results.csv', 'models/crosscheck_lab_results.js', 'AQUATRACE_CROSSCHECK_CSV', true);
    STU.cross = Papa.parse(csv, {header: true, skipEmptyLines: true}).data;
  }
  return STU.cross;
}
async function stuEvaluate(){
  const ids = mlModelIds(); const e = stuActiveEntry();
  const key = (e?.pkg.created || '') + '|' + ids.join(',');
  if(STU.evalData && STU.evalKey === key) return STU.evalData;
  const rows = await stuCross(); const per = {};
  for(const id of ids){
    const m = S.models[id]; const y = [], p = [], f = [], real = [], below = [], pred = [];
    for(const r of rows){
      if(r.compound !== id) continue;
      const x = m.feats.map(k => r[k] === '' || r[k] == null ? NaN : +r[k]); if(!x.every(isFinite)) continue;
      const isBelow = r.concentration === '<LOD'; const conc = isBelow ? (+r.lod || 0) / 2 : +r.concentration;
      const pv = m.final.screen(x);
      y.push(!isBelow && conc >= m.threshold); p.push(pv); f.push(pv >= m.pThr); real.push(conc); below.push(isBelow); pred.push(m.final.predict(x));
    }
    const cm = stuCm(y, f), cur = stuCurves(y, p);
    const det = below.map((b, i) => b ? -1 : i).filter(i => i >= 0);
    const within2 = det.filter(i => Math.abs(Math.log10(pred[i] / real[i])) <= Math.log10(2)).length / Math.max(1, det.length);
    per[id] = {y, p, f, real, below, pred, cm, ...stuScores(cm), ap: cur.ap, auc: cur.auc, pr: cur.pr, roc: cur.roc, within2, nDet: det.length};
  }
  const sum = k => ids.reduce((s, id) => s + per[id].cm[k], 0);
  const pooled = {tp: sum('tp'), fp: sum('fp'), fn: sum('fn'), tn: sum('tn')};
  STU.evalData = {ids, per, pooled, all: stuScores(pooled), mAP: ids.reduce((s, id) => s + per[id].ap, 0) / ids.length,
    rmAP: ids.reduce((s, id) => s + per[id].base, 0) / ids.length, mAUC: ids.reduce((s, id) => s + per[id].auc, 0) / ids.length};
  STU.evalKey = key;
  return STU.evalData;
}

/* ---------- small drawing helpers ---------- */
function stuGauge(label, v, rv, fmt, cap){
  const pt = (t, r) => [60 + r * Math.cos(Math.PI * (1 - t)), 62 - r * Math.sin(Math.PI * (1 - t))];
  const arc = (t1, r) => { const [x0, y0] = pt(0, r), [x1, y1] = pt(Math.max(0.002, Math.min(1, t1)), r); return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`; };
  const [a0, b0] = pt(rv, 38), [a1, b1] = pt(rv, 58);
  return `<div class="gauge"><svg viewBox="0 0 120 68" role="img" aria-label="${label} ${fmt(v)}, random picks ${fmt(rv)}">
    <path d="${arc(1, 48)}" stroke="var(--panel-2)" stroke-width="11" fill="none" stroke-linecap="round"/>
    <path d="${arc(v, 48)}" stroke="var(--accent)" stroke-width="11" fill="none" stroke-linecap="round"/>
    <line x1="${a0.toFixed(1)}" y1="${b0.toFixed(1)}" x2="${a1.toFixed(1)}" y2="${b1.toFixed(1)}" stroke="var(--bad)" stroke-width="2.6" stroke-linecap="round"/></svg>
    <b>${fmt(v)}</b><span>${label}</span><i>random ${fmt(rv)} · ${cap}</i></div>`;
}
function stuCmHtml(c){
  return `<div class="cm"><span></span><span class="h">Lab says HIGH</span><span class="h">Lab says LOW</span>
    <span class="r">Model flags<br>"send to lab"</span><div class="c tp"><small>True positive</small><b>${c.tp.toLocaleString()}</b><small>correct flag</small></div><div class="c fp"><small>False positive</small><b>${c.fp.toLocaleString()}</b><small>false alarm</small></div>
    <span class="r">Model does<br>not flag</span><div class="c fn"><small>False negative</small><b>${c.fn.toLocaleString()}</b><small>missed</small></div><div class="c tn"><small>True negative</small><b>${c.tn.toLocaleString()}</b><small>correctly skipped</small></div></div>`;
}
function stuMeter(p, thr){ return `<div class="meter" title="chance ${stuPct(p, 0)}, flag line ${stuPct(thr, 0)}"><i style="width:${Math.max(1, p * 100)}%;background:${p >= thr ? 'var(--bad)' : 'var(--accent)'}"></i><u style="left:${thr * 100}%"></u></div>`; }
function stuDownload(name, text, type = 'text/csv'){
  try{ const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], {type})); a.download = name; document.body.appendChild(a); a.click(); a.remove(); }
  catch(e){ copyText(text); toast('Download blocked: copied to the clipboard instead'); }
}
const logAxis = (title) => ({type: 'logarithmic', title: {display: true, text: title, color: css('--fg-2')}, ticks: {color: css('--fg-3'), maxTicksLimit: 8, callback: v => { const l = Math.log10(v); return Math.abs(l - Math.round(l)) < 1e-6 ? (+v).toPrecision(1).replace(/\.0+$/, '') : ''; }}, grid: {color: css('--line-2')}});
const linAxis = (title, min, max) => ({type: 'linear', min, max, title: {display: true, text: title, color: css('--fg-2')}, ticks: {color: css('--fg-3')}, grid: {color: css('--line-2')}});

/* Predicted vs real level, and predicted chance vs real level (shared by Results and Upload) */
function stuDrawPvr(canvasId, groups){   // groups: [{label, color, real[], pred[]}]
  const all = groups.flatMap(g => g.real.concat(g.pred)).filter(v => v > 0);
  if(!all.length){ chart(canvasId, {type: 'scatter', data: {datasets: []}, options: baseOpts()}); return; }
  const lo = Math.min(...all) * 0.7, hi = Math.max(...all) * 1.4;
  const ds = groups.map(g => ({label: g.label, data: g.real.map((r, i) => ({x: r, y: g.pred[i]})).filter(d => d.x > 0 && d.y > 0), backgroundColor: g.color + 'AA', borderColor: g.color, pointRadius: 2.6}));
  const line = (k, dash, label) => ({type: 'line', label, data: [{x: lo, y: lo * k}, {x: hi, y: hi * k}], borderColor: css('--fg-3'), borderDash: dash, borderWidth: 1.2, pointRadius: 0});
  ds.push(line(1, [6, 4], 'perfect (1:1)'), line(2, [2, 3], '2× off'), line(0.5, [2, 3], '½ off'));
  chart(canvasId, {type: 'scatter', data: {datasets: ds}, options: baseOpts({interaction: {mode: 'nearest', intersect: true},
    plugins: {legend: {labels: {filter: it => !/off$/.test(it.text)}}, tooltip: {callbacks: {label: c => c.dataset.type === 'line' ? c.dataset.label : `${c.dataset.label}: real ${(+c.raw.x).toPrecision(3)}, predicted ${(+c.raw.y).toPrecision(3)} µg/L`}}},
    scales: {x: {...logAxis('Real level, lab-measured (µg/L)'), min: lo, max: hi}, y: {...logAxis('Predicted level (µg/L)'), min: lo, max: hi}}})});
}
function stuDrawPvc(canvasId, pts, opt){  // pts: [{x, y, kind:'flag'|'ok'|'below', label}], opt: {vx, hy, xTitle, yTitle, yMax}
  const xs = pts.map(p => p.x).filter(v => v > 0); if(!xs.length){ chart(canvasId, {type: 'scatter', data: {datasets: []}, options: baseOpts()}); return; }
  const lo = Math.min(...xs) * 0.7, hi = Math.max(...xs) * 1.4, ymax = opt.yMax || 1;
  const kinds = [['flag', 'flagged: send to lab', css('--bad')], ['ok', 'detected, not flagged', css('--accent')], ['below', 'not detected by the lab', css('--fg-3')]];
  const ds = kinds.map(([k, label, col]) => ({label, data: pts.filter(p => p.kind === k && p.x > 0), backgroundColor: col + (k === 'below' ? '66' : 'BB'), borderColor: col, pointRadius: k === 'below' ? 2 : 2.8, pointStyle: k === 'below' ? 'triangle' : 'circle'}));
  ds.push({type: 'line', label: '"high" level', data: [{x: opt.vx, y: 0}, {x: opt.vx, y: ymax}], borderColor: css('--ok'), borderWidth: 1.6, pointRadius: 0},
          {type: 'line', label: 'flag line', data: [{x: lo, y: opt.hy}, {x: hi, y: opt.hy}], borderColor: css('--fg'), borderDash: [5, 4], borderWidth: 1.2, pointRadius: 0});
  chart(canvasId, {type: 'scatter', data: {datasets: ds}, options: baseOpts({interaction: {mode: 'nearest', intersect: true},
    plugins: {tooltip: {callbacks: {label: c => c.dataset.type === 'line' ? c.dataset.label : opt.yScale ? `${c.raw.label || ''} ${(+c.raw.x).toFixed(2)}× the high level, ${c.raw.y.toFixed(2)}× the flag line` : `real ${(+c.raw.x).toPrecision(3)} µg/L, chance ${(c.raw.y * 100).toFixed(0)}%`}}},
    scales: {x: {...logAxis(opt.xTitle), min: lo, max: hi}, y: linAxis(opt.yTitle, 0, ymax)}})});
}

/* ============================================================ ① LIVE DATA */
function renderLive(full){
  stuBars();
  if(full){
    const sel = $('#liveBoat'); const boats = [...S.fleet.values()];
    sel.innerHTML = boats.length ? boats.map(b => `<option value="${esc(b.id)}" ${b.id === S.follow ? 'selected' : ''}>${esc(b.name || b.id)}</option>`).join('') : '<option>Survey boat</option>';
    sel.disabled = !boats.length;
    const ids = stuIds(); const ms = $('#liveMed');
    if(!ids.includes(STU.liveMed)) STU.liveMed = ids[0] || '';
    ms.innerHTML = ids.map(id => `<option value="${id}" ${id === STU.liveMed ? 'selected' : ''}>${esc(stuShort(id))}</option>`).join('');
  }
  const r = latest(); const ids = stuIds();
  if(!r){ $('#liveCards').innerHTML = '<div class="empty">Waiting for the first reading…</div>'; return; }
  $('#liveWhen').textContent = `${fmtT(r.ts)} · ${r.lat?.toFixed(4)}° N, ${r.lon?.toFixed(4)}° E · ${followName()}`;
  $('#liveSensors').innerHTML = ['ph', 'temp', 'conductivity', 'turbidity', 'do', 'uv', 'orp'].filter(k => r[k] != null && isFinite(r[k]))
    .map(k => `<div><span>${esc(PARAMS[k].label)}</span><b>${fmtNum(r[k], PARAMS[k].dp)}<small style="font-size:12px;font-weight:600;color:var(--fg-3)"> ${esc(PARAMS[k].unit)}</small></b></div>`).join('');
  if(!ids.length){ $('#liveCards').innerHTML = '<div class="empty">No model loaded, or every medicine is switched off. Go to <a href="#models">Select model</a>.</div>'; return; }
  const cards = ids.map(id => {
    const m = S.models[id], e = r.est?.[id];
    if(!e) return `<div class="mcard"><b>${esc(stuShort(id))}</b><span class="small muted">Needs ${m.feats.map(f => esc(PARAMS[f]?.short || PARAMS[f]?.label || f)).join(', ')}: this sensor is not reporting it.</span></div>`;
    return `<div class="mcard ${e.flag ? 'flag' : ''}"><div class="flowrow"><b style="font-size:16px">${esc(stuShort(id))}</b><span class="sp"></span><span class="pill ${e.flag ? 'bad' : 'ok'}">${e.flag ? 'Send to lab' : 'No test needed'}</span></div>
      <div class="flowrow"><span class="big">${stuPct(e.p)}</span><span class="small muted">chance of "high" · flag at ${stuPct(m.pThr)}</span></div>${stuMeter(e.p, m.pThr)}
      <div class="small">Level: <b>${fmtConc(e.mu, id)}</b> <span class="muted">(${fmtConc(e.lo, id)}–${fmtConc(e.hi, id)})</span></div>
      <div class="small">Confidence: <span class="pill ${e.conf === 'High' ? 'ok' : e.conf === 'Medium' ? 'warn' : 'bad'}" title="${esc(e.reasons.join('; '))}">${e.conf}</span> <span class="tiny">${esc(e.outside?.length ? 'outside training range: ' + e.outside.map(f => PARAMS[f]?.short || f).join(', ') : 'sensors: ' + m.feats.map(f => PARAMS[f]?.short || PARAMS[f]?.label || f).join(', '))}</span></div></div>`;
  });
  $('#liveCards').innerHTML = cards.join('');
  const nFlag = ids.filter(id => r.est?.[id]?.flag).length;
  $('#liveNote').innerHTML = nFlag ? `<b style="color:var(--bad)">${nFlag} medicine${nFlag > 1 ? 's' : ''} flagged: take a water sample here for the lab</b>` : 'No medicine flagged at this reading';
  // chance over time for one medicine
  const id = STU.liveMed, m = S.models[id];
  if(m){
    const pts = S.readings.slice(-240).filter(x => x.est?.[id]);
    const t0 = pts[0]?.ts, t1 = pts[pts.length - 1]?.ts;
    chart('liveChart', {type: 'line', data: {datasets: [
      {label: `Chance of "high": ${stuShort(id)}`, data: pts.map(x => ({x: x.ts, y: x.est[id].p * 100})), borderColor: css('--accent'), backgroundColor: css('--accent-soft'), fill: true, pointRadius: 0, borderWidth: 2, tension: .2},
      {label: 'Flag line', data: [{x: t0, y: m.pThr * 100}, {x: t1, y: m.pThr * 100}], borderColor: css('--bad'), borderDash: [6, 4], borderWidth: 1.4, pointRadius: 0}]},
      options: baseOpts({plugins: {tooltip: {callbacks: {label: c => `${c.dataset.label}: ${c.raw.y.toFixed(0)}%`}}},
        scales: {x: {type: 'linear', min: t0, max: t1, ticks: {...timeTicks, color: css('--fg-3'), maxTicksLimit: 6}, grid: {display: false}}, y: {min: 0, max: 100, ticks: {color: css('--fg-3'), callback: v => v + '%'}, grid: {color: css('--line-2')}}}})});
  }
  // where to take lab samples: the most recent readings that were flagged
  const since = (S.simNow || Date.now()) - 24 * 3600e3;
  const hits = S.readings.filter(x => x.ts >= since && ids.some(i => x.est?.[i]?.flag)).slice(-400);
  const groups = []; for(const x of hits){ const g = groups[groups.length - 1]; if(g && x.ts - g.end < 20 * 60e3){ g.end = x.ts; g.n++; ids.forEach(i => { if(x.est?.[i]?.flag) g.meds.add(i); }); } else groups.push({start: x.ts, end: x.ts, n: 1, lat: x.lat, lon: x.lon, meds: new Set(ids.filter(i => x.est?.[i]?.flag))}); }
  $('#liveAlertsNote').textContent = `${groups.length} stretch${groups.length === 1 ? '' : 'es'} flagged in the last 24 h`;
  $('#liveAlerts').innerHTML = groups.length ? groups.slice(-8).reverse().map(g => `<div class="alertrow"><span class="pill bad">Send to lab</span><div><b>${[...g.meds].map(stuShort).map(esc).join(', ')}</b><div class="tiny">${fmtT(g.start)}${g.n > 1 ? ` – ${fmtTime(g.end)} · ${g.n} readings` : ''} · ${g.lat?.toFixed(4)}° N, ${g.lon?.toFixed(4)}° E</div></div></div>`).join('')
    : '<div class="empty">No reading flagged in the last 24 hours.</div>';
}
$('#liveBoat')?.addEventListener('change', e => { if(typeof followBoat === 'function' && S.fleet.has(e.target.value)) followBoat(e.target.value); renderLive(true); });
$('#liveMed')?.addEventListener('change', e => { STU.liveMed = e.target.value; renderLive(false); });

/* ============================================================ ② UPLOAD DATA */
const UP_COLS = {ph: ['ph', 'p_h'], temp: ['temp', 'temperature', 'temp_c', 'temperature_c', 'water_temp', 'water_temperature', 't'],
  conductivity: ['conductivity', 'cond', 'ec', 'conductivity_uscm', 'conductivity_us_cm', 'spc', 'specific_conductance'],
  turbidity: ['turbidity', 'turb', 'ntu', 'turbidity_ntu'], do: ['do', 'dissolved_oxygen', 'do_mgl', 'do_mg_l', 'oxygen', 'dissolved_o2'],
  sample_id: ['sample_id', 'id', 'sample', 'name', 'site'], timestamp: ['timestamp', 'time', 'date', 'datetime'], lat: ['lat', 'latitude'], lon: ['lon', 'lng', 'longitude'],
  compound: ['compound', 'medicine', 'analyte'], concentration: ['concentration', 'conc', 'lab_result', 'result'], lod: ['lod', 'detection_limit'], unit: ['unit', 'units']};
const UP_TPL = 'sample_id,timestamp,lat,lon,ph,temp,conductivity,turbidity,do\nS-001,2026-10-17T09:00,5.4140,100.3310,7.4,29.0,350,12,6.5\nS-002,2026-10-17T09:20,5.4105,100.3392,7.1,29.5,1400,45,2.8\n'
  + '\n# Optional, to check the model against your lab: add two columns, compound (e.g. CBZ-US or Carbamazepine) and concentration (µg/L, or <LOD)\n';
const UP_EX = [['EX-01 Sungai Pinang upstream (example)', 5.4182, 100.3105, 7.4, 27.5, 120, 8, 7.2], ['EX-02 below a sewage outfall (example)', 5.4121, 100.3297, 7.1, 29.0, 1400, 45, 2.8],
  ['EX-03 hospital drain (example)', 5.4150, 100.3240, 7.0, 30.0, 950, 60, 1.5], ['EX-04 river mouth, mixed water (example)', 5.4065, 100.3420, 7.6, 29.5, 8000, 20, 4.5],
  ['EX-05 fish farm, coast (example)', 5.3905, 100.3560, 7.8, 29.0, 30000, 15, 5.0], ['EX-06 Penang Strait, seawater (example)', 5.4010, 100.3700, 8.0, 30.0, 50000, 12, 6.0]];
function upMatchCompound(v){
  const s = String(v || '').trim().toLowerCase(); if(!s) return null;
  const ids = mlModelIds();
  return ids.find(id => id.toLowerCase() === s) || ids.find(id => stuShort(id).toLowerCase() === s) || ids.find(id => s.includes(stuShort(id).toLowerCase()) || (s === 'acetaminophen' && id === 'PCM-US')) || null;
}
function upParse(text, name){
  const P = Papa.parse(text.split('\n').filter(l => !/^\s*#/.test(l)).join('\n'), {header: true, skipEmptyLines: true});
  const hdr = P.meta.fields || []; const map = {};
  for(const h of hdr){ const k = h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''); for(const [key, al] of Object.entries(UP_COLS)) if(!map[key] && al.includes(k)) map[key] = h; }
  const sensors = SENSOR_KEYS.filter(k => map[k]);
  if(!sensors.length) throw new Error('No sensor columns found. Name them ph, temp, conductivity, turbidity, do (see the template).');
  const evalMode = !!(map.compound && map.concentration);
  const num = v => { if(v == null || v === '') return null; const x = +String(v).replace(',', '.'); return isFinite(x) ? x : null; };
  const rows = P.data.map((r, i) => {
    const rd = {}; for(const k of SENSOR_KEYS) rd[k] = map[k] ? num(r[map[k]]) : null;
    const o = {i, raw: r, rd, id: map.sample_id ? r[map.sample_id] : `row ${i + 1}`, ts: map.timestamp ? r[map.timestamp] : '', lat: map.lat ? num(r[map.lat]) : null, lon: map.lon ? num(r[map.lon]) : null};
    if(evalMode){
      o.cid = upMatchCompound(r[map.compound]); const cv = String(r[map.concentration] ?? '').trim();
      let fac = 1; const u = map.unit ? String(r[map.unit] || '').toLowerCase() : ''; if(u.includes('ng')) fac = 1e-3; else if(u.includes('mg')) fac = 1e3;
      o.below = /lod|^</i.test(cv) || cv === ''; o.conc = o.below ? (num(map.lod ? r[map.lod] : null) || 0) * fac / 2 : num(cv) * fac;
    }
    return o;
  });
  return {name, rows, evalMode, map, sensors, hdr};
}
async function upRun(data){
  STU.up = data; const ids = stuIds(); const st = $('#upStatus');
  if(!ids.length){ st.textContent = 'No model loaded, or every medicine is switched off (Select model).'; return; }
  st.textContent = `Screening ${data.rows.length.toLocaleString()} rows…`; const t0 = performance.now(); let how = 'browser';
  if(data.evalMode){
    for(const id of ids){
      const R = data.rows.filter(r => r.cid === id); if(!R.length) continue;
      const out = await stuPredictMany(R.map(r => r.rd), [id], n => st.textContent = `${stuShort(id)}: ${n.toLocaleString()} of ${R.length.toLocaleString()}…`);
      how = out.how; R.forEach((r, k) => { r.res = out.res[k][0]; });
    }
  } else {
    const out = await stuPredictMany(data.rows.map(r => r.rd), ids, n => st.textContent = `${n.toLocaleString()} of ${data.rows.length.toLocaleString()} rows…`);
    how = out.how; data.rows.forEach((r, k) => { r.resAll = out.res[k]; });
  }
  data.ids = ids; data.how = how; data.secs = (performance.now() - t0) / 1000;
  st.innerHTML = `Done: ${data.rows.length.toLocaleString()} rows in ${data.secs.toFixed(1)} s, ${how === 'api' ? 'by the <b>online ML API</b>' : 'in this browser'}.`;
  renderUpload(true);
}
function renderUpload(full){
  stuBars();
  const d = STU.up; $('#upOut').hidden = !d || !d.ids; if(!d || !d.ids) return;
  const ids = d.ids;
  if(d.evalMode){
    const R = d.rows.filter(r => r.res && r.res.ok); const used = [...new Set(R.map(r => r.cid))];
    const unknown = d.rows.filter(r => !r.cid).length;
    const kv = [['Rows', d.rows.length.toLocaleString()], ['Checked against the lab', R.length.toLocaleString()], ['Flagged: send to lab', R.filter(r => r.res.flag).length.toLocaleString()],
      ['Lab says high', R.filter(r => !r.below && r.conc >= S.models[r.cid].threshold).length.toLocaleString()], ['Medicines', used.length]];
    $('#upKv').innerHTML = kv.map(([a, b]) => `<div><span>${a}</span><b>${b}</b></div>`).join('') + (unknown ? `<div><span>Unknown compound</span><b>${unknown}</b></div>` : '');
    $('#upEvalPanel').hidden = !R.length;
    if(!used.includes(STU.upMed)) STU.upMed = 'ALL';
    $('#upMed').innerHTML = `<option value="ALL">All medicines</option>` + used.map(id => `<option value="${id}" ${id === STU.upMed ? 'selected' : ''}>${esc(stuShort(id))}</option>`).join('');
    const sel = STU.upMed === 'ALL' ? R : R.filter(r => r.cid === STU.upMed);
    const y = sel.map(r => !r.below && r.conc >= S.models[r.cid].threshold), f = sel.map(r => r.res.flag), p = sel.map(r => r.res.p_high);
    const cm = stuCm(y, f), sc = stuScores(cm), cur = stuCurves(y, p);
    $('#upCm').innerHTML = stuCmHtml(cm) + `<div class="small" style="margin-top:10px">Precision <b>${stuPct(sc.precision)}</b> vs ${stuPct(sc.rand.precision)} at random (<b>${sc.rand.precision ? (sc.precision / sc.rand.precision).toFixed(1) : '–'}×</b>) · recall ${stuPct(sc.recall)} · ROC-AUC ${y.some(Boolean) && y.some(v => !v) ? cur.auc.toFixed(2) : '–'}</div>`;
    $('#upEvalTable').innerHTML = used.map(id => { const Q = R.filter(r => r.cid === id); const yy = Q.map(r => !r.below && r.conc >= S.models[id].threshold), ff = Q.map(r => r.res.flag);
      const c = stuCm(yy, ff), s = stuScores(c), a = stuCurves(yy, Q.map(r => r.res.p_high));
      return `<tr><td><b>${esc(stuShort(id))}</b></td><td class="n">${Q.length}</td><td class="n">${c.tp}</td><td class="n">${c.fp}</td><td class="n">${c.fn}</td><td class="n">${c.tn}</td><td class="n"><b>${stuPct(s.precision)}</b> <span class="tiny">vs ${stuPct(s.base)}</span></td><td class="n">${stuPct(s.recall)}</td><td class="n">${yy.some(Boolean) && yy.some(v => !v) ? a.auc.toFixed(2) : '–'}</td></tr>`; }).join('');
    const groups = (STU.upMed === 'ALL' ? used : [STU.upMed]).map((id, i) => { const Q = sel.filter(r => r.cid === id && !r.below && r.conc > 0); return {label: stuShort(id), color: MED_COL[mlModelIds().indexOf(id) % MED_COL.length], real: Q.map(r => r.conc), pred: Q.map(r => r.res.estimate.value)}; });
    stuDrawPvr('upPvr', groups);
    if(STU.upMed === 'ALL') stuDrawPvc('upPvc', sel.map(r => ({x: (r.conc || 1e-9) / S.models[r.cid].threshold, y: r.res.p_high / S.models[r.cid].pThr, kind: r.below ? 'below' : r.res.flag ? 'flag' : 'ok', label: stuShort(r.cid) + ':'})),
      {vx: 1, hy: 1, yMax: Math.max(2, ...sel.map(r => r.res.p_high / S.models[r.cid].pThr)) * 1.02, yScale: 1, xTitle: 'Real level ÷ "high" level (1 = high)', yTitle: 'Chance ÷ flag line (1 = flag line)'});
    else { const m = S.models[STU.upMed]; stuDrawPvc('upPvc', sel.map(r => ({x: r.conc, y: r.res.p_high, kind: r.below ? 'below' : r.res.flag ? 'flag' : 'ok'})), {vx: m.threshold, hy: m.pThr, xTitle: 'Real level, lab-measured (µg/L)', yTitle: 'Predicted chance of "high"'}); }
    $('#upHead').innerHTML = '<tr><th>Sample</th><th>Medicine</th><th class="n">Lab result</th><th class="n">Chance of "high"</th><th>Model</th><th>Lab says</th><th>Verdict</th><th class="n">Level estimate</th></tr>';
    $('#upBody').innerHTML = d.rows.slice(0, 300).map(r => { const s = r.res; if(!r.cid) return `<tr><td>${esc(r.id)}</td><td colspan="7" class="muted">compound not recognised</td></tr>`;
      if(!s || !s.ok) return `<tr><td>${esc(r.id)}</td><td>${esc(stuShort(r.cid))}</td><td colspan="6" class="muted">${esc(s?.message || 'not screened')}</td></tr>`;
      const hi = !r.below && r.conc >= S.models[r.cid].threshold, v = s.flag === hi ? (hi ? 'both high' : 'both low') : (hi ? 'missed high' : 'false alarm');
      return `<tr><td class="mono">${esc(r.id)}</td><td>${esc(stuShort(r.cid))}</td><td class="n">${r.below ? '&lt;LOD' : fmtConc(r.conc, r.cid)}</td><td class="n">${stuPct(s.p_high)}</td><td><span class="pill ${s.flag ? 'bad' : 'ok'}">${s.flag ? 'Send to lab' : 'No test'}</span></td><td>${hi ? '<b>high</b>' : 'low'}</td><td><span class="pill ${s.flag === hi ? 'ok' : hi ? 'bad' : 'warn'}">${v}</span></td><td class="n">${fmtConc(s.estimate.value, r.cid)}</td></tr>`; }).join('');
  } else {
    const flagged = id => d.rows.filter(r => r.resAll?.find(x => x.compound === id)?.flag).length;
    const okRows = d.rows.filter(r => r.resAll?.some(x => x.ok)).length;
    $('#upKv').innerHTML = [['Rows', d.rows.length.toLocaleString()], ['Rows screened', okRows.toLocaleString()], ['Rows with any flag', d.rows.filter(r => r.resAll?.some(x => x.flag)).length.toLocaleString()]]
      .map(([a, b]) => `<div><span>${a}</span><b>${b}</b></div>`).join('') + ids.map(id => `<div><span>${esc(stuShort(id))}: send to lab</span><b>${flagged(id)}</b></div>`).join('');
    $('#upEvalPanel').hidden = true;
    $('#upHead').innerHTML = `<tr><th>Sample</th>${d.sensors.map(k => `<th class="n">${esc(PARAMS[k]?.short || PARAMS[k]?.label)}</th>`).join('')}${ids.map(id => `<th>${esc(stuShort(id))}</th>`).join('')}</tr>`;
    $('#upBody').innerHTML = d.rows.slice(0, 300).map(r => `<tr><td class="mono">${esc(r.id)}</td>${d.sensors.map(k => `<td class="n">${r.rd[k] == null ? '–' : fmtNum(r.rd[k], PARAMS[k]?.dp ?? 2)}</td>`).join('')}${ids.map(id => { const s = r.resAll?.find(x => x.compound === id);
      return !s ? '<td>–</td>' : !s.ok ? `<td class="tiny" title="${esc(s.message)}">needs data</td>` : `<td><span class="pill ${s.flag ? 'bad' : 'ok'}" title="level ${fmtConc(s.estimate.value, id)} (${fmtConc(s.estimate.low, id)}–${fmtConc(s.estimate.high, id)}) · confidence ${s.confidence}">${s.flag ? 'Send to lab' : 'No test'} ${stuPct(s.p_high)}</span></td>`; }).join('')}</tr>`).join('');
  }
  $('#upNote').textContent = `${d.name} · ${d.rows.length > 300 ? 'first 300 rows shown; the download has all ' + d.rows.length.toLocaleString() : d.rows.length + ' rows'} · ${d.how === 'api' ? 'screened by the online ML API' : 'screened in this browser'} · the level is a rough estimate; the lab result is the reference.`;
}
function upResultsCsv(){
  const d = STU.up; if(!d) return '';
  const q = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  let head = [...d.hdr], lines;
  if(d.evalMode){
    head = head.concat(['model_compound', 'p_high', 'flag_send_to_lab', 'lab_high', 'verdict', 'level_estimate_ugL', 'level_low_ugL', 'level_high_ugL', 'confidence']);
    lines = d.rows.map(r => { const s = r.res, hi = r.cid ? (!r.below && r.conc >= S.models[r.cid].threshold) : null;
      const v = s && s.ok ? (s.flag === hi ? (hi ? 'both high' : 'both low') : (hi ? 'missed high' : 'false alarm')) : (s?.message || '');
      return d.hdr.map(h => q(r.raw[h])).concat([r.cid || '', s?.ok ? s.p_high.toFixed(4) : '', s?.ok ? (s.flag ? 'yes' : 'no') : '', hi == null ? '' : hi ? 'yes' : 'no', v,
        s?.ok ? s.estimate.value.toPrecision(4) : '', s?.ok ? s.estimate.low.toPrecision(3) : '', s?.ok ? s.estimate.high.toPrecision(3) : '', s?.confidence || '']).join(','); });
  } else {
    for(const id of d.ids) head.push(`${id}_p_high`, `${id}_send_to_lab`, `${id}_level_ugL`, `${id}_confidence`);
    lines = d.rows.map(r => d.hdr.map(h => q(r.raw[h])).concat(d.ids.flatMap(id => { const s = r.resAll?.find(x => x.compound === id);
      return s && s.ok ? [s.p_high.toFixed(4), s.flag ? 'yes' : 'no', s.estimate.value.toPrecision(4), s.confidence] : ['', '', '', q(s?.message || '')]; })).join(','));
  }
  return head.map(q).join(',') + '\n' + lines.join('\n') + '\n';
}
function upLoadText(text, name){ try{ upRun(upParse(text, name)); }catch(e){ $('#upStatus').textContent = 'Could not read the file: ' + e.message; } }
function upFile(f){ if(!f) return; $('#upStatus').textContent = `Reading ${f.name}…`; const rd = new FileReader(); rd.onload = () => upLoadText(rd.result, f.name); rd.readAsText(f); }
$('#upFile')?.addEventListener('change', e => { upFile(e.target.files[0]); e.target.value = ''; });
const upDrop = $('#upDrop');
if(upDrop){
  ['dragenter', 'dragover'].forEach(ev => upDrop.addEventListener(ev, e => { e.preventDefault(); upDrop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => upDrop.addEventListener(ev, e => { e.preventDefault(); upDrop.classList.remove('over'); }));
  upDrop.addEventListener('drop', e => upFile(e.dataTransfer.files[0]));
}
$('#upTpl')?.addEventListener('click', () => stuDownload('aquatrace_readings_template.csv', UP_TPL));
$('#upEx1')?.addEventListener('click', () => upLoadText('sample_id,lat,lon,ph,temp,conductivity,turbidity,do\n' + UP_EX.map(r => r.map(v => typeof v === 'string' ? `"${v}"` : v).join(',')).join('\n'), 'Penang-style example readings (made up)'));
$('#upEx2')?.addEventListener('click', async () => { $('#upStatus').textContent = 'Loading 5,248 US testing-set lab results…'; try{ upLoadText(await getBundled('models/crosscheck_lab_results.csv', 'models/crosscheck_lab_results.js', 'AQUATRACE_CROSSCHECK_CSV', true), 'US testing set: 5,248 lab results'); }catch(e){ $('#upStatus').textContent = 'Could not load: ' + e.message; } });
$('#upDl')?.addEventListener('click', () => { const t = upResultsCsv(); if(t) stuDownload(`aquatrace_screening_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.csv`, t); });
$('#upMed')?.addEventListener('change', e => { STU.upMed = e.target.value; renderUpload(false); });

/* ============================================================ ③ SELECT MODEL */
function renderModels(full){
  stuBars();
  const act = stuActiveEntry(); const L = stuPackages();
  $('#mdlVersions').innerHTML = L.length ? L.map(e => {
    const s = e.pkg.summary || {}, ms = Object.values(e.pkg.models || {}), on = act && act.id === e.id;
    const sensors = [...new Set(ms.flatMap(m => m.feats))].map(f => PARAMS[f]?.short || PARAMS[f]?.label || f);
    const live = e.source === 'online' ? (MLAPI.state === 'online' ? '<span class="pill ok">connected</span>' : '<span class="pill warn">not connected now</span>') : e.source === 'saved' ? '<span class="pill">offline backup</span>' : '<span class="pill acc">uploaded</span>';
    return `<div class="mcard ${on ? 'on' : ''}"><div class="flowrow"><b style="font-size:16px">${esc(e.name)}</b><span class="sp"></span>${live}</div>
      <div class="tiny">${esc(e.where)} · built ${esc(fmtT(Date.parse(e.pkg.created)))}</div>
      <div class="stats"><div><span>mAP</span><b>${s.mAP_test != null ? s.mAP_test.toFixed(2) : '–'}</b><i>random ${s.random_mAP_test != null ? s.random_mAP_test.toFixed(2) : '–'}</i></div><div><span>ROC-AUC</span><b>${s.mean_auc_test != null ? s.mean_auc_test.toFixed(2) : '–'}</b><i>mean, testing</i></div><div><span>Medicines</span><b>${ms.length}</b><i>random forest</i></div></div>
      <div class="tiny">Sensors needed: ${esc(sensors.join(', '))}</div>
      <div class="flowrow">${on ? '<span class="pill ok">✓ In use</span>' : `<button class="btn sm pri" data-use="${esc(e.id)}">Use this model</button>`}${e.source === 'upload' ? `<button class="btn sm" data-del="${esc(e.id)}">Remove</button>` : ''}</div></div>`;
  }).join('') : '<div class="empty">No model yet: start the ML API, or upload a model file from Colab.</div>';
  const ids = mlModelIds();
  $('#mdlMeds').innerHTML = ids.length ? ids.map((id, i) => {
    const m = S.models[id], sh = m.screenHold || {}, off = STU.off.has(id);
    return `<div class="mcard ${off ? 'dim' : ''}"><div class="flowrow"><span class="dotc" style="background:${MED_COL[i % MED_COL.length]}"></span><b style="font-size:16px">${esc(stuShort(id))}</b><span class="sp"></span>
      <label class="chk"><input type="checkbox" data-med="${id}" ${off ? '' : 'checked'}> screen</label></div>
      <div class="tiny">${esc(S.compounds[id]?.cls || '')} · "high" above ${fmtConc(m.threshold, id)} · flag when chance ≥ ${stuPct(m.pThr)}</div>
      <div class="stats"><div><span>ROC-AUC</span><b>${sh.auc != null ? sh.auc.toFixed(2) : '–'}</b><i>testing</i></div><div><span>Precision</span><b>${stuPct(sh.hit_rate)}</b><i>random ${stuPct(sh.base_rate)}</i></div><div><span>Recall</span><b>${stuPct(sh.caught_share)}</b><i>high caught</i></div></div>
      <div class="tiny">Sensors: ${m.feats.map(f => esc(PARAMS[f]?.label || f)).join(', ')}${m.chosen?.screening ? ` · depth ${m.chosen.screening.max_depth}, leaf ${m.chosen.screening.min_samples_leaf}` : ''}</div></div>`;
  }).join('') : '<div class="empty">No model loaded.</div>';
  renderMlAlgos('#mdlAlgoTable', '#mdlAlgoNote');
}
$('#mdlVersions')?.addEventListener('click', e => {
  const u = e.target.closest('[data-use]'), d = e.target.closest('[data-del]');
  if(u) stuActivate(u.dataset.use);
  if(d){ STU.uploads = STU.uploads.filter(x => x.id !== d.dataset.del); stuSafe('aquatrace.models', JSON.stringify(STU.uploads)); if(STU.activeId === d.dataset.del){ STU.activeId = null; stuSafe('aquatrace.activeModel', null); mlApiApply(); STU.evalKey = ''; } renderModels(true); }
});
$('#mdlMeds')?.addEventListener('change', e => {
  const c = e.target.closest('[data-med]'); if(!c) return;
  c.checked ? STU.off.delete(c.dataset.med) : STU.off.add(c.dataset.med); stuSafe('aquatrace.medsOff', JSON.stringify([...STU.off])); renderModels(false);
});
$('#mdlFile')?.addEventListener('change', e => {
  const f = e.target.files[0]; if(!f) return; e.target.value = '';
  const rd = new FileReader(); rd.onload = () => {
    try{
      const pkg = JSON.parse(rd.result);
      if(!/^aquatrace-model-package\//.test(pkg.format || '') || !pkg.models) throw new Error('This is not an AquaTrace model file (use aquatrace_colab_model.json from the Colab zip).');
      const ent = {id: 'up-' + Date.now(), name: f.name.replace(/\.json$/i, ''), addedAt: Date.now(), pkg};
      STU.uploads.push(ent);
      if(!stuSafe('aquatrace.models', JSON.stringify(STU.uploads))) toast('Model added for this session (too big to remember after a reload)');
      stuActivate(ent.id);
    }catch(err){ toast(err.message); }
  };
  rd.readAsText(f);
});

/* ============================================================ ④ RESULTS & FIGURES */
async function renderResults(full){
  stuBars();
  if(!mlModelIds().length){ $('#resKv').innerHTML = '<div style="grid-column:1/-1"><span>No model loaded</span><b>–</b></div>'; return; }
  if(full) $('#resCmNote').textContent = 'calculating…';
  let D; try{ D = await stuEvaluate(); }catch(e){ $('#resCmNote').textContent = 'Could not load the testing-set lab results: ' + e.message; return; }
  const ids = D.ids; if(STU.resMed !== 'ALL' && !ids.includes(STU.resMed)) STU.resMed = 'ALL';
  $('#resSeg').innerHTML = ['ALL', ...ids].map(id => `<button type="button" data-med="${id}" class="${STU.resMed === id ? 'on' : ''}">${id === 'ALL' ? 'All 5 medicines' : esc(stuShort(id))}</button>`).join('');
  const one = STU.resMed !== 'ALL', E = one ? D.per[STU.resMed] : null, cm = one ? E.cm : D.pooled, sc = one ? stuScores(E.cm) : D.all;
  const n = cm.tp + cm.fp + cm.fn + cm.tn;
  $('#resKv').innerHTML = [
    ['Testing lab results', n.toLocaleString(), one ? stuShort(STU.resMed) : 'rivers never seen'],
    [one ? 'AP' : 'mAP', (one ? E.ap : D.mAP).toFixed(2), `random ${(one ? E.base : D.rmAP).toFixed(2)}`],
    [one ? 'ROC-AUC' : 'Mean ROC-AUC', (one ? E.auc : D.mAUC).toFixed(2), '0.5 = coin flip'],
    ['Precision', stuPct(sc.precision), `random ${stuPct(sc.rand.precision)} · ${(sc.precision / sc.rand.precision).toFixed(1)}× better`],
    ['Recall', stuPct(sc.recall), `random ${stuPct(sc.rand.recall)}`],
    ['F1', sc.f1.toFixed(2), `random ${sc.rand.f1.toFixed(2)}`]].map(([a, b, c]) => `<div><span>${a}</span><b>${b}</b><span class="tiny" style="display:block">${esc(c)}</span></div>`).join('');
  $('#resCm').innerHTML = stuCmHtml(cm);
  $('#resCmNote').textContent = `${one ? stuShort(STU.resMed) : 'All 5 medicines'} · testing set`;
  $('#resGauges').innerHTML = stuGauge('Accuracy', sc.accuracy, sc.rand.accuracy, v => stuPct(v), 'looks good, says little')
    + stuGauge('Precision', sc.precision, sc.rand.precision, v => stuPct(v), 'flagged that were high')
    + stuGauge('Recall', sc.recall, sc.rand.recall, v => stuPct(v), 'high ones we flagged')
    + stuGauge('F1-score', sc.f1, sc.rand.f1, v => v.toFixed(2), 'balance of the two');
  $('#resTable').innerHTML = ids.map((id, i) => { const e = D.per[id]; return `<tr${STU.resMed === id ? ' class="sel"' : ''}><td><span class="dotc" style="background:${MED_COL[i % MED_COL.length]}"></span> <b>${esc(stuShort(id))}</b></td><td class="n">${e.n.toLocaleString()}</td>
    <td class="n">${e.cm.tp}</td><td class="n">${e.cm.fp}</td><td class="n">${e.cm.fn}</td><td class="n">${e.cm.tn.toLocaleString()}</td><td class="n"><b>${stuPct(e.precision)}</b> <span class="tiny">vs ${stuPct(e.base)}</span></td>
    <td class="n">${stuPct(e.recall)}</td><td class="n">${e.f1.toFixed(2)}</td><td class="n">${e.auc.toFixed(2)}</td><td class="n">${e.ap.toFixed(2)} <span class="tiny">vs ${e.base.toFixed(2)}</span></td><td class="n"><b>${(e.precision / e.base).toFixed(1)}×</b></td>
    <td class="n">${stuPct(e.within2)} <span class="tiny">of ${e.nDet}</span></td></tr>`; }).join('');
  // predicted vs real
  const show = one ? [STU.resMed] : ids;
  stuDrawPvr('resPvr', show.map(id => { const e = D.per[id]; const k = e.below.map((b, i) => b ? -1 : i).filter(i => i >= 0); return {label: stuShort(id), color: MED_COL[ids.indexOf(id) % MED_COL.length], real: k.map(i => e.real[i]), pred: k.map(i => e.pred[i])}; }));
  $('#resPvrNote').textContent = `Lab-detected samples only (${show.reduce((s, id) => s + D.per[id].nDet, 0).toLocaleString()}). Within 2× of the lab: ${show.map(id => `${stuShort(id)} ${stuPct(D.per[id].within2)}`).join(' · ')}. The level is rough, so the website shows it as a range.`;
  if(one){ const e = E, m = S.models[STU.resMed];
    stuDrawPvc('resPvc', e.p.map((p, i) => ({x: e.real[i], y: p, kind: e.below[i] ? 'below' : e.f[i] ? 'flag' : 'ok'})), {vx: m.threshold, hy: m.pThr, xTitle: `Real level, lab-measured (µg/L) · "high" ≥ ${fmtConc(m.threshold, STU.resMed)}`, yTitle: 'Predicted chance of "high"'});
    $('#resPvcNote').textContent = 'Green line = "high" level (lab). Dashed line = flag line. Top-right: correct flags · top-left: false alarms · bottom-right: missed · bottom-left: correctly skipped.'; }
  else { const pts = []; ids.forEach(id => { const e = D.per[id], m = S.models[id]; e.p.forEach((p, i) => pts.push({x: Math.max(e.real[i], 1e-9) / m.threshold, y: p / m.pThr, kind: e.below[i] ? 'below' : e.f[i] ? 'flag' : 'ok', label: stuShort(id) + ':'})); });
    stuDrawPvc('resPvc', pts, {vx: 1, hy: 1, yMax: Math.max(...pts.map(p => p.y)) * 1.02, yScale: 1, xTitle: 'Real level ÷ "high" level (right of 1 = high)', yTitle: 'Chance ÷ flag line (above 1 = flagged)'});
    $('#resPvcNote').textContent = 'All medicines on one scale. Right of the green line = really high; above the dashed line = flagged. Pick one medicine above for its own units.'; }
  // curves
  const dsCurve = (key, xy) => show.map(id => { const e = D.per[id], c = MED_COL[ids.indexOf(id) % MED_COL.length];
    return {label: `${stuShort(id)} (${key === 'pr' ? 'AP ' + e.ap.toFixed(2) : 'AUC ' + e.auc.toFixed(2)})`, data: thin(e[key]).map(([a, b]) => ({x: a, y: b})), showLine: true, borderColor: c, backgroundColor: c, pointRadius: 0, borderWidth: 1.8, stepped: key === 'pr' ? false : false}; });
  const prD = dsCurve('pr'); show.forEach(id => { const e = D.per[id]; prD.push({label: '', data: [{x: e.recall, y: e.precision}], backgroundColor: MED_COL[ids.indexOf(id) % MED_COL.length], pointRadius: 5, pointStyle: 'circle'}); });
  chart('resPr', {type: 'scatter', data: {datasets: prD}, options: baseOpts({interaction: {mode: 'nearest', intersect: false}, plugins: {legend: {labels: {filter: it => !!it.text}}, tooltip: {callbacks: {label: c => `${c.dataset.label || 'flag line'}: recall ${(c.raw.x * 100).toFixed(0)}%, precision ${(c.raw.y * 100).toFixed(0)}%`}}},
    scales: {x: linAxis('Recall: share of truly high samples flagged', 0, 1), y: linAxis('Precision: share of flagged samples truly high', 0, 1)}})});
  const rocD = dsCurve('roc'); rocD.push({type: 'line', label: 'coin flip', data: [{x: 0, y: 0}, {x: 1, y: 1}], borderColor: css('--fg-3'), borderDash: [5, 4], borderWidth: 1, pointRadius: 0});
  chart('resRoc', {type: 'scatter', data: {datasets: rocD}, options: baseOpts({interaction: {mode: 'nearest', intersect: false}, plugins: {tooltip: {callbacks: {label: c => `${c.dataset.label}: false alarms ${(c.raw.x * 100).toFixed(0)}%, caught ${(c.raw.y * 100).toFixed(0)}%`}}},
    scales: {x: linAxis('False-alarm rate (share of low samples flagged)', 0, 1), y: linAxis('Catch rate (share of high samples flagged)', 0, 1)}})});
  // sensor importance
  $('#resImp').innerHTML = show.map(id => { const m = S.models[id]; const mx = Math.max(...m.importance.map(i => i.v), 1e-9);
    return `<div class="small" style="margin:6px 0 2px"><b>${esc(stuShort(id))}</b></div>` + m.importance.map(i => `<div class="r"><span>${esc(PARAMS[i.f]?.label || i.f)}</span><div class="track"><i style="left:0;width:${i.v / mx * 100}%;background:${MED_COL[ids.indexOf(id) % MED_COL.length]}"></i></div><span class="v">${(i.v * 100).toFixed(0)}%</span></div>`).join(''); }).join('');
  renderMlAlgos('#resAlgoTable', '#resAlgoNote');
}
$('#resSeg')?.addEventListener('click', e => { const b = e.target.closest('[data-med]'); if(!b) return; STU.resMed = b.dataset.med; renderResults(false); });

/* ---------- wiring into the app ---------- */
VIEWS.push('live', 'upload', 'models', 'results');
Object.assign(RENDER, {live: renderLive, upload: renderUpload, models: renderModels, results: renderResults});
stuBars();
// The saved copy (models/ folder) is always offered as a version, even while the online API is connected.
(async () => { try{ if(!MLAPI.saved) MLAPI.saved = await getBundled('models/aquatrace_colab_model.json', 'models/aquatrace_colab_model.js', 'AQUATRACE_MODEL', false); if(VIEW === 'models') renderModels(true); }catch(e){} })();
