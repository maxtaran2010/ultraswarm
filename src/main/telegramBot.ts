import { SettingsStore } from './settingsStore'
import { SwarmController } from './swarmController'
import { RunStore } from './runStore'

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

/**
 * Tiny Telegram client. We avoid pulling in a full bot library (node-telegram-bot-api,
 * telegraf, ...) because the surface we need is small: send a message, long-poll
 * for updates, answer a couple of slash commands. Anything beyond /status can
 * be added by extending dispatch().
 */
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

  /**
   * Read the current settings and (re)start the long-poll loop if telegram
   * is enabled with a token. Safe to call repeatedly — it diff-checks the
   * token/chatId and restarts only when they change.
   */
  async syncFromSettings(): Promise<void> {
    const s = this.settings.current()
    const tg = s.telegram
    const wantRunning = tg.enabled && tg.botToken.length > 0
    const tokenChanged =
      this.currentToken !== tg.botToken || this.currentChatId !== tg.chatId
    if (this.polling && (!wantRunning || tokenChanged)) {
      this.stop()
    }
    if (wantRunning && !this.polling) {
      this.currentToken = tg.botToken
      this.currentChatId = tg.chatId
      this.start()
    }
  }

  stop(): void {
    this.polling = false
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }
  }

  private start(): void {
    if (this.polling) return
    this.polling = true
    void this.pollLoop().catch((e) => {
      console.error('[TelegramBot] poll loop crashed:', e)
      this.polling = false
    })
  }

  /**
   * Verify the token by calling getMe and, if a chatId is configured, send a
   * "ccswarm connected" message. Returns the bot username on success.
   */
  async test(token: string, chatId: string): Promise<{ username: string }> {
    if (!token) throw new Error('Bot token is required')
    const me = await this.callApi<{ username: string; first_name: string }>(
      token,
      'getMe',
      {}
    )
    if (chatId) {
      await this.callApi(token, 'sendMessage', {
        chat_id: chatId,
        text: `ccswarm: test message from @${me.username}`
      })
    }
    return { username: me.username }
  }

  /**
   * Push a notification to the configured chat. No-ops cleanly when telegram
   * is disabled or unconfigured — callers should not need to guard this.
   */
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
          if (u.message?.text) {
            await this.handleCommand(u.message)
          }
        }
      } catch (e) {
        if ((e as Error).name === 'AbortError') return
        console.error('[TelegramBot] getUpdates failed:', e)
        // Token likely invalid or network blip — back off so we don't hammer.
        await delay(5000)
      } finally {
        this.abortController = null
      }
    }
  }

  private async handleCommand(message: NonNullable<TelegramUpdate['message']>): Promise<void> {
    const text = (message.text ?? '').trim()
    const chatId = String(message.chat.id)
    // If the user pinned a chatId in settings, only honour commands from that
    // chat — otherwise an attacker who guesses the bot username can drive it.
    const expected = this.currentChatId
    if (expected && expected !== chatId) {
      await this.callApi(this.currentToken, 'sendMessage', {
        chat_id: chatId,
        text: `Not authorized. This bot is bound to chat ${expected}.`
      })
      return
    }

    // Strip the @botname suffix Telegram appends in group chats.
    const cmd = text.split(/\s+/)[0].toLowerCase().split('@')[0]
    switch (cmd) {
      case '/start':
        await this.reply(
          chatId,
          'ccswarm bot online. Commands:\n/status — list active and recent runs\n/help — show this'
        )
        // Auto-bind chatId if it wasn't set yet, to make first-time setup
        // friction-free. The user can still override in Settings.
        if (!expected) {
          await this.bindChatId(chatId)
        }
        break
      case '/help':
        await this.reply(
          chatId,
          'Commands:\n/status — list active and recent runs\n/help — show this'
        )
        break
      case '/status':
        await this.reply(chatId, await this.renderStatus(), { parseMode: 'Markdown' })
        break
      default:
        await this.reply(chatId, `Unknown command: ${cmd}. Try /help.`)
    }
  }

  private async bindChatId(chatId: string): Promise<void> {
    const cur = this.settings.current()
    const next = { ...cur, telegram: { ...cur.telegram, chatId } }
    await this.settings.save(next)
    this.currentChatId = chatId
    await this.reply(chatId, `Bound to this chat (id: ${chatId}).`)
  }

  private async renderStatus(): Promise<string> {
    const active = this.controller.list()
    const all = await this.runs.list()
    const recentStopped = all
      .filter((r) => r.status === 'stopped')
      .slice(0, 5)
    const lines: string[] = []
    if (active.length === 0) {
      lines.push('*Active:* none')
    } else {
      lines.push(`*Active (${active.length}):*`)
      for (const r of active) {
        lines.push(
          `• \`${r.taskId}\` — ${r.displayName} · ${r.agents.length} agents`
        )
      }
    }
    if (recentStopped.length > 0) {
      lines.push('')
      lines.push('*Recent (stopped):*')
      for (const r of recentStopped) {
        lines.push(
          `• \`${r.taskId}\` — ${r.displayName} · stopped ${r.stoppedAt ?? '?'}`
        )
      }
    }
    return lines.join('\n')
  }

  private async reply(
    chatId: string,
    text: string,
    opts: SendOpts = {}
  ): Promise<void> {
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
    const composite = signal
      ? mergeSignals(signal, ctl.signal)
      : ctl.signal
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: composite
      })
      const json = (await res.json()) as { ok: boolean; result?: T; description?: string }
      if (!json.ok) {
        throw new Error(json.description || `Telegram API error: ${method}`)
      }
      return json.result as T
    } finally {
      clearTimeout(timer)
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
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
