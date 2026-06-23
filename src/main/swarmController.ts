import { ProfileStore } from './profileStore'
import { SettingsStore } from './settingsStore'
import { SwarmTemplateStore } from './swarmTemplateStore'
import { RunStore } from './runStore'
import { WorkspaceManager, Workspace } from './workspaceManager'
import { ITermDriver, StyledRun } from './itermDriver'
import { AgentProfile, LaunchTaskRequest, RunSummary, Settings, SwarmAgent } from './types'
import { promises as fs, watch, FSWatcher } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { randomUUID } from 'crypto'

interface ActiveRun {
  taskId: string
  displayName: string
  projectDir: string
  windowIds: string[]
  workspace: Workspace
  agents: Array<{ name: string; sessionId: string; claudeSessionId: string | null }>
  startedAt: string
  watchers: FSWatcher[]
  exitPoller?: NodeJS.Timeout
  /** Cleared once the exit poller observes every agent's iTerm session is gone. */
  live?: boolean
}

/** A single agent pane's captured terminal contents (plain + styled runs). */
export interface AgentScreen {
  taskId: string
  displayName: string
  agent: string
  lines: string[]
  styled?: StyledRun[][]
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

function substituteSessionId(args: string[], sessionId: string): string[] {
  return args.map((a) => a.replace(/\{\{\s*session_id\s*\}\}/g, sessionId))
}

function buildLaunchCommand(
  profile: AgentProfile,
  cwd: string,
  extraEnv: Record<string, string>,
  pathPrefix: string,
  sessionId: string,
  argsOverride?: string[]
): string {
  const env = { ...profile.env, ...extraEnv }
  const exports = Object.entries(env)
    .map(([k, v]) => `export ${k}=${shellEscape(v)}`)
    .join('; ')
  // Prepend the per-run bin/ so `swarm-msg` is on PATH for the agent shell.
  const pathExport = `export PATH=${shellEscape(pathPrefix)}":$PATH"`
  const baseArgs = argsOverride ?? profile.args
  const resolvedArgs = substituteSessionId(baseArgs, sessionId)
  const argv = [profile.command, ...resolvedArgs].map(shellEscape).join(' ')
  const cd = `cd ${shellEscape(cwd)}`
  const head = exports ? `${exports}; ${pathExport}; ${cd}` : `${pathExport}; ${cd}`
  return `${head}; clear; ${argv}\r`
}

interface ResolvedComposition {
  agents: SwarmAgent[]
  windowMode: Settings['swarm']['windowMode']
  clientTemplate: string
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Encode a cwd into the directory name Claude Code uses under
 * `~/.claude/projects/<encoded>/`. Claude replaces `/` with `-`, so
 * `/Users/maksim/Documents` → `-Users-maksim-Documents`.
 */
function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/\//g, '-')
}

/**
 * After we've dispatched the protocol to every agent, Claude Code will have
 * written a session log per pane under `~/.claude/projects/<encoded-cwd>/`.
 * The filename is the real sessionId Claude assigned (it ignores our
 * `--session-id` flag for interactive sessions). We scan those files for the
 * per-agent marker we baked into the protocol prompt and return a map of
 * agent name → real sessionId. Best-effort; missing entries stay null.
 */
async function discoverRealSessionIds(
  cwd: string,
  taskId: string,
  agentNames: string[],
  workspaces: WorkspaceManager,
  timeoutMs = 15_000,
  pollMs = 500
): Promise<Record<string, string | null>> {
  const dir = join(homedir(), '.claude', 'projects', encodeClaudeProjectDir(cwd))
  const result: Record<string, string | null> = {}
  for (const n of agentNames) result[n] = null

  const markers: Record<string, string> = {}
  for (const n of agentNames) markers[n] = workspaces.agentMarker(taskId, n)

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    let files: string[] = []
    try {
      files = (await fs.readdir(dir)).filter((f) => f.endsWith('.jsonl'))
    } catch {
      files = []
    }
    for (const f of files) {
      const sid = f.replace(/\.jsonl$/, '')
      // Skip files we've already matched.
      if (Object.values(result).includes(sid)) continue
      let content = ''
      try {
        content = await fs.readFile(join(dir, f), 'utf8')
      } catch {
        continue
      }
      for (const name of agentNames) {
        if (result[name]) continue
        if (content.includes(markers[name])) {
          result[name] = sid
          break
        }
      }
    }
    if (agentNames.every((n) => result[n])) return result
    await delay(pollMs)
  }
  return result
}

export class SwarmController {
  private active = new Map<string, ActiveRun>()
  onEvent?: (event: { type: 'agents_exited'; taskId: string; displayName: string }) => void
  /** Fired whenever the set of runs with live agents changes (launch/stop/exit). */
  onActiveChange?: () => void

  /** True while at least one launched run still has live agents. */
  hasLiveAgents(): boolean {
    return Array.from(this.active.values()).some((r) => r.live !== false && r.agents.length > 0)
  }

  private notifyActiveChange(): void {
    try {
      this.onActiveChange?.()
    } catch (e) {
      console.error('[SwarmController] onActiveChange handler failed:', e)
    }
  }

  constructor(
    private profiles: ProfileStore,
    private settings: SettingsStore,
    private templates: SwarmTemplateStore,
    private workspaces: WorkspaceManager,
    private driver: ITermDriver,
    private runs: RunStore
  ) {}

  list(): RunSummary[] {
    return Array.from(this.active.values()).map((r) => this.toSummary(r))
  }

  private toSummary(r: ActiveRun): RunSummary {
    return {
      taskId: r.taskId,
      displayName: r.displayName,
      projectDir: r.projectDir,
      runId: r.workspace.runId,
      startedAt: r.startedAt,
      workspaceDir: r.workspace.root,
      windowId: r.windowIds[0] ?? null,
      windowIds: r.windowIds,
      agents: r.agents.map((a) => ({
        name: a.name,
        sessionId: a.sessionId,
        claudeSessionId: a.claudeSessionId
      }))
    }
  }

  private async resolve(req: LaunchTaskRequest, settings: Settings): Promise<ResolvedComposition> {
    let agents: import('./types').SwarmAgent[]
    if (req.templateName) {
      const tpl = await this.templates.get(req.templateName)
      if (!tpl) throw new Error(`Template '${req.templateName}' not found`)
      agents = tpl.agents
    } else {
      agents = settings.swarm.agents
    }
    return {
      agents,
      windowMode: req.windowMode,
      clientTemplate: req.clientTemplate
    }
  }

  /**
   * Launch a new task. Each task spins up its own iTerm window/tabs/panes
   * with its own per-agent inbox/outbox tree, but every agent shares one
   * shell cwd: the user-picked projectDir.
   */
  async launch(req: LaunchTaskRequest): Promise<RunSummary> {
    const settings = this.settings.current()
    const composition = await this.resolve(req, settings)

    if (composition.agents.length === 0) {
      throw new Error('Task must have at least one agent')
    }
    const seen = new Set<string>()
    for (const a of composition.agents) {
      if (seen.has(a.name)) {
        throw new Error(`Duplicate agent name '${a.name}' — names must be unique within a task.`)
      }
      seen.add(a.name)
    }

    // Resolve each agent's client config: a per-agent override if set, else the
    // swarm-wide client chosen at launch. This is what lets one swarm mix CLIs
    // (e.g. some agents on codex, others on claude-code). Resolved before we open
    // any iTerm windows so a bad config name fails fast.
    const clientCache = new Map<string, AgentProfile>()
    const resolveClient = async (name: string): Promise<AgentProfile> => {
      const cached = clientCache.get(name)
      if (cached) return cached
      const tpl = await this.profiles.get(name)
      if (!tpl) {
        throw new Error(`Client config '${name}' not found. Pick one in Settings → Configs.`)
      }
      clientCache.set(name, tpl)
      return tpl
    }
    const agentClients = composition.agents.map(
      (a) => a.clientTemplate?.trim() || composition.clientTemplate
    )
    const profiles: AgentProfile[] = []
    for (let i = 0; i < composition.agents.length; i++) {
      const a = composition.agents[i]
      const template = await resolveClient(agentClients[i])
      const role = a.role.trim()
      profiles.push({
        ...template,
        name: a.name,
        initialPrompt: role.length > 0 ? role : template.initialPrompt
      })
    }

    const workspace = await this.workspaces.create(settings, profiles, {
      projectDir: req.projectDir,
      displayName: req.displayName
    })

    if (this.active.has(workspace.taskId)) {
      throw new Error(`A task with id '${workspace.taskId}' is already running`)
    }

    await this.driver.start()
    const grid =
      composition.windowMode === 'windows'
        ? await this.driver.createWindows(profiles.length)
        : composition.windowMode === 'tabs'
        ? await this.driver.createTabs(profiles.length)
        : await this.driver.createGrid(profiles.length)

    if (grid.session_ids.length !== profiles.length) {
      throw new Error(
        `iTerm2 returned ${grid.session_ids.length} sessions for ${profiles.length} agents`
      )
    }

    const agents: ActiveRun['agents'] = []
    const peerNames = profiles.map((p) => p.name)
    const sessionIds: string[] = profiles.map(() => randomUUID())

    for (let i = 0; i < profiles.length; i++) {
      const profile = profiles[i]
      const sessionId = grid.session_ids[i]
      const claudeSessionId = sessionIds[i]
      const dirs = workspace.agentDirs[profile.name]
      const launchCmd = buildLaunchCommand(
        profile,
        dirs.cwd,
        {
          CCSWARM_AGENT: profile.name,
          CCSWARM_TASK: workspace.taskId,
          CCSWARM_WORKSPACE: workspace.root,
          CCSWARM_PROJECT: workspace.projectDir,
          CCSWARM_INBOX: dirs.inbox,
          CCSWARM_OUTBOX: dirs.outbox,
          CCSWARM_SHARED: workspace.sharedDir,
          CCSWARM_SESSION_ID: claudeSessionId
        },
        workspace.binDir,
        claudeSessionId
      )
      await this.driver.sendText(sessionId, launchCmd)
      agents.push({ name: profile.name, sessionId, claudeSessionId })
    }

    for (let i = 0; i < profiles.length; i++) {
      const profile = profiles[i]
      const sessionId = grid.session_ids[i]
      const peers = peerNames.filter((n) => n !== profile.name)
      const protocol = this.workspaces.renderAgentProtocol(settings, workspace, profile, peers)
      await delay(Math.max(profile.readyDelayMs, 2500))
      if (profile.prelude && profile.prelude.length > 0) {
        await this.driver.sendText(sessionId, profile.prelude)
        await delay(400)
        await this.driver.sendText(sessionId, profile.prelude)
        await delay(600)
      }
      await this.sendMessage(sessionId, protocol)
    }

    // Claude Code (and possibly other clients) ignore our `--session-id` for
    // interactive sessions and assign their own uuid. Scan the per-cwd
    // projects dir for the markers we baked into each agent's protocol prompt
    // and replace the pre-allocated uuid with the real one when we find it.
    // Best-effort: if discovery times out we keep the pre-allocated uuid.
    const discovered = await discoverRealSessionIds(
      workspace.projectDir,
      workspace.taskId,
      profiles.map((p) => p.name),
      this.workspaces
    )
    for (const a of agents) {
      const real = discovered[a.name]
      if (real && real !== a.claudeSessionId) {
        a.claudeSessionId = real
      }
    }

    const run: ActiveRun = {
      taskId: workspace.taskId,
      displayName: workspace.displayName,
      projectDir: workspace.projectDir,
      windowIds: grid.window_ids,
      workspace,
      agents,
      startedAt: new Date().toISOString(),
      watchers: [],
      live: true
    }
    this.active.set(run.taskId, run)
    this.notifyActiveChange()
    this.startInboxWatchers(run)
    this.startPlanWatcher(run)
    this.startExitPoller(run)
    await this.runs.save({
      taskId: run.taskId,
      displayName: run.displayName,
      projectDir: run.projectDir,
      workspaceDir: workspace.root,
      clientTemplate: composition.clientTemplate,
      windowMode: composition.windowMode,
      windowIds: run.windowIds,
      agents: run.agents.map((a, i) => ({
        name: a.name,
        role: composition.agents[i]?.role ?? '',
        clientTemplate: agentClients[i],
        claudeSessionId: a.claudeSessionId,
        iterm2SessionId: a.sessionId
      })),
      status: 'running',
      startedAt: run.startedAt,
      stoppedAt: null
    })
    return this.toSummary(run)
  }

  async stop(taskId: string): Promise<void> {
    const run = this.active.get(taskId)
    if (!run) return
    if (run.exitPoller) {
      clearInterval(run.exitPoller)
      run.exitPoller = undefined
    }
    for (const w of run.watchers) {
      try {
        w.close()
      } catch {
        /* ignore */
      }
    }
    try {
      await this.driver.closeWindows(run.windowIds)
    } catch (err) {
      console.error(`[SwarmController] closeWindows failed for ${taskId}:`, err)
    }
    this.active.delete(taskId)
    this.notifyActiveChange()
    try {
      await this.runs.update(taskId, (r) => ({
        ...r,
        status: 'stopped',
        stoppedAt: new Date().toISOString()
      }))
    } catch (err) {
      console.error(`[SwarmController] runs.update failed for ${taskId}:`, err)
    }
  }

  async stopAll(): Promise<void> {
    const ids = Array.from(this.active.keys())
    await Promise.all(ids.map((id) => this.stop(id)))
  }

  /**
   * Resume a previously stopped run: open the existing workspace, recreate
   * iTerm panes/windows/tabs, and relaunch each agent's CLI with its saved
   * session id (so Claude Code resumes the conversation). The protocol prompt
   * is NOT re-injected — the chat already carries that context.
   */
  async resume(taskId: string): Promise<RunSummary> {
    if (this.active.has(taskId)) {
      throw new Error(`Task '${taskId}' is already running`)
    }
    const record = await this.runs.get(taskId)
    if (!record) throw new Error(`Run '${taskId}' not found`)

    // Resolve each agent's client config (per-agent override, else the run's
    // default). Pre-resolve everything up front so a missing config fails before
    // we reopen any windows.
    const clientCache = new Map<string, AgentProfile>()
    const resolveClient = async (name: string): Promise<AgentProfile> => {
      const cached = clientCache.get(name)
      if (cached) return cached
      const tpl = await this.profiles.get(name)
      if (!tpl) {
        throw new Error(
          `Client config '${name}' from this run no longer exists. ` +
            `Recreate it in Settings → Configs (or edit the run record).`
        )
      }
      clientCache.set(name, tpl)
      return tpl
    }
    const agentClients = record.agents.map(
      (a) => a.clientTemplate?.trim() || record.clientTemplate
    )
    for (const name of agentClients) await resolveClient(name)

    const workspace = await this.workspaces.open({
      taskId: record.taskId,
      displayName: record.displayName,
      workspaceDir: record.workspaceDir,
      projectDir: record.projectDir,
      agentNames: record.agents.map((a) => a.name)
    })

    await this.driver.start()
    const grid =
      record.windowMode === 'windows'
        ? await this.driver.createWindows(record.agents.length)
        : record.windowMode === 'tabs'
        ? await this.driver.createTabs(record.agents.length)
        : await this.driver.createGrid(record.agents.length)

    if (grid.session_ids.length !== record.agents.length) {
      throw new Error(
        `iTerm2 returned ${grid.session_ids.length} sessions for ${record.agents.length} agents`
      )
    }

    const agents: ActiveRun['agents'] = []
    for (let i = 0; i < record.agents.length; i++) {
      const a = record.agents[i]
      const template = await resolveClient(agentClients[i])
      const useResumeArgs = template.resumeArgs && template.resumeArgs.length > 0
      const sessionId = grid.session_ids[i]
      const claudeSessionId = a.claudeSessionId ?? ''
      const dirs = workspace.agentDirs[a.name]
      const profile: AgentProfile = { ...template, name: a.name }
      const launchCmd = buildLaunchCommand(
        profile,
        dirs.cwd,
        {
          CCSWARM_AGENT: a.name,
          CCSWARM_TASK: workspace.taskId,
          CCSWARM_WORKSPACE: workspace.root,
          CCSWARM_PROJECT: workspace.projectDir,
          CCSWARM_INBOX: dirs.inbox,
          CCSWARM_OUTBOX: dirs.outbox,
          CCSWARM_SHARED: workspace.sharedDir,
          CCSWARM_SESSION_ID: claudeSessionId,
          CCSWARM_RESUMING: '1'
        },
        workspace.binDir,
        claudeSessionId,
        useResumeArgs ? template.resumeArgs : undefined
      )
      await this.driver.sendText(sessionId, launchCmd)
      agents.push({ name: a.name, sessionId, claudeSessionId: a.claudeSessionId })
    }

    const startedAt = new Date().toISOString()
    const run: ActiveRun = {
      taskId: record.taskId,
      displayName: record.displayName,
      projectDir: record.projectDir,
      windowIds: grid.window_ids,
      workspace,
      agents,
      startedAt,
      watchers: [],
      live: true
    }
    this.active.set(run.taskId, run)
    this.notifyActiveChange()
    this.startInboxWatchers(run)
    this.startPlanWatcher(run)
    this.startExitPoller(run)
    await this.runs.update(run.taskId, (r) => ({
      ...r,
      status: 'running',
      stoppedAt: null,
      windowIds: run.windowIds,
      agents: r.agents.map((rec, i) => ({
        ...rec,
        iterm2SessionId: agents[i]?.sessionId ?? rec.iterm2SessionId
      }))
    }))
    return this.toSummary(run)
  }

  /** Inject arbitrary text into one agent's iTerm pane. */
  async sendToAgent(taskId: string, agentName: string, text: string): Promise<void> {
    const run = this.active.get(taskId)
    if (!run) throw new Error(`Task '${taskId}' is not running`)
    const agent = run.agents.find((a) => a.name === agentName)
    if (!agent) throw new Error(`Agent '${agentName}' not found in task '${taskId}'`)
    await this.sendMessage(agent.sessionId, text)
  }

  /**
   * Inject a message into an agent's Claude Code TUI and submit it.
   *
   * The body is wrapped in bracketed-paste markers (ESC[200~ … ESC[201~) so the
   * TUI sees a paste with a well-defined end, then Enter is sent as a separate
   * write. Without the end marker, the trailing CR can be coalesced into the
   * same PTY read as the body and inserted as a literal newline — which is why
   * messages sometimes landed in the input box but were never sent.
   */
  private async sendMessage(sessionId: string, text: string): Promise<void> {
    await this.driver.sendText(sessionId, `\x1b[200~${text}\x1b[201~`)
    await delay(120)
    await this.driver.sendText(sessionId, '\r')
  }

  /** Return filesystem paths and session ids for a specific agent. */
  getAgentRecord(
    taskId: string,
    agentName: string
  ): { inbox: string; outbox: string; processed: string; claudeSessionId: string | null; projectDir: string } | null {
    const run = this.active.get(taskId)
    if (!run) return null
    const agent = run.agents.find((a) => a.name === agentName)
    if (!agent) return null
    const dirs = run.workspace.agentDirs[agentName]
    if (!dirs) return null
    return { ...dirs, claudeSessionId: agent.claudeSessionId, projectDir: run.projectDir }
  }

  async resendProtocols(taskId: string): Promise<void> {
    const run = this.active.get(taskId)
    if (!run) throw new Error(`Task '${taskId}' is not running`)
    const record = await this.runs.get(taskId)
    if (!record) throw new Error(`Run record for '${taskId}' not found`)
    const settings = this.settings.current()
    const peerNames = record.agents.map((a) => a.name)
    for (const a of record.agents) {
      const activeAgent = run.agents.find((ra) => ra.name === a.name)
      if (!activeAgent) continue
      const tplName = a.clientTemplate?.trim() || record.clientTemplate
      const template = await this.profiles.get(tplName)
      if (!template) throw new Error(`Client config '${tplName}' not found`)
      const profile: AgentProfile = {
        ...template,
        name: a.name,
        initialPrompt: a.role?.trim() ? a.role : template.initialPrompt
      }
      const peers = peerNames.filter((n) => n !== a.name)
      const protocol = this.workspaces.renderAgentProtocol(settings, run.workspace, profile, peers)
      await delay(300)
      await this.sendMessage(activeAgent.sessionId, protocol)
    }
  }

  /**
   * Read the live terminal text of every active agent pane. Used to synthesize
   * a screenshot of the swarm without capturing the physical display (which is
   * black/locked when the lid is closed). If `taskId` is given, only that task's
   * agents are captured; otherwise all active runs.
   */
  async captureScreens(taskId?: string): Promise<AgentScreen[]> {
    const runs = taskId
      ? ([this.active.get(taskId)].filter(Boolean) as ActiveRun[])
      : Array.from(this.active.values())
    const out: AgentScreen[] = []
    for (const run of runs) {
      for (const a of run.agents) {
        let lines: string[]
        let styled: StyledRun[][] | undefined
        try {
          const res = await this.driver.getScreenContents(a.sessionId)
          lines = res.lines
          styled = res.styled
        } catch (e) {
          lines = [`(could not read pane: ${e instanceof Error ? e.message : String(e)})`]
          styled = undefined
        }
        out.push({ taskId: run.taskId, displayName: run.displayName, agent: a.name, lines, styled })
      }
    }
    return out
  }

  /** Expose the shared plan path so callers (Telegram bot etc.) can read/send it. */
  getSharedPlanPath(taskId: string): string | null {
    const run = this.active.get(taskId)
    return run ? join(run.workspace.sharedDir, 'PLAN.md') : null
  }

  private startExitPoller(run: ActiveRun): void {
    const POLL_MS = 45_000
    const timer = setInterval(async () => {
      const active = this.active.get(run.taskId)
      if (!active) { clearInterval(timer); return }
      if (active.agents.length === 0) { clearInterval(timer); return }
      try {
        const results = await Promise.allSettled(
          active.agents.map((a) => this.driver.checkSessionAlive(a.sessionId))
        )
        const allGone = results.every(
          (r) => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.alive)
        )
        if (allGone) {
          clearInterval(timer)
          active.exitPoller = undefined
          active.live = false
          this.notifyActiveChange()
          this.onEvent?.({ type: 'agents_exited', taskId: run.taskId, displayName: run.displayName })
        }
      } catch {
        // driver not running, skip this tick
      }
    }, POLL_MS)
    run.exitPoller = timer
  }

  private startPlanWatcher(run: ActiveRun): void {
    const planPath = join(run.workspace.sharedDir, 'PLAN.md')
    let timer: NodeJS.Timeout | null = null
    let lastContent = ''

    const watcher = watch(run.workspace.sharedDir, { persistent: false }, (_evt, filename) => {
      if (filename !== 'PLAN.md') return
      if (timer) clearTimeout(timer)
      timer = setTimeout(async () => {
        timer = null
        let content: string
        try {
          content = await fs.readFile(planPath, 'utf8')
        } catch {
          return
        }
        if (content === lastContent) return
        lastContent = content
        const msg =
          `\n[plan updated]\n${content.trim()}\n` +
          `(swarm-plan read | swarm-plan done N | swarm-plan add "item")\n`
        for (const agent of run.agents) {
          try {
            await this.sendMessage(agent.sessionId, msg)
          } catch { /* agent may have stopped */ }
        }
      }, 400)
    })
    watcher.on('error', (e) => console.error('[SwarmController] plan watch error:', e))
    run.watchers.push(watcher)
  }

  private startInboxWatchers(run: ActiveRun): void {
    for (const a of run.agents) {
      const dirs = run.workspace.agentDirs[a.name]
      if (!dirs) continue
      const debounce = new Map<string, NodeJS.Timeout>()
      const watcher = watch(dirs.inbox, { persistent: false }, (_evt, filename) => {
        if (!filename) return
        const f = String(filename)
        if (f.startsWith('.') || f === 'processed' || f.includes('/')) return
        const existing = debounce.get(f)
        if (existing) clearTimeout(existing)
        debounce.set(
          f,
          setTimeout(() => {
            debounce.delete(f)
            this.onInboxFile(a.name, a.sessionId, dirs.inbox, f).catch((e) =>
              console.error('[SwarmController] inbox notify failed:', e)
            )
          }, 200)
        )
      })
      watcher.on('error', (e) => console.error(`[SwarmController] watch ${dirs.inbox}:`, e))
      run.watchers.push(watcher)
    }
  }

  private async onInboxFile(
    agentName: string,
    sessionId: string,
    inboxDir: string,
    filename: string
  ): Promise<void> {
    const full = join(inboxDir, filename)
    let raw: string
    try {
      const stat = await fs.stat(full)
      if (!stat.isFile()) return
      raw = await fs.readFile(full, 'utf8')
    } catch {
      return
    }

    // Parse YAML frontmatter to extract `from:` field.
    let sender = 'unknown'
    const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)
    if (fmMatch) {
      const fromLine = fmMatch[1].split('\n').find((l) => l.startsWith('from:'))
      if (fromLine) sender = fromLine.replace('from:', '').trim()
    }

    // Send a single-line nudge so Claude Code receives it as one user message.
    // Multi-line injections get split into separate submits in raw terminal mode.
    // The file stays in inbox so the agent can read it via `swarm-msg read`.
    const nudge = `[ultraswarm] new message from ${sender} — run: swarm-msg read`
    try {
      await this.sendMessage(sessionId, nudge)
    } catch (e) {
      console.error('[SwarmController] sendText inbox failed:', e)
    }
  }
}
