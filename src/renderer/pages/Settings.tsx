import React, { useEffect, useState } from 'react'
import { api, ClientTemplate, Settings as SettingsT, SwarmAgent } from '../api'

type Tab = 'swarm' | 'configs' | 'gateway' | 'protocol' | 'telegram' | 'general'

const BLANK_CONFIG: ClientTemplate = {
  name: 'new-client',
  displayName: 'New Client',
  command: 'bash',
  args: ['-i'],
  env: {},
  cwd: '${workspace}/agents/${name}',
  initialPrompt: '',
  readyDelayMs: 1500
}

const NAME_RE = /^[a-zA-Z0-9_-]+$/

function validateAgents(agents: SwarmAgent[]): string | null {
  if (agents.length === 0) return 'At least one agent is required.'
  const names = new Set<string>()
  for (const a of agents) {
    if (!a.name.trim()) return 'Every agent needs a name.'
    if (!NAME_RE.test(a.name)) {
      return `Invalid name '${a.name}': use letters, digits, dashes, underscores only.`
    }
    if (names.has(a.name)) return `Duplicate agent name '${a.name}'.`
    names.add(a.name)
  }
  return null
}

export function Settings(): JSX.Element {
  const [settings, setSettings] = useState<SettingsT | null>(null)
  const [draft, setDraft] = useState<SettingsT | null>(null)
  const [configs, setConfigs] = useState<ClientTemplate[]>([])
  const [tab, setTab] = useState<Tab>('swarm')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  // Configs tab state
  const [selectedConfigName, setSelectedConfigName] = useState<string | null>(null)
  const [configDraft, setConfigDraft] = useState<string>('')
  const [configDirty, setConfigDirty] = useState(false)
  const [configError, setConfigError] = useState<string | null>(null)

  // Telegram tab state
  const [tgTesting, setTgTesting] = useState(false)
  const [tgTestMsg, setTgTestMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    Promise.all([api().settings.load(), api().profiles.list()])
      .then(([s, list]) => {
        setSettings(s)
        setDraft(s)
        setConfigs(list)
        if (list.length > 0) selectConfig(list[0].name, list)
      })
      .catch((e) => setError(String(e)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function save(): Promise<void> {
    if (!draft) return
    const agentErr = validateAgents(draft.swarm.agents)
    if (agentErr) {
      setError(agentErr)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const saved = await api().settings.save(draft)
      setSettings(saved)
      setDraft(saved)
      setSavedAt(Date.now())
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(false)
    }
  }

  function reset(): void {
    if (settings) setDraft(settings)
  }

  async function refreshConfigs(keepName?: string): Promise<void> {
    const list = await api().profiles.list()
    setConfigs(list)
    const name = keepName ?? selectedConfigName ?? list[0]?.name ?? null
    if (name) selectConfig(name, list)
    else {
      setSelectedConfigName(null)
      setConfigDraft('')
      setConfigDirty(false)
    }
  }

  function selectConfig(name: string, list: ClientTemplate[] = configs): void {
    const found = list.find((p) => p.name === name) || null
    setSelectedConfigName(found ? found.name : null)
    setConfigDraft(found ? JSON.stringify(found, null, 2) : '')
    setConfigDirty(false)
    setConfigError(null)
  }

  async function saveConfig(): Promise<void> {
    setConfigError(null)
    let parsed: ClientTemplate
    try {
      parsed = JSON.parse(configDraft)
    } catch (e) {
      setConfigError(`Invalid JSON: ${e instanceof Error ? e.message : e}`)
      return
    }
    try {
      const saved = await api().profiles.save(parsed)
      await refreshConfigs(saved.name)
    } catch (e) {
      setConfigError(String(e instanceof Error ? e.message : e))
    }
  }

  async function deleteConfig(): Promise<void> {
    if (!selectedConfigName) return
    if (!confirm(`Delete config '${selectedConfigName}'?`)) return
    await api().profiles.delete(selectedConfigName)
    await refreshConfigs(undefined)
  }

  function newConfig(): void {
    setSelectedConfigName(null)
    setConfigDraft(JSON.stringify(BLANK_CONFIG, null, 2))
    setConfigDirty(true)
    setConfigError(null)
  }

  function duplicateConfig(): void {
    if (!selectedConfigName) return
    try {
      const obj = JSON.parse(configDraft) as ClientTemplate
      obj.name = `${obj.name}-copy`
      obj.displayName = `${obj.displayName} (copy)`
      setSelectedConfigName(null)
      setConfigDraft(JSON.stringify(obj, null, 2))
      setConfigDirty(true)
    } catch {
      setConfigError('Cannot duplicate: current draft is invalid JSON.')
    }
  }

  if (!draft) return <div className="muted">Loading…</div>

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings)
  const swarm = draft.swarm

  function setSwarm(patch: Partial<typeof swarm>): void {
    setDraft({ ...draft!, swarm: { ...draft!.swarm, ...patch } })
  }

  function patchAgent(i: number, p: Partial<SwarmAgent>): void {
    const agents = swarm.agents.map((a, idx) => (idx === i ? { ...a, ...p } : a))
    setSwarm({ agents })
  }

  function addAgent(): void {
    const used = new Set(swarm.agents.map((a) => a.name))
    let n = swarm.agents.length + 1
    while (used.has(`agent-${n}`)) n++
    setSwarm({ agents: [...swarm.agents, { name: `agent-${n}`, role: '' }] })
  }

  function removeAgent(i: number): void {
    if (swarm.agents.length <= 1) return
    setSwarm({ agents: swarm.agents.filter((_, idx) => idx !== i) })
  }

  return (
    <div>
      <h2>Settings</h2>

      <div className="tabs">
        <button className={tab === 'swarm' ? 'active' : ''} onClick={() => setTab('swarm')}>
          Swarm
        </button>
        <button className={tab === 'configs' ? 'active' : ''} onClick={() => setTab('configs')}>
          Configs
        </button>
        <button className={tab === 'gateway' ? 'active' : ''} onClick={() => setTab('gateway')}>
          Gateway / Workspace
        </button>
        <button className={tab === 'protocol' ? 'active' : ''} onClick={() => setTab('protocol')}>
          Protocol Prompt
        </button>
        <button className={tab === 'telegram' ? 'active' : ''} onClick={() => setTab('telegram')}>
          Telegram
        </button>
        <button className={tab === 'general' ? 'active' : ''} onClick={() => setTab('general')}>
          General
        </button>
      </div>

      {tab === 'swarm' && (
        <div className="card col">
          <div>
            <span className="label">Client config</span>
            <select
              value={swarm.clientTemplate}
              onChange={(e) => setSwarm({ clientTemplate: e.target.value })}
            >
              {configs.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.displayName} ({t.name})
                </option>
              ))}
              {!configs.find((t) => t.name === swarm.clientTemplate) && (
                <option value={swarm.clientTemplate}>{swarm.clientTemplate} (missing)</option>
              )}
            </select>
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              Edit configs in the Configs tab.
            </div>
          </div>

          <div>
            <span className="label">Window layout</span>
            <select
              value={swarm.windowMode}
              onChange={(e) =>
                setSwarm({ windowMode: e.target.value as 'grid' | 'windows' | 'tabs' })
              }
            >
              <option value="grid">Single window, split into panes (grid)</option>
              <option value="windows">Separate windows, tiled across screen</option>
              <option value="tabs">Single window, one tab per agent</option>
            </select>
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              <strong>windows</strong> places one iTerm2 window per agent and tiles them in a
              ⌈√N⌉×⌈N/√N⌉ layout on the main screen.
            </div>
          </div>

          <div>
            <div className="row">
              <span className="label">Agents</span>
              <span className="spacer" />
              <button onClick={addAgent}>Add agent</button>
            </div>
            <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
              Each agent gets its own name and role prompt. Names must be unique. Leave a
              role blank to fall back to the config's{' '}
              <span className="tag">initialPrompt</span>.
            </div>
            <div className="col" style={{ gap: 6 }}>
              {swarm.agents.map((a, i) => (
                <div key={i} className="row" style={{ alignItems: 'flex-start', gap: 6 }}>
                  <input
                    type="text"
                    style={{ width: 160 }}
                    placeholder="agent-name"
                    value={a.name}
                    onChange={(e) => patchAgent(i, { name: e.target.value })}
                  />
                  <textarea
                    rows={2}
                    style={{ flex: 1 }}
                    placeholder="(use config prompt)"
                    value={a.role}
                    onChange={(e) => patchAgent(i, { role: e.target.value })}
                  />
                  <button
                    className="danger"
                    onClick={() => removeAgent(i)}
                    disabled={swarm.agents.length <= 1}
                    title={swarm.agents.length <= 1 ? 'Need at least one agent' : 'Remove'}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {tab === 'configs' && (
        <div className="card col">
          <div className="muted" style={{ fontSize: 12 }}>
            Each config defines how to launch one instance of an agent CLI
            (claude-code, codex, hermes, bash, …). Pick which config the swarm uses in
            the <strong>Swarm</strong> tab, or via a Template on the Templates page.
          </div>

          <div className="row gap" style={{ alignItems: 'flex-start' }}>
            <div className="col" style={{ width: 240 }}>
              <div className="row">
                <span className="label">Configs</span>
                <span className="spacer" />
                <button onClick={newConfig}>New</button>
                <button onClick={duplicateConfig} disabled={!selectedConfigName}>
                  Duplicate
                </button>
              </div>
              <div className="list">
                {configs.map((p) => (
                  <div
                    key={p.name}
                    className={`list-row ${selectedConfigName === p.name ? 'selected' : ''}`}
                    onClick={() => selectConfig(p.name)}
                    style={{ cursor: 'pointer' }}
                  >
                    <div>
                      <div>{p.displayName}</div>
                      <div className="muted" style={{ fontSize: 11 }}>
                        {p.name}
                      </div>
                    </div>
                    <span className="spacer" />
                  </div>
                ))}
              </div>
            </div>

            <div className="col" style={{ flex: 1 }}>
              <div className="label">Config JSON</div>
              <textarea
                rows={22}
                value={configDraft}
                onChange={(e) => {
                  setConfigDraft(e.target.value)
                  setConfigDirty(true)
                }}
              />
              {configError && <div className="error">{configError}</div>}
              <div className="row">
                <button
                  className="primary"
                  onClick={saveConfig}
                  disabled={!configDirty && !!selectedConfigName}
                >
                  Save config
                </button>
                <button className="danger" onClick={deleteConfig} disabled={!selectedConfigName}>
                  Delete
                </button>
              </div>
              <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
                Variables in <span className="tag">cwd</span>:{' '}
                <span className="tag">{'${workspace}'}</span>{' '}
                <span className="tag">{'${name}'}</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {tab === 'gateway' && (
        <div className="card col">
          <div>
            <span className="label">Workspace root</span>
            <input
              type="text"
              value={draft.workspaceRoot}
              onChange={(e) => setDraft({ ...draft, workspaceRoot: e.target.value })}
            />
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              Each run creates a timestamped subdirectory here with per-agent inbox/outbox folders.
            </div>
          </div>
          <div>
            <span className="label">Terminal</span>
            <select
              value={draft.terminal}
              onChange={(e) => setDraft({ ...draft, terminal: e.target.value as 'iterm2' })}
            >
              <option value="iterm2">iTerm2</option>
            </select>
          </div>
          <div>
            <span className="label">Python interpreter</span>
            <input
              type="text"
              value={draft.pythonPath}
              onChange={(e) => setDraft({ ...draft, pythonPath: e.target.value })}
            />
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              Used to run the iTerm2 driver. Must have the <span className="tag">iterm2</span> package installed.
            </div>
          </div>
        </div>
      )}

      {tab === 'protocol' && (
        <div className="card col">
          <div>
            <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
              <span className="label">
                Global protocol prompt (injected into each agent at start)
              </span>
              <button
                className="btn"
                onClick={async () => {
                  const def = await api().settings.defaultProtocol()
                  if (def === draft.protocolTemplate) return
                  if (
                    !window.confirm(
                      'Replace the current protocol prompt with the built-in default? Your current text will be lost.'
                    )
                  )
                    return
                  setDraft({ ...draft, protocolTemplate: def })
                }}
              >
                Reset to default
              </button>
            </div>
            <textarea
              rows={22}
              value={draft.protocolTemplate}
              onChange={(e) => setDraft({ ...draft, protocolTemplate: e.target.value })}
            />
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              Variables: <span className="tag">{'{{agent_name}}'}</span>{' '}
              <span className="tag">{'{{inbox}}'}</span>{' '}
              <span className="tag">{'{{outbox}}'}</span>{' '}
              <span className="tag">{'{{shared_dir}}'}</span>{' '}
              <span className="tag">{'{{workspace}}'}</span>{' '}
              <span className="tag">{'{{peers_list}}'}</span>
            </div>
          </div>
        </div>
      )}

      {tab === 'telegram' && (
        <div className="card col">
          <div className="muted" style={{ fontSize: 12 }}>
            Get notifications when a swarm starts/stops and check status from
            your phone. Create a bot via{' '}
            <span className="tag">@BotFather</span> on Telegram, paste the
            token below, then send <span className="tag">/start</span> to your
            bot — the chat id auto-binds on first message.
          </div>
          <label className="row">
            <input
              type="checkbox"
              checked={draft.telegram.enabled}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  telegram: { ...draft.telegram, enabled: e.target.checked }
                })
              }
            />
            <span>Enable Telegram bot</span>
          </label>
          <div>
            <span className="label">Bot token</span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="123456:ABC-..."
              value={draft.telegram.botToken}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  telegram: { ...draft.telegram, botToken: e.target.value }
                })
              }
            />
          </div>
          <div>
            <span className="label">Chat id</span>
            <input
              type="text"
              spellCheck={false}
              placeholder="(empty — bound on first /start to bot)"
              value={draft.telegram.chatId}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  telegram: { ...draft.telegram, chatId: e.target.value }
                })
              }
            />
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              Only this chat can issue commands. Leave blank and ultraswarm will
              fill it in when you message the bot.
            </div>
          </div>
          <div className="row">
            <button
              disabled={tgTesting || !draft.telegram.botToken}
              onClick={async () => {
                setTgTesting(true)
                setTgTestMsg(null)
                try {
                  const res = await api().telegram.test(
                    draft.telegram.botToken,
                    draft.telegram.chatId
                  )
                  setTgTestMsg({
                    ok: true,
                    text: draft.telegram.chatId
                      ? `Connected as @${res.username}. Test message sent.`
                      : `Connected as @${res.username}. No chat id yet — open Telegram and /start the bot.`
                  })
                } catch (e) {
                  setTgTestMsg({
                    ok: false,
                    text: String(e instanceof Error ? e.message : e)
                  })
                } finally {
                  setTgTesting(false)
                }
              }}
            >
              {tgTesting ? 'Testing…' : 'Test'}
            </button>
            {tgTestMsg && (
              <span
                className={tgTestMsg.ok ? 'muted' : 'error'}
                style={{ fontSize: 12 }}
              >
                {tgTestMsg.text}
              </span>
            )}
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            Bot commands:{' '}
            {['/status', '/agents', '/inbox', '/sent', '/log', '/msg', '/snap', '/help'].map((c) => (
              <span key={c} className="tag" style={{ marginRight: 4 }}>{c}</span>
            ))}
          </div>
        </div>
      )}

      {tab === 'general' && (
        <div className="card col">
          <label className="row">
            <input
              type="checkbox"
              checked={draft.general.autoStart}
              onChange={(e) =>
                setDraft({ ...draft, general: { ...draft.general, autoStart: e.target.checked } })
              }
            />
            <span>Launch swarm on app start</span>
          </label>
          <label className="row">
            <input
              type="checkbox"
              checked={draft.general.preventSleep ?? false}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  general: { ...draft.general, preventSleep: e.target.checked }
                })
              }
            />
            <span>Prevent display sleep while app is running</span>
          </label>
          <label className="row">
            <input
              type="checkbox"
              checked={draft.general.keepAwakeWithLidClosed ?? false}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  general: { ...draft.general, keepAwakeWithLidClosed: e.target.checked }
                })
              }
            />
            <span>Keep Mac awake with lid closed while agents run (screen still sleeps)</span>
          </label>
          <div className="muted" style={{ fontSize: 11, marginTop: -4, marginLeft: 24 }}>
            While a task is running, prevents system sleep so closing the lid won&apos;t pause
            agents — on AC and battery. Asks for your admin password once (uses{' '}
            <code>pmset disablesleep</code>); automatically reverted when agents finish or the app
            quits.
          </div>
          <div>
            <span className="label">Terminal font size</span>
            <input
              type="number"
              value={draft.general.fontSize}
              min={8}
              max={48}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  general: { ...draft.general, fontSize: Number(e.target.value) }
                })
              }
            />
          </div>
        </div>
      )}

      {tab !== 'configs' && (
        <div className="row" style={{ marginTop: 16 }}>
          <button className="primary" disabled={!dirty || busy} onClick={save}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button disabled={!dirty || busy} onClick={reset}>
            Reset
          </button>
          {savedAt && !dirty && (
            <span className="muted" style={{ fontSize: 12 }}>
              Saved {new Date(savedAt).toLocaleTimeString()}
            </span>
          )}
          {error && <span className="error">{error}</span>}
        </div>
      )}
    </div>
  )
}
