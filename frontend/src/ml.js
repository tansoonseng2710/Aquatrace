/* ============================================================
   AquaTrace — machine learning (in-browser; mirrors backend sklearn pipeline)
   Ridge regression (standardised) and random forest regression,
   5-fold CV, out-of-fold permutation importance, tree-spread uncertainty,
   applicability-domain check.
   ============================================================ */
function standardizer(X){ const p=X[0].length; const mu=[],sg=[]; for(let j=0;j<p;j++){ const c=X.map(r=>r[j]); mu.push(mean(c)); sg.push(sd(c)||1); } return {mu,sg,t:r=>r.map((v,j)=>(v-mu[j])/sg[j])}; }
function solve(A,b){ const n=A.length; const M=A.map((r,i)=>[...r,b[i]]); for(let c=0;c<n;c++){ let p=c; for(let r=c+1;r<n;r++) if(Math.abs(M[r][c])>Math.abs(M[p][c])) p=r; [M[c],M[p]]=[M[p],M[c]]; const d=M[c][c]||1e-12; for(let r=0;r<n;r++){ if(r===c) continue; const f=M[r][c]/d; for(let k=c;k<=n;k++) M[r][k]-=f*M[c][k]; } } return M.map((r,i)=>r[n]/(r[i]||1e-12)); }
function fitRidge(X,y,lambda=1){
  const st=standardizer(X); const Z=X.map(st.t); const p=Z[0].length; const ym=mean(y);
  const A=Array.from({length:p},(_,i)=>Array.from({length:p},(_,j)=>Z.reduce((s,r)=>s+r[i]*r[j],0)+(i===j?lambda:0)));
  const b=Array.from({length:p},(_,i)=>Z.reduce((s,r,k)=>s+r[i]*(y[k]-ym),0));
  const w=solve(A,b);
  return {type:'ridge', st, w, ym, predict:x=>{ const z=st.t(x); return ym+z.reduce((s,v,j)=>s+v*w[j],0); }, spread:()=>0};
}
function buildTree(X,y,idx,depth,opt){
  const n=idx.length; const m=mean(idx.map(i=>y[i]));
  if(depth>=opt.maxDepth || n<2*opt.minLeaf) return {v:m};
  const p=X[0].length; const feats=[]; const pool=[...Array(p).keys()];
  while(feats.length<opt.mtry && pool.length){ const k=Math.floor(RNG()*pool.length); feats.push(pool.splice(k,1)[0]); }
  let best=null; let tot=0,tot2=0; for(const i of idx){tot+=y[i]; tot2+=y[i]*y[i];}
  const parentSSE = tot2 - tot*tot/n;
  for(const f of feats){
    const srt=[...idx].sort((a,b)=>X[a][f]-X[b][f]); let ls=0,ls2=0;
    for(let k=0;k<n-1;k++){ const yi=y[srt[k]]; ls+=yi; ls2+=yi*yi; const nl=k+1, nr=n-nl;
      if(nl<opt.minLeaf || nr<opt.minLeaf) continue; if(X[srt[k]][f]===X[srt[k+1]][f]) continue;
      const rs=tot-ls, rs2=tot2-ls2; const sse=(ls2-ls*ls/nl)+(rs2-rs*rs/nr);
      if(!best || sse<best.sse) best={sse,f,thr:(X[srt[k]][f]+X[srt[k+1]][f])/2};
    }
  }
  if(!best || best.sse>=parentSSE-1e-15) return {v:m};
  const L=idx.filter(i=>X[i][best.f]<=best.thr), R=idx.filter(i=>X[i][best.f]>best.thr);
  return {f:best.f, t:best.thr, l:buildTree(X,y,L,depth+1,opt), r:buildTree(X,y,R,depth+1,opt)};
}
function treePred(t,x){ while(t.v===undefined) t = x[t.f]<=t.t ? t.l : t.r; return t.v; }
function fitRF(X,y,opt={}){
  const o={nTrees:120, maxDepth:7, minLeaf:3, mtry:Math.max(1,Math.ceil(X[0].length/2)), ...opt}; const trees=[]; const n=X.length;
  for(let t=0;t<o.nTrees;t++){ const idx=Array.from({length:n},()=>Math.floor(RNG()*n)); trees.push(buildTree(X,y,idx,0,o)); }
  const preds = x => trees.map(t=>treePred(t,x));
  return {type:'rf', trees, predict:x=>mean(preds(x)), spread:x=>sd(preds(x))};
}
// One decision tree on all the data (no bootstrap): easy to read, but jumpy.
function fitTree(X,y){ const t=buildTree(X,y,[...Array(X.length).keys()],0,{maxDepth:6,minLeaf:3,mtry:X[0].length}); return {type:'tree', tree:t, predict:x=>treePred(t,x), spread:()=>0}; }
// K-nearest neighbours: average of the k most similar past samples (standardised inputs).
function fitKNN(X,y,k=7){ const st=standardizer(X), Z=X.map(st.t), kk=Math.min(k,X.length);
  const nb=x=>{ const z=st.t(x); return Z.map((r,i)=>({d:r.reduce((s,v,j)=>s+(v-z[j])**2,0), y:y[i]})).sort((a,b)=>a.d-b.d).slice(0,kk).map(o=>o.y); };
  return {type:'knn', predict:x=>mean(nb(x)), spread:x=>sd(nb(x))}; }
// Gradient boosting: small trees added one by one, each fitted to what the previous ones still get wrong.
function fitGB(X,y,opt={}){ const o={rounds:100, lr:0.1, maxDepth:3, minLeaf:3, ...opt}; const f0=mean(y), idx=[...Array(X.length).keys()], to={maxDepth:o.maxDepth,minLeaf:o.minLeaf,mtry:X[0].length};
  const trees=[]; let pred=new Array(y.length).fill(f0);
  for(let m=0;m<o.rounds;m++){ const r=y.map((v,i)=>v-pred[i]); const t=buildTree(X,r,idx,0,to); trees.push(t); pred=pred.map((p,i)=>p+o.lr*treePred(t,X[i])); }
  return {type:'gb', trees, predict:x=>f0+o.lr*trees.reduce((s,t)=>s+treePred(t,x),0), spread:()=>0}; }
const ALGO_NAMES = {rf:'Random forest', gb:'Gradient boosting', ridge:'Ridge (linear) regression', knn:'K-nearest neighbours', tree:'Decision tree'};
const fitModel = (type,X,y) => type==='ridge' ? fitRidge(X,y,1.0) : type==='tree' ? fitTree(X,y) : type==='knn' ? fitKNN(X,y) : type==='gb' ? fitGB(X,y) : fitRF(X,y);

function trainModel(comp, type, feats){
  RNG = mulberry32(1234);   // reproducible training
  const P = pairs(comp).map(h=>{ const s={...h.match.sensors}; s.hour_sin=Math.sin(2*Math.PI*new Date(h.ts).getHours()/24); s.hour_cos=Math.cos(2*Math.PI*new Date(h.ts).getHours()/24); s.lat=h.lat; s.lon=h.lon; return {h, x:featVec(s,feats), y:h.conc}; })
              .filter(p=>p.x.every(v=>isFinite(v)));
  const n=P.length; if(n<12) return {error:`Only ${n} paired samples for ${S.compounds[comp]?.name||comp}. At least 12 are needed to train; 30+ recommended.`, n};
  const X=P.map(p=>p.x), y=P.map(p=>p.y);
  // 5-fold CV
  const order=[...Array(n).keys()].sort(()=>RNG()-0.5); const K=Math.min(5,n); const folds=Array.from({length:K},(_,k)=>order.filter((_,i)=>i%K===k));
  const oof=new Array(n).fill(0), oofUV=new Array(n).fill(0), imp=new Array(feats.length).fill(0);
  const uvIdx = feats.indexOf('uv');
  for(const test of folds){
    const trainI=order.filter(i=>!test.includes(i));
    const m=fitModel(type, trainI.map(i=>X[i]), trainI.map(i=>y[i]));
    const base=test.map(i=>m.predict(X[i])); test.forEach((i,k)=>oof[i]=base[k]);
    const mse0=mean(test.map((i,k)=>(y[i]-base[k])**2));
    for(let j=0;j<feats.length;j++){
      const perm=test.map(i=>X[i][j]).sort(()=>RNG()-0.5);
      const mse=mean(test.map((i,k)=>{ const x=[...X[i]]; x[j]=perm[k]; return (y[i]-m.predict(x))**2; }));
      imp[j]+=Math.max(0,mse-mse0);
    }
    if(uvIdx>=0){ const lf=linfit(trainI.map(i=>X[i][uvIdx]), trainI.map(i=>y[i])); test.forEach(i=>oofUV[i]=lf.a+lf.b*X[i][uvIdx]); }
  }
  const resid=y.map((v,i)=>v-oof[i]);
  const rmse=Math.sqrt(mean(resid.map(r=>r*r))), mae=mean(resid.map(Math.abs)), r2=r2score(y,oof);
  const final=fitModel(type,X,y); const fitR2=r2score(y,X.map(x=>final.predict(x)));
  const impTot=imp.reduce((a,b)=>a+b,0)||1;
  const ranges=feats.map((_,j)=>{ const c=X.map(r=>r[j]); return [Math.min(...c), Math.max(...c)]; });
  const corr=feats.map((f,j)=>({f, r:pearson(X.map(r=>r[j]),y), rho:spearman(X.map(r=>r[j]),y)}));
  const res = {comp, type, feats, n, r2, rmse, mae, fitR2, r2UV: uvIdx>=0? r2score(y,oofUV): null, bias:mean(resid),
    importance:feats.map((f,j)=>({f, v:imp[j]/impTot})).sort((a,b)=>b.v-a.v), corr, ranges,
    oof:P.map((p,i)=>({y:p.y, yhat:oof[i], id:p.h.sample_id, below:p.h.below})), X, y, final, trainedAt:Date.now(), yMax:Math.max(...y)};
  return res;
}
function predictWithUncertainty(m, x){
  if(m.external){   // Colab model: level in log space, plus a screening probability
    const lg=m.final.logs(x), ml=mean(lg), sp=sd(lg), s=Math.sqrt(sp*sp+m.rmseLog*m.rmseLog);
    const mu=Math.pow(10,ml)*m.fac, lo=Math.pow(10,ml-1.96*s)*m.fac, hi=Math.pow(10,ml+1.96*s)*m.fac;
    const p=m.final.screen(x), flag=p>=m.pThr;
    const outside=m.feats.filter((f,j)=>{ const [a,b]=m.ranges[j]; const pad=0.1*(b-a||Math.abs(a)*0.1||1); return x[j]<a-pad || x[j]>b+pad; });
    const auc=m.screenHold?.auc ?? 0; let conf=auc>=0.85?'High':auc>=0.7?'Medium':'Low'; const reasons=[`screening AUC on held-out sites is ${auc.toFixed(2)}`];
    if(outside.length){ conf='Low'; reasons.push('outside calibration range: '+outside.map(f=>PARAMS[f]?.short||PARAMS[f]?.label||f).join(', ')); }
    return {mu, lo, hi, conf, reasons, outside, p, flag};
  }
  const mu = Math.max(0, m.final.predict(x)); const sp = m.final.spread(x);
  const hw = 1.96*Math.sqrt(sp*sp + m.rmse*m.rmse);
  const outside = m.feats.filter((f,j)=>{ const [a,b]=m.ranges[j]; const pad=0.1*(b-a||Math.abs(a)*0.1||1); return x[j]<a-pad || x[j]>b+pad; });
  const rel = hw/Math.max(mu, 1e-9);
  let conf = rel<0.5 ? 'High' : rel<1.0 ? 'Medium' : 'Low';
  const reasons=[];
  if(m.r2<0.5){ conf='Low'; reasons.push(`cross-validated R² is ${m.r2.toFixed(2)}`); }
  else if(m.r2<0.7 && conf==='High'){ conf='Medium'; reasons.push(`cross-validated R² is ${m.r2.toFixed(2)}`); }
  if(outside.length){ conf='Low'; reasons.push('outside calibration range: '+outside.map(f=>PARAMS[f]?.short||PARAMS[f]?.label||EXTRA_FEATS[f]||f).join(', ')); }
  if(rel>=1.0) reasons.push(mu<(m.yMax||1)*0.15?'uncertainty range is wide because the level is near background':'uncertainty range is wide compared with the estimate');
  return {mu, lo:Math.max(0,mu-hw), hi:mu+hw, conf, reasons, outside};
}
function trainAll(){ for(const c of Object.keys(S.compounds)){ const r=trainModel(c, c===CFG.target? (S.models[c]?.type||'rf') : 'rf', S.models[c]?.feats || CFG.feats); S.models[c] = r.error? null : r; } }

/* ---------- models trained outside the browser (Google Colab model packages) ---------- */
// Trees arrive as arrays: [feature, threshold, left, right] for a split, [value] for a leaf.
// Split rule matches scikit-learn: x <= threshold goes left, with x rounded to 32-bit first (scikit-learn stores inputs as float32).
function treeFromArrays(nodes){ const mk=i=>{ const n=nodes[i]; return n.length===1?{v:n[0]}:{f:n[0],t:n[1],l:mk(n[2]),r:mk(n[3])}; }; return mk(0); }
function loadModelPackage(pkg){
  if(!pkg || !pkg.models || !/^aquatrace-model-package\//.test(pkg.format||'')) throw new Error('This file is not an AquaTrace model package.');
  for(const c of (pkg.compounds||[])) S.compounds[c.id]={...c, external:true};
  const loaded=[];
  for(const [id,p] of Object.entries(pkg.models)){
    if(!S.compounds[id]) S.compounds[id]={id, name:p.name, unit:p.unit, level:p.threshold, cls:'', cas:'', external:true};
    const ct=p.clf_trees.map(treeFromArrays), rt=p.reg_trees.map(treeFromArrays);
    const fac=p.ng_to_unit ?? (p.threshold/p.threshold_ngL);
    const f32=x=>x.map(v=>Math.fround(v));
    const logs=x=>{ const z=f32(x); return rt.map(t=>treePred(t,z)); };
    const final={ logs, predict:x=>Math.pow(10,mean(logs(x)))*fac, spread:x=>sd(logs(x)), screen:x=>{ const z=f32(x); return mean(ct.map(t=>treePred(t,z))); } };
    S.models[id]={comp:id, type:'rf', external:true, pkgSource:pkg.source, pkgCreated:pkg.created, feats:p.feats, n:p.n, nDetected:p.n_detected,
      nSites:p.n_sites, nHold:p.n_holdout, nHoldSites:p.n_holdout_sites, r2:p.level.r2_log_cv, rmseLog:p.level.rmse_log_cv, rmse:p.level.rmse_log_cv,
      mae:null, fitR2:null, r2UV:null, bias:0, fac, threshold:p.threshold, thresholdNg:p.threshold_ngL, pThr:p.p_threshold,
      screenCV:p.screen_cv, screenHold:p.screen_holdout, screenTrain:p.screen_train, chosen:p.chosen, split:p.split, level:p.level, importance:p.importance, corr:p.corr, ranges:p.ranges,
      oof:p.oof, yMax:Math.max(...p.oof.map(o=>o.y)), final, trainedAt:Date.parse(pkg.created)||Date.now()};
    loaded.push(id);
  }
  return loaded;
}
// One lab result checked against the model, which sees only the sensor readings taken with the sample.
function crossCheckOne(h, m){
  const s=h.match&&h.match.ok? h.match.sensors : null; if(!s) return null;
  const x=featVec(s, m.feats); if(!x.every(v=>v!=null && isFinite(v))) return null;
  const p=m.final.screen(x), flag=p>=m.pThr, labHigh=!h.below && h.conc>=m.threshold;
  const est=m.final.predict(x);
  return {p, flag, labHigh, est, verdict: flag===labHigh ? (labHigh?'both high':'both low') : (labHigh?'missed high':'false alarm')};
}
function crossCheckSummary(comp){
  const m=S.models[comp]; if(!m||!m.external) return null;
  const rows=S.hplc.filter(h=>h.compound===comp).map(h=>({h, c:crossCheckOne(h,m)})).filter(r=>r.c);
  if(!rows.length) return {comp, n:0};
  const n=rows.length, high=rows.filter(r=>r.c.labHigh).length, flagged=rows.filter(r=>r.c.flag).length, tp=rows.filter(r=>r.c.flag&&r.c.labHigh).length;
  const agree=rows.filter(r=>r.c.flag===r.c.labHigh).length;
  const det=rows.filter(r=>!r.h.below), w2=det.filter(r=>Math.abs(Math.log10(r.c.est/r.h.conc))<=Math.log10(2)).length;
  // AUC: share of (high, low) pairs where the high sample got the higher screening score
  const ph=rows.filter(r=>r.c.labHigh).map(r=>r.c.p), pl=rows.filter(r=>!r.c.labHigh).map(r=>r.c.p).sort((a,b)=>a-b);
  let auc=null; if(ph.length&&pl.length){ let s=0; for(const v of ph){ let lo=0,hi=pl.length; while(lo<hi){const mid=(lo+hi)>>1; if(pl[mid]<v) lo=mid+1; else hi=mid;} let eq=lo; while(eq<pl.length&&pl[eq]===v) eq++; s+=lo+(eq-lo)/2; } auc=s/(ph.length*pl.length); }
  return {comp, n, high, flagged, tp, agree:agree/n, hit:flagged?tp/flagged:null, base:high/n, caught:high?tp/high:null, within2x:det.length?w2/det.length:null, nDet:det.length, auc};
}
