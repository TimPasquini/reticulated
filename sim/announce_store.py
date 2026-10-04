"""Durable, deduplicated announce observations from topology reporters."""

from __future__ import annotations

import sqlite3
import threading
from contextlib import closing
from pathlib import Path
from typing import Any


class AnnounceEventStore:
    def __init__(self, path: str) -> None:
        self.path = Path(path)
        self._lock = threading.Lock()
        self._count = 0
        self.error: str | None = None
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=10)
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=NORMAL")
        return connection

    def _initialize(self) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with closing(self._connect()) as connection, connection:
                connection.executescript("""
                    CREATE TABLE IF NOT EXISTS announce_events (
                        reporter_id TEXT NOT NULL,
                        event_id TEXT NOT NULL,
                        received_at REAL NOT NULL,
                        destination_hash TEXT NOT NULL,
                        identity_hash TEXT,
                        packet_hash TEXT,
                        aspect TEXT,
                        is_path_response INTEGER NOT NULL DEFAULT 0,
                        app_data_length INTEGER NOT NULL DEFAULT 0,
                        app_data_sha256 TEXT,
                        app_data_preview_base64 TEXT,
                        app_data_text TEXT,
                        app_data_truncated INTEGER NOT NULL DEFAULT 0,
                        route_hops INTEGER,
                        route_via TEXT,
                        route_interface TEXT,
                        PRIMARY KEY (reporter_id, event_id)
                    );
                    CREATE INDEX IF NOT EXISTS announce_events_received
                        ON announce_events(received_at DESC);
                    CREATE INDEX IF NOT EXISTS announce_events_destination
                        ON announce_events(destination_hash, received_at DESC);
                """)
                row = connection.execute("SELECT COUNT(*) FROM announce_events").fetchone()
                self._count = int(row[0]) if row else 0
            self.error = None
        except (OSError, sqlite3.Error) as exc:
            self.error = str(exc)

    def ingest(self, reporter_id: str, capture: Any) -> int:
        if not isinstance(capture, dict):
            return 0
        events = capture.get("events", [])
        if not isinstance(events, list):
            return 0
        rows = []
        for event in events:
            if not isinstance(event, dict):
                continue
            event_id = str(event.get("id") or "")
            destination_hash = str(event.get("destination_hash") or "").lower()
            try:
                received_at = float(event.get("received_at"))
            except (TypeError, ValueError):
                continue
            if not event_id or not destination_hash:
                continue
            rows.append((
                reporter_id, event_id, received_at, destination_hash,
                event.get("identity_hash"), event.get("packet_hash"), event.get("aspect"),
                int(bool(event.get("is_path_response"))),
                int(event.get("app_data_length") or 0), event.get("app_data_sha256"),
                event.get("app_data_preview_base64"), event.get("app_data_text"),
                int(bool(event.get("app_data_truncated"))), event.get("route_hops"),
                event.get("route_via"), event.get("route_interface"),
            ))
        if not rows:
            return 0
        try:
            with self._lock, closing(self._connect()) as connection, connection:
                before = connection.total_changes
                connection.executemany("""
                    INSERT OR IGNORE INTO announce_events (
                        reporter_id, event_id, received_at, destination_hash,
                        identity_hash, packet_hash, aspect, is_path_response,
                        app_data_length, app_data_sha256, app_data_preview_base64,
                        app_data_text, app_data_truncated, route_hops, route_via,
                        route_interface
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, rows)
                inserted = connection.total_changes - before
                self._count += inserted
            self.error = None
            return inserted
        except (OSError, sqlite3.Error, TypeError, ValueError) as exc:
            self.error = str(exc)
            return 0

    def count(self) -> int:
        with self._lock:
            return self._count

    def recent(
        self,
        *,
        limit: int = 100,
        reporter_id: str | None = None,
        destination_hash: str | None = None,
    ) -> list[dict[str, Any]]:
        limit = max(1, min(1000, int(limit)))
        conditions = []
        parameters: list[Any] = []
        if reporter_id:
            conditions.append("reporter_id = ?")
            parameters.append(reporter_id)
        if destination_hash:
            conditions.append("destination_hash = ?")
            parameters.append(destination_hash.lower())
        where = " WHERE " + " AND ".join(conditions) if conditions else ""
        columns = (
            "reporter_id", "event_id", "received_at", "destination_hash",
            "identity_hash", "packet_hash", "aspect", "is_path_response",
            "app_data_length", "app_data_sha256", "app_data_preview_base64",
            "app_data_text", "app_data_truncated", "route_hops", "route_via",
            "route_interface",
        )
        try:
            with self._lock, closing(self._connect()) as connection:
                rows = connection.execute(
                    f"SELECT {', '.join(columns)} FROM announce_events{where} "
                    "ORDER BY received_at DESC LIMIT ?",
                    [*parameters, limit],
                ).fetchall()
            self.error = None
            return [dict(zip(columns, row)) for row in rows]
        except sqlite3.Error as exc:
            self.error = str(exc)
            return []
