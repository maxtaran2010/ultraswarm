export interface ClientTemplate {
  name: string
  displayName: string
  command: string
  args: string[]
  env: Record<string, string>
  cwd: string
  initialPrompt: string
  readyDelayMs: number
}
export type AgentProfile = ClientTemplate

export interface SwarmAgent {
  name: string
  role: string
}

export interface SwarmConfig {
  clientTemplate: string
  windowMode: 'grid' | 'windows' | 'tabs'
  agents: SwarmAgent[]
}

export interface Settings {
  workspaceRoot: string
  terminal: 'iterm2'
  pythonPath: string
  protocolTemplate: string
  swarm: SwarmConfig
  telegram: {
    enabled: boolean
    botToken: string
    chatId: string
  }
  general: {
    autoStart: boolean
    fontSize: number
  }
}

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

export interface RunRecord {
  taskId: string
  displayName: string
  projectDir: string
  workspaceDir: string
  clientTemplate: string
  windowMode: 'grid' | 'windows' | 'tabs'
  windowIds: string[]
  agents: Array<{
    name: string
    role: string
    claudeSessionId: string | null
    iterm2SessionId: string | null
  }>
  status: 'running' | 'stopped'
  startedAt: string
  stoppedAt: string | null
}

export interface SwarmTemplate {
  name: string
  displayName: string
  description: string
  clientTemplate: string
  windowMode: 'grid' | 'windows' | 'tabs'
  agents: SwarmAgent[]
}

export interface LaunchTaskRequest {
  templateName: string | null
  projectDir: string
  displayName: string
}

interface CcswarmApi {
  profiles: {
    list(): Promise<ClientTemplate[]>
    get(name: string): Promise<ClientTemplate | null>
    save(profile: ClientTemplate): Promise<ClientTemplate>
    delete(name: string): Promise<void>
  }
  templates: {
    list(): Promise<SwarmTemplate[]>
    get(name: string): Promise<SwarmTemplate | null>
    save(template: SwarmTemplate): Promise<SwarmTemplate>
    delete(name: string): Promise<void>
    apply(name: string): Promise<Settings>
  }
  settings: {
    load(): Promise<Settings>
    save(settings: Settings): Promise<Settings>
    defaultProtocol(): Promise<string>
  }
  telegram: {
    test(botToken: string, chatId: string): Promise<{ username: string }>
  }
  tasks: {
    list(): Promise<RunSummary[]>
    launch(req: LaunchTaskRequest): Promise<RunSummary>
    stop(taskId: string): Promise<void>
    stopAll(): Promise<void>
    resume(taskId: string): Promise<RunSummary>
  }
  runs: {
    list(): Promise<RunRecord[]>
    get(taskId: string): Promise<RunRecord | null>
    delete(taskId: string): Promise<void>
  }
  dialog: {
    pickDirectory(defaultPath?: string): Promise<string | null>
  }
  shell: {
    openPath(path: string): Promise<string>
  }
}

declare global {
  interface Window {
    ccswarm: CcswarmApi
  }
}

export const api = (): CcswarmApi => window.ccswarm
