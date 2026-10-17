# AquaTrace: website + online ML model

The screening model (random forest, 5 medicines) runs as a small web service, the **ML API** (folder `ml_api/`).
The website (folder `frontend/`) asks it for every screening score. If the API cannot be reached, the website
uses the copy of the same model saved in `frontend/models/` and says so in the top bar ("Model: offline copy").

```
 sensor readings ──► website (laptop or Vercel) ──► ML API (laptop or online) ──► P(high), "send to lab?", level range
```

---

## Part 1 · Run everything on this laptop (5 minutes)

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
   - panel **Online ML API**: *Online · Connected to http://localhost:7860*.
3. Try it:
   - **Ask the online model** → *Use latest boat reading* → *Ask the model*: one row per medicine with P(high),
     **Send to lab / No test needed**, level range and confidence.
   - *Check the online model on 5,248 testing-set lab results* → expect
     **5,248 of 5,248 … same as Colab ✓** (TP 166 · FP 445 · FN 283 · TN 4,354).
   - **Which algorithm? 7 compared**: random forest is marked *chosen*; the dummy that never flags anything has
     the highest accuracy (91%) and finds nothing, which is why we choose by mAP.
   - The API's own test page: http://localhost:7860/docs → `POST /predict` → *Try it out* → *Execute*
     (FastAPI mode only; in basic mode open http://localhost:7860/health).
4. To stop: close the two windows.

---

## Part 2 · Put the ML model online (free, about 15 minutes)

Hugging Face now charges for Docker Spaces, so we use **Vercel** (the website is already on Vercel).
You need a GitHub account and a Vercel account (sign in to Vercel with GitHub).

### A. Put the ML API on GitHub
1. github.com → **+** (top right) → **New repository** → name `aquatrace-ml-api` → **Public** → **Create repository**.
2. On the new page click **uploading an existing file**.
3. Open `C:\projects\water_zoomed-main\ml_api` and drag in these files (not a folder):
   `app.py`, `aquatrace_model.py`, `aquatrace_colab_model.json`, `evaluation.json`, `requirements.txt`,
   `.python-version`, `.vercelignore`, `Dockerfile`, `README.md` (and `test_api.py`, `serve_basic.py` if you like).
4. **Commit changes**. `app.py` must sit at the top level of the repository, not inside a folder.

### B. Deploy on Vercel
1. vercel.com → **Add New… → Project** → **Import** `aquatrace-ml-api`.
2. Keep what Vercel detects (FastAPI / Python) → **Deploy**. Wait about a minute.
3. Copy the address Vercel shows, for example `https://aquatrace-ml-api.vercel.app`.
4. Test it: open `https://aquatrace-ml-api.vercel.app/health` → you should see `"status":"ok"`.
   `…/docs` is the interactive test page.

### C. Connect the website to the online model
- **For everyone who opens the website:** open `frontend\ml_api_config.js` in Notepad and set
  `window.AQUATRACE_ML_API = 'https://aquatrace-ml-api.vercel.app';` then save and reload the website (Ctrl+F5).
- **Only for this browser:** website → **Settings → Online ML model** → paste the address → **Connect**.

The **Online ML API** panel now says *Connected to https://aquatrace-ml-api.vercel.app*. The laptop API
(`run_ml_api_local.bat`) is no longer needed: the website tries the online address first, then the laptop,
then the saved copy. You can start just `run_website_local.bat`.

### D. The public website (waterzoomed.vercel.app)
Give Phi the changed files (`frontend/index.html`, `frontend/ml_api_config.js`, `frontend/src/*`). He pushes them
to GitHub and Vercel redeploys. The public website then uses the online model too.

### Backup host: Render
render.com → **New → Web Service** → pick the `aquatrace-ml-api` repository → Render finds the `Dockerfile` →
instance type **Free** → **Create**. Address: `https://aquatrace-ml-api.onrender.com`.
A free Render service sleeps after 15 minutes without visitors and needs about 1 minute to wake, so open
`/health` a few minutes before a demo.

---

## Update the model later
1. Re-run the Colab notebook; it downloads `aquatrace_website_models.zip`.
2. Replace `aquatrace_colab_model.json` in the GitHub repository (**Add file → Upload files → Commit**).
   Vercel redeploys on its own; the website picks up the new model on the next reload.
3. Also copy the new files into `frontend/models/` and `ml_api/` on the laptop, so the offline copy matches.

## If something goes wrong

| What you see | What to do |
|---|---|
| Top bar says **Model: offline copy** | The API is not running or not reachable. Start `run_ml_api_local.bat`, or open the online address `/health` in the browser to check it. |
| ML API window: *Python was not found* | Install Anaconda or Python 3.10+, then run it again. |
| ML API window: *FastAPI could not be installed … basic mode* | Nothing to fix: basic mode gives the same answers. For the `/docs` page, connect to the internet and run it again. |
| ML API window closes at once, or *Python was not found* | Open `run_ml_api_local.bat` from a Command Prompt to read the message; install Anaconda or Python 3.10+ if needed. |
| ML API window: *address already in use* | It is already running in another window. Close the extra window. |
| Vercel: *No FastAPI entrypoint found* | `app.py` must be at the top of the repository, not in a subfolder. |
| Online address works, website still offline | The address must start with `https://` and must not end in `/docs`. Press **Reconnect** on the Estimation model page. |

## Before the pitch
1. Open the website; the top bar must show green **Model: online**.
2. Press **Ask the model** once and **Check the online model…** once, so the judges can see it live.
3. No internet at the venue? The website still works with the saved copy (top bar: *Model: offline copy*),
   and `start_local.bat` runs both the website and the ML API on the laptop with no internet after the first install.
