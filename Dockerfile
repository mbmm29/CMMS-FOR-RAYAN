FROM python:3.12-slim
WORKDIR /app
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/app ./app
COPY RAYAN_CMMS_WEB_HTML_CSS_JS ./web
CMD ["uvicorn","app.main:app","--host","0.0.0.0","--port","8000"]
