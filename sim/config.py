import os
import shutil
import hashlib
import socket

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.environ.get("SIM_DATA_DIR", os.path.join(BASE_DIR, "simdata"))
NODES_DIR = os.path.join(DATA_DIR, "nodes")
WEB_DIR = os.path.join(BASE_DIR, "web")
TOPOLOGY_FILE = os.path.join(DATA_DIR, "topology.json")

INSTANCE_PREFIX = hashlib.md5(os.path.abspath(DATA_DIR).encode("utf-8")).hexdigest()[:6]

HUB_HOST = os.environ.get("SIM_HUB_HOST", "127.0.0.1")
HUB_PORT = int(os.environ.get("SIM_HUB_PORT", "5800"))

HTTP_HOST = os.environ.get("SIM_HOST", "127.0.0.1")
HTTP_PORT = int(os.environ.get("SIM_PORT", "8000"))

# Live mode only invokes read-only, machine-readable RNS utilities. These can
# point at another local RNS config directory without coupling to RNS internals.
RNSTATUS_PATH = os.environ.get("LIVE_RNS_RNSTATUS", shutil.which("rnstatus") or "rnstatus")
RNPATH_PATH = os.environ.get("LIVE_RNS_RNPATH", shutil.which("rnpath") or "rnpath")
LIVE_RNS_CONFIG_DIR = os.environ.get("LIVE_RNS_CONFIG_DIR")
LIVE_RNS_LABEL = os.environ.get("LIVE_RNS_LABEL", socket.gethostname() or "Local RNS")
LIVE_RNS_TIMEOUT = float(os.environ.get("LIVE_RNS_TIMEOUT", "3"))
LIVE_RNS_INTERVAL = float(os.environ.get("LIVE_RNS_INTERVAL", "5"))
LIVE_RNS_PATH_INTERVAL = float(os.environ.get("LIVE_RNS_PATH_INTERVAL", "10"))
LIVE_RNS_RMAP_INTERVAL = float(os.environ.get("LIVE_RNS_RMAP_INTERVAL", "60"))
LIVE_RNS_REPORTER_ID = os.environ.get("LIVE_RNS_REPORTER_ID", socket.gethostname() or "local")
LIVE_REPORT_TOKEN = os.environ.get("RETICULATED_REPORT_TOKEN")
LIVE_REPORT_STALE_AFTER = float(os.environ.get("LIVE_REPORT_STALE_AFTER", "90"))
LIVE_REPORT_MAX_BYTES = int(os.environ.get("LIVE_REPORT_MAX_BYTES", str(16 * 1024 * 1024)))
LIVE_REPORT_MAX_UNCOMPRESSED_BYTES = int(os.environ.get(
    "LIVE_REPORT_MAX_UNCOMPRESSED_BYTES", str(64 * 1024 * 1024)
))
LIVE_REPORT_CACHE_FILE = os.environ.get(
    "LIVE_REPORT_CACHE_FILE", os.path.join(DATA_DIR, "live-reports.json.gz")
)
LIVE_REPORT_CACHE_INTERVAL = float(os.environ.get("LIVE_REPORT_CACHE_INTERVAL", "300"))
LIVE_ANNOUNCE_CAPTURE_ENABLED = os.environ.get(
    "LIVE_ANNOUNCE_CAPTURE_ENABLED", "true"
).lower() in ("1", "true", "yes", "on")
LIVE_ANNOUNCE_MAX_EVENTS = int(os.environ.get("LIVE_ANNOUNCE_MAX_EVENTS", "2048"))
LIVE_ANNOUNCE_GRAPH_MAX_DESTINATIONS = int(
    os.environ.get("LIVE_ANNOUNCE_GRAPH_MAX_DESTINATIONS", "250")
)
LIVE_ANNOUNCE_APP_DATA_PREVIEW = int(
    os.environ.get("LIVE_ANNOUNCE_APP_DATA_PREVIEW", "512")
)
LIVE_ANNOUNCE_DB_FILE = os.environ.get(
    "LIVE_ANNOUNCE_DB_FILE", os.path.join(DATA_DIR, "announces.sqlite3")
)
LIVE_RNS_INGEST_ENABLED = os.environ.get("LIVE_RNS_INGEST_ENABLED", "false").lower() in (
    "1", "true", "yes", "on"
)
LIVE_RNS_INGEST_IDENTITY = os.environ.get(
    "LIVE_RNS_INGEST_IDENTITY", os.path.join(DATA_DIR, "topology-ingest.identity")
)
LIVE_RNS_INGEST_ALLOWLIST = os.environ.get(
    "LIVE_RNS_INGEST_ALLOWLIST", os.path.join(DATA_DIR, "reporters.json")
)
LIVE_RNS_INGEST_ANNOUNCE_INTERVAL = float(
    os.environ.get("LIVE_RNS_INGEST_ANNOUNCE_INTERVAL", "300")
)
LIVE_LAYOUTS_FILE = os.environ.get(
    "LIVE_LAYOUTS_FILE", os.path.join(DATA_DIR, "live-layouts.json")
)

BRIDGE_HOST = os.environ.get("SIM_BRIDGE_HOST", "127.0.0.1")
TCP_BASE = int(os.environ.get("SIM_TCP_BASE", "6000"))
SHARED_PORT_BASE = int(os.environ.get("SIM_SHARED_PORT_BASE", "6200"))
CONTROL_PORT_BASE = int(os.environ.get("SIM_CONTROL_PORT_BASE", "6400"))

DEFAULT_MTU = 500
DEFAULT_BITRATE = 9600
DEFAULT_LOSS = 0.0
DEFAULT_PROPAGATION = 0.0

MIN_MTU = 500
MAX_MTU = 32768


def rns_tool(name):
    return shutil.which(name) or name


def rnsd_path():
    return rns_tool("rnsd")


def ensure_dirs():
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(NODES_DIR, exist_ok=True)
