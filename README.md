# Market Masters

Market Masters is a three-round trading competition platform with a React frontend, FastAPI API, and Supabase Postgres persistence. It also supports the original Emergent MongoDB runtime as a compatibility mode.

## Requirements

- Node.js 20+
- Python 3.11+
- A Supabase project with its Postgres connection pooler URL, or the original Emergent MongoDB runtime

## Local setup

1. Create `backend/.env` from `backend/.env.example`. Set the Supabase pooler URL plus admin credentials for Supabase, or set `MONGO_URL` and `DB_NAME` for the original Emergent environment. For an event, start with the documented pool defaults and adjust them only within your Supabase connection limits.
2. If using Supabase, apply both files in `supabase/migrations/` in order. The API automatically prefers `SUPABASE_DB_URL` when both database configurations exist.
3. Install and start the API:

   ```powershell
   cd backend
   python -m venv .venv
   .\.venv\Scripts\Activate.ps1
   pip install -r requirements.txt
   uvicorn server:app --reload --port 8000
   ```

4. In a second terminal, install and start the frontend:

   ```powershell
   cd frontend
   corepack yarn install --frozen-lockfile
   corepack yarn start
   ```

The frontend runs at `http://localhost:3000` and the API health endpoint is `http://localhost:8000/api/`.

For Render deployment, use `render.yaml` and set `SUPABASE_DB_URL`, `JWT_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and `CORS_ORIGINS` as Render secrets. The supplied Emergent variables (`MONGO_URL`, `DB_NAME`, `WDS_SOCKET_PORT`, and `ENABLE_HEALTH_CHECK`) are supported for that runtime; `WDS_SOCKET_PORT` and `ENABLE_HEALTH_CHECK` are frontend-dev settings and are not required by the production build.

Do not put a Supabase personal access token in the app or frontend. PATs are for Supabase CLI/Management API operations; the backend uses the private Postgres connection string.

Demo data is disabled by default. Set `SEED_DEMO_DATA=true` and `DEMO_PASSWORD` in `backend/.env` only for local demonstrations.

## Validation

```powershell
cd frontend
corepack yarn build
```

```powershell
cd backend
python -m py_compile server.py
```

To run the repeatable API E2E test suite:

```powershell
cd backend
pip install -r requirements-dev.txt
python -m pytest -q
```

Never commit `.env`, local virtual environments, `node_modules`, or build output.
