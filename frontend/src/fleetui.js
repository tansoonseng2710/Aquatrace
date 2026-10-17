/* ============================================================
   AquaTrace — Fishing fleet page
   ============================================================ */
const STATE_LABEL = {ok:'Normal', warn:'Unusual readings', bad:'Possible contamination', offline:'Not reporting'};
let fleetFitted = false, fleetBoatCount = 0;
function ago(ms){ const s=Math.max(0,Math.round(ms/1000)); return s<60?`${s} s ago`:s<3600?`${Math.round(s/60)} min ago`:`${Math.round(s/3600)} h ago`; }
function phonePageUrl(){
  if(CFG.phoneUrl) return CFG.phoneUrl;
  try{ return new URL(/^https?:$/.test(location.protocol)?'boat':'boat.html', location.href).href; }catch(e){ return 'boat.html'; }   // Vercel and the API serve /boat
}
function joinUrl(){
  const u = new URL(phonePageUrl(), location.href);
  u.searchParams.set('code', CFG.fleetCode);
  if(CFG.broker==='custom') u.searchParams.set('broker', CFG.brokerUrl); else u.searchParams.set('broker', CFG.broker);
  return u.href;
}
function renderQR(){
  const url = joinUrl(); const box=$('#qr'); if(!box) return;
  if(window.qrcode){ try{ const q=qrcode(0,'M'); q.addData(url); q.make(); box.innerHTML=q.createSvgTag({cellSize:4, margin:2, scalable:true}); box.title=url; }catch(e){ box.textContent='QR code unavailable'; } }
  else box.textContent='QR library did not load';
  const reachable = /^https:\/\//.test(url) && !/claude|usercontent|localhost|127\.0\.0\.1/.test(new URL(url).host);
  $('#phoneUrlNote').innerHTML = `Phone page: <a href="${esc(url)}" target="_blank" rel="noopener">${esc(url.length>70?url.slice(0,70)+'…':url)}</a>` +
    (reachable?'':` <br><span style="color:var(--warn)">A phone may not be able to open this address. Phones need the page over HTTPS from a public site, such as your Vercel deployment. Set the address under Connection settings.</span>`);
  $('#fleetCode').textContent = CFG.fleetCode;
}
function renderLinkStatus(){
  const el=$('#linkStatus'); if(!el) return;
  const m={off:['','Not connected'], connecting:['warn','Connecting…'], connected:['ok','Connected, listening for phones'], error:['bad','Connection failed']}[LINK.status]||['',''];
  el.innerHTML = `<span class="pill ${m[0]}"><span class="dot"></span>${m[1]}</span>${LINK.error?` <span class="tiny">${esc(LINK.error)}</span>`:''}`;
}
function renderFleet(full){
  if(full){
    renderQR(); renderLinkStatus();
    $('#brokerSel').value = CFG.broker; $('#brokerUrl').value = CFG.brokerUrl||''; $('#phoneUrl').value = CFG.phoneUrl||''; $('#autoFollow').checked = S.autoFollow!==false;
    $('#brokerUrlWrap').hidden = CFG.broker!=='custom';
    if(LINK.status==='off' && !LINK.tried){ LINK.tried=true; linkConnect(); }
  }
  $('#followName').textContent = followName();
  const boats=[...S.fleet.values()];
  const states=boats.map(boatState);
  const nowC=clockNow(); const recentBad=S.fleetAlerts.filter(a=>nowC-a.ts<3600e3).length; const cov=fleetCoverageKm2(24);
  $('#fleetKv').innerHTML = `<div><span>Boats reporting</span><b>${states.filter(s=>s!=='offline').length} of ${boats.length}</b></div>
    <div><span>Phones connected</span><b>${boats.filter(b=>b.kind==='phone'&&boatState(b)!=='offline').length}</b></div>
    <div><span>Alerts in the last hour</span><b>${recentBad}</b></div>
    <div><span>Water sampled, 24 h</span><b>${cov.km2.toFixed(1)} km²</b></div>`;
  // boat cards (followed first, then phones, then the rest)
  const order={survey:1, phone:0, replay:2, server:3, sim:4};
  const list=boats.slice().sort((a,b)=>(b.id===S.follow)-(a.id===S.follow) || order[a.kind]-order[b.kind] || a.name.localeCompare(b.name));
  $('#boatCount').textContent=`${boats.length} boats`;
  $('#boatList').innerHTML = list.map(b=>{ const st=boatState(b), r=b.last;
    const seen = b.kind==='phone'||b.kind==='server' ? (b.lastSeenReal?ago(Date.now()-b.lastSeenReal):'never') : b.kind==='replay' ? `${Math.round((b.meta.progress||1)*100)}% played` : 'reporting';
    const meta = b.kind==='node' ? [b.meta.hw==='nano'?`Arduino Nano over ${b.meta.via==='bridge'?'serial bridge':'USB'}`:null, b.meta.rssi!=null?`Wi-Fi ${rssiLabel(b.meta.rssi).toLowerCase()} (${b.meta.rssi} dBm)`:null, b.meta.every?`every ${b.meta.every} s`:null, b.meta.turbCal==='default'?'turbidity not calibrated':null].filter(Boolean).join(' · ') : b.kind==='phone' ? [b.meta.battery!=null?`Battery ${Math.round(b.meta.battery*100)}%`:null, b.meta.acc!=null?`GPS ±${Math.round(b.meta.acc)} m`:null, b.meta.mode?({gps:'Phone GPS', relative:'Movement placed on Penang', route:'Simulated route'}[b.meta.mode]||b.meta.mode):null, b.meta.discharge?'Discharge on':null].filter(Boolean).join(' · ') : '';
    return `<div class="boat ${b.id===S.follow?'on':''}" data-boat="${esc(b.id)}">
      <div class="bh"><b title="${esc(b.name)}">${esc(b.name)}</b><span class="pill ${st}">${st==='ok'?'<span class="dot"></span>':''}${STATE_LABEL[st]}</span></div>
      <div class="tiny">${KIND_LABEL[b.kind]||b.kind} · ${seen}${r?` · ${r.lat.toFixed(4)}° N, ${r.lon.toFixed(4)}° E`:''}</div>
      ${r?`<div class="vals">${(b.kind==='node'?['ph','turbidity','temp']:['uv','do','ph']).filter(k=>r[k]!=null).map(k=>`<span>${PARAMS[k].short||PARAMS[k].label} <b>${fmtNum(r[k],k==='turbidity'?1:PARAMS[k].dp)}</b></span>`).join('')}${r.est?.[CFG.target]?`<span>Est. <b>${fmtConc(r.est[CFG.target].mu,CFG.target)}</b></span>`:''}</div>`:''}
      ${meta?`<div class="tiny">${esc(meta)}</div>`:''}
      ${b.kind==='replay'?`<div class="prog"><i style="width:${Math.round((b.meta.progress||0)*100)}%"></i></div>`:''}
      <div class="acts">${b.id===S.follow?'<span class="pill acc">Following</span>':`<button class="btn sm" type="button" data-follow="${esc(b.id)}">Follow</button>`}${b.kind==='node'?`<a class="btn sm" href="#node" data-nodeopen="${esc(b.id)}">Open sensor page</a>`:b.kind!=='replay'&&b.kind!=='server'?`<button class="btn sm" type="button" data-discharge="${esc(b.id)}">Simulate discharge</button>`:''}</div>
    </div>`; }).join('');
  const nPhones=boats.filter(b=>b.kind==='phone'&&boatState(b)!=='offline').length;
  $('#navFleetCount').innerHTML = nPhones?`<span class="pill acc" title="Phones connected">${nPhones}</span>`:'';
  // alerts
  $('#fleetAlerts').innerHTML = S.fleetAlerts.length ? S.fleetAlerts.slice(0,8).map(a=>`<div class="alert" data-fa="${esc(a.boat)}" tabindex="0" role="button"><div class="h"><span>${esc(a.name)}</span><time>${fmtT(a.ts)}</time></div><div class="small muted">Possible contamination at ${a.lat.toFixed(4)}° N, ${a.lon.toFixed(4)}° E${a.est!=null?` · est. ${fmtConc(a.est,CFG.target)}`:''}</div><div class="tiny">${a.kind==='phone'?'Reported by a phone':KIND_LABEL[a.kind]||''} · laboratory confirmation recommended</div></div>`).join('') : '<div class="empty">No contamination alerts from the fleet yet. Try <b>Simulate discharge</b> on a boat.</div>';
  // map
  if(!MAPS.fleet){ MAPS.fleet=new MapView($('#fleetMap')); }
  const lay=[];
  for(const b of boats){ const tr=b.readings.slice(-40); if(tr.length>1) lay.push({t:'line', pts:tr, color:css(b.id===S.follow?'--s1':'--fg-3'), w:b.id===S.follow?2.5:1.3, op:b.id===S.follow?.9:.55}); }
  S.sources.forEach(s=>lay.push({t:'dot',p:s,r:4.5,shape:'square',fill:css('--fg'),stroke:css('--panel'),tip:`<b>${esc(s.name)}</b><br>${esc(s.type)}`}));
  S.fleetAlerts.filter(a=>nowC-a.ts<6*3600e3).forEach(a=>lay.push({t:'dot',p:a,r:6,shape:'tri',fill:css('--bad'),stroke:css('--panel'),sw:1.5,tip:`<b>${esc(a.name)}</b><br>Possible contamination, ${fmtT(a.ts)}`}));
  for(const b of boats){ if(!b.last) continue; const st=boatState(b);
    lay.push({t:'dot',p:b.last,r:b.id===S.follow?7:5.5,shape:'boat',heading:b.last.heading||0,fill:st==='offline'?css('--fg-3'):statusCol(st==='ok'?'ok':st),stroke:css(b.id===S.follow?'--accent':'--panel'),sw:b.id===S.follow?3:1.5,
      tip:`<b>${esc(b.name)}</b><br>${KIND_LABEL[b.kind]||''} · ${STATE_LABEL[st]}<br>${b.last.lat.toFixed(4)}° N, ${b.last.lon.toFixed(4)}° E`, click:()=>followBoat(b.id)});
    lay.push({t:'label',p:b.last,text:b.name});
  }
  MAPS.fleet.setLayers(lay);
  if(!fleetFitted || boats.length!==fleetBoatCount){ fleetFitted=true; fleetBoatCount=boats.length; MAPS.fleet.fitPoints(boats.filter(b=>b.last).map(b=>b.last)); }
}
document.addEventListener('click', e=>{
  const f=e.target.closest('[data-follow]'); if(f){ followBoat(f.dataset.follow); return; }
  const d=e.target.closest('[data-discharge]'); if(d){ triggerDischarge(d.dataset.discharge); return; }
  const no=e.target.closest('[data-nodeopen]'); if(no){ NODE.sel=no.dataset.nodeopen; }
  const a=e.target.closest('[data-fa]'); if(a){ followBoat(a.dataset.fa, true); location.hash='events'; }
});
$('#newCode').onclick=()=>{ CFG.fleetCode=newFleetCode(); savePrefs(); renderQR(); linkConnect(); toast(`New fleet code ${CFG.fleetCode}. Phones must scan the new QR code.`); };
$('#brokerSel').onchange=e=>{ CFG.broker=e.target.value; $('#brokerUrlWrap').hidden=CFG.broker!=='custom'; savePrefs(); renderQR(); };
$('#brokerUrl').onchange=e=>{ CFG.brokerUrl=e.target.value.trim(); savePrefs(); renderQR(); };
$('#phoneUrl').onchange=e=>{ CFG.phoneUrl=e.target.value.trim(); savePrefs(); renderQR(); };
$('#autoFollow').onchange=e=>{ S.autoFollow=e.target.checked; CFG.autoFollow=e.target.checked; savePrefs(); };
$('#linkConnect').onclick=()=>linkConnect();
$('#linkDisconnect').onclick=()=>{ linkDisconnect(); renderLinkStatus(); };
$('#playSample').onclick=()=>{ const id=loadTrip(sampleTrip(), 'Sample trip, Sungai Pinang'); if(!S.realtime && CFG.mode==='demo'){ S.realtime=true; S.lastTickReal=Date.now(); } $('#tripMsg').textContent='Playing the sample trip: one reading per update. A discharge plume is passed near Kampung Rawa about a third of the way down the river.'; if(S.autoFollow!==false) followBoat(id, true); renderFleet(false); };
$('#tripFile').onchange=e=>{ const f=e.target.files[0]; if(!f) return; const rd=new FileReader(); rd.onload=()=>{ try{
    const txt=String(rd.result); let rows;
    if(/^\s*[\[{]/.test(txt)){ const j=JSON.parse(txt); rows=Array.isArray(j)?j:(j.readings||[]); }
    else rows=Papa.parse(txt.trim(),{header:true,dynamicTyping:true,skipEmptyLines:true,transformHeader:h=>h.trim().toLowerCase()}).data;
    const id=loadTrip(rows, f.name.replace(/\.(json|csv)$/i,'')); if(!S.realtime && CFG.mode==='demo'){ S.realtime=true; S.lastTickReal=Date.now(); }
    $('#tripMsg').textContent=`Playing ${rows.length} readings from ${f.name}.`; if(S.autoFollow!==false) followBoat(id, true); renderFleet(false);
  }catch(err){ $('#tripMsg').textContent='Could not read this file: '+err.message; } }; rd.readAsText(f); e.target.value=''; };
