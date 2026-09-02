# RAYAN CMMS — Render deployment

This deployment keeps the Flutter project untouched but does not build or serve it.
Render runs the Web UI and FastAPI from the same Docker container.

## 1. Create PostgreSQL on Render
Create a PostgreSQL database in the Render dashboard.
Copy its **Internal Database URL** and use it as the `DATABASE_URL` environment variable of the Web Service.

## 2. Create the Web Service
Connect the GitHub repository containing this project.
Choose **Docker**. The repository root contains the deployment `Dockerfile`.

Recommended environment variables:

- `DATABASE_URL` = Internal Database URL from Render PostgreSQL
- `JWT_SECRET` = a long random secret (Render can generate it)
- `ALLOW_DEMO_SEED` = `false`
- `BOOTSTRAP_USERNAME` = your initial System Developer username
- `BOOTSTRAP_PASSWORD` = your initial System Developer password
- `BOOTSTRAP_FULL_NAME` = your name / system developer name
- `BOOTSTRAP_RESET_PASSWORD` = `false`

`PORT` is supplied by Render automatically. The container uses it.

## 3. Verify
After deployment open:

- `/health` → should return `{"status":"ok","version":"2.0.0"}`
- `/` → Web login page

The browser Web UI uses the same origin as the FastAPI server in production, so it does not depend on `localhost:8000`.

## Security
Do not commit `backend/.env` or production passwords/secrets. Use Render Environment Variables.
