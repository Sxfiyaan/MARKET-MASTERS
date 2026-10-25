import json
import os
import re
from dataclasses import dataclass
from typing import Any
from uuid import uuid4

import asyncpg


FIELD_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
NUMERIC_FIELDS = {"round", "order", "trade_number", "base_points", "time_limit"}


@dataclass
class UpdateResult:
    matched_count: int
    modified_count: int


def _validate_field(field: str) -> str:
    if not FIELD_PATTERN.fullmatch(field):
        raise ValueError(f"Unsupported document field: {field}")
    return field


def _bind(value: Any, params: list[Any]) -> str:
    params.append(value)
    return f"${len(params)}"


def _value_expression(field: str, value: Any) -> str:
    _validate_field(field)
    if field == "id":
        return "id"
    expression = f"data->>'{field}'"
    if isinstance(value, bool):
        return f"({expression})::boolean"
    if isinstance(value, int) and not isinstance(value, bool):
        return f"({expression})::bigint"
    if isinstance(value, float):
        return f"({expression})::double precision"
    return expression


def _where(collection: str, query: dict[str, Any], params: list[Any]) -> str:
    clauses = [f"collection = {_bind(collection, params)}"]
    for field, condition in query.items():
        if isinstance(condition, dict) and "$ne" in condition:
            value = condition["$ne"]
            clauses.append(
                f"{_value_expression(field, value)} IS DISTINCT FROM {_bind(value, params)}"
            )
            continue
        clauses.append(f"{_value_expression(field, condition)} = {_bind(condition, params)}")
    return " AND ".join(clauses)


def _sort_expression(field: str) -> str:
    _validate_field(field)
    if field == "id":
        return "id"
    expression = f"data->>'{field}'"
    if field in NUMERIC_FIELDS:
        return f"({expression})::double precision"
    return expression


def _document(row: asyncpg.Record) -> dict[str, Any]:
    data = dict(row["data"] or {})
    return {"id": row["id"], **data}


def _json(value: Any) -> str:
    return json.dumps(value, default=str, separators=(",", ":"))


class PostgresCursor:
    def __init__(self, collection: "PostgresCollection", query: dict[str, Any]):
        self.collection = collection
        self.query = query
        self.sort_field: str | None = None
        self.sort_direction = 1
        self.max_rows: int | None = None

    def sort(self, field: str, direction: int = 1) -> "PostgresCursor":
        self.sort_field = field
        self.sort_direction = -1 if direction < 0 else 1
        return self

    def limit(self, count: int) -> "PostgresCursor":
        self.max_rows = count
        return self

    async def to_list(self, length: int | None = None) -> list[dict[str, Any]]:
        params: list[Any] = []
        where_sql = _where(self.collection.name, self.query, params)
        sql = f"SELECT id, data FROM app_documents WHERE {where_sql}"
        if self.sort_field:
            direction = "DESC" if self.sort_direction < 0 else "ASC"
            sql += f" ORDER BY {_sort_expression(self.sort_field)} {direction} NULLS LAST"
        limit = self.max_rows if self.max_rows is not None else length
        if limit is not None:
            sql += f" LIMIT {_bind(max(0, limit), params)}"
        rows = await self.collection.database.pool.fetch(sql, *params)
        return [_document(row) for row in rows]

    def __aiter__(self):
        return self._iterate()

    async def _iterate(self):
        for document in await self.to_list():
            yield document


class PostgresCollection:
    def __init__(self, database: "PostgresDatabase", name: str):
        self.database = database
        self.name = name

    async def create_index(self, *_args: Any, **_kwargs: Any) -> None:
        return None

    def find(self, query: dict[str, Any] | None = None, *_args: Any, **_kwargs: Any) -> PostgresCursor:
        return PostgresCursor(self, query or {})

    async def find_one(self, query: dict[str, Any] | None = None) -> dict[str, Any] | None:
        documents = await self.find(query).limit(1).to_list(1)
        return documents[0] if documents else None

    async def insert_one(self, document: dict[str, Any]) -> None:
        stored = dict(document)
        stored.pop("_id", None)
        document_id = str(stored.pop("id", uuid4()))
        await self.database.pool.execute(
            """
            INSERT INTO app_documents (collection, id, data)
            VALUES ($1, $2, $3::jsonb)
            """,
            self.name,
            document_id,
            _json(stored),
        )

    async def insert_many(self, documents: list[dict[str, Any]]) -> None:
        rows = []
        for document in documents:
            stored = dict(document)
            stored.pop("_id", None)
            document_id = str(stored.pop("id", uuid4()))
            rows.append((self.name, document_id, _json(stored)))
        if rows:
            await self.database.pool.executemany(
                """
                INSERT INTO app_documents (collection, id, data)
                VALUES ($1, $2, $3::jsonb)
                """,
                rows,
            )

    async def update_one(
        self,
        query: dict[str, Any],
        update: dict[str, Any],
        upsert: bool = False,
    ) -> UpdateResult:
        params: list[Any] = []
        where_sql = _where(self.name, query, params)
        async with self.database.pool.acquire() as connection:
            async with connection.transaction():
                row = await connection.fetchrow(
                    f"SELECT id, data FROM app_documents WHERE {where_sql} LIMIT 1",
                    *params,
                )
                changes = update.get("$set", {})
                if row:
                    data = dict(row["data"] or {})
                    data.update(changes)
                    await connection.execute(
                        """
                        UPDATE app_documents
                        SET data = $1::jsonb, updated_at = now()
                        WHERE collection = $2 AND id = $3
                        """,
                        _json(data),
                        self.name,
                        row["id"],
                    )
                    return UpdateResult(1, 1)
                if not upsert:
                    return UpdateResult(0, 0)

                data = {
                    key: value
                    for key, value in query.items()
                    if not isinstance(value, dict)
                }
                data.update(changes)
                document_id = str(data.pop("id", uuid4()))
                await connection.execute(
                    """
                    INSERT INTO app_documents (collection, id, data)
                    VALUES ($1, $2, $3::jsonb)
                    """,
                    self.name,
                    document_id,
                    _json(data),
                )
                return UpdateResult(0, 0)

    async def delete_one(self, query: dict[str, Any]) -> int:
        params: list[Any] = []
        where_sql = _where(self.name, query, params)
        result = await self.database.pool.execute(
            f"DELETE FROM app_documents WHERE {where_sql}", *params
        )
        return int(result.rsplit(" ", 1)[-1])

    async def delete_many(self, query: dict[str, Any]) -> int:
        return await self.delete_one(query)

    async def count_documents(self, query: dict[str, Any] | None = None) -> int:
        params: list[Any] = []
        where_sql = _where(self.name, query or {}, params)
        count = await self.database.pool.fetchval(
            f"SELECT COUNT(*) FROM app_documents WHERE {where_sql}", *params
        )
        return int(count or 0)


class PostgresDatabase:
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

    def __init__(self, dsn: str):
        self.dsn = dsn.replace("postgresql+asyncpg://", "postgresql://", 1)
        self.pool: asyncpg.Pool | None = None
        for collection in self.COLLECTIONS:
            setattr(self, collection, PostgresCollection(self, collection))

    async def connect(self) -> None:
        if self.pool is None:
            min_size = max(1, int(os.environ.get("DB_POOL_MIN_SIZE", "2")))
            max_size = max(min_size, int(os.environ.get("DB_POOL_MAX_SIZE", "10")))
            self.pool = await asyncpg.create_pool(
                self.dsn,
                min_size=min_size,
                max_size=max_size,
                command_timeout=30,
                statement_cache_size=0,
            )

    async def close(self) -> None:
        if self.pool is not None:
            await self.pool.close()
            self.pool = None
