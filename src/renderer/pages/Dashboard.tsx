import React, { useEffect, useState } from 'react'
import { api, RunRecord, RunSummary, Settings, SwarmTemplate } from '../api'

export function Dashboard(): JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [templates, setTemplates] = useState<SwarmTemplate[]>([])
  const [tasks, setTasks] = useState<RunSummary[]>([])
  const [history, setHistory] = useState<RunRecord[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // New-task form state
  const [templateName, setTemplateName] = useState<string>('') // '' = use Settings → Swarm
  const [projectDir, setProjectDir] = useState<string>('')
  const [displayName, setDisplayName] = useState<string>('')

  async function refresh(): Promise<void> {
    const [s, list, running, runs] = await Promise.all([
      api().settings.load(),
      api().templates.list(),
      api().tasks.list(),
      api().runs.list()
    ])
    setSettings(s)
    setTemplates(list)
    setTasks(running)
    setHistory(runs)
  }

  useEffect(() => {
    refresh().catch((e) => setError(String(e)))
    const id = window.setInterval(() => {
      Promise.all([api().tasks.list(), api().runs.list()])
        .then(([t, r]) => {
          setTasks(t)
          setHistory(r)
        })
        .catch(() => {})
    }, 3000)
    return () => window.clearInterval(id)
  }, [])

  async function pickDir(): Promise<void> {
    const picked = await api().dialog.pickDirectory(projectDir || undefined)
    if (picked) setProjectDir(picked)
  }

  async function launch(): Promise<void> {
    if (!projectDir.trim()) {
      setError('Pick a working directory first.')
      return
    }
    if (!displayName.trim()) {
      setError('Give the task a name.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api().tasks.launch({
        templateName: templateName || null,
        projectDir: projectDir.trim(),
        displayName: displayName.trim()
      })
      setDisplayName('')
      await refresh()
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(false)
    }
  }

  async function stop(taskId: string): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await api().tasks.stop(taskId)
      await refresh()
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(false)
    }
  }

  if (!settings) return <div className="muted">Loading…</div>

  const selectedTemplate = templateName ? templates.find((t) => t.name === templateName) : null
  const settingsAgents = settings.swarm.agents
  const previewAgents = selectedTemplate ? selectedTemplate.agents : settingsAgents
  const previewClient = selectedTemplate ? selectedTemplate.clientTemplate : settings.swarm.clientTemplate

  return (
    <div>
      <div className="row">
        <h2>Tasks</h2>
        <span className="spacer" />
        <span className={`status-pill ${tasks.length ? 'run' : 'idle'}`}>
          {tasks.length ? `${tasks.length} running` : 'idle'}
        </span>
      </div>

      {error && (
        <div className="card" style={{ borderColor: '#6a3030', marginBottom: 12 }}>
          <div className="error">{error}</div>
        </div>
      )}

      <div className="card col">
        <div className="label">New task</div>

        <div className="row gap">
          <div style={{ flex: 1 }}>
            <span className="label">Template</span>
            <select value={templateName} onChange={(e) => setTemplateName(e.target.value)}>
              <option value="">(use Settings → Swarm)</option>
              {templates.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.displayName} — {t.agents.length}× {t.clientTemplate}
                </option>
              ))}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <span className="label">Task name</span>
            <input
              type="text"
              placeholder="e.g. add-pagination, fix-login-bug"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>
        </div>

        <div>
          <span className="label">Working directory (shared cwd for all agents)</span>
          <div className="row gap">
            <input
              type="text"
              style={{ flex: 1 }}
              placeholder="/path/to/repo"
              value={projectDir}
              onChange={(e) => setProjectDir(e.target.value)}
            />
            <button onClick={pickDir} disabled={busy}>
              Browse…
            </button>
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            Every agent in this task launches with this folder as its cwd, so they see and
            edit the same code.
          </div>
        </div>

        <div className="muted" style={{ fontSize: 12 }}>
          Will launch <strong>{previewAgents.length}</strong>× <span className="tag">{previewClient}</span>:{' '}
          {previewAgents.map((a) => (
            <span key={a.name} className="tag" style={{ marginRight: 4 }}>
              {a.name}
            </span>
          ))}
        </div>

        <div className="row">
          <button
            className="primary"
            onClick={launch}
            disabled={busy || !projectDir.trim() || !displayName.trim() || previewAgents.length === 0}
          >
            {busy ? 'Launching…' : 'Launch task'}
          </button>
        </div>
      </div>

      <div className="row" style={{ marginTop: 20 }}>
        <h3 style={{ margin: 0 }}>Running tasks</h3>
        <span className="spacer" />
        {tasks.length > 0 && (
          <button
            className="danger"
            disabled={busy}
            onClick={async () => {
              if (!confirm(`Stop all ${tasks.length} tasks?`)) return
              setBusy(true)
              try {
                await api().tasks.stopAll()
                await refresh()
              } finally {
                setBusy(false)
              }
            }}
          >
            Stop all
          </button>
        )}
      </div>

      {tasks.length === 0 ? (
        <div className="muted" style={{ marginTop: 8 }}>
          No tasks running. Fill the form above and hit Launch.
        </div>
      ) : (
        <div className="col" style={{ gap: 10, marginTop: 8 }}>
          {tasks.map((t) => (
            <div key={t.taskId} className="card col">
              <div className="row">
                <div className="col" style={{ gap: 2 }}>
                  <div style={{ fontSize: 16, fontWeight: 500 }}>{t.displayName}</div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {new Date(t.startedAt).toLocaleString()} · {t.agents.length} agents
                  </div>
                </div>
                <span className="spacer" />
                <button onClick={() => api().shell.openPath(t.projectDir)}>Open project</button>
                <button onClick={() => api().shell.openPath(t.workspaceDir)}>
                  Open workspace
                </button>
                <button className="danger" onClick={() => stop(t.taskId)} disabled={busy}>
                  Stop
                </button>
              </div>
              <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
                <span className="muted" style={{ fontSize: 12 }}>cwd:</span>
                <span className="tag">{t.projectDir}</span>
              </div>
              <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                {t.agents.map((a) => (
                  <span
                    key={a.name}
                    className="tag"
                    title={a.claudeSessionId ? `claude session: ${a.claudeSessionId}` : 'no session id'}
                  >
                    {a.name}
                    {a.claudeSessionId && (
                      <span className="muted" style={{ marginLeft: 6, fontSize: 10 }}>
                        {a.claudeSessionId.slice(0, 8)}
                      </span>
                    )}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="row" style={{ marginTop: 24 }}>
        <h3 style={{ margin: 0 }}>History</h3>
        <span className="spacer" />
      </div>
      {history.filter((h) => !tasks.find((t) => t.taskId === h.taskId)).length === 0 ? (
        <div className="muted" style={{ marginTop: 8 }}>
          Past runs will appear here.
        </div>
      ) : (
        <div className="col" style={{ gap: 6, marginTop: 8 }}>
          {history
            .filter((h) => !tasks.find((t) => t.taskId === h.taskId))
            .map((h) => (
              <div key={h.taskId} className="card col" style={{ gap: 4 }}>
                <div className="row">
                  <div className="col" style={{ gap: 2 }}>
                    <div style={{ fontWeight: 500 }}>{h.displayName}</div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {new Date(h.startedAt).toLocaleString()} · {h.status} ·{' '}
                      <span className="tag">{h.clientTemplate}</span> · {h.agents.length} agents
                    </div>
                  </div>
                  <span className="spacer" />
                  <button onClick={() => api().shell.openPath(h.workspaceDir)}>Open workspace</button>
                  <button
                    className="primary"
                    disabled={busy || h.status !== 'stopped' || !h.agents.some((a) => a.claudeSessionId)}
                    title={
                      h.status !== 'stopped'
                        ? 'Run already in progress'
                        : !h.agents.some((a) => a.claudeSessionId)
                        ? 'No saved Claude session ids — cannot resume'
                        : 'Reopen panes and continue each agent\'s chat'
                    }
                    onClick={async () => {
                      setBusy(true)
                      setError(null)
                      try {
                        await api().tasks.resume(h.taskId)
                        await refresh()
                      } catch (e) {
                        setError(String(e instanceof Error ? e.message : e))
                      } finally {
                        setBusy(false)
                      }
                    }}
                  >
                    Resume
                  </button>
                  <button
                    className="danger"
                    onClick={async () => {
                      if (!confirm(`Delete run record for "${h.displayName}"? Workspace files stay on disk.`)) return
                      await api().runs.delete(h.taskId)
                      await refresh()
                    }}
                  >
                    Forget
                  </button>
                </div>
                <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                  {h.agents.map((a) => (
                    <span
                      key={a.name}
                      className="tag"
                      title={a.claudeSessionId ? `claude session: ${a.claudeSessionId}` : 'no session id'}
                    >
                      {a.name}
                      {a.claudeSessionId && (
                        <span className="muted" style={{ marginLeft: 6, fontSize: 10 }}>
                          {a.claudeSessionId.slice(0, 8)}
                        </span>
                      )}
                    </span>
                  ))}
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  )
}
