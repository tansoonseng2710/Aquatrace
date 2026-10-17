/* ============================================================
   AquaTrace — fishing fleet: boat registry, simulated boats,
   phones joining over MQTT, replayed trips, follow-a-boat.
   Every boat keeps its own reading stream and baseline; the boat
   being followed drives the Overview, Trends, Map and Events pages.
   ============================================================ */
const PRIMARY = 'BOAT-01';
// Fictional boats on fishing grounds in the channel between George Town and the mainland.
const FLEET_SIM = [
  {id:'PKFB-1027', name:'Sri Pinang 3',   ground:{lat:5.4185, lon:100.3505}, rx:520, ry:380, period:95,  phase:0.1},
  {id:'PKFB-0841', name:'Bintang Laut',   ground:{lat:5.3880, lon:100.3450}, rx:420, ry:520, period:80,  phase:0.6},
  {id:'PKFB-1310', name:'Camar Biru',     ground:{lat:5.3790, lon:100.3470}, rx:650, ry:450, period:110, phase:0.3},
  {id:'PKFB-0552', name:'Seri Jelutong',  ground:{lat:5.3600, lon:100.3400}, rx:600, ry:600, period:120, phase:0.8},
  {id:'PKFB-1188', name:'Ikan Bilis 7',   ground:{lat:5.3380, lon:100.3460}, rx:700, ry:500, period:100, phase:0.45},
  {id:'PKFB-0975', name:'Pantai Jerejak', ground:{lat:5.3230, lon:100.3330}, rx:500, ry:700, period:130, phase:0.9},
];
const KIND_LABEL = {survey:'Survey vessel', sim:'Simulated boat', phone:'Phone', replay:'Recorded trip', server:'Server device', node:'Sensor node'};
const MAX_PER_BOAT = 4000;
S.fleetAlerts = [];

function boat(id){ return S.fleet.get(id); }
function ensureBoat(id, props={}){
  let b = S.fleet.get(id);
  if(!b){ b = {id, name:props.name||id, kind:props.kind||'server', readings:[], last:null, meta:{}, lastSeenReal:0, dischargeUntil:0, alertAt:0, ...props}; S.fleet.set(id, b); }
  else Object.assign(b, Object.fromEntries(Object.entries(props).filter(([k,v])=>v!=null && k!=='readings')));
  return b;
}
function clockNow(){ return S.simNow + (S.realtime ? Date.now()-S.lastTickReal : 0); }

/* ---------- simulated boats ---------- */
function simPos(b, ts){
  const t = ((ts/60000)/b.period + b.phase) * 2*Math.PI;
  const mLat = 1/111320, mLon = 1/(111320*Math.cos(b.ground.lat*Math.PI/180));
  const lat = b.ground.lat + b.ry*Math.sin(t)*mLat + 60*Math.sin(3.1*t)*mLat;
  const lon = b.ground.lon + b.rx*Math.cos(t)*mLon + 60*Math.cos(2.3*t)*mLon;
  return {lat, lon, heading:Math.atan2(-b.rx*Math.sin(t)*mLon, b.ry*Math.cos(t)*mLat)};
}
function dischargeLoad(b, ts, p){
  if(!b || ts >= b.dischargeUntil) return 0;
  return 1.8/(1-0.62*seaFrac(p));            // strong enough to show through seawater dilution
}
function simReading(b, ts){
  const p = simPos(b, ts);
  const extra = dischargeLoad(b, ts, p);
  const w = world(ts, p, true, extra);
  const r = {id:b.id+'-'+ts, ts, device:b.id, lat:+p.lat.toFixed(6), lon:+p.lon.toFixed(6), heading:p.heading, _rain:w.rain, battery:null};
  for(const k in w.r) r[k] = +w.r[k].toFixed(PARAMS[k].dp+1);
  return r;
}
function seedFleet(){
  S.fleet = new Map(); S.fleetAlerts = [];
  const pb = ensureBoat(PRIMARY, {name:'Survey boat', kind:'survey'});
  pb.readings = S.readings; S.primary = S.readings;
  const t0 = S.simNow - 6*3600e3;
  for(const def of FLEET_SIM){
    const b = ensureBoat(def.id, {...def, kind:'sim'});
    b.readings = [];
    for(let ts=t0; ts<=S.simNow; ts+=10*60000) b.readings.push(simReading(b, ts));
  }
  S.follow = PRIMARY; S.readings = pb.readings;
}
/* live server: one boat per device; the device with the longest record is the survey vessel */
function fleetFromReadings(all){
  S.fleet = new Map(); S.fleetAlerts = [];
  const by = {}; for(const r of all) (by[r.device||'UNKNOWN'] = by[r.device||'UNKNOWN'] || []).push(r);
  const ids = Object.keys(by).sort((a,b)=>by[b].length-by[a].length);
  ids.forEach((id,i)=>{ const x=by[id][by[id].length-1]; const b=ensureBoat(id, {name:(x.extra&&x.extra.name)||id, kind:i===0?'survey':(x.extra&&NODE_KINDS.has(x.extra.kind)?'node':x.extra&&x.extra.mode?'phone':'server')}); b.readings=by[id]; b.last=x; b.lastSeenReal=x.ts; b.meta=metaFromMsg(x.extra||{}, b.meta); });
  const first = ids[0];
  S.primary = first ? by[first] : []; S.follow = first || PRIMARY; S.readings = S.primary;
}
function simFleetStep(ts){ for(const b of S.fleet.values()) if(b.kind==='sim') addReading(b.id, simReading(b, ts)); }

/* ---------- one entry point for every new reading ---------- */
function addReading(id, r, props){
  const b = ensureBoat(id, props);
  r.device = id; r.id = r.id || id+'-'+r.ts;
  const prev = b.last;
  if(prev && r.ts <= prev.ts) r.ts = prev.ts + 1000;          // keep each stream strictly ordered
  scoreReading(r); estimateReading(r);
  b.readings.push(r); b.last = r;
  if(b.readings.length > MAX_PER_BOAT) b.readings.splice(0, b.readings.length - MAX_PER_BOAT);
  if(r.status==='bad' && (!prev || prev.status!=='bad') && r.ts - b.alertAt > 10*60000){
    b.alertAt = r.ts;
    const e = r.est?.[CFG.target];
    S.fleetAlerts.unshift({boat:id, name:b.name, ts:r.ts, lat:r.lat, lon:r.lon, est:e?.mu, kind:b.kind});
    S.fleetAlerts.length = Math.min(S.fleetAlerts.length, 50);
    if(id!==PRIMARY || S.follow===PRIMARY) toast(`⚠ Possible contamination reported by ${b.name} at ${r.lat.toFixed(4)}° N, ${r.lon.toFixed(4)}° E. Laboratory confirmation recommended.`);
  }
  return b;
}
/* readings from phones / replays carry their own sensor values; the dashboard clock stamps them */
function ingestRemote(msg, kind){
  if(!msg || !msg.device || !isFinite(msg.lat) || !isFinite(msg.lon)) return;
  if((kind==='phone'||kind==='node') && CFG.mode==='demo' && !S.realtime){ S.realtime=true; S.simNow=clockNow(); S.lastTickReal=Date.now(); toast(kind==='node'?'A sensor node is sending. The demo clock now runs in real time.':'A phone joined the fleet. The demo clock now runs in real time.'); }
  const r = {ts: kind==='server' ? (typeof msg.ts==='number'?msg.ts:Date.parse(msg.ts)) : clockNow(), lat:+msg.lat, lon:+msg.lon, heading:msg.heading||0, sent_ts:msg.ts};
  for(const k of Object.keys(PARAMS)) r[k] = msg[k]!=null && isFinite(+msg[k]) ? +msg[k] : null;
  if(!Object.keys(PARAMS).some(k=>r[k]!=null)) return;            // needs at least one sensor value
  r.raw = {ph_mv:msg.ph_mv, turb_mv:msg.turb_mv};
  const b = addReading(msg.device, r, {name:msg.name||msg.device, kind});
  b.lastSeenReal = Date.now();
  b.meta = metaFromMsg(msg, b.meta);
  if(msg.ack && !(b.acks&&b.acks[0]&&b.acks[0].text===String(msg.ack)&&Date.now()-b.acks[0].t<90000)){ (b.acks=b.acks||[]).unshift({t:Date.now(), text:String(msg.ack)}); b.acks.length=Math.min(b.acks.length,20); if(VIEW==='node') toast(`${b.name}: ${msg.ack}`); }
  if(S.follow===b.id){ buildEvents(); }
  if(S.autoFollow && (kind==='phone'||kind==='node') && S.follow!==b.id && !S.followedOnce?.has(b.id)){ (S.followedOnce=S.followedOnce||new Set()).add(b.id); followBoat(b.id, true); }
}
function metaFromMsg(msg, prev){
  return {...(prev||{}), battery:msg.battery, acc:msg.acc, mode:msg.mode, discharge:!!msg.discharge, net:msg.net, seq:msg.seq,
    fw:msg.fw, rssi:msg.rssi, uptime:msg.uptime_s, every:msg.every_s, cal:msg.cal, turbCal:msg.turb_cal, ph_mv:msg.ph_mv, turb_mv:msg.turb_mv, vcc:msg.vcc_mv, hw:msg.kind||prev?.hw, via:msg._via||msg.via||prev?.via};
}
const NODE_KINDS = new Set(['esp32','nano']);
function msgKind(msg){ return NODE_KINDS.has(msg.kind) ? 'node' : 'phone'; }
function followBoat(id, quiet){
  const b = boat(id); if(!b) return;
  S.follow = id; S.readings = b.readings; CFG.device = id;
  SEL_EV = null; buildEvents();
  if(!quiet) toast(`Now following ${b.name}`);
  $('#followName') && ($('#followName').textContent = b.name);
  renderView(true);
}
function triggerDischarge(id, minutes=2){
  const b = boat(id); if(!b) return;
  if(b.kind==='sim' || b.kind==='survey'){
    b.dischargeUntil = clockNow() + minutes*60000*(S.realtime?1:20);   // demo clock runs 20x when no phone is connected
    toast(`Simulated discharge started near ${b.name}`);
  } else if(b.kind==='phone'){
    if(LINK.client && LINK.status==='connected'){ LINK.client.publish(`${linkTopicBase()}/${id}/cmd`, JSON.stringify({cmd:'discharge', minutes})); toast(`Discharge command sent to ${b.name}`); }
    else toast('Connect to the broker first (Fleet page, Live connection).');
  }
}
function boatState(b){
  if(!b.last) return 'offline';
  if((b.kind==='phone'||b.kind==='node') && Date.now()-b.lastSeenReal > Math.max(30000, 3000*(b.meta?.every||0))) return 'offline';
  return b.last.status || 'ok';
}
function fleetCoverageKm2(hours=24){
  const since = clockNow()-hours*3600e3; const cells=new Set();
  for(const b of S.fleet.values()) for(let i=b.readings.length-1;i>=0;i--){ const r=b.readings[i]; if(r.ts<since) break; cells.add(Math.round(r.lat/0.0018)+':'+Math.round(r.lon/0.0018)); }
  return {cells:cells.size, km2:cells.size*0.04};
}

/* ---------- recorded trips (replay) ---------- */
S.replays = [];
function loadTrip(rows, name){
  const clean = rows.filter(r=>isFinite(+r.lat)&&isFinite(+r.lon)&&Object.keys(PARAMS).every(k=>isFinite(+r[k])));
  if(!clean.length) throw new Error('No readings with position and all seven sensor values were found in this file.');
  const id = 'TRIP-'+Math.random().toString(36).slice(2,6).toUpperCase();
  ensureBoat(id, {name:name||'Recorded trip', kind:'replay'});
  S.replays.push({id, rows:clean, i:0});
  return id;
}
function replayStep(){
  for(const rp of S.replays){
    for(let k=0;k<2 && rp.i<rp.rows.length;k++){ const r = rp.rows[rp.i++]; ingestRemote({...r, device:rp.id, name:boat(rp.id).name}, 'replay'); }   // two readings per update
    boat(rp.id).meta.progress = rp.i/rp.rows.length;
  }
  S.replays = S.replays.filter(rp=>rp.i<rp.rows.length);
}
/* A built-in trip along Sungai Pinang with a discharge near Kampung Rawa: the fallback when no phone or network is available. */
function sampleTrip(){
  const path=['SP1','SP2','SP3','SP4','SP5','MOUTH'].map(k=>PLACES[k]); const rows=[]; const R=mulberry32(99); const g=()=>{let u=0,v=0;while(!u)u=R();while(!v)v=R();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);};
  const N=120; let L=0; const seg=[]; for(let i=1;i<path.length;i++){ const d=distM(path[i-1],path[i]); seg.push(d); L+=d; }
  for(let i=0;i<N;i++){
    let d=L*i/(N-1), j=0; while(j<seg.length-1 && d>seg[j]){ d-=seg[j]; j++; }
    const f=Math.min(1,d/seg[j]); const lat=path[j].lat+(path[j+1].lat-path[j].lat)*f, lon=path[j].lon+(path[j+1].lon-path[j].lon)*f;
    const pulse = Math.exp(-0.5*((i-38)/7)**2)*1.7;            // discharge plume passed around reading 38
    const se = 0.12 + 0.25*Math.exp(-0.5*(distM({lat,lon},PLACES.SP2)/300)**2) + pulse;
    const v = sensorsFrom({se: se/(1+0.35*se), sf:seaFracAt(lat,lon), rain:0, domU:0.3, h:10, n:g});
    rows.push({lat:+lat.toFixed(6), lon:+lon.toFixed(6), ...Object.fromEntries(Object.entries(v).map(([k,x])=>[k,+x.toFixed(SENSOR_DP[k]+1)]))});
  }
  return rows;
}

/* ---------- live connection (MQTT over secure WebSockets) ---------- */
const BROKERS = {
  emqx:{label:'EMQX public broker', url:'wss://broker.emqx.io:8084/mqtt'},
  hivemq:{label:'HiveMQ public broker', url:'wss://broker.hivemq.com:8884/mqtt'},
  mosquitto:{label:'Eclipse Mosquitto test broker', url:'wss://test.mosquitto.org:8081'},
};
const LINK = {client:null, status:'off', error:''};
function newFleetCode(){ const a='ABCDEFGHJKMNPQRSTUVWXYZ23456789'; let c=''; for(let i=0;i<5;i++) c+=a[Math.floor(Math.random()*a.length)]; return c; }
function linkTopicBase(){ return `aquatrace/demo/${CFG.fleetCode}`; }
function brokerUrl(){ return CFG.broker==='custom' ? CFG.brokerUrl : (BROKERS[CFG.broker]||BROKERS.emqx).url; }
function linkConnect(){
  linkDisconnect();
  if(!window.mqtt){ LINK.status='error'; LINK.error='The MQTT library did not load.'; renderLinkStatus(); return; }
  LINK.status='connecting'; LINK.error=''; renderLinkStatus();
  try{
    const c = mqtt.connect(brokerUrl(), {clientId:'aquatrace-dash-'+Math.random().toString(16).slice(2,10), reconnectPeriod:4000, connectTimeout:8000, clean:true});
    LINK.client = c;
    c.on('connect', ()=>{ LINK.status='connected'; LINK.error=''; c.subscribe(`${linkTopicBase()}/+/readings`, {qos:0}); c.subscribe(`${linkTopicBase()}/+/cmd`, {qos:0}); renderLinkStatus(); });
    c.on('reconnect', ()=>{ LINK.status='connecting'; renderLinkStatus(); });
    c.on('close', ()=>{ if(LINK.status!=='off'){ LINK.status='connecting'; renderLinkStatus(); } });
    c.on('error', err=>{ LINK.error=String(err&&err.message||err); renderLinkStatus(); });
    c.on('message', (topic, buf)=>{ try{ if(topic.endsWith('/cmd')){ if(typeof usbRelayCmd==='function') usbRelayCmd(topic, new TextDecoder().decode(buf)); return; } const m=JSON.parse(new TextDecoder().decode(buf)); if(window.USB && USB.status==='connected' && USB.deviceId===m.device) return; ingestRemote(m, msgKind(m)); if(VIEW==='fleet') renderFleet(false); else if(VIEW==='node') renderNode(false); }catch(e){ console.warn('bad message', e); } });
  }catch(e){ LINK.status='error'; LINK.error=e.message; renderLinkStatus(); }
}
function sendNodeCmd(id, cmd, value){
  if(window.USB && USB.deviceId===id && USB.status==='connected') return usbSend(value==null?{cmd}:{cmd, value});
  if(!(LINK.client && LINK.status==='connected')){ toast('Connect to the broker first (Fishing fleet page, Connection settings).'); return false; }
  LINK.client.publish(`${linkTopicBase()}/${id}/cmd`, JSON.stringify(value==null?{cmd}:{cmd, value})); return true;
}
function linkDisconnect(){ if(LINK.client){ LINK.status='off'; try{ LINK.client.end(true); }catch(e){} LINK.client=null; } }
