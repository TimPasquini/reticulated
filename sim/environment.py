"""Load Reticulated's user configuration without executing shell code."""

from __future__ import annotations

import os
import re
import shlex
from pathlib import Path


_ENVIRONMENT_KEY = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def default_environment_file() -> Path:
    override = os.environ.get("RETICULATED_ENV_FILE")
    if override:
        return Path(override).expanduser()
    config_home = Path(
        os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")
    ).expanduser()
    return config_home / "reticulated" / "reticulated.env"


def load_environment_file(path: str | os.PathLike[str] | None = None) -> Path | None:
    """Load KEY=VALUE settings, leaving explicit process values authoritative.

    This intentionally parses the small env-file format instead of sourcing the
    file. Command substitutions and other shell syntax are never executed.
    """

    environment_file = Path(path).expanduser() if path else default_environment_file()
    if not environment_file.is_file():
        return None

    for line_number, raw_line in enumerate(
        environment_file.read_text(encoding="utf-8").splitlines(), start=1
    ):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            raise ValueError(
                f"invalid environment setting at {environment_file}:{line_number}"
            )
        key, raw_value = line.split("=", 1)
        key = key.strip()
        if not _ENVIRONMENT_KEY.fullmatch(key):
            raise ValueError(
                f"invalid environment key at {environment_file}:{line_number}"
            )
        try:
            values = shlex.split(raw_value, comments=True, posix=True)
        except ValueError as exc:
            raise ValueError(
                f"invalid environment value at {environment_file}:{line_number}: {exc}"
            ) from exc
        if len(values) > 1:
            raise ValueError(
                f"unquoted whitespace in environment value at "
                f"{environment_file}:{line_number}"
            )
        value = values[0] if values else ""
        os.environ.setdefault(key, value)
    return environment_file
