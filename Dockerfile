FROM python:3.12-slim
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# The published repository is flat; place Python code and web assets in the
# locations expected by the FastAPI application.
RUN mkdir -p /app/app /app/web
COPY __init__.py database.py main.py models.py schemas.py security.py /app/app/
COPY *.html *.js *.css *.jpeg *.png *.webmanifest /app/web/

EXPOSE 8000
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
