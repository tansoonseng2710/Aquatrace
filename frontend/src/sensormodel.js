/* ============================================================
   AquaTrace — shared synthetic sensor model (demo only).
   Used by the dashboard simulator and the phone transmitter so both
   produce readings the trained model responds to in the same way.
   se   : sewage-like load seen by the sensors (0 clean … ~2 heavy)
   sf   : sea fraction (0 river … 1 open coast)
   rain : rainfall runoff index (0 … 1)
   domU : natural organic matter unrelated to sewage (0 … 1)
   h    : local hour of day, n : noise generator (returns ~N(0,1))
   ============================================================ */
function sensorsFrom({se=0, sf=0, rain=0, domU=0.3, h=12, n=()=>0}){
  const cl=(x,a,b)=>Math.max(a,Math.min(b,x));
  return {
    ph: cl(7.25 - 0.55*se + 0.72*sf - 0.12*rain + 0.04*n(), 5.5, 9),
    orp: 322 - 205*se - 30*domU + 25*sf - 28*rain + 10*n(),
    turbidity: Math.max(0.3, (4 + 7*se + 42*rain*(1-0.5*sf)) * Math.exp(0.12*n())),
    uv: Math.max(0.01, 0.05 + 0.42*se + 0.16*domU + 0.11*rain + 0.012*Math.sin(2*Math.PI*h/24) + 0.012*n()),
    temp: 29.2 + 1.1*Math.sin(2*Math.PI*(h-9)/24) - 0.9*rain + 0.1*n(),
    conductivity: Math.max(50, (460 + 820*se)*(1-sf)*(1-0.35*rain) + 42000*sf + 25*n()),
    do: cl(6.8 - 3.1*se + 0.9*Math.sin(2*Math.PI*(h-8)/24) + 0.3*sf + 0.15*n(), 0.2, 12),
  };
}
const SENSOR_DP = {ph:2, orp:0, turbidity:1, uv:3, temp:1, conductivity:0, do:2};
/* Sea fraction for the Penang study area (east coast of George Town); 0 elsewhere. */
function seaFracAt(lat, lon){
  if(lat<5.30 || lat>5.47 || lon<100.28 || lon>100.42) return 0;
  const s=Math.max(0,Math.min(1,(lon-100.3312)/(100.3372-100.3312))); return s*s*(3-2*s);
}
