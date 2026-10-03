import asyncio
import gzip
import hmac
import io
import json
import os
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import config
from .live_rns import LiveRNSProvider
from .live_reports import LiveReportRegistry, validate_reporter_id
from .rns_reporting import RNSReportListener
from .manager import Simulator

sim = Simulator()
live_rns = LiveRNSProvider()
live_reports = LiveReportRegistry(stale_after=config.LIVE_REPORT_STALE_AFTER)
clients = set()
clients_lock = asyncio.Lock()
rns_report_listener: RNSReportListener | None = None


class NodeBody(BaseModel):
    label: str | None = None
    x: float = 0.0
    y: float = 0.0


class NodeUpdate(BaseModel):
    label: str | None = None
    x: float | None = None
    y: float | None = None
    transport: bool | None = None
    mode: str | None = None
    announce_interval: float | None = None
    announce_rate_target: int | None = None
    announce_rate_grace: int | None = None
    announce_rate_penalty: int | None = None
    announce_cap: float | None = None
    color: str | None = None


class LinkBody(BaseModel):
    members: list[str]
    mtu: int = config.DEFAULT_MTU
    bitrate: int = config.DEFAULT_BITRATE
    loss: float = config.DEFAULT_LOSS
    propagation: float = config.DEFAULT_PROPAGATION
    x: float = 0.0
    y: float = 0.0


class LinkParams(BaseModel):
    name: str | None = None
    mtu: int | None = None
    bitrate: int | None = None
    loss: float | None = None
    propagation: float | None = None
    x: float | None = None
    y: float | None = None


class LinkMembers(BaseModel):
    members: list[str]


class TrafficBody(BaseModel):
    src: str
    dst: str
    size: int = 32768


class MessageBody(BaseModel):
    src: str
    dst: str
    text: str


class SettingsBody(BaseModel):
    announce_interval: float | None = None
    announce_cap: float | None = None
    loglevel: int | None = None


class GenerateBody(BaseModel):
    nodes: int = 10
    max_hops: int = 4
    presets: list[str] = []
    max_loss: float = 0.0
    shape: str = "hub"


class PositionsBody(BaseModel):
    nodes: dict = {}
    links: dict = {}


class DropBody(BaseModel):
    destination: str


class LinkModeBody(BaseModel):
    link_id: str
    mode: str | None = None


async def broadcast(event):
    async with clients_lock:
        targets = list(clients)
    dead = []
    for ws in targets:
        try:
            await ws.send_json(event)
        except Exception:
            dead.append(ws)
    if dead:
        async with clients_lock:
            for ws in dead:
                clients.discard(ws)


async def event_pump():
    loop = asyncio.get_running_loop()
    while True:
        event = await loop.run_in_executor(None, sim.events.get)
        await broadcast(event)


async def status_pump():
    while True:
        await asyncio.sleep(3)
        if sim.active:
            data = await asyncio.to_thread(sim.all_status)
            await broadcast({"type": "status", "nodes": data, "lxmf": sim.lxmf_map(), "media": sim.hub.snapshot()})


async def live_rns_pump():
    while True:
        snapshot = await asyncio.to_thread(live_rns.collect)
        live_reports.update(config.LIVE_RNS_REPORTER_ID, snapshot, local=True)
        await asyncio.sleep(config.LIVE_RNS_INTERVAL)


@asynccontextmanager
async def lifespan(app):
    global rns_report_listener
    if config.LIVE_RNS_INGEST_ENABLED:
        rns_report_listener = RNSReportListener(
            live_reports,
            identity_path=config.LIVE_RNS_INGEST_IDENTITY,
            allowlist_path=config.LIVE_RNS_INGEST_ALLOWLIST,
            local_reporter_id=config.LIVE_RNS_REPORTER_ID,
            config_dir=config.LIVE_RNS_CONFIG_DIR,
            max_bytes=config.LIVE_REPORT_MAX_BYTES,
            announce_interval=config.LIVE_RNS_INGEST_ANNOUNCE_INTERVAL,
        )
        destination_hash = await asyncio.to_thread(rns_report_listener.start)
        service = rns_report_listener.service_info()
        if service is not None:
            live_rns.register_local_service(service)
        print(f"Reticulated RNS ingest destination: {destination_hash}", flush=True)
    pump = asyncio.create_task(event_pump())
    poller = asyncio.create_task(status_pump())
    live_poller = asyncio.create_task(live_rns_pump())
    yield
    pump.cancel()
    poller.cancel()
    live_poller.cancel()
    if rns_report_listener is not None:
        rns_report_listener.stop()
    sim.shutdown()


app = FastAPI(lifespan=lifespan)


@app.get("/api/state")
def get_state():
    return sim.snapshot()


@app.get("/api/status")
async def get_status():
    return await asyncio.to_thread(sim.all_status)


@app.get("/api/live/state")
def get_live_state(include_paths: bool = False, include_rmap: bool = False):
    """Return the latest read-only view of the local shared RNS instance."""
    return live_rns.topology_snapshot(
        include_paths=include_paths, include_rmap=include_rmap
    )


@app.get("/api/live/reporters")
def get_live_reporters():
    return {
        "reporters": live_reports.list(),
        "correlations": live_reports.correlations(),
        "remote_ingest_enabled": bool(config.LIVE_REPORT_TOKEN),
        "rns_ingest": {
            "enabled": rns_report_listener is not None,
            "destination_hash": (
                rns_report_listener.destination_hash if rns_report_listener else None
            ),
        },
    }


@app.get("/api/live/network")
def get_live_network(include_paths: bool = False, include_rmap: bool = False):
    state = live_reports.network(
        include_paths=include_paths, include_rmap=include_rmap
    )
    if state is None:
        raise HTTPException(status_code=503, detail="no live reports collected yet")
    return state


@app.get("/api/live/reporters/{reporter_id}/state")
def get_live_reporter_state(
    reporter_id: str, include_paths: bool = False, include_rmap: bool = False
):
    try:
        state = live_reports.get(
            reporter_id, include_paths=include_paths, include_rmap=include_rmap
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if state is None:
        raise HTTPException(status_code=404, detail="unknown reporter")
    return state


def _decode_report_body(raw: bytes, content_encoding: str | None) -> dict:
    if len(raw) > config.LIVE_REPORT_MAX_BYTES:
        raise HTTPException(status_code=413, detail="compressed report is too large")
    if content_encoding:
        if content_encoding.lower() != "gzip":
            raise HTTPException(status_code=415, detail="only gzip content encoding is supported")
        try:
            with gzip.GzipFile(fileobj=io.BytesIO(raw)) as source:
                raw = source.read(config.LIVE_REPORT_MAX_BYTES + 1)
        except (OSError, EOFError) as exc:
            raise HTTPException(status_code=400, detail="invalid gzip report") from exc
    if len(raw) > config.LIVE_REPORT_MAX_BYTES:
        raise HTTPException(status_code=413, detail="uncompressed report is too large")
    try:
        report = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise HTTPException(status_code=400, detail="invalid JSON report") from exc
    if not isinstance(report, dict):
        raise HTTPException(status_code=400, detail="report must be a JSON object")
    return report


@app.post("/api/live/reporters/{reporter_id}")
async def post_live_report(reporter_id: str, request: Request):
    """Accept a normalized, read-only report from a controlled RNS node."""
    if not config.LIVE_REPORT_TOKEN:
        raise HTTPException(status_code=503, detail="remote reporter ingestion is disabled")
    supplied = request.headers.get("authorization", "")
    expected = f"Bearer {config.LIVE_REPORT_TOKEN}"
    if not hmac.compare_digest(supplied, expected):
        raise HTTPException(status_code=401, detail="invalid reporter token")
    try:
        validate_reporter_id(reporter_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if reporter_id == config.LIVE_RNS_REPORTER_ID:
        raise HTTPException(status_code=409, detail="reporter ID is reserved for this server")
    report = _decode_report_body(
        await request.body(), request.headers.get("content-encoding")
    )
    try:
        live_reports.update(reporter_id, report)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"ok": True, "reporter_id": reporter_id, "received_at": time.time()}


@app.get("/api/paths/{node_id}")
async def get_paths(node_id: str):
    return await asyncio.to_thread(sim.node_paths, node_id)


@app.get("/api/nodes/{node_id}/log")
async def get_node_log(node_id: str):
    return {"log": await asyncio.to_thread(sim.node_log, node_id)}


@app.post("/api/paths/{node_id}/drop")
async def post_drop_path(node_id: str, body: DropBody):
    ok = await asyncio.to_thread(sim.drop_path, node_id, body.destination)
    return {"ok": ok}


@app.post("/api/nodes")
def post_node(body: NodeBody):
    node_id = sim.add_node(body.label, body.x, body.y)
    return {"id": node_id}


@app.patch("/api/nodes/{node_id}")
def patch_node(node_id: str, body: NodeUpdate):
    fields = body.model_dump(exclude_unset=True)
    if any(k in fields for k in ("label", "x", "y")):
        sim.update_node(node_id, fields.get("label"), fields.get("x"), fields.get("y"))
    if "announce_interval" in fields:
        sim.set_node_announce_interval(node_id, fields["announce_interval"])
    if "color" in fields:
        sim.set_node_color(node_id, fields["color"])
    config_fields = {k: fields[k] for k in ("transport", "mode", "announce_rate_target", "announce_rate_grace", "announce_rate_penalty", "announce_cap") if k in fields}
    if config_fields:
        sim.set_node_options(node_id, config_fields)
    return {"ok": True}


@app.post("/api/nodes/{node_id}/link_mode")
def post_link_mode(node_id: str, body: LinkModeBody):
    ok = sim.set_node_link_mode(node_id, body.link_id, body.mode)
    return {"ok": ok}


@app.post("/api/nodes/{node_id}/announce")
def post_announce(node_id: str):
    ok = sim.announce(node_id)
    return {"ok": ok}


@app.post("/api/nodes/{node_id}/announce_lxmf")
def post_announce_lxmf(node_id: str):
    ok = sim.announce_lxmf(node_id)
    return {"ok": ok}


@app.delete("/api/nodes/{node_id}")
def delete_node(node_id: str):
    removed = sim.remove_node(node_id)
    return {"ok": True, "removed_links": removed}


@app.post("/api/links")
def post_link(body: LinkBody):
    link_id = sim.add_link(body.members, body.mtu, body.bitrate, body.loss, body.propagation, body.x, body.y)
    return {"id": link_id}


@app.patch("/api/links/{link_id}")
def patch_link(link_id: str, body: LinkParams):
    if body.x is not None or body.y is not None:
        sim.update_link(link_id, body.x, body.y)
    if body.name is not None:
        sim.set_link_name(link_id, body.name)
    ok = True
    if any(v is not None for v in (body.mtu, body.bitrate, body.loss, body.propagation)):
        ok = sim.set_link_params(link_id, body.mtu, body.bitrate, body.loss, body.propagation)
    return {"ok": ok}


@app.patch("/api/links/{link_id}/members")
def patch_link_members(link_id: str, body: LinkMembers):
    ok = sim.set_link_members(link_id, body.members)
    return {"ok": ok}


@app.delete("/api/links/{link_id}")
def delete_link(link_id: str):
    ok = sim.remove_link(link_id)
    return {"ok": ok}


@app.get("/api/topology")
def get_topology():
    return sim.export_topology()


@app.post("/api/topology/import")
def post_import(body: dict):
    ok = sim.load_topology(body.get("topology", body))
    return {"ok": ok}


@app.get("/api/route")
async def get_route(src: str, dst: str):
    return await asyncio.to_thread(sim.trace_route, src, dst)


@app.post("/api/reset")
def post_reset():
    sim.reset()
    return {"ok": True}


@app.post("/api/generate")
def post_generate(body: GenerateBody):
    result = sim.generate(body.nodes, body.max_hops, body.presets, body.max_loss, body.shape)
    return {"ok": True, "result": result}


@app.post("/api/positions")
def post_positions(body: PositionsBody):
    sim.set_positions(body.nodes, body.links)
    return {"ok": True}


@app.post("/api/start")
def post_start():
    sim.start()
    return {"active": True}


@app.post("/api/stop")
def post_stop():
    sim.stop()
    return {"active": False}


@app.post("/api/nodes/{node_id}/restart")
def post_restart(node_id: str):
    sim.restart_node(node_id)
    return {"ok": True}


@app.post("/api/traffic")
def post_traffic(body: TrafficBody):
    sim.run_traffic(body.src, body.dst, body.size)
    return {"ok": True}


@app.post("/api/message")
def post_message(body: MessageBody):
    ok = sim.send_message(body.src, body.dst, body.text)
    return {"ok": ok}


@app.post("/api/settings")
def post_settings(body: SettingsBody):
    fields = body.model_dump(exclude_unset=True)
    if "announce_interval" in fields and fields["announce_interval"] is not None:
        sim.set_announce_interval(fields["announce_interval"])
    if "announce_cap" in fields and fields["announce_cap"] is not None:
        sim.set_announce_cap(fields["announce_cap"])
    if "loglevel" in fields and fields["loglevel"] is not None:
        sim.set_loglevel(fields["loglevel"])
    return {"ok": True}


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    async with clients_lock:
        clients.add(ws)
    try:
        await ws.send_json({"type": "state", "state": sim.snapshot()})
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        async with clients_lock:
            clients.discard(ws)


@app.get("/")
def index():
    return FileResponse(os.path.join(config.WEB_DIR, "index.html"))


app.mount("/", StaticFiles(directory=config.WEB_DIR), name="static")
