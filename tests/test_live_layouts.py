import tempfile
import unittest
from pathlib import Path

from sim.live_layouts import LiveLayoutStore, validate_layout


class LiveLayoutStoreTests(unittest.TestCase):
    def test_named_layout_round_trips_stable_positions_pins_and_viewport(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "layouts.json"
            store = LiveLayoutStore(path)
            store.save("all", "Patroon anchors", {
                "positions": {
                    "transport:patroon": {"x": 10, "y": 20},
                    "interface:garage": {"x": 40.5, "y": 60.5},
                },
                "pinned": ["transport:patroon"],
                "viewport": {"zoom": 1.25, "pan": {"x": 5, "y": -8}},
            })

            restored = LiveLayoutStore(path).get("all", "Patroon anchors")

        self.assertEqual(restored["positions"]["transport:patroon"], {"x": 10.0, "y": 20.0})
        self.assertEqual(restored["pinned"], ["transport:patroon"])
        self.assertEqual(restored["viewport"]["zoom"], 1.25)

    def test_autosave_is_not_exposed_as_named_layout(self):
        with tempfile.TemporaryDirectory() as directory:
            store = LiveLayoutStore(Path(directory) / "layouts.json")
            body = {"positions": {"node": {"x": 0, "y": 0}}, "pinned": []}
            store.save("all", "__autosave__", body)
            store.save("all", "Field view", body)

            self.assertEqual([item["name"] for item in store.list("all")], ["Field view"])

    def test_rejects_non_finite_positions_and_unknown_pin_ids(self):
        with self.assertRaises(ValueError):
            validate_layout("all", "bad", {
                "positions": {"node": {"x": float("nan"), "y": 0}}, "pinned": []
            })
        with self.assertRaises(ValueError):
            validate_layout("all", "bad", {
                "positions": {"node": {"x": 0, "y": 0}}, "pinned": ["missing"]
            })


if __name__ == "__main__":
    unittest.main()
