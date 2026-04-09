from __future__ import annotations

import asyncio
import json
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Optional
from uuid import uuid4


RuntimeSnapshotFactory = Callable[[], dict[str, Any]]


@dataclass
class _Subscriber:
    id: str
    loop: asyncio.AbstractEventLoop
    queue: asyncio.Queue[dict[str, Any]]


class RuntimeEventBroker:
    def __init__(
        self,
        snapshot_factory: RuntimeSnapshotFactory,
        *,
        max_queue_size: int = 32,
    ):
        self._snapshot_factory = snapshot_factory
        self._max_queue_size = max_queue_size
        self._lock = threading.Lock()
        self._subscribers: dict[str, _Subscriber] = {}
        self._sequence = 0

    def _next_sequence(self) -> int:
        with self._lock:
            self._sequence += 1
            return self._sequence

    def _build_envelope(self, event_type: str, data: Any = None) -> dict[str, Any]:
        return {
            "seq": self._next_sequence(),
            "type": event_type,
            "data": data,
            "emitted_at": int(time.time() * 1000),
        }

    async def subscribe(self) -> tuple[str, asyncio.Queue[dict[str, Any]]]:
        subscriber_id = str(uuid4())
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=self._max_queue_size)
        subscriber = _Subscriber(id=subscriber_id, loop=loop, queue=queue)

        with self._lock:
            self._subscribers[subscriber_id] = subscriber

        queue.put_nowait(self._build_envelope("snapshot", self._snapshot_factory()))
        return subscriber_id, queue

    def unsubscribe(self, subscriber_id: str) -> None:
        with self._lock:
            self._subscribers.pop(subscriber_id, None)

    def publish(self, event_type: str, data: Any = None) -> None:
        envelope = self._build_envelope(event_type, data)
        with self._lock:
            subscribers = list(self._subscribers.values())

        for subscriber in subscribers:
            try:
                subscriber.loop.call_soon_threadsafe(self._deliver_event, subscriber.id, envelope)
            except RuntimeError:
                self.unsubscribe(subscriber.id)

    def _replace_with_snapshot(self, queue: asyncio.Queue[dict[str, Any]]) -> None:
        while not queue.empty():
            try:
                queue.get_nowait()
            except asyncio.QueueEmpty:
                break

        try:
            queue.put_nowait(self._build_envelope("snapshot", self._snapshot_factory()))
        except asyncio.QueueFull:
            return

    def _deliver_event(self, subscriber_id: str, envelope: dict[str, Any]) -> None:
        with self._lock:
            subscriber = self._subscribers.get(subscriber_id)

        if subscriber is None:
            return

        if subscriber.queue.full():
            self._replace_with_snapshot(subscriber.queue)
            return

        try:
            subscriber.queue.put_nowait(envelope)
        except asyncio.QueueFull:
            self._replace_with_snapshot(subscriber.queue)


def encode_sse_event(envelope: dict[str, Any]) -> bytes:
    payload = json.dumps(envelope, separators=(",", ":"), ensure_ascii=False)
    return f"id: {envelope['seq']}\nevent: {envelope['type']}\ndata: {payload}\n\n".encode("utf-8")


def build_heartbeat_event() -> dict[str, Any]:
    return {
        "seq": 0,
        "type": "heartbeat",
        "data": {"ts": int(time.time() * 1000)},
        "emitted_at": int(time.time() * 1000),
    }
