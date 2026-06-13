# ultraswarm — Claude Code project config

## What this is
Electron app (main + renderer) that launches and orchestrates swarms of Claude Code agents inside iTerm2. The Python `resources/iterm-driver.py` controls iTerm2 via AppleScript; the Electron main process manages workspaces, agent profiles, and swarm coordination.

## Dev commands
```bash
npm run dev        # start Electron + Vite in watch mode
npm run build      # compile TS, bundle renderer, package Electron
npm run typecheck  # tsc --noEmit across all tsconfigs
npm run lint       # eslint
```

## Key paths
```
src/main/           — Electron main process (Node/TS)
src/renderer/       — React UI (Vite/TS)
src/preload/        — Electron preload bridge
src/main/presets/   — shipped agent profiles (seeded to ~/.ultraswarm/agents/ on first run)
src/main/template-presets/ — shipped swarm templates (seeded to ~/.ultraswarm/templates/)
resources/          — Python iterm-driver, AppleScript helpers
~/.ultraswarm/
  config.json       — main settings (pythonPath, swarm config, telegram, etc.)
  agents/           — user's agent profiles (copied from presets, editable)
  templates/        — user's swarm templates (copied from template-presets, editable)
  workspaces/       — per-task sandboxes created at launch
  runs/             — persisted run records (taskId → RunRecord JSON)
```

## Architecture
- **ITermDriver** — spawns `iterm-driver.py` as a child process, communicates via newline-delimited JSON RPC over stdio
- **SwarmController** — orchestrates launch/stop/resume of named agents inside a task workspace
- **ProfileStore** — CRUD for `~/.ultraswarm/agents/*.json`; seeds from `src/main/presets/` on init
- **SwarmTemplateStore** — CRUD for `~/.ultraswarm/templates/*.json`; seeds from `src/main/template-presets/` on init
- **SettingsStore** — loads/saves `~/.ultraswarm/config.json`
- **RunStore** — persists run records so sessions can be resumed after restart
- **WorkspaceManager** — creates per-task directory trees with shared/ and per-agent inboxes
- **TelegramBot** — optional notifications; configured via settings

## Adding a new agent preset
1. Add `src/main/presets/<name>.json` — must satisfy `ClientTemplateSchema` in `types.ts`
2. Also add the same object to `BUILTIN_PROFILES` in `setupCheck.ts` (keyed by filename) so it is seeded even when the agents dir already exists

## Adding a new swarm template
1. Add `src/main/template-presets/<name>.json` — must satisfy `SwarmTemplateSchema`
2. `SwarmTemplateStore.init()` calls `seedFromPresets()` unconditionally, so the new template will appear for existing users on next launch

## IPC channels (main ↔ renderer)
Defined in `index.ts::registerIpc()`. Prefix by domain:
`profiles:*`, `settings:*`, `templates:*`, `tasks:*`, `runs:*`, `dialog:*`, `shell:*`, `setup:*`, `telegram:*`

## Python path
Resolved at startup by `setupCheck.ts::findPython3()` — checks PATH, pyenv, uv, conda, homebrew versioned installs. The resolved path is stored in `config.json::pythonPath` and passed to `ITermDriver`.

## iTerm2
Required. `runSetup()` auto-installs via `brew install --cask iterm2` if brew is available. The `iterm-driver.py` uses the `iterm2` Python package (PyPI) — it must be installed in the resolved Python env.
