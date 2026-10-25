# Market Masters Optimizations

## Overview

Market Masters was migrated from the original Python/MongoDB deployment model to a Supabase-native architecture with a Vercel-hosted React frontend.

## Architecture improvements

- Replaced the Python/MongoDB backend with Supabase Postgres, Supabase Auth, and a Supabase Edge Function.
- Added the `market-api` Edge Function as the central API for authentication, teams, questions, submissions, trading, leaderboards, analytics, announcements, and admin operations.
- Preserved the existing `/api/...` route contract so the frontend could be migrated with minimal page-level changes.
- Moved authentication to Supabase Auth sessions instead of custom JWT handling.
- Added a shared Supabase client and centralized API wrapper in the frontend.

## Database and security improvements

- Added normalized tables for profiles, teams, event configuration, questions, submissions, round-three sessions, trades, score overrides, leaderboard snapshots, announcements, and audit logs.
- Enabled Row Level Security on the application tables.
- Added explicit deny policies for unauthenticated and client-side direct access.
- Kept the Supabase service-role credential inside the Edge Function environment only.
- Added indexes for common team, round, question, trade-status, audit, announcement, and ordering queries.
- Added admin role checks for protected operations.
- Added explicit cleanup of child records and leaderboard snapshots when removing teams.

## Frontend improvements

- Replaced backend URL calls with Supabase Edge Function calls.
- Attached the active Supabase access token to protected API requests.
- Added Supabase Auth login, registration, session refresh, auth-state listeners, and logout handling.
- Updated admin exports to use the active authenticated session.
- Added Vercel SPA rewrites so direct navigation to `/login`, `/dashboard`, `/admin`, and other client routes works correctly.
- Added production environment templates without committing credentials.

## Cleanup

Removed obsolete project content including:

- The old MongoDB/Python backend implementation.
- Render deployment configuration.
- Backend-only dependency and test configuration.
- Unused frontend UI components and unused configuration files.
- Old test reports and deployment artifacts.
- Old frontend dependency entries that were no longer required.

Compared with the initial repository, the migration removed approximately 7,117 lines and added approximately 2,220 focused lines.

## Performance and deployment

- Added a reproducible Vercel build using the frozen Yarn lockfile.
- Production build output is approximately:
  - JavaScript: 148.64 KB gzip
  - CSS: 4.9 KB gzip
- Deployed the React frontend to Vercel.
- Deployed the API to Supabase Edge Functions.
- Configured production environment variables through Vercel rather than storing secrets in the repository.

## Verification completed

- Supabase team registration and authentication.
- Protected `/auth/me` access.
- Admin login and role authorization.
- Admin question creation.
- Round-one activation.
- Question delivery without exposing the correct answer to teams.
- Correct-answer submission and scoring.
- Admin analytics.
- Leaderboard and event configuration endpoints.
- Production frontend routes.
- Supabase API health endpoint.
- Vercel deployment status.
- Browser console error check.
- Database cleanup after test runs.

## Concurrent-load optimization

- Removed leaderboard snapshot delete/insert operations from public leaderboard reads.
- Added short-lived Edge Function caching and request coalescing for configuration and score calculations.
- Added explicit cache invalidation after scoring, trade, override, event, and configuration changes.
- Added a read-only Supabase Data API path for public event configuration and leaderboard data.
- Added RLS-protected public-read policies only for the event configuration and leaderboard snapshot data intended for public display.
- Kept authenticated writes and admin operations inside the Edge Function.
- Verified 100 concurrent public-read users with 100% success and approximately 1.1 second p95 response time.

## Current production state

- Frontend: `https://market-masters-five.vercel.app`
- Supabase Edge Function: `market-api`
- Admin account: configured and verified.
- Database: clean and ready for event data.
- GitHub: latest migration commit pushed to `main`.

## Remaining considerations

- Supabase currently reports that leaked-password protection is disabled. This is a security advisory, not an application failure.
- Authenticated write-heavy event traffic should still be monitored during the event because it remains Edge Function-backed.
