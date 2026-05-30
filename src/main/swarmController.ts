import { ProfileStore } from './profileStore'
import { SettingsStore } from './settingsStore'
import { SwarmTemplateStore } from './swarmTemplateStore'
import { RunStore } from './runStore'
import { WorkspaceManager, Workspace } from './workspaceManager'
import { ITermDriver } from './itermDriver'
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
    if (req.templateName) {
      const tpl = await this.templates.get(req.templateName)
      if (!tpl) throw new Error(`Template '${req.templateName}' not found`)
      return {
        agents: tpl.agents,
        windowMode: tpl.windowMode,
        clientTemplate: tpl.clientTemplate
      }
    }
    return {
      agents: settings.swarm.agents,
      windowMode: settings.swarm.windowMode,
      clientTemplate: settings.swarm.clientTemplate
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
    const template = await this.profiles.get(composition.clientTemplate)
    if (!template) {
      throw new Error(
        `Client config '${composition.clientTemplate}' not found. ` +
          `Pick one in Settings → Configs.`
      )
    }

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

    const profiles: AgentProfile[] = composition.agents.map((a) => {
      const role = a.role.trim()
      return {
        ...template,
        name: a.name,
        initialPrompt: role.length > 0 ? role : template.initialPrompt
      }
    })

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
      await this.driver.sendText(sessionId, protocol)
      await delay(120)
      await this.driver.sendText(sessionId, '\r')
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
      watchers: []
    }
    this.active.set(run.taskId, run)
    this.startInboxWatchers(run)
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

    const template = await this.profiles.get(record.clientTemplate)
    if (!template) {
      throw new Error(
        `Client config '${record.clientTemplate}' from this run no longer exists. ` +
          `Recreate it in Settings → Configs (or edit the run record).`
      )
    }

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
    const useResumeArgs = template.resumeArgs && template.resumeArgs.length > 0
    for (let i = 0; i < record.agents.length; i++) {
      const a = record.agents[i]
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
      watchers: []
    }
    this.active.set(run.taskId, run)
    this.startInboxWatchers(run)
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
    try {
      const stat = await fs.stat(full)
      if (!stat.isFile()) return
    } catch {
      return
    }
    const nudge =
      `\n[ccswarm] new inbox message for ${agentName}. ` +
      `Run \`swarm-msg read\` to see it.\n`
    try {
      await this.driver.sendText(sessionId, nudge)
      await delay(120)
      await this.driver.sendText(sessionId, '\r')
    } catch (e) {
      console.error('[SwarmController] sendText nudge failed:', e)
    }
  }
}
