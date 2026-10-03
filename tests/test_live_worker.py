import threading
import time
import unittest

from sim.live_worker import PeriodicCollector


class PeriodicCollectorTests(unittest.TestCase):
    def test_stop_returns_while_blocking_collection_is_in_progress(self):
        collecting = threading.Event()
        release = threading.Event()
        published = []

        def collect():
            collecting.set()
            release.wait(2)
            return {"mode": "live_rns"}

        worker = PeriodicCollector(collect, published.append, 60)
        worker.start()
        self.assertTrue(collecting.wait(1))

        started = time.monotonic()
        worker.stop(wait=0.05)
        elapsed = time.monotonic() - started
        release.set()

        self.assertLess(elapsed, 0.25)
        self.assertEqual(published, [])

    def test_publishes_and_stops_during_interval_wait(self):
        published = []
        worker = PeriodicCollector(lambda: {"ok": True}, published.append, 60)
        worker.start()
        deadline = time.monotonic() + 1
        while not published and time.monotonic() < deadline:
            time.sleep(0.01)

        worker.stop()

        self.assertEqual(published, [{"ok": True}])


if __name__ == "__main__":
    unittest.main()
