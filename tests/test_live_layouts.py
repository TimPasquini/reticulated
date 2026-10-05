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
                    "transport:patroon": {"x": -10.25, "y": 20.75},
                    "interface:garage": {"x": 40.5, "y": -60.5},
                },
                "pinned": ["transport:patroon"],
                "pinned_nodes": {
                    "transport:patroon": {
                        "label": "◆ RMAP · Patroon",
                        "live_kind": "transport",
                        "hash": "09985437",
                        "rmap_records": [{"transport_id": "09985437"}],
                    }
                },
                "viewport": {"zoom": 1.25, "pan": {"x": 5, "y": -8}},
            })

            restored = LiveLayoutStore(path).get("all", "Patroon anchors")

        self.assertEqual(
            restored["positions"]["transport:patroon"],
            {"x": -10.25, "y": 20.75},
        )
        self.assertEqual(
            restored["positions"]["interface:garage"],
            {"x": 40.5, "y": -60.5},
        )
        self.assertEqual(restored["pinned"], ["transport:patroon"])
        self.assertEqual(
            restored["pinned_nodes"]["transport:patroon"]["hash"], "09985437"
        )
        self.assertEqual(restored["viewport"]["zoom"], 1.25)

    def test_autosave_is_not_exposed_as_named_layout(self):
        with tempfile.TemporaryDirectory() as directory:
            store = LiveLayoutStore(Path(directory) / "layouts.json")
            body = {"positions": {"node": {"x": 0, "y": 0}}, "pinned": []}
            store.save("all", "__autosave__", body)
            store.save("all", "Field view", body)

            self.assertEqual([item["name"] for item in store.list("all")], ["Field view"])

    def test_overwrite_retains_absent_pins_but_allows_visible_unpin(self):
        with tempfile.TemporaryDirectory() as directory:
            store = LiveLayoutStore(Path(directory) / "layouts.json")
            store.save("all", "Field view", {
                "positions": {
                    "visible": {"x": 10, "y": 20},
                    "temporarily-absent": {"x": -30, "y": 40},
                },
                "pinned": ["visible", "temporarily-absent"],
                "pinned_nodes": {
                    "temporarily-absent": {
                        "label": "◆ RMAP · remembered",
                        "live_kind": "transport",
                        "hash": "deadbeef",
                        "rmap_records": [{"transport_id": "deadbeef"}],
                    }
                },
            })
            overwritten = store.save("all", "Field view", {
                "positions": {"visible": {"x": 50, "y": 60}},
                "pinned": [],
            })

        self.assertEqual(overwritten["pinned"], ["temporarily-absent"])
        self.assertEqual(
            overwritten["positions"]["temporarily-absent"],
            {"x": -30.0, "y": 40.0},
        )
        self.assertEqual(
            overwritten["pinned_nodes"]["temporarily-absent"]["hash"],
            "deadbeef",
        )
        self.assertEqual(overwritten["positions"]["visible"], {"x": 50.0, "y": 60.0})

    def test_replace_drops_absent_pins_and_delete_removes_autosave(self):
        with tempfile.TemporaryDirectory() as directory:
            store = LiveLayoutStore(Path(directory) / "layouts.json")
            store.save("all", "__autosave__", {
                "positions": {"hidden": {"x": -30, "y": 40}},
                "pinned": ["hidden"],
            })
            replaced = store.save(
                "all", "__autosave__", {"positions": {}, "pinned": []},
                retain_absent_pins=False,
            )
            self.assertEqual(replaced["pinned"], [])
            self.assertEqual(replaced["positions"], {})
            self.assertTrue(store.delete("all", "__autosave__"))
            self.assertIsNone(store.get("all", "__autosave__"))
            self.assertFalse(store.delete("all", "__autosave__"))

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
