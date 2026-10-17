/* ============================================================
   AquaTrace — core: config, utilities, geography, simulator,
   data store, HPLC matching, anomaly detection, events, API.
   ============================================================ */
'use strict';
const CFG = {
  mode: 'demo', apiBase: '', apiKey: '',
  device: 'BOAT-01',
  tickSec: 3, simMinPerTick: 1,          // demo: 1 simulated minute per tick
  histDays: 7, histStepMin: 5,
  zTh: 3, baseWin: 72,
  matchWinMin: 15, matchDistM: 300,
  target: 'PCM',
  feats: ['ph','orp','turbidity','uv','temp','conductivity','do'],
  basemap: 'osm',                          // 'osm' (OpenStreetMap tiles) or 'schematic'
  tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  tileAttr: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  nominatim: 'https://nominatim.openstreetmap.org',
  overpass: 'https://overpass-api.de/api/interpreter',
  fleetCode: '', broker: 'emqx', brokerUrl: '', phoneUrl: '', autoFollow: true
};
const PARAMS = {
  ph:{label:'pH', unit:'', dp:2},
  orp:{label:'ORP', unit:'mV', dp:0},
  turbidity:{label:'Turbidity', unit:'NTU', dp:1},
  uv:{label:'UV absorbance', short:'UV', unit:'AU', dp:3},
  temp:{label:'Temperature', short:'Temp', unit:'°C', dp:1},
  conductivity:{label:'Conductivity', short:'Cond.', unit:'µS/cm', dp:0},
  do:{label:'Dissolved O₂', short:'DO', unit:'mg/L', dp:2},
};
const EXTRA_FEATS = {hour_sin:'Time of day (sin)', hour_cos:'Time of day (cos)', lat:'Latitude', lon:'Longitude'};
const UNIT_TO_UG = {'ng/L':1e-3,'µg/L':1,'ug/L':1,'mg/L':1e3,'particles/L':1};

/* ---------- utils ---------- */
const $ = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
const clamp = (x,a,b) => Math.max(a, Math.min(b, x));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;}}
let RNG = mulberry32(20240714);
const rnd = () => RNG();
function gauss(){let u=0,v=0;while(!u)u=rnd();while(!v)v=rnd();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);}
const mean = a => a.length ? a.reduce((s,x)=>s+x,0)/a.length : NaN;
const sd = a => { if(a.length<2) return 0; const m=mean(a); return Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/(a.length-1)); };
function pearson(x,y){const mx=mean(x),my=mean(y);let a=0,b=0,c=0;for(let i=0;i<x.length;i++){a+=(x[i]-mx)*(y[i]-my);b+=(x[i]-mx)**2;c+=(y[i]-my)**2;}return b&&c?a/Math.sqrt(b*c):0;}
function ranks(a){const idx=a.map((v,i)=>[v,i]).sort((p,q)=>p[0]-q[0]);const r=new Array(a.length);let i=0;while(i<idx.length){let j=i;while(j+1<idx.length&&idx[j+1][0]===idx[i][0])j++;const rk=(i+j)/2+1;for(let k=i;k<=j;k++)r[idx[k][1]]=rk;i=j+1;}return r;}
const spearman = (x,y) => pearson(ranks(x),ranks(y));
function linfit(x,y){const mx=mean(x),my=mean(y);let sxy=0,sxx=0;for(let i=0;i<x.length;i++){sxy+=(x[i]-mx)*(y[i]-my);sxx+=(x[i]-mx)**2;}const b=sxx?sxy/sxx:0;const a=my-b*mx;const yh=x.map(v=>a+b*v);return {a,b,r2:r2score(y,yh)};}
function r2score(y,yh){const m=mean(y);let ss=0,st=0;for(let i=0;i<y.length;i++){ss+=(y[i]-yh[i])**2;st+=(y[i]-m)**2;}return st?1-ss/st:0;}
const fmtT = ts => new Date(ts).toLocaleString([], {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'});
const fmtTime = ts => new Date(ts).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
function fmtNum(v, dp=2){ if(v==null||!isFinite(v)) return '–'; return Number(v).toFixed(dp); }
function fmtConc(v, comp){ if(v==null||!isFinite(v)) return '–'; const c=S.compounds[comp]; const u=c?c.unit:''; const a=Math.abs(v); const dp = a>=100?0: a>=10?1: a>=1?2: a>=0.1?3:4; return `${v.toFixed(dp)} ${u}`; }
function toast(msg){ const t=$('#toast'); t.textContent=msg; t.hidden=false; clearTimeout(toast._t); toast._t=setTimeout(()=>t.hidden=true, 3800); }
async function copyText(txt, fallbackEl){
  try { await navigator.clipboard.writeText(txt); toast('Copied to clipboard'); }
  catch(e){ if(fallbackEl){ fallbackEl.hidden=false; fallbackEl.value=txt; fallbackEl.focus(); fallbackEl.select(); toast('Clipboard blocked: text selected below, copy it manually'); } }
}
function toCSV(rows, cols){ const q=v=>{ if(v==null) return ''; const s=String(v); return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s; }; return [cols.join(','), ...rows.map(r=>cols.map(c=>q(r[c])).join(','))].join('\n'); }

/* ---------- geography (WGS84) ---------- */
const R_E = 6371000;
function distM(a,b){const toR=Math.PI/180;const dLat=(b.lat-a.lat)*toR,dLon=(b.lon-a.lon)*toR;const s=Math.sin(dLat/2)**2+Math.cos(a.lat*toR)*Math.cos(b.lat*toR)*Math.sin(dLon/2)**2;return 2*R_E*Math.asin(Math.sqrt(s));}
// Sampling points SP1–SP5 from Sharifah Nurul Sofhia (2023), Sungai Pinang. Other points are approximate.
const PLACES = {
  UP:  {lat:5.41360, lon:100.30870, name:'Upstream reach'},
  SP1: {lat:5.410733, lon:100.313743, name:'SP1 Persiaran Stadium'},
  SP2: {lat:5.408132, lon:100.322845, name:'SP2 Kampung Rawa'},
  SP3: {lat:5.408349, lon:100.325677, name:'SP3 Jalan S.P. Chelliah drain'},
  SP4: {lat:5.407830, lon:100.325927, name:'SP4 Jalan Sungai'},
  SP5: {lat:5.403843, lon:100.330476, name:'SP5 Jelutong (before sea)'},
  MOUTH:{lat:5.40330, lon:100.33560, name:'River mouth'},
  NCST:{lat:5.41230, lon:100.34330, name:'North coastal station'},
  SCST:{lat:5.39350, lon:100.33620, name:'South coastal station'},
  OUTF:{lat:5.39520, lon:100.33380, name:'STP outfall vicinity'},
};
const ROUTE_KEYS = ['SP1','SP2','SP3','SP4','SP5','MOUTH','NCST','MOUTH','OUTF','SCST','MOUTH','SP5','SP4','SP3','SP2','SP1'];
const ROUTE = ROUTE_KEYS.map(k=>PLACES[k]);
const COAST = [[5.4240,100.3462],[5.4190,100.3440],[5.4150,100.3418],[5.4105,100.3394],[5.4065,100.3372],[5.4040,100.3356],[5.4026,100.3352],[5.3995,100.3343],[5.3950,100.3326],[5.3900,100.3306],[5.3840,100.3285],[5.3780,100.3268]];
const RIVER = ['UP','SP1','SP2','SP3','SP4','SP5','MOUTH'].map(k=>PLACES[k]);
const SOURCES_DEFAULT = [
  {id:'SRC-HOSP', name:'Hospital effluent drain', type:'Hospital effluent', lat:5.41090, lon:100.31330, sigma:260, load:1.0, lbl:'left',
   basis:'Sharifah (2023): SP1 chosen for hospital effluent released via drain', prof:{PCM:0.38, ATL:95, DIC:9, CBZ:0.6, KTP:2.5}},
  {id:'SRC-RAWA', name:'Kampung Rawa settlement', type:'Unsewered settlement', lat:5.40830, lon:100.32250, sigma:230, load:1.3,
   lbl:'above', basis:'Sharifah (2023): SP2, impractical sewage system at unplanned settlement', prof:{PCM:0.30, ATL:40, DIC:14, CBZ:0.9, KTP:4}},
  {id:'SRC-DRAIN', name:'Commercial / residential drain', type:'Urban drain', lat:5.40840, lon:100.32560, sigma:180, load:0.8,
   basis:'Sharifah (2023): SP3, runoff from residential and commercial areas', prof:{PCM:0.16, ATL:18, DIC:11, CBZ:0.7, KTP:3}},
  {id:'SRC-STP', name:'Jelutong STP effluent outfall', type:'Sewage treatment plant', lat:5.39520, lon:100.33300, sigma:420, load:0.35,
   basis:'Teoh (2022): Jelutong STP, largest centralised STP on Penang Island. Coastal outfall position approximate; measured effluent discharge point is 5.39725 N, 100.32415 E (Amir Irham 2024, pt 3)', prof:{PCM:0.03, ATL:8, DIC:6, CBZ:4.5, KTP:0.8}},
];

/* ---------- compound database (seed) ---------- */
const COMPOUNDS_DEFAULT = [
  {id:'PCM', name:'Paracetamol', cls:'Analgesic / antipyretic', cas:'103-90-2', kow:0.46, unit:'mg/L', level:0.15, pnec:null, bg:0.012,
   method:'SPE + HPLC-UV (λmax ≈ 243 nm)', rt:null, src:'Project target compound. PNEC not set: enter from your ERA source.'},
  {id:'DIC', name:'Diclofenac', cls:'NSAID', cas:'15307-86-5', kow:4.51, unit:'µg/L', level:10, pnec:14.5, bg:0.3,
   method:'SPE + HPLC-UV 254 nm, C18', rt:10.466, src:'PNEC, RT: Sharifah (2023); log Kow: Khasawneh (2022)'},
  {id:'CBZ', name:'Carbamazepine', cls:'Anticonvulsant', cas:'298-46-4', kow:2.77, unit:'µg/L', level:3, pnec:35.4, bg:0.15,
   method:'SPE + HPLC-UV 254 nm, C18', rt:4.161, src:'PNEC, RT: Sharifah (2023); log Kow: Khasawneh (2022)'},
  {id:'ATL', name:'Atenolol', cls:'β-blocker', cas:'29122-68-7', kow:0.16, unit:'µg/L', level:60, pnec:200, bg:1.0,
   method:'SPE + HPLC-UV 254 nm, C18', rt:2.175, src:'PNEC, RT: Sharifah (2023); log Kow: Khasawneh (2022)'},
  {id:'KTP', name:'Ketoprofen', cls:'NSAID', cas:'22071-15-4', kow:3.12, unit:'µg/L', level:4, pnec:32, bg:0.1,
   method:'SPE + HPLC-UV 254 nm, C18', rt:7.279, src:'PNEC, RT: Sharifah (2023)'},
  {id:'MPL', name:'Microplastics', cls:'Particulate (emerging)', cas:'–', kow:null, unit:'particles/L', level:null, pnec:null, bg:0,
   method:'Filtration + µ-FTIR / Raman', rt:null, src:'Placeholder for future particle-count datasets'},
];

/* ---------- prior measured concentrations (reference only, never used for training) ---------- */
// Generated from backend/app/literature.py. Amir Irham (2024) compilation of Khasawneh (2022), Teoh (2022), Sharifah (2023).
const LITERATURE_DEFAULT = {"source": "Amir Irham (2024), USM, Tables 3.2-3.5; compiled from Khasawneh (2022), Teoh (2022) and Sharifah Nurul Sofhia (2023). Values below LOD were reported as 0.", "points": [{"pt": 1, "study": "Khasawneh (2022)", "site": "Jelutong STP, influent area", "lat": 5.3919194, "lon": 100.3194583, "unit": "µg/L", "values": {"ATL": {"min": 0.09, "max": 1.02, "mean": 0.591, "flag": false}, "CBZ": {"min": 0.43, "max": 3.2, "mean": 1.293, "flag": false}, "DIC": {"min": 0.123, "max": 1.439, "mean": 0.887, "flag": false}, "KTP": {"min": 0.02, "max": 0.286, "mean": 0.155, "flag": false}}}, {"pt": 2, "study": "Khasawneh (2022)", "site": "Jelutong STP, effluent area", "lat": 5.3973361, "lon": 100.3230333, "unit": "µg/L", "values": {"ATL": {"min": 0.04, "max": 0.367, "mean": 0.207, "flag": false}, "CBZ": {"min": 0.12, "max": 1.45, "mean": 0.764, "flag": false}, "DIC": {"min": 0.12, "max": 0.746, "mean": 0.484, "flag": false}, "KTP": {"min": 0.015, "max": 0.15, "mean": 0.074, "flag": false}}}, {"pt": 3, "study": "Teoh (2022)", "site": "Jelutong STP effluent discharge", "lat": 5.39725, "lon": 100.3241472, "unit": "µg/L", "values": {"ATL": {"min": 0.011, "max": 0.21, "mean": 0.13, "flag": false}, "CBZ": {"min": 0.175, "max": 0.613, "mean": 0.426, "flag": false}, "DIC": {"min": 0.137, "max": 0.563, "mean": 0.306, "flag": false}, "KTP": {"min": 0.035, "max": 0.138, "mean": 0.066, "flag": false}}}, {"pt": 4, "study": "Teoh (2022)", "site": "Effluent channel, downstream", "lat": 5.394832, "lon": 100.327103, "unit": "µg/L", "values": {"ATL": {"min": 0.075, "max": 0.219, "mean": 0.223, "flag": true}, "CBZ": {"min": 0.13, "max": 0.732, "mean": 0.302, "flag": false}, "DIC": {"min": 0.048, "max": 0.219, "mean": 0.103, "flag": false}, "KTP": {"min": 0.034, "max": 0.083, "mean": 0.058, "flag": false}}}, {"pt": 5, "study": "Teoh (2022)", "site": "Sg. Pinang downstream of STP", "lat": 5.399644, "lon": 100.332162, "unit": "µg/L", "values": {"ATL": {"min": 0.07, "max": 0.196, "mean": 0.428, "flag": true}, "CBZ": {"min": 0.089, "max": 0.438, "mean": 0.231, "flag": false}, "DIC": {"min": 0.042, "max": 0.173, "mean": 0.089, "flag": false}, "KTP": {"min": 0.032, "max": 0.062, "mean": 0.048, "flag": false}}}, {"pt": 6, "study": "Sharifah (2023)", "site": "SP1 Persiaran Stadium (hospital drain)", "lat": 5.410733, "lon": 100.313743, "unit": "µg/L", "values": {"ATL": {"min": 49.091, "max": 98.811, "mean": 68.794, "flag": false}, "CBZ": {"min": 0.294, "max": 0.976, "mean": 0.635, "flag": false}, "DIC": {"min": 1.198, "max": 17.678, "mean": 6.71, "flag": false}, "KTP": {"min": 4.572, "max": 4.572, "mean": 4.572, "flag": false}}}, {"pt": 7, "study": "Sharifah (2023)", "site": "SP2 Kampung Rawa", "lat": 5.408132, "lon": 100.322845, "unit": "µg/L", "values": {"ATL": {"min": 39.791, "max": 81.786, "mean": 61.323, "flag": false}, "CBZ": {"min": 0.342, "max": 0.354, "mean": 0.348, "flag": false}, "DIC": {"min": 1.224, "max": 28.311, "mean": 10.314, "flag": false}, "KTP": {"min": 1.061, "max": 2.466, "mean": 1.764, "flag": false}}}, {"pt": 8, "study": "Sharifah (2023)", "site": "SP3 Jalan S.P. Chelliah drain", "lat": 5.40827222, "lon": 100.3256222, "unit": "µg/L", "values": {"ATL": {"min": 50.531, "max": 82.632, "mean": 60.57, "flag": false}, "CBZ": {"min": 0.381, "max": 19.204, "mean": 9.828, "flag": false}, "DIC": {"min": 1.661, "max": 2.386, "mean": 2.023, "flag": false}, "KTP": {"min": 7.332, "max": 7.332, "mean": 7.332, "flag": false}}}, {"pt": 9, "study": "Sharifah (2023)", "site": "SP4 Jalan Sungai", "lat": 5.40783, "lon": 100.325927, "unit": "µg/L", "values": {"ATL": {"min": 47.248, "max": 119.527, "mean": 68.564, "flag": false}, "CBZ": {"min": 0.05, "max": 7.968, "mean": 3.758, "flag": false}, "DIC": {"min": 1.237, "max": 18.62, "mean": 5.687, "flag": false}, "KTP": {"min": 2.49, "max": 2.49, "mean": 2.49, "flag": false}}}, {"pt": 10, "study": "Sharifah (2023)", "site": "SP5 Jelutong (before sea)", "lat": 5.403843, "lon": 100.330476, "unit": "µg/L", "values": {"ATL": {"min": 34.831, "max": 56.751, "mean": 46.87, "flag": false}, "CBZ": {"min": 0.0, "max": 0.0, "mean": 0.0, "flag": false}, "DIC": {"min": 1.314, "max": 1.585, "mean": 1.453, "flag": false}, "KTP": {"min": 0.0, "max": 0.0, "mean": 0.0, "flag": false}}}]};

/* ---------- store ---------- */
const S = {
  readings: [], hplc: [], compounds: {}, sources: [], models: {}, events: [],
  reactor: [], survey: [], interviews: [], literature: LITERATURE_DEFAULT, simNow: 0, paused: false, startedAt: Date.now(),
  base: {}, pulses: [], rains: [], routeLen: 0, t0: 0, lastLiveTs: null, serverModels: {},
  fleet: new Map(), follow: 'BOAT-01', primary: [], realtime: false, lastTickReal: Date.now()
};
function loadPrefs(){ try{ const p=JSON.parse(localStorage.getItem('aquatrace.prefs')||'{}'); Object.assign(CFG, p);}catch(e){} }
function savePrefs(){ try{ const {apiBase,apiKey,zTh,baseWin,tickSec,target,matchWinMin,matchDistM,basemap,fleetCode,broker,brokerUrl,phoneUrl,autoFollow}=CFG; localStorage.setItem('aquatrace.prefs', JSON.stringify({apiBase,apiKey,zTh,baseWin,tickSec,target,matchWinMin,matchDistM,basemap,fleetCode,broker,brokerUrl,phoneUrl,autoFollow})); }catch(e){} }

/* ---------- vessel route ---------- */
function initRoute(){ let L=0; for(let i=1;i<ROUTE.length;i++) L+=distM(ROUTE[i-1],ROUTE[i]); S.routeLen=L; }
const SPEED_M_PER_MIN = 110;   // ~6.6 km/h survey speed
function posAt(ts){
  let d = ((ts - S.t0)/60000*SPEED_M_PER_MIN) % S.routeLen; if(d<0) d+=S.routeLen;
  for(let i=1;i<ROUTE.length;i++){ const seg=distM(ROUTE[i-1],ROUTE[i]); if(d<=seg){ const f=seg?d/seg:0; return {lat:ROUTE[i-1].lat+(ROUTE[i].lat-ROUTE[i-1].lat)*f, lon:ROUTE[i-1].lon+(ROUTE[i].lon-ROUTE[i-1].lon)*f, heading:Math.atan2(ROUTE[i].lon-ROUTE[i-1].lon, ROUTE[i].lat-ROUTE[i-1].lat)}; } d-=seg; }
  return {...ROUTE[0], heading:0};
}
const seaFrac = p => { const s=clamp((p.lon-100.3312)/(100.3372-100.3312),0,1); return s*s*(3-2*s); };

/* ---------- synthetic water model ---------- */
function rainAt(ts){ let r=0; for(const e of S.rains){ const dt=(ts-e.t)/3600000; if(dt<0) continue; if(dt<e.dur) r=Math.max(r,e.i*Math.min(1,dt/0.3)); else r=Math.max(r, e.i*Math.exp(-(dt-e.dur)/2.5)); } return clamp(r,0,1); }
function srcStrength(src, ts){
  const h = new Date(ts).getHours() + new Date(ts).getMinutes()/60;
  let a = 0.55 + 0.35*Math.exp(-((h-9)**2)/6) + 0.3*Math.exp(-((h-20)**2)/5) - 0.2*Math.exp(-((h-3.5)**2)/5);
  for(const p of S.pulses) if(p.src===src.id && ts>=p.t && ts<=p.t+p.dur) a *= p.k;
  return a;
}
function world(ts, pos, noise=true, extra=0){
  const n = noise ? gauss : ()=>0;
  const rain = rainAt(ts), sf = seaFrac(pos);
  const dil = (1-0.62*sf)*(1-0.4*rain);
  let s = 0.04 + extra; const conc = {};
  for(const c of Object.values(S.compounds)) conc[c.id] = c.bg || 0;
  for(const src of S.sources){
    const w = srcStrength(src, ts) * Math.exp(-0.5*(distM(pos,src)/src.sigma)**2);
    s += w*src.load;
    for(const [k,v] of Object.entries(src.prof||{})) if(k in conc) conc[k] += w*v;
  }
  const se0 = s*dil; const se = se0/(1+0.35*se0);          // sensor response saturates at high loads
  const dom = 0.5+0.5*Math.sin(2*Math.PI*(ts-S.t0)/(3.3*864e5)) * Math.cos(2*Math.PI*(ts-S.t0)/(1.7*864e5)); // natural organic matter, unrelated to sewage
  for(const k in conc){ conc[k] = conc[k]*dil*Math.exp(0.12*n()); }
  const domU = dom*(1-0.7*sf);
  const h = new Date(ts).getHours() + new Date(ts).getMinutes()/60;
  const r = sensorsFrom({se, sf, rain, domU, h, n});
  return {r, conc, s:se, rain, sf};
}
function makeReading(ts){
  const p = posAt(ts); const w = world(ts, p, true, typeof dischargeLoad==='function' ? dischargeLoad(S.fleet.get('BOAT-01'), ts, p) : 0);
  const rd = {id:'R'+ts, ts, device:'BOAT-01', lat:+(p.lat+2e-5*gauss()).toFixed(6), lon:+(p.lon+2e-5*gauss()).toFixed(6), heading:p.heading};
  for(const k in w.r) rd[k] = +w.r[k].toFixed(PARAMS[k].dp+1);
  rd._truth = w.conc; rd._rain = w.rain;
  return rd;
}
function seedDemo(){
  RNG = mulberry32(20240714);
  S.compounds = {}; COMPOUNDS_DEFAULT.forEach(c=>S.compounds[c.id]={...c});
  S.sources = SOURCES_DEFAULT.map(s=>({...s}));
  const now = Date.now(); const start = now - CFG.histDays*864e5;
  S.t0 = start; initRoute();
  // rain storms: tropical afternoon convection
  S.rains = []; for(let d=0; d<CFG.histDays+2; d++){ if(rnd()<0.55){ const day = new Date(start + d*864e5); day.setHours(14+Math.floor(rnd()*5), Math.floor(rnd()*60),0,0); S.rains.push({t:day.getTime(), dur:0.5+rnd()*1.8, i:0.35+rnd()*0.65}); } }
  // discharge pulses (illicit / overflow) at random sources
  S.pulses = []; for(let i=0;i<14;i++){ const src=S.sources[Math.floor(rnd()*S.sources.length)]; S.pulses.push({src:src.id, t:start+rnd()*(now-start), dur:(25+rnd()*70)*60000, k:2.2+rnd()*1.8}); }
  // guarantee one live pulse the vessel will cross ~10–25 simulated minutes after start
  for(let m=10; m<120; m++){ const ts=now+m*60000, p=posAt(ts); const near=S.sources.find(s=>distM(p,s)<120 && s.id!=='SRC-STP'); if(near){ S.pulses.push({src:near.id, t:ts-20*60000, dur:45*60000, k:3.6}); break; } }
  S.readings = [];
  for(let ts=start; ts<=now; ts+=CFG.histStepMin*60000) S.readings.push(makeReading(ts));
  S.simNow = now;
  // HPLC grab samples at stations
  const stations = ['SP1','SP2','SP3','SP4','SP5','MOUTH','NCST','OUTF','SCST'].map(k=>({k,...PLACES[k]}));
  const cand = S.readings.filter(r=>stations.some(s=>distM(r,s)<60));
  const picks = []; const used = new Set();
  while(picks.length<72 && used.size<cand.length){ const i=Math.floor(rnd()*cand.length); if(used.has(i)) continue; used.add(i); const r=cand[i]; if(picks.some(p=>Math.abs(p.ts-r.ts)<90*60000)) continue; picks.push(r); }
  picks.sort((a,b)=>a.ts-b.ts);
  const LOD = {PCM:0.005, DIC:0.054, CBZ:0.060, ATL:0.080, KTP:0.050};   // DIC/CBZ/ATL LODs (ng→µg/L) after Khasawneh (2022) Table 4.1
  S.hplc = [];
  picks.forEach((r,i)=>{
    const st = stations.find(s=>distM(r,s)<60);
    const sid = `S-${String(i+1).padStart(3,'0')}`;
    const ts = r.ts + Math.round(gauss()*2)*60000;
    const comps = ['PCM']; if(i%9<5) comps.push('DIC','CBZ'); if(i%12<5) comps.push('ATL'); if(i%5===0) comps.push('KTP');
    for(const c of comps){
      let v = r._truth[c]*Math.exp(0.08*gauss()); const lod = LOD[c]; let below=false;
      if(v<lod){ below=true; v=lod/2; }
      S.hplc.push({id:sid+'-'+c, sample_id:sid, ts, lat:+(r.lat+5e-5*gauss()).toFixed(6), lon:+(r.lon+5e-5*gauss()).toFixed(6), station:st.k,
        compound:c, conc:+v.toPrecision(4), lod, below, method:S.compounds[c].method, notes:'demo', origin:'demo'});
    }
  });
  seedReactor(); seedSurvey();
}

/* ---------- photocatalytic reactor demo runs ---------- */
function seedReactor(){
  const mk = (id, catalyst, dose, light, k, hours, step, ads, rep) => {
    const rows=[]; const C0=5.0;
    for(let t=0;t<=hours+1e-9;t+=step){
      const adsF = ads? (1-ads*(1-Math.exp(-t*4))) : 1;
      const C = C0*adsF*Math.exp(-k*t)*(t? Math.exp(0.03*gauss()):1);
      const frac = C/C0;
      rows.push({time_h:+t.toFixed(2), conc:+C.toFixed(4),
        uv:+(0.05 + 0.60*frac + 0.22*(1-frac)*Math.exp(-t/1.8) + (dose? 0.04:0) + 0.005*gauss()).toFixed(4),
        orp:+(245 + (catalyst!=='none'&&light!=='dark'? 120*(1-Math.exp(-t/1.2)) : 8*t) + 5*gauss()).toFixed(1),
        ph:+(6.9 - (catalyst!=='none'&&light!=='dark'? 0.45*(1-Math.exp(-t/1.5)):0.02*t) + 0.02*gauss()).toFixed(3),
        turbidity:+(dose*180 + 3 + 2*gauss()).toFixed(1),
        toc:+(4.1*(1 - (catalyst!=='none'&&light!=='dark'? 0.33*(1-Math.exp(-t/2.2)) : 0.02*t)) + 0.05*gauss()).toFixed(3)});
    }
    return {id, catalyst, dose, light, compound:'PCM', rows, origin:'demo', rep:rep||null};
  };
  S.reactor = [
    mk('R1','Fe2O3-TiO2',0.2,'simulated solar',1.02,3,0.5,0.06),
    mk('R1b','Fe2O3-TiO2',0.2,'simulated solar',0.97,3,0.5,0.06,'R1'),
    mk('R2','TiO2 P25',0.2,'simulated solar',0.71,3,0.5,0.04),
    mk('R3','Fe2O3-TiO2',0.1,'simulated solar',0.78,3,0.5,0.04),
    mk('R4','Fe2O3-TiO2',0.3,'simulated solar',0.86,3,0.5,0.07),
    mk('R5','Fe2O3-TiO2',0.2,'natural solar (pilot)',0.44,5,0.5,0.05),
    mk('C1','none',0,'simulated solar',0.045,3,0.5,0),
    mk('C2','Fe2O3-TiO2',0.2,'dark',0.0,3,0.5,0.08),
  ];
}
function seedSurvey(){
  const methods = [['Household rubbish bin',46],['Kept at home',22],['Returned to pharmacy / clinic',14],['Sink or toilet',9],['Given to family or friends',6],['Other',3]];
  S.survey = [];
  for(let i=0;i<120;i++){
    let u=rnd()*100, m=methods[0][0]; for(const [k,p] of methods){ if(u<p){m=k;break;} u-=p; }
    const f = b => clamp(Math.round(b + gauss()*0.9),1,5);
    S.survey.push({respondent_id:'D'+(i+1), disposal_method:m, awareness:f(3.9), convenience:f(3.6), uncertainty:f(3.4), habit:f(3.2), no_followup:f(3.0), leftover:f(3.8), origin:'demo'});
  }
  S.interviews = [
    {theme:'Convenience', text:'Example: nearest take-back point is a hospital pharmacy; respondents rarely pass it.', origin:'demo'},
    {theme:'Awareness', text:'Example: several respondents did not know clinics accept returned medicines.', origin:'demo'},
    {theme:'Leftover', text:'Example: symptom relief before the course ends leaves partial strips of tablets.', origin:'demo'},
  ];
}

/* ---------- HPLC ↔ sensor matching ---------- */
function lowerBound(ts, arr=S.readings){ let lo=0,hi=arr.length; while(lo<hi){ const m=(lo+hi)>>1; if(arr[m].ts<ts) lo=m+1; else hi=m; } return lo; }
function matchSample(h){
  if(h.sensors){ h.match={ok:true, n:1, dt:0, dist:0, sensors:h.sensors, direct:true}; return h.match; }
  const L=S.primary&&S.primary.length?S.primary:S.readings;   // lab samples pair with the survey vessel's record
  const win = CFG.matchWinMin*60000; const i0=lowerBound(h.ts-win,L), i1=lowerBound(h.ts+win+1,L);
  const pool=[]; for(let i=i0;i<i1;i++){ const r=L[i]; const d=distM(h,r); if(d<=CFG.matchDistM) pool.push({r,d,dt:Math.abs(r.ts-h.ts)}); }
  if(!pool.length){ h.match={ok:false}; return h.match; }
  let wsum=0; const agg={}; const keys=[...Object.keys(PARAMS)];
  for(const p of pool){ const w = 1/(1+p.dt/60000) * 1/(1+p.d/50); wsum+=w; for(const k of keys) agg[k]=(agg[k]||0)+w*p.r[k]; }
  for(const k of keys) agg[k]/=wsum;
  const best = pool.reduce((a,b)=> (a.dt+a.d*1000 < b.dt+b.d*1000 ? a:b));
  agg.hour_sin=Math.sin(2*Math.PI*new Date(h.ts).getHours()/24); agg.hour_cos=Math.cos(2*Math.PI*new Date(h.ts).getHours()/24); agg.lat=h.lat; agg.lon=h.lon;
  h.match = {ok:true, n:pool.length, dt:best.dt/60000, dist:best.d, sensors:agg, readingId:best.r.id};
  return h.match;
}
function matchAll(){ S.hplc.forEach(matchSample); }
function pairs(comp){ return S.hplc.filter(h=>h.compound===comp && h.match && h.match.ok); }

/* ---------- anomaly baseline (EWMA, per water-body segment) ---------- */
// Baselines are kept per salinity class (from conductivity), so a vessel moving from river to sea
// is not flagged simply for changing water body. Same rule as the backend (app/services/anomaly.py).
function zoneOf(r){ const c=r.conductivity; return c>25000 ? 'coast' : c>2500 ? 'estuary' : 'river'; }
const zval = (k,x) => k==='conductivity' ? Math.log10(Math.max(x,1)) : x;   // salinity mixing is multiplicative
function scoreReading(r){
  const zone = zoneOf(r); const bk=(r.device||'')+'|'+zone; S.base[bk] = S.base[bk] || {}; const B=S.base[bk];   // one baseline per boat and water type
  const a = 2/(CFG.baseWin+1); r.z = {}; let maxZ=0, maxK=null;
  for(const k of Object.keys(PARAMS)){
    if(r[k]==null || !isFinite(r[k])) continue;          // a device may measure only some parameters
    const x=zval(k,r[k]); const b=B[k];
    if(!b){ B[k]={m:x, v:(Math.abs(x)*0.05+1e-3)**2, n:1}; r.z[k]=0; continue; }
    const z=(x-b.m)/Math.sqrt(b.v+1e-12); r.z[k]=b.n<12?0:z;
    if(Math.abs(r.z[k])>maxZ){maxZ=Math.abs(r.z[k]); maxK=k;}
    const aa = Math.abs(z)>CFG.zTh ? a*0.25 : a;            // anomalies update the baseline slowly
    const d=x-b.m; b.m+=aa*d; b.v=(1-aa)*(b.v+aa*d*d); b.n++;
  }
  r.maxZ=maxZ; r.maxZk=maxK; r.zone=zone;
}
function rescoreAll(){ S.base={}; const streams=S.fleet.size?[...S.fleet.values()].map(b=>b.readings):[S.readings]; for(const rs of streams){ rs.forEach(scoreReading); rs.forEach(estimateReading); } buildEvents(); }

/* ---------- screening estimate + status per reading ---------- */
function featVec(src, feats){ return feats.map(f=>src[f]); }
function estimateReading(r){
  r.est = r.est || {};
  const src = {...r, hour_sin:Math.sin(2*Math.PI*new Date(r.ts).getHours()/24), hour_cos:Math.cos(2*Math.PI*new Date(r.ts).getHours()/24)};
  for(const [c,m] of Object.entries(S.models)){ if(!m || !m.final) continue; const x=featVec(src, m.feats); if(x.every(v=>v!=null && isFinite(v))) r.est[c] = predictWithUncertainty(m, x); else delete r.est[c]; }   // no estimate without every model input
  const tgt = CFG.target, e = r.est[tgt], lvl = S.compounds[tgt]?.level;
  let st='ok';
  if(r.maxZ>=CFG.zTh) st='warn';
  if(e && lvl){ if(e.mu>=lvl) st='bad'; else if(e.mu>=0.7*lvl && st==='ok') st='warn'; }
  r.status = st;
}

/* ---------- events (grouped abnormal readings) ---------- */
function buildEvents(){
  const ev=[]; let cur=null; const gap=20*60000;
  for(const r of S.readings){
    if(r.status==='ok'){ if(cur && r.ts-cur.end>gap){ ev.push(cur); cur=null; } continue; }
    if(!cur || r.ts-cur.end>gap){ if(cur) ev.push(cur); cur={readings:[], start:r.ts, end:r.ts}; }
    cur.readings.push(r); cur.end=r.ts;
  }
  if(cur) ev.push(cur);
  const tgt=CFG.target;
  S.events = ev.map((e,i)=>{
    const bad = e.readings.some(r=>r.status==='bad');
    const peak = e.readings.reduce((a,b)=> ((b.est[tgt]?.mu??0) + b.maxZ*1e-6 > (a.est[tgt]?.mu??0) + a.maxZ*1e-6 ? b:a));
    const near = S.sources.map(s=>({s, d:distM(peak,s)})).sort((a,b)=>a.d-b.d)[0];
    const lab = S.hplc.filter(h=>h.compound===tgt && Math.abs(h.ts-peak.ts)<=Math.max(CFG.matchWinMin,30)*60000 && distM(h,peak)<=CFG.matchDistM*1.5);
    const imp = Object.fromEntries((S.models[tgt]?.importance||[]).map(i=>[i.f,i.v]));
    const drivers = Object.keys(PARAMS).map(k=>({k, z:peak.z[k]||0, w:Math.abs(peak.z[k]||0)*(1+3*(bad?(imp[k]||0):0))})).sort((a,b)=>b.w-a.w);
    return {id:'EV-'+String(i+1).padStart(3,'0'), start:e.start, end:e.end, n:e.readings.length, status:bad?'bad':'warn', peak, lat:peak.lat, lon:peak.lon,
      est:peak.est[tgt], near, lab, drivers, zone:peak.zone, rain:peak._rain};
  });
  for(const e of S.events){ e.repeats = S.events.filter(o=>o!==e && distM(o,e)<200).length; }
  S.events.reverse();
}
function hotspots(sinceTs){
  const evs = S.events.filter(e=>e.start>=sinceTs); const used=new Set(); const out=[];
  for(const e of evs){ if(used.has(e)) continue; const grp=evs.filter(o=>!used.has(o) && distM(o,e)<200); if(grp.length<2) continue; grp.forEach(g=>used.add(g));
    const lat=mean(grp.map(g=>g.lat)), lon=mean(grp.map(g=>g.lon)); const near=S.sources.map(s=>({s,d:distM({lat,lon},s)})).sort((a,b)=>a.d-b.d)[0];
    out.push({lat, lon, n:grp.length, bad:grp.filter(g=>g.status==='bad').length, meanEst:mean(grp.map(g=>g.est?.mu??0)), near, events:grp}); }
  return out.sort((a,b)=>b.bad-a.bad||b.n-a.n);
}

/* ---------- API (live deployment) ---------- */
const API = {
  url(p){ const b=CFG.apiBase.replace(/\/$/,''); return b + p; },
  async req(p, opt={}){ const h={'Content-Type':'application/json'}; if(CFG.apiKey) h['X-API-Key']=CFG.apiKey;
    const ctl=new AbortController(); const to=setTimeout(()=>ctl.abort(), opt.timeout||8000);
    try{ const r=await fetch(API.url(p), {...opt, headers:{...h,...(opt.headers||{})}, signal:ctl.signal}); if(!r.ok) throw new Error(r.status+' '+(await r.text()).slice(0,200)); const ct=r.headers.get('content-type')||''; return ct.includes('json')? r.json() : r.text(); }
    finally{ clearTimeout(to); } },
  async detect(){
    if(!CFG.apiBase && location.protocol==='file:') return null;   // opened from disk: no backend beside it
    const bases = CFG.apiBase ? [CFG.apiBase] : ['api'];
    for(const b of bases){ try{ CFG.apiBase=b; const h=await API.req('/health',{timeout:2000}); if(h && h.status==='ok') return h; }catch(e){} }
    CFG.apiBase = CFG.apiBase==='api' ? '' : CFG.apiBase; return null;
  },
  async bootstrap(){
    const d = await API.req('/bootstrap', {timeout:20000});
    S.compounds={}; d.compounds.forEach(c=>S.compounds[c.id]=c);
    S.sources=d.sources; S.literature=d.literature||LITERATURE_DEFAULT; S.reactor=d.reactor_runs||[]; S.survey=d.survey||[]; S.interviews=d.interviews||[];
    S.hplc=(d.hplc||[]).map(h=>({...h, ts:Date.parse(h.ts)}));
    const rd = await API.req('/readings?hours='+(CFG.histDays*24)+'&device=', {timeout:30000});
    const all = rd.map(normReading).sort((a,b)=>a.ts-b.ts);
    S.lastLiveTs = all.length ? all[all.length-1].ts : Date.now()-3600e3;
    S.simNow = Date.now(); S.lastTickReal = Date.now();
    fleetFromReadings(all);
  },
  async poll(){
    const since = new Date(S.lastLiveTs).toISOString();
    const rd = await API.req('/readings?since='+encodeURIComponent(since));
    const fresh = rd.map(normReading).filter(r=>r.ts>S.lastLiveTs).sort((a,b)=>a.ts-b.ts);
    if(fresh.length){ S.lastLiveTs = fresh[fresh.length-1].ts; }
    S.simNow = Date.now(); return fresh;
  }
};
function normReading(r){ const o={...r, ts:typeof r.ts==='number'?r.ts:Date.parse(r.ts)}; o.id=o.id||('R'+o.ts); return o; }

/* ---------- OpenStreetMap APIs (Nominatim, Overpass) ----------
   Live mode goes through the backend (/api/geo/*), which caches and rate-limits
   as the OSM usage policies require. Demo mode calls the public endpoints directly. */
const OSM_FACILITIES = [
  ['amenity','hospital','Hospital'],['healthcare','hospital','Hospital'],['amenity','clinic','Clinic'],['amenity','doctors','Clinic'],
  ['amenity','pharmacy','Pharmacy'],['man_made','wastewater_plant','Wastewater treatment plant'],['man_made','outfall','Outfall'],
  ['waterway','drain','Drain'],['amenity','veterinary','Veterinary clinic'],['landuse','industrial','Industrial area']];
const OSM = {
  cache: new Map(), last: 0,
  async reverse(lat, lon){
    const key='r'+lat.toFixed(4)+','+lon.toFixed(4); if(OSM.cache.has(key)) return OSM.cache.get(key);
    let out=null;
    if(CFG.mode==='live') out = await API.req(`/geo/reverse?lat=${lat}&lon=${lon}`, {timeout:12000});
    else {
      const wait = 1050-(Date.now()-OSM.last); if(wait>0) await new Promise(r=>setTimeout(r,wait)); OSM.last=Date.now();   // max 1 request/s
      const r = await fetch(`${CFG.nominatim}/reverse?format=jsonv2&zoom=17&addressdetails=1&lat=${lat}&lon=${lon}`, {headers:{'Accept-Language':'en'}});
      if(!r.ok) throw new Error('Nominatim '+r.status); const j=await r.json(); if(j.error) throw new Error(j.error);
      const a=j.address||{}; const road=a.road||a.pedestrian||a.footway||a.waterway; const area=a.suburb||a.neighbourhood||a.quarter||a.village||a.town; const city=a.city||a.town||a.county;
      out={short:[j.name&&j.name!==road?j.name:null, road, area, city].filter(Boolean).join(', ')||j.display_name, display_name:j.display_name, osm:`${j.osm_type}/${j.osm_id}`};
    }
    OSM.cache.set(key,out); return out;
  },
  async facilities(lat, lon, radius=800){
    const key='f'+lat.toFixed(3)+','+lon.toFixed(3)+','+radius; if(OSM.cache.has(key)) return OSM.cache.get(key);
    let out;
    if(CFG.mode==='live') out = await API.req(`/geo/facilities?lat=${lat}&lon=${lon}&radius=${radius}`, {timeout:40000});
    else {
      const q=`[out:json][timeout:25];(${OSM_FACILITIES.map(([k,v])=>`nwr["${k}"="${v}"](around:${radius},${lat},${lon});`).join('')});out center tags 200;`;
      const r = await fetch(CFG.overpass, {method:'POST', body:'data='+encodeURIComponent(q), headers:{'Content-Type':'application/x-www-form-urlencoded'}});
      if(!r.ok) throw new Error('Overpass '+r.status);
      const j = await r.json(); const seen=new Set(); const items=[];
      for(const el of j.elements||[]){ const p = el.lat!=null? el : el.center; if(!p) continue; const id=`${el.type}/${el.id}`; if(seen.has(id)) continue; seen.add(id);
        const t=el.tags||{}; const cat=(OSM_FACILITIES.find(([k,v])=>t[k]===v)||[])[2]||'Other';
        items.push({osm:id, name:t.name||t['name:en']||`Unnamed ${cat.toLowerCase()}`, category:cat, lat:p.lat, lon:p.lon, dist_m:distM({lat,lon},p), url:`https://www.openstreetmap.org/${id}`}); }
      out={radius_m:radius, items:items.sort((a,b)=>a.dist_m-b.dist_m)};
    }
    OSM.cache.set(key,out); return out;
  },
  link(lat, lon, z=17){ return `https://www.openstreetmap.org/?mlat=${lat.toFixed(5)}&mlon=${lon.toFixed(5)}#map=${z}/${lat.toFixed(5)}/${lon.toFixed(5)}`; }
};
