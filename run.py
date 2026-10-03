import argparse

import uvicorn

from sim import config


def main():
    parser = argparse.ArgumentParser(description="Reticulum network simulator")
    parser.add_argument("--host", default=config.HTTP_HOST)
    parser.add_argument("--port", type=int, default=config.HTTP_PORT)
    parser.add_argument("--hub-host", default=config.HUB_HOST)
    parser.add_argument("--hub-port", type=int, default=config.HUB_PORT)
    args = parser.parse_args()

    config.HTTP_HOST = args.host
    config.HTTP_PORT = args.port
    config.HUB_HOST = args.hub_host
    config.HUB_PORT = args.hub_port

    url_host = "localhost" if args.host in ("0.0.0.0", "::", "") else args.host
    all_ifaces = "  (listening on all interfaces)" if args.host in ("0.0.0.0", "::") else ""
    print("\n".join([
        "reticulated",
        "  web UI:     http://" + url_host + ":" + str(args.port) + all_ifaces,
        "  medium hub: " + args.hub_host + ":" + str(args.hub_port),
        "  data dir:   " + config.DATA_DIR,
        "  Ctrl+C to stop",
    ]), flush=True)

    try:
        uvicorn.run(
            "sim.server:app",
            host=args.host,
            port=args.port,
            log_level="warning",
            # Keep shutdown behaviour consistent on Python 3.13 instead of
            # delegating signal handling to an optional uvloop installation.
            loop="asyncio",
        )
    except KeyboardInterrupt:
        # Uvicorn normally consumes SIGINT itself. If another interrupt lands
        # during cleanup, still return to the shell without a traceback.
        pass


if __name__ == "__main__":
    main()
