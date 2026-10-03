"""Push read-only local RNS observations to a Reticulated aggregator."""

from __future__ import annotations

import argparse
import gzip
import json
import os
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

from .live_reports import validate_reporter_id
from .live_rns import LiveRNSProvider
from .rns_reporting import RNSReportClient, load_or_create_identity


def report_url(server: str, reporter_id: str) -> str:
    parsed = urllib.parse.urlsplit(server)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError("server must be an http:// or https:// URL")
    base = server.rstrip("/")
    return f"{base}/api/live/reporters/{urllib.parse.quote(reporter_id, safe='')}"


def send_report(server: str, reporter_id: str, token: str, snapshot: dict) -> dict:
    payload = gzip.compress(
        json.dumps(snapshot, separators=(",", ":"), ensure_ascii=False).encode("utf-8"),
        compresslevel=6,
    )
    request = urllib.request.Request(
        report_url(server, reporter_id),
        data=payload,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Content-Encoding": "gzip",
            "User-Agent": "reticulated-live-reporter/1",
        },
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.loads(response.read(64 * 1024))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Collect local rnstatus/rnpath data and push it to a Reticulated server"
    )
    transport = parser.add_mutually_exclusive_group()
    transport.add_argument("--rns-destination", help="Reticulated ingest destination hash")
    transport.add_argument("--server", help="compatibility HTTP aggregator base URL")
    parser.add_argument("--id", dest="reporter_id", help="stable reporter ID")
    parser.add_argument("--label", default=socket.gethostname(), help="display label")
    parser.add_argument("--identity", help="persistent reporter RNS identity file")
    parser.add_argument(
        "--print-identity",
        action="store_true",
        help="create/load --identity, print its hash for enrollment, and exit",
    )
    parser.add_argument("--interval", type=float, default=30.0, help="seconds between reports")
    parser.add_argument("--timeout", type=float, default=3.0, help="RNS command timeout")
    parser.add_argument("--config", dest="config_dir", help="alternate Reticulum config directory")
    parser.add_argument("--rnstatus", default="rnstatus", help="rnstatus executable")
    parser.add_argument("--rnpath", default="rnpath", help="rnpath executable")
    parser.add_argument("--once", action="store_true", help="send one report and exit")
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    if args.print_identity:
        if not args.identity:
            parser.error("--identity is required with --print-identity")
        try:
            print(load_or_create_identity(args.identity).hash.hex())
        except (OSError, ValueError) as exc:
            parser.error(str(exc))
        return
    if not args.reporter_id:
        parser.error("--id is required")
    if not args.server and not args.rns_destination:
        parser.error("one of --rns-destination or --server is required")
    try:
        validate_reporter_id(args.reporter_id)
        if args.server:
            report_url(args.server, args.reporter_id)
    except ValueError as exc:
        parser.error(str(exc))
    if args.interval < 5 and not args.once:
        parser.error("interval must be at least 5 seconds")
    token = os.environ.get("RETICULATED_REPORT_TOKEN")
    if args.server and not token:
        parser.error("RETICULATED_REPORT_TOKEN is required for HTTP reporting")
    if args.rns_destination and not args.identity:
        parser.error("--identity is required for RNS reporting")

    provider = LiveRNSProvider(
        label=args.label,
        timeout=args.timeout,
        rnstatus_path=args.rnstatus,
        rnpath_path=args.rnpath,
        config_dir=args.config_dir,
    )
    rns_client = None
    if args.rns_destination:
        try:
            rns_client = RNSReportClient(
                destination_hash=args.rns_destination,
                identity_path=args.identity,
                config_dir=args.config_dir,
            )
            identity_hash = rns_client.start()
        except (OSError, ValueError) as exc:
            parser.error(str(exc))
        print(f"reporter identity: {identity_hash}", flush=True)
    while True:
        snapshot = provider.collect()
        try:
            if rns_client is not None:
                rns_client.send_report(args.reporter_id, args.label, snapshot)
            else:
                assert args.server is not None and token is not None
                send_report(args.server, args.reporter_id, token, snapshot)
            print(
                f"reported {args.reporter_id}: "
                f"{len(snapshot['interfaces'])} interfaces, "
                f"{len(snapshot['destinations'])} destinations",
                flush=True,
            )
        except (
            OSError,
            TimeoutError,
            urllib.error.URLError,
            urllib.error.HTTPError,
            ValueError,
        ) as exc:
            print(f"report failed: {exc}", file=sys.stderr, flush=True)
            if args.once:
                raise SystemExit(1) from exc
        if args.once:
            return
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
