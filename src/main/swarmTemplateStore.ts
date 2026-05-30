import { promises as fs } from 'fs'
import { join } from 'path'
import { TEMPLATES_DIR, templatePresetsDir } from './paths'
import { SwarmTemplate, SwarmTemplateSchema } from './types'

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

export class SwarmTemplateStore {
  async init(): Promise<void> {
    await ensureDir(TEMPLATES_DIR)
    const entries = await fs.readdir(TEMPLATES_DIR)
    if (entries.filter((e) => e.endsWith('.json')).length === 0) {
      await this.seedFromPresets()
    }
  }

  private async seedFromPresets(): Promise<void> {
    const dir = templatePresetsDir()
    if (!(await fileExists(dir))) return
    const files = await fs.readdir(dir)
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      const src = join(dir, f)
      const dst = join(TEMPLATES_DIR, f)
      if (!(await fileExists(dst))) {
        await fs.copyFile(src, dst)
      }
    }
  }

  async list(): Promise<SwarmTemplate[]> {
    await ensureDir(TEMPLATES_DIR)
    const files = await fs.readdir(TEMPLATES_DIR)
    const out: SwarmTemplate[] = []
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      try {
        const raw = await fs.readFile(join(TEMPLATES_DIR, f), 'utf8')
        out.push(SwarmTemplateSchema.parse(JSON.parse(raw)))
      } catch (err) {
        console.error(`[SwarmTemplateStore] failed to load ${f}:`, err)
      }
    }
    return out.sort((a, b) => a.displayName.localeCompare(b.displayName))
  }

  async get(name: string): Promise<SwarmTemplate | null> {
    const path = join(TEMPLATES_DIR, `${name}.json`)
    if (!(await fileExists(path))) return null
    const raw = await fs.readFile(path, 'utf8')
    return SwarmTemplateSchema.parse(JSON.parse(raw))
  }

  async save(template: SwarmTemplate): Promise<SwarmTemplate> {
    const parsed = SwarmTemplateSchema.parse(template)
    await ensureDir(TEMPLATES_DIR)
    const path = join(TEMPLATES_DIR, `${parsed.name}.json`)
    await fs.writeFile(path, JSON.stringify(parsed, null, 2) + '\n', 'utf8')
    return parsed
  }

  async delete(name: string): Promise<void> {
    const path = join(TEMPLATES_DIR, `${name}.json`)
    if (await fileExists(path)) await fs.unlink(path)
  }
}
