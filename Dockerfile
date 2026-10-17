# AquaTrace API + dashboard in one image.
#   docker build -t aquatrace .
#   docker run -p 8000:8000 aquatrace
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app

COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

COPY backend/app backend/app
COPY backend/tests backend/tests
COPY frontend/index.html frontend/index.html
COPY frontend/vendor frontend/vendor
COPY tools tools

WORKDIR /app/backend
RUN mkdir -p /data/models
ENV MODEL_DIR=/data/models \
    DATABASE_URL=sqlite:////data/aquatrace.db

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/api/health')"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
