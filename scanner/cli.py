"""scanner: devices | capture | serve | run"""

from __future__ import annotations

import argparse
import logging
import signal
import threading

from . import audio, config


def _setup_logging() -> None:
    logging.basicConfig(
        level=config.LOG_LEVEL,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    )


def cmd_devices(_: argparse.Namespace) -> int:
    print(audio.list_devices())
    return 0


def cmd_capture(_: argparse.Namespace) -> int:
    from . import pipeline
    stop = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    pipeline.run(stop=stop)
    return 0


def cmd_serve(args: argparse.Namespace) -> int:
    import uvicorn
    uvicorn.run(
        "scanner.web.app:app",
        host=args.host or config.WEB_HOST,
        port=args.port or config.WEB_PORT,
        log_level=config.LOG_LEVEL.lower(),
    )
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    """Capture in a thread + uvicorn in the main thread."""
    import uvicorn
    from . import pipeline

    stop = threading.Event()
    cap = threading.Thread(target=pipeline.run, args=(stop,), name="capture", daemon=True)
    cap.start()

    def _shutdown(*_):
        stop.set()

    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)
    try:
        uvicorn.run(
            "scanner.web.app:app",
            host=args.host or config.WEB_HOST,
            port=args.port or config.WEB_PORT,
            log_level=config.LOG_LEVEL.lower(),
        )
    finally:
        stop.set()
        cap.join(timeout=5)
    return 0


def main(argv: list[str] | None = None) -> int:
    _setup_logging()
    p = argparse.ArgumentParser(prog="scanner")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("devices", help="list audio input devices")
    sub.add_parser("capture", help="record clips only (no web UI)")

    sp = sub.add_parser("serve", help="run web UI only")
    sp.add_argument("--host", default=None)
    sp.add_argument("--port", type=int, default=None)

    sp = sub.add_parser("run", help="capture + web UI together")
    sp.add_argument("--host", default=None)
    sp.add_argument("--port", type=int, default=None)

    args = p.parse_args(argv)
    return {
        "devices": cmd_devices,
        "capture": cmd_capture,
        "serve": cmd_serve,
        "run": cmd_run,
    }[args.cmd](args)


if __name__ == "__main__":
    raise SystemExit(main())
