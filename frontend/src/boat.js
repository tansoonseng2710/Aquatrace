/* ============================================================
   AquaTrace — phone transmitter
   Position from the phone (or a simulated route), simulated sensor
   values from the shared sensor model, sent to the dashboard over
   MQTT (public broker) or to the AquaTrace server's ingest API.
   ============================================================ */
'use strict';
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const BROKERS = {emqx:'wss://broker.emqx.io:8084/mqtt', hivemq:'wss://broker.hivemq.com:8884/mqtt', mosquitto:'wss://test.mosquitto.org:8081'};
const LABEL = {ph:['pH',''], orp:['ORP','mV'], turbidity:['Turbidity','NTU'], uv:['UV absorbance','AU'], temp:['Temperature','°C'], conductivity:['Conductivity','µS/cm'], do:['Dissolved O₂','mg/L']};
// Potential sources on Sungai Pinang (same as the dashboard demo) so readings react when the boat is placed there.
const SOURCES = [
  {lat:5.41090, lon:100.31330, sigma:260, load:1.0}, {lat:5.40830, lon:100.32250, sigma:230, load:1.3},
  {lat:5.40840, lon:100.32560, sigma:180, load:0.8}, {lat:5.39520, lon:100.33300, sigma:420, load:0.35}];
const ROUTE = [[5.410733,100.313743],[5.408132,100.322845],[5.408349,100.325677],[5.407830,100.325927],[5.403843,100.330476],[5.40330,100.33560],[5.41230,100.34330],[5.40330,100.33560],[5.39520,100.33380],[5.39350,100.33620],[5.40330,100.33560],[5.403843,100.330476],[5.408132,100.322845],[5.410733,100.313743]].map(([lat,lon])=>({lat,lon}));
const ANCHOR = {lat:5.40330, lon:100.33560};   // river mouth: where "On Penang map" places the phone's first fix
const SCALE = 15;                              // indoor walking is multiplied so movement is visible on the map

const st = {
  dev:'', name:'', code:'', broker:'emqx', brokerUrl:'', transport:'mqtt', apiUrl:'', apiKey:'', interval:5, mode:'gps', wake:true,
  running:false, timer:null, seq:0, sent:0, queue:[], trip:[], client:null, conn:'off', fix:null, origin:null, prev:null,
  dischargeUntil:0, routeStart:0, battery:null, wakeLock:null, dom:0.3, lastErr:'', geoWatch:null,
};

/* ---------- utilities ---------- */
function distM(a,b){ const R=6371000, t=Math.PI/180; const dLa=(b.lat-a.lat)*t, dLo=(b.lon-a.lon)*t; const s=Math.sin(dLa/2)**2+Math.cos(a.lat*t)*Math.cos(b.lat*t)*Math.sin(dLo/2)**2; return 2*R*Math.asin(Math.sqrt(s)); }
function gauss(){ let u=0,v=0; while(!u)u=Math.random(); while(!v)v=Math.random(); return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v); }
function save(){ try{ const {dev,name,code,broker,brokerUrl,transport,apiUrl,apiKey,interval,mode,wake}=st; localStorage.setItem('aquatrace.boat', JSON.stringify({dev,name,code,broker,brokerUrl,transport,apiUrl,apiKey,interval,mode,wake})); }catch(e){} }
function load(){ try{ Object.assign(st, JSON.parse(localStorage.getItem('aquatrace.boat')||'{}')); }catch(e){} try{ st.trip = JSON.parse(localStorage.getItem('aquatrace.trip')||'[]'); }catch(e){ st.trip=[]; } }
function msg(text, bad){ const m=$('#msg'); if(!text){ m.hidden=true; return; } m.hidden=false; m.className='msg'+(bad?' bad':''); m.textContent=text; }
function topicBase(){ return `aquatrace/demo/${st.code}/${st.dev}`; }
function brokerUrl(){ return st.broker==='custom' ? st.brokerUrl : (BROKERS[st.broker] || st.broker); }

/* ---------- position ---------- */
function startGeo(){
  if(st.geoWatch!=null || st.mode==='route') return;
  if(!('geolocation' in navigator)){ msg('This browser has no location access. Choose "Simulated route" instead.', true); return; }
  st.geoWatch = navigator.geolocation.watchPosition(p=>{
    st.fix = {lat:p.coords.latitude, lon:p.coords.longitude, acc:p.coords.accuracy, t:Date.now()};
    if(!st.origin) st.origin = {...st.fix};
    if(st.mode!=='route') msg('');
    renderPos();
  }, err=>{
    const why = err.code===1 ? 'Location permission was refused. Allow location for this site in the browser settings, or choose "Simulated route".' : 'No GPS fix yet. Indoors this can take a while; "On Penang map" or "Simulated route" work without a good fix.';
    msg(why, err.code===1);
  }, {enableHighAccuracy:true, maximumAge:2000, timeout:20000});
}
function stopGeo(){ if(st.geoWatch!=null){ navigator.geolocation.clearWatch(st.geoWatch); st.geoWatch=null; } }
function routePos(){
  const speed = 12;   // m/s, faster than a boat so movement is visible in a short demo
  const L=[]; let tot=0; for(let i=1;i<ROUTE.length;i++){ const d=distM(ROUTE[i-1],ROUTE[i]); L.push(d); tot+=d; }
  let d = ((Date.now()-st.routeStart)/1000*speed) % tot, i=0; while(d>L[i]){ d-=L[i]; i++; }
  const f=d/L[i]; return {lat:ROUTE[i].lat+(ROUTE[i+1].lat-ROUTE[i].lat)*f, lon:ROUTE[i].lon+(ROUTE[i+1].lon-ROUTE[i].lon)*f, acc:null};
}
function currentPos(){
  if(st.mode==='route') return routePos();
  if(!st.fix) return null;
  if(st.mode==='relative'){
    const o=st.origin||st.fix; const dLat=(st.fix.lat-o.lat)*SCALE, dLon=(st.fix.lon-o.lon)*SCALE*Math.cos(o.lat*Math.PI/180)/Math.cos(ANCHOR.lat*Math.PI/180);
    return {lat:ANCHOR.lat+dLat, lon:ANCHOR.lon+dLon, acc:st.fix.acc};
  }
  return {lat:st.fix.lat, lon:st.fix.lon, acc:st.fix.acc};
}

/* ---------- simulated sensors ---------- */
function makeReading(p){
  const now=Date.now(); const h=new Date().getHours()+new Date().getMinutes()/60;
  const sf = seaFracAt(p.lat, p.lon);
  let s = 0.04;
  for(const src of SOURCES) s += src.load*0.6*Math.exp(-0.5*(distM(p,src)/src.sigma)**2);
  const remain = st.dischargeUntil-now;
  if(remain>0){ const ramp=Math.min(1,(120000-remain)/15000, remain/15000+0.2); s += Math.max(0,ramp)*1.8/(1-0.62*sf); }
  const se0 = s*(1-0.62*sf); const se = se0/(1+0.35*se0);
  st.dom = Math.max(0, Math.min(1, st.dom + 0.01*gauss()));
  const v = sensorsFrom({se, sf, rain:0, domU:st.dom*(1-0.7*sf), h, n:gauss});
  const r = {device:st.dev, name:st.name, ts:new Date(now).toISOString(), seq:++st.seq, lat:+p.lat.toFixed(6), lon:+p.lon.toFixed(6), acc:p.acc!=null?Math.round(p.acc):null,
    mode:st.mode, battery:st.battery, net:(navigator.connection&&navigator.connection.effectiveType)||null, discharge:remain>0};
  if(st.prev) r.heading = Math.atan2(p.lon-st.prev.lon, p.lat-st.prev.lat);
  st.prev = p;
  for(const k in v) r[k] = +v[k].toFixed(SENSOR_DP[k]+1);
  return r;
}

/* ---------- transport ---------- */
function setConn(c, text){ st.conn=c; const m={off:['','Not connected'],connecting:['warn','Connecting…'],ok:['ok','Connected'],error:['bad','No connection'],server:['ok','Server']}[c]; $('#conn').className='pill '+m[0]; $('#conn').innerHTML=`<span class="dot"></span>${esc(text||m[1])}`; }
function connect(){
  disconnect();
  if(st.transport==='server'){ setConn(st.apiUrl?'server':'error', st.apiUrl?'Server':'Set the server address'); return; }
  if(!window.mqtt){ setConn('error','Library missing'); msg('The messaging library did not load. Check the internet connection and reload the page.', true); return; }
  if(!st.code){ setConn('error','No fleet code'); msg('Enter the fleet code shown on the dashboard, or scan its QR code.', true); return; }
  setConn('connecting');
  const c = mqtt.connect(brokerUrl(), {clientId:'aquatrace-'+st.dev+'-'+Math.random().toString(16).slice(2,6), reconnectPeriod:3000, connectTimeout:8000, clean:true});
  st.client = c;
  c.on('connect', ()=>{ setConn('ok'); c.subscribe(`${topicBase()}/cmd`); flush(); });
  c.on('reconnect', ()=>setConn('connecting'));
  c.on('offline', ()=>setConn('error','Offline, buffering'));
  c.on('error', e=>{ st.lastErr=String(e&&e.message||e); setConn('error'); });
  c.on('message', (t, buf)=>{ try{ const m=JSON.parse(new TextDecoder().decode(buf)); if(m.cmd==='discharge') startDischarge(m.minutes||2, true); }catch(e){} });
}
function disconnect(){ if(st.client){ try{ st.client.end(true); }catch(e){} st.client=null; } setConn('off'); }
async function send(r){
  st.queue.push(r); if(st.queue.length>500) st.queue.shift();
  await flush();
}
async function flush(){
  if(!st.queue.length) return;
  if(st.transport==='server'){
    if(!st.apiUrl) return;
    const batch = st.queue.slice(0,50);
    try{
      const res = await fetch(st.apiUrl.replace(/\/$/,'')+'/ingest', {method:'POST', headers:{'Content-Type':'application/json','X-API-Key':st.apiKey,'X-Device-Id':st.dev}, body:JSON.stringify(batch)});
      if(!res.ok) throw new Error('server answered '+res.status);
      st.queue.splice(0,batch.length); st.sent+=batch.length; setConn('server','Server'); msg('');
    }catch(e){ setConn('error','Server unreachable, buffering'); msg(`Could not reach the server (${e.message}). Readings are kept and sent when it is back.`); }
    return;
  }
  if(!st.client || !st.client.connected) return;
  while(st.queue.length){ const r=st.queue.shift(); st.client.publish(`${topicBase()}/readings`, JSON.stringify(r), {qos:0}); st.sent++; }
}

/* ---------- loop ---------- */
async function step(){
  const p = currentPos();
  if(!p){ $('#state').textContent='Waiting for a position'; return; }
  const r = makeReading(p);
  st.trip.push(r); if(st.trip.length>3000) st.trip.shift();
  try{ localStorage.setItem('aquatrace.trip', JSON.stringify(st.trip)); }catch(e){}
  await send(r);
  render(r);
}
async function start(){
  st.running=true; st.routeStart = st.routeStart || Date.now(); save();
  $('#startBtn').textContent='Stop sending'; $('#startBtn').className='btn stop block'; $('#disBtn').disabled=false;
  startGeo(); connect();
  if(st.wake) requestWake();
  try{ if(navigator.getBattery){ const b=await navigator.getBattery(); st.battery=+b.level.toFixed(2); b.addEventListener('levelchange',()=>st.battery=+b.level.toFixed(2)); } }catch(e){}
  clearInterval(st.timer); st.timer=setInterval(step, st.interval*1000); step();
}
function stop(){
  st.running=false; clearInterval(st.timer); st.timer=null; disconnect(); releaseWake();
  $('#startBtn').textContent='Start sending'; $('#startBtn').className='btn pri block'; $('#disBtn').disabled=true;
  $('#state').textContent='Stopped'; $('#stateSub').textContent=`${st.sent} readings sent this session.`;
}
function startDischarge(minutes=2, remote){
  st.dischargeUntil = Date.now()+minutes*60000; renderDischarge();
  if(remote) msg('The dashboard started a simulated discharge on this boat.');
}
function renderDischarge(){
  const b=$('#disBtn'); const left=Math.max(0,Math.round((st.dischargeUntil-Date.now())/1000));
  if(left>0){ b.classList.add('on'); b.textContent=`Discharge running · ${Math.floor(left/60)}:${String(left%60).padStart(2,'0')} · tap to stop`; }
  else { b.classList.remove('on'); b.textContent='Simulate discharge'; }
}

/* ---------- screen wake lock ---------- */
async function requestWake(){ try{ if('wakeLock' in navigator && document.visibilityState==='visible'){ st.wakeLock = await navigator.wakeLock.request('screen'); } }catch(e){} }
function releaseWake(){ try{ st.wakeLock && st.wakeLock.release(); }catch(e){} st.wakeLock=null; }
document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState==='visible' && st.running){ if(st.wake) requestWake(); step(); } });

/* ---------- rendering ---------- */
const MODE_HELP = {
  gps:'Uses this phone\'s real location. Best outdoors or on a boat.',
  relative:`Places the phone at the Sungai Pinang river mouth and moves it as you walk (movement ×${SCALE}). Good for indoor demonstrations.`,
  route:'Moves along the Sungai Pinang survey route without GPS. Works anywhere, even with location turned off.'};
function renderPos(){
  const p=currentPos(); const rows=[];
  if(p){ rows.push(['Position', `${p.lat.toFixed(5)}° N, ${p.lon.toFixed(5)}° E`]); }
  if(st.mode!=='route') rows.push(['GPS accuracy', st.fix?`±${Math.round(st.fix.acc)} m`:'Waiting for a fix']);
  rows.push(['Water type', seaFracAt(p?p.lat:0,p?p.lon:0)>0.5?'Coastal':'River']);
  $('#pos').innerHTML = rows.map(([a,b])=>`<dt>${a}</dt><dd>${esc(b)}</dd>`).join('');
}
function render(r){
  $('#state').textContent = st.conn==='ok'||st.conn==='server' ? `Sending every ${st.interval} s` : 'Recording, not yet delivered';
  $('#stateSub').textContent = `${st.sent} readings delivered${st.queue.length?`, ${st.queue.length} waiting`:''} · last ${new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})}`;
  $('#readings').innerHTML = Object.keys(LABEL).map(k=>{ const hi = r.discharge && ['uv','orp','do','ph','turbidity'].includes(k); const [l,u]=LABEL[k]; return `<div class="rd${hi?' hi':''}"><span>${l}</span><b>${r[k].toFixed(SENSOR_DP[k])}<small>${u}</small></b></div>`; }).join('');
  $('#tripInfo').textContent = `${st.trip.length} readings in this trip`;
  renderPos(); renderDischarge();
}
function renderSettings(){
  $('#name').value=st.name; $('#codeShow').textContent=st.code||'none'; $('#devShow').textContent=st.dev; $('#code').value=st.code;
  $('#broker').value = BROKERS[st.broker]||st.broker==='custom' ? st.broker : 'custom'; if(!BROKERS[st.broker] && st.broker!=='custom'){ st.brokerUrl=st.broker; st.broker='custom'; }
  $('#brokerUrl').value=st.brokerUrl; $('#brokerUrlWrap').hidden = st.broker!=='custom';
  $('#transport').value=st.transport; $('#mqttBox').hidden = st.transport!=='mqtt'; $('#serverBox').hidden = st.transport!=='server';
  $('#apiUrl').value=st.apiUrl; $('#apiKey').value=st.apiKey; $('#interval').value=String(st.interval); $('#wake').checked=st.wake;
  $$('#modeSeg button').forEach(b=>b.classList.toggle('on', b.dataset.m===st.mode)); $('#modeHelp').textContent = MODE_HELP[st.mode];
  $('#tripInfo').textContent = `${st.trip.length} readings in this trip`;
}

/* ---------- controls ---------- */
$('#startBtn').onclick = ()=> st.running ? stop() : start();
$('#disBtn').onclick = ()=>{ if(st.dischargeUntil>Date.now()){ st.dischargeUntil=0; renderDischarge(); } else startDischarge(2); if(st.running) step(); };
$('#name').onchange = e=>{ st.name=e.target.value.trim()||st.name; save(); };
$('#code').onchange = e=>{ st.code=e.target.value.trim().toUpperCase(); $('#codeShow').textContent=st.code; save(); if(st.running) connect(); };
$('#broker').onchange = e=>{ st.broker=e.target.value; $('#brokerUrlWrap').hidden=st.broker!=='custom'; save(); if(st.running) connect(); };
$('#brokerUrl').onchange = e=>{ st.brokerUrl=e.target.value.trim(); save(); if(st.running) connect(); };
$('#transport').onchange = e=>{ st.transport=e.target.value; renderSettings(); save(); if(st.running) connect(); };
$('#apiUrl').onchange = e=>{ st.apiUrl=e.target.value.trim(); save(); if(st.running) connect(); };
$('#apiKey').onchange = e=>{ st.apiKey=e.target.value.trim(); save(); };
$('#interval').onchange = e=>{ st.interval=+e.target.value; save(); if(st.running){ clearInterval(st.timer); st.timer=setInterval(step, st.interval*1000); } };
$('#wake').onchange = e=>{ st.wake=e.target.checked; save(); if(st.running) (st.wake?requestWake():releaseWake()); };
$('#modeSeg').onclick = e=>{ const b=e.target.closest('button'); if(!b) return; st.mode=b.dataset.m; st.origin=st.fix?{...st.fix}:null; st.prev=null; if(st.mode==='route'){ st.routeStart=Date.now(); stopGeo(); msg(''); } else if(st.running) startGeo(); save(); renderSettings(); renderPos(); };
$('#dlTrip').onclick = ()=>{ const blob=new Blob([JSON.stringify({boat:st.name, device:st.dev, readings:st.trip}, null, 1)], {type:'application/json'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`aquatrace-trip-${st.dev}-${new Date().toISOString().slice(0,16).replace(/[:T]/g,'')}.json`; document.body.appendChild(a); a.click(); a.remove(); };
$('#clearTrip').onclick = ()=>{ st.trip=[]; try{ localStorage.removeItem('aquatrace.trip'); }catch(e){} $('#tripInfo').textContent='0 readings in this trip'; };
setInterval(()=>{ if(st.dischargeUntil) renderDischarge(); }, 1000);

/* ---------- boot ---------- */
(function boot(){
  load();
  const q = new URLSearchParams(location.search);
  if(!st.dev){ st.dev = 'PHONE-'+Math.random().toString(36).slice(2,6).toUpperCase(); }
  if(!st.name){ st.name = 'Phone boat '+st.dev.slice(-4); }
  if(q.get('code')) st.code=q.get('code').toUpperCase();
  if(q.get('broker')){ const b=q.get('broker'); if(BROKERS[b]) st.broker=b; else { st.broker='custom'; st.brokerUrl=b; } st.transport='mqtt'; }
  if(q.get('api')){ st.transport='server'; st.apiUrl=q.get('api'); }
  if(q.get('name')) st.name=q.get('name');
  if(['gps','relative','route'].includes(q.get('mode'))) st.mode=q.get('mode');
  save(); renderSettings(); renderPos();
  if(!st.code && st.transport==='mqtt') msg('Scan the QR code on the dashboard\'s Fishing fleet page, or enter its fleet code under Connection and settings.');
  if(!window.isSecureContext && st.mode!=='route') msg('Location needs a secure (https) page. Open this page from your https site, or choose "Simulated route".', true);
})();
