#!/usr/bin/env python3
"""
swarm-msg — tiny CLI for ccswarm agents to message each other without
hand-rolling file paths or timestamps.

Usage:
  swarm-msg send <peer> -m "text"        send a message to peer
  swarm-msg send <peer> < body.md        same, body on stdin
  swarm-msg read [--all] [--keep]        print unread messages, mark processed
  swarm-msg peek                         list unread without consuming
  swarm-msg peers                        print peer names, one per line

Env (set by the orchestrator at launch time):
  CCSWARM_AGENT     this agent's name
  CCSWARM_WORKSPACE absolute path of the run workspace

Exit codes:
  0 ok / 1 user error / 2 environment broken
"""
from __future__ import annotations

import argparse
import os
import shutil
import sys
import time
from datetime import datetime, timezone
from pathlib import Path


def _env() -> tuple[str, Path]:
    agent = os.environ.get("CCSWARM_AGENT", "").strip()
    ws = os.environ.get("CCSWARM_WORKSPACE", "").strip()
    if not agent or not ws:
        sys.stderr.write(
            "swarm-msg: CCSWARM_AGENT or CCSWARM_WORKSPACE not set. "
            "Are you running this inside an agent shell?\n"
        )
        sys.exit(2)
    root = Path(ws)
    if not root.is_dir():
        sys.stderr.write(f"swarm-msg: workspace '{root}' is not a directory\n")
        sys.exit(2)
    return agent, root


def _peer_inbox(root: Path, peer: str) -> Path:
    return root / "agents" / peer / "inbox"


def _my_inbox(root: Path, agent: str) -> Path:
    return root / "agents" / agent / "inbox"


def _peers(root: Path, me: str) -> list[str]:
    base = root / "agents"
    if not base.is_dir():
        return []
    return sorted(p.name for p in base.iterdir() if p.is_dir() and p.name != me)


def cmd_send(args: argparse.Namespace) -> int:
    me, root = _env()
    peer = args.peer
    inbox = _peer_inbox(root, peer)
    if not inbox.is_dir():
        peers = _peers(root, me)
        sys.stderr.write(
            f"swarm-msg: peer '{peer}' has no inbox at {inbox}.\n"
            f"known peers: {', '.join(peers) if peers else '(none)'}\n"
        )
        return 1

    if args.message is not None:
        body = args.message
    else:
        body = sys.stdin.read()
    body = body.rstrip() + "\n"

    ts_ms = int(time.time() * 1000)
    iso = datetime.now(timezone.utc).isoformat(timespec="seconds")
    fname = f"{ts_ms:013d}-{me}.md"
    path = inbox / fname
    header = f"---\nfrom: {me}\nto: {peer}\nts: {iso}\n---\n"
    # Atomic-ish write so the watcher never sees a half-baked file.
    tmp = inbox / f".{fname}.tmp"
    tmp.write_text(header + body, encoding="utf-8")
    tmp.replace(path)
    print(str(path))
    return 0


def _list_unread(inbox: Path) -> list[Path]:
    if not inbox.is_dir():
        return []
    out = []
    for p in sorted(inbox.iterdir()):
        if not p.is_file():
            continue
        if p.name.startswith("."):
            continue
        out.append(p)
    return out


def cmd_read(args: argparse.Namespace) -> int:
    me, root = _env()
    inbox = _my_inbox(root, me)
    processed = inbox / "processed"
    processed.mkdir(parents=True, exist_ok=True)
    msgs = _list_unread(inbox)
    if not msgs:
        if not args.quiet:
            print(f"(no new messages for {me})")
        return 0
    out_chunks: list[str] = []
    for p in msgs:
        try:
            text = p.read_text(encoding="utf-8")
        except Exception as exc:  # noqa: BLE001
            out_chunks.append(f"=== {p.name} (read error: {exc}) ===\n")
            continue
        out_chunks.append(f"=== {p.name} ===\n{text.rstrip()}\n")
        if not args.keep:
            try:
                shutil.move(str(p), str(processed / p.name))
            except Exception as exc:  # noqa: BLE001
                sys.stderr.write(f"swarm-msg: failed to archive {p.name}: {exc}\n")
    sys.stdout.write("\n".join(out_chunks))
    if not out_chunks[-1].endswith("\n"):
        sys.stdout.write("\n")
    return 0


def cmd_peek(args: argparse.Namespace) -> int:
    me, root = _env()
    inbox = _my_inbox(root, me)
    msgs = _list_unread(inbox)
    if not msgs:
        if not args.quiet:
            print(f"(no new messages for {me})")
        return 0
    for p in msgs:
        print(p.name)
    return 0


def cmd_peers(_args: argparse.Namespace) -> int:
    me, root = _env()
    for n in _peers(root, me):
        print(n)
    return 0


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="swarm-msg", description="ccswarm peer messaging")
    sub = ap.add_subparsers(dest="cmd", required=True)

    send = sub.add_parser("send", help="send a message to a peer")
    send.add_argument("peer", help="peer agent name")
    send.add_argument("-m", "--message", help="message body (otherwise read stdin)")
    send.set_defaults(func=cmd_send)

    read = sub.add_parser("read", help="print unread messages and archive them")
    read.add_argument("--keep", action="store_true", help="don't move to processed/")
    read.add_argument("--quiet", "-q", action="store_true")
    read.set_defaults(func=cmd_read)

    peek = sub.add_parser("peek", help="list unread filenames without consuming")
    peek.add_argument("--quiet", "-q", action="store_true")
    peek.set_defaults(func=cmd_peek)

    peers = sub.add_parser("peers", help="list peer agent names")
    peers.set_defaults(func=cmd_peers)

    return ap


def main(argv: list[str]) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
