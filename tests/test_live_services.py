import os
import tempfile
import unittest
from pathlib import Path

import RNS

from sim.live_services import discover_local_services, discover_rnsh_services


class LiveServiceDiscoveryTests(unittest.TestCase):
    def test_discovers_running_rnsh_listener_without_starting_it(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            process = root / "123"
            process.mkdir()
            identity_path = root / "rnsh-identity"
            identity = RNS.Identity()
            identity.to_file(str(identity_path))
            (process / "cmdline").write_bytes(
                b"/home/tim/.local/bin/rnsh\0--listen\0--identity\0" +
                str(identity_path).encode() + b"\0"
            )
            (process / "status").write_text(f"Name:\trnsh\nUid:\t{os.geteuid()}\t{os.geteuid()}\t{os.geteuid()}\t{os.geteuid()}\n")
            (process / "cwd").symlink_to(root)

            services, errors = discover_rnsh_services(str(root))

        self.assertEqual(errors, [])
        self.assertEqual(len(services), 1)
        self.assertEqual(
            services[0]["destination_hash"],
            RNS.Destination.hash(identity, "rnsh").hex(),
        )
        self.assertEqual(services[0]["name"], "rnsh")

    def test_discovers_probe_responder_from_status(self):
        with tempfile.TemporaryDirectory() as directory:
            services, errors = discover_local_services(
                {"probe_responder": "a" * 32}, proc_root=directory
            )

        self.assertEqual(errors, [])
        self.assertEqual(services, [{
            "destination_hash": "a" * 32,
            "name": "RNS probe responder",
            "type": "probe_responder",
            "discovered_by": "rnstatus",
        }])


if __name__ == "__main__":
    unittest.main()
