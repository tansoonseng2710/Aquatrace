/* ============================================================
   AquaTrace — Sensor node page (Arduino Nano or ESP32 + PH-4502C + TS-300B)
   Shows only what the hardware measures, with calibration controls that send
   commands back to the node: over USB (Web Serial) for a Nano, MQTT for an ESP32.
   ============================================================ */
const NODE = {sel:null, winMin:10, marks:{}, sim:null, board:(()=>{ try{ return localStorage.getItem('aq.board')||'nano'; }catch(e){ return 'nano'; } })()};
const NODE_KEYS = ['ph','turbidity','temp'];
const BROKER_TCP = {emqx:'broker.emqx.io', hivemq:'broker.hivemq.com', mosquitto:'test.mosquitto.org'};
function brokerTcpHost(){ if(CFG.broker!=='custom') return BROKER_TCP[CFG.broker]||BROKER_TCP.emqx; try{ return new URL(CFG.brokerUrl).hostname; }catch(e){ return 'your broker'; } }
function nodeList(){ return [...S.fleet.values()].filter(b=>b.kind==='node'); }
function rssiLabel(r){ return r==null?'–':r>-60?'Good':r>-70?'Fair':'Weak'; }
function fmtDur(s){ if(s==null) return '–'; const h=Math.floor(s/3600), m=Math.floor(s%3600/60); return h?`${h} h ${m} min`:m?`${m} min`:`${s} s`; }

/* Chart.js plugin: vertical marker lines with a note */
const markerPlugin = {id:'markers', afterDatasetsDraw(chart, args, o){
  const list=o&&o.list||[]; if(!list.length) return; const {ctx, chartArea:{top,bottom}, scales:{x}} = chart;
  ctx.save(); ctx.strokeStyle=o.color; ctx.fillStyle=o.color; ctx.lineWidth=1.2; ctx.font=`600 12px ${o.font}`;
  const placed=[];                                                     // stagger notes that would overlap
  for(const m of list){ const px=x.getPixelForValue(m.t); if(px<x.left||px>x.right) continue;
    ctx.setLineDash([4,3]); ctx.beginPath(); ctx.moveTo(px,top); ctx.lineTo(px,bottom); ctx.stroke(); ctx.setLineDash([]);
    if(o.labels){ const w=ctx.measureText(m.text).width; const lx=Math.max(x.left, Math.min(px+5, x.right-w)); let row=0;
      while(placed.some(p=>p.row===row && lx < p.x+p.w+8 && p.x < lx+w+8)) row++;
      placed.push({x:lx, w, row}); ctx.fillText(m.text, lx, top+12+row*15); } }
  ctx.restore(); }};

function firmwareSettingsHtml(){
  return `<div class="tiny" style="margin-top:6px">Firmware settings for this dashboard: <code>FLEET_CODE = "${esc(CFG.fleetCode)}"</code> · <code>MQTT_HOST = "${esc(brokerTcpHost())}"</code> · <code>MQTT_PORT = 1883</code></div>`;
}
function renderNode(full){
  if(full && LINK.status==='off' && !LINK.tried){ LINK.tried=true; linkConnect(); }
  const list=nodeList();
  if(!NODE.sel || !boat(NODE.sel) || boat(NODE.sel).kind!=='node') NODE.sel = (list.find(b=>boatState(b)!=='offline')||list[0]||{}).id || null;
  $('#nodeSel').innerHTML = list.map(b=>`<option value="${esc(b.id)}" ${b.id===NODE.sel?'selected':''}>${esc(b.name)}</option>`).join('');
  $('#nodeSelWrap').hidden = list.length<2;
  $('#nodeEmpty').hidden = !!NODE.sel; $('#nodeBody').hidden = !NODE.sel;
  if(!NODE.sel){
    const st={off:'Not connected to the message broker', connecting:'Connecting to the message broker…', connected:'Connected. Waiting for a node to send', error:'Could not reach the message broker'}[LINK.status]||'';
    const usbOk = 'serial' in navigator;
    $('#nodeEmpty').innerHTML = `<h2>No sensor node is sending yet</h2>
      <div class="grid g2" style="margin-top:12px">
      <div><h3>Arduino Nano over USB</h3>
      <ol class="steps"><li>Wire the sensors straight to the Nano, no dividers: PH-4502C <b>V+</b>→5V, <b>G</b>→GND, <b>PO</b>→<b>A0</b>; TS-300B <b>VCC</b>→5V, <b>GND</b>→GND, <b>A</b>→<b>A1</b>.</li>
      <li>Upload <code>aquatrace_nano_node.ino</code> and plug the Nano into this computer. Close the Arduino Serial Monitor, as only one program can use the port.</li>
      <li>${usbOk?'Press <b>Connect USB device</b> and choose the Nano\'s port (often <i>USB-SERIAL CH340</i>).':'This browser cannot open USB ports. Use Chrome or Edge, or run <code>python tools/serial_bridge.py --code '+esc(CFG.fleetCode)+'</code> to forward the Nano to the broker.'}</li></ol>
      ${usbOk?'<button class="btn pri" type="button" id="usbBtn2">Connect USB device</button>':''}</div>
      <div><h3>ESP32 over Wi-Fi</h3>
      <ol class="steps"><li>Wire the sensors to GPIO34 and GPIO35 through 10 kΩ / 10 kΩ dividers (<code>firmware/aquatrace_bench_node</code>).</li>
      <li>In the sketch set your Wi-Fi, <code>FLEET_CODE = "${esc(CFG.fleetCode)}"</code> and <code>MQTT_HOST = "${esc(brokerTcpHost())}"</code>, then upload it.</li>
      <li>It appears on this page within a few seconds.</li></ol>
      <span class="pill ${LINK.status==='connected'?'ok':LINK.status==='error'?'bad':'warn'}"><span class="dot"></span>${st}</span></div>
      </div>
      <div class="flowrow" style="margin-top:12px"><button class="btn" type="button" id="simNodeBtn">Start a simulated ${NODE.board==='esp32'?'ESP32':'Nano'} node</button></div>
      <div class="tiny">The simulated node runs in this browser and behaves like the hardware, including calibration, so you can rehearse the demonstration before the sensors are wired.</div>
      ${USB.error?`<div class="disclaim" style="margin-top:10px">${esc(USB.error)}</div>`:''}`;
    if($('#usbBtn2')) $('#usbBtn2').onclick=usbToggle;
    usbRenderButton();
    $('#simNodeBtn').onclick=startSimNode;
    return;
  }
  usbRenderButton();
  const b=boat(NODE.sel), r=b.last||{}, m=b.meta||{}, st=boatState(b), isSim=NODE.sim&&NODE.sim.id===b.id;
  const since=Date.now()-b.lastSeenReal;
  $('#nodeKv').innerHTML = `<div><span>Status</span><b style="color:var(--${st==='offline'?'bad':'ok'})">${st==='offline'?'Not sending':'Receiving'}</b><span class="tiny" style="font-weight:500">${b.lastSeenReal?`last ${ago(since)}`:''}</span></div>
    <div><span>Readings received</span><b>${b.readings.length}</b><span class="tiny" style="font-weight:500">${m.seq?`node counter ${m.seq}`:''}</span></div>
    <div><span>Sends every</span><b>${m.every?m.every+' s':'–'}</b></div>
    ${m.hw==='nano' ? `<div><span>Connection</span><b>${isSim?'Simulated':m.via==='usb'?'USB cable':m.via==='dashboard'?'USB, shared':m.via==='bridge'?'Serial bridge':'USB'}</b><span class="tiny" style="font-weight:500">${m.vcc!=null?`supply ${(m.vcc/1000).toFixed(2)} V`:''}</span></div>`
      : `<div><span>Wi-Fi signal</span><b>${rssiLabel(m.rssi)}</b><span class="tiny" style="font-weight:500">${m.rssi!=null?m.rssi+' dBm':''}</span></div>`}
    <div><span>Running for</span><b>${fmtDur(m.uptime)}</b><span class="tiny" style="font-weight:500">${m.hw==='nano'?'Arduino Nano':m.hw==='esp32'?'ESP32':''}${m.fw?' · firmware '+esc(m.fw):''}${isSim?' · simulated':''}</span></div>`;
  // tiles
  const tc = m.turbCal==='two-point' ? '<span class="pill ok">Two-point calibrated</span>' : m.turbCal==='clear-water' ? '<span class="pill">Clear-water calibrated</span>' : m.turbCal==='default' ? '<span class="pill warn">Not calibrated</span>' : '';
  const t=[];
  t.push(`<div class="nt"><div class="lb"><span>pH</span></div><div class="v">${fmtNum(r.ph,2)}</div><div class="d">${r.ph!=null?HINT.ph(r.ph):'No pH reading'}</div><div class="raw">${m.ph_mv!=null?`Probe output ${m.ph_mv} mV`:''}</div></div>`);
  t.push(`<div class="nt"><div class="lb"><span>Turbidity</span>${tc}</div><div class="v">${fmtNum(r.turbidity,1)}<small>NTU</small></div><div class="d">${r.turbidity!=null?HINT.turbidity(r.turbidity):'No turbidity reading'}</div><div class="raw">${m.turb_mv!=null?`Sensor output ${m.turb_mv} mV`:''}</div></div>`);
  if(b.readings.some(x=>x.temp!=null)) t.push(`<div class="nt"><div class="lb"><span>Water temperature</span></div><div class="v">${fmtNum(r.temp,1)}<small>°C</small></div><div class="d">DS18B20 probe${r.temp!=null?', used for pH temperature correction':''}</div><div class="raw"></div></div>`);
  if(isSim) t.push(`<div class="nt"><div class="lb"><span>Simulated water</span></div><div class="d" style="margin:4px 0 8px">Change the water the simulated sensors are in.</div><div class="flowrow"><button class="btn sm" type="button" id="simMud">Add muddy water</button><button class="btn sm" type="button" id="simAcid">Add vinegar</button><button class="btn sm" type="button" id="simStop">Stop simulation</button></div></div>`);
  $('#nodeTiles').innerHTML=t.join('');
  if(isSim){ $('#simMud').onclick=()=>{ NODE.sim.mud+=180; nodeMark('Added muddy water'); }; $('#simAcid').onclick=()=>{ NODE.sim.acid+=1.6; nodeMark('Added vinegar'); }; $('#simStop').onclick=stopSimNode; }
  if(m.turbCal==='default' && !$('#nodeTiles .warnnote')) $('#nodeTiles').insertAdjacentHTML('beforeend', `<div class="disclaim warnnote" style="grid-column:1/-1">Turbidity has not been calibrated on this sensor yet, so the NTU value can be far off. Put the sensor in clear water and press <b>Save clear water</b>.</div>`);
  // charts
  const since0=clockNow()-NODE.winMin*60000; const pts=b.readings.filter(x=>x.ts>=since0);
  const keys=NODE_KEYS.filter(k=>pts.some(x=>x[k]!=null));
  const marks=(NODE.marks[b.id]||[]).filter(x=>x.t>=since0);
  const box=$('#nodeCharts');
  const want=keys.map(k=>`nc-${k}`).join(',');
  if(box.dataset.k!==want){ box.dataset.k=want; box.innerHTML=keys.map(k=>`<div class="lbl"><span class="key"></span>${esc(paramLabel(k))}</div><div class="chart short"><canvas id="nc-${k}"></canvas></div>`).join(''); }
  const t0=since0, t1=clockNow();
  keys.forEach((k,i)=>{ const last=i===keys.length-1;
    chart('nc-'+k,{type:'line', plugins:[markerPlugin], data:{datasets:[{label:PARAMS[k].label, data:pts.map(x=>({x:x.ts,y:x[k]})), borderColor:css('--s1'), backgroundColor:css('--s1-soft'), fill:true, pointRadius:pts.length<60?2.5:0, borderWidth:2, tension:.2, spanGaps:true}]},
      options:baseOpts({plugins:{legend:{display:false}, markers:{list:marks, color:css('--fg-2'), labels:i===0, font:css('--f-body')}, tooltip:{callbacks:{label:ctx=>`${PARAMS[k].label}: ${fmtNum(ctx.raw.y,PARAMS[k].dp)} ${PARAMS[k].unit}`}}},
        scales:{x:{type:'linear',min:t0,max:t1,ticks:{display:last,color:css('--fg-3'),maxTicksLimit:6,callback:v=>new Date(v).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:NODE.winMin<=10?'2-digit':undefined})},grid:{display:false}}, y:{...yAxisW(),ticks:{maxTicksLimit:4}}}})}); });
  // stats
  $('#nodeStats').innerHTML = keys.map(k=>{ const v=pts.map(x=>x[k]).filter(x=>x!=null&&isFinite(x)); if(!v.length) return ''; const dp=PARAMS[k].dp; const u=PARAMS[k].unit;
    return `<tr><td>${esc(PARAMS[k].label)}${u?` <span class="tiny">${u}</span>`:''}</td><td class="n">${fmtNum(v[v.length-1],dp)}</td><td class="n">${fmtNum(Math.min(...v),dp)}</td><td class="n">${fmtNum(mean(v),dp)}</td><td class="n">${fmtNum(Math.max(...v),dp)}</td><td class="n">${v.length}</td></tr>`; }).join('') || '<tr><td colspan="6">No readings in this window.</td></tr>';
  // calibration state + acks
  const c=m.cal||{};
  const slope = c.ph7_mv!=null&&c.ph4_mv!=null ? (c.ph4_mv-c.ph7_mv)/3 : null;
  const slopeOk = slope!=null && Math.abs(slope)>=120 && Math.abs(slope)<=230;
  $('#calState').innerHTML = c.ph7_mv!=null ? `pH points: 7 at ${c.ph7_mv} mV, 4 at ${c.ph4_mv} mV (${slope.toFixed(0)} mV per pH${slopeOk?'':', <span style="color:var(--bad)">outside the usual 120–230 range: check the buffers and probe</span>'}).<br>Turbidity: clear water at ${c.clear_mv} mV${c.ref_ntu?`, reference ${c.ref_ntu} NTU at ${c.ref_mv} mV`:''}.` : 'Waiting for the node to report its calibration.';
  $('#ackList').innerHTML = (b.acks||[]).slice(0,6).map(a=>`<div class="ack"><time>${new Date(a.t).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})}</time>${esc(a.text)}</div>`).join('') || '<div class="tiny">No messages yet.</div>';
  if(m.every) $('#nodeEvery').value=String(m.every);
  $('#nodeSetup').innerHTML = isSim||m.hw==='nano' ? '' : firmwareSettingsHtml();
  if(m.hw && m.hw!==NODE.shownBoard){ NODE.shownBoard=m.hw; setBoard(m.hw, true); }
  $('#calVia').textContent = m.via==='usb' ? 'Buttons send commands over the USB cable. ' : isSim ? 'Buttons send commands to the simulated node. ' : 'Buttons send commands through the message broker. ';
  $('#navNodeDot').innerHTML = nodeList().some(x=>boatState(x)!=='offline') ? '<span class="pill ok" title="A sensor node is sending"><span class="dot"></span></span>' : '';
}
function nodeMark(text){ if(!NODE.sel) return; (NODE.marks[NODE.sel]=NODE.marks[NODE.sel]||[]).push({t:clockNow(), text:text||'Marker'}); renderNode(false); }
function nodeCmd(cmd, value){
  if(!NODE.sel) return;
  if(NODE.sim && NODE.sim.id===NODE.sel){ simNodeCommand(cmd, value); return; }
  if(sendNodeCmd(NODE.sel, cmd, value)) toast(USB.deviceId===NODE.sel&&USB.status==='connected' ? 'Command sent over USB.' : 'Command sent. The node confirms with its next reading.');
}
$('#nodeSel').onchange=e=>{ NODE.sel=e.target.value; $('#nodeCharts').dataset.k=''; renderNode(true); };
$('#nodeWin').onclick=e=>{ const b=e.target.closest('button'); if(!b) return; NODE.winMin=+b.dataset.m; $$('#nodeWin button').forEach(x=>x.classList.toggle('on',x===b)); renderNode(false); };
$('#markBtn').onclick=()=>{ nodeMark($('#markText').value.trim()||'Marker'); $('#markText').value=''; };
$('#markText').addEventListener('keydown',e=>{ if(e.key==='Enter') $('#markBtn').click(); });
document.addEventListener('click', e=>{ const c=e.target.closest('[data-cal]'); if(!c) return;
  const cmd=c.dataset.cal;
  if(cmd==='cal_ref'){ const v=+$('#refNtu').value; if(!(v>0)) return toast('Enter the reference sample turbidity in NTU first.'); nodeCmd('cal_ref', v); }
  else nodeCmd(cmd); });
$('#nodeEvery').onchange=e=>nodeCmd('interval', +e.target.value);
$('#nodeCsv').onclick=()=>{ const b=boat(NODE.sel); if(!b) return; const since0=clockNow()-NODE.winMin*60000;
  const rows=b.readings.filter(x=>x.ts>=since0).map(x=>({time:new Date(x.ts).toISOString(), device:b.id, ph:x.ph, turbidity_ntu:x.turbidity, temp_c:x.temp, lat:x.lat, lon:x.lon}));
  const marks=(NODE.marks[b.id]||[]).map(mk=>`# marker ${new Date(mk.t).toISOString()} ${mk.text}`).join('\n');
  const csv=toCSV(rows,['time','device','ph','turbidity_ntu','temp_c','lat','lon'])+(marks?'\n'+marks:'');
  if(window.self!==window.top){ copyText(csv, $('#nodeCsvOut')); return; }   // embedded viewers block downloads: copy instead
  try{ const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'})); a.download=`aquatrace-${b.id}-${new Date().toISOString().slice(0,16).replace(/[:T]/g,'')}.csv`; document.body.appendChild(a); a.click(); a.remove(); }
  catch(err){ copyText(csv, $('#nodeCsvOut')); } };

/* ---------- simulated node (rehearsal without hardware) ---------- */
function simConvertPh(mv, s){ const slope=(s.ph4-s.ph7)/3; return Math.max(0,Math.min(14, 7-(mv-s.ph7)/slope)); }
function simConvertNtu(mv, s){
  if(s.refNtu>0 && s.ref>0 && s.clear-s.ref>50) return Math.max(0, s.refNtu*(s.clear-mv)/(s.clear-s.ref));
  const curve=v=>-1120.4*v*v+5742.3*v-4352.9; let v=mv/1000+(4.2-s.clear/1000); if(v>=4.2) return 0; if(v<2.5) v=2.5; return Math.max(0, curve(v)-curve(4.2));
}
// Sensor voltage for a true turbidity, inverting the same curve the firmware uses (this simulated sensor reads 4120 mV in clear water).
function simTurbMv(ntu){ const a=1120.4, b=5742.3, c=4352.9+0.9+ntu; const D=Math.max(0, b*b-4*a*c); const v=(b+Math.sqrt(D))/(2*a); return (v-(4.2-4.120))*1000; }
function startSimNode(){
  if(NODE.sim) return;
  const hw=NODE.board==='esp32'?'esp32':'nano';
  NODE.sim={id:hw==='nano'?'NANO-SIM':'ESP32-SIM', hw, ph7:2500, ph4:3030, clear:4200, clearDone:false, ref:0, refNtu:0, every:2, mud:0, acid:0, seq:0, t0:Date.now(), ack:'', phMv:NaN, turbMv:NaN, timer:null};
  NODE.sel=NODE.sim.id; simNodeStep(); NODE.sim.timer=setInterval(simNodeStep, NODE.sim.every*1000); renderNode(true);
}
function stopSimNode(){ if(!NODE.sim) return; clearInterval(NODE.sim.timer); const id=NODE.sim.id; NODE.sim=null; S.fleet.delete(id); if(S.follow===id) followBoat(PRIMARY, true); NODE.sel=null; renderNode(true); }
function simNodeStep(){
  const s=NODE.sim; if(!s) return; const g=gauss;
  s.mud*=0.93; s.acid*=0.96;                                   // the added material settles / mixes away
  const phTrue=7.15 - s.acid; const ntuTrue=2 + s.mud;
  const phMv=2500+(7-phTrue)*177+3*g(); const turbMv=simTurbMv(ntuTrue)+1.5*g();
  s.phMv=isFinite(s.phMv)?s.phMv+0.5*(phMv-s.phMv):phMv; s.turbMv=isFinite(s.turbMv)?s.turbMv+0.5*(turbMv-s.turbMv):turbMv;
  const msg={device:s.id, name:s.hw==='nano'?'Simulated bench node (Nano)':'Simulated bench node (ESP32)', kind:s.hw, fw:s.hw==='nano'?'1.0-nano-sim':'1.0-sim', seq:++s.seq, lat:PLACES.SP2.lat, lon:PLACES.SP2.lon,
    ph:+simConvertPh(s.phMv,s).toFixed(2), turbidity:+simConvertNtu(s.turbMv,s).toFixed(1), ph_mv:Math.round(s.phMv), turb_mv:Math.round(s.turbMv),
    turb_cal:s.refNtu>0?'two-point':s.clearDone?'clear-water':'default', ...(s.hw==='nano'?{vcc_mv:Math.round(4960+4*g())}:{rssi:-58}), uptime_s:Math.round((Date.now()-s.t0)/1000), every_s:s.every,
    cal:{ph7_mv:Math.round(s.ph7), ph4_mv:Math.round(s.ph4), clear_mv:Math.round(s.clear), ...(s.refNtu>0?{ref_mv:Math.round(s.ref), ref_ntu:s.refNtu}:{})}};
  if(s.ack){ msg.ack=s.ack; s.ack=''; }
  ingestRemote(msg, 'node');
  if(VIEW==='node') renderNode(false);
}
function simNodeCommand(cmd, value){
  const s=NODE.sim;
  if(cmd==='cal_ph7'){ s.ph7=s.phMv; s.ack=`pH 7 point saved at ${Math.round(s.phMv)} mV`; }
  else if(cmd==='cal_ph4'){ if(Math.abs(s.phMv-s.ph7)<60){ s.ack='pH 4 not saved: reading is too close to the pH 7 point. Check the buffer and wait for the reading to settle.'; } else { s.ph4=s.phMv; s.ack=`pH 4 point saved at ${Math.round(s.phMv)} mV; slope ${((s.ph4-s.ph7)/3).toFixed(1)} mV per pH`; } }
  else if(cmd==='cal_clear'){ s.clear=s.turbMv; s.ref=0; s.refNtu=0; s.clearDone=true; s.ack=`Clear-water point saved at ${Math.round(s.turbMv)} mV`; }
  else if(cmd==='cal_ref'){ if(s.clear-s.turbMv<50) s.ack='Reference not saved: the sample reads almost the same as clear water.'; else { s.ref=s.turbMv; s.refNtu=value; s.ack=`Reference point saved: ${value} NTU at ${Math.round(s.turbMv)} mV`; } }
  else if(cmd==='reset'){ Object.assign(s,{ph7:2500, ph4:3030, clear:4200, clearDone:false, ref:0, refNtu:0}); s.ack='Calibration reset to defaults'; }
  else if(cmd==='interval'){ s.every=value; clearInterval(s.timer); s.timer=setInterval(simNodeStep, s.every*1000); s.ack=`Sending every ${value} s`; }
  toast('Command sent to the simulated node.');
}

/* ---------- wiring panel: Nano or ESP32 ---------- */
function setBoard(bd, auto){
  NODE.board = bd==='esp32' ? 'esp32' : 'nano';
  if(!auto){ try{ localStorage.setItem('aq.board', NODE.board); }catch(e){} }
  $$('#wireBoard button').forEach(x=>x.classList.toggle('on', x.dataset.b===NODE.board));
  $('#wire-nano').hidden = NODE.board!=='nano'; $('#wire-esp32').hidden = NODE.board!=='esp32';
}
$('#wireBoard').onclick=e=>{ const b=e.target.closest('button'); if(!b) return; setBoard(b.dataset.b); if(!NODE.sel) renderNode(false); };
setBoard(NODE.board, true);

/* ---------- USB (Web Serial): Arduino Nano plugged into this computer ----------
   The Nano prints one JSON reading per line at 115200 baud; lines starting with '#' are messages.
   Commands go back as one JSON line, e.g. {"cmd":"cal_ref","value":100}. */
const USB = {port:null, reader:null, status:'off', deviceId:null, error:'', pending:[]};
window.USB = USB;
function usbRenderButton(){
  const btn=$('#usbBtn'); if(!btn) return;
  btn.hidden = !('serial' in navigator) || (!NODE.sel && USB.status!=='connected');
  btn.textContent = USB.status==='connected' ? 'Disconnect USB' : USB.status==='connecting' ? 'Connecting…' : 'Connect USB device';
  btn.classList.toggle('pri', USB.status!=='connected');
}
async function usbToggle(){ if(USB.status==='connected'||USB.status==='connecting') return usbClose(); return usbOpen(); }
async function usbOpen(){
  USB.error='';
  if(!('serial' in navigator)){ USB.error='This browser cannot open USB serial ports. Use Chrome or Edge on a computer, or tools/serial_bridge.py.'; renderNode(false); return; }
  let port;
  try{ port = await navigator.serial.requestPort(); }
  catch(e){ if(e.name!=='NotFoundError'){ USB.error = e.name==='SecurityError' ? 'USB access is blocked in this embedded view. Open the dashboard in its own browser tab.' : String(e.message||e); renderNode(false); } return; }
  USB.status='connecting'; usbRenderButton();
  try{ await port.open({baudRate:115200}); }
  catch(e){ USB.status='off'; USB.error = 'Could not open the port: '+(e.message||e)+'. Close the Arduino Serial Monitor or any other program using it, then try again.'; usbRenderButton(); renderNode(false); return; }
  USB.port=port; USB.status='connected'; usbRenderButton();
  toast('USB port open. The Nano restarts and sends its first reading in about 3 seconds.');
  usbReadLoop(port);
}
async function usbReadLoop(port){
  const dec=new TextDecoder(); let buf='';
  while(port.readable && USB.port===port){
    const reader=port.readable.getReader(); USB.reader=reader;
    try{
      for(;;){ const {value, done}=await reader.read(); if(done) break;
        buf += dec.decode(value, {stream:true}); let i;
        while((i=buf.indexOf('\n'))>=0){ const line=buf.slice(0,i).replace(/\r$/,'').trim(); buf=buf.slice(i+1); if(line) usbLine(line); }
        if(buf.length>4096) buf=''; }
    }catch(e){ USB.error = 'The USB connection was interrupted ('+(e.message||e)+').'; }
    finally{ try{ reader.releaseLock(); }catch(e){} }
    if(USB.port!==port || USB.status!=='connected') break;
    if(!port.readable) break;
  }
  if(USB.port===port){ USB.status='off'; USB.port=null; usbRenderButton(); if(VIEW==='node') renderNode(false); }
}
function usbLine(line){
  if(line[0]==='#'){                                   // human message: confirmation or status
    const text=line.replace(/^#\s*/,'');
    const b=USB.deviceId && boat(USB.deviceId);
    if(b){ (b.acks=b.acks||[]).unshift({t:Date.now(), text}); b.acks.length=Math.min(b.acks.length,20); if(VIEW==='node'){ if(!/^AquaTrace bench node/.test(text)) toast(`${b.name}: ${text}`); renderNode(false); } }
    else USB.pending.push(text);
    return;
  }
  if(line[0]!=='{') return;
  let m; try{ m=JSON.parse(line); }catch(e){ return; }     // partial line right after the port opens
  if(!m.device) return;
  m._via='usb';
  const first = USB.deviceId!==m.device; USB.deviceId=m.device;
  ingestRemote(m, 'node');
  const b=boat(m.device);
  if(first && b){ USB.pending.forEach(text=>(b.acks=b.acks||[]).unshift({t:Date.now(), text})); USB.pending=[]; NODE.sel=m.device; }
  if(LINK.client && LINK.status==='connected'){            // share with other dashboards watching this fleet code
    const out={...m, via:'dashboard'}; delete out._via; if(!out.ts) out.ts=new Date().toISOString();
    try{ LINK.client.publish(`${linkTopicBase()}/${m.device}/readings`, JSON.stringify(out)); }catch(e){}
  }
  if(VIEW==='node') renderNode(first); else if(VIEW==='fleet') renderFleet(false);
}
async function usbSend(obj){
  if(!USB.port || !USB.port.writable){ toast('The USB device is not connected.'); return false; }
  const w=USB.port.writable.getWriter();
  try{ await w.write(new TextEncoder().encode(JSON.stringify(obj)+'\n')); }
  catch(e){ toast('Could not send over USB: '+(e.message||e)); return false; }
  finally{ w.releaseLock(); }
  return true;
}
async function usbClose(){
  const port=USB.port; USB.status='off'; USB.port=null; usbRenderButton();
  try{ if(USB.reader) await USB.reader.cancel(); }catch(e){}
  try{ if(port) await port.close(); }catch(e){}
  toast('USB device disconnected.'); if(VIEW==='node') renderNode(false);
}
// incoming commands for a USB node from other dashboards (via the broker) are passed on to the cable
function usbRelayCmd(topic, payload){ if(USB.status==='connected' && USB.deviceId && topic.endsWith(`/${USB.deviceId}/cmd`)){ try{ usbSend(JSON.parse(payload)); }catch(e){} } }
if('serial' in navigator){ navigator.serial.addEventListener('disconnect', e=>{ if(e.target===USB.port){ USB.port=null; USB.status='off'; USB.error='The USB device was unplugged.'; usbRenderButton(); if(VIEW==='node') renderNode(false); } }); }
$('#usbBtn').onclick=usbToggle;
usbRenderButton();
