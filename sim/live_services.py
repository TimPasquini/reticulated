"""Read-only discovery of Reticulum services hosted on the reporting machine."""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

import RNS


DESTINATION_HASH_PATTERN = re.compile(r"^[0-9a-fA-F]{32}$")


def _option(argv: list[str], *names: str) -> str | None:
    arguments = argv[:argv.index("--")] if "--" in argv else argv
    for index, value in enumerate(arguments):
        if value in names and index + 1 < len(arguments):
            return arguments[index + 1]
        for name in names:
            prefix = name + "="
            if value.startswith(prefix):
                return value[len(prefix):]
    return None


def _rnsh_listener(argv: list[str]) -> bool:
    arguments = argv[:argv.index("--")] if "--" in argv else argv
    is_rnsh = any(Path(value).name == "rnsh" for value in arguments)
    return is_rnsh and ("-l" in arguments or "--listen" in arguments)


def _process_home(pid_dir: Path) -> Path:
    try:
        status = (pid_dir / "status").read_text(errors="replace")
        uid_line = next(line for line in status.splitlines() if line.startswith("Uid:"))
        uid = int(uid_line.split()[1])
        import pwd
        return Path(pwd.getpwuid(uid).pw_dir)
    except (OSError, StopIteration, ValueError, KeyError):
        return Path.home()


def _rnsh_identity_path(pid_dir: Path, argv: list[str]) -> tuple[Path, str]:
    try:
        cwd = Path(os.readlink(pid_dir / "cwd"))
    except OSError:
        cwd = Path.cwd()
    home = _process_home(pid_dir)
    identity_option = _option(argv, "-i", "--identity")
    service_name = _option(argv, "-s", "--service") or "default"
    if identity_option:
        identity_path = Path(identity_option.replace("~", str(home), 1))
        if not identity_path.is_absolute():
            identity_path = cwd / identity_path
        return identity_path, service_name

    config_option = _option(argv, "-c", "--config")
    if config_option:
        config_dir = Path(config_option.replace("~", str(home), 1))
        if not config_dir.is_absolute():
            config_dir = cwd / config_dir
    elif (home / ".config/rnsh").is_dir():
        config_dir = home / ".config/rnsh"
    else:
        config_dir = home / ".rnsh"
    safe_service_name = re.sub(r"\W+", "", service_name)
    suffix = f".{safe_service_name}" if safe_service_name else ""
    return config_dir / f"identity{suffix}", service_name


def discover_rnsh_services(proc_root: str = "/proc") -> tuple[list[dict[str, Any]], list[str]]:
    services: list[dict[str, Any]] = []
    errors: list[str] = []
    seen: set[str] = set()
    root = Path(proc_root)
    try:
        process_dirs = [entry for entry in root.iterdir() if entry.name.isdigit()]
    except OSError as exc:
        return [], [f"cannot inspect {proc_root}: {exc}"]
    for pid_dir in process_dirs:
        try:
            argv = [
                value.decode("utf-8", errors="replace")
                for value in (pid_dir / "cmdline").read_bytes().split(b"\0")
                if value
            ]
        except OSError:
            continue
        if not _rnsh_listener(argv):
            continue
        identity_path, service_name = _rnsh_identity_path(pid_dir, argv)
        if not identity_path.is_file():
            errors.append(f"rnsh process {pid_dir.name}: identity not readable")
            continue
        try:
            identity = RNS.Identity.from_file(str(identity_path))
            if identity is None:
                raise ValueError("invalid identity")
            destination_hash = RNS.Destination.hash(identity, "rnsh").hex()
        except Exception as exc:
            errors.append(f"rnsh process {pid_dir.name}: {exc}")
            continue
        if destination_hash in seen:
            continue
        seen.add(destination_hash)
        label = "rnsh" if service_name == "default" else f"rnsh ({service_name})"
        services.append({
            "destination_hash": destination_hash,
            "name": label,
            "type": "rnsh",
            "discovered_by": "running_process",
            "pid": int(pid_dir.name),
        })
    return services, errors


def discover_local_services(
    status: dict[str, Any], *, proc_root: str = "/proc"
) -> tuple[list[dict[str, Any]], list[str]]:
    services, errors = discover_rnsh_services(proc_root)
    probe_hash = str(status.get("probe_responder") or "").lower()
    if DESTINATION_HASH_PATTERN.fullmatch(probe_hash) and not any(
        service["destination_hash"] == probe_hash for service in services
    ):
        services.append({
            "destination_hash": probe_hash,
            "name": "RNS probe responder",
            "type": "probe_responder",
            "discovered_by": "rnstatus",
        })
    return services, errors
