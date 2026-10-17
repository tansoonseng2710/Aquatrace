/* AquaTrace: where the online ML model lives.
   The ML API runs on Vercel (project aquatrace-ml-api, built from ml_api/ on the main branch).
   Check it any time: https://aquatrace-ml-api.vercel.app/health  ->  "status":"ok"
   Set this to '' to use only the ML API on this laptop (http://localhost:7860, run_ml_api_local.bat).
   The Settings page can override this address for one browser. */
window.AQUATRACE_ML_API = 'https://aquatrace-ml-api.vercel.app';
