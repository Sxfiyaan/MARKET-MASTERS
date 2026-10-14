# MARKET MASTERS: THE TRADING FLOOR — PRD

## Problem Statement
Full-stack web platform for a 3-round university finance & trading competition.
Round 1 (Quiz · 20 questions · speed scoring), Round 2 (Chart predictions · BUY/SELL/NO_TRADE),
Round 3 (1-hour trading challenge · MAX 2 trades · risk management scoring · admin verification).
Includes landing, auth, team registration, participant dashboard, admin dashboard, server-authoritative
timers, live leaderboard, audit logs, CSV exports, cinematic dark finance UI.

## Architecture
- **Frontend**: React 19 + React Router 7 + Tailwind + Sonner, JWT in localStorage (`mm_token`), axios client
- **Backend**: FastAPI (single `server.py`, modular routes under `/api`), Motor async MongoDB
- **DB**: MongoDB — collections `users`, `teams`, `questions`, `submissions`, `trades`, `round3_sessions`, `event_config`, `announcements`, `audit_logs`, `score_overrides`, `leaderboard_snapshot`
- **Auth**: Bcrypt hashing + PyJWT bearer tokens (24h); roles `admin` + `team`; admin seeded from `.env`

## Core Requirements Implemented (Oct 2026)
- Landing with hero (candlestick BG, ticker, 3-round section, rules)
- Team self-registration (duplicate team name + email blocked, config toggle `registration_open`)
- JWT login (admin + team), `/auth/me` with team join
- Round-state machine (UPCOMING/ACTIVE/PAUSED/COMPLETED) per round, admin-only
- Round 1: 20 seeded quiz Qs, speed-weighted scoring, dup block, hides answers from teams
- Round 2: 5 seeded chart Qs with asset+timeframe+image+correct BUY/SELL/NO_TRADE
- Round 3: server-authoritative 60-min timer (idempotent start), max-2-trades enforced via unique index + count check, server-side validation of PROFIT/LOSS sign relationships, pending→verified/rejected workflow with reason required for reject
- Scoring: performance (`total_pl_pct` mapped) × 60% + risk (penalties for excess risk, blown trades) × 40% → weighted into total; score overrides supported
- Live leaderboard (polled 7s) with rank_change (UP/DOWN/SAME/NEW), snapshot stored
- Admin: event control, trade verification queue, team list, config editor, audit log viewer, CSV export (teams/round1/round2/round3/leaderboard), announcements broadcast
- Audit log for every state change, submission, verification, override

## Test Credentials
- Admin: `admin@marketmasters.com` / `Admin@12345`
- Demo Team: `alpha@team.com` / `Team@12345` (Alpha Traders)

## Backlog / Next Phase
- **P1 — Lightweight charts**: swap R2 image placeholders for actual TradingView Lightweight-Charts rendering of OHLC
- **P1 — WebSockets**: push leaderboard + round-state live instead of polling
- **P1 — Trade proof upload**: wire Emergent Object Storage when `trade_proof_required=true`
- **P2 — Score override UI**: add a modal in Admin → Verify tab to call `/admin/score-override`
- **P2 — Tie-breaker config**: expose tie-breaker order from admin UI (current logic hardcoded: total → R3 → risk → R2)
- **P2 — Mobile polish**: compact admin tables; sticky mobile nav
- **P2 — Demo seed command**: `/api/admin/seed-demo` to pre-create 10 named teams for showcase mode

## Known Limitations
- Round 2 charts are static images (not interactive candlestick canvas yet)
- No rate-limiting middleware (production should add)
- Leaderboard refresh is polled every 7s (not WebSocket)
- Trade proof upload disabled by default (toggle in Admin Config)
