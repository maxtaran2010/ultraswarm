#!/usr/bin/env python3
"""
ccswarm iTerm2 driver.

JSON-RPC over stdio. Each line on stdin is a JSON request:
  {"id": "...", "method": "create_grid",  "params": {"count": N}}
  {"id": "...", "method": "send_text",    "params": {"session_id": "...", "text": "..."}}
  {"id": "...", "method": "close_window", "params": {"window_id": "..."}}
  {"id": "...", "method": "ping"}

Each response line is JSON:
  {"id": "...", "ok": true,  "result": {...}}
  {"id": "...", "ok": false, "error": "msg"}

Requires: python3 -m pip install iterm2
And iTerm2 Preferences -> General -> Magic -> "Enable Python API" must be on.
"""
from __future__ import annotations

import asyncio
import json
import math
import os
import sys
import threading
import traceback
from typing import Any, Dict, List

try:
    import iterm2
except Exception as exc:  # pragma: no cover
    sys.stderr.write(
        "ccswarm: failed to import iterm2. Install with: python3 -m pip install iterm2\n"
        f"underlying error: {exc}\n"
    )
    sys.exit(2)


def _iterm2_running() -> bool:
    """Cheap check: iTerm2 must be running before the API will accept connections."""
    try:
        # `pgrep -x iTerm2` matches the main app process. The XPC helper has a different name.
        import subprocess

        r = subprocess.run(
            ["pgrep", "-x", "iTerm2"], capture_output=True, text=True, timeout=2
        )
        if r.returncode == 0 and r.stdout.strip():
            return True
        # Fallback: socket file appears once API is enabled and app is running.
        socket = os.path.expanduser(
            "~/Library/Application Support/iTerm2/private/socket"
        )
        return os.path.exists(socket)
    except Exception:
        return False


if not _iterm2_running():
    sys.stderr.write(
        "ccswarm: iTerm2 is not running. Open iTerm2 once and ensure "
        "Settings -> General -> Magic -> Enable Python API is on, then retry.\n"
    )
    sys.exit(3)


def emit(payload: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def start_stdin_reader(loop: asyncio.AbstractEventLoop, queue: "asyncio.Queue[str]") -> None:
    def _reader() -> None:
        for line in sys.stdin:
            line = line.rstrip("\n")
            if not line:
                continue
            asyncio.run_coroutine_threadsafe(queue.put(line), loop)
        asyncio.run_coroutine_threadsafe(queue.put(""), loop)  # EOF sentinel

    threading.Thread(target=_reader, daemon=True).start()


async def _split(parent: iterm2.Session, vertical: bool) -> iterm2.Session:
    """Split a pane, retrying briefly to dodge transient SDK races.

    The iterm2 SDK occasionally returns None or raises AssertionError when
    splits are issued back-to-back on a freshly created window because the
    pane graph is still settling. A short retry loop is enough.
    """
    last_exc: Exception | None = None
    for attempt in range(8):
        try:
            new = await parent.async_split_pane(vertical=vertical)
            if new is not None:
                return new
        except AssertionError as exc:
            last_exc = exc
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
        await asyncio.sleep(0.1 * (attempt + 1))
    raise RuntimeError(
        f"async_split_pane (vertical={vertical}) failed after retries: {last_exc!r}"
    )


async def create_grid(connection: iterm2.Connection, count: int) -> Dict[str, Any]:
    """Create a window with `count` panes arranged in a grid."""
    if count < 1:
        raise ValueError("count must be >= 1")
    cols = max(1, int(math.ceil(math.sqrt(count))))
    rows = int(math.ceil(count / cols))

    window = await iterm2.Window.async_create(connection)
    if window is None:
        raise RuntimeError("could not create iTerm2 window - is the Python API enabled?")

    # `window.current_tab.current_session` can be None right after creation;
    # the tab/session graph is populated asynchronously. Pull from tabs[0].
    first_session = None
    for _ in range(40):
        if window.tabs and window.tabs[0].sessions:
            first_session = window.tabs[0].sessions[0]
            break
        await asyncio.sleep(0.05)
    if first_session is None:
        raise RuntimeError("iTerm2 window has no initial session")

    sessions: List[iterm2.Session] = [first_session]
    grid: List[List[iterm2.Session]] = [[sessions[0]]]

    # Fill first row horizontally (vertical=True splits to the right).
    for _ in range(cols - 1):
        if len(sessions) >= count:
            break
        new = await _split(grid[0][-1], vertical=True)
        grid[0].append(new)
        sessions.append(new)

    # Subsequent rows: split the leftmost pane of the previous row downward,
    # then fill horizontally.
    for r in range(1, rows):
        if len(sessions) >= count:
            break
        new_left = await _split(grid[r - 1][0], vertical=False)
        grid.append([new_left])
        sessions.append(new_left)
        for _ in range(cols - 1):
            if len(sessions) >= count:
                break
            new = await _split(grid[r][-1], vertical=True)
            grid[r].append(new)
            sessions.append(new)

    sessions = sessions[:count]
    await window.async_activate()

    return {
        "window_id": window.window_id,
        "window_ids": [window.window_id],
        "session_ids": [s.session_id for s in sessions],
        "rows": rows,
        "cols": cols,
    }


async def create_windows(connection: iterm2.Connection, count: int) -> Dict[str, Any]:
    """Create `count` separate windows, tiled across the main screen."""
    if count < 1:
        raise ValueError("count must be >= 1")
    cols = max(1, int(math.ceil(math.sqrt(count))))
    rows = int(math.ceil(count / cols))

    windows: List[iterm2.Window] = []
    sessions: List[iterm2.Session] = []
    for _ in range(count):
        w = await iterm2.Window.async_create(connection)
        if w is None:
            raise RuntimeError("could not create iTerm2 window")
        windows.append(w)
        first = None
        for _try in range(40):
            if w.tabs and w.tabs[0].sessions:
                first = w.tabs[0].sessions[0]
                break
            await asyncio.sleep(0.05)
        if first is None:
            raise RuntimeError("iTerm2 window has no initial session")
        sessions.append(first)

    try:
        screen_w, screen_h, screen_x, screen_y = await _screen_frame()
    except Exception:
        screen_w, screen_h, screen_x, screen_y = 1440, 900, 0, 0

    cell_w = screen_w // cols
    cell_h = screen_h // rows
    for i, w in enumerate(windows):
        r = i // cols
        c = i % cols
        # Top-left in screen coords (origin top-left).
        top_left_x = screen_x + c * cell_w
        top_left_y = screen_y + r * cell_h
        # iterm2.util.Frame uses Cocoa coords (origin bottom-left).
        cocoa_y = (screen_y + screen_h) - top_left_y - cell_h
        frame = iterm2.util.Frame(
            origin=iterm2.util.Point(top_left_x, cocoa_y),
            size=iterm2.util.Size(cell_w, cell_h),
        )
        try:
            await w.async_set_frame(frame)
        except Exception as exc:  # noqa: BLE001
            sys.stderr.write(f"ccswarm: tile failed for {w.window_id}: {exc!r}\n")

    if windows:
        await windows[0].async_activate()

    return {
        "window_id": windows[0].window_id,
        "window_ids": [w.window_id for w in windows],
        "session_ids": [s.session_id for s in sessions],
        "rows": rows,
        "cols": cols,
    }


async def create_tabs(connection: iterm2.Connection, count: int) -> Dict[str, Any]:
    """Create one window with `count` tabs."""
    if count < 1:
        raise ValueError("count must be >= 1")
    window = await iterm2.Window.async_create(connection)
    if window is None:
        raise RuntimeError("could not create iTerm2 window")

    sessions: List[iterm2.Session] = []
    for _try in range(40):
        if window.tabs and window.tabs[0].sessions:
            sessions.append(window.tabs[0].sessions[0])
            break
        await asyncio.sleep(0.05)
    if not sessions:
        raise RuntimeError("iTerm2 window has no initial session")

    for _ in range(count - 1):
        tab = await window.async_create_tab()
        if tab is None or not tab.sessions:
            raise RuntimeError("could not create iTerm2 tab")
        sessions.append(tab.sessions[0])

    await window.async_activate()
    return {
        "window_id": window.window_id,
        "window_ids": [window.window_id],
        "session_ids": [s.session_id for s in sessions],
        "rows": 1,
        "cols": count,
    }


async def _screen_frame() -> tuple[int, int, int, int]:
    """Return (width, height, x, y) of the main screen's visible frame.

    Uses AppleScript via osascript so we don't need extra deps. Falls back to
    a safe default upstream if anything goes wrong.
    """
    script = (
        'tell application "Finder" to get bounds of window of desktop'
    )
    proc = await asyncio.create_subprocess_exec(
        "osascript", "-e", script,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    out, err = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(err.decode().strip() or "osascript failed")
    parts = [int(p.strip()) for p in out.decode().strip().split(",")]
    if len(parts) != 4:
        raise RuntimeError(f"unexpected bounds: {out!r}")
    x1, y1, x2, y2 = parts
    return (x2 - x1, y2 - y1, x1, y1)


async def send_text(connection: iterm2.Connection, session_id: str, text: str) -> Dict[str, Any]:
    app = await iterm2.async_get_app(connection)
    session = app.get_session_by_id(session_id)
    if session is None:
        raise RuntimeError(f"session {session_id} not found")
    await session.async_send_text(text)
    return {"sent": len(text)}


async def check_session_alive(connection: iterm2.Connection, session_id: str) -> Dict[str, Any]:
    app = await iterm2.async_get_app(connection)
    session = app.get_session_by_id(session_id)
    return {"alive": session is not None}


# xterm 256-color palette → (r, g, b), so standard/256 colors render with the
# right hue in the synthesized screenshot.
_ANSI16 = [
    (0, 0, 0), (205, 0, 0), (0, 205, 0), (205, 205, 0),
    (0, 0, 238), (205, 0, 205), (0, 205, 205), (229, 229, 229),
    (127, 127, 127), (255, 0, 0), (0, 255, 0), (255, 255, 0),
    (92, 92, 255), (255, 0, 255), (0, 255, 255), (255, 255, 255),
]
_CUBE = [0, 95, 135, 175, 215, 255]


def _xterm256(idx: int):
    if idx < 0:
        return None
    if idx < 16:
        return _ANSI16[idx]
    if idx < 232:
        i = idx - 16
        return (_CUBE[(i // 36) % 6], _CUBE[(i // 6) % 6], _CUBE[i % 6])
    if idx < 256:
        v = 8 + (idx - 232) * 10
        return (v, v, v)
    return None


def _color_hex(color) -> Any:
    """Map a CellStyle.Color to '#rrggbb', or None for default/alternate
    colors (so the renderer can apply the terminal's default fg/bg)."""
    if color is None:
        return None
    try:
        if color.is_rgb:
            c = color.rgb
            return "#%02x%02x%02x" % (c.red, c.green, c.blue)
        if color.is_standard:
            rgb = _xterm256(color.standard)
            return "#%02x%02x%02x" % rgb if rgb else None
    except Exception:
        return None
    return None


async def get_screen_contents(connection: iterm2.Connection, session_id: str) -> Dict[str, Any]:
    """Return the visible terminal text of a session as styled runs, so the
    synthesized screenshot preserves the terminal's colors. Works without the
    physical (possibly locked/closed-lid) display.

    Returns {"lines": [...plain text...], "styled": [[{t,f,b,bo}, ...], ...]}
    where each run is text `t`, foreground `f`, background `b` (hex or null),
    and bold `bo`."""
    app = await iterm2.async_get_app(connection)
    session = app.get_session_by_id(session_id)
    if session is None:
        raise RuntimeError(f"session {session_id} not found")
    contents = await session.async_get_screen_contents()
    lines: List[str] = []
    styled: List[List[Dict[str, Any]]] = []
    for i in range(contents.number_of_lines):
        try:
            line = contents.line(i)
        except Exception:
            lines.append("")
            styled.append([])
            continue
        # Walk the line cell by cell (not via .string): blank cells are encoded
        # as zero-code-point cells and drop out of .string, which collapses runs
        # of spaces and breaks column alignment. string_at() lets us recover them.
        runs: List[Dict[str, Any]] = []
        chars: List[str] = []
        cur = None
        cur_key = None
        for x in range(2000):  # bounded; string_at raises once past the last cell
            try:
                ch = line.string_at(x)
            except Exception:
                break
            if ch == "" or ch == "\x00":
                ch = " "  # blank/uninitialized cell → real space
            chars.append(ch)
            f = b = None
            bo = False
            try:
                st = line.style_at(x)
                if st is not None:
                    f = _color_hex(st.fg_color)
                    b = _color_hex(st.bg_color)
                    bo = bool(st.bold)
            except Exception:
                pass
            key = (f, b, bo)
            if cur is not None and cur_key == key:
                cur["t"] += ch
            else:
                cur = {"t": ch, "f": f, "b": b, "bo": bo}
                cur_key = key
                runs.append(cur)
        # Drop trailing padding (uncolored spaces) so tiles aren't over-wide.
        while runs and runs[-1]["t"].strip() == "" and not runs[-1]["b"]:
            runs.pop()
        lines.append("".join(chars).rstrip())
        styled.append(runs)
    # Trim trailing blank lines so the rendered image isn't mostly empty.
    while lines and not lines[-1].strip():
        lines.pop()
        styled.pop()
    return {"lines": lines, "styled": styled}


async def close_window(connection: iterm2.Connection, window_id: str) -> Dict[str, Any]:
    app = await iterm2.async_get_app(connection)
    for w in app.windows:
        if w.window_id == window_id:
            await w.async_close(force=True)
            return {"closed": True}
    return {"closed": False}


async def close_windows(connection: iterm2.Connection, window_ids: List[str]) -> Dict[str, Any]:
    app = await iterm2.async_get_app(connection)
    closed = 0
    for wid in window_ids:
        for w in app.windows:
            if w.window_id == wid:
                try:
                    await w.async_close(force=True)
                    closed += 1
                except Exception:
                    pass
                break
    return {"closed": closed}


async def dispatch(
    connection: iterm2.Connection, method: str, params: Dict[str, Any]
) -> Dict[str, Any]:
    if method == "ping":
        return {"pong": True}
    if method == "create_grid":
        return await create_grid(connection, int(params.get("count", 1)))
    if method == "create_windows":
        return await create_windows(connection, int(params.get("count", 1)))
    if method == "create_tabs":
        return await create_tabs(connection, int(params.get("count", 1)))
    if method == "send_text":
        return await send_text(connection, str(params["session_id"]), str(params["text"]))
    if method == "check_session_alive":
        return await check_session_alive(connection, str(params["session_id"]))
    if method == "get_screen_contents":
        return await get_screen_contents(connection, str(params["session_id"]))
    if method == "close_window":
        return await close_window(connection, str(params["window_id"]))
    if method == "close_windows":
        return await close_windows(connection, list(params.get("window_ids", [])))
    raise ValueError(f"unknown method: {method}")


async def main(connection: iterm2.Connection) -> None:
    loop = asyncio.get_running_loop()
    queue: "asyncio.Queue[str]" = asyncio.Queue()
    start_stdin_reader(loop, queue)
    # Construct the App singleton up front. This installs Session/Window/Tab
    # delegates that async_split_pane and async_create rely on (they assert
    # the delegate is set). Without this, the very first split after creating
    # a window fails with a bare AssertionError from inside the SDK.
    await iterm2.async_get_app(connection)
    emit({"id": "_ready", "ok": True, "result": {"ready": True}})
    while True:
        line = await queue.get()
        if line == "":
            return
        req: Any = None
        try:
            req = json.loads(line)
            rid = req.get("id")
            method = req["method"]
            params = req.get("params", {}) or {}
            result = await dispatch(connection, method, params)
            emit({"id": rid, "ok": True, "result": result})
        except Exception as exc:  # noqa: BLE001
            emit(
                {
                    "id": req.get("id") if isinstance(req, dict) else None,
                    "ok": False,
                    "error": f"{exc.__class__.__name__}: {exc}",
                    "trace": traceback.format_exc(),
                }
            )


if __name__ == "__main__":
    iterm2.run_until_complete(main, retry=True)
