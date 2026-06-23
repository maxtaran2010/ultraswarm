import React, { useEffect, useState } from 'react'
import { api, ClientTemplate, SwarmAgent, SwarmTemplate } from '../api'

const NAME_RE = /^[a-zA-Z0-9_-]+$/

const BLANK: SwarmTemplate = {
  name: 'new-template',
  displayName: 'New Template',
  description: '',
  agents: [
    { name: 'agent-1', role: '' },
    { name: 'agent-2', role: '' }
  ]
}

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

export function Templates(): JSX.Element {
  const [templates, setTemplates] = useState<SwarmTemplate[]>([])
  const [profiles, setProfiles] = useState<ClientTemplate[]>([])
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const [draft, setDraft] = useState<SwarmTemplate | null>(null)
  const [original, setOriginal] = useState<SwarmTemplate | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function refresh(keepName?: string): Promise<void> {
    const [list, profs] = await Promise.all([api().templates.list(), api().profiles.list()])
    setTemplates(list)
    setProfiles(profs)
    const name = keepName ?? selectedName ?? list[0]?.name ?? null
    if (name) selectTemplate(name, list)
    else {
      setSelectedName(null)
      setDraft(null)
      setOriginal(null)
    }
  }

  useEffect(() => {
    refresh().catch((e) => setError(String(e)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function selectTemplate(name: string, list: SwarmTemplate[] = templates): void {
    const found = list.find((t) => t.name === name) || null
    setSelectedName(found ? found.name : null)
    setDraft(found ? structuredClone(found) : null)
    setOriginal(found ? structuredClone(found) : null)
    setError(null)
    setInfo(null)
  }

  function newTemplate(): void {
    setSelectedName(null)
    setDraft(structuredClone(BLANK))
    setOriginal(null)
    setError(null)
    setInfo(null)
  }

  function duplicate(): void {
    if (!draft) return
    const copy = structuredClone(draft)
    copy.name = `${copy.name}-copy`
    copy.displayName = `${copy.displayName} (copy)`
    setSelectedName(null)
    setDraft(copy)
    setOriginal(null)
    setInfo(null)
  }

  async function save(): Promise<void> {
    if (!draft) return
    const agentErr = validateAgents(draft.agents)
    if (agentErr) {
      setError(agentErr)
      return
    }
    setBusy(true)
    setError(null)
    setInfo(null)
    try {
      const saved = await api().templates.save(draft)
      await refresh(saved.name)
      setInfo('Saved.')
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(false)
    }
  }

  async function remove(): Promise<void> {
    if (!selectedName) return
    if (!confirm(`Delete template '${selectedName}'?`)) return
    setBusy(true)
    setError(null)
    try {
      await api().templates.delete(selectedName)
      await refresh(undefined)
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(false)
    }
  }

  async function apply(): Promise<void> {
    if (!selectedName) return
    setBusy(true)
    setError(null)
    setInfo(null)
    try {
      await api().templates.apply(selectedName)
      setInfo(`Applied '${selectedName}' to current swarm settings.`)
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(false)
    }
  }

  function patch(p: Partial<SwarmTemplate>): void {
    if (!draft) return
    setDraft({ ...draft, ...p })
  }

  function patchAgent(i: number, p: Partial<SwarmAgent>): void {
    if (!draft) return
    const agents = draft.agents.map((a, idx) => (idx === i ? { ...a, ...p } : a))
    patch({ agents })
  }

  function addAgent(): void {
    if (!draft) return
    const used = new Set(draft.agents.map((a) => a.name))
    let n = draft.agents.length + 1
    while (used.has(`agent-${n}`)) n++
    patch({ agents: [...draft.agents, { name: `agent-${n}`, role: '' }] })
  }

  function removeAgent(i: number): void {
    if (!draft) return
    if (draft.agents.length <= 1) return
    patch({ agents: draft.agents.filter((_, idx) => idx !== i) })
  }

  const dirty = draft && JSON.stringify(draft) !== JSON.stringify(original)

  return (
    <div>
      <div className="row">
        <h2>Templates</h2>
        <span className="spacer" />
        <button onClick={newTemplate}>New</button>
        <button onClick={duplicate} disabled={!draft}>
          Duplicate
        </button>
      </div>

      <div className="muted" style={{ marginBottom: 12, fontSize: 12 }}>
        A template defines a named team with role prompts. The client config and window
        layout are chosen separately when you launch a task. Hit{' '}
        <strong>Apply to swarm</strong> to copy this team into Settings → Swarm as the
        default.
      </div>

      <div className="row gap" style={{ alignItems: 'flex-start' }}>
        <div className="col" style={{ width: 260 }}>
          <div className="label">Available templates</div>
          <div className="list">
            {templates.map((t) => (
              <div
                key={t.name}
                className={`list-row ${selectedName === t.name ? 'selected' : ''}`}
                onClick={() => selectTemplate(t.name)}
                style={{ cursor: 'pointer' }}
              >
                <div>
                  <div>{t.displayName}</div>
                  <div className="muted" style={{ fontSize: 11 }}>
                    {t.agents.length} agents
                  </div>
                </div>
                <span className="spacer" />
              </div>
            ))}
            {templates.length === 0 && (
              <div className="list-row muted">No templates yet — hit New.</div>
            )}
          </div>
        </div>

        {draft ? (
          <div className="col" style={{ flex: 1 }}>
            <div className="row gap">
              <div style={{ flex: 1 }}>
                <span className="label">Name (id)</span>
                <input
                  type="text"
                  value={draft.name}
                  onChange={(e) => patch({ name: e.target.value })}
                  placeholder="kebab-id"
                />
              </div>
              <div style={{ flex: 1 }}>
                <span className="label">Display name</span>
                <input
                  type="text"
                  value={draft.displayName}
                  onChange={(e) => patch({ displayName: e.target.value })}
                />
              </div>
            </div>

            <div>
              <span className="label">Description</span>
              <textarea
                rows={2}
                value={draft.description}
                onChange={(e) => patch({ description: e.target.value })}
                placeholder="What is this swarm for?"
              />
            </div>

            <div>
              <div className="row">
                <span className="label">Agents</span>
                <span className="spacer" />
                <button onClick={addAgent}>Add agent</button>
              </div>
              <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                Each agent gets its own name, client config, and role prompt. Names must be
                unique. Leave a role blank to fall back to the config's{' '}
                <span className="tag">initialPrompt</span>. Set <strong>Client</strong> per
                agent to mix CLIs in one swarm (e.g. codex + claude-code); leave it on{' '}
                <span className="tag">(launch default)</span> to use whatever client config is
                chosen on the dashboard.
              </div>
              <div className="col" style={{ gap: 8 }}>
                {draft.agents.map((a, i) => (
                  <div key={i} className="row" style={{ alignItems: 'flex-start', gap: 6 }}>
                    <div className="col" style={{ gap: 4, width: 180 }}>
                      <input
                        type="text"
                        placeholder="agent-name"
                        value={a.name}
                        onChange={(e) => patchAgent(i, { name: e.target.value })}
                      />
                      <select
                        value={a.clientTemplate ?? ''}
                        title="Which CLI this agent runs"
                        onChange={(e) =>
                          patchAgent(i, { clientTemplate: e.target.value || undefined })
                        }
                      >
                        <option value="">(launch default)</option>
                        {profiles.map((p) => (
                          <option key={p.name} value={p.name}>
                            {p.displayName} ({p.name})
                          </option>
                        ))}
                        {a.clientTemplate && !profiles.some((p) => p.name === a.clientTemplate) && (
                          <option value={a.clientTemplate}>{a.clientTemplate} (missing)</option>
                        )}
                      </select>
                    </div>
                    <textarea
                      rows={3}
                      style={{ flex: 1 }}
                      placeholder="(use config prompt)"
                      value={a.role}
                      onChange={(e) => patchAgent(i, { role: e.target.value })}
                    />
                    <button
                      className="danger"
                      onClick={() => removeAgent(i)}
                      disabled={draft.agents.length <= 1}
                      title={draft.agents.length <= 1 ? 'Need at least one agent' : 'Remove'}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {error && <div className="error">{error}</div>}
            {info && (
              <div className="muted" style={{ fontSize: 12 }}>
                {info}
              </div>
            )}

            <div className="row" style={{ marginTop: 8 }}>
              <button className="primary" onClick={save} disabled={busy || !dirty}>
                {busy ? 'Saving…' : 'Save'}
              </button>
              <button onClick={apply} disabled={busy || !selectedName || !!dirty}>
                Apply to swarm
              </button>
              <button className="danger" onClick={remove} disabled={busy || !selectedName}>
                Delete
              </button>
              {!!dirty && selectedName && (
                <span className="muted" style={{ fontSize: 12 }}>
                  Save before applying.
                </span>
              )}
            </div>
          </div>
        ) : (
          <div className="col" style={{ flex: 1 }}>
            <div className="muted">Pick a template on the left or hit New.</div>
            {error && <div className="error">{error}</div>}
          </div>
        )}
      </div>
    </div>
  )
}
