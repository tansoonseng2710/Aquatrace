/* ============================================================
   AquaTrace — map renderer.
   OpenStreetMap tiles through Leaflet by default, with a schematic SVG
   basemap as the offline fallback (used automatically if tiles cannot
   load, or chosen by the user). Both consume the same layer spec:
   {t:'line', pts, color, w, dash, op} · {t:'dot', p, r, fill, stroke, shape, tip, click}
   {t:'halo', p, rm, fill, op, click} · {t:'label', p, text}
   ============================================================ */
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
class MapView {
  static all=[]; static tilesFailed=false; static tileErrors=0; static tileLoads=0;
  constructor(el, opts={}){ this.el=el; this.opts=opts; this.layers=[]; this.kind=null; this.view=null; this.tip=null; this.focus=null;
    MapView.all=MapView.all.filter(m=>{ if(m.el.isConnected) return true; if(m.lm){ m.lm.remove(); m.lm=null; } return false; }); MapView.all.push(this); }
  setLayers(layers){ this.layers=layers; this.render(); }
  render(){
    if(CFG.basemap==='osm' && window.L && !MapView.tilesFailed) return this.renderLeaflet();
    return this.renderSVG();
  }
  /* centre on a point; span is the approximate width in degrees of longitude */
  focusOn(lat, lon, span){
    this.focus={lat,lon,span:span||this.opts.focus||0.02};
    if(this.kind==='leaflet' && this.lm){ const W=this.el.clientWidth||400; const z=clamp(Math.round(Math.log2(360*W/(256*this.focus.span))),3,18); this.lm.setView([lat,lon], z, {animate:false}); }
    else if(this.view){ this.view.cLat=lat; this.view.cLon=lon; this.view.span=this.focus.span; if(this.kind==='svg') this.drawSVG(); }
  }
  /* frame a set of points (used by the fleet map) */
  fitPoints(pts){
    if(!pts.length) return;
    const la=pts.map(p=>p.lat), lo=pts.map(p=>p.lon); const la0=Math.min(...la), la1=Math.max(...la), lo0=Math.min(...lo), lo1=Math.max(...lo);
    const span=Math.max(0.01, (lo1-lo0)*1.35, (la1-la0)*1.35*(this.el.clientWidth||600)/(this.el.clientHeight||400));
    this.focus={lat:(la0+la1)/2, lon:(lo0+lo1)/2, span};
    if(this.kind==='leaflet' && this.lm) this.lm.fitBounds([[la0,lo0],[la1,lo1]],{padding:[40,40],maxZoom:16,animate:false});
    else if(this.view){ this.view.cLat=this.focus.lat; this.view.cLon=this.focus.lon; this.view.span=span; if(this.kind==='svg') this.drawSVG(); }
  }
  addLegend(){
    if(this.opts.legend===false) return;
    const lg=document.createElement('div'); lg.className='maplegend'; lg.innerHTML=
      `<span><i class="dot" style="background:var(--ok)"></i>Normal</span><span><i class="dot" style="background:var(--warn)"></i>Unusual readings</span><span><i class="dot" style="background:var(--bad)"></i>Possible contamination</span><span><svg width="10" height="10"><rect width="9" height="9" x=".5" y=".5" fill="var(--fg)"/></svg>Potential source</span><span><svg width="10" height="10"><path d="M5 0L10 5L5 10L0 5Z" fill="var(--lab)"/></svg>HPLC sample</span><span><svg width="12" height="12"><circle cx="6" cy="6" r="4.5" fill="none" stroke="var(--fg-2)" stroke-width="2"/></svg>Prior study (MEC)</span><span><svg width="12" height="12"><circle cx="6" cy="6" r="4.5" fill="var(--panel)" stroke="var(--accent)" stroke-width="2"/></svg>OSM facility</span>`;
    L && L.DomEvent && L.DomEvent.disableClickPropagation && this.kind==='leaflet' && L.DomEvent.disableClickPropagation(lg);
    this.el.appendChild(lg);
  }
  /* ---------- schematic SVG ---------- */
  bounds(){ const pts=[...ROUTE, ...S.sources, PLACES.UP]; const lat=pts.map(p=>p.lat), lon=pts.map(p=>p.lon);
    return {la0:Math.min(...lat)-0.0025, la1:Math.max(...lat)+0.0025, lo0:Math.min(...lon)-0.003, lo1:Math.max(...lon)+0.003}; }
  renderSVG(){
    if(this.kind!=='svg'){ this.teardown(); this.kind='svg'; this.el.innerHTML=''; this.svg=document.createElementNS('http://www.w3.org/2000/svg','svg'); this.el.appendChild(this.svg);
      this.tip=document.createElement('div'); this.tip.className='maptip'; this.tip.hidden=true; this.el.appendChild(this.tip);
      if(this.opts.note!==false){ const n=document.createElement('div'); n.className='mapnote'; n.textContent=MapView.tilesFailed?'Schematic basemap · map tiles unavailable':'Schematic basemap · WGS84'; this.el.appendChild(n); }
      this.addLegend();
      const b=this.bounds(); this.view={cLat:(b.la0+b.la1)/2, cLon:(b.lo0+b.lo1)/2, span:(b.lo1-b.lo0)};
      if(this.opts.focus){ this.view.span=this.opts.focus; }
      if(this.focus){ this.view.cLat=this.focus.lat; this.view.cLon=this.focus.lon; this.view.span=this.focus.span; }
      this.bindPanZoom();
      new ResizeObserver(()=>this.kind==='svg'&&this.drawSVG()).observe(this.el);
    }
    this.drawSVG();
  }
  proj(p){ const W=this.el.clientWidth||600, H=this.el.clientHeight||400; const k=W/this.view.span; const ky=k/Math.cos(this.view.cLat*Math.PI/180);
    return [W/2+(p.lon-this.view.cLon)*k, H/2-(p.lat-this.view.cLat)*ky]; }
  mPerPx(){ const W=this.el.clientWidth||600; return this.view.span*111320*Math.cos(this.view.cLat*Math.PI/180)/W; }
  drawSVG(){
    const W=this.el.clientWidth||600, H=this.el.clientHeight||400; const svg=this.svg; svg.setAttribute('viewBox',`0 0 ${W} ${H}`);
    const P=p=>this.proj(p); const path=pts=>pts.map((p,i)=>(i?'L':'M')+P(p).map(v=>v.toFixed(1)).join(' ')).join('');
    let h='';
    // land: coastline closed far to the west
    const coast=COAST.map(([lat,lon])=>({lat,lon})); const land=[...coast, {lat:5.3700,lon:100.2700},{lat:5.4400,lon:100.2700},{lat:5.4400,lon:100.3480}];
    h+=`<rect x="0" y="0" width="${W}" height="${H}" fill="var(--sea)"/>`;
    h+=`<path d="${path(land)}Z" fill="var(--land)" stroke="var(--grid)" stroke-width="1"/>`;
    // graticule every 0.005°
    const b=this.bounds(); const raw=this.view.span/5; const step=[0.0025,0.005,0.01,0.02,0.05,0.1,0.2,0.5,1].find(v=>v>=raw)||1;   // about five grid lines across
    for(let la=Math.ceil((this.view.cLat-this.view.span)/step)*step; la<this.view.cLat+this.view.span; la+=step){ const y=P({lat:la,lon:this.view.cLon})[1]; if(y<0||y>H) continue; h+=`<line x1="0" x2="${W}" y1="${y}" y2="${y}" stroke="var(--grid)" stroke-width=".6" stroke-dasharray="2 4"/>${this.opts.labels!==false?`<text x="4" y="${y-3}" font-size="10">${la.toFixed(step<0.01?4:step<0.1?2:1)}°N</text>`:''}`; }
    for(let lo=Math.ceil((this.view.cLon-this.view.span)/step)*step; lo<this.view.cLon+this.view.span; lo+=step){ const x=P({lat:this.view.cLat,lon:lo})[0]; if(x<0||x>W) continue; h+=`<line y1="0" y2="${H}" x1="${x}" x2="${x}" stroke="var(--grid)" stroke-width=".6" stroke-dasharray="2 4"/>${this.opts.labels!==false?`<text x="${x+3}" y="${H-6}" font-size="10">${lo.toFixed(step<0.01?4:step<0.1?2:1)}°E</text>`:''}`; }
    // river
    h+=`<path d="${path(RIVER)}" fill="none" stroke="var(--river)" stroke-width="${clamp(40/this.mPerPx(),4,26)}" stroke-linecap="round" stroke-linejoin="round" opacity=".75"/>`;
    const mouth=P(PLACES.MOUTH); if(this.opts.labels!==false){ const t=P({lat:5.4095,lon:100.3175}); h+=`<text x="${t[0]}" y="${t[1]-14}" font-size="11" font-style="italic">Sungai Pinang</text><text x="${mouth[0]+24}" y="${mouth[1]+30}" font-size="11" font-style="italic">Penang Strait</text>`; }
    // data layers
    this.hits=[];
    for(const L of this.layers){
      if(L.t==='line'){ h+=`<path d="${path(L.pts)}" fill="none" stroke="${L.color}" stroke-width="${L.w||2}" ${L.dash?`stroke-dasharray="${L.dash}"`:''} opacity="${L.op??1}" stroke-linejoin="round"/>`; }
      else if(L.t==='halo'){ const [x,y]=P(L.p); const r=L.rm/this.mPerPx(); const i=this.hits.push(L)-1; h+=`<circle data-i="${i}" cx="${x}" cy="${y}" r="${Math.max(r,8)}" fill="${L.fill}" fill-opacity="${L.op??.18}" stroke="${L.fill}" stroke-width="1.2" stroke-dasharray="3 3" style="cursor:pointer"/>`; }
      else if(L.t==='label'){ const [x,y]=P(L.p); const up=L.pos==='above', lf=L.pos==='left'; h+=`<text x="${up?x-6:lf?x-9:x+9}" y="${up?y-10:y+4}" text-anchor="${up||lf?'end':'start'}" font-size="11" font-weight="600" style="fill:var(--fg);paint-order:stroke;stroke:var(--land);stroke-width:3px">${esc(L.text)}</text>`; }
      else if(L.t==='dot'){ const [x,y]=P(L.p); if(x<-20||y<-20||x>W+20||y>H+20) continue; const r=L.r||4; const i=this.hits.push(L)-1; const a=`data-i="${i}" fill="${L.fill}" stroke="${L.stroke||'none'}" stroke-width="${L.sw||1}" ${L.click||L.tip?'style="cursor:pointer"':''}`;
        if(L.shape==='square') h+=`<rect ${a} x="${x-r}" y="${y-r}" width="${2*r}" height="${2*r}"/>`;
        else if(L.shape==='diamond') h+=`<path ${a} d="M${x} ${y-r-1}L${x+r+1} ${y}L${x} ${y+r+1}L${x-r-1} ${y}Z"/>`;
        else if(L.shape==='tri') h+=`<path ${a} d="M${x} ${y-r-2}L${x+r+1} ${y+r}L${x-r-1} ${y+r}Z"/>`;
        else if(L.shape==='ring') h+=`<circle ${a.replace(/fill="[^"]*"/,'fill="transparent"')} cx="${x}" cy="${y}" r="${r}" stroke-width="2.5"/><circle cx="${x}" cy="${y}" r="2" fill="${L.stroke}"/>`;
        else if(L.shape==='boat'){ const hd=L.heading||0; const dx=Math.sin(hd), dy=-Math.cos(hd); h+=`<circle cx="${x}" cy="${y}" r="${r+6}" fill="var(--accent)" fill-opacity=".18"/><circle ${a} cx="${x}" cy="${y}" r="${r}"/><line x1="${x}" y1="${y}" x2="${x+dx*(r+9)}" y2="${y+dy*(r+9)}" stroke="var(--accent)" stroke-width="2"/>`; }
        else h+=`<circle ${a} cx="${x}" cy="${y}" r="${r}"/>`; }
    }
    svg.innerHTML=h;
  }
  bindPanZoom(){
    const svg=this.svg; let drag=null;
    svg.addEventListener('wheel',e=>{ e.preventDefault(); const f=e.deltaY>0?1.2:1/1.2; this.view.span=clamp(this.view.span*f,0.003,0.12); this.drawSVG(); },{passive:false});
    svg.addEventListener('pointerdown',e=>{ drag={x:e.clientX,y:e.clientY,v:{...this.view},moved:false}; svg.setPointerCapture(e.pointerId); });
    svg.addEventListener('pointermove',e=>{
      if(drag){ const dx=e.clientX-drag.x, dy=e.clientY-drag.y; if(Math.abs(dx)+Math.abs(dy)>3) drag.moved=true; if(drag.moved){ const W=this.el.clientWidth; const k=W/this.view.span; this.view.cLon=drag.v.cLon-dx/k; this.view.cLat=drag.v.cLat+dy/(k/Math.cos(this.view.cLat*Math.PI/180)); this.drawSVG(); } return; }
      const t=e.target.closest('[data-i]'); const L=t&&this.hits[+t.dataset.i];
      if(L&&L.tip){ const r=this.el.getBoundingClientRect(); this.tip.innerHTML=L.tip; this.tip.hidden=false; this.tip.style.left=Math.min(e.clientX-r.left+12, r.width-250)+'px'; this.tip.style.top=(e.clientY-r.top+12)+'px'; } else this.tip.hidden=true;
    });
    svg.addEventListener('pointerleave',()=>{ if(this.tip) this.tip.hidden=true; });
    svg.addEventListener('pointerup',e=>{ const was=drag; drag=null; if(was&&was.moved) return; const t=e.target.closest('[data-i]'); const L=t&&this.hits[+t.dataset.i]; if(L&&L.click) L.click(); });
  }
  /* ---------- Leaflet + OpenStreetMap ---------- */
  renderLeaflet(){
    if(this.kind!=='leaflet'){ this.teardown(); this.kind='leaflet'; this.el.innerHTML='';
      if(getComputedStyle(this.el).position==='static') this.el.style.position='relative';
      const host=document.createElement('div'); host.style.cssText='position:absolute;inset:0'; this.el.appendChild(host);
      this.lm=L.map(host,{zoomControl:this.opts.legend!==false, preferCanvas:true, attributionControl:true});
      this.lm.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
      if(this.focus) this.focusOn(this.focus.lat,this.focus.lon,this.focus.span);
      else { const b=this.bounds(); this.lm.fitBounds([[b.la0,b.lo0],[b.la1,b.lo1]]); }
      const tl=L.tileLayer(CFG.tileUrl,{maxZoom:19, attribution:CFG.tileAttr});
      tl.on('tileload',()=>{ MapView.tileLoads++; });
      tl.on('tileerror',()=>{ if(++MapView.tileErrors>=6 && !MapView.tileLoads && !MapView.tilesFailed){ MapView.tilesFailed=true; MapView.all.forEach(m=>m.kind==='leaflet'&&m.el.isConnected&&m.render()); toast('OpenStreetMap tiles could not load here: switched to the schematic basemap'); } });
      tl.addTo(this.lm);
      this.lg=L.layerGroup().addTo(this.lm);
      this.addLegend();
      new ResizeObserver(()=>this.lm&&this.lm.invalidateSize()).observe(this.el);
    }
    this.lg.clearLayers();
    for(const Ly of this.layers){
      let o=null;
      if(Ly.t==='line') o=L.polyline(Ly.pts.map(p=>[p.lat,p.lon]),{color:Ly.color,weight:Ly.w||2,dashArray:Ly.dash,opacity:Ly.op??1,interactive:false});
      else if(Ly.t==='halo') o=L.circle([Ly.p.lat,Ly.p.lon],{radius:Ly.rm,color:Ly.fill,fillColor:Ly.fill,fillOpacity:Ly.op??.18,weight:1.2,dashArray:'3 3'});
      else if(Ly.t==='dot'){
        if(!Ly.shape||Ly.shape==='circle') o=L.circleMarker([Ly.p.lat,Ly.p.lon],{radius:Ly.r||4,color:Ly.stroke||Ly.fill,fillColor:Ly.fill,fillOpacity:1,weight:Ly.stroke?(Ly.sw||1):0});
        else { const sz=(Ly.r||5)*2+ (Ly.shape==='boat'?26:8); o=L.marker([Ly.p.lat,Ly.p.lon],{icon:L.divIcon({className:'at-ico',html:MapView.iconSVG(Ly,sz),iconSize:[sz,sz],iconAnchor:[sz/2,sz/2]}), keyboard:false, zIndexOffset:Ly.shape==='boat'?1000:0}); }
      }
      else if(Ly.t==='label') o=L.tooltip({permanent:true,direction:Ly.pos==='above'?'top':Ly.pos==='left'?'left':'right',className:'lbl',offset:Ly.pos==='above'?[0,-6]:Ly.pos==='left'?[-8,0]:[8,0]}).setLatLng([Ly.p.lat,Ly.p.lon]).setContent(esc(Ly.text));
      if(!o) continue;
      if(Ly.tip && o.bindTooltip) o.bindTooltip(Ly.tip,{direction:'top',offset:[0,-6]});
      if(Ly.click && o.on) o.on('click',Ly.click);
      this.lg.addLayer(o);
    }
  }
  static iconSVG(L_, sz){
    const c=sz/2, r=L_.r||5, f=L_.fill, st=L_.stroke||'none', sw=L_.sw||1;
    let b='';
    if(L_.shape==='square') b=`<rect x="${c-r}" y="${c-r}" width="${2*r}" height="${2*r}" fill="${f}" stroke="${st}" stroke-width="${sw}"/>`;
    else if(L_.shape==='diamond') b=`<path d="M${c} ${c-r-1}L${c+r+1} ${c}L${c} ${c+r+1}L${c-r-1} ${c}Z" fill="${f}" stroke="${st}" stroke-width="${sw}"/>`;
    else if(L_.shape==='tri') b=`<path d="M${c} ${c-r-2}L${c+r+1} ${c+r}L${c-r-1} ${c+r}Z" fill="${f}" stroke="${st}" stroke-width="${sw}"/>`;
    else if(L_.shape==='ring') b=`<circle cx="${c}" cy="${c}" r="${r}" fill="${f==='none'?'transparent':f}" stroke="${st}" stroke-width="2.5"/><circle cx="${c}" cy="${c}" r="2" fill="${st}"/>`;
    else if(L_.shape==='boat'){ const hd=L_.heading||0, dx=Math.sin(hd), dy=-Math.cos(hd); b=`<circle cx="${c}" cy="${c}" r="${r+6}" fill="${f}" fill-opacity=".2"/><circle cx="${c}" cy="${c}" r="${r}" fill="${f}" stroke="${st}" stroke-width="${sw}"/><line x1="${c}" y1="${c}" x2="${c+dx*(r+9)}" y2="${c+dy*(r+9)}" stroke="${f}" stroke-width="2.5"/>`; }
    return `<svg width="${sz}" height="${sz}" viewBox="0 0 ${sz} ${sz}">${b}</svg>`;
  }
  teardown(){ if(this.lm){ this.lm.remove(); this.lm=null; } this.el.innerHTML=''; }
}
