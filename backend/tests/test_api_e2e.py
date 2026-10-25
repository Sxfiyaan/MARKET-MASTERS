import os

import pytest
from fastapi.testclient import TestClient
from mongomock_motor import AsyncMongoMockClient

os.environ.update(
    MONGO_URL="mongodb://test",
    DB_NAME="market_masters_test",
    JWT_SECRET="test-secret-abcdefghijklmnopqrstuvwxyz",
    ADMIN_EMAIL="admin@example.com",
    ADMIN_PASSWORD="AdminTest123!",
    CORS_ORIGINS="http://localhost:3000",
)

import server


class MemoryDatabase:
    COLLECTIONS = (
        "users",
        "teams",
        "questions",
        "submissions",
        "trades",
        "round3_sessions",
        "event_config",
        "announcements",
        "audit_logs",
        "score_overrides",
        "leaderboard_snapshot",
    )

    def __init__(self):
        self.client = AsyncMongoMockClient()
        self.database = self.client["market_masters_test"]
        for collection in self.COLLECTIONS:
            setattr(self, collection, self.database[collection])

    async def connect(self):
        return None

    async def close(self):
        self.client.close()


@pytest.fixture
def client():
    server.db = MemoryDatabase()
    server.database_backend = "test-memory"
    with TestClient(server.app) as test_client:
        yield test_client


def test_competition_flow(client):
    assert client.get("/api/").status_code == 200

    registration = {
        "team_name": "Test Traders",
        "leader_name": "Test Leader",
        "leader_email": "leader@example.com",
        "leader_phone": "9999999999",
        "college": "Test University",
        "password": "TeamTest123!",
        "members": ["Member Two"],
    }
    registered = client.post("/api/auth/register-team", json=registration)
    assert registered.status_code == 200
    team_headers = {"Authorization": f"Bearer {registered.json()['token']}"}

    assert client.post("/api/auth/register-team", json=registration).status_code == 400
    assert client.get("/api/auth/me", headers=team_headers).json()["team"]["team_name"] == "Test Traders"

    admin_login = client.post(
        "/api/auth/login",
        json={"email": "admin@example.com", "password": "AdminTest123!"},
    )
    assert admin_login.status_code == 200
    admin_headers = {"Authorization": f"Bearer {admin_login.json()['token']}"}

    question = client.post(
        "/api/questions",
        json={
            "round": 1,
            "text": "Which answer is correct?",
            "options": ["A", "B"],
            "correct_answer": "A",
            "base_points": 100,
            "time_limit": 30,
            "order": 1,
        },
        headers=admin_headers,
    )
    assert question.status_code == 200
    question_id = question.json()["id"]

    participant_questions = client.get("/api/questions?round=1", headers=team_headers)
    assert participant_questions.status_code == 200
    assert "correct_answer" not in participant_questions.json()[0]

    assert client.post(
        "/api/rounds/1/state",
        json={"state": "ACTIVE"},
        headers=admin_headers,
    ).status_code == 200
    submission = client.post(
        "/api/rounds/1/submit",
        json={"question_id": question_id, "answer": "A", "time_taken": 5},
        headers=team_headers,
    )
    assert submission.status_code == 200
    assert submission.json()["correct"] is True
    assert client.post(
        "/api/rounds/1/submit",
        json={"question_id": question_id, "answer": "A", "time_taken": 5},
        headers=team_headers,
    ).status_code == 400

    assert client.post(
        "/api/rounds/3/state",
        json={"state": "ACTIVE"},
        headers=admin_headers,
    ).status_code == 200
    assert client.post("/api/rounds/3/start", headers=team_headers).status_code == 200

    trade = {
        "asset": "NIFTY",
        "account_size": 100000,
        "risk_per_trade": 1,
        "result_type": "PROFIT",
        "profit": 1000,
        "loss": 0,
        "pl_percentage": 1,
    }
    assert client.post("/api/rounds/3/trades", json=trade, headers=team_headers).status_code == 200
    assert client.post(
        "/api/rounds/3/trades",
        json={**trade, "asset": "BANKNIFTY", "profit": 500, "pl_percentage": 0.5},
        headers=team_headers,
    ).status_code == 200
    assert client.post(
        "/api/rounds/3/trades",
        json={**trade, "asset": "RELIANCE"},
        headers=team_headers,
    ).status_code == 400

    leaderboard = client.get("/api/leaderboard")
    assert leaderboard.status_code == 200
    assert len(leaderboard.json()["rows"]) == 1

    analytics = client.get("/api/admin/analytics", headers=admin_headers)
    assert analytics.status_code == 200
    assert analytics.json()["trades_total"] == 2
