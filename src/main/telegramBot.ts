import { exec } from 'child_process'
import { promises as fs } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { SettingsStore } from './settingsStore'
import { SwarmController } from './swarmController'
import { RunStore } from './runStore'
import { RunSummary } from './types'

interface TelegramUpdate {
  update_id: number
  message?: {
    message_id: number
    chat: { id: number | string; type?: string }
    text?: string
    from?: { id: number; username?: string }
  }
}

interface SendOpts {
  parseMode?: 'Markdown' | 'HTML'
}

const HELP = `Commands:
/status — active + recent tasks
/agents — list active agents
/inbox <agent> [taskN] — recent inbox messages
/sent <agent> [taskN] — recent sent messages
/log <agent> [taskN] — last Claude responses
/msg <agent> <text> [taskN] — inject text to agent
/snap — screenshot
/help — this message`

export class TelegramBot {
  private polling = false
  private offset = 0
  private currentToken = ''
  private currentChatId = ''
  private abortController: AbortController | null = null

  constructor(
    private settings: SettingsStore,
    private controller: SwarmController,
    private runs: RunStore
  ) {}

  async syncFromSettings(): Promise<void> {
    const s = this.settings.current()
    const tg = s.telegram
    const wantRunning = tg.enabled && tg.botToken.length > 0
    const tokenChanged =
      this.currentToken !== tg.botToken || this.currentChatId !== tg.chatId
    if (this.polling && (!wantRunning || tokenChanged)) this.stop()
    if (wantRunning && !this.polling) {
      this.currentToken = tg.botToken
      this.currentChatId = tg.chatId
      this.start()
    }
  }

  stop(): void {
    this.polling = false
    this.abortController?.abort()
    this.abortController = null
  }

  private start(): void {
    if (this.polling) return
    this.polling = true
    void this.pollLoop().catch((e) => {
      console.error('[TelegramBot] poll loop crashed:', e)
      this.polling = false
    })
  }

  async test(token: string, chatId: string): Promise<{ username: string }> {
    if (!token) throw new Error('Bot token is required')
    const me = await this.callApi<{ username: string; first_name: string }>(token, 'getMe', {})
    if (chatId) {
      await this.callApi(token, 'sendMessage', {
        chat_id: chatId,
        text: `ultraswarm: test message from @${me.username}`
      })
    }
    return { username: me.username }
  }

  async notify(text: string, opts: SendOpts = {}): Promise<void> {
    const tg = this.settings.current().telegram
    if (!tg.enabled || !tg.botToken || !tg.chatId) return
    try {
      await this.callApi(tg.botToken, 'sendMessage', {
        chat_id: tg.chatId,
        text,
        ...(opts.parseMode ? { parse_mode: opts.parseMode } : {})
      })
    } catch (e) {
      console.error('[TelegramBot] notify failed:', e)
    }
  }

  private async pollLoop(): Promise<void> {
    while (this.polling) {
      const token = this.currentToken
      this.abortController = new AbortController()
      try {
        const updates = await this.callApi<TelegramUpdate[]>(
          token,
          'getUpdates',
          { offset: this.offset, timeout: 25 },
          this.abortController.signal,
          30_000
        )
        for (const u of updates) {
          this.offset = Math.max(this.offset, u.update_id + 1)
          if (u.message?.text) await this.handleCommand(u.message)
        }
      } catch (e) {
        if ((e as Error).name === 'AbortError') return
        console.error('[TelegramBot] getUpdates failed:', e)
        await delay(5000)
      } finally {
        this.abortController = null
      }
    }
  }

  private async handleCommand(message: NonNullable<TelegramUpdate['message']>): Promise<void> {
    const text = (message.text ?? '').trim()
    const chatId = String(message.chat.id)
    const expected = this.currentChatId
    if (expected && expected !== chatId) {
      await this.reply(chatId, `Not authorized. This bot is bound to chat ${expected}.`)
      return
    }

    const parts = text.split(/\s+/)
    const cmd = parts[0].toLowerCase().split('@')[0]
    const args = parts.slice(1)

    switch (cmd) {
      case '/start':
        await this.reply(chatId, `ultraswarm bot online.\n\n${HELP}`)
        if (!expected) await this.bindChatId(chatId)
        break
      case '/help':
        await this.reply(chatId, HELP)
        break
      case '/status':
        await this.reply(chatId, await this.renderStatus(), { parseMode: 'Markdown' })
        break
      case '/agents':
        await this.reply(chatId, this.renderAgents(), { parseMode: 'Markdown' })
        break
      case '/inbox':
        await this.reply(chatId, await this.renderInbox(args), { parseMode: 'Markdown' })
        break
      case '/sent':
        await this.reply(chatId, await this.renderSent(args), { parseMode: 'Markdown' })
        break
      case '/log':
        await this.reply(chatId, await this.renderLog(args), { parseMode: 'Markdown' })
        break
      case '/msg':
        await this.reply(chatId, await this.handleMsg(args))
        break
      case '/snap':
        await this.sendScreenshot(chatId)
        break
      default:
        await this.reply(chatId, `Unknown command: ${cmd}\n\n${HELP}`)
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private active(): RunSummary[] {
    return this.controller.list()
  }

  /** Resolve task by optional 1-based index (default: first task). */
  private resolveTask(taskNum?: number): RunSummary | null {
    const list = this.active()
    if (list.length === 0) return null
    const idx = (taskNum ?? 1) - 1
    return list[idx] ?? null
  }

  /**
   * Parse [agent, taskNum?] or [taskNum, agent] from args.
   * If args[0] is a number → treat as taskNum, next word is agent.
   * Otherwise args[0] is agent, optional args[1] is taskNum.
   */
  private parseAgentArgs(args: string[]): { agentName: string; taskNum: number; rest: string } | null {
    if (args.length === 0) return null
    let taskNum = 1
    let agentName = ''
    let rest = ''

    const firstIsNum = /^\d+$/.test(args[0])
    if (firstIsNum) {
      taskNum = parseInt(args[0], 10)
      if (args.length < 2) return null
      agentName = args[1]
      rest = args.slice(2).join(' ')
    } else {
      agentName = args[0]
      if (args.length >= 2 && /^\d+$/.test(args[args.length - 1])) {
        taskNum = parseInt(args[args.length - 1], 10)
        rest = args.slice(1, -1).join(' ')
      } else {
        rest = args.slice(1).join(' ')
      }
    }
    return { agentName, taskNum, rest }
  }

  // ── command renderers ─────────────────────────────────────────────────────

  private renderAgents(): string {
    const tasks = this.active()
    if (tasks.length === 0) return 'No active tasks.'
    return tasks
      .map((t, i) => {
        const agents = t.agents.map((a) => a.name).join(', ')
        return `*${i + 1}. ${t.displayName}*\n   ${agents}`
      })
      .join('\n\n')
  }

  private async renderStatus(): Promise<string> {
    const active = this.active()
    const all = await this.runs.list()
    const recentStopped = all.filter((r) => r.status === 'stopped').slice(0, 5)
    const lines: string[] = []
    if (active.length === 0) {
      lines.push('*Active:* none')
    } else {
      lines.push(`*Active (${active.length}):*`)
      for (const r of active) {
        lines.push(`• \`${r.taskId}\` — ${r.displayName} · ${r.agents.length} agents`)
      }
    }
    if (recentStopped.length > 0) {
      lines.push('', '*Recent (stopped):*')
      for (const r of recentStopped) {
        lines.push(`• ${r.displayName} · ${r.stoppedAt ?? '?'}`)
      }
    }
    return lines.join('\n')
  }

  private async renderInbox(args: string[]): Promise<string> {
    const parsed = this.parseAgentArgs(args)
    if (!parsed) return 'Usage: /inbox <agent> [taskN]'
    const task = this.resolveTask(parsed.taskNum)
    if (!task) return `No active task #${parsed.taskNum}.`
    const info = this.controller.getAgentRecord(task.taskId, parsed.agentName)
    if (!info) return `Agent '${parsed.agentName}' not found in task ${parsed.taskNum}.`

    const msgs = await readRecentMessages(info.inbox, 5)
    if (msgs.length === 0) return `No messages in ${parsed.agentName}'s inbox.`
    const header = `*Inbox — ${parsed.agentName}:*\n`
    return header + msgs.map(formatMsg).join('\n---\n')
  }

  private async renderSent(args: string[]): Promise<string> {
    const parsed = this.parseAgentArgs(args)
    if (!parsed) return 'Usage: /sent <agent> [taskN]'
    const task = this.resolveTask(parsed.taskNum)
    if (!task) return `No active task #${parsed.taskNum}.`
    const info = this.controller.getAgentRecord(task.taskId, parsed.agentName)
    if (!info) return `Agent '${parsed.agentName}' not found in task ${parsed.taskNum}.`

    const msgs = await readRecentMessages(info.outbox, 5)
    if (msgs.length === 0) return `${parsed.agentName} hasn't sent anything yet.`
    const header = `*Sent — ${parsed.agentName}:*\n`
    return header + msgs.map(formatMsg).join('\n---\n')
  }

  private async renderLog(args: string[]): Promise<string> {
    const parsed = this.parseAgentArgs(args)
    if (!parsed) return 'Usage: /log <agent> [taskN]'
    const task = this.resolveTask(parsed.taskNum)
    if (!task) return `No active task #${parsed.taskNum}.`
    const info = this.controller.getAgentRecord(task.taskId, parsed.agentName)
    if (!info) return `Agent '${parsed.agentName}' not found in task ${parsed.taskNum}.`
    if (!info.claudeSessionId) return `No Claude session id for ${parsed.agentName} yet.`

    const encoded = info.projectDir.replace(/\//g, '-')
    const logPath = join(homedir(), '.claude', 'projects', encoded, `${info.claudeSessionId}.jsonl`)
    let raw: string
    try {
      raw = await fs.readFile(logPath, 'utf8')
    } catch {
      return `Log file not found for ${parsed.agentName} (session ${info.claudeSessionId.slice(0, 8)}…).`
    }

    // Extract last 3 assistant text blocks from JSONL.
    const lines = raw.trim().split('\n').filter(Boolean)
    const excerpts: string[] = []
    for (let i = lines.length - 1; i >= 0 && excerpts.length < 3; i--) {
      try {
        const obj = JSON.parse(lines[i]) as Record<string, unknown>
        const role = (obj.role ?? (obj.message as Record<string, unknown>)?.role) as string | undefined
        if (role !== 'assistant') continue
        const content =
          obj.content ?? (obj.message as Record<string, unknown>)?.content
        const text = extractText(content)
        if (text) excerpts.unshift(text.slice(0, 600))
      } catch { /* skip malformed line */ }
    }

    if (excerpts.length === 0) return `No assistant messages found in ${parsed.agentName}'s log yet.`
    const header = `*Log — ${parsed.agentName} (last ${excerpts.length}):*\n`
    return header + excerpts.map((e, i) => `[${i + 1}] ${e}`).join('\n---\n')
  }

  private async handleMsg(args: string[]): Promise<string> {
    // Format: /msg <agent> <text...> [taskN at end]
    // or:     /msg <taskN> <agent> <text...>
    if (args.length < 2) return 'Usage: /msg <agent> <text> [taskN]'
    const parsed = this.parseAgentArgs(args)
    if (!parsed) return 'Usage: /msg <agent> <text> [taskN]'
    if (!parsed.rest.trim()) return 'Usage: /msg <agent> <text> [taskN]'
    const task = this.resolveTask(parsed.taskNum)
    if (!task) return `No active task #${parsed.taskNum}.`
    try {
      await this.controller.sendToAgent(task.taskId, parsed.agentName, parsed.rest.trim())
      return `✓ Sent to ${parsed.agentName}.`
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`
    }
  }

  private async sendScreenshot(chatId: string): Promise<void> {
    const tmpPath = `/tmp/ultraswarm-snap-${Date.now()}.png`
    try {
      await execShell(`screencapture -x -o "${tmpPath}"`)
      const data = await fs.readFile(tmpPath)
      const form = new FormData()
      form.append('chat_id', chatId)
      form.append('photo', new Blob([data], { type: 'image/png' }), 'snap.png')
      const url = `https://api.telegram.org/bot${this.currentToken}/sendPhoto`
      const res = await fetch(url, { method: 'POST', body: form })
      const json = (await res.json()) as { ok: boolean; description?: string }
      if (!json.ok) throw new Error(json.description ?? 'sendPhoto failed')
    } catch (e) {
      await this.reply(chatId, `Screenshot failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      fs.unlink(tmpPath).catch(() => {})
    }
  }

  // ── plumbing ──────────────────────────────────────────────────────────────

  private async bindChatId(chatId: string): Promise<void> {
    const cur = this.settings.current()
    await this.settings.save({ ...cur, telegram: { ...cur.telegram, chatId } })
    this.currentChatId = chatId
    await this.reply(chatId, `Bound to this chat (id: ${chatId}).`)
  }

  private async reply(chatId: string, text: string, opts: SendOpts = {}): Promise<void> {
    try {
      await this.callApi(this.currentToken, 'sendMessage', {
        chat_id: chatId,
        text,
        ...(opts.parseMode ? { parse_mode: opts.parseMode } : {})
      })
    } catch (e) {
      console.error('[TelegramBot] reply failed:', e)
    }
  }

  private async callApi<T = unknown>(
    token: string,
    method: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = 15_000
  ): Promise<T> {
    const url = `https://api.telegram.org/bot${token}/${method}`
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    const composite = signal ? mergeSignals(signal, ctl.signal) : ctl.signal
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: composite
      })
      const json = (await res.json()) as { ok: boolean; result?: T; description?: string }
      if (!json.ok) throw new Error(json.description || `Telegram API error: ${method}`)
      return json.result as T
    } finally {
      clearTimeout(timer)
    }
  }
}

// ── file reading helpers ────────────────────────────────────────────────────

interface ParsedMsg {
  filename: string
  from: string
  to: string
  body: string
}

async function readRecentMessages(dir: string, count: number): Promise<ParsedMsg[]> {
  let files: string[] = []
  // Read from inbox/outbox dir + processed subdir if exists.
  for (const d of [dir, join(dir, 'processed')]) {
    try {
      const entries = await fs.readdir(d)
      files.push(...entries.filter((f) => !f.startsWith('.')).map((f) => join(d, f)))
    } catch { /* dir missing */ }
  }
  // Sort by filename (timestamp-prefixed) descending, take last N.
  files.sort()
  files = files.slice(-count)

  const out: ParsedMsg[] = []
  for (const p of files) {
    try {
      const raw = await fs.readFile(p, 'utf8')
      out.push(parseMsgFile(p, raw))
    } catch { /* skip */ }
  }
  return out
}

function parseMsgFile(filepath: string, raw: string): ParsedMsg {
  const filename = filepath.split('/').pop() ?? filepath
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (!fmMatch) return { filename, from: '?', to: '?', body: raw.trim() }
  const fm = fmMatch[1]
  const body = fmMatch[2].trim()
  const getField = (key: string) =>
    fm.split('\n').find((l) => l.startsWith(`${key}:`))?.replace(`${key}:`, '').trim() ?? '?'
  return { filename, from: getField('from'), to: getField('to'), body }
}

function formatMsg(m: ParsedMsg): string {
  const preview = m.body.length > 400 ? m.body.slice(0, 400) + '…' : m.body
  return `_${m.from} → ${m.to}_\n${preview}`
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'object' && c !== null ? (c as Record<string, unknown>).text : ''))
      .filter(Boolean)
      .join(' ') as string
  }
  return ''
}

// ── utils ───────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function execShell(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 10_000 }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout.trim())
    })
  })
}

function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (a.aborted) return a
  if (b.aborted) return b
  const ctl = new AbortController()
  const onAbort = (): void => ctl.abort()
  a.addEventListener('abort', onAbort, { once: true })
  b.addEventListener('abort', onAbort, { once: true })
  return ctl.signal
}
