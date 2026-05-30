import { promises as fs } from 'fs'
import { join } from 'path'
import { RUNS_DIR } from './paths'
import { RunRecord, RunRecordSchema } from './types'

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

/**
 * Tiny file-based store for run records. One JSON per task in
 * ~/.ccswarm/runs/<taskId>.json so it's trivial to inspect and survives
 * app crashes (no half-written multi-record file).
 */
export class RunStore {
  async init(): Promise<void> {
    await ensureDir(RUNS_DIR)
  }

  private pathFor(taskId: string): string {
    return join(RUNS_DIR, `${taskId}.json`)
  }

  async list(): Promise<RunRecord[]> {
    await ensureDir(RUNS_DIR)
    const files = await fs.readdir(RUNS_DIR)
    const out: RunRecord[] = []
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      try {
        const raw = await fs.readFile(join(RUNS_DIR, f), 'utf8')
        out.push(RunRecordSchema.parse(JSON.parse(raw)))
      } catch (err) {
        console.error(`[RunStore] failed to load ${f}:`, err)
      }
    }
    return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }

  async get(taskId: string): Promise<RunRecord | null> {
    const p = this.pathFor(taskId)
    if (!(await fileExists(p))) return null
    const raw = await fs.readFile(p, 'utf8')
    return RunRecordSchema.parse(JSON.parse(raw))
  }

  async save(record: RunRecord): Promise<RunRecord> {
    const parsed = RunRecordSchema.parse(record)
    await ensureDir(RUNS_DIR)
    const p = this.pathFor(parsed.taskId)
    const tmp = `${p}.tmp`
    await fs.writeFile(tmp, JSON.stringify(parsed, null, 2) + '\n', 'utf8')
    await fs.rename(tmp, p)
    return parsed
  }

  async update(taskId: string, patch: (r: RunRecord) => RunRecord): Promise<RunRecord | null> {
    const cur = await this.get(taskId)
    if (!cur) return null
    return this.save(patch(cur))
  }

  async delete(taskId: string): Promise<void> {
    const p = this.pathFor(taskId)
    if (await fileExists(p)) await fs.unlink(p)
  }
}
