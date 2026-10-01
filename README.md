

## Reticulated

<img src="docs/reticulated_logo.webp">

Reticulated is a Reticulum Network simulator that spawns live, interactive [Reticulum](https://github.com/markqvist/reticulum) instances controllable from a node-based Web UI. 

You can create networks of any topology and set bitrate, MTU, and configure path loss and propagation behavior. It provides a top-down view to a live network. You can connect any Reticulum application to the simulated network. It also has built in utilities like a basic LXMF chat function and Resource transfer included.

<img src="docs/screen1.webp">
<img src="docs/screen2.webp">



### Requirements

- Python 3.10+
- `lxmf`
- `rnsd`, `rnstatus`, `rnpath` on `PATH` (installed with the `rns` package)

## Install and run

```bash
pip install -r requirements.txt
python run.py
```

Open http://127.0.0.1:8000.

```bash
python run.py --port 9000                 # web UI on 9000
python run.py --host 0.0.0.0 --port 9000  # listen on all interfaces
python run.py --hub-port 5900             # move the medium hub off 5800
SIM_PORT=9000 SIM_HUB_PORT=5900 python run.py
```

## Live RNS topology

The UI has two independent modes. **Simulation** retains the original editable
simulator. **Live RNS** is a read-only view of the local shared Reticulum
instance. It polls `rnstatus -j` and `rnpath -t -j` every five seconds and
exposes the normalized result at `GET /api/live/state`.

Run Reticulated as the same user that can access the shared RNS instance, then
select **Live RNS** in the toolbar. The local hostname is used for the root
label; it can be given a friendlier name such as Patroon without hard-coding a
transport identity:

```bash
LIVE_RNS_LABEL=Patroon python run.py
```

Optional live-mode settings are:

- `LIVE_RNS_RNSTATUS` and `LIVE_RNS_RNPATH`: executable paths
- `LIVE_RNS_CONFIG_DIR`: alternate local Reticulum config directory
- `LIVE_RNS_TIMEOUT`: per-command timeout in seconds (default `3`)
- `LIVE_RNS_INTERVAL`: backend collection interval in seconds (default `5`)
- `LIVE_RNS_REPORTER_ID`: stable ID for this server's local report

Live paths show only what the local transport reports. Solid edges represent
the local instance, its interfaces, and reported next-hop transports. Dashed
edges lead to known destinations and label any unresolved remaining hops; the
application never fabricates intermediate routers. If either command fails,
the API reports the error and retains the last good data from that source.
Normalized objects also retain their raw `rnstatus` or `rnpath` fields so newer
RNS telemetry can be adopted without another collector redesign.

RNS 1.5.5 adds live interface attach, detach, and reload operations to
`rnstatus`. Reticulated deliberately does not invoke or expose those operations;
they are reserved for a separately designed, authenticated management mode.

### Multiple reporters

A Reticulated instance can aggregate read-only observations from other nodes we
control. The server always registers its own local RNS observation. Set a token
to enable remote report ingestion:

```bash
RETICULATED_REPORT_TOKEN='replace-with-a-long-random-token' \
LIVE_RNS_REPORTER_ID=patroon \
LIVE_RNS_LABEL=Patroon \
python run.py --host 0.0.0.0 --port 8765
```

Keep this listener on the trusted LAN; this does not require a WAN port, public
DNS, or changes to Patroon's I2P gateway. On Fedora, send an observation every
30 seconds with:

```bash
RETICULATED_REPORT_TOKEN='the-same-token' \
python -m sim.reporter \
  --server http://garage-reticulum-node:8765 \
  --id fedora-laptop \
  --label 'Fedora laptop'
```

The reporter gzip-compresses normalized `rnstatus -j`, `rnpath -t -j`, and
`rnstatus -d -j` observations. It never invokes interface management or other
mutating RNS commands. Reports are kept in memory and replaced atomically;
after a server restart, each node repopulates its entry on its next interval.

The default **All reporters** view draws one evidence graph. The server's local
report is primary, transport identities shared between reports become the same
graph node, and reporter-specific interfaces remain distinct. A reporter whose
transport identity is an observed primary next hop can refine the primary path
with its closer observation. A disconnected reporter cannot replace the
primary's route merely because it is locally closer. Every retained destination
identifies the reporter that observed it, and individual reporter views remain
selectable for diagnosis.

Useful endpoints are:

- `GET /api/live/reporters`
- `GET /api/live/network`
- `GET /api/live/reporters/{id}/state`
- `POST /api/live/reporters/{id}` (Bearer token required)

Example systemd units and environment files are in `deploy/`. Generate a
unique token, protect the environment file, and adjust repository paths before
installing them.

Each node's `instance_name` is derived from the data directory under simdata/
