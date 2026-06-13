#!/usr/bin/env python3
"""
swarm-plan — shared task list for ultraswarm agents.

Usage:
  swarm-plan read               print the current plan
  swarm-plan add "task"         append a new unchecked item
  swarm-plan done <N>           mark item N done (1-based, checkbox lines only)
  swarm-plan undone <N>         uncheck item N
  swarm-plan remove <N>         delete item N
  swarm-plan set "full text"    replace entire plan (coordinator use)
  swarm-plan clear              remove all items

Env (set by orchestrator):
  CCSWARM_SHARED    path to the shared directory
  CCSWARM_AGENT     this agent's name (used in edit log)
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path


def _shared() -> Path:
    ws = os.environ.get("CCSWARM_SHARED", "").strip()
    if not ws:
        sys.stderr.write(
            "swarm-plan: CCSWARM_SHARED not set. "
            "Are you running this inside an agent shell?\n"
        )
        sys.exit(2)
    root = Path(ws)
    if not root.is_dir():
        sys.stderr.write(f"swarm-plan: shared dir '{root}' is not a directory\n")
        sys.exit(2)
    return root


def _plan_path(shared: Path) -> Path:
    return shared / "PLAN.md"


def _read_raw(shared: Path) -> str:
    p = _plan_path(shared)
    return p.read_text("utf-8") if p.exists() else "# Plan\n\n"


def _write(shared: Path, content: str) -> None:
    p = _plan_path(shared)
    tmp = shared / ".PLAN.md.tmp"
    tmp.write_text(content, "utf-8")
    tmp.replace(p)


def _checkbox_lines(content: str) -> list[tuple[int, str, bool]]:
    """Return (line_index, text, done) for every checkbox line."""
    out = []
    for i, line in enumerate(content.splitlines()):
        s = line.strip()
        if s.startswith("- ["):
            done = s[3:4].lower() == "x"
            text = s[5:].strip() if len(s) > 5 else ""
            out.append((i, text, done))
    return out


def cmd_read(args: argparse.Namespace) -> int:
    shared = _shared()
    content = _read_raw(shared)
    items = _checkbox_lines(content)
    if not items:
        print("(plan is empty)")
        return 0
    for n, (_, text, done) in enumerate(items, 1):
        mark = "x" if done else " "
        print(f"{n}. [{mark}] {text}")
    return 0


def cmd_add(args: argparse.Namespace) -> int:
    shared = _shared()
    text = args.text.strip()
    if not text:
        sys.stderr.write("swarm-plan: item text is empty\n")
        return 1
    content = _read_raw(shared)
    line = f"- [ ] {text}"
    if content.endswith("\n"):
        content += line + "\n"
    else:
        content += "\n" + line + "\n"
    _write(shared, content)
    items = _checkbox_lines(content)
    print(f"Added item {len(items)}.")
    return 0


def _set_item_done(args: argparse.Namespace, done: bool) -> int:
    shared = _shared()
    n = args.n
    content = _read_raw(shared)
    lines = content.splitlines(keepends=True)
    items = _checkbox_lines(content)
    if n < 1 or n > len(items):
        sys.stderr.write(f"swarm-plan: item {n} not found (plan has {len(items)} items)\n")
        return 1
    line_idx, text, _ = items[n - 1]
    mark = "x" if done else " "
    # Preserve original indentation
    orig = lines[line_idx]
    leading = len(orig) - len(orig.lstrip())
    lines[line_idx] = orig[:leading] + f"- [{mark}] {text}\n"
    _write(shared, "".join(lines))
    status = "done" if done else "undone"
    print(f"Item {n} marked {status}: {text}")
    return 0


def cmd_done(args: argparse.Namespace) -> int:
    return _set_item_done(args, True)


def cmd_undone(args: argparse.Namespace) -> int:
    return _set_item_done(args, False)


def cmd_remove(args: argparse.Namespace) -> int:
    shared = _shared()
    n = args.n
    content = _read_raw(shared)
    lines = content.splitlines(keepends=True)
    items = _checkbox_lines(content)
    if n < 1 or n > len(items):
        sys.stderr.write(f"swarm-plan: item {n} not found (plan has {len(items)} items)\n")
        return 1
    line_idx, text, _ = items[n - 1]
    del lines[line_idx]
    _write(shared, "".join(lines))
    print(f"Removed item {n}: {text}")
    return 0


def cmd_set(args: argparse.Namespace) -> int:
    shared = _shared()
    body = args.text.strip()
    _write(shared, body + "\n")
    print("Plan updated.")
    return 0


def cmd_clear(args: argparse.Namespace) -> int:
    shared = _shared()
    _write(shared, "# Plan\n\n")
    print("Plan cleared.")
    return 0


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="swarm-plan", description="ultraswarm shared task list")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("read", help="print the current plan").set_defaults(func=cmd_read)

    p_add = sub.add_parser("add", help="append a new item")
    p_add.add_argument("text", help="item description")
    p_add.set_defaults(func=cmd_add)

    p_done = sub.add_parser("done", help="mark item N done")
    p_done.add_argument("n", type=int, metavar="N")
    p_done.set_defaults(func=cmd_done)

    p_undone = sub.add_parser("undone", help="uncheck item N")
    p_undone.add_argument("n", type=int, metavar="N")
    p_undone.set_defaults(func=cmd_undone)

    p_rm = sub.add_parser("remove", help="delete item N")
    p_rm.add_argument("n", type=int, metavar="N")
    p_rm.set_defaults(func=cmd_remove)

    p_set = sub.add_parser("set", help="replace entire plan")
    p_set.add_argument("text", help="full plan text")
    p_set.set_defaults(func=cmd_set)

    sub.add_parser("clear", help="remove all items").set_defaults(func=cmd_clear)

    return ap


def main(argv: list[str]) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
