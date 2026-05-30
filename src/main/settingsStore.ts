import { promises as fs } from 'fs'
import { CCSWARM_HOME, CONFIG_FILE } from './paths'
import { Settings, SettingsSchema } from './types'
import { DEFAULT_PROTOCOL_TEMPLATE } from './defaultProtocol'

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

function defaults(): Settings {
  return SettingsSchema.parse({
    protocolTemplate: DEFAULT_PROTOCOL_TEMPLATE
  })
}

/**
 * Convert pre-named-agents settings (instanceCount + namePrefix + roles[])
 * into the new agents[] shape in place. Old configs on disk would otherwise
 * fail Zod validation on first load.
 */
function migrateLegacySwarm(parsed: { swarm?: Record<string, unknown> }): void {
  const sw = parsed.swarm
  if (!sw || typeof sw !== 'object') return
  if (Array.isArray(sw.agents)) return
  const count = typeof sw.instanceCount === 'number' ? sw.instanceCount : 0
  if (count <= 0) return
  const prefix = typeof sw.namePrefix === 'string' && sw.namePrefix.length > 0 ? sw.namePrefix : 'agent'
  const roles = Array.isArray(sw.roles) ? (sw.roles as unknown[]) : []
  const agents: { name: string; role: string }[] = []
  for (let i = 0; i < count; i++) {
    const role = typeof roles[i] === 'string' ? (roles[i] as string) : ''
    agents.push({ name: `${prefix}-${i + 1}`, role })
  }
  sw.agents = agents
  delete sw.instanceCount
  delete sw.namePrefix
  delete sw.roles
}

export class SettingsStore {
  private cached: Settings | null = null

  async init(): Promise<Settings> {
    await fs.mkdir(CCSWARM_HOME, { recursive: true })
    if (!(await fileExists(CONFIG_FILE))) {
      const def = defaults()
      await fs.writeFile(CONFIG_FILE, JSON.stringify(def, null, 2) + '\n', 'utf8')
      this.cached = def
      return def
    }
    return this.load()
  }

  async load(): Promise<Settings> {
    const raw = await fs.readFile(CONFIG_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    migrateLegacySwarm(parsed)
    const merged = { ...defaults(), ...parsed }
    this.cached = SettingsSchema.parse(merged)
    return this.cached
  }

  async save(next: Settings): Promise<Settings> {
    const parsed = SettingsSchema.parse(next)
    await fs.writeFile(CONFIG_FILE, JSON.stringify(parsed, null, 2) + '\n', 'utf8')
    this.cached = parsed
    return parsed
  }

  current(): Settings {
    if (!this.cached) throw new Error('SettingsStore not initialized')
    return this.cached
  }
}
