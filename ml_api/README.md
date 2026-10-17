# AquaTrace ML API

Online screening model for 5 medicines (micropollutants) in river water, from cheap sensor readings:
pH, temperature, conductivity, turbidity and dissolved oxygen.

- Trained in the Colab notebook on 26,073 US lab results (Water Quality Portal), split by river site
  60 / 20 / 20 into training, validation and testing.
- Random forest, chosen from 7 algorithms by 5-fold cross-validation.
- Testing set (rivers the model never saw): mAP 0.40 vs 0.12 for random picks, mean ROC-AUC 0.78,
  precision 27% vs 9% at random.
- It answers **which samples to send to the lab**. HPLC / LC-MS stays the reference.
- Pure Python (FastAPI only, no scikit-learn): the random-forest trees are read from `aquatrace_colab_model.json`
  and give exactly the Colab numbers (`python test_api.py` checks all 5,248 testing-set results).

## Endpoints

| Method | Path | What it does |
|---|---|---|
| GET | `/docs` | Interactive docs: try every endpoint in the browser |
| GET | `/health` | Is the model loaded? |
| GET | `/models` | The 5 models: sensors, "high" level, testing scores |
| GET | `/evaluation` | Confusion matrix, precision / recall / F1 vs random, mAP, algorithm comparison |
| GET | `/model-package` | The full model file (the website loads it from here) |
| POST | `/predict` | One set of readings → P(high), lab flag, level estimate per medicine |
| POST | `/predict/batch` | Up to 5,000 readings at once |

Example:

```
POST /predict
{"readings": {"ph": 7.6, "temp": 24, "conductivity": 950, "turbidity": 8.5, "do": 6.2}}
```

## Run on your laptop

Windows: double-click `run_ml_api_local.bat` in the project folder (first run installs FastAPI once).
Or by hand:

```
pip install -r requirements.txt
python -m uvicorn app:app --port 7860
```

Open http://localhost:7860/docs. Check that it matches Colab: `python test_api.py`.

**No FastAPI, no internet?** `python serve_basic.py` runs the same model and endpoints with Python's standard
library only (no `/docs` page). `run_ml_api_local.bat` switches to it automatically when FastAPI cannot be installed.

## Put it online

The files in this folder are a complete web service. Step-by-step guide: `ML_API_SETUP.md` in the project folder.

- **Vercel (free, recommended):** put these files in their own GitHub repository, then on vercel.com
  *Add New → Project → Import* that repository and press *Deploy*. Vercel finds `app.py` and its `app` on its own.
- **Render (free, sleeps after 15 min without visitors):** *New → Web Service*, pick the repository;
  Render builds the `Dockerfile`. Choose the Free instance.
- **Any Docker host:** the `Dockerfile` listens on `$PORT` (default 7860).

## Update the model

Re-run the Colab notebook, then replace `aquatrace_colab_model.json` here (and in the online repository) with the new one.
The website loads the model from this service, so the website itself does not need to change.
