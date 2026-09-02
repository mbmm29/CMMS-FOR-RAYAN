# Mechanical Maintenance CMMS — V2 upgrade

This project keeps the original V1 stack (FastAPI + PostgreSQL + Flutter) and extends it with the approved CMMS requirements.

## Backend modules
- Authentication / JWT
- RBAC: System Developer, Maintenance Engineer, Technician, Administrator / Viewer
- Company/Plant/Line foundation
- Equipment and automatically numbered Components
- Daily Reports with Maintenance Type, start/end time and free-text Spare Parts
- Engineer approval and report locking
- Automatic Machine Record creation from Daily Report
- Work Orders and PM/Corrective matching
- PM automation one day before due date; overdue PM keeps the same WO
- SOP and ISO Document Control
- Notifications
- Audit Trail
- KPI engine and Dashboard

## Important development note
The database uses PostgreSQL in Docker. `Base.metadata.create_all()` creates missing tables but does not migrate existing tables. Before testing this V2 schema on a disposable development database, use `docker compose down -v` to recreate the PostgreSQL volume. If the existing database contains production data, back it up first and use a proper migration before applying the new schema.

## Run backend
```powershell
cd backend
Copy-Item .env.example .env
# Edit .env: set POSTGRES_PASSWORD and JWT_SECRET to long, unique values.
docker compose up --build
```
API: http://localhost:8000/docs

Demo data is disabled by default. For local development only, set
`ALLOW_DEMO_SEED=true` in `backend/.env`, restart the API, then seed once:
POST http://localhost:8000/seed

Demo accounts:
- developer / developer123
- engineer / engineer123
- technician / technician123
- viewer / viewer123

## Run Flutter
```powershell
cd flutter_app
flutter pub get
flutter run -d chrome
```

If the Flutter app is not running on the same machine as the API, change `apiBaseUrl` in `flutter_app/lib/config.dart`.

## Render deployment
The repository root now contains `Dockerfile`, `.dockerignore`, `render.yaml`, and `RENDER_DEPLOY.md` for deploying the Web UI + FastAPI service. The Flutter project is intentionally retained but is not built or served by Render.
