import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import { join } from 'path'
import { resourcesDir } from './paths'
import { randomUUID } from 'crypto'

interface RpcResponse {
  id: string | null
  ok: boolean
  result?: unknown
  error?: string
  trace?: string
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

export interface GridResult {
  window_id: string
  window_ids: string[]
  session_ids: string[]
  rows: number
  cols: number
}

/** One run of same-styled terminal text (from get_screen_contents). */
export interface StyledRun {
  /** text */
  t: string
  /** foreground hex (#rrggbb) or null = terminal default */
  f: string | null
  /** background hex (#rrggbb) or null = terminal default */
  b: string | null
  /** bold */
  bo: boolean
}

export class ITermDriver {
  private proc: ChildProcessWithoutNullStreams | null = null
  private pending = new Map<string, Pending>()
  private buf = ''
  private ready = false
  private readyWaiters: Array<(err?: Error) => void> = []
  private pythonPath: string
  private stderrBuf = ''
  private exited = false

  constructor(pythonPath = 'python3') {
    this.pythonPath = pythonPath
  }

  async start(): Promise<void> {
    if (this.proc) return
    const script = join(resourcesDir(), 'iterm-driver.py')
    this.stderrBuf = ''
    this.exited = false
    const proc = spawn(this.pythonPath, [script], {
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.proc = proc

    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => this.onStdout(chunk))
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk: string) => {
      this.stderrBuf += chunk
      if (this.stderrBuf.length > 8192) {
        this.stderrBuf = this.stderrBuf.slice(-8192)
      }
      console.error('[iterm-driver]', chunk.trim())
    })
    proc.on('exit', (code, signal) => {
      console.error(`[iterm-driver] exited code=${code} signal=${signal}`)
      this.proc = null
      this.exited = true
      const stderrTail = this.stderrBuf.trim()
      const reason = stderrTail
        ? `iterm-driver exited (code=${code}): ${stderrTail}`
        : `iterm-driver exited (code=${code}, signal=${signal})`
      // Fail any in-flight calls.
      for (const p of this.pending.values()) {
        clearTimeout(p.timer)
        p.reject(new Error(reason))
      }
      this.pending.clear()
      // Fail anyone still waiting for ready.
      if (!this.ready) {
        for (const w of this.readyWaiters) w(new Error(reason))
        this.readyWaiters = []
      }
      this.ready = false
    })

    await this.waitReady(15_000)
  }

  async stop(): Promise<void> {
    if (!this.proc) return
    this.proc.stdin.end()
    this.proc.kill('SIGTERM')
    this.proc = null
    this.ready = false
  }

  private waitReady(timeoutMs: number): Promise<void> {
    if (this.ready) return Promise.resolve()
    if (this.exited) {
      const tail = this.stderrBuf.trim()
      return Promise.reject(
        new Error(tail ? `iterm-driver exited: ${tail}` : 'iterm-driver exited before ready')
      )
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const tail = this.stderrBuf.trim()
        const hint = tail
          ? `\n\nDriver stderr:\n${tail}`
          : '\n\nCheck iTerm2 → Settings → General → Magic → Enable Python API.'
        reject(new Error(`iterm-driver did not become ready in 15s.${hint}`))
      }, timeoutMs)
      this.readyWaiters.push((err) => {
        clearTimeout(timer)
        if (err) reject(err)
        else resolve()
      })
    })
  }

  private onStdout(chunk: string): void {
    this.buf += chunk
    let idx: number
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim()
      this.buf = this.buf.slice(idx + 1)
      if (!line) continue
      let msg: RpcResponse
      try {
        msg = JSON.parse(line) as RpcResponse
      } catch {
        console.error('[iterm-driver] non-JSON stdout:', line)
        continue
      }
      if (msg.id === '_ready' && msg.ok) {
        this.ready = true
        for (const w of this.readyWaiters) w()
        this.readyWaiters = []
        continue
      }
      if (typeof msg.id !== 'string') continue
      const pending = this.pending.get(msg.id)
      if (!pending) continue
      this.pending.delete(msg.id)
      clearTimeout(pending.timer)
      if (msg.ok) pending.resolve(msg.result)
      else {
        const baseMsg = msg.error && msg.error.trim() ? msg.error : 'iterm-driver error'
        if (msg.trace) console.error('[iterm-driver] traceback:\n' + msg.trace)
        const full = msg.trace ? `${baseMsg}\n${msg.trace}` : baseMsg
        pending.reject(new Error(full))
      }
    }
  }

  private call<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    if (!this.proc || !this.ready) {
      return Promise.reject(new Error('iterm-driver not started'))
    }
    const id = randomUUID()
    const payload = JSON.stringify({ id, method, params }) + '\n'
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`iterm-driver call '${method}' timed out`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer
      })
      this.proc!.stdin.write(payload)
    })
  }

  ping(): Promise<{ pong: boolean }> {
    return this.call('ping')
  }

  createGrid(count: number): Promise<GridResult> {
    return this.call('create_grid', { count }, 60_000)
  }

  createWindows(count: number): Promise<GridResult> {
    return this.call('create_windows', { count }, 60_000)
  }

  createTabs(count: number): Promise<GridResult> {
    return this.call('create_tabs', { count }, 60_000)
  }

  sendText(sessionId: string, text: string): Promise<{ sent: number }> {
    return this.call('send_text', { session_id: sessionId, text })
  }

  checkSessionAlive(sessionId: string): Promise<{ alive: boolean }> {
    return this.call('check_session_alive', { session_id: sessionId })
  }

  getScreenContents(sessionId: string): Promise<{ lines: string[]; styled?: StyledRun[][] }> {
    return this.call('get_screen_contents', { session_id: sessionId }, 10_000)
  }

  closeWindow(windowId: string): Promise<{ closed: boolean }> {
    return this.call('close_window', { window_id: windowId })
  }

  closeWindows(windowIds: string[]): Promise<{ closed: number }> {
    return this.call('close_windows', { window_ids: windowIds })
  }
}
