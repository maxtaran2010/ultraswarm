import { promises as fs } from 'fs'
import { join } from 'path'
import { AgentProfile, Settings } from './types'
import { expandHome, resourcesDir } from './paths'

export interface Workspace {
  taskId: string
  displayName: string
  runId: string
  root: string
  projectDir: string
  sharedDir: string
  binDir: string
  protocolFile: string
  agentDirs: Record<string, { cwd: string; inbox: string; outbox: string; processed: string }>
}

function nowRunId(): string {
  const d = new Date()
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

function renderTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/{{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*}}/g, (_, k) => vars[k] ?? `{{${k}}}`)
}

export class WorkspaceManager {
  /**
   * Create a per-task workspace. All agents in the task share `projectDir`
   * as their shell cwd (so they cooperate on one repo / folder); inbox /
   * outbox / processed live under `<workspaceRoot>/<taskId>/agents/<name>/`.
   */
  async create(
    settings: Settings,
    profiles: AgentProfile[],
    opts: { projectDir: string; displayName: string }
  ): Promise<Workspace> {
    const projectDir = expandHome(opts.projectDir)
    try {
      const stat = await fs.stat(projectDir)
      if (!stat.isDirectory()) {
        throw new Error(`projectDir '${projectDir}' is not a directory`)
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`projectDir '${projectDir}' does not exist`)
      }
      throw e
    }

    const runId = nowRunId()
    const taskId = `${runId}-${slug(opts.displayName) || 'task'}`
    const root = join(expandHome(settings.workspaceRoot), taskId)
    const sharedDir = join(root, 'shared')
    const binDir = join(root, 'bin')
    await fs.mkdir(sharedDir, { recursive: true })
    await fs.mkdir(binDir, { recursive: true })

    const agentDirs: Workspace['agentDirs'] = {}
    for (const p of profiles) {
      const base = join(root, 'agents', p.name)
      const inbox = join(base, 'inbox')
      const outbox = join(base, 'outbox')
      const processed = join(inbox, 'processed')
      await fs.mkdir(inbox, { recursive: true })
      await fs.mkdir(outbox, { recursive: true })
      await fs.mkdir(processed, { recursive: true })
      agentDirs[p.name] = { cwd: projectDir, inbox, outbox, processed }
    }

    const protocolFile = join(root, 'PROTOCOL.md')
    await fs.writeFile(protocolFile, settings.protocolTemplate, 'utf8')

    for (const [script, bin] of [
      ['swarm-msg.py', 'swarm-msg'],
      ['swarm-plan.py', 'swarm-plan']
    ] as [string, string][]) {
      try {
        await fs.copyFile(join(resourcesDir(), script), join(binDir, bin))
        await fs.chmod(join(binDir, bin), 0o755)
      } catch (err) {
        console.error(`[WorkspaceManager] failed to install ${bin}:`, err)
      }
    }

    // Create initial shared plan
    const planPath = join(sharedDir, 'PLAN.md')
    try {
      await fs.writeFile(planPath, '# Plan\n\n', 'utf8')
    } catch { /* ignore */ }

    await this.installSkill(root, agentDirs)

    return {
      taskId,
      displayName: opts.displayName,
      runId,
      root,
      projectDir,
      sharedDir,
      binDir,
      protocolFile,
      agentDirs
    }
  }

  /**
   * Reconstruct a Workspace handle from disk for an existing run. Used by
   * resume(): no mkdir, no file copies — we just point at what's already
   * there. Throws if the workspace root is missing.
   */
  async open(opts: {
    taskId: string
    displayName: string
    workspaceDir: string
    projectDir: string
    agentNames: string[]
  }): Promise<Workspace> {
    const root = expandHome(opts.workspaceDir)
    try {
      const stat = await fs.stat(root)
      if (!stat.isDirectory()) throw new Error(`workspace '${root}' is not a directory`)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`workspace '${root}' no longer exists`)
      }
      throw e
    }
    const sharedDir = join(root, 'shared')
    const binDir = join(root, 'bin')
    const protocolFile = join(root, 'PROTOCOL.md')
    const projectDir = expandHome(opts.projectDir)

    // Repair the per-run swarm-msg copy in case the user blew away the bin/
    // dir or the resource path changed (e.g. dev → packaged).
    await fs.mkdir(binDir, { recursive: true })
    const dstCli = join(binDir, 'swarm-msg')
    try {
      await fs.access(dstCli)
    } catch {
      const srcCli = join(resourcesDir(), 'swarm-msg.py')
      try {
        await fs.copyFile(srcCli, dstCli)
        await fs.chmod(dstCli, 0o755)
      } catch (err) {
        console.error('[WorkspaceManager] failed to reinstall swarm-msg:', err)
      }
    }

    const agentDirs: Workspace['agentDirs'] = {}
    for (const name of opts.agentNames) {
      const base = join(root, 'agents', name)
      const inbox = join(base, 'inbox')
      const outbox = join(base, 'outbox')
      const processed = join(inbox, 'processed')
      // Recreate any missing subdir so watchers and CLI don't crash.
      await fs.mkdir(inbox, { recursive: true })
      await fs.mkdir(outbox, { recursive: true })
      await fs.mkdir(processed, { recursive: true })
      agentDirs[name] = { cwd: projectDir, inbox, outbox, processed }
    }

    await this.installSkill(root, agentDirs)

    // Best-effort: if the runId is encoded in taskId as <YYYYMMDD-HHMMSS>-<slug>,
    // recover it; otherwise empty. Not load-bearing.
    const runIdMatch = opts.taskId.match(/^(\d{8}-\d{6})/)
    return {
      taskId: opts.taskId,
      displayName: opts.displayName,
      runId: runIdMatch?.[1] ?? '',
      root,
      projectDir,
      sharedDir,
      binDir,
      protocolFile,
      agentDirs
    }
  }

  /** Copy SWARM_SKILL.md to <workspace>/SKILL.md. Returns true if newly installed. */
  private async installSkill(root: string, _agentDirs: Workspace['agentDirs']): Promise<boolean> {
    const dest = join(root, 'SKILL.md')
    try {
      await fs.access(dest)
      return false // already installed
    } catch { /* not yet */ }
    const src = join(resourcesDir(), 'SWARM_SKILL.md')
    try {
      await fs.copyFile(src, dest)
      return true
    } catch (err) {
      console.error('[WorkspaceManager] failed to install SKILL.md:', err)
      return false
    }
  }

  agentMarker(taskId: string, agentName: string): string {
    return `<!-- ultraswarm-agent: ${agentName} task: ${taskId} -->`
  }

  renderAgentProtocol(
    settings: Settings,
    workspace: Workspace,
    profile: AgentProfile,
    peerNames: string[]
  ): string {
    const dirs = workspace.agentDirs[profile.name]
    const peersList = peerNames.length
      ? peerNames.map((n) => `  - ${n}`).join('\n')
      : '  (no peers in this run)'
    const protocol = renderTemplate(settings.protocolTemplate, {
      agent_name: profile.name,
      inbox: dirs.inbox,
      outbox: dirs.outbox,
      shared_dir: workspace.sharedDir,
      workspace: workspace.root,
      project_dir: workspace.projectDir,
      task_name: workspace.displayName,
      peers_list: peersList
    })
    // Stable marker we use post-launch to find which Claude Code session log
    // (~/.claude/projects/<cwd>/<uuid>.jsonl) belongs to which agent. Claude
    // currently ignores `--session-id` for interactive sessions and assigns
    // its own uuid, so we can't trust the one we generated up-front.
    const marker = `${this.agentMarker(workspace.taskId, profile.name)}\n\n`
    const header =
      `## Task\n` +
      `**${workspace.displayName}** — shared working directory: \`${workspace.projectDir}\`\n\n`
    if (profile.initialPrompt && profile.initialPrompt.trim().length > 0) {
      return `${marker}${header}${protocol}\n\n---\n## Your role\n${profile.initialPrompt}\n`
    }
    return `${marker}${header}${protocol}`
  }
}
