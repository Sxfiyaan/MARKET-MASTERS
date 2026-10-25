from typing import Any

from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase


class MongoDatabase:
    """Compatibility database for the original Emergent/Mongo runtime."""

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

    def __init__(self, url: str, database_name: str):
        self.client = AsyncIOMotorClient(url, serverSelectionTimeoutMS=5000)
        self.database: AsyncIOMotorDatabase = self.client[database_name]
        for collection in self.COLLECTIONS:
            setattr(self, collection, self.database[collection])

    async def connect(self) -> None:
        await self.client.admin.command("ping")

    async def close(self) -> None:
        self.client.close()
