import { promises as fs } from 'fs'
import { join } from 'path'
import { AGENTS_DIR, presetsDir } from './paths'
import { AgentProfile, AgentProfileSchema } from './types'

async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true })
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

export class ProfileStore {
  async init(): Promise<void> {
    await ensureDir(AGENTS_DIR)
    await this.seedFromPresets()
  }

  private async seedFromPresets(): Promise<void> {
    const dir = presetsDir()
    if (!(await fileExists(dir))) return
    const files = await fs.readdir(dir)
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      const src = join(dir, f)
      const dst = join(AGENTS_DIR, f)
      if (!(await fileExists(dst))) {
        await fs.copyFile(src, dst)
      }
    }
  }

  async list(): Promise<AgentProfile[]> {
    await ensureDir(AGENTS_DIR)
    const files = await fs.readdir(AGENTS_DIR)
    const out: AgentProfile[] = []
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      try {
        const raw = await fs.readFile(join(AGENTS_DIR, f), 'utf8')
        out.push(this.applyMigrations(AgentProfileSchema.parse(JSON.parse(raw))))
      } catch (err) {
        console.error(`[ProfileStore] failed to load ${f}:`, err)
      }
    }
    return out.sort((a, b) => a.displayName.localeCompare(b.displayName))
  }

  async get(name: string): Promise<AgentProfile | null> {
    const path = join(AGENTS_DIR, `${name}.json`)
    if (!(await fileExists(path))) return null
    const raw = await fs.readFile(path, 'utf8')
    const parsed = AgentProfileSchema.parse(JSON.parse(raw))
    return this.applyMigrations(parsed)
  }

  /**
   * Patch up older profile files written before a feature existed. Right now
   * that's just `resumeArgs` for claude-code: early versions seeded a config
   * without it, so Resume silently falls back to plain `args` and starts a
   * fresh chat instead of `--resume <uuid>`. We don't rewrite the file — the
   * patch only applies in-memory so the user's edits aren't clobbered.
   */
  private applyMigrations(p: AgentProfile): AgentProfile {
    if (p.command === 'claude' && (!p.resumeArgs || p.resumeArgs.length === 0)) {
      const passthrough = p.args.filter((a) => a !== '--session-id' && !/^[0-9a-f-]{36}$/i.test(a))
      return {
        ...p,
        resumeArgs: [...passthrough, '--resume', '{{session_id}}']
      }
    }
    return p
  }

  async save(profile: AgentProfile): Promise<AgentProfile> {
    const parsed = AgentProfileSchema.parse(profile)
    await ensureDir(AGENTS_DIR)
    const path = join(AGENTS_DIR, `${parsed.name}.json`)
    await fs.writeFile(path, JSON.stringify(parsed, null, 2) + '\n', 'utf8')
    return parsed
  }

  async delete(name: string): Promise<void> {
    const path = join(AGENTS_DIR, `${name}.json`)
    if (await fileExists(path)) await fs.unlink(path)
  }
}
