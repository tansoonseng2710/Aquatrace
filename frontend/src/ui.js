/* ============================================================
   AquaTrace — views
   ============================================================ */
function followName(){ return boat(S.follow)?.name || S.follow; }
const statusName = {ok:'Normal', warn:'Unusual readings', bad:'Possible contamination'};
const statusCol = st => css(st==='bad'?'--bad':st==='warn'?'--warn-mark':'--ok');
const CH = {};
function chart(id, cfg){ if(CH[id]) CH[id].destroy(); const el=document.getElementById(id); if(!el) return; CH[id]=new Chart(el, cfg); return CH[id]; }
function baseOpts(extra={}){
  const fg=css('--fg-2'), grid=css('--line-2');
  const o={responsive:true, maintainAspectRatio:false, animation:false, layout:{padding:{right:18}}, interaction:{mode:'nearest', intersect:false, axis:'x'},
    plugins:{legend:{labels:{color:fg, boxWidth:10, boxHeight:10, usePointStyle:true, font:{family:css('--f-body'), size:12.5}}},
      tooltip:{backgroundColor:css('--panel'), titleColor:css('--fg'), bodyColor:css('--fg-2'), borderColor:css('--line'), borderWidth:1, padding:10, cornerRadius:8, boxPadding:4,
        titleFont:{family:css('--f-body'),weight:'600'}, bodyFont:{family:css('--f-body')}, callbacks:{title:items=>items.length&&items[0].parsed.x>1e12?new Date(items[0].parsed.x).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}):undefined}}},
    scales:{x:{ticks:{color:css('--fg-3'),maxTicksLimit:7,font:{family:css('--f-body')}}, grid:{color:grid}, border:{display:false}}, y:{ticks:{color:css('--fg-3'),font:{family:css('--f-body')}}, grid:{color:grid}, border:{display:false}}}};
  return deepMerge(o, extra);
}
function deepMerge(a,b){ for(const k in b){ const v=b[k]; if(v && typeof v==='object' && !Array.isArray(v) && typeof v!=='function' && a[k] && typeof a[k]==='object' && !Array.isArray(a[k])) a[k]=deepMerge({...a[k]},v); else a[k]=v; } return a; }
const timeTicks = {callback:function(v){ const sc=this; const span=(sc.max-sc.min)/3600e3; const d=new Date(v); return span>36? d.toLocaleString([], {month:'short',day:'numeric',hour:'2-digit'}) : fmtTime(v); }};
const compLabel = c => S.compounds[c]?.name || c;
function compOptions(sel, selected, withAll){ sel.innerHTML=(withAll?'<option value="">All compounds</option>':'')+Object.values(S.compounds).map(c=>`<option value="${c.id}" ${c.id===selected?'selected':''}>${esc(c.name)}</option>`).join(''); }
function paramLabel(k){ return PARAMS[k]? `${PARAMS[k].label}${PARAMS[k].unit?' ('+PARAMS[k].unit+')':''}` : (EXTRA_FEATS[k]||k); }
function latest(){ return S.readings[S.readings.length-1]; }
function within(hours){ const t=S.simNow-hours*3600e3; return S.readings.slice(lowerBound(t)); }

/* ---------- router ---------- */
const VIEWS = ['dashboard','fleet','node','trends','map','events','hplc','ml','database','reactor','insights','architecture','settings'];
let VIEW='dashboard';
function go(v){ if(!VIEWS.includes(v)) v='dashboard'; VIEW=v; $$('.view').forEach(s=>s.classList.toggle('on', s.id==='v-'+v)); $$('#nav a').forEach(a=>a.classList.toggle('on', a.dataset.v===v)); renderView(true); window.scrollTo(0,0); }
function renderView(full){ const f=RENDER[VIEW]; if(f) f(full); }
window.addEventListener('hashchange', ()=>go(location.hash.slice(1)));

/* ---------- overview ---------- */
let dashParam='uv'; const SPARK=60;
// Everyday reading of each sensor value (Malaysian NWQS ranges where one applies).
const HINT={
  ph:v=>v<6.5?'Acidic':v>8.5?'Alkaline':'Usual range (6.5–8.5)',
  orp:v=>v<100?'Reducing, little oxygen':v<300?'Moderately oxidising':'Oxidising',
  turbidity:v=>v<5?'Clear':v<50?'Cloudy':'Very cloudy',
  uv:v=>v<0.15?'Low organic load':v<0.3?'Moderate organic load':'High organic load',
  temp:v=>'Water temperature',
  conductivity:v=>v<2500?'Fresh water':v<25000?'Brackish (estuary)':'Seawater',
  do:v=>v<3?'Very low for fish':v<5?'Low for fish':'Healthy for fish',
};
let lastPlaceAt=null;
function yAxisW(){ return {afterFit:a=>{ a.width=56; }}; }
function renderDashboard(full){
  const r=latest(); if(!r) return;
  if(full){
    compOptions($('#dashTarget'), CFG.target);
    $('#dashParamSeg').innerHTML=Object.keys(PARAMS).map(k=>`<button type="button" data-k="${k}" class="${k===dashParam?'on':''}">${PARAMS[k].short||PARAMS[k].label}</button>`).join('');
    $('#sensorCards').innerHTML=Object.keys(PARAMS).map(k=>`<div class="sc" id="sc-${k}"><div class="lb"><span>${PARAMS[k].label}</span><span class="flag"></span></div><div class="v"></div><div class="d"></div><canvas height="28" aria-hidden="true"></canvas></div>`).join('');
  }
  $('#zTxt').textContent=CFG.zTh;
  const hist=S.readings.slice(-SPARK);
  for(const k of Object.keys(PARAMS)){
    const el=$('#sc-'+k); if(!el) continue; const z=r.z?.[k]||0; const lvl=Math.abs(z)>=CFG.zTh*1.6?'bad':Math.abs(z)>=CFG.zTh?'warn':'';
    el.className='sc'+(lvl?' z-'+lvl:'');
    $('.flag',el).textContent=lvl?(z>0?'High ↑':'Low ↓'):''; $('.flag',el).title=lvl?(z>0?'Unusually high':'Unusually low'):'';
    const has = r[k]!=null && isFinite(r[k]);
    el.classList.toggle('na', !has);
    $('.v',el).innerHTML= has ? `${fmtNum(r[k],PARAMS[k].dp)}<small>${PARAMS[k].unit}</small>` : '–';
    $('.d',el).textContent= has ? HINT[k](r[k]) : 'Not measured by this device';
    spark($('canvas',el), hist.map(h=>h[k]).filter(v=>v!=null && isFinite(v)), lvl==='bad'?css('--bad'):lvl==='warn'?css('--warn-mark'):css('--s1'));
  }
  $('#lastTs').textContent=`Updated ${fmtTime(r.ts)} · ${followName()}`;
  $('#dashSub').innerHTML=`Live readings from <b>${esc(followName())}</b>${S.follow===PRIMARY?' as it moves along Sungai Pinang and the coast':''}. <a href="#fleet">Change boat</a>`;
  // plain-language status
  const e=r.est?.[CFG.target], c=S.compounds[CFG.target], st=r.status||'ok', m=S.models[CFG.target];
  const lab=S.hplc.filter(h=>h.compound===CFG.target).sort((a,b)=>b.ts-a.ts)[0];
  const name=c?.name||CFG.target, lname=name.toLowerCase();
  const k0=r.maxZk, z0=r.z?.[k0]||0;
  const say = st==='bad' ? {t:`Possible ${lname} contamination at the boat's position.`, n:`The estimated level is above the screening level. Take a water sample here and confirm it with an HPLC test before drawing conclusions.`}
    : st==='warn' ? {t:`Some readings are unusual right now.`, n:`${PARAMS[k0]?.label||'A sensor'} is ${z0>0?'higher':'lower'} than its recent normal. Watch the next few readings, and take a sample if it continues.`}
    : {t:`The water looks normal here.`, n:`Readings are within their recent range and the estimated ${lname} level is below the screening level. No action needed.`};
  $('#hero').className='panel hero st-'+st;
  $('#statusBox').innerHTML=`<span class="pill ${st}"><span class="dot"></span>${statusName[st]}</span><div class="t" style="margin-top:10px">${esc(say.t)}</div><div class="next">${esc(say.n)}</div>`;
  const confTxt={High:'High',Medium:'Medium',Low:'Low'};
  $('#estBox').innerHTML = e ? `
    <div><span>Estimated ${esc(lname)}</span><b>${fmtConc(e.mu,CFG.target)}</b><i>likely ${fmtConc(e.lo,CFG.target)} to ${fmtConc(e.hi,CFG.target)}</i></div>
    <div><span>Model confidence</span><b>${confTxt[e.conf]}</b><i>${esc(e.conf==='High'?'Model is reliable for these conditions':e.reasons[0]?e.reasons[0].replace(/^./,x=>x.toUpperCase()):'')}</i></div>
    <div><span>Latest lab result</span><b>${lab?fmtConc(lab.conc,CFG.target)+(lab.below?' (below detection)':''):'None yet'}</b><i>${lab?`${esc(lab.sample_id)}, ${fmtT(lab.ts)}`:'Add one on the Lab results page'}</i></div>
    <div><span>Screening level</span><b>${c.level!=null?fmtConc(c.level,CFG.target):'Not set'}</b><i>Alert threshold for the estimate</i></div>`
    : (m && m.feats.some(f=>PARAMS[f] && (r[f]==null || !isFinite(r[f]))))
      ? `<div style="grid-column:1/-1"><span>Estimated ${esc(lname)}</span><b>Not estimated</b><i>This device measures ${Object.keys(PARAMS).filter(k=>r[k]!=null&&isFinite(r[k])).map(k=>PARAMS[k].label).join(' and ')} only. The model needs all of ${m.feats.filter(f=>PARAMS[f]).map(f=>PARAMS[f].short||PARAMS[f].label).join(', ')}, so readings are shown as measured. See the Sensor node page.</i></div>`
      : `<div><span>Estimated ${esc(lname)}</span><b>No model yet</b><i>Add lab results and train it on the Estimation model page</i></div>`;
  // live charts: sensor on top, concentration below, one time axis
  const pts=S.readings.slice(-180); const t0=pts[0]?.ts, t1=pts[pts.length-1]?.ts;
  const labPts=S.hplc.filter(h=>h.compound===CFG.target && h.ts>=t0 && h.ts<=t1);
  $('#dashLbl1').innerHTML=`<span class="key"></span>${esc(paramLabel(dashParam))}`;
  $('#dashLbl2').innerHTML=`<span class="key dash"></span>Estimated ${esc(lname)} (${esc(c?.unit||'')})${labPts.length?' <span class="key lab" style="margin-left:10px"></span>Lab result':''}${c?.level!=null?' <span class="key" style="margin-left:10px;background:var(--bad);height:2px"></span>Screening level':''}`;
  const xs={type:'linear',min:t0,max:t1,ticks:{...timeTicks,color:css('--fg-3'),maxTicksLimit:6},grid:{display:false},border:{display:false}};
  chart('dashChart',{type:'line', data:{datasets:[
    {label:paramLabel(dashParam), data:pts.map(p=>({x:p.ts,y:p[dashParam]})), borderColor:css('--s1'), backgroundColor:css('--s1-soft'), fill:true, pointRadius:0, borderWidth:2, tension:.25},
    {label:'Unusual reading', type:'scatter', data:pts.filter(p=>p.status!=='ok').map(p=>({x:p.ts,y:p[dashParam],st:p.status})), pointBackgroundColor:pts.filter(p=>p.status!=='ok').map(p=>p.status==='bad'?css('--bad'):css('--warn-mark')), pointBorderColor:css('--panel'), pointBorderWidth:1.5, pointRadius:4}]},
    options:baseOpts({plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>ctx.dataset.type==='scatter'?`${statusName[ctx.raw.st]}: ${fmtNum(ctx.raw.y,PARAMS[dashParam].dp)}`:`${PARAMS[dashParam].label}: ${fmtNum(ctx.raw.y,PARAMS[dashParam].dp)} ${PARAMS[dashParam].unit}`}}},scales:{x:{...xs,ticks:{display:false}},y:{...yAxisW(),ticks:{color:css('--fg-3'),maxTicksLimit:4},grid:{color:css('--line-2')},border:{display:false}}}})});
  const ds2=[{label:`Estimated ${lname}`, data:pts.map(p=>({x:p.ts,y:p.est?.[CFG.target]?.mu??null})), borderColor:css('--fg-2'), borderDash:[5,4], pointRadius:0, borderWidth:1.6, tension:.2}];
  if(c?.level!=null) ds2.push({label:'Screening level', data:[{x:t0,y:c.level},{x:t1,y:c.level}], borderColor:css('--bad'), borderWidth:1, pointRadius:0, borderDash:[2,3]});
  if(labPts.length) ds2.push({label:'Lab result', type:'scatter', data:labPts.map(h=>({x:h.ts,y:h.conc})), pointBackgroundColor:css('--lab'), pointBorderColor:css('--panel'), pointBorderWidth:1.5, pointRadius:6, pointStyle:'rectRot'});
  chart('dashChart2',{type:'line', data:{datasets:ds2}, options:baseOpts({plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>`${ctx.dataset.label}: ${fmtConc(ctx.raw.y,CFG.target)}`}}},scales:{x:xs,y:{...yAxisW(),min:0,ticks:{color:css('--fg-3'),maxTicksLimit:3},grid:{color:css('--line-2')},border:{display:false}}}})});
  // alerts
  const al=S.events.slice(0,5);
  $('#dashAlerts').innerHTML = al.length? al.map(alertCard).join('') : '<div class="empty">No unusual readings so far.</div>';
  const nBad=S.events.filter(e=>e.status==='bad' && e.end>S.simNow-24*3600e3).length;
  $('#navAlertCount').innerHTML = nBad? `<span class="pill bad" title="Possible contamination events in the last 24 hours">${nBad}</span>`:'';
  $('#dashPos').textContent=`${r.lat.toFixed(4)}° N, ${r.lon.toFixed(4)}° E`;
  if(!lastPlaceAt || distM(lastPlaceAt,r)>150){ lastPlaceAt={lat:r.lat,lon:r.lon}; OSM.reverse(r.lat,r.lon).then(pl=>{ if(pl) $('#dashPlace').textContent=pl.short; }).catch(()=>{ $('#dashPlace').textContent='Boat position'; }); }
  if(!MAPS.mini){ MAPS.mini=new MapView($('#dashMini'),{legend:false,note:false,labels:false,focus:0.018}); }
  const tail=within(2);
  MAPS.mini.focusOn(r.lat, r.lon, 0.018);
  MAPS.mini.setLayers([
    {t:'line', pts:tail, color:css('--s1'), w:2.5, op:.7},
    ...S.sources.map(s=>({t:'dot',p:s,r:4,fill:css('--fg'),shape:'square',tip:esc(s.name)})),
    ...tail.filter(p=>p.status!=='ok').map(p=>({t:'dot',p,r:3.5,fill:statusCol(p.status)})),
    {t:'dot',p:r,r:6,fill:css('--accent'),stroke:css('--panel'),sw:2,shape:'boat',heading:r.heading||0,tip:'Boat position'}]);
}
function alertCard(e){ const c=S.compounds[CFG.target]; const d=e.drivers[0];
  return `<div class="alert ${e.status}" data-ev="${e.id}" tabindex="0" role="button"><div class="h"><span>${e.status==='bad'?'Possible contamination':'Unusual readings'}</span><time>${fmtT(e.start)}</time></div>
  <div class="small muted">${esc(PARAMS[d.k].label)} ${d.z>0?'rose':'fell'} · ${Math.round(e.near.d)} m from ${esc(e.near.s.name)}</div>
  ${e.est?`<div class="tiny">Estimated ${esc(c.name.toLowerCase())} ${fmtConc(e.est.mu,CFG.target)}${e.status==='bad'?' · lab check recommended':''}</div>`:''}</div>`; }
document.addEventListener('click', e=>{ const a=e.target.closest('[data-ev]'); if(a){ SEL_EV=a.dataset.ev; location.hash='events'; if(VIEW==='events') renderView(true); } });
function spark(cv, vals, col){ if(!vals.length){ const g=cv.getContext('2d'); g.clearRect(0,0,cv.width,cv.height); return; } const w=cv.clientWidth||150, h=30; cv.width=w*devicePixelRatio; cv.height=h*devicePixelRatio; const g=cv.getContext('2d'); g.scale(devicePixelRatio,devicePixelRatio); g.clearRect(0,0,w,h);
  const mn=Math.min(...vals), mx=Math.max(...vals), sp=(mx-mn)||1; g.beginPath(); vals.forEach((v,i)=>{ const x=i/(vals.length-1)*(w-4)+2, y=h-3-(v-mn)/sp*(h-6); i?g.lineTo(x,y):g.moveTo(x,y); });
  g.strokeStyle=col; g.lineWidth=1.4; g.stroke(); g.lineTo(w-2,h); g.lineTo(2,h); g.closePath(); g.globalAlpha=.12; g.fillStyle=col; g.fill(); g.globalAlpha=1;
  const lx=w-2, ly=h-3-(vals[vals.length-1]-mn)/sp*(h-6); g.beginPath(); g.arc(lx,ly,2.4,0,7); g.fillStyle=col; g.fill(); }
$('#dashParamSeg').addEventListener('click',e=>{ const b=e.target.closest('button'); if(!b) return; dashParam=b.dataset.k; $$('#dashParamSeg button').forEach(x=>x.classList.toggle('on',x===b)); renderDashboard(false); });
$('#dashTarget').addEventListener('change',e=>{ CFG.target=e.target.value; savePrefs(); S.readings.forEach(estimateReading); buildEvents(); renderDashboard(false); });

/* ---------- 02 trends ---------- */
let trHours=24;
function renderTrends(full){
  if(full){ $('#trParam').innerHTML=Object.keys(PARAMS).map(k=>`<option value="${k}" ${k==='uv'?'selected':''}>${paramLabel(k)}</option>`).join(''); compOptions($('#trComp'), CFG.target); }
  const comp=$('#trComp').value, k=$('#trParam').value; const pts=within(trHours); const t0=S.simNow-trHours*3600e3;
  const lab=S.hplc.filter(h=>h.compound===comp && h.ts>=t0); const showEst=$('#trEst').checked; const c=S.compounds[comp];
  const xs={type:'linear',min:t0,max:S.simNow,ticks:{...timeTicks,color:css('--fg-3')},grid:{display:false}};
  $('#trLbl1').innerHTML=`<span class="key"></span>${esc(paramLabel(k))}`;
  $('#trLbl2').innerHTML=`<span class="key lab"></span>Lab result: ${esc(c.name)} (${esc(c.unit)})${showEst&&S.models[comp]?' <span class="key dash" style="margin-left:10px"></span>Model estimate':''}${lab.length?'':' <span class="tiny" style="margin-left:8px">No lab samples in this period</span>'}`;
  chart('trChart',{type:'line', data:{datasets:[{label:paramLabel(k), data:pts.map(p=>({x:p.ts,y:p[k]})), borderColor:css('--s1'), backgroundColor:css('--s1-soft'), fill:true, pointRadius:0, borderWidth:1.6}]},
    options:baseOpts({plugins:{legend:{display:false}},scales:{x:{...xs,ticks:{display:false}}, y:{...yAxisW()}}})});
  const ds=[{label:`Lab result`, type:'scatter', data:lab.map(h=>({x:h.ts,y:h.conc,id:h.sample_id})), pointBackgroundColor:css('--lab'), pointBorderColor:css('--panel'), pointBorderWidth:1.5, pointRadius:6, pointStyle:'rectRot'}];
  if(showEst && S.models[comp]) ds.push({label:`Model estimate`, data:pts.map(p=>({x:p.ts,y:p.est?.[comp]?.mu??null})), borderColor:css('--fg-2'), borderDash:[5,4], pointRadius:0, borderWidth:1.4});
  chart('trChart2',{type:'line', data:{datasets:ds}, options:baseOpts({plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>`${ctx.dataset.label}${ctx.raw.id?' '+ctx.raw.id:''}: ${fmtConc(ctx.raw.y,comp)}`}}},scales:{x:xs, y:{...yAxisW(),min:0}}})});
  if(full||!$('#trSmall').children.length) $('#trSmall').innerHTML=Object.keys(PARAMS).map(p=>`<div class="panel" style="gap:8px"><h3>${paramLabel(p)}</h3><div class="chart short"><canvas id="trs-${p}"></canvas></div></div>`).join('');
  for(const p of Object.keys(PARAMS)) chart('trs-'+p,{type:'line',data:{datasets:[{label:PARAMS[p].label,data:pts.map(q=>({x:q.ts,y:q[p]})),borderColor:css('--s1'),pointRadius:0,borderWidth:1.3}]},options:baseOpts({plugins:{legend:{display:false}},scales:{x:{type:'linear',min:t0,max:S.simNow,ticks:{...timeTicks,color:css('--fg-3'),maxTicksLimit:4},grid:{display:false}},y:{ticks:{color:css('--fg-3'),maxTicksLimit:4},grid:{color:css('--line-2')}}}})});
}
$('#trRange').addEventListener('click',e=>{ const b=e.target.closest('button'); if(!b) return; trHours=+b.dataset.h; $$('#trRange button').forEach(x=>x.classList.toggle('on',x===b)); renderTrends(false); });
['#trParam','#trComp','#trEst'].forEach(s=>$(s).addEventListener('change',()=>renderTrends(false)));

/* ---------- 03 map ---------- */
const MAPS={}; let mapHours=24;
function mapLayers(hours, onSel){
  const pts=within(hours); const out=[];
  out.push({t:'line', pts, color:css('--fg-3'), w:1.2, dash:'4 3', op:.7});
  const step = Math.max(1, Math.floor(pts.length/900));
  pts.forEach((p,i)=>{ if(i%step && p.status==='ok') return; out.push({t:'dot', p, r:p.status==='ok'?2.6:3.8, fill:statusCol(p.status), tip:readingTip(p), click:()=>onSel({kind:'reading',p})}); });
  if($('#mapHot').checked) hotspots(S.simNow-hours*3600e3).forEach(h=>out.push({t:'halo',p:h,rm:170,fill:css(h.bad?'--bad':'--warn'),click:()=>onSel({kind:'hot',h})}));
  S.events.filter(e=>e.start>=S.simNow-hours*3600e3 && e.status==='bad').forEach(e=>out.push({t:'dot',p:e,r:6,shape:'tri',fill:css('--bad'),stroke:css('--panel'),sw:1.5,tip:`<b>${e.id}</b> possible contamination<br>${fmtT(e.start)}`,click:()=>onSel({kind:'event',e})}));
  if($('#mapLab').checked) S.hplc.filter(h=>h.compound===CFG.target && h.ts>=S.simNow-hours*3600e3).forEach(h=>out.push({t:'dot',p:h,r:5,shape:'diamond',fill:css('--lab'),stroke:css('--panel'),tip:`<b>${esc(h.sample_id)}</b> HPLC ${fmtConc(h.conc,h.compound)}${h.below?' (&lt;LOD)':''}<br>${fmtT(h.ts)}`,click:()=>onSel({kind:'lab',h})}));
  if($('#mapLit').checked) S.literature.points.forEach(q=>{ const rq=litRQ(q); out.push({t:'dot',p:q,r:7,shape:'ring',fill:'none',stroke:rq.v>1?css('--bad'):rq.v>=0.1?css('--warn'):css('--fg-2'),tip:litTip(q),click:()=>onSel({kind:'lit',q})}); });
  if($('#mapSrc').checked) S.sources.forEach(s=>{ out.push({t:'dot',p:s,r:5,shape:'square',fill:css('--fg'),stroke:css('--panel'),tip:`<b>${esc(s.name)}</b><br>${esc(s.type)}`,click:()=>onSel({kind:'src',s})}); out.push({t:'label',p:s,text:s.name,pos:s.lbl}); });
  const r=latest(); out.push({t:'dot',p:r,r:6,fill:css('--accent'),stroke:css('--panel'),sw:2,shape:'boat',heading:r.heading||0,tip:`<b>${esc(followName())}</b> (live)<br>${fmtT(r.ts)}`});
  return out;
}
function readingTip(p){ const e=p.est?.[CFG.target]; return `<b>${statusName[p.status]}</b><br>${fmtT(p.ts)}<br>${p.lat.toFixed(5)}° N, ${p.lon.toFixed(5)}° E<br>pH ${fmtNum(p.ph,2)} · ORP ${fmtNum(p.orp,0)} mV<br>Turb. ${fmtNum(p.turbidity,1)} NTU · UV ${fmtNum(p.uv,3)} AU${e?`<br>Est. ${compLabel(CFG.target)} ${fmtConc(e.mu,CFG.target)} (${e.conf})`:''}`; }
const LIT_COMP=['ATL','CBZ','DIC','KTP'];
function litRQ(q){ let best={v:0,c:null}; for(const c of LIT_COMP){ const pn=S.compounds[c]?.pnec; const v=q.values[c]; if(!pn||!v) continue; const rq=v.max/pn; if(rq>best.v) best={v:rq,c}; } return best; }
function litTip(q){ return `<b>Point ${q.pt}: ${esc(q.site)}</b><br>${esc(q.study)}, measured (µg/L, max / mean)<br>`+LIT_COMP.map(c=>`${esc(compLabel(c))}: ${fmtNum(q.values[c].max,3)} / ${fmtNum(q.values[c].mean,3)}`).join('<br>')+`<br><span class="tiny">Reference data, not paired with sensors</span>`; }
function renderMap(full){
  if(!MAPS.big) MAPS.big=new MapView($('#mapBig'));
  MAPS.big.baseLayers=mapLayers(mapHours, showMapSel); MAPS.big.setLayers([...MAPS.big.baseLayers, ...(MAPS.big.extra||[])]);
  $$('#mapBase button').forEach(b=>b.classList.toggle('on', b.dataset.b===(MapView.tilesFailed?'schematic':CFG.basemap)));
  const hs=hotspots(S.simNow-mapHours*3600e3);
  $('#hotList').innerHTML = hs.length? hs.map((h,i)=>`<div class="alert ${h.bad?'':'warn'}" data-hot="${i}"><div class="h"><span class="pill ${h.bad?'bad':'warn'}">${h.n} events · ${h.bad} possible contamination</span></div><div class="small">${h.lat.toFixed(4)}° N, ${h.lon.toFixed(4)}° E · ${Math.round(h.near.d)} m from ${esc(h.near.s.name)}</div></div>`).join('') : '<div class="empty">No location with repeated abnormal readings in this window.</div>';
  $$('#hotList [data-hot]').forEach(el=>el.onclick=()=>showMapSel({kind:'hot',h:hs[+el.dataset.hot]}));
}
function showMapSel(sel){
  const box=$('#mapSel'); let h='';
  if(sel.kind==='reading'){ const p=sel.p; h=`<span class="pill ${p.status}">${statusName[p.status]}</span><div class="small">${readingTip(p)}</div>`+changeBars(p); }
  else if(sel.kind==='event'){ SEL_EV=sel.e.id; h=`<span class="pill bad">${sel.e.id}</span><div class="small">${fmtT(sel.e.start)} · ${sel.e.lat.toFixed(5)}° N, ${sel.e.lon.toFixed(5)}° E</div>${changeBars(sel.e.peak)}<a href="#events" class="btn sm">Open event</a>`; }
  else if(sel.kind==='hot'){ const x=sel.h; h=`<span class="pill ${x.bad?'bad':'warn'}">Hotspot · ${x.n} events</span><div class="small">Centre ${x.lat.toFixed(5)}° N, ${x.lon.toFixed(5)}° E<br>Nearest potential source: ${esc(x.near.s.name)} (${Math.round(x.near.d)} m)<br>Mean peak estimate ${fmtConc(x.meanEst,CFG.target)}</div><div class="list">${x.events.slice(0,5).map(alertCard).join('')}</div>`; }
  else if(sel.kind==='lab'){ const x=sel.h; h=`<span class="pill lab">HPLC ${esc(x.sample_id)}</span><div class="small">${esc(compLabel(x.compound))}: <b>${fmtConc(x.conc,x.compound)}</b>${x.below?' (&lt;LOD)':''}<br>${fmtT(x.ts)} · ${esc(x.method)}<br>Match: ${x.match?.ok? `${x.match.n} readings, Δt ${x.match.dt.toFixed(1)} min, ${Math.round(x.match.dist)} m`:'no sensor data in window'}</div>`; }
  else if(sel.kind==='lit'){ const q=sel.q, rq=litRQ(q); h=`<span class="pill">Prior study · point ${q.pt}</span><div class="small">${litTip(q)}<br>Highest RQ: <b>${rq.c?esc(compLabel(rq.c))+' '+rq.v.toFixed(2):'–'}</b> ${rq.v>1?'<span class="pill bad">High</span>':rq.v>=0.1?'<span class="pill warn">Moderate</span>':'<span class="pill ok">Negligible</span>'}</div>`; }
  else if(sel.kind==='src'){ const s=sel.s; const n=S.events.filter(e=>distM(e,s)<=300).length; h=`<b>${esc(s.name)}</b><div class="small">${esc(s.type)}<br>${s.lat.toFixed(5)}° N, ${s.lon.toFixed(5)}° E<br>${n} events within 300 m<br><span class="tiny">${esc(s.basis)}</span></div>`; }
  const at = sel.kind==='reading'? sel.p : sel.kind==='event'? sel.e : sel.kind==='hot'? sel.h : sel.kind==='lab'? sel.h : null;
  if(at){ h+=`<div class="flowrow" style="margin-top:8px"><a class="btn sm" href="${OSM.link(at.lat,at.lon)}" target="_blank" rel="noopener">Open in OpenStreetMap</a><button class="btn sm" type="button" id="selFac">Facilities within 1 km</button></div><div id="selPlace" class="small"></div><div id="selFac" class="small"></div>`; }
  box.innerHTML=h;
  if(at){ OSM.reverse(at.lat,at.lon).then(pl=>{ const el=$('#selPlace'); if(el&&pl) el.innerHTML=`<b>${esc(pl.short)}</b> <span class="tiny">(OpenStreetMap)</span>`; }).catch(()=>{});
    $('button#selFac').onclick=()=>findFacilities(at, $('div#selFac'), MAPS.big, 1000); }
}
/* ---------- OpenStreetMap facility search ---------- */
const FAC_COL = {'Hospital':'--bad','Clinic':'--bad','Pharmacy':'--warn','Wastewater treatment plant':'--accent','Outfall':'--accent','Drain':'--river','Veterinary clinic':'--warn','Industrial area':'--fg-2'};
async function findFacilities(at, box, mv, radius){
  box.innerHTML='<span class="tiny">Searching OpenStreetMap…</span>';
  let res; try{ res=await OSM.facilities(at.lat, at.lon, radius); }catch(err){ box.innerHTML=`<span style="color:var(--bad)">OpenStreetMap search failed (${esc(err.message)}). The Overpass API may be busy or blocked on this network; try again later.</span>`; return; }
  const items=res.items.filter(i=>i.category!=='Drain'||i.name!=='Unnamed drain').slice(0,25); const drains=res.items.filter(i=>i.category==='Drain'&&i.name==='Unnamed drain').length;
  if(!items.length && !drains){ box.innerHTML=`No mapped facilities within ${radius} m.`; return; }
  const byCat={}; res.items.forEach(i=>byCat[i.category]=(byCat[i.category]||0)+1);
  box.innerHTML=`<div class="tiny">${Object.entries(byCat).map(([k,v])=>`${v} ${esc(k.toLowerCase())}${v>1&&!k.endsWith('s')?'s':''}`).join(' · ')} within ${radius} m. © OpenStreetMap contributors</div>
    <div class="tw" style="max-height:260px"><table><thead><tr><th>Facility</th><th>Type</th><th class="n">Distance</th><th></th></tr></thead><tbody>${items.map((f,i)=>`<tr><td><a href="${f.url}" target="_blank" rel="noopener">${esc(f.name)}</a></td><td>${esc(f.category)}</td><td class="n">${Math.round(f.dist_m)} m</td><td>${S.sources.some(s=>s.id==='OSM-'+f.osm)?'<span class="pill ok">source</span>':`<button class="btn sm" type="button" data-addsrc="${i}">Add as source</button>`}</td></tr>`).join('')}</tbody></table></div>${drains?`<div class="tiny">${drains} unnamed drain segments not listed.</div>`:''}`;
  box.querySelectorAll('[data-addsrc]').forEach(b=>b.onclick=()=>addSource(items[+b.dataset.addsrc]).then(()=>{ b.outerHTML='<span class="pill ok">source</span>'; }));
  if(mv){ const base=mv.baseLayers||mv.layers; mv.extra=items.map(f=>({t:'dot',p:f,r:5,shape:'ring',fill:css('--panel'),stroke:css(FAC_COL[f.category]||'--accent'),tip:`<b>${esc(f.name)}</b><br>${esc(f.category)} · ${Math.round(f.dist_m)} m<br><span class="tiny">OpenStreetMap ${esc(f.osm)}</span>`})); mv.setLayers([...base, ...mv.extra]); }
}
async function addSource(f){
  const src={id:('OSM-'+f.osm).slice(0,32), name:f.name, type:f.category+' (OpenStreetMap)', lat:f.lat, lon:f.lon, basis:`OpenStreetMap ${f.osm}, added from facility search`, sigma:250, load:1.0};
  if(CFG.mode==='live'){ try{ await API.req('/sources',{method:'POST',body:JSON.stringify(src)}); }catch(err){ toast('Server rejected the source: '+err.message); throw err; } }
  S.sources=S.sources.filter(s=>s.id!==src.id).concat([src]); buildEvents(); toast(`${f.name} added as a potential source`);
}
function changeBars(p){ if(!p.z) return ''; const ks=Object.keys(PARAMS); const mx=Math.max(CFG.zTh*1.5, ...ks.map(k=>Math.abs(p.z[k]||0)));
  return `<div class="hbars">${ks.map(k=>{ const z=p.z[k]||0; const w=Math.abs(z)/mx*50; return `<div class="r"><span>${PARAMS[k].label}</span><div class="track"><span class="mid"></span><i class="${z<0?'neg':''}" style="left:${z<0?50-w:50}%;width:${w}%"></i></div><span class="v">${z>=0?'+':''}${z.toFixed(1)}σ</span></div>`; }).join('')}</div><div class="tiny">Change from the rolling ${p.zone||''} baseline, in standard deviations.</div>`; }
$('#mapRange').addEventListener('click',e=>{ const b=e.target.closest('button'); if(!b) return; mapHours=+b.dataset.h; $$('#mapRange button').forEach(x=>x.classList.toggle('on',x===b)); renderMap(); });
$('#mapBase').addEventListener('click',e=>{ const b=e.target.closest('button'); if(!b) return; CFG.basemap=b.dataset.b; if(CFG.basemap==='osm') MapView.tilesFailed=false, MapView.tileErrors=0; savePrefs(); MapView.all.forEach(m=>m.el.isConnected&&m.render()); renderMap(); });
['#mapHot','#mapSrc','#mapLab','#mapLit'].forEach(s=>$(s).addEventListener('change',()=>renderMap()));

/* ---------- 04 events ---------- */
let SEL_EV=null, evFilter='all';
function renderEvents(full){
  const list=S.events.filter(e=>evFilter==='all'||e.status===evFilter);
  if(!SEL_EV || !S.events.find(e=>e.id===SEL_EV)) SEL_EV=(list.find(e=>e.status==='bad')||list[0]||{}).id;
  $('#evTable').innerHTML=list.map(e=>`<tr class="click ${e.id===SEL_EV?'sel':''}" data-id="${e.id}"><td>${fmtT(e.start)}</td><td><span class="pill ${e.status}">${e.status==='bad'?'Possible':'Unusual'}</span></td><td class="n">${e.est?fmtConc(e.est.mu,CFG.target):'–'}</td></tr>`).join('') || '<tr><td colspan="3">No events.</td></tr>';
  $$('#evTable tr[data-id]').forEach(tr=>tr.onclick=()=>{ SEL_EV=tr.dataset.id; renderEvents(); });
  const e=S.events.find(x=>x.id===SEL_EV); const box=$('#evDetail');
  if(!e){ box.innerHTML='<div class="empty">No events recorded.</div>'; return; }
  const c=S.compounds[CFG.target]; const dur=Math.max(1,Math.round((e.end-e.start)/60000));
  const labTxt = e.lab.length ? e.lab.map(h=>`<span class="pill lab">${esc(h.sample_id)}</span> ${fmtConc(h.conc,h.compound)}${h.below?' (&lt;LOD)':''} at ${fmtTime(h.ts)}, ${Math.round(distM(h,e))} m away`).join('<br>') : 'No HPLC sample within the matching window. <b>Laboratory confirmation recommended.</b>';
  box.innerHTML=`<div class="ph"><h2>${e.id}</h2><span class="pill ${e.status}">${statusName[e.status]}</span><div class="tools"><button class="btn lab sm" type="button" id="evSample">Log sampling request</button></div></div>
    <div class="kv"><div><span>Start</span><b style="font-size:18px">${fmtT(e.start)}</b></div><div><span>Duration</span><b>${dur} min</b><span class="tiny" style="font-weight:500">${e.n} readings</span></div><div><span>Peak estimate</span><b style="font-size:20px">${e.est?fmtConc(e.est.mu,CFG.target):'–'}</b></div><div><span>Repeats ≤200 m</span><b>${e.repeats}</b></div></div>
    <div class="grid g2"><div><h3>Where</h3><div class="small"><span id="evPlace"><span class="tiny">Looking up place name…</span><br></span>${e.lat.toFixed(5)}° N, ${e.lon.toFixed(5)}° E · ${e.zone==='coast'?'coastal water':'river reach'} · <a href="${OSM.link(e.lat,e.lon)}" target="_blank" rel="noopener">Open in OpenStreetMap</a><br>Nearest potential source: <b>${esc(e.near.s.name)}</b>, ${Math.round(e.near.d)} m (${esc(e.near.s.type)})${e.rain>0.15?'<br>Rainfall runoff was active at the time: turbidity and dilution may explain part of the signal.':''}</div>
      <div id="evMap" style="height:220px;border:1px solid var(--line);border-radius:var(--r);overflow:hidden;margin-top:8px"></div></div>
      <div><h3>What changed</h3>${changeBars(e.peak)}</div></div>
    <div class="grid g2"><div><h3>Estimated contamination</h3><div class="small">${e.est? `${esc(c.name)} ${fmtConc(e.est.mu,CFG.target)} (95% interval ${fmtConc(e.est.lo,CFG.target)}–${fmtConc(e.est.hi,CFG.target)}), confidence ${e.est.conf}. Screening estimate only.`:'No model.'}</div></div>
      <div><h3>HPLC result</h3><div class="small">${labTxt}</div></div></div>
    <div><h3>Sensor record around the event</h3><div class="stack" style="margin-top:6px"><div class="lbl" id="evLbl1"></div><div class="chart xs"><canvas id="evChart"></canvas></div><div class="lbl" id="evLbl2"></div><div class="chart xs"><canvas id="evChart2"></canvas></div></div></div>
    <div><div class="ph"><h3>Facilities nearby (OpenStreetMap)</h3><div class="tools"><select id="evFacR"><option value="500">500 m</option><option value="1000" selected>1 km</option><option value="2000">2 km</option></select><button class="btn sm" type="button" id="evFac">Search</button></div></div>
      <div id="evFacList" class="small muted">Hospitals, clinics, pharmacies, wastewater plants, outfalls, drains and industrial areas mapped in OpenStreetMap. Add any of them as a potential source.</div></div>
    <div class="small muted">Investigation checklist: Did it repeat at this location (${e.repeats} other events within 200 m)? Is a discharge point nearby (${Math.round(e.near.d)} m to ${esc(e.near.s.name)})? Does a lab sample confirm it?</div>`;
  const win=S.readings.filter(r=>r.ts>=e.start-90*60000 && r.ts<=e.end+90*60000);
  const k1=e.drivers[0].k, k2=e.drivers[1].k;
  const ex={type:'linear',min:win[0]?.ts,max:win[win.length-1]?.ts,ticks:{...timeTicks,color:css('--fg-3')},grid:{display:false}};
  const band={label:'Event',data:[{x:e.start,y:null}],showLine:false};
  const evPlot=(id,k,bottom)=>chart(id,{type:'line',data:{datasets:[{label:paramLabel(k),data:win.map(r=>({x:r.ts,y:r[k]})),borderColor:css('--s1'),pointRadius:win.map(r=>r.ts>=e.start&&r.ts<=e.end&&r.status!=='ok'?3:0),pointBackgroundColor:win.map(r=>statusCol(r.status)),pointBorderWidth:0,borderWidth:1.6}]},
    options:baseOpts({plugins:{legend:{display:false}},scales:{x:bottom?ex:{...ex,ticks:{display:false}},y:{...yAxisW(),ticks:{maxTicksLimit:3}}}})});
  $('#evLbl1').innerHTML=`<span class="key"></span>${esc(paramLabel(k1))} <span class="tiny">largest change</span>`; $('#evLbl2').innerHTML=`<span class="key"></span>${esc(paramLabel(k2))} <span class="tiny">second largest</span>`;
  evPlot('evChart',k1,false); evPlot('evChart2',k2,true);
  const mv=new MapView($('#evMap'),{legend:false,note:false,labels:false,focus:0.012}); mv.focusOn(e.lat, e.lon, 0.012); MAPS.ev=mv;
  const evBase=[{t:'line',pts:win,color:css('--fg-3'),w:1.5,dash:'3 3'}, ...win.filter(r=>r.status!=='ok').map(r=>({t:'dot',p:r,r:3.5,fill:statusCol(r.status)})), ...S.sources.map(s=>({t:'dot',p:s,r:5,shape:'square',fill:css('--fg'),tip:esc(s.name)})), {t:'dot',p:e,r:6,shape:'tri',fill:css('--bad'),stroke:css('--panel'),sw:1.5}];
  mv.baseLayers=evBase; mv.setLayers(evBase);
  // OpenStreetMap: place name + nearby facilities
  OSM.reverse(e.lat,e.lon).then(pl=>{ const el=$('#evPlace'); if(el&&pl&&SEL_EV===e.id) el.innerHTML=`<b>${esc(pl.short)}</b> <span class="tiny">(OpenStreetMap)</span><br>`; }).catch(()=>{ const el=$('#evPlace'); if(el) el.innerHTML=''; });
  $('#evFac').onclick=()=>findFacilities(e, $('#evFacList'), MAPS.ev, +$('#evFacR').value);
  $('#evSample').onclick=async()=>{ const txt=`Sampling request ${e.id}\nLocation: ${e.lat.toFixed(5)} N, ${e.lon.toFixed(5)} E\nTime of event: ${new Date(e.start).toISOString()}\nTarget: ${c.name} by SPE + HPLC-UV\nReason: ${statusName[e.status]}; ${PARAMS[e.drivers[0].k].label} z ${e.drivers[0].z.toFixed(1)}`;
    if(CFG.mode==='live'){ try{ await API.req('/sampling-requests',{method:'POST',body:JSON.stringify({event_id:e.id,lat:e.lat,lon:e.lon,compound:CFG.target,note:txt})}); toast('Sampling request saved'); }catch(err){ toast('Could not save: '+err.message); } }
    else copyText(txt); };
}
$('#evFilter').addEventListener('click',e=>{ const b=e.target.closest('button'); if(!b) return; evFilter=b.dataset.f; $$('#evFilter button').forEach(x=>x.classList.toggle('on',x===b)); renderEvents(); });

/* ---------- 05 HPLC ---------- */
const HPLC_TPL=`sample_id,timestamp,lat,lon,compound,concentration,unit,lod,method,notes
S-101,2026-09-28T09:15:00+08:00,5.408132,100.322845,Paracetamol,0.12,mg/L,0.005,SPE + HPLC-UV,SP2 grab sample
S-101,2026-09-28T09:15:00+08:00,5.408132,100.322845,Diclofenac,<LOD,µg/L,0.054,SPE + HPLC-UV 254 nm,
S-102,2026-09-28T10:40:00+08:00,5.403843,100.330476,PCM,190,µg/L,5,SPE + HPLC-UV,SP5`;
function resolveComp(s){ s=String(s||'').trim().toLowerCase(); return Object.values(S.compounds).find(c=>c.id.toLowerCase()===s||c.name.toLowerCase()===s)?.id; }
function convert(v, from, comp){ const to=S.compounds[comp].unit; const a=UNIT_TO_UG[from.replace('u','µ')]??UNIT_TO_UG[from], b=UNIT_TO_UG[to]; if(a==null||b==null) return null; return v*a/b; }
function importHPLC(text){
  const res=Papa.parse(text.trim(),{header:true,skipEmptyLines:true,transformHeader:h=>h.trim().toLowerCase()});
  const ok=[], errs=[];
  res.data.forEach((row,i)=>{
    const line=i+2; const comp=resolveComp(row.compound); const ts=Date.parse(row.timestamp); const lat=+row.lat, lon=+row.lon; const unit=(row.unit||S.compounds[comp]?.unit||'').trim();
    if(!comp) return errs.push(`Row ${line}: unknown compound "${row.compound}". Add it in the micropollutant database first.`);
    if(!isFinite(ts)) return errs.push(`Row ${line}: timestamp "${row.timestamp}" is not a date (use ISO 8601, e.g. 2026-09-28T09:15:00+08:00).`);
    if(!isFinite(lat)||!isFinite(lon)) return errs.push(`Row ${line}: lat/lon missing.`);
    let lod = row.lod!==''&&row.lod!=null ? convert(+row.lod, unit, comp) : null; let below=false; let v;
    if(/lod|nd|</i.test(row.concentration)){ below=true; if(lod==null) return errs.push(`Row ${line}: <LOD needs an LOD value.`); v=lod/2; }
    else { v=convert(parseFloat(row.concentration), unit, comp); if(v==null||!isFinite(v)) return errs.push(`Row ${line}: concentration or unit "${unit}" not recognised.`); }
    const h={id:`${row.sample_id||'U'+Date.now()}-${comp}-${ts}`, sample_id:row.sample_id||'(no id)', ts, lat, lon, compound:comp, conc:+v.toPrecision(5), lod, below, method:row.method||'', notes:row.notes||'', origin:'upload'};
    const sens={}; let has=false; for(const k of Object.keys(PARAMS)){ if(row[k]!==undefined && row[k]!==''){ sens[k]=+row[k]; has=true; } }
    if(has){ h.sensors=sens; if(!Object.keys(PARAMS).every(k=>k in sens)) h.sensorsPartial=true; }
    ok.push(h);
  });
  return {ok, errs};
}
async function addHPLC(list){
  if(CFG.mode==='live'){ await API.req('/hplc',{method:'POST',body:JSON.stringify(list.map(h=>({...h, ts:new Date(h.ts).toISOString()})))}); }
  const ids=new Set(list.map(h=>h.id)); S.hplc=S.hplc.filter(h=>!ids.has(h.id)).concat(list).sort((a,b)=>a.ts-b.ts);
  list.forEach(matchSample);
}
function renderHPLC(full){
  if(full){ compOptions($('#hfComp'), CFG.target); compOptions($('#hplcFilter'), '', true); $('#mWin').value=CFG.matchWinMin; $('#mDist').value=CFG.matchDistM; }
  const f=$('#hplcFilter').value; const rows=S.hplc.filter(h=>!f||h.compound===f).slice().sort((a,b)=>b.ts-a.ts);
  const matched=rows.filter(h=>h.match?.ok).length;
  $('#hplcCount').textContent=`${rows.length} results · ${matched} matched to sensor data`;
  $('#hplcTable').innerHTML=rows.map(h=>{ const m=h.match||{}; const s=m.sensors||{}; const mdl=S.models[h.compound];
    const xv = m.ok&&mdl ? featVec({...s}, mdl.feats) : null; const est = xv && xv.every(v=>v!=null&&isFinite(v)) ? mdl.final.predict(xv) : null;
    const ck = mdl&&mdl.external ? crossCheckOne(h, mdl) : null;
    return `<tr><td class="mono">${esc(h.sample_id)}</td><td>${fmtT(h.ts)}</td><td>${esc(compLabel(h.compound))}</td><td class="n">${fmtConc(h.conc,h.compound)}</td><td class="n">${est!=null?fmtConc(Math.max(0,est),h.compound):'–'}</td><td>${ck?`<span class="pill ${ck.flag===ck.labHigh?'ok':ck.labHigh?'bad':'warn'}" title="Screening probability ${(ck.p*100).toFixed(0)}%">${ck.flag===ck.labHigh?'✓ ':''}${ck.verdict}</span>`:''}</td><td>${h.below?'<span class="pill warn">&lt;LOD</span>':''}${h.origin==='demo'?'<span class="pill">demo</span>':''}</td>
    <td>${m.ok?(m.direct?'<span class="pill acc">in file</span>':`<span class="pill ok">${m.n} rdg</span>`):'<span class="pill bad">none</span>'}</td><td class="n">${m.ok?fmtNum(m.dt,1)+' min':'–'}</td><td class="n">${m.ok?Math.round(m.dist)+' m':'–'}</td>
    <td class="n">${fmtNum(s.ph,2)}</td><td class="n">${fmtNum(s.orp,0)}</td><td class="n">${fmtNum(s.turbidity,1)}</td><td class="n">${fmtNum(s.uv,3)}</td></tr>`; }).join('');
  renderCrossCheck();
}
$('#hplcFilter').addEventListener('change',()=>renderHPLC(false));
$('#hplcTplBtn').onclick=()=>copyText(HPLC_TPL,$('#hplcPaste'));
$('#hplcDemoBtn').onclick=async()=>{ try{ if(!Object.values(S.models).some(m=>m&&m.external)) await loadBundledModel();
  $('#hplcPaste').value=await getBundled('models/crosscheck_lab_results.csv','models/crosscheck_lab_results.js','AQUATRACE_CROSSCHECK_CSV',true); $('#hplcImport').click(); await new Promise(z=>setTimeout(z,50));
  const first=Object.keys(S.models).find(c=>S.models[c]&&S.models[c].external&&S.hplc.some(h=>h.compound===c)); if(first){ $('#hplcFilter').value=first; renderHPLC(false); }
  $('#xcPanel').scrollIntoView({behavior:'smooth'}); }catch(e){ toast('Could not load the cross-check file: '+e.message); } };
$('#hplcFile').addEventListener('change',e=>{ const f=e.target.files[0]; if(!f) return; const rd=new FileReader(); rd.onload=()=>{ $('#hplcPaste').value=rd.result; }; rd.readAsText(f); });
$('#hplcImport').onclick=async()=>{ const t=$('#hplcPaste').value; if(!t.trim()) return $('#hplcMsg').textContent='Choose a CSV file or paste CSV text first.';
  const {ok,errs}=importHPLC(t); try{ if(ok.length) await addHPLC(ok); }catch(e){ return $('#hplcMsg').textContent='Server rejected the upload: '+e.message; }
  $('#hplcMsg').innerHTML=`Imported ${ok.length} result${ok.length===1?'':'s'}.`+(errs.length?`<br><span style="color:var(--bad)">${errs.slice(0,6).map(esc).join('<br>')}${errs.length>6?`<br>…and ${errs.length-6} more`:''}</span>`:'');
  renderHPLC(false); };
$('#hplcForm').addEventListener('submit',async e=>{ e.preventDefault(); const comp=$('#hfComp').value, unit=$('#hfUnit').value; const v=convert(+$('#hfConc').value,unit,comp); const lod=$('#hfLod').value? convert(+$('#hfLod').value,unit,comp):null;
  if(v==null) return toast(`Unit ${unit} cannot be converted to ${S.compounds[comp].unit}.`);
  const h={id:`${$('#hfId').value}-${comp}`, sample_id:$('#hfId').value, ts:Date.parse($('#hfTs').value), lat:+$('#hfLat').value, lon:+$('#hfLon').value, compound:comp, conc:+v.toPrecision(5), lod, below:false, method:$('#hfMethod').value, notes:'manual', origin:'manual'};
  try{ await addHPLC([h]); }catch(err){ return toast('Server rejected the result: '+err.message); }
  toast(`Added ${h.sample_id}: ${h.match?.ok?`matched to ${h.match.n} readings`:'no sensor readings in the matching window'}`); renderHPLC(false); });
$('#hfNow').onclick=()=>{ const r=latest(); const d=new Date(r.ts); const pad=n=>String(n).padStart(2,'0'); $('#hfTs').value=`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; $('#hfLat').value=r.lat; $('#hfLon').value=r.lon; if(!$('#hfId').value) $('#hfId').value='S-'+String(Math.floor(Math.random()*900+100)); };
$('#mRun').onclick=()=>{ CFG.matchWinMin=+$('#mWin').value||15; CFG.matchDistM=+$('#mDist').value||300; savePrefs(); matchAll(); renderHPLC(false); toast('Matching re-run. Retrain models to use the new pairs.'); };


function renderCrossCheck(){
  const comps=Object.keys(S.models).filter(c=>S.models[c]&&S.models[c].external);
  const rows=comps.map(crossCheckSummary).filter(r=>r&&r.n);
  $('#xcPanel').hidden=!rows.length; if(!rows.length) return;
  const pct=v=>v==null?'–':(v*100).toFixed(0)+'%';
  $('#xcTable').innerHTML=rows.map(r=>{ const m=S.models[r.comp]; const lift=r.hit!=null&&r.base?r.hit/r.base:null;
    return `<tr><td><b>${esc(S.compounds[r.comp].name)}</b><div class="tiny">high = above ${fmtConc(m.threshold,r.comp)}</div></td><td class="n">${r.n}</td><td class="n">${r.high} <span class="tiny">(${pct(r.base)})</span></td><td class="n">${r.flagged}</td>
      <td class="n"><b>${pct(r.hit)}</b></td><td class="n">${lift?lift.toFixed(1)+'×':'–'}</td><td class="n">${pct(r.caught)}</td><td class="n">${pct(r.agree)}</td><td class="n">${r.auc!=null?r.auc.toFixed(2):'–'}</td>
      <td class="n">${m.screenHold?.auc!=null?m.screenHold.auc.toFixed(2):'–'}</td><td class="n">${pct(r.within2x)} <span class="tiny">of ${r.nDet}</span></td></tr>`; }).join('');
  const tot=rows.reduce((a,r)=>({n:a.n+r.n, tp:a.tp+r.tp, f:a.f+r.flagged, h:a.h+r.high}),{n:0,tp:0,f:0,h:0});
  $('#xcNote').textContent=`${tot.n} lab results checked · model flagged ${tot.f}, of which ${tot.tp} were truly high (${pct(tot.f?tot.tp/tot.f:null)}) vs ${pct(tot.h/tot.n)} if sampled at random`;
}
// Bundled files: fetch() when served by a web server; when index.html is opened by double-click (file://)
// browsers block fetch, so fall back to the same data wrapped as a .js file loaded with a <script> tag.
function loadScriptOnce(src){ return new Promise((res,rej)=>{ const s=document.createElement('script'); s.src=src; s.onload=res; s.onerror=()=>rej(new Error('cannot load '+src)); document.head.appendChild(s); }); }
async function getBundled(url, jsUrl, globalName, asText){
  try{ const r=await fetch(url,{cache:'no-store'}); if(r.ok) return asText? await r.text() : await r.json(); }catch(e){}
  if(window[globalName]==null) await loadScriptOnce(jsUrl);
  if(window[globalName]==null) throw new Error('files not found in the models folder next to index.html');
  return window[globalName];
}
async function loadBundledModel(){
  return useModelPackage(await getBundled('models/aquatrace_colab_model.json','models/aquatrace_colab_model.js','AQUATRACE_MODEL',false));
}
function useModelPackage(pkg){
  const ids=loadModelPackage(pkg); rescoreAll();
  toast(`Loaded ${ids.length} Colab models (${ids.map(i=>S.compounds[i].name.replace(' (US model)','')).join(', ')})`);
  renderView(true); return ids;
}

/* ---------- 06 ML ---------- */
let mlFeats=null;
function renderML(full){
  if(full){ mlAskPrefill(false); mlApiShow(); renderMlAlgos(); }
  if(full){ compOptions($('#mlComp'), $('#mlComp').value||CFG.target);
    const comp=$('#mlComp').value; const m=S.models[comp]; mlFeats = mlFeats || (m?m.feats:[...CFG.feats]); if(m) $('#mlModel').value=m.type;
    $('#mlFeat').innerHTML=[...Object.keys(PARAMS),...Object.keys(EXTRA_FEATS)].map(k=>`<label class="chk"><input type="checkbox" value="${k}" ${mlFeats.includes(k)?'checked':''}> ${esc(PARAMS[k]?.label||EXTRA_FEATS[k])}</label>`).join('')+`<span class="tiny">Location and time features can inflate scores when samples cluster at a few stations; leave them off unless you validate by station.</span>`;
    $('#mlScX').innerHTML=Object.keys(PARAMS).map(k=>`<option value="${k}" ${k==='uv'?'selected':''}>${paramLabel(k)}</option>`).join(''); }
  const comp=$('#mlComp').value; const c=S.compounds[comp]; const m=S.models[comp]; const P=pairs(comp);
  const ext=!!(m&&m.external) || !!c?.external; $('#mlModelLbl').hidden=ext; $('#mlTrain').hidden=ext; $('#mlCompare').hidden=ext; $('#mlAlgoJump').hidden=!ext; if(ext) $('#mlCmpPanel').hidden=true;
  $('#mlN').textContent=`${P.length} paired samples (HPLC ↔ sensors) for ${c.name}`;
  if(!m){ const err=trainModel(comp,'rf',mlFeats||CFG.feats).error;
    $('#mlMetrics').innerHTML=`<div style="grid-column:1/-1"><span>Not trained</span><div class="small" style="margin-top:4px">${esc(err||'Press Train model.')}</div></div>`;
    ['mlPvm','mlScatter'].forEach(id=>{ if(CH[id]){CH[id].destroy(); delete CH[id];} }); $('#mlImp').innerHTML=''; $('#mlCorr').innerHTML=''; $('#mlNow').innerHTML=''; $('#mlAssess').textContent=''; $('#mlCard').textContent=''; return; }
  const u=c.unit;
  const r2c = v => v>=0.7?'ok':v>=0.5?'warn':'bad';
  if(m.external){ $$('#mlFeat input').forEach(i=>i.checked=m.feats.includes(i.value)); if(full) $('#mlScX').value=(m.importance.find(i=>PARAMS[i.f])||m.importance[0]).f; }
  if(m.external){ const sh=m.screenHold||{}, a=v=>v==null?'–':(v*100).toFixed(0)+'%';
    $('#mlMetrics').innerHTML=`<div><span>Training samples</span><b>${m.n}</b><span class="tiny" style="display:block">${m.nSites} sites</span></div><div><span>Screening AUC <span class="nu">(held-out sites)</span></span><b style="color:var(--${r2c((sh.auc-0.5)*2.5)})">${sh.auc?.toFixed(2)??'–'}</b></div><div><span>Flagged that were really high</span><b>${a(sh.hit_rate)}</b><span class="tiny" style="display:block">vs ${a(sh.base_rate)} at random</span></div><div><span>High samples caught</span><b>${a(sh.caught_share)}</b></div><div><span>Level R² <span class="nu">(log, CV)</span></span><b style="color:var(--${r2c(m.level.r2_log_cv)})">${m.level.r2_log_cv.toFixed(2)}</b></div><div><span>Level within 2×</span><b>${a(m.level.within2x_cv)}</b></div>`; }
  else $('#mlMetrics').innerHTML=`<div><span>Samples (n)</span><b>${m.n}</b></div><div><span>R² (5-fold CV)</span><b style="color:var(--${r2c(m.r2)})">${m.r2.toFixed(2)}</b></div><div><span>RMSE <span class="nu">(${esc(u)})</span></span><b>${fmtNum(m.rmse, m.rmse<0.1?3:2)}</b></div><div><span>MAE <span class="nu">(${esc(u)})</span></span><b>${fmtNum(m.mae, m.mae<0.1?3:2)}</b></div><div><span>UV-only R² (CV)</span><b>${m.r2UV!=null?m.r2UV.toFixed(2):'–'}</b></div><div><span>Training R²</span><b>${m.fitR2.toFixed(2)}</b></div>`;
  const mx=Math.max(m.yMax, ...m.oof.map(o=>o.yhat))*1.05; const lg=!!m.external, mn=lg?Math.min(...m.oof.map(o=>Math.min(o.y,o.yhat)))*0.8:0;
  chart('mlPvm',{type:'scatter',data:{datasets:[{label:'Samples',data:m.oof.map(o=>({x:o.y,y:o.yhat,id:o.id})),pointBackgroundColor:m.oof.map(o=>o.below?css('--fg-3'):css('--lab')),pointRadius:4},{label:'1:1',type:'line',data:[{x:mn,y:mn},{x:mx,y:mx}],borderColor:css('--fg-3'),borderDash:[4,4],pointRadius:0,borderWidth:1}]},
    options:baseOpts({plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>ctx.raw.id?`${ctx.raw.id}: HPLC ${fmtConc(ctx.raw.x,comp)}, predicted ${fmtConc(ctx.raw.y,comp)}`:''}}},scales:{x:{type:lg?'logarithmic':'linear',min:mn,max:mx,title:{display:true,text:`${lg?'Lab-measured':'HPLC-measured'} (${u})${lg?', log scale':''}`,color:css('--fg-2')},ticks:{color:css('--fg-2')},grid:{color:css('--line-2')}},y:{type:lg?'logarithmic':'linear',min:mn,max:mx,title:{display:true,text:`Predicted (${u})`,color:css('--fg-2')},ticks:{color:css('--fg-2')},grid:{color:css('--line-2')}}}})});
  const imax=Math.max(...m.importance.map(i=>i.v),1e-9);
  $('#mlImpNote').textContent=m.external?'permutation, screening model, held-out sites':'permutation, held-out folds';
  $('#mlImp').innerHTML=m.importance.map(i=>`<div class="r"><span>${esc(PARAMS[i.f]?.label||EXTRA_FEATS[i.f]||i.f)}</span><div class="track"><i style="left:0;width:${i.v/imax*100}%"></i></div><span class="v">${(i.v*100).toFixed(0)}%</span></div>`).join('');
  $('#mlCorr').innerHTML=m.corr.map(k=>{ const w=Math.abs(k.r)*50; return `<div class="r"><span>${esc(PARAMS[k.f]?.short||PARAMS[k.f]?.label||EXTRA_FEATS[k.f]||k.f)}</span><div class="track"><span class="mid"></span><i class="${k.r<0?'neg':''}" style="left:${k.r<0?50-w:50}%;width:${w}%"></i></div><span class="v">${k.r>=0?'+':''}${k.r.toFixed(2)} / ${k.rho.toFixed(2)}</span></div>`; }).join('');
  renderScatter();
  const r=latest(); const e=r.est?.[comp];
  const lab=P.slice().sort((a,b)=>b.ts-a.ts)[0];
  $('#mlNow').innerHTML= e? `<dt>Estimated ${esc(c.name.toLowerCase())}</dt><dd><span class="big">${fmtConc(e.mu,comp)}</span></dd><dt>95% interval</dt><dd>${fmtConc(e.lo,comp)} – ${fmtConc(e.hi,comp)}</dd><dt>Reference HPLC</dt><dd>${lab?`${fmtConc(lab.conc,comp)} <span class="tiny">latest, ${esc(lab.sample_id)} ${fmtT(lab.ts)}</span>`:'none'}</dd><dt>Model confidence</dt><dd><span class="pill ${e.conf==='High'?'ok':e.conf==='Medium'?'warn':'bad'}">${e.conf}</span></dd>${e.p!=null?`<dt>Screening</dt><dd>${mlAlertPill(e.alert||(e.flag?'red':'green'))} <span class="tiny">chance of being above ${fmtConc(m.threshold,comp)}: ${(e.p*100).toFixed(1)}% (red ≥ ${(m.pThr*100).toFixed(1)}%, amber ≥ ${((m.pAmber??m.pThr)*100).toFixed(1)}%)</span></dd>`:''}${m.external?`<dt>Online API</dt><dd id="mlNowApi">–</dd>`:''}<dt>Status</dt><dd>${c.level!=null && e.mu>=c.level?'<span class="pill bad">Possible pharmaceutical contamination detected</span>':'<span class="pill ok">Below screening level</span>'}</dd><dt>Recommendation</dt><dd>${c.level!=null && e.mu>=c.level?'Confirm with laboratory analysis':'Continue monitoring; confirm periodically with HPLC'}</dd>`:'';
  $('#mlAssess').innerHTML= m.external ? `<b>How to read this.</b> This model was trained in Google Colab on ${m.n} real US river samples and tested on ${m.nHold} samples from ${m.nHoldSites} sites it never saw. Its strength is <b>screening</b>: flagged readings were truly high ${((m.screenHold?.hit_rate||0)*100).toFixed(0)}% of the time, against ${((m.screenHold?.base_rate||0)*100).toFixed(0)}% for random sampling. The level estimate is rough (R² ${m.level.r2_log_cv.toFixed(2)}). It has not been calibrated on Penang water. ${e&&e.reasons.length? 'Current reading: '+esc(e.reasons.join('; '))+'.':''}` : `<b>How to read this.</b> ${m.r2>=0.7?'Sensor combinations explain most of the variation in HPLC results for this dataset.':m.r2>=0.5?'Sensor combinations explain part of the variation; use estimates for screening only.':'Sensor signals explain little of the HPLC variation for this compound. Treat estimates as unreliable.'} ${m.r2UV!=null? (m.r2-m.r2UV>0.05?`The multivariable model adds ${((m.r2-m.r2UV)*100).toFixed(0)} points of R² over UV alone.`:'UV alone performs about as well as the full model.'):''} ${e&&e.reasons.length? 'Current reading: '+esc(e.reasons.join('; '))+'.':''}`;
  mlApiNow(comp);
  if(m.external){ $('#mlCard').innerHTML=`Compound: ${esc(c.name)} · unit ${esc(u)}<br>Source: ${esc(m.pkgSource)}<br>Built in Google Colab, ${fmtT(m.trainedAt)}<br>Served by: ${m.via==='online'?`online ML API, <span class="mono">${esc(m.apiBase)}</span>`:'the copy saved in models/ (online ML API not connected)'}<br>Inputs: ${m.feats.map(f=>esc(PARAMS[f]?.label||f)).join(', ')}<br>Screening model: ${m.kind==='two-step'?'two random forests of 60 trees: P(detected at all) × P(high, if detected)':'random forest classifier, 60 trees'}${m.season?', with the season (month of the reading) as an input':''} (kind and settings chosen on validation sites; random forest chosen out of 7 algorithms). Alerts: 🔴 red = send to lab when the score is in the riskiest 5% of validation readings (≥ ${(m.pThr*100).toFixed(1)}%); 🟠 amber = watch, riskiest 5–10% (≥ ${((m.pAmber??m.pThr)*100).toFixed(1)}%). "High" = above ${fmtConc(m.threshold,comp)} (${m.thresholdNg} ng/L, the median of US detections).<br>Level model: random forest regressor on log10 concentration, detected samples only (${m.nDetected}).<br>Validation: ${m.split?`sites split 60/20/20: training ${m.split.training.samples} samples (${m.split.training.sites} sites), validation ${m.split.validation.samples} (${m.split.validation.sites} sites), testing ${m.split.testing.samples} (${m.split.testing.sites} sites), tested once`:`20% of sites held back entirely (${m.nHold} samples, ${m.nHoldSites} sites)`}.`; }
  else $('#mlCard').innerHTML=`Compound: ${esc(c.name)} (${esc(c.cas)}) · target unit ${esc(u)}<br>Algorithm: ${({rf:'Random forest, 120 trees, max depth 7, min leaf 3, bootstrap', ridge:'Ridge regression on standardised inputs, λ = 1', tree:'Decision tree, max depth 6, min leaf 3', knn:'K-nearest neighbours, k = 7, standardised inputs', gb:'Gradient boosting, 100 trees of depth 3, learning rate 0.1'})[m.type]||m.type}<br>Inputs: ${m.feats.map(f=>esc(PARAMS[f]?.label||EXTRA_FEATS[f]||f)).join(', ')}<br>Validation: 5-fold CV (shuffled, seed 1234). Uncertainty = 1.96·√(tree spread² + CV RMSE²).<br>Applicability domain: each input within training range ±10%.<br>Pairing: HPLC samples matched to readings within ±${CFG.matchWinMin} min and ${CFG.matchDistM} m (weighted average).<br>Values below LOD entered as LOD/2 (grey points).<br>Trained ${fmtT(m.trainedAt)}${S.serverModels[comp]?`<br>Server model: v${S.serverModels[comp].version}, CV R² ${S.serverModels[comp].r2_cv.toFixed(2)}`:''}`;
}
function renderScatter(){ const comp=$('#mlComp').value; const m=S.models[comp]; if(!m) return; const k=$('#mlScX').value; const P=pairs(comp).filter(h=>isFinite(h.match.sensors[k])); if(!P.length){ if(CH.mlScatter){CH.mlScatter.destroy(); delete CH.mlScatter;} return; } const x=P.map(h=>h.match.sensors[k]), y=P.map(h=>h.conc); const lf=linfit(x,y); const xs=[Math.min(...x),Math.max(...x)];
  chart('mlScatter',{type:'scatter',data:{datasets:[{label:'Lab samples',data:x.map((v,i)=>({x:v,y:y[i]})),pointBackgroundColor:css('--lab'),pointBorderColor:css('--panel'),pointBorderWidth:1,pointRadius:4.5},{label:`Linear fit, R² ${lf.r2.toFixed(2)}`,type:'line',data:xs.map(v=>({x:v,y:lf.a+lf.b*v})),borderColor:css('--s1'),pointRadius:0,borderWidth:1.5}]},
    options:baseOpts({scales:{x:{type:'linear',title:{display:true,text:paramLabel(k),color:css('--fg-2')},ticks:{color:css('--fg-2')},grid:{color:css('--line-2')}},y:{title:{display:true,text:`${S.compounds[comp].name} (${S.compounds[comp].unit})`,color:css('--fg-2')},ticks:{color:css('--fg-2')},grid:{color:css('--line-2')}}}})}); }
$('#mlScX').addEventListener('change',renderScatter);
$('#mlPkgDemo').onclick=async()=>{ try{ let ids=[]; if(await MLAPI.connect()) { ids=mlModelIds(); toast(`Model reloaded from the online ML API (${ids.length} medicines)`); } else { ids=await loadBundledModel(); toast('Online ML API not reachable: using the saved copy of the model'); } if(ids[0]) $('#mlComp').value=ids[0]; mlFeats=null; renderML(true); }catch(e){ toast('Could not load the model: '+e.message); } };
$('#mlPkgFile').addEventListener('change',e=>{ const f=e.target.files[0]; if(!f) return; const rd=new FileReader(); rd.onload=()=>{ try{ const ids=useModelPackage(JSON.parse(rd.result)); $('#mlComp').value=ids[0]; mlFeats=null; renderML(true); }catch(err){ toast(err.message); } }; rd.readAsText(f); e.target.value=''; });
$('#mlComp').addEventListener('change',()=>{ mlFeats=null; renderML(true); });
$('#mlTrain').onclick=async()=>{ const comp=$('#mlComp').value; mlFeats=$$('#mlFeat input:checked').map(i=>i.value); if(!mlFeats.length) return toast('Select at least one input.');
  $('#mlTrain').disabled=true; $('#mlTrain').textContent='Training…'; await new Promise(r=>setTimeout(r,30));
  const res=trainModel(comp,$('#mlModel').value,mlFeats); $('#mlTrain').disabled=false; $('#mlTrain').textContent='Train model';
  if(res.error){ S.models[comp]=null; toast(res.error); renderML(false); return; }
  S.models[comp]=res; S.readings.forEach(estimateReading); buildEvents();
  if(CFG.mode==='live' && ['rf','ridge'].includes(res.type)){ try{ const sm=await API.req('/ml/train',{method:'POST',body:JSON.stringify({compound:comp,model:res.type,features:mlFeats}),timeout:60000}); S.serverModels[comp]=sm; toast(`Server model v${sm.version} trained: CV R² ${sm.r2_cv.toFixed(2)}`);}catch(e){ toast('Server training failed: '+e.message); } }
  else toast(`${S.compounds[comp].name} model trained: CV R² ${res.r2.toFixed(2)}, n = ${res.n}`);
  renderML(false); };

$('#mlCompare').onclick=async()=>{ const comp=$('#mlComp').value; const feats=$$('#mlFeat input:checked').map(i=>i.value); if(!feats.length) return toast('Select at least one input.');
  const btn=$('#mlCompare'); btn.disabled=true; $('#mlCmpPanel').hidden=false; $('#mlCmpTable').innerHTML=''; const rows=[];
  for(const type of Object.keys(ALGO_NAMES)){ btn.textContent=`Training ${ALGO_NAMES[type]}…`; await new Promise(r=>setTimeout(r,20));
    const res=trainModel(comp,type,feats); if(res.error){ $('#mlCmpNote').textContent=res.error; break; } rows.push({type,res});
    const best=Math.max(...rows.map(r=>r.res.r2)); const u=S.compounds[comp].unit;
    $('#mlCmpTable').innerHTML=rows.slice().sort((a,b)=>b.res.r2-a.res.r2).map(r=>`<tr${r.res.r2===best?' class="sel"':''}><td><b>${esc(ALGO_NAMES[r.type])}</b>${r.res.r2===best?' <span class="pill ok">best</span>':''}</td><td class="n"><b>${r.res.r2.toFixed(2)}</b></td><td class="n">${fmtNum(r.res.rmse,r.res.rmse<0.1?3:2)} <span class="tiny">${esc(u)}</span></td><td class="n">${fmtNum(r.res.mae,r.res.mae<0.1?3:2)}</td><td class="n">${r.res.n}</td></tr>`).join('');
    $('#mlCmpNote').textContent=`${S.compounds[comp].name} · ${rows[0].res.n} paired lab results · inputs: ${feats.map(f=>PARAMS[f]?.short||PARAMS[f]?.label||EXTRA_FEATS[f]||f).join(', ')}`; }
  btn.disabled=false; btn.textContent='Compare algorithms'; };

/* ---------- 07 database ---------- */
$('#litStat').addEventListener('change',()=>renderDB());
function renderDB(){
  $('#dbTable').innerHTML=Object.values(S.compounds).map(c=>{ const n=S.hplc.filter(h=>h.compound===c.id).length; const m=S.models[c.id];
    return `<tr class="click" data-id="${c.id}"><td><b>${esc(c.name)}</b> <span class="tiny mono">${esc(c.id)}</span></td><td>${esc(c.cls)}</td><td class="mono">${esc(c.cas)}</td><td class="n">${c.kow??'–'}</td><td>${esc(c.unit)}</td><td class="n">${c.level??'–'}</td><td class="n">${c.pnec??'<span class="tiny">not set</span>'}</td><td>${esc(c.method)}${c.rt?` <span class="tiny">RT ${c.rt} min</span>`:''}</td><td class="n">${n}</td><td>${m?`<span class="pill ${m.r2>=0.7?'ok':m.r2>=0.5?'warn':'bad'}">R² ${m.r2.toFixed(2)}</span>`:n?'<span class="pill">needs data</span>':'<span class="pill">no data</span>'}</td><td class="tiny" style="white-space:normal;min-width:220px">${esc(c.src||'')}</td></tr>`; }).join('');
  $$('#dbTable tr[data-id]').forEach(tr=>tr.onclick=()=>{ const c=S.compounds[tr.dataset.id]; $('#dbId').value=c.id; $('#dbName').value=c.name; $('#dbClass').value=c.cls||''; $('#dbCas').value=c.cas||''; $('#dbKow').value=c.kow??''; $('#dbUnit').value=c.unit; $('#dbLevel').value=c.level??''; $('#dbPnec').value=c.pnec??''; $('#dbMethod').value=c.method||''; });
  const rows=Object.values(S.compounds).filter(c=>c.pnec).map(c=>{ const hs=S.hplc.filter(h=>h.compound===c.id && !h.below); if(!hs.length) return null; const mec=Math.max(...hs.map(h=>h.conc))*(UNIT_TO_UG[c.unit]||1); const rq=mec/c.pnec; return {c,mec,rq}; }).filter(Boolean);
  const st=$('#litStat').value;
  $('#litTable').innerHTML=S.literature.points.map(q=>{ const rq=litRQ(q); return `<tr><td class="n">${q.pt}</td><td>${esc(q.study)}</td><td>${esc(q.site)}</td>${LIT_COMP.map(c=>{ const v=q.values[c]; const pn=S.compounds[c]?.pnec; const hot=pn&&v.max/pn>1; return `<td class="n" ${hot?'style="color:var(--bad);font-weight:600"':''}>${v[st]? fmtNum(v[st], v[st]>=10?1:3):'<span class="tiny">&lt;LOD</span>'}${v.flag&&st==='mean'?' <span class="tiny" title="Reported mean exceeds reported maximum">†</span>':''}</td>`; }).join('')}<td>${rq.c?`<span class="pill ${rq.v>1?'bad':rq.v>=0.1?'warn':'ok'}">${esc(compLabel(rq.c))} ${rq.v.toFixed(2)}</span>`:'–'}</td></tr>`; }).join('');
  $('#litNote').innerHTML=`${esc(S.literature.source)} Red values give RQ &gt; 1 against the PNEC in the table above. † reported mean exceeds reported maximum in the source table. These points are reference context: they carry no sensor readings, so they are not used to train models. Paracetamol was not measured in these studies.`;
  const litRows=Object.values(S.compounds).filter(c=>c.pnec && LIT_COMP.includes(c.id)).map(c=>{ const mx=Math.max(...S.literature.points.map(q=>q.values[c.id].max)); const at=S.literature.points.find(q=>q.values[c.id].max===mx); return {c, mec:mx, rq:mx/c.pnec, at}; });
  rows.forEach(r=>{ const l=litRows.find(x=>x.c.id===r.c.id); if(l) r.lit=l; });
  $('#rqBox').innerHTML = rows.length? `<div class="tw"><table><thead><tr><th>Compound</th><th class="n">MEC <span class="nu">(µg/L)</span></th><th class="n">PNEC <span class="nu">(µg/L)</span></th><th class="n">RQ</th><th>Risk</th><th class="n">Prior studies: max MEC → RQ</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${esc(r.c.name)}</td><td class="n">${r.mec.toFixed(3)}</td><td class="n">${r.c.pnec}</td><td class="n">${r.rq.toFixed(3)}</td><td><span class="pill ${r.rq>1?'bad':r.rq>=0.1?'warn':'ok'}">${r.rq>1?'High':r.rq>=0.1?'Moderate':'Negligible'}</span></td><td class="n">${r.lit?`${r.lit.mec.toFixed(2)} → <span class="pill ${r.lit.rq>1?'bad':r.lit.rq>=0.1?'warn':'ok'}">${r.lit.rq.toFixed(2)}</span> <span class="tiny">pt ${r.lit.at.pt}</span>`:'–'}</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">Add PNEC values and HPLC data to compute risk quotients.</div>';
}
$('#dbForm').addEventListener('submit',async e=>{ e.preventDefault(); const id=$('#dbId').value.trim().toUpperCase(); const num=v=>v===''?null:+v;
  const c={...(S.compounds[id]||{bg:0,src:'Added by user'}), id, name:$('#dbName').value.trim(), cls:$('#dbClass').value, cas:$('#dbCas').value, kow:num($('#dbKow').value), unit:$('#dbUnit').value, level:num($('#dbLevel').value), pnec:num($('#dbPnec').value), method:$('#dbMethod').value};
  if(CFG.mode==='live'){ try{ await API.req('/compounds',{method:'POST',body:JSON.stringify(c)}); }catch(err){ return toast('Server rejected the compound: '+err.message); } }
  S.compounds[id]=c; toast(`Saved ${c.name}. It is now available for HPLC import and training.`); renderDB(); });

/* ---------- 08 reactor ---------- */
function kinetics(run){ const r=run.rows; const C0=r[0].conc; const pts=r.filter(x=>x.time_h>0 && x.conc>0).map(x=>({t:x.time_h, y:Math.log(C0/x.conc)}));
  const n=pts.length; const st=pts.reduce((s,p)=>s+p.t*p.t,0); const k=n? pts.reduce((s,p)=>s+p.t*p.y,0)/st : 0; // through origin
  const r2=n>1? r2score(pts.map(p=>p.y), pts.map(p=>k*p.t)) : 0; const end=r[r.length-1];
  return {C0, Cend:end.conc, removal:(1-end.conc/C0)*100, k, r2, t:end.time_h, half:k>0?Math.log(2)/k:Infinity, rUV:pearson(r.map(x=>x.uv), r.map(x=>x.conc)), tocRemoval: r[0].toc? (1-end.toc/r[0].toc)*100 : null}; }
const isCtrl = r => r.catalyst==='none' || r.light==='dark';
function renderReactor(full){
  if(!S.reactor.length){ $('#rxFlow').innerHTML='<div class="empty">No reactor runs yet. Import one below.</div>'; return; }
  if(full||!$('#rxRun').options.length) $('#rxRun').innerHTML=S.reactor.map(r=>`<option value="${r.id}">${r.id} · ${esc(r.catalyst)} ${r.dose?r.dose+' g/L':''} · ${esc(r.light)}${r.origin==='demo'?' (demo)':''}</option>`).join('');
  const run=S.reactor.find(r=>r.id===$('#rxRun').value)||S.reactor[0]; const k=kinetics(run); const c=S.compounds[run.compound]||{name:run.compound,unit:'mg/L'};
  $('#rxFlow').innerHTML=`<div class="stage"><span class="tiny">Initial ${esc(c.name.toLowerCase())} (HPLC)</span><b>${k.C0.toFixed(2)}</b><span class="tiny">${esc(c.unit)}</span></div><span class="ar">→</span>
    <div class="stage"><span class="tiny">Photocatalytic treatment</span><b style="font-size:20px">${esc(run.catalyst)}</b><span class="tiny">${run.dose} g/L · ${esc(run.light)} · ${k.t} h</span></div><span class="ar">→</span>
    <div class="stage"><span class="tiny">Final (HPLC)</span><b>${k.Cend.toFixed(3)}</b><span class="tiny">${esc(c.unit)}</span></div><span class="ar">=</span>
    <div class="stage"><span class="tiny">Removal efficiency</span><b>${k.removal.toFixed(1)}%</b><span class="tiny">k = ${k.k.toFixed(3)} h⁻¹ · t½ = ${isFinite(k.half)?(k.half*60).toFixed(0)+' min':'–'}${k.tocRemoval!=null?` · TOC −${k.tocRemoval.toFixed(0)}%`:''}</span></div>`;
  // verdict from data
  const ctrls=S.reactor.filter(r=>isCtrl(r) && r.compound===run.compound).map(r=>({r,k:kinetics(r)}));
  const reps=S.reactor.filter(r=>r!==run && (r.rep===run.id || run.rep===r.id || (r.rep && r.rep===run.rep))).map(kinetics);
  let v;
  if(isCtrl(run)) v={cls:'', t:'Control run', d:`This run is a control (${run.catalyst==='none'?'photolysis without catalyst':'catalyst in the dark: adsorption only'}). It defines the baseline that treatment runs must beat.`};
  else if(!ctrls.length) v={cls:'warn', t:'Inconclusive: no control runs', d:'Add a photolysis-only run (no catalyst) and a dark adsorption run so removal can be attributed to photocatalysis.'};
  else { const best=Math.max(...ctrls.map(x=>x.k.removal)); const net=k.removal-best; const kr=k.k/Math.max(...ctrls.map(x=>x.k.k),1e-6);
    const repSd = reps.length? sd([k.removal,...reps.map(x=>x.removal)]) : null;
    const pass = net>=20 && kr>=3 && k.r2>=0.9;
    v={cls:pass?'ok':net>0?'warn':'bad', t: pass?'Evidence supports photocatalytic removal under these conditions':'Evidence does not yet support a treatment effect',
      d:`Removal ${k.removal.toFixed(1)}% vs best control ${best.toFixed(1)}% (net ${net.toFixed(1)} percentage points). Rate constant ${kr.toFixed(1)}× the fastest control. First-order fit R² ${k.r2.toFixed(2)}.${repSd!=null?` Replicate spread ±${repSd.toFixed(1)} points (n = ${reps.length+1}).`:' No replicate yet: add one to estimate run-to-run variability.'} Criteria: net ≥ 20 points, k ≥ 3× control, R² ≥ 0.9.`}; }
  $('#rxVerdict').innerHTML=`<span class="pill ${v.cls||'acc'}">${v.cls==='ok'?'Supported':v.cls==='bad'?'Not supported':v.cls==='warn'?'Unresolved':'Control'}</span> <b>${v.t}</b><div class="small muted" style="margin-top:4px">${v.d}</div>`;
  chart('rxChart',{type:'line',data:{datasets:[...S.reactor.filter(r=>r!==run).map(r=>({label:r.id+(isCtrl(r)?' (control)':''),data:r.rows.map(x=>({x:x.time_h,y:x.conc/r.rows[0].conc})),borderColor:css(isCtrl(r)?'--fg-3':'--line'),borderDash:isCtrl(r)?[5,4]:undefined,borderWidth:1.3,pointRadius:0})),
      {label:run.id+' (selected)',data:run.rows.map(x=>({x:x.time_h,y:x.conc/run.rows[0].conc})),borderColor:css('--s1'),borderWidth:2.5,pointRadius:3.5,pointBackgroundColor:css('--s1')}]},
    options:baseOpts({plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>`${ctx.dataset.label}: C/C₀ ${ctx.raw.y.toFixed(2)}`}}},scales:{x:{type:'linear',title:{display:true,text:'Irradiation time (h)',color:css('--fg-2')}},y:{min:0,max:1.05,title:{display:true,text:'C / C₀',color:css('--fg-2')}}}})});
  const C0=run.rows[0].conc;
  chart('rxKin',{type:'scatter',data:{datasets:[{label:'ln(C₀/C)',data:run.rows.map(x=>({x:x.time_h,y:Math.log(C0/x.conc)})),pointBackgroundColor:css('--lab'),pointRadius:4},{label:`k = ${k.k.toFixed(3)} h⁻¹, R² ${k.r2.toFixed(3)}`,type:'line',data:[{x:0,y:0},{x:k.t,y:k.k*k.t}],borderColor:css('--s1'),pointRadius:0}]},
    options:baseOpts({scales:{x:{type:'linear',title:{display:true,text:'Time (h)',color:css('--fg-2')},ticks:{color:css('--fg-2')},grid:{color:css('--line-2')}},y:{title:{display:true,text:'ln(C₀/C)',color:css('--fg-2')},ticks:{color:css('--fg-2')},grid:{color:css('--line-2')}}}})});
  const sk=$('#rxSensor').value;
  const sl=$('#rxSensor').selectedOptions[0].text; const rxX={type:'linear',min:0,max:k.t,title:{display:true,text:'Time (h)',color:css('--fg-2')}};
  $('#rxLbl1').innerHTML=`<span class="key"></span>${esc(sl)} (in-line sensor)`; $('#rxLbl2').innerHTML=`<span class="key lab"></span>Lab result: ${esc(c.name)} (${esc(c.unit)})`;
  chart('rxSens',{type:'line',data:{datasets:[{label:sl,data:run.rows.map(x=>({x:x.time_h,y:x[sk]})),borderColor:css('--s1'),pointRadius:3,pointBackgroundColor:css('--s1'),borderWidth:2}]},options:baseOpts({plugins:{legend:{display:false}},scales:{x:{...rxX,title:{display:false},ticks:{display:false}},y:{...yAxisW()}}})});
  chart('rxSens2',{type:'line',data:{datasets:[{label:'Lab result',data:run.rows.map(x=>({x:x.time_h,y:x.conc})),borderColor:css('--lab'),pointRadius:5,pointStyle:'rectRot',pointBackgroundColor:css('--lab'),borderWidth:1.5,borderDash:[4,3]}]},options:baseOpts({plugins:{legend:{display:false}},scales:{x:rxX,y:{...yAxisW(),min:0}}})});
  $('#rxTable').innerHTML=S.reactor.map(r=>{ const q=kinetics(r); return `<tr class="${r===run?'sel':''}"><td>${r.id}${isCtrl(r)?' <span class="pill">control</span>':''}</td><td>${esc(r.catalyst)}</td><td class="n">${r.dose}</td><td>${esc(r.light)}</td><td class="n">${q.t}</td><td class="n">${q.C0.toFixed(2)}</td><td class="n">${q.Cend.toFixed(3)}</td><td class="n">${q.removal.toFixed(1)}%</td><td class="n">${q.k.toFixed(3)}</td><td class="n">${q.r2.toFixed(2)}</td><td class="n">${q.rUV.toFixed(2)}</td></tr>`; }).join('');
  $('#rxRefs').innerHTML=`<ul class="clean refs"><li>Khasawneh (2022, PhD, USM): lab-scale Fe₂O₃-TiO₂ / TiO₂ P25 removal of atenolol, diclofenac and carbamazepine 87–97% under simulated solar light (500 W halogen, ~140 W/m², 3 h); optimum catalyst dose 0.2 g/L; pseudo-first-order kinetics.</li>
    <li>Pilot scale (solar CPC reactor, natural sunlight): Fe₂O₃-TiO₂ 79–88.8%, TiO₂ P25 59–81.7%; TOC fell at most 33% after 5 h; activity dropped below 50% after five reuse cycles; cost ≈ 0.65 MYR/m³ (P25) and 1.47 MYR/m³ (Fe₂O₃-TiO₂).</li>
    <li>These are benchmarks for other compounds. Paracetamol runs in this demo are synthetic and must be replaced with your HPLC results.</li></ul>`;
}
$('#rxRun').addEventListener('change',()=>renderReactor(false)); $('#rxSensor').addEventListener('change',()=>renderReactor(false));
const RX_TPL=`run_id,catalyst,dose_gL,light,compound,time_h,conc,ph,orp,uv,turbidity,toc
R9,Fe2O3-TiO2,0.2,simulated solar,PCM,0,5.00,6.9,245,0.65,39,4.1
R9,Fe2O3-TiO2,0.2,simulated solar,PCM,1,1.90,6.7,330,0.36,40,3.7
R9,Fe2O3-TiO2,0.2,simulated solar,PCM,2,0.70,6.6,352,0.20,39,3.3
R9,Fe2O3-TiO2,0.2,simulated solar,PCM,3,0.26,6.5,360,0.13,40,3.1`;
$('#rxTpl').onclick=()=>copyText(RX_TPL,$('#rxPaste'));
$('#rxImport').onclick=async()=>{ const res=Papa.parse($('#rxPaste').value.trim(),{header:true,skipEmptyLines:true,dynamicTyping:true,transformHeader:h=>h.trim().toLowerCase()});
  const by={}; for(const r of res.data){ if(!r.run_id||r.time_h==null||r.conc==null) continue; (by[r.run_id]=by[r.run_id]||{id:String(r.run_id),catalyst:String(r.catalyst||'unknown'),dose:+r.dose_gl||0,light:String(r.light||''),compound:resolveComp(r.compound)||'PCM',rows:[],origin:'upload'}).rows.push({time_h:+r.time_h,conc:+r.conc,ph:r.ph,orp:r.orp,uv:r.uv,turbidity:r.turbidity,toc:r.toc}); }
  const runs=Object.values(by).filter(r=>r.rows.length>=3); if(!runs.length) return $('#rxMsg').textContent='No run with at least 3 time points found. Check the column names against the template.';
  runs.forEach(r=>r.rows.sort((a,b)=>a.time_h-b.time_h));
  if(CFG.mode==='live'){ try{ await API.req('/reactor/runs',{method:'POST',body:JSON.stringify(runs)}); }catch(e){ return $('#rxMsg').textContent='Server rejected the run: '+e.message; } }
  S.reactor=S.reactor.filter(r=>!runs.some(n=>n.id===r.id)).concat(runs); $('#rxMsg').textContent=`Imported ${runs.map(r=>r.id).join(', ')}.`; renderReactor(true); $('#rxRun').value=runs[0].id; renderReactor(false); };

/* ---------- 09 insights ---------- */
const FACTORS={awareness:'Lack of awareness of take-back options', convenience:'No convenient collection point', uncertainty:'Unsure of the correct disposal method', habit:'Convenience / habit of using the bin', no_followup:'No follow-up after treatment', leftover:'Medicines left over after the course'};
function renderInsights(){
  const sv=S.survey; const demo=sv.some(s=>s.origin==='demo');
  $('#svN').textContent=`n = ${sv.length}${demo?' · synthetic example data':''}`;
  const cnt={}; sv.forEach(s=>cnt[s.disposal_method]=(cnt[s.disposal_method]||0)+1); const tot=sv.length||1; const mx=Math.max(...Object.values(cnt),1);
  $('#svMethods').innerHTML=Object.entries(cnt).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`<div class="r"><span>${esc(k)}</span><div class="track"><i class="${/pharmacy|clinic/i.test(k)?'':'neg'}" style="left:0;width:${v/mx*100}%"></i></div><span class="v">${(v/tot*100).toFixed(0)}%</span></div>`).join('')+`<div class="tiny">Blue marks a registered take-back channel.</div>`;
  const fs=Object.entries(FACTORS).map(([k,l])=>({k,l,m:mean(sv.map(s=>+s[k]).filter(isFinite))})).filter(f=>isFinite(f.m)).sort((a,b)=>b.m-a.m);
  $('#svFactors').innerHTML=fs.map(f=>`<div class="r"><span>${esc(f.l)}</span><div class="track"><i style="left:0;width:${(f.m-1)/4*100}%"></i></div><span class="v">${f.m.toFixed(2)}</span></div>`).join('')||'<div class="empty">No factor columns in the survey data.</div>';
  $('#srcTable').innerHTML=S.sources.map(s=>{ const ev=S.events.filter(e=>distM(e,s)<=300); return {s,ev}; }).sort((a,b)=>b.ev.length-a.ev.length).map(({s,ev})=>`<tr><td><b>${esc(s.name)}</b></td><td>${esc(s.type)}</td><td class="n">${ev.length}</td><td class="n">${ev.length?fmtConc(mean(ev.map(e=>e.est?.mu??0)),CFG.target):'–'}</td><td class="tiny" style="white-space:normal;min-width:200px">${esc(s.basis)}</td></tr>`).join('');
  $('#ivList').innerHTML=S.interviews.map(i=>`<div class="small"><span class="pill acc">${esc(i.theme)}</span> ${esc(i.text)}</div>`).join('')||'<div class="tiny">No interview notes yet.</div>';
}
const SV_TPL=`respondent_id,disposal_method,awareness,convenience,uncertainty,habit,no_followup,leftover
P001,Household rubbish bin,4,5,3,4,2,5
P002,Returned to pharmacy / clinic,2,2,1,1,1,3`;
$('#svTpl').onclick=()=>copyText(SV_TPL,$('#svPaste'));
$('#svFile').addEventListener('change',e=>{ const f=e.target.files[0]; if(!f) return; const rd=new FileReader(); rd.onload=()=>$('#svPaste').value=rd.result; rd.readAsText(f); });
$('#svImport').onclick=async()=>{ const res=Papa.parse($('#svPaste').value.trim(),{header:true,skipEmptyLines:true,transformHeader:h=>h.trim().toLowerCase()}); const rows=res.data.filter(r=>r.disposal_method);
  if(!rows.length) return $('#svMsg').textContent='No rows with a disposal_method column were found.';
  if(CFG.mode==='live'){ try{ await API.req('/survey',{method:'POST',body:JSON.stringify(rows)}); }catch(e){ return $('#svMsg').textContent='Server rejected the survey: '+e.message; } }
  S.survey=S.survey.filter(s=>s.origin!=='demo').concat(rows.map(r=>({...r,origin:'upload'}))); $('#svMsg').textContent=`Imported ${rows.length} responses (demo responses removed).`; renderInsights(); };
$('#ivForm').addEventListener('submit',async e=>{ e.preventDefault(); const it={theme:$('#ivTheme').value||'General', text:$('#ivQuote').value, origin:'user'}; if(!it.text) return;
  if(CFG.mode==='live'){ try{ await API.req('/interviews',{method:'POST',body:JSON.stringify(it)}); }catch(err){ return toast('Could not save: '+err.message); } }
  S.interviews.unshift(it); $('#ivQuote').value=''; renderInsights(); });

/* ---------- 10 architecture / 11 settings ---------- */
function renderArch(){ $('#archApi').innerHTML=`<ul class="clean">
  <li><b>Sensor node</b>: ESP32 with DFRobot-class analogue pH, ORP, turbidity, conductivity and DO probes, DS18B20 temperature, RS-485 UV254 absorbance probe and a u-blox GPS. Firmware posts JSON every 10–60 s over Wi-Fi or 4G.</li>
  <li><b>Ingest</b>: <code>POST /api/ingest</code> (HTTPS, device key) or MQTT topic <code>aquatrace/&lt;device&gt;/readings</code>. Each reading is scored against its baseline and every trained model on arrival, so alerts are raised even when no one has the dashboard open.</li>
  <li><b>Database</b>: SQLite for a laptop pilot, PostgreSQL / TimescaleDB in production (set <code>DATABASE_URL</code>).</li>
  <li><b>ML service</b>: scikit-learn random forest / ridge per compound, versioned in a model registry with CV metrics, retrained on demand from the paired dataset.</li>
  <li><b>Fishing fleet</b>: any phone can join as a demonstration boat from the Fishing fleet page (scan the QR code). It sends its GPS position and simulated sensor values over MQTT, or to <code>/api/ingest</code> on a server; real boats use the ESP32 node in <code>firmware/</code>.</li>
  <li><b>Context APIs</b>: Open-Meteo hourly rainfall and temperature are attached to each event, since rain drives turbidity and dilution. OpenStreetMap supplies the basemap, place names (Nominatim) and nearby hospitals, pharmacies, treatment plants and outfalls (Overpass) for source investigation.</li>
  <li><b>This dashboard</b> is one HTML file served by the backend. Opened on its own it falls back to the built-in simulator.</li></ul>`; }
function renderSettings(){ renderMlApiSettings(); $('#apiBase').value=CFG.apiBase; $('#apiKey').value=CFG.apiKey; $('#thZ').value=CFG.zTh; $('#thWin').value=CFG.baseWin; $('#thTick').value=CFG.tickSec;
  $('#aboutDemo').innerHTML=CFG.mode==='demo'?`<p style="margin:0 0 6px">Everything shown in demo mode is <b>synthetic</b>. A water model places four potential sources along Sungai Pinang and the coast, mixes in tropical afternoon rain, seawater intrusion and occasional discharge pulses, and generates both sensor readings and "true" concentrations. HPLC results are those concentrations with ±8% analytical noise and LODs.</p><p style="margin:0">Real elements: sampling-point coordinates SP1–SP5, the HPLC method (C18, 254 nm), retention times, PNEC values and photocatalysis benchmarks come from the attached USM theses. The STP outfall and coastal station positions are approximate.</p>`:`Connected to ${esc(CFG.apiBase)}. Data shown is from the server database.`; }
$('#apiConnect').onclick=async()=>{ CFG.apiBase=$('#apiBase').value.trim(); CFG.apiKey=$('#apiKey').value.trim(); if(!CFG.apiBase) return $('#apiMsg').textContent='Enter the API base URL, e.g. https://monitor.example.org/api';
  $('#apiMsg').textContent='Connecting…'; const h=await API.detect(); if(!h){ $('#apiMsg').textContent='Could not reach the API. Check the URL, CORS settings and that the server is running. In a sandboxed preview, outside connections are blocked.'; return; }
  savePrefs(); await startLive(h); $('#apiMsg').textContent=`Connected: ${h.name||'AquaTrace API'} ${h.version||''}`; };
$('#apiDemo').onclick=()=>{ CFG.apiBase=''; savePrefs(); startDemo(); toast('Switched to demo simulator'); };
$('#thApply').onclick=()=>{ CFG.zTh=+$('#thZ').value||3; CFG.baseWin=+$('#thWin').value||72; CFG.tickSec=Math.max(1,+$('#thTick').value||3); savePrefs(); rescoreAll(); restartTimer(); toast('Thresholds applied and history re-scored'); };
$$('[data-exp]').forEach(b=>b.onclick=()=>{ const k=b.dataset.exp; let txt='';
  if(k==='readings') txt=toCSV(S.readings.map(r=>({...r, ts:new Date(r.ts).toISOString(), status:r.status, [`est_${CFG.target}`]:r.est?.[CFG.target]?.mu?.toFixed(5)})), ['ts','device','lat','lon',...Object.keys(PARAMS),'status',`est_${CFG.target}`]);
  if(k==='pairs') txt=toCSV(S.hplc.filter(h=>h.match?.ok).map(h=>({sample_id:h.sample_id,ts:new Date(h.ts).toISOString(),lat:h.lat,lon:h.lon,compound:h.compound,conc:h.conc,below_lod:h.below,match_n:h.match.n,match_dt_min:h.match.dt.toFixed(1),match_dist_m:Math.round(h.match.dist),...Object.fromEntries(Object.keys(PARAMS).map(p=>[p,h.match.sensors[p]?.toFixed(4)]))})), ['sample_id','ts','lat','lon','compound','conc','below_lod','match_n','match_dt_min','match_dist_m',...Object.keys(PARAMS)]);
  if(k==='hplc') txt=toCSV(S.hplc.map(h=>({...h,ts:new Date(h.ts).toISOString(),unit:S.compounds[h.compound]?.unit})), ['sample_id','ts','lat','lon','compound','conc','unit','lod','below','method','notes']);
  if(k==='events') txt=toCSV(S.events.map(e=>({id:e.id,start:new Date(e.start).toISOString(),end:new Date(e.end).toISOString(),status:e.status,lat:e.lat,lon:e.lon,peak_est:e.est?.mu?.toFixed(5),confidence:e.est?.conf,driver:e.drivers[0].k,driver_z:e.drivers[0].z.toFixed(2),nearest_source:e.near.s.name,source_dist_m:Math.round(e.near.d),repeats:e.repeats})), ['id','start','end','status','lat','lon','peak_est','confidence','driver','driver_z','nearest_source','source_dist_m','repeats']);
  copyText(txt,$('#expOut')); });

const RENDER={dashboard:renderDashboard, fleet:renderFleet, node:renderNode, trends:renderTrends, map:renderMap, events:renderEvents, hplc:renderHPLC, ml:renderML, database:renderDB, reactor:renderReactor, insights:renderInsights, architecture:renderArch, settings:renderSettings};

/* ---------- stream ---------- */
let TIMER=null;
function restartTimer(){ clearInterval(TIMER); TIMER=setInterval(tick, CFG.tickSec*1000); }
async function tick(){
  if(S.paused) return;
  const nowReal=Date.now();
  if(CFG.mode==='demo'){
    S.simNow += S.realtime ? (nowReal-S.lastTickReal) : CFG.simMinPerTick*60000;   // real time once a phone has joined
    S.lastTickReal = nowReal;
    addReading(PRIMARY, makeReading(S.simNow));
    simFleetStep(S.simNow);
  } else {
    try{ const fresh=await API.poll(); S.lastTickReal=nowReal; for(const r of fresh){ const x=r.extra||{}; const b=addReading(r.device||'UNKNOWN', r, {name:x.name||undefined, kind:S.fleet.has(r.device)?undefined:(x.kind==='esp32'?'node':x.mode?'phone':'server')}); b.lastSeenReal=Date.now(); b.meta=metaFromMsg(x, b.meta); if(x.ack){ (b.acks=b.acks||[]).unshift({t:Date.now(), text:String(x.ack)}); } } $('#liveDot').className='dot live'; }
    catch(e){ $('#liveDot').className='dot'; }
  }
  replayStep();
  buildEvents();
  $('#clock').textContent=new Date(clockNow()).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit', second:S.realtime?'2-digit':undefined});
  if(['dashboard','map','fleet','node','live'].includes(VIEW)) renderView(false);
  else if(VIEW==='trends' && trHours<=24) renderTrends(false);
}
$('#pauseBtn').onclick=()=>{ S.paused=!S.paused; $('#pauseBtn span').textContent=S.paused?'Resume':'Pause'; $('#liveDot').className='dot'+(S.paused?'':' live'); };
/* light / dark switch: follows the system until chosen, then remembers the choice */
function currentTheme(){ const t=document.documentElement.dataset.theme; return t || (matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'); }
function setTheme(t){ document.documentElement.dataset.theme=t; try{ localStorage.setItem('aquatrace.theme',t); }catch(e){} $('#themeLbl').textContent=t==='dark'?'Dark':'Light'; }
$('#themeBtn').onclick=()=>setTheme(currentTheme()==='dark'?'light':'dark');
try{ const t=localStorage.getItem('aquatrace.theme'); if(t==='light'||t==='dark') document.documentElement.dataset.theme=t; }catch(e){}
$('#themeLbl').textContent=currentTheme()==='dark'?'Dark':'Light';

/* ---------- boot ---------- */
function afterData(){
  matchAll(); S.models={}; trainAll(); rescoreAll(); mlApiApply();   // online ML model, when connected
  if(!S.compounds[CFG.target]) CFG.target='PCM';
  $('#modeBadge').className='mode '+CFG.mode; $('#modeBadge').textContent= CFG.mode==='demo'?'Demo data':'Live data'; $('#modeBadge').title= CFG.mode==='demo'?'Synthetic example data generated in your browser':'Connected to '+CFG.apiBase;
  $('#clock').textContent=new Date(S.simNow).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
  go(location.hash.slice(1)||'dashboard'); restartTimer();
}
function startDemo(){ CFG.mode='demo'; S.realtime=false; seedDemo(); seedFleet(); afterData(); }
async function startLive(h){ CFG.mode='live'; if(h.map){ CFG.tileUrl=h.map.tile_url||CFG.tileUrl; if(h.map.attribution) CFG.tileAttr=h.map.attribution.replace('OpenStreetMap','<a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'); }
  try{ await API.bootstrap(); }catch(e){ toast('Live data failed to load: '+e.message); return startDemo(); }
  if(!S.readings.length){ toast('Connected, but the server has no readings yet. Showing the simulator until data arrives.'); return startDemo(); }
  S.t0 = S.readings[0].ts; initRoute(); afterData(); }
matchMedia('(prefers-color-scheme: dark)').addEventListener('change',()=>renderView(true));
new MutationObserver(()=>renderView(true)).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
(async function boot(){
  loadPrefs();
  if(!CFG.fleetCode){ CFG.fleetCode=newFleetCode(); savePrefs(); }
  S.autoFollow = CFG.autoFollow!==false;
  if(!window.Chart||!window.Papa){ document.querySelector('.main').insertAdjacentHTML('afterbegin','<div class="disclaim" style="margin:16px">Chart and CSV libraries failed to load. Check the network connection and reload.</div>'); }
  const h = await API.detect();
  if(h) await startLive(h); else startDemo();
})();
