# AquaTrace: website + online ML model

The screening model (random forest, 5 medicines) runs as a small web service, the **ML API** (folder `ml_api/`).
The website (folder `frontend/`) asks it for every screening score. If the API cannot be reached, the website
uses the copy of the same model saved in `frontend/models/` and says so in the top bar ("Model: offline copy").

```
 sensor readings ──► website (GitHub Pages or laptop) ──► ML API (Vercel or laptop) ──► P(high), "send to lab?", level range
```

---

## Part 1 · Run everything on this laptop (for a venue without internet)

1. Open the folder `C:\projects\water_zoomed-main` and double-click **`start_local.bat`**.
   Two windows open:
   - **AquaTrace ML API**: the first time it installs FastAPI (needs internet once, about 1 minute), then shows
     `Uvicorn running on http://127.0.0.1:7860`. If FastAPI cannot be installed, it says so and starts in
     **basic mode** instead (`AquaTrace ML API (basic mode) at http://localhost:7860`): same model, same answers,
     nothing to install; only the `/docs` test page is missing.
   - **AquaTrace website**: serves the website on http://localhost:5500.
2. The browser opens the **Estimation model** page. While the ML API is still starting, the page uses the saved
   copy and checks again every 10 seconds; it switches to the API by itself. Check:
   - top bar: green **Model: online**;
   - panel **Online ML API**: *Online · Connected to https://aquatrace-ml-api.vercel.app* (with internet), or
     *Connected to http://localhost:7860* (no internet: the laptop API takes over).
3. Try it:
   - **Ask the online model** → *Use latest boat reading* → *Ask the model*: one row per medicine with P(high),
     an alert (🔴 **red** = send to lab · 🟠 **amber** = watch, take a second reading · green = no test needed),
     level range and confidence.
   - *Check the online model on 5,248 testing-set lab results* → expect
     **5,248 of 5,248 … same as Colab ✓** (red alerts: TP 117 · FP 251 · FN 332 · TN 4,548).
   - **Which algorithm? 7 compared**: random forest is marked *chosen*; the dummy that never flags anything has
     the highest accuracy (91%) and finds nothing, which is why we choose by mAP.
   - The API's own test page: http://localhost:7860/docs → `POST /predict` → *Try it out* → *Execute*
     (FastAPI mode only; in basic mode open http://localhost:7860/health).
4. To stop: close the two windows.

---

## Part 2 · The online ML model (live on Vercel)

The ML API is online at **https://aquatrace-ml-api.vercel.app** and the public website
(https://tansoonseng2710.github.io/Aquatrace/) uses it. Nothing needs to run on the laptop.

```
 website (GitHub Pages, gh-pages branch) ──► ML API (Vercel, built from ml_api/ on main) ──► P(high), "send to lab?", level
```

**Check it:** open https://aquatrace-ml-api.vercel.app/health → `"status":"ok"` and 5 models.
`/docs` is the interactive test page.

**How it is set up** (already done, for reference):
- Vercel project `aquatrace-ml-api` (team *Tan Soon Seng's projects*, Hobby plan), linked to GitHub
  `tansoonseng2710/Aquatrace`, branch `main`, **Root Directory = `ml_api`**.
- `ml_api/vercel.json` runs `app.py` as one Python function for every path. Without it, Vercel's automatic
  FastAPI detection produced an empty deployment (every page 404).
- The root `.vercelignore` must not list `ml_api/`, or the ML API deployment is empty.
- `frontend/ml_api_config.js` holds the address: `window.AQUATRACE_ML_API = 'https://aquatrace-ml-api.vercel.app';`
  (same file on the `gh-pages` branch, which GitHub Pages serves).

**Is it online 24/7?** Yes. Vercel functions do not go to sleep like a free Render service. After a quiet
period the first request takes about 1–2 seconds longer (a "cold start"); the website waits and retries on its own.
The free Hobby plan allows far more requests than a hackathon needs.

**Only for this browser:** website → **Settings → Online ML model** → paste another address → **Connect**.

### Backup host: Render
render.com → **New → Web Service** → pick the repository, Root Directory `ml_api` → Render finds the `Dockerfile` →
instance type **Free** → **Create**. A free Render service sleeps after 15 minutes without visitors and needs about
1 minute to wake, so open `/health` a few minutes before a demo.

---

## Update the model later
1. Re-run the Colab notebook; it downloads `aquatrace_website_models.zip`.
2. Replace `ml_api/aquatrace_colab_model.json` in the GitHub repository (**Add file → Upload files → Commit**
   on the `main` branch). Vercel redeploys the ML API on its own; the website picks up the new model on the next reload.
3. Also copy the new files into `frontend/models/` and `ml_api/` on the laptop, so the offline copy matches.

## If something goes wrong

| What you see | What to do |
|---|---|
| Top bar says **Model: offline copy** | The API is not running or not reachable. Start `run_ml_api_local.bat`, or open the online address `/health` in the browser to check it. |
| ML API window: *Python was not found* | Install Anaconda or Python 3.10+, then run it again. |
| ML API window: *FastAPI could not be installed … basic mode* | Nothing to fix: basic mode gives the same answers. For the `/docs` page, connect to the internet and run it again. |
| ML API window closes at once, or *Python was not found* | Open `run_ml_api_local.bat` from a Command Prompt to read the message; install Anaconda or Python 3.10+ if needed. |
| ML API window: *address already in use* | It is already running in another window. Close the extra window. |
| Online address shows *404: NOT_FOUND* | Vercel → aquatrace-ml-api → Settings → Build and Deployment: Root Directory must be `ml_api`; `ml_api/vercel.json` must exist; the root `.vercelignore` must not list `ml_api/`. Then Deployments → Redeploy. |
| Online address works, website still offline | The address must start with `https://` and must not end in `/docs`. Press **Reconnect** on the Estimation model page. |

## Before the pitch
1. Open the website; the top bar must show green **Model: online**.
2. Press **Ask the model** once and **Check the online model…** once, so the judges can see it live.
3. No internet at the venue? The website still works with the saved copy (top bar: *Model: offline copy*),
   and `start_local.bat` runs both the website and the ML API on the laptop with no internet after the first install.
