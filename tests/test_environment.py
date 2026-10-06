import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from sim.environment import default_environment_file, load_environment_file


class EnvironmentFileTests(unittest.TestCase):
    def test_loads_plain_exported_and_quoted_values(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "reticulated.env"
            path.write_text(
                "# local aggregator\n"
                "SIM_HOST=0.0.0.0\n"
                "export SIM_PORT=8765\n"
                'LIVE_RNS_LABEL="Patroon node" # friendly name\n',
                encoding="utf-8",
            )
            with patch.dict(os.environ, {}, clear=True):
                loaded = load_environment_file(path)
                self.assertEqual(loaded, path)
                self.assertEqual(os.environ["SIM_HOST"], "0.0.0.0")
                self.assertEqual(os.environ["SIM_PORT"], "8765")
                self.assertEqual(os.environ["LIVE_RNS_LABEL"], "Patroon node")

    def test_explicit_process_environment_has_priority(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "reticulated.env"
            path.write_text("SIM_PORT=8765\n", encoding="utf-8")
            with patch.dict(os.environ, {"SIM_PORT": "9000"}, clear=True):
                load_environment_file(path)
                self.assertEqual(os.environ["SIM_PORT"], "9000")

    def test_default_honors_xdg_config_home_and_override(self):
        with patch.dict(os.environ, {"XDG_CONFIG_HOME": "/tmp/config"}, clear=True):
            self.assertEqual(
                default_environment_file(),
                Path("/tmp/config/reticulated/reticulated.env"),
            )
        with patch.dict(
            os.environ, {"RETICULATED_ENV_FILE": "/tmp/custom.env"}, clear=True
        ):
            self.assertEqual(default_environment_file(), Path("/tmp/custom.env"))

    def test_rejects_shell_statements_instead_of_executing_them(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "reticulated.env"
            path.write_text("echo unsafe\n", encoding="utf-8")
            with patch.dict(os.environ, {}, clear=True):
                with self.assertRaisesRegex(ValueError, "invalid environment setting"):
                    load_environment_file(path)

    def test_config_import_loads_file_before_constants_are_evaluated(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "reticulated.env"
            path.write_text(
                "SIM_HOST=0.0.0.0\nSIM_PORT=8765\n"
                "LIVE_RNS_REPORTER_ID=patroon\nLIVE_RNS_LABEL=Patroon\n",
                encoding="utf-8",
            )
            environment = os.environ.copy()
            for key in ("SIM_HOST", "SIM_PORT", "LIVE_RNS_REPORTER_ID", "LIVE_RNS_LABEL"):
                environment.pop(key, None)
            environment["RETICULATED_ENV_FILE"] = str(path)
            output = subprocess.check_output(
                [
                    sys.executable,
                    "-c",
                    "from sim import config; print(config.HTTP_HOST, config.HTTP_PORT, "
                    "config.LIVE_RNS_REPORTER_ID, config.LIVE_RNS_LABEL)",
                ],
                cwd=Path(__file__).resolve().parents[1],
                env=environment,
                text=True,
            )
        self.assertEqual(output.strip(), "0.0.0.0 8765 patroon Patroon")


if __name__ == "__main__":
    unittest.main()
