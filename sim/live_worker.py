"""Background polling that cannot hold the web event loop open on shutdown."""

from __future__ import annotations

import threading
from collections.abc import Callable
from typing import Any


class PeriodicCollector:
    """Run a blocking collector on a daemon thread until asked to stop.

    Reticulum's CLI subprocesses are bounded by their own timeouts, but a
    cancelled ``asyncio.to_thread`` call still leaves its executor thread
    running. A daemon worker lets the web server exit immediately even when a
    read-only collection happens to be in progress.
    """

    def __init__(
        self,
        collect: Callable[[], Any],
        publish: Callable[[Any], None],
        interval: float,
    ) -> None:
        self.collect = collect
        self.publish = publish
        self.interval = max(0.1, interval)
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._run,
            name="reticulated-live-rns",
            daemon=True,
        )
        self._thread.start()

    def stop(self, wait: float = 0.25) -> None:
        self._stop.set()
        thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(max(0.0, wait))

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                snapshot = self.collect()
                if not self._stop.is_set():
                    self.publish(snapshot)
            except Exception:
                # Collection health is normally encoded in the snapshot. An
                # unexpected collector error must not kill future polling.
                pass
            self._stop.wait(self.interval)
