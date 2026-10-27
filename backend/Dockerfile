FROM python:3.12-slim
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends poppler-utils \
    && rm -rf /var/lib/apt/lists/*
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/app ./app
COPY RAYAN_CMMS_WEB_HTML_CSS_JS ./web
EXPOSE 8000
# Render supplies PORT at runtime, while 8000 keeps the local Docker workflow
# unchanged.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
