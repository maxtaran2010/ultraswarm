import { BrowserWindow } from 'electron'
import { exec } from 'child_process'
import { promises as fs } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { SettingsStore } from './settingsStore'
import { AgentScreen, SwarmController } from './swarmController'
import { StyledRun } from './itermDriver'
import { RunStore } from './runStore'
import { RunSummary } from './types'

// ── Telegram wire types ───────────────────────────────────────────────────────

interface TgMessage {
  message_id: number
  chat: { id: number | string; type?: string }
  text?: string
  from?: { id: number; username?: string }
  reply_to_message?: { message_id: number; text?: string }
}

interface TgCallbackQuery {
  id: string
  from: { id: number; username?: string }
  message: TgMessage
  data: string
}

interface TelegramUpdate {
  update_id: number
  message?: TgMessage
  callback_query?: TgCallbackQuery
}

// ── Reply markup types ────────────────────────────────────────────────────────

interface InlineButton {
  text: string
  callback_data: string
}

type InlineKeyboard = { inline_keyboard: InlineButton[][] }
type ForceReply = { force_reply: true; selective?: boolean }
type ReplyMarkup = InlineKeyboard | ForceReply

interface SendOpts {
  parseMode?: 'Markdown' | 'HTML'
  replyMarkup?: ReplyMarkup
}

// ── Keyboard builder helpers ──────────────────────────────────────────────────

function btn(text: string, data: string): InlineButton {
  return { text, callback_data: data }
}

function kb(rows: InlineButton[][]): InlineKeyboard {
  return { inline_keyboard: rows }
}

/** Escape Markdown V1 special characters in user-provided strings. */
function escMd(s: string): string {
  return s.replace(/[_*`\[]/g, '\\$&')
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Max lines kept per pane (clipped to the bottom = most recent). */
const SNAP_MAX_LINES = 200
/** Terminal default colors used when a cell has no explicit fg/bg. */
const TERM_FG = '#cdd6e4'

/** Render one terminal line's styled runs (or plain text) to colored HTML. */
function lineToHtml(runs: StyledRun[] | undefined, plain: string): string {
  if (!runs || runs.length === 0) {
    const t = escHtml(plain)
    return t.length ? t : '&nbsp;'
  }
  let out = ''
  for (const r of runs) {
    const txt = escHtml(r.t)
    const s: string[] = []
    if (r.f) s.push(`color:${r.f}`)
    if (r.b) s.push(`background:${r.b}`)
    if (r.bo) s.push('font-weight:700')
    out += s.length ? `<span style="${s.join(';')}">${txt}</span>` : txt
  }
  return out.length ? out : '&nbsp;'
}

/**
 * Synthesize a "screenshot" of the swarm by rendering each agent's live
 * terminal text into a PNG via a hidden Electron window. This works even when
 * the lid is closed / display is locked (where a real `screencapture` would be
 * black), because the text comes from iTerm over the driver, not the GPU frame.
 *
 * Panes are tiled into a near-square grid (like macOS window tiling) and the
 * terminal's own colors are preserved from the per-cell style runs.
 */
async function renderPanesToPng(panes: AgentScreen[]): Promise<Buffer> {
  // Near-square grid: cols = ceil(sqrt(n)), rows = ceil(n/cols) — matches how
  // macOS tiles N windows across the screen.
  const n = panes.length
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)))
  const rows = Math.max(1, Math.ceil(n / cols))

  // Fixed 16:10 canvas sized so each tile has room for a terminal viewport.
  const WIDTH = Math.min(2200, Math.max(1200, cols * 720))
  const HEIGHT = Math.round((WIDTH / cols) * rows * 0.62)

  const tiles = panes
    .map((p) => {
      const styled = p.styled?.slice(-SNAP_MAX_LINES)
      const lines = p.lines.slice(-SNAP_MAX_LINES)
      const bodyHtml = lines.length
        ? lines.map((ln, i) => lineToHtml(styled?.[i], ln)).join('\n')
        : '(empty pane)'
      const title = escHtml(`${p.displayName} › ${p.agent}`)
      return `<div class="tile"><div class="hdr">${title}</div><div class="scr"><pre>${bodyHtml}</pre></div></div>`
    })
    .join('')

  const stamp = escHtml(new Date().toLocaleString())
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{background:#0b0e14;font-family:'SF Mono',Menlo,Monaco,monospace}
.grid{display:grid;grid-template-columns:repeat(${cols},1fr);grid-auto-rows:1fr;gap:8px;padding:8px;height:100%}
.tile{display:flex;flex-direction:column;background:#11151f;border:1px solid #232a39;border-radius:8px;overflow:hidden;min-height:0}
.hdr{flex:0 0 auto;height:26px;line-height:26px;padding:0 10px;background:#1a2030;color:#7dd3fc;font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.scr{flex:1 1 auto;display:flex;flex-direction:column;justify-content:flex-end;overflow:hidden;padding:6px 10px}
pre{margin:0;color:${TERM_FG};font-size:12px;line-height:15px;white-space:pre;overflow:hidden}
.stamp{position:absolute;top:2px;right:8px;color:#64748b;font-size:10px}
</style></head><body><div class="stamp">ultraswarm · ${stamp}</div><div class="grid">${tiles}</div></body></html>`

  const win = new BrowserWindow({
    show: false,
    width: WIDTH,
    height: HEIGHT,
    webPreferences: { offscreen: true }
  })
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    // Let fonts/layout settle, then capture — retry until a frame is painted so
    // offscreen timing can't hand us a blank image.
    await new Promise((r) => setTimeout(r, 200))
    let image = await win.webContents.capturePage()
    for (let i = 0; i < 6 && image.isEmpty(); i++) {
      await new Promise((r) => setTimeout(r, 200))
      image = await win.webContents.capturePage()
    }
    return image.toPNG()
  } finally {
    win.destroy()
  }
}

// ── Bot ───────────────────────────────────────────────────────────────────────

const HELP_TEXT = `*ultraswarm bot*

Tap any button that appears after /status, or use text commands:
/status — active tasks with buttons
/snap — screenshot
/inbox <agent> [taskN] — inbox messages
/sent <agent> [taskN] — sent messages
/log <agent> [taskN] — Claude responses
/msg <agent> <text> [taskN] — send text to agent
/wake [agent] [text] — wake the screen (and optionally send a prompt)`

export class TelegramBot {
  private polling = false
  private offset = 0
  private currentToken = ''
  private currentChatId = ''
  private abortController: AbortController | null = null
  /** message_id of a force-reply prompt → pending send context */
  private pendingMsg = new Map<number, { taskIdx: number; agentName: string }>()

  constructor(
    private settings: SettingsStore,
    private controller: SwarmController,
    private runs: RunStore
  ) {}

  // ── lifecycle ─────────────────────────────────────────────────────────────

  async syncFromSettings(): Promise<void> {
    const s = this.settings.current()
    const tg = s.telegram
    const wantRunning = tg.enabled && tg.botToken.length > 0
    const tokenChanged = this.currentToken !== tg.botToken || this.currentChatId !== tg.chatId
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
    const me = await this.callApi<{ username: string }>(token, 'getMe', {})
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
      // Always append a Status button so notifications are actionable
      const markup = opts.replyMarkup ?? kb([[btn('📋 Status', 's')]])
      await this.sendMsg(tg.chatId, text, { ...opts, replyMarkup: markup })
    } catch (e) {
      console.error('[TelegramBot] notify failed:', e)
    }
  }

  // ── polling ────────────────────────────────────────────────────────────────

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
          try {
            if (u.callback_query) await this.handleCallback(u.callback_query)
            else if (u.message?.text) await this.handleMessage(u.message)
          } catch (e) {
            console.error('[TelegramBot] update handler error:', e)
          }
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

  // ── text message handler ───────────────────────────────────────────────────

  private async handleMessage(msg: TgMessage): Promise<void> {
    const text = (msg.text ?? '').trim()
    const chatId = String(msg.chat.id)
    if (!this.isAuthorized(chatId)) {
      await this.sendMsg(chatId, `Not authorized. This bot is bound to chat ${this.currentChatId}.`)
      return
    }

    // Reply to a force-reply "send to agent" prompt
    if (msg.reply_to_message) {
      const ctx = this.pendingMsg.get(msg.reply_to_message.message_id)
      if (ctx) {
        this.pendingMsg.delete(msg.reply_to_message.message_id)
        await this.execSendToAgent(chatId, ctx.taskIdx, ctx.agentName, text)
        return
      }
    }

    const parts = text.split(/\s+/)
    const cmd = parts[0].toLowerCase().split('@')[0]
    const args = parts.slice(1)

    switch (cmd) {
      case '/start':
        if (!this.currentChatId) await this.bindChatId(chatId)
        await this.showStatus(chatId)
        break
      case '/help':
        await this.sendMsg(chatId, HELP_TEXT, { parseMode: 'Markdown' })
        break
      case '/status':
        await this.showStatus(chatId)
        break
      case '/agents':
        await this.showStatus(chatId)
        break
      case '/snap':
        await this.sendScreenshot(chatId)
        break
      // Legacy text commands still supported
      case '/inbox':
        await this.sendMsg(chatId, await this.renderInboxArgs(args), { parseMode: 'Markdown' })
        break
      case '/sent':
        await this.sendMsg(chatId, await this.renderSentArgs(args), { parseMode: 'Markdown' })
        break
      case '/log':
        await this.sendMsg(chatId, await this.renderLogArgs(args), { parseMode: 'Markdown' })
        break
      case '/msg':
        await this.sendMsg(chatId, await this.execMsgCmd(args))
        break
      case '/wake':
        await this.execWakeCmd(chatId, args)
        break
      default:
        await this.showStatus(chatId)
    }
  }

  // ── callback handler ───────────────────────────────────────────────────────

  private async handleCallback(cb: TgCallbackQuery): Promise<void> {
    const chatId = String(cb.message.chat.id)
    if (!this.isAuthorized(chatId)) {
      await this.answerCb(cb.id, 'Not authorized')
      return
    }

    const [cmd, ...rest] = cb.data.split(':')
    const msgId = cb.message.message_id

    try {
      switch (cmd) {
        // Main status/menu
        case 's':
          await this.editStatus(chatId, msgId)
          await this.answerCb(cb.id)
          break

        // Task detail: t:<idx>
        case 't': {
          const idx = parseInt(rest[0], 10)
          await this.editTaskDetail(chatId, msgId, idx)
          await this.answerCb(cb.id)
          break
        }

        // Agent detail: a:<idx>:<name>
        case 'a': {
          const idx = parseInt(rest[0], 10)
          const name = rest[1]
          await this.editAgentDetail(chatId, msgId, idx, name)
          await this.answerCb(cb.id)
          break
        }

        // Inbox: ib:<idx>:<name>
        case 'ib': {
          const idx = parseInt(rest[0], 10)
          const name = rest[1]
          const content = await this.renderInboxFor(idx, name)
          await this.answerCb(cb.id)
          await this.sendMsg(chatId, content, {
            parseMode: 'Markdown',
            replyMarkup: kb([[btn(`← ${name}`, `a:${rest[0]}:${name}`)]])
          })
          break
        }

        // Sent: st:<idx>:<name>
        case 'st': {
          const idx = parseInt(rest[0], 10)
          const name = rest[1]
          const content = await this.renderSentFor(idx, name)
          await this.answerCb(cb.id)
          await this.sendMsg(chatId, content, {
            parseMode: 'Markdown',
            replyMarkup: kb([[btn(`← ${name}`, `a:${rest[0]}:${name}`)]])
          })
          break
        }

        // Log: lg:<idx>:<name>
        case 'lg': {
          const idx = parseInt(rest[0], 10)
          const name = rest[1]
          const content = await this.renderLogFor(idx, name)
          await this.answerCb(cb.id)
          await this.sendMsg(chatId, content, {
            parseMode: 'Markdown',
            replyMarkup: kb([[btn(`← ${name}`, `a:${rest[0]}:${name}`)]])
          })
          break
        }

        // Message agent: mg:<idx>:<name>
        case 'mg': {
          const idx = parseInt(rest[0], 10)
          const name = rest[1]
          const tasks = this.active()
          if (!tasks[idx]) { await this.answerCb(cb.id, 'Task not found'); break }
          await this.answerCb(cb.id)
          const sent = await this.sendMsg(
            chatId,
            `Reply to this message with text to send to *${name}*:`,
            { parseMode: 'Markdown', replyMarkup: { force_reply: true, selective: true } }
          )
          if (sent) this.pendingMsg.set(sent.message_id, { taskIdx: idx, agentName: name })
          break
        }

        // Stop task: kl:<idx>
        case 'kl': {
          const idx = parseInt(rest[0], 10)
          const tasks = this.active()
          const task = tasks[idx]
          if (!task) { await this.answerCb(cb.id, 'Task not found'); break }
          try {
            await this.controller.stop(task.taskId)
            await this.answerCb(cb.id, `Stopped: ${task.displayName}`)
            await this.editStatus(chatId, msgId)
          } catch (e) {
            await this.answerCb(cb.id, `Error: ${e instanceof Error ? e.message : String(e)}`)
          }
          break
        }

        // Screenshot
        case 'sn':
          await this.answerCb(cb.id)
          await this.sendScreenshot(chatId)
          break

        // Wake the display, then refresh the menu so a prompt can be typed
        case 'wk':
          this.wakeDisplay()
          await this.answerCb(cb.id, '☀️ Screen woken')
          await this.editStatus(chatId, msgId)
          break

        default:
          await this.answerCb(cb.id, 'Unknown action')
      }
    } catch (e) {
      console.error('[TelegramBot] callback error:', e)
      await this.answerCb(cb.id, 'Error')
    }
  }

  // ── UI builders ────────────────────────────────────────────────────────────

  private async showStatus(chatId: string): Promise<void> {
    const { text, markup } = await this.buildStatusContent()
    await this.sendMsg(chatId, text, { parseMode: 'Markdown', replyMarkup: markup })
  }

  private async editStatus(chatId: string, msgId: number): Promise<void> {
    const { text, markup } = await this.buildStatusContent()
    await this.editMsg(chatId, msgId, text, { parseMode: 'Markdown', replyMarkup: markup })
  }

  private async buildStatusContent(): Promise<{ text: string; markup: InlineKeyboard }> {
    const active = this.active()
    const all = await this.runs.list()
    const stoppedCount = all.filter((r) => r.status === 'stopped').length
    const lines: string[] = []
    const rows: InlineButton[][] = []

    if (active.length === 0) {
      lines.push('No active tasks.')
      if (stoppedCount > 0) lines.push(`${stoppedCount} stopped task(s) in history.`)
    } else {
      lines.push(`*Active (${active.length}):*`)
      for (let i = 0; i < active.length; i++) {
        const t = active[i]
        lines.push(`${i + 1}. ${escMd(t.displayName)} — ${t.agents.length} agents`)
        rows.push([btn(t.displayName, `t:${i}`)])
      }
    }

    rows.push([btn('📷 Screenshot', 'sn'), btn('☀️ Wake', 'wk')])
    return { text: lines.join('\n'), markup: kb(rows) }
  }

  private async editTaskDetail(chatId: string, msgId: number, idx: number): Promise<void> {
    const task = this.active()[idx]
    if (!task) {
      await this.editMsg(chatId, msgId, 'Task not found — it may have stopped.', {
        replyMarkup: kb([[btn('← Menu', 's')]])
      })
      return
    }
    const agentNames = task.agents.map((a) => a.name)
    const text = `*${escMd(task.displayName)}*\nAgents: ${agentNames.map(escMd).join(', ')}`
    // Each agent gets its own button
    const agentRows = chunkArray(agentNames.map((n) => btn(n, `a:${idx}:${n}`)), 3)
    const actionRow = [btn('🔴 Stop task', `kl:${idx}`), btn('← Menu', 's')]
    await this.editMsg(chatId, msgId, text, {
      parseMode: 'Markdown',
      replyMarkup: kb([...agentRows, actionRow])
    })
  }

  private async editAgentDetail(
    chatId: string,
    msgId: number,
    idx: number,
    name: string
  ): Promise<void> {
    const task = this.active()[idx]
    if (!task) {
      await this.editMsg(chatId, msgId, 'Task not found — it may have stopped.', {
        replyMarkup: kb([[btn('← Menu', 's')]])
      })
      return
    }
    const text = `*${escMd(name)}* — ${escMd(task.displayName)}`
    const rows: InlineButton[][] = [
      [btn('📥 Inbox', `ib:${idx}:${name}`), btn('📤 Sent', `st:${idx}:${name}`)],
      [btn('📋 Log', `lg:${idx}:${name}`), btn('💬 Message', `mg:${idx}:${name}`)],
      [btn(`← ${task.displayName}`, `t:${idx}`)]
    ]
    await this.editMsg(chatId, msgId, text, { parseMode: 'Markdown', replyMarkup: kb(rows) })
  }

  // ── data fetchers ──────────────────────────────────────────────────────────

  private async renderInboxFor(idx: number, name: string): Promise<string> {
    const task = this.active()[idx]
    if (!task) return 'Task not found.'
    const info = this.controller.getAgentRecord(task.taskId, name)
    if (!info) return `Agent '${name}' not found.`
    const msgs = await readRecentMessages(info.inbox, 5)
    if (msgs.length === 0) return `No messages in ${name}'s inbox.`
    return `*Inbox — ${name}:*\n` + msgs.map(formatMsg).join('\n---\n')
  }

  private async renderSentFor(idx: number, name: string): Promise<string> {
    const task = this.active()[idx]
    if (!task) return 'Task not found.'
    const info = this.controller.getAgentRecord(task.taskId, name)
    if (!info) return `Agent '${name}' not found.`
    const msgs = await readRecentMessages(info.outbox, 5)
    if (msgs.length === 0) return `${name} hasn't sent anything yet.`
    return `*Sent — ${name}:*\n` + msgs.map(formatMsg).join('\n---\n')
  }

  private async renderLogFor(idx: number, name: string): Promise<string> {
    const task = this.active()[idx]
    if (!task) return 'Task not found.'
    const info = this.controller.getAgentRecord(task.taskId, name)
    if (!info) return `Agent '${name}' not found.`
    if (!info.claudeSessionId) return `No Claude session id for ${name} yet.`

    const encoded = info.projectDir.replace(/\//g, '-')
    const logPath = join(homedir(), '.claude', 'projects', encoded, `${info.claudeSessionId}.jsonl`)
    let raw: string
    try {
      raw = await fs.readFile(logPath, 'utf8')
    } catch {
      return `Log file not found for ${name} (session ${info.claudeSessionId.slice(0, 8)}…).`
    }

    const lines = raw.trim().split('\n').filter(Boolean)
    const excerpts: string[] = []
    for (let i = lines.length - 1; i >= 0 && excerpts.length < 3; i--) {
      try {
        const obj = JSON.parse(lines[i]) as Record<string, unknown>
        const role = (obj.role ?? (obj.message as Record<string, unknown>)?.role) as
          | string
          | undefined
        if (role !== 'assistant') continue
        const content = obj.content ?? (obj.message as Record<string, unknown>)?.content
        const text = extractText(content)
        if (text) excerpts.unshift(text.slice(0, 600))
      } catch {
        /* skip malformed */
      }
    }

    if (excerpts.length === 0) return `No assistant messages found in ${name}'s log yet.`
    return `*Log — ${name} (last ${excerpts.length}):*\n` + excerpts.map((e, i) => `[${i + 1}] ${e}`).join('\n---\n')
  }

  // Legacy text-command wrappers

  private renderInboxArgs(args: string[]): Promise<string> {
    const p = this.parseAgentArgs(args)
    if (!p) return Promise.resolve('Usage: /inbox <agent> [taskN]')
    return this.renderInboxFor(p.taskNum - 1, p.agentName)
  }

  private renderSentArgs(args: string[]): Promise<string> {
    const p = this.parseAgentArgs(args)
    if (!p) return Promise.resolve('Usage: /sent <agent> [taskN]')
    return this.renderSentFor(p.taskNum - 1, p.agentName)
  }

  private renderLogArgs(args: string[]): Promise<string> {
    const p = this.parseAgentArgs(args)
    if (!p) return Promise.resolve('Usage: /log <agent> [taskN]')
    return this.renderLogFor(p.taskNum - 1, p.agentName)
  }

  private async execSendToAgent(
    chatId: string,
    taskIdx: number,
    agentName: string,
    text: string
  ): Promise<void> {
    const task = this.active()[taskIdx]
    if (!task) { await this.sendMsg(chatId, 'Task not found.'); return }
    try {
      await this.controller.sendToAgent(task.taskId, agentName, text)
      await this.sendMsg(chatId, `✓ Sent to ${agentName}.`, {
        replyMarkup: kb([[btn(`← ${agentName}`, `a:${taskIdx}:${agentName}`)]])
      })
    } catch (e) {
      await this.sendMsg(chatId, `Error: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /**
   * Wake the Mac's display. `caffeinate -u` declares user activity, which brings
   * the screen back on; -t bounds the assertion. Fire-and-forget so the bot reply
   * isn't delayed. Only meaningful while the system itself is awake (e.g. the
   * keepAwakeWithLidClosed setting is holding it up) — a fully asleep Mac can't
   * receive the Telegram message in the first place. With the lid physically shut
   * the internal panel stays dark; this wakes an open lid or external display.
   */
  private wakeDisplay(seconds = 8): void {
    if (process.platform !== 'darwin') return
    const child = exec(`caffeinate -u -t ${seconds}`)
    child.on('error', (e) => console.error('[TelegramBot] wake failed:', e))
  }

  private async execWakeCmd(chatId: string, args: string[]): Promise<void> {
    this.wakeDisplay()
    if (args.length >= 2) {
      // /wake <agent> <text> [taskN] — wake and immediately deliver a prompt.
      await this.sendMsg(chatId, `☀️ Woke screen. ${await this.execMsgCmd(args)}`)
      return
    }
    // Bare /wake — show the task menu so a prompt can be typed via Message buttons.
    await this.sendMsg(chatId, '☀️ Woke the screen.')
    await this.showStatus(chatId)
  }

  private async execMsgCmd(args: string[]): Promise<string> {
    if (args.length < 2) return 'Usage: /msg <agent> <text> [taskN]'
    const p = this.parseAgentArgs(args)
    if (!p || !p.rest.trim()) return 'Usage: /msg <agent> <text> [taskN]'
    const task = this.active()[p.taskNum - 1]
    if (!task) return `No active task #${p.taskNum}.`
    try {
      await this.controller.sendToAgent(task.taskId, p.agentName, p.rest.trim())
      return `✓ Sent to ${p.agentName}.`
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`
    }
  }

  // ── screenshot ─────────────────────────────────────────────────────────────

  private async sendScreenshot(chatId: string): Promise<void> {
    let tmpPath: string | null = null
    try {
      let data: Buffer
      const panes = await this.controller.captureScreens()
      if (panes.length > 0) {
        // Synthesize from the agents' live terminal text — works lid-closed.
        data = await renderPanesToPng(panes)
      } else {
        // Nothing running: fall back to a real capture (only useful unlocked).
        tmpPath = `/tmp/ultraswarm-snap-${Date.now()}.png`
        await execShell(`screencapture -x -o "${tmpPath}"`)
        data = await fs.readFile(tmpPath)
      }
      const form = new FormData()
      form.append('chat_id', chatId)
      form.append('photo', new Blob([new Uint8Array(data)], { type: 'image/png' }), 'snap.png')
      const url = `https://api.telegram.org/bot${this.currentToken}/sendPhoto`
      const res = await fetch(url, { method: 'POST', body: form })
      const json = (await res.json()) as { ok: boolean; description?: string }
      if (!json.ok) throw new Error(json.description ?? 'sendPhoto failed')
    } catch (e) {
      await this.sendMsg(chatId, `Screenshot failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      if (tmpPath) fs.unlink(tmpPath).catch(() => {})
    }
  }

  // ── auth / binding ─────────────────────────────────────────────────────────

  private isAuthorized(chatId: string): boolean {
    return !this.currentChatId || this.currentChatId === chatId
  }

  private async bindChatId(chatId: string): Promise<void> {
    const cur = this.settings.current()
    await this.settings.save({ ...cur, telegram: { ...cur.telegram, chatId } })
    this.currentChatId = chatId
    await this.sendMsg(chatId, `Bound to this chat (id: ${chatId}).`)
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private active(): RunSummary[] {
    return this.controller.list()
  }

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

  private async sendMsg(
    chatId: string,
    text: string,
    opts: SendOpts = {}
  ): Promise<{ message_id: number } | null> {
    try {
      return await this.callApi<{ message_id: number }>(this.currentToken, 'sendMessage', {
        chat_id: chatId,
        text,
        ...(opts.parseMode ? { parse_mode: opts.parseMode } : {}),
        ...(opts.replyMarkup ? { reply_markup: opts.replyMarkup } : {})
      })
    } catch (e) {
      console.error('[TelegramBot] sendMsg failed:', e)
      return null
    }
  }

  private async editMsg(
    chatId: string,
    msgId: number,
    text: string,
    opts: SendOpts = {}
  ): Promise<void> {
    try {
      await this.callApi(this.currentToken, 'editMessageText', {
        chat_id: chatId,
        message_id: msgId,
        text,
        ...(opts.parseMode ? { parse_mode: opts.parseMode } : {}),
        ...(opts.replyMarkup ? { reply_markup: opts.replyMarkup } : {})
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!msg.includes('message is not modified')) {
        console.error('[TelegramBot] editMsg failed:', e)
      }
    }
  }

  private async answerCb(cbId: string, text?: string): Promise<void> {
    try {
      await this.callApi(this.currentToken, 'answerCallbackQuery', {
        callback_query_id: cbId,
        ...(text ? { text } : {})
      })
    } catch (e) {
      console.error('[TelegramBot] answerCb failed:', e)
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

// ── file reading helpers ─────────────────────────────────────────────────────

interface ParsedMsg {
  filename: string
  from: string
  to: string
  body: string
}

async function readRecentMessages(dir: string, count: number): Promise<ParsedMsg[]> {
  let files: string[] = []
  for (const d of [dir, join(dir, 'processed')]) {
    try {
      const entries = await fs.readdir(d)
      files.push(...entries.filter((f) => !f.startsWith('.')).map((f) => join(d, f)))
    } catch {
      /* dir missing */
    }
  }
  files.sort()
  files = files.slice(-count)

  const out: ParsedMsg[] = []
  for (const p of files) {
    try {
      const raw = await fs.readFile(p, 'utf8')
      out.push(parseMsgFile(p, raw))
    } catch {
      /* skip */
    }
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
    fm
      .split('\n')
      .find((l) => l.startsWith(`${key}:`))
      ?.replace(`${key}:`, '')
      .trim() ?? '?'
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

// ── utils ────────────────────────────────────────────────────────────────────

function chunkArray<T>(arr: T[], size: number): T[][] {
  const result: T[][] = []
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size))
  }
  return result
}

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
