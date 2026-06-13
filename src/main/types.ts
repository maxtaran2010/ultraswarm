import { z } from 'zod'

/**
 * A client template describes how to launch one instance of an agent CLI
 * (claude-code, codex, hermes, ...). The swarm runs N copies of one chosen
 * template; per-instance roles override the initial prompt.
 */
export const ClientTemplateSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'name must be alphanumeric/dash/underscore'),
  displayName: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  /**
   * Optional override of `args` used when resuming an existing run.
   * Same {{session_id}} substitution applies. If empty, resume falls back
   * to `args` (which is fine for clients without a session concept).
   */
  resumeArgs: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  cwd: z.string().default('${workspace}/agents/${name}'),
  initialPrompt: z.string().default(''),
  /**
   * Optional keystrokes sent after the CLI starts but before the protocol
   * prompt. Useful for dismissing first-run TUI dialogs (e.g. Claude Code's
   * "Trust this folder?" prompt — set this to "\r" to accept the default).
   */
  prelude: z.string().default(''),
  readyDelayMs: z.number().int().min(0).max(60_000).default(1500)
})
export type ClientTemplate = z.infer<typeof ClientTemplateSchema>

/** Backwards-compat alias used by older code. */
export const AgentProfileSchema = ClientTemplateSchema
export type AgentProfile = ClientTemplate

/**
 * One named participant in a swarm. The name becomes the agent's identifier
 * everywhere (workspace dirs, inbox/outbox paths, peer addressing). The role
 * is appended to the protocol prompt so each agent gets its own brief.
 */
export const SwarmAgentSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'name must be alphanumeric/dash/underscore'),
  role: z.string().default('')
})
export type SwarmAgent = z.infer<typeof SwarmAgentSchema>

export const SwarmConfigSchema = z.object({
  /** name of a ClientTemplate stored in ~/.ultraswarm/agents/<name>.json */
  clientTemplate: z.string().default('claude-code'),
  /**
   * How agents are arranged in iTerm2.
   * - grid:    one window split into N panes (default).
   * - windows: N separate windows tiled across the screen.
   * - tabs:    one window with N tabs.
   */
  windowMode: z.enum(['grid', 'windows', 'tabs']).default('grid'),
  /**
   * The agents to launch. Each entry has its own name and role prompt.
   * Names must be unique within a swarm (enforced at save time in the UI).
   */
  agents: z
    .array(SwarmAgentSchema)
    .min(1, 'swarm must have at least one agent')
    .default([{ name: 'agent-1', role: '' }])
})
export type SwarmConfig = z.infer<typeof SwarmConfigSchema>

export const SettingsSchema = z.object({
  workspaceRoot: z.string().default('~/.ultraswarm/workspaces'),
  terminal: z.enum(['iterm2']).default('iterm2'),
  pythonPath: z.string().default('python3'),
  protocolTemplate: z.string(),
  swarm: SwarmConfigSchema.default({
    clientTemplate: 'claude-code',
    windowMode: 'grid',
    agents: [{ name: 'agent-1', role: '' }]
  }),
  telegram: z
    .object({
      enabled: z.boolean().default(false),
      botToken: z.string().default(''),
      chatId: z.string().default('')
    })
    .default({ enabled: false, botToken: '', chatId: '' }),
  general: z
    .object({
      autoStart: z.boolean().default(false),
      fontSize: z.number().int().min(8).max(48).default(13),
      preventSleep: z.boolean().default(false)
    })
    .default({ autoStart: false, fontSize: 13, preventSleep: false })
})
export type Settings = z.infer<typeof SettingsSchema>

export interface RunSummary {
  taskId: string
  displayName: string
  projectDir: string
  runId: string
  startedAt: string
  workspaceDir: string
  windowId: string | null
  windowIds: string[]
  agents: Array<{ name: string; sessionId: string; claudeSessionId: string | null }>
}

/**
 * What the renderer sends when the user hits "New task" on the dashboard.
 * `templateName` references a saved SwarmTemplate (agents only); if null we
 * fall back to settings.swarm.agents. `clientTemplate` and `windowMode` are
 * always chosen at launch time and are independent of the template.
 */
export const LaunchTaskRequestSchema = z.object({
  templateName: z.string().min(1).nullable(),
  projectDir: z.string().min(1),
  displayName: z.string().min(1).max(120),
  clientTemplate: z.string().min(1).default('claude-code'),
  windowMode: z.enum(['grid', 'windows', 'tabs']).default('grid')
})
export type LaunchTaskRequest = z.infer<typeof LaunchTaskRequestSchema>

/**
 * A SwarmTemplate is a named team configuration: a set of agents with role
 * prompts. The client config (which CLI to run) and window layout are chosen
 * separately at launch time, so templates are reusable across any client.
 */
export const SwarmTemplateSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'name must be alphanumeric/dash/underscore'),
  displayName: z.string().min(1),
  description: z.string().default(''),
  agents: z.array(SwarmAgentSchema).min(1)
})
export type SwarmTemplate = z.infer<typeof SwarmTemplateSchema>

/**
 * One agent inside a persisted run record. `claudeSessionId` is the uuid we
 * pass to Claude Code via `--session-id` so the chat can be resumed later
 * (and so we know which file in `~/.claude/projects/<encoded>/` is the agent's
 * conversation log).
 */
export const RunAgentRecordSchema = z.object({
  name: z.string(),
  role: z.string().default(''),
  claudeSessionId: z.string().nullable().default(null),
  iterm2SessionId: z.string().nullable().default(null)
})
export type RunAgentRecord = z.infer<typeof RunAgentRecordSchema>

export const RunRecordSchema = z.object({
  taskId: z.string(),
  displayName: z.string(),
  projectDir: z.string(),
  workspaceDir: z.string(),
  clientTemplate: z.string(),
  windowMode: z.enum(['grid', 'windows', 'tabs']),
  windowIds: z.array(z.string()).default([]),
  agents: z.array(RunAgentRecordSchema),
  status: z.enum(['running', 'stopped']).default('running'),
  startedAt: z.string(),
  stoppedAt: z.string().nullable().default(null)
})
export type RunRecord = z.infer<typeof RunRecordSchema>
