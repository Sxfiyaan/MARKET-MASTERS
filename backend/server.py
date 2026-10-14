from dotenv import load_dotenv
from pathlib import Path
ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

import os
import io
import csv
import uuid
import logging
import secrets
import bcrypt
import jwt
from datetime import datetime, timezone, timedelta
from typing import List, Optional, Literal, Any

from fastapi import FastAPI, APIRouter, HTTPException, Depends, Request, Query
from fastapi.responses import StreamingResponse
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, Field, EmailStr, ConfigDict, field_validator

# -----------------------------------------------------------------------------
# DB + App
# -----------------------------------------------------------------------------
mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

app = FastAPI(title="Market Masters API")
api = APIRouter(prefix="/api")

JWT_ALGORITHM = "HS256"
JWT_SECRET = os.environ["JWT_SECRET"]

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------
def now_utc() -> datetime:
    return datetime.now(timezone.utc)

def iso(d: Optional[datetime]) -> Optional[str]:
    return d.isoformat() if d else None

def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()

def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode(), hashed.encode())
    except Exception:
        return False

def create_token(user_id: str, role: str, minutes: int = 60 * 24) -> str:
    payload = {
        "sub": user_id,
        "role": role,
        "type": "access",
        "exp": now_utc() + timedelta(minutes=minutes),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)

def clean_doc(doc: dict) -> dict:
    if not doc:
        return doc
    doc.pop("_id", None)
    doc.pop("password_hash", None)
    return doc

async def get_current_user(request: Request) -> dict:
    auth = request.headers.get("Authorization", "")
    token = auth[7:] if auth.startswith("Bearer ") else request.cookies.get("access_token")
    if not token:
        raise HTTPException(401, "Not authenticated")
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(401, "Invalid token")
    user = await db.users.find_one({"id": payload["sub"]})
    if not user:
        raise HTTPException(401, "User not found")
    return clean_doc(user)

async def require_admin(user: dict = Depends(get_current_user)) -> dict:
    if user.get("role") != "admin":
        raise HTTPException(403, "Admin only")
    return user

async def require_team(user: dict = Depends(get_current_user)) -> dict:
    if user.get("role") != "team":
        raise HTTPException(403, "Team only")
    return user

async def audit(action: str, user: dict, details: dict | None = None):
    await db.audit_logs.insert_one({
        "id": str(uuid.uuid4()),
        "timestamp": iso(now_utc()),
        "user_id": user.get("id"),
        "user_email": user.get("email"),
        "role": user.get("role"),
        "action": action,
        "details": details or {},
    })

# -----------------------------------------------------------------------------
# Models
# -----------------------------------------------------------------------------
class RegisterTeamIn(BaseModel):
    team_name: str
    leader_name: str
    leader_email: EmailStr
    leader_phone: str
    college: str
    password: str
    members: List[str] = Field(default_factory=list)

class LoginIn(BaseModel):
    email: EmailStr
    password: str

class QuestionIn(BaseModel):
    round: Literal[1, 2]
    text: Optional[str] = None  # R1 question text or R2 question prompt
    options: Optional[List[str]] = None  # R1 options
    correct_answer: str  # R1: "A"/"B"/.. ; R2: "BUY"/"SELL"/"NO_TRADE"
    base_points: int = 100
    time_limit: int = 30  # seconds
    # R2 specifics
    asset: Optional[str] = None
    timeframe: Optional[str] = None
    chart_image_url: Optional[str] = None
    order: int = 0

class QuestionOut(QuestionIn):
    id: str

class SubmitAnswerIn(BaseModel):
    question_id: str
    answer: str
    time_taken: float  # seconds

class TradeIn(BaseModel):
    asset: str
    account_size: float
    risk_per_trade: float  # percent
    result_type: Literal["PROFIT", "LOSS"]
    profit: float = 0
    loss: float = 0
    pl_percentage: float
    proof_url: Optional[str] = None

    @field_validator("account_size")
    @classmethod
    def _acc(cls, v):
        if v <= 0:
            raise ValueError("Account size must be > 0")
        return v

class VerifyTradeIn(BaseModel):
    status: Literal["VERIFIED", "REJECTED"]
    reason: Optional[str] = None

class EventConfigIn(BaseModel):
    event_name: Optional[str] = None
    team_size: Optional[int] = None
    registration_open: Optional[bool] = None
    round1_weight: Optional[float] = None
    round2_weight: Optional[float] = None
    round3_weight: Optional[float] = None
    round3_duration_minutes: Optional[int] = None
    max_trades: Optional[int] = None
    starting_capital: Optional[float] = None
    max_risk_per_trade: Optional[float] = None
    performance_weight: Optional[float] = None
    risk_mgmt_weight: Optional[float] = None
    leaderboard_visible: Optional[bool] = None
    trade_proof_required: Optional[bool] = None
    speed_bonus_pct: Optional[float] = None  # extra fraction from speed, e.g. 0.5

class RoundStateIn(BaseModel):
    state: Literal["UPCOMING", "ACTIVE", "PAUSED", "COMPLETED"]

class AnnouncementIn(BaseModel):
    message: str

class ScoreOverrideIn(BaseModel):
    team_id: str
    round: Literal[1, 2, 3]
    new_score: float
    reason: str

# -----------------------------------------------------------------------------
# Defaults / Seed
# -----------------------------------------------------------------------------
DEFAULT_CONFIG = {
    "id": "event",
    "event_name": "Market Masters: The Trading Floor",
    "team_size": 4,
    "registration_open": True,
    "round1_weight": 30.0,
    "round2_weight": 30.0,
    "round3_weight": 40.0,
    "round3_duration_minutes": 60,
    "max_trades": 2,
    "starting_capital": 100000.0,
    "max_risk_per_trade": 2.0,
    "performance_weight": 60.0,
    "risk_mgmt_weight": 40.0,
    "leaderboard_visible": True,
    "trade_proof_required": False,
    "speed_bonus_pct": 0.5,
    "rounds": {
        "1": {"state": "UPCOMING", "started_at": None, "ended_at": None},
        "2": {"state": "UPCOMING", "started_at": None, "ended_at": None},
        "3": {"state": "UPCOMING", "started_at": None, "ended_at": None},
    },
}

SAMPLE_R1 = []
SAMPLE_R2 = []

@app.on_event("startup")
async def startup():
    # Indexes
    await db.users.create_index("email", unique=True)
    await db.users.create_index("id", unique=True)
    await db.teams.create_index("id", unique=True)
    await db.teams.create_index("team_name", unique=True)
    await db.questions.create_index([("round", 1), ("order", 1)])
    await db.submissions.create_index([("team_id", 1), ("question_id", 1)], unique=True)
    await db.trades.create_index([("team_id", 1), ("trade_number", 1)], unique=True)

    # Seed event config
    existing = await db.event_config.find_one({"id": "event"})
    if not existing:
        await db.event_config.insert_one(DEFAULT_CONFIG.copy())

    # Seed admin
    admin_email = os.environ["ADMIN_EMAIL"].lower()
    admin = await db.users.find_one({"email": admin_email})
    if not admin:
        uid = str(uuid.uuid4())
        await db.users.insert_one({
            "id": uid, "email": admin_email, "name": "Admin",
            "password_hash": hash_password(os.environ["ADMIN_PASSWORD"]),
            "role": "admin", "created_at": iso(now_utc()),
        })
    else:
        if not verify_password(os.environ["ADMIN_PASSWORD"], admin["password_hash"]):
            await db.users.update_one(
                {"email": admin_email},
                {"$set": {"password_hash": hash_password(os.environ["ADMIN_PASSWORD"])}},
            )

    # Admin seeding only (no questions seeded; organizer adds them via admin UI)

    # Seed one demo team for testing
    demo_email = "alpha@team.com"
    if not await db.users.find_one({"email": demo_email}):
        uid = str(uuid.uuid4())
        tid = str(uuid.uuid4())
        await db.users.insert_one({
            "id": uid, "email": demo_email, "name": "Alpha Lead",
            "password_hash": hash_password("Team@12345"),
            "role": "team", "team_id": tid, "created_at": iso(now_utc()),
        })
        await db.teams.insert_one({
            "id": tid, "team_name": "Alpha Traders", "leader_name": "Alpha Lead",
            "leader_email": demo_email, "leader_phone": "9999999999",
            "college": "IIM Example", "members": ["Member Two", "Member Three"],
            "owner_user_id": uid, "created_at": iso(now_utc()),
        })

# -----------------------------------------------------------------------------
# Health
# -----------------------------------------------------------------------------
@api.get("/")
async def root():
    return {"service": "Market Masters API", "ok": True}

# -----------------------------------------------------------------------------
# Auth
# -----------------------------------------------------------------------------
@api.post("/auth/register-team")
async def register_team(body: RegisterTeamIn):
    cfg = await db.event_config.find_one({"id": "event"})
    if not cfg.get("registration_open", True):
        raise HTTPException(400, "Registration is closed")
    email = body.leader_email.lower()
    if await db.users.find_one({"email": email}):
        raise HTTPException(400, "Email already registered")
    if await db.teams.find_one({"team_name": body.team_name}):
        raise HTTPException(400, "Team name already taken")

    uid = str(uuid.uuid4())
    tid = str(uuid.uuid4())
    await db.users.insert_one({
        "id": uid, "email": email, "name": body.leader_name,
        "password_hash": hash_password(body.password),
        "role": "team", "team_id": tid, "created_at": iso(now_utc()),
    })
    await db.teams.insert_one({
        "id": tid, "team_name": body.team_name, "leader_name": body.leader_name,
        "leader_email": email, "leader_phone": body.leader_phone,
        "college": body.college, "members": body.members,
        "owner_user_id": uid, "created_at": iso(now_utc()),
    })
    token = create_token(uid, "team")
    await audit("register_team", {"id": uid, "email": email, "role": "team"}, {"team_id": tid})
    return {"token": token, "user": {"id": uid, "email": email, "name": body.leader_name, "role": "team", "team_id": tid}}

@api.post("/auth/login")
async def login(body: LoginIn):
    user = await db.users.find_one({"email": body.email.lower()})
    if not user or not verify_password(body.password, user["password_hash"]):
        raise HTTPException(401, "Invalid email or password")
    token = create_token(user["id"], user["role"])
    out = clean_doc(user)
    await audit("login", out)
    return {"token": token, "user": out}

@api.get("/auth/me")
async def me(user: dict = Depends(get_current_user)):
    if user.get("role") == "team" and user.get("team_id"):
        team = await db.teams.find_one({"id": user["team_id"]})
        user["team"] = clean_doc(team) if team else None
    return user

@api.post("/auth/logout")
async def logout(user: dict = Depends(get_current_user)):
    await audit("logout", user)
    return {"ok": True}

# -----------------------------------------------------------------------------
# Event / Rounds
# -----------------------------------------------------------------------------
@api.get("/event/config")
async def get_config():
    cfg = await db.event_config.find_one({"id": "event"})
    return clean_doc(cfg)

@api.put("/event/config")
async def update_config(body: EventConfigIn, _: dict = Depends(require_admin)):
    update = {k: v for k, v in body.model_dump(exclude_none=True).items()}
    if update:
        await db.event_config.update_one({"id": "event"}, {"$set": update})
    return clean_doc(await db.event_config.find_one({"id": "event"}))

@api.post("/rounds/{round_id}/state")
async def set_round_state(round_id: int, body: RoundStateIn, admin: dict = Depends(require_admin)):
    if round_id not in (1, 2, 3):
        raise HTTPException(400, "Invalid round")
    cfg = await db.event_config.find_one({"id": "event"})
    rounds = cfg.get("rounds", DEFAULT_CONFIG["rounds"])
    key = str(round_id)
    r = rounds.get(key, {"state": "UPCOMING", "started_at": None, "ended_at": None})
    r["state"] = body.state
    if body.state == "ACTIVE" and not r.get("started_at"):
        r["started_at"] = iso(now_utc())
    if body.state == "COMPLETED":
        r["ended_at"] = iso(now_utc())
    rounds[key] = r
    await db.event_config.update_one({"id": "event"}, {"$set": {"rounds": rounds}})
    await audit(f"round{round_id}_state_change", admin, {"state": body.state})
    return r

# -----------------------------------------------------------------------------
# Questions (admin CRUD + participant fetch)
# -----------------------------------------------------------------------------
@api.get("/questions")
async def list_questions(round: int = Query(..., ge=1, le=2), user: dict = Depends(get_current_user)):
    docs = await db.questions.find({"round": round}).sort("order", 1).to_list(500)
    for d in docs:
        d.pop("_id", None)
        if user.get("role") != "admin":
            d.pop("correct_answer", None)
    return docs

@api.post("/questions")
async def create_question(body: QuestionIn, admin: dict = Depends(require_admin)):
    doc = body.model_dump()
    doc["id"] = str(uuid.uuid4())
    await db.questions.insert_one(doc)
    doc.pop("_id", None)
    await audit("question_create", admin, {"id": doc["id"], "round": doc["round"]})
    return doc

@api.put("/questions/{qid}")
async def update_question(qid: str, body: QuestionIn, admin: dict = Depends(require_admin)):
    await db.questions.update_one({"id": qid}, {"$set": body.model_dump()})
    doc = await db.questions.find_one({"id": qid})
    doc.pop("_id", None)
    await audit("question_update", admin, {"id": qid})
    return doc

@api.delete("/questions/{qid}")
async def delete_question(qid: str, admin: dict = Depends(require_admin)):
    await db.questions.delete_one({"id": qid})
    await audit("question_delete", admin, {"id": qid})
    return {"ok": True}

# -----------------------------------------------------------------------------
# Submissions (Round 1 + Round 2)
# -----------------------------------------------------------------------------
async def _round_active(round_id: int):
    cfg = await db.event_config.find_one({"id": "event"})
    state = cfg.get("rounds", {}).get(str(round_id), {}).get("state", "UPCOMING")
    if state != "ACTIVE":
        raise HTTPException(400, f"Round {round_id} is not active (state={state})")
    return cfg

@api.post("/rounds/{round_id}/submit")
async def submit_answer(round_id: int, body: SubmitAnswerIn, user: dict = Depends(require_team)):
    if round_id not in (1, 2):
        raise HTTPException(400, "Use /rounds/3/trades for round 3")
    cfg = await _round_active(round_id)
    q = await db.questions.find_one({"id": body.question_id, "round": round_id})
    if not q:
        raise HTTPException(404, "Question not found")

    team_id = user["team_id"]
    existing = await db.submissions.find_one({"team_id": team_id, "question_id": body.question_id})
    if existing:
        raise HTTPException(400, "Already submitted")

    correct = (body.answer.upper().strip() == q["correct_answer"].upper().strip())
    base = q.get("base_points", 100)
    time_limit = max(1, q.get("time_limit", 30))
    speed_pct = cfg.get("speed_bonus_pct", 0.5)
    speed_factor = max(0.0, 1.0 - (body.time_taken / time_limit))
    score = 0
    if correct:
        score = round(base * (1 + speed_pct * speed_factor))

    doc = {
        "id": str(uuid.uuid4()),
        "team_id": team_id, "question_id": body.question_id,
        "round": round_id, "answer": body.answer.upper().strip(),
        "correct": correct, "time_taken": body.time_taken,
        "score": score, "submitted_at": iso(now_utc()),
    }
    await db.submissions.insert_one(doc)
    await audit(f"round{round_id}_submit", user, {"question_id": body.question_id, "score": score})
    doc.pop("_id", None)
    return {"correct": correct, "score": score, "submission_id": doc["id"]}

@api.get("/rounds/{round_id}/my-submissions")
async def my_subs(round_id: int, user: dict = Depends(require_team)):
    docs = await db.submissions.find({"team_id": user["team_id"], "round": round_id}).to_list(500)
    for d in docs:
        d.pop("_id", None)
    return docs

# -----------------------------------------------------------------------------
# Round 3 — Trading
# -----------------------------------------------------------------------------
@api.post("/rounds/3/start")
async def round3_start(user: dict = Depends(require_team)):
    cfg = await _round_active(3)
    team_id = user["team_id"]
    session = await db.round3_sessions.find_one({"team_id": team_id})
    if not session:
        duration = cfg.get("round3_duration_minutes", 60)
        start = now_utc()
        end = start + timedelta(minutes=duration)
        session = {
            "id": str(uuid.uuid4()),
            "team_id": team_id,
            "started_at": iso(start),
            "ends_at": iso(end),
            "closed": False,
        }
        await db.round3_sessions.insert_one(session)
        await audit("round3_start", user, {})
    session.pop("_id", None)
    session["server_time"] = iso(now_utc())
    return session

@api.get("/rounds/3/status")
async def round3_status(user: dict = Depends(require_team)):
    team_id = user["team_id"]
    session = await db.round3_sessions.find_one({"team_id": team_id})
    trades = await db.trades.find({"team_id": team_id}).sort("trade_number", 1).to_list(10)
    cfg = await db.event_config.find_one({"id": "event"})
    for t in trades:
        t.pop("_id", None)
    s = clean_doc(session) if session else None
    if s:
        s["server_time"] = iso(now_utc())
    return {
        "session": s,
        "trades": trades,
        "max_trades": cfg.get("max_trades", 2),
        "round_state": cfg.get("rounds", {}).get("3", {}).get("state", "UPCOMING"),
        "starting_capital": cfg.get("starting_capital", 100000.0),
        "max_risk_per_trade": cfg.get("max_risk_per_trade", 2.0),
        "trade_proof_required": cfg.get("trade_proof_required", False),
    }

@api.post("/rounds/3/trades")
async def submit_trade(body: TradeIn, user: dict = Depends(require_team)):
    cfg = await _round_active(3)
    team_id = user["team_id"]
    session = await db.round3_sessions.find_one({"team_id": team_id})
    if not session:
        raise HTTPException(400, "Start Round 3 first")

    ends_at = datetime.fromisoformat(session["ends_at"])
    if now_utc() >= ends_at or session.get("closed"):
        raise HTTPException(400, "Round 3 window has closed")

    max_trades = cfg.get("max_trades", 2)
    count = await db.trades.count_documents({"team_id": team_id})
    if count >= max_trades:
        raise HTTPException(400, "Trade limit reached")    # Validations
    if body.result_type == "PROFIT":
        if body.profit <= 0 or body.loss != 0:
            raise HTTPException(400, "Profit must be > 0 and loss must be 0 for PROFIT")
        if body.pl_percentage <= 0:
            raise HTTPException(400, "P/L % must be positive for PROFIT")
    else:
        if body.loss <= 0 or body.profit != 0:
            raise HTTPException(400, "Loss must be > 0 and profit must be 0 for LOSS")
        if body.pl_percentage >= 0:
            raise HTTPException(400, "P/L % must be negative for LOSS")
    if body.risk_per_trade < 0:
        raise HTTPException(400, "Risk % must be >= 0")

    # Trade number = max existing + 1 (so admin deletions don't collide with unique index)
    last = await db.trades.find({"team_id": team_id}).sort("trade_number", -1).limit(1).to_list(1)
    trade_number = (last[0]["trade_number"] + 1) if last else 1
    trade = {
        "id": str(uuid.uuid4()),
        "team_id": team_id,
        "trade_number": trade_number,
        "asset": body.asset,
        "account_size": body.account_size,
        "risk_per_trade": body.risk_per_trade,
        "result_type": body.result_type,
        "profit": body.profit,
        "loss": body.loss,
        "pl_percentage": body.pl_percentage,
        "verification_status": "PENDING",
        "admin_notes": None,
        "proof_url": body.proof_url,
        "submitted_at": iso(now_utc()),
    }
    try:
        await db.trades.insert_one(trade)
    except Exception:
        raise HTTPException(400, "Duplicate trade submission")
    trade.pop("_id", None)
    await audit("round3_trade_submit", user, {"trade_number": trade_number, "asset": body.asset})
    return trade

@api.post("/rounds/3/close")
async def round3_close(user: dict = Depends(require_team)):
    team_id = user["team_id"]
    await db.round3_sessions.update_one({"team_id": team_id}, {"$set": {"closed": True}})
    await audit("round3_close", user, {})
    return {"ok": True}

@api.post("/admin/trades/{trade_id}/verify")
async def verify_trade(trade_id: str, body: VerifyTradeIn, admin: dict = Depends(require_admin)):
    trade = await db.trades.find_one({"id": trade_id})
    if not trade:
        raise HTTPException(404, "Trade not found")
    if body.status == "REJECTED" and not body.reason:
        raise HTTPException(400, "Reason required when rejecting")
    await db.trades.update_one(
        {"id": trade_id},
        {"$set": {"verification_status": body.status, "admin_notes": body.reason}},
    )
    await audit("trade_verify", admin, {"trade_id": trade_id, "status": body.status, "reason": body.reason})
    doc = await db.trades.find_one({"id": trade_id})
    doc.pop("_id", None)
    return doc

@api.get("/admin/trades")
async def admin_trades(status: Optional[str] = None, admin: dict = Depends(require_admin)):
    q = {}
    if status:
        q["verification_status"] = status.upper()
    trades = await db.trades.find(q).sort("submitted_at", -1).to_list(1000)
    # join team names
    team_map = {t["id"]: t["team_name"] async for t in db.teams.find({})}
    for t in trades:
        t.pop("_id", None)
        t["team_name"] = team_map.get(t["team_id"], "Unknown")
    return trades

# -----------------------------------------------------------------------------
# Scoring
# -----------------------------------------------------------------------------
async def _compute_scores():
    cfg = await db.event_config.find_one({"id": "event"})
    w1 = cfg.get("round1_weight", 30.0) / 100.0
    w2 = cfg.get("round2_weight", 30.0) / 100.0
    w3 = cfg.get("round3_weight", 40.0) / 100.0
    perf_w = cfg.get("performance_weight", 60.0) / 100.0
    risk_w = cfg.get("risk_mgmt_weight", 40.0) / 100.0
    max_risk = cfg.get("max_risk_per_trade", 2.0)

    # Overrides
    overrides = {}
    async for o in db.score_overrides.find({}):
        overrides[(o["team_id"], o["round"])] = o["new_score"]

    teams = await db.teams.find({}).to_list(500)
    rows = []
    for team in teams:
        tid = team["id"]
        r1_subs = await db.submissions.find({"team_id": tid, "round": 1}).to_list(500)
        r2_subs = await db.submissions.find({"team_id": tid, "round": 2}).to_list(500)
        r1_raw = sum(s["score"] for s in r1_subs)
        r2_raw = sum(s["score"] for s in r2_subs)
        r1_raw = overrides.get((tid, 1), r1_raw)
        r2_raw = overrides.get((tid, 2), r2_raw)

        # Round 3: performance + risk management
        trades = await db.trades.find({"team_id": tid, "verification_status": {"$ne": "REJECTED"}}).to_list(10)
        total_pl_pct = sum(t.get("pl_percentage", 0) for t in trades)
        # Performance score: map [-5, +10] % to [0, 1000]
        perf_norm = max(0.0, min(1.0, (total_pl_pct + 5) / 15.0))
        performance_score = perf_norm * 1000

        # Risk management:
        risk_score = 1000.0 if trades else 500.0  # neutral if no trades yet
        penalties = 0
        rewards = 0
        for t in trades:
            r = t.get("risk_per_trade", 0)
            if r > max_risk:
                penalties += 300
            elif r <= max_risk / 2:
                rewards += 100
            elif r <= max_risk:
                rewards += 50
            # Penalize blown trades with very large loss
            if t.get("pl_percentage", 0) < -max_risk * 1.5:
                penalties += 200
        risk_score = max(0, min(1000, risk_score + rewards - penalties))

        r3_combined = perf_w * performance_score + risk_w * risk_score
        r3_raw = overrides.get((tid, 3), r3_combined)

        # Normalize each round score to 1000 scale for weighting
        total = w1 * r1_raw + w2 * r2_raw + w3 * r3_raw
        rows.append({
            "team_id": tid,
            "team_name": team["team_name"],
            "college": team.get("college", ""),
            "round1": round(r1_raw, 2),
            "round2": round(r2_raw, 2),
            "round3": round(r3_raw, 2),
            "performance_score": round(performance_score, 2),
            "risk_score": round(risk_score, 2),
            "total_pl_pct": round(total_pl_pct, 2),
            "total": round(total, 2),
        })

    rows.sort(key=lambda r: (-r["total"], -r["round3"], -r["risk_score"], -r["round2"]))

    # Rank + rank change
    prev = {s["team_id"]: s.get("rank") for s in await db.leaderboard_snapshot.find({}).to_list(500)}
    for i, r in enumerate(rows, start=1):
        r["rank"] = i
        last = prev.get(r["team_id"])
        if last is None:
            r["rank_change"] = "NEW"
        elif last > i:
            r["rank_change"] = "UP"
        elif last < i:
            r["rank_change"] = "DOWN"
        else:
            r["rank_change"] = "SAME"

    # Store snapshot
    await db.leaderboard_snapshot.delete_many({})
    if rows:
        await db.leaderboard_snapshot.insert_many([{**r} for r in rows])
    return rows

@api.get("/leaderboard")
async def leaderboard():
    cfg = await db.event_config.find_one({"id": "event"})
    if not cfg.get("leaderboard_visible", True):
        return {"visible": False, "rows": []}
    rows = await _compute_scores()
    return {"visible": True, "rows": rows}

@api.get("/scores/me")
async def my_scores(user: dict = Depends(require_team)):
    rows = await _compute_scores()
    row = next((r for r in rows if r["team_id"] == user["team_id"]), None)
    return row or {"rank": None, "total": 0}

@api.post("/admin/score-override")
async def score_override(body: ScoreOverrideIn, admin: dict = Depends(require_admin)):
    existing = await db.score_overrides.find_one({"team_id": body.team_id, "round": body.round})
    prev = existing["new_score"] if existing else None
    await db.score_overrides.update_one(
        {"team_id": body.team_id, "round": body.round},
        {"$set": {"team_id": body.team_id, "round": body.round, "new_score": body.new_score, "reason": body.reason,
                  "updated_at": iso(now_utc())}},
        upsert=True,
    )
    await audit("score_override", admin, {"team_id": body.team_id, "round": body.round, "previous": prev,
                                          "new": body.new_score, "reason": body.reason})
    return {"ok": True}

# -----------------------------------------------------------------------------
# Teams / Participants (admin)
# -----------------------------------------------------------------------------
@api.get("/admin/teams")
async def list_teams(_: dict = Depends(require_admin)):
    teams = await db.teams.find({}).to_list(1000)
    for t in teams:
        t.pop("_id", None)
    return teams

@api.delete("/admin/teams/{team_id}")
async def delete_team(team_id: str, admin: dict = Depends(require_admin)):
    team = await db.teams.find_one({"id": team_id})
    if not team:
        raise HTTPException(404, "Team not found")
    await db.users.delete_many({"team_id": team_id})
    await db.submissions.delete_many({"team_id": team_id})
    await db.trades.delete_many({"team_id": team_id})
    await db.round3_sessions.delete_many({"team_id": team_id})
    await db.score_overrides.delete_many({"team_id": team_id})
    await db.leaderboard_snapshot.delete_many({"team_id": team_id})
    await db.teams.delete_one({"id": team_id})
    await audit("team_delete", admin, {"team_id": team_id, "team_name": team.get("team_name")})
    return {"ok": True}

@api.delete("/admin/trades/{trade_id}")
async def delete_trade(trade_id: str, admin: dict = Depends(require_admin)):
    trade = await db.trades.find_one({"id": trade_id})
    if not trade:
        raise HTTPException(404, "Trade not found")
    await db.trades.delete_one({"id": trade_id})
    await audit("trade_delete", admin, {"trade_id": trade_id, "team_id": trade.get("team_id"), "trade_number": trade.get("trade_number")})
    return {"ok": True}

@api.post("/admin/event/action")
async def event_action(payload: dict, admin: dict = Depends(require_admin)):
    action = (payload or {}).get("action")
    if action not in ("start", "stop", "reset"):
        raise HTTPException(400, "action must be start | stop | reset")
    cfg = await db.event_config.find_one({"id": "event"}) or {}
    rounds = cfg.get("rounds", DEFAULT_CONFIG["rounds"])

    if action == "start":
        for k in ("1", "2", "3"):
            rounds[k] = {"state": "UPCOMING", "started_at": None, "ended_at": None}
        await db.event_config.update_one(
            {"id": "event"},
            {"$set": {"registration_open": True, "leaderboard_visible": True, "rounds": rounds}},
        )
    elif action == "stop":
        now = iso(now_utc())
        for k in ("1", "2", "3"):
            r = rounds.get(k, {})
            r["state"] = "COMPLETED"
            r["ended_at"] = r.get("ended_at") or now
            rounds[k] = r
        await db.event_config.update_one(
            {"id": "event"},
            {"$set": {"registration_open": False, "rounds": rounds}},
        )
    else:  # reset — wipe gameplay data but keep teams, questions, config
        await db.submissions.delete_many({})
        await db.trades.delete_many({})
        await db.round3_sessions.delete_many({})
        await db.score_overrides.delete_many({})
        await db.leaderboard_snapshot.delete_many({})
        for k in ("1", "2", "3"):
            rounds[k] = {"state": "UPCOMING", "started_at": None, "ended_at": None}
        await db.event_config.update_one({"id": "event"}, {"$set": {"rounds": rounds}})

    await audit(f"event_{action}", admin, {})
    cfg = await db.event_config.find_one({"id": "event"})
    return clean_doc(cfg)

# -----------------------------------------------------------------------------
# Announcements
# -----------------------------------------------------------------------------
@api.get("/announcements")
async def list_announcements():
    docs = await db.announcements.find({}).sort("created_at", -1).limit(20).to_list(20)
    for d in docs:
        d.pop("_id", None)
    return docs

@api.post("/announcements")
async def create_announcement(body: AnnouncementIn, admin: dict = Depends(require_admin)):
    doc = {"id": str(uuid.uuid4()), "message": body.message, "created_at": iso(now_utc())}
    await db.announcements.insert_one(doc)
    doc.pop("_id", None)
    await audit("announcement", admin, {"message": body.message})
    return doc

# -----------------------------------------------------------------------------
# Audit logs
# -----------------------------------------------------------------------------
@api.get("/admin/audit-logs")
async def audit_logs(limit: int = 200, _: dict = Depends(require_admin)):
    docs = await db.audit_logs.find({}).sort("timestamp", -1).limit(limit).to_list(limit)
    for d in docs:
        d.pop("_id", None)
    return docs

# -----------------------------------------------------------------------------
# Analytics
# -----------------------------------------------------------------------------
@api.get("/admin/analytics")
async def analytics(_: dict = Depends(require_admin)):
    teams = await db.teams.count_documents({})
    r1_count = await db.submissions.count_documents({"round": 1})
    r2_count = await db.submissions.count_documents({"round": 2})
    trade_total = await db.trades.count_documents({})
    trade_1 = await db.trades.count_documents({"trade_number": 1})
    trade_2 = await db.trades.count_documents({"trade_number": 2})
    pending = await db.trades.count_documents({"verification_status": "PENDING"})
    verified = await db.trades.count_documents({"verification_status": "VERIFIED"})
    rejected = await db.trades.count_documents({"verification_status": "REJECTED"})
    active_sessions = await db.round3_sessions.count_documents({"closed": False})

    trades = await db.trades.find({"verification_status": {"$ne": "REJECTED"}}).to_list(1000)
    returns = [t.get("pl_percentage", 0) for t in trades]
    avg_return = round(sum(returns) / len(returns), 2) if returns else 0
    best_return = round(max(returns), 2) if returns else 0

    rows = await _compute_scores()
    best_risk = round(max((r["risk_score"] for r in rows), default=0), 2)

    return {
        "total_teams": teams,
        "r1_submissions": r1_count,
        "r2_submissions": r2_count,
        "trades_total": trade_total,
        "trade_1": trade_1,
        "trade_2": trade_2,
        "pending_verification": pending,
        "verified": verified,
        "rejected": rejected,
        "active_round3_sessions": active_sessions,
        "avg_return_pct": avg_return,
        "best_return_pct": best_return,
        "best_risk_score": best_risk,
    }

# -----------------------------------------------------------------------------
# CSV exports
# -----------------------------------------------------------------------------
def _csv_response(rows: list[dict], filename: str) -> StreamingResponse:
    buf = io.StringIO()
    if rows:
        writer = csv.DictWriter(buf, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)
    buf.seek(0)
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": f"attachment; filename={filename}"})

@api.get("/admin/export/{kind}")
async def export(kind: str, _: dict = Depends(require_admin)):
    if kind == "teams":
        rows = await db.teams.find({}, {"_id": 0}).to_list(5000)
    elif kind == "round1":
        rows = await db.submissions.find({"round": 1}, {"_id": 0}).to_list(5000)
    elif kind == "round2":
        rows = await db.submissions.find({"round": 2}, {"_id": 0}).to_list(5000)
    elif kind == "round3":
        rows = await db.trades.find({}, {"_id": 0}).to_list(5000)
    elif kind == "leaderboard":
        rows = await _compute_scores()
    else:
        raise HTTPException(400, "Unknown export kind")
    # Flatten any nested list/dict values to strings so CSV writes cleanly
    for r in rows:
        for k, v in list(r.items()):
            if isinstance(v, (list, dict)):
                r[k] = str(v)
    return _csv_response(rows, f"{kind}.csv")

# -----------------------------------------------------------------------------
# Register router + CORS
# -----------------------------------------------------------------------------
app.include_router(api)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get("CORS_ORIGINS", "*").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)

logging.basicConfig(level=logging.INFO)

@app.on_event("shutdown")
async def shutdown():
    client.close()
