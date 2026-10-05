

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
exposes the normalized result at `GET /api/live/state`. Live mode has both a
logical **Topology** view and a geographic **Map** view. The map places only
RMAP records containing valid latitude/longitude data, draws hop-depth
observations without inventing intermediate routers, and preserves its
viewport across refreshes and browser sessions.

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
- `LIVE_RNS_PATH_INTERVAL`: refresh interval for the full path table (default
  `10`; cached paths are reused between polls)
- `LIVE_RNS_RMAP_INTERVAL`: refresh interval for the slower RMAP discovery
  command (default `60`; cached discovery data remains available between polls)
- `LIVE_RNS_REPORTER_ID`: stable ID for this server's local report
- `LIVE_REPORT_CACHE_FILE`: persistent latest-report cache, including complete
  path and RMAP data
- `LIVE_REPORT_CACHE_INTERVAL`: minimum seconds between compressed cache writes
- `LIVE_REPORT_MAX_BYTES`: maximum compressed reporter request size (default 16 MiB)
- `LIVE_REPORT_MAX_UNCOMPRESSED_BYTES`: maximum expanded reporter JSON size (default 64 MiB)
  (default `300`; in-memory data still updates immediately)
- `LIVE_ANNOUNCE_CAPTURE_ENABLED`: attach a read-only announce handler to the
  existing shared RNS instance (default `true`)
- `LIVE_ANNOUNCE_MAX_EVENTS`: bounded per-reporter in-memory event buffer
  (default `2048`)
- `LIVE_ANNOUNCE_GRAPH_MAX_DESTINATIONS`: maximum announce destinations
  projected into the interactive graph (default `250`; all events remain in
  the durable history and reporter buffers)
- `LIVE_ANNOUNCE_APP_DATA_PREVIEW`: maximum app-data preview bytes retained per
  event (default `512`; full payload length and SHA-256 are still recorded)
- `LIVE_ANNOUNCE_DB_FILE`: durable, deduplicated announce history database
- `LIVE_LAYOUTS_FILE`: persistent named and autosaved live graph layouts

Live paths show only what the local transport reports. Solid edges represent
the local instance, its interfaces, and reported next-hop transports. Dashed
edges lead to known destinations and label any unresolved remaining hops; the
application never fabricates intermediate routers. If either command fails,
the API reports the error and retains the last good data from that source.
Normalized objects also retain their raw `rnstatus` or `rnpath` fields so newer
RNS telemetry can be adopted without another collector redesign.

Live graph nodes can be pinned from the toolbar or simply dragged into place;
dragging pins the node automatically. Pinned nodes are fixed anchors for the
fCoSE/CoSE layout sequence, while unpinned and newly discovered nodes remain
free to arrange around them. Positions, pins, zoom, and pan are autosaved by
stable graph node ID. Named layouts can also be saved and loaded per reporter
view. The complete latest reporter snapshots are cached separately, so path
summaries and RMAP metadata are available immediately after a restart while
fresh background collection is still running.

Zero-hop destinations learned through the shared `LocalInterface` are retained
as local services even when path summaries are hidden. The reporter discovers
running rnsh listeners from the local process table, reads their existing
identity files, and derives their destination hashes with the public RNS API.
It never starts rnsh or creates an identity. The RNS probe responder is also
identified directly from `rnstatus`. These exact hashes are correlated across
all reporters, so a remote observation of Patroon's rnsh destination receives
the same service label.

RNS 1.5.5 adds live interface attach, detach, and reload operations to
`rnstatus`. Reticulated deliberately does not invoke or expose those operations;
they are reserved for a separately designed, authenticated management mode.

### Multiple reporters

A Reticulated instance can aggregate read-only observations from other nodes we
control. The server always registers its own local RNS observation. The primary
report transport is an encrypted, authenticated Reticulum Link to a dedicated
ingest destination; no public HTTP endpoint or bearer token is required.

```text
Fedora / Vehicle collector
  -> shared local RNS instance
  -> authenticated Link (Resource for large reports)
  -> Patroon topology-ingest destination
  -> in-memory report registry
  -> combined evidence graph and UI

Patroon's own collector --------------------^ (primary report)
```

First create the reporter's stable identity and print its hash:

```bash
python -m sim.reporter \
  --identity /var/lib/reticulated/reporter.identity \
  --print-identity
```

Add that 32-character identity hash to `/etc/reticulated/reporters.json`, bound
to exactly one reporter ID. See `deploy/reporters.json.example`. Enable the
listener on Patroon with `LIVE_RNS_INGEST_ENABLED=true`; its persistent ingest
identity and allowlist paths are shown in `deploy/reticulated.env.example`.
At startup the server logs its ingest destination hash, and the same value is
available from `GET /api/live/reporters`.

On Fedora, use that destination hash to send an observation every 30 seconds:

```bash
python -m sim.reporter \
  --rns-destination PATROON_INGEST_DESTINATION_HASH \
  --identity /var/lib/reticulated/reporter.identity \
  --id fedora-laptop \
  --label 'Fedora laptop'
```

The reporter also registers a public RNS announce handler on the existing
shared instance. It records destination, announcing identity, packet hash,
receive time, recognized aspect, bounded app-data metadata, and the current
route hop/interface evidence when available. It does not retain unlimited raw
payloads. Patroon deduplicates every reporter observation into
`announces.sqlite3`; recent events can be inspected through
`GET /api/live/announces`.

The combined topology correlates announce destination and identity hashes,
next-hop transport hashes, reporter transport identities, interfaces and hop
counts. Shared identities are displayed once with their announced destination
hashes. When the evidence requires unidentified intermediate topology, the UI
draws a labelled ghost segment containing the required unknown hop count; it
does not assign invented hashes or claim false router adjacencies. Conflicting
hop observations remain visible as route uncertainty instead of silently
choosing one report.

The reporter sends the current normalized `rnstatus -j`, `rnpath -t -j`, and
`rnstatus -d -j` state plus its bounded recent announce-event buffer. It removes
redundant raw copies of path and RMAP records before gzip compression while
retaining evolving root/interface telemetry. Large gzip streams are divided
into bounded, checksummed RNS requests; the listener reassembles and validates
the entire transfer before atomically replacing the reporter's prior snapshot.
Missing or expired chunks never create partial topology. RNS automatically
uses a Resource when an individual chunk is larger than one packet. The listener accepts
only identified peers in its allowlist and verifies that the claimed reporter
ID matches the identity's enrollment. The reporter never invokes interface
management or other mutating RNS commands. Reports are kept in memory and
replaced atomically; after a server restart, each node repopulates its entry on
its next interval. The older `--server` HTTP mode remains available for LAN
debugging and compatibility.

`rnstatus -d -j` supplies RMAP discovery records received by that reporter; it
is not a list of the reporter's own interfaces. In the combined view,
Reticulated correlates those records with every reporting node's interfaces:
Backbone and I2P endpoints are matched by advertised address/port, while a
node's own published RNode or I2P interface is matched by transport identity
and interface type. Thus an RMAP cache contributed by Fedora can annotate
Patroon's interfaces even when Patroon has received no discovery records of
its own. The UI reports **RMAP records** and **interface matches** separately.
An active local client interface whose endpoint matches an advertised RMAP
interface also becomes a confirmed one-hop **attachment** between transport
nodes. These attachment edges form a structural graph suitable for shortest
known-attachment paths; they are not assertions about the route Reticulum will
choose for a packet. The geographic view places RMAP transports with real
coordinates and leaves unlocated nodes off the geographic layer instead of
inventing locations.

The default **All reporters** view draws one evidence graph. The server's local
report is primary, transport identities shared between reports become the same
graph node, and interfaces sharing a stable interface hash are merged while
retaining every reporter observation. Unhashed interfaces remain distinct. A
reporter whose transport identity is an observed primary next hop can refine the primary path
with its closer observation. A disconnected reporter cannot replace the
primary's route merely because it is locally closer. Every retained destination
identifies the reporter that observed it, and individual reporter views remain
selectable for diagnosis.

Useful endpoints are:

- `GET /api/live/reporters`
- `GET /api/live/network`
- `GET /api/live/announces`
- `GET /api/live/reporters/{id}/state`
- `POST /api/live/reporters/{id}` (optional HTTP compatibility path; token required)

Example systemd units, environment files, and the reporter allowlist format are
in `deploy/`. Protect identity and configuration files and adjust repository
paths before installing them.

Each node's `instance_name` is derived from the data directory under simdata/
