# Market Masters

Market Masters is a three-round trading competition platform built with React and Supabase. Authentication uses Supabase Auth, persistent data uses private Postgres tables with RLS enabled, and protected game/admin operations run in the `market-api` Supabase Edge Function.

## Supabase setup

The Supabase project is `qpdepehmplravgxagogt`. The native schema is defined in `supabase/migrations/202610250003_market_masters_native.sql` and the backend is the `market-api` Edge Function in `supabase/functions/market-api/index.ts`.

The function uses Supabase's server-side service key internally. It is never sent to the browser. The browser only receives the publishable key.

For the first administrator:

1. Create the admin user in Supabase Dashboard → Authentication → Users.
2. Add an Edge Function secret named `ADMIN_EMAIL` with that same email.
3. Sign in once through the app. The function creates the private admin profile automatically.

## Local frontend

Create `frontend/.env.local` from `frontend/.env.example`. The project URL and function URL are already filled in; replace only the publishable key with the browser-safe key from Supabase Dashboard → Project Settings → API:

```env
REACT_APP_SUPABASE_URL=https://qpdepehmplravgxagogt.supabase.co
REACT_APP_SUPABASE_PUBLISHABLE_KEY=sb_publishable_replace_me
REACT_APP_SUPABASE_FUNCTIONS_URL=https://qpdepehmplravgxagogt.supabase.co/functions/v1/market-api
```

Then run:

```powershell
cd frontend
corepack yarn install --frozen-lockfile
corepack yarn start
```

The frontend runs at `http://localhost:3000`. The Supabase API health endpoint is:

```text
https://qpdepehmplravgxagogt.supabase.co/functions/v1/market-api/api/
```

## Deployment

Deploy the `frontend` directory to Vercel with the three `REACT_APP_SUPABASE_*` variables above. No Render, Railway, MongoDB, private database URL, JWT secret, or Supabase personal access token is required at runtime.

Deploy updates to `supabase/functions/market-api/index.ts` through the Supabase Edge Function deployment workflow. For local function work, copy `supabase/functions/.env.example` to a local env file and provide the service-role key only through the local CLI. Keep `SUPABASE_SERVICE_ROLE_KEY` inside Supabase Function secrets only.

The old Python/MongoDB backend is intentionally no longer part of the deployment. Supabase Postgres, Auth, RLS policies, and the `market-api` Edge Function are the backend. Do not deploy `backend/` to Render or Railway.

## Validation

```powershell
cd frontend
corepack yarn build
```

Never commit `.env`, local virtual environments, `node_modules`, or build output.
