# AquaTrace ML API: works on Hugging Face Spaces (port 7860), Render, Railway or any Docker host ($PORT).
FROM python:3.11-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PORT=7860
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py aquatrace_model.py aquatrace_colab_model.json evaluation.json ./
EXPOSE 7860
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT}"]
