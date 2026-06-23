import { app, BrowserWindow, dialog, ipcMain, Notification, powerSaveBlocker, shell } from 'electron'
import { spawn, execFile, execFileSync, type ChildProcess } from 'child_process'
import { join } from 'path'
import { existsSync } from 'fs'
import { ProfileStore } from './profileStore'
import { SettingsStore } from './settingsStore'
import { SwarmTemplateStore } from './swarmTemplateStore'
import { RunStore } from './runStore'
import { WorkspaceManager } from './workspaceManager'
import { ITermDriver } from './itermDriver'
import { SwarmController } from './swarmController'
import { TelegramBot } from './telegramBot'
import { checkSetup, runSetup } from './setupCheck'
import {
  AgentProfileSchema,
  LaunchTaskRequestSchema,
  SettingsSchema,
  SwarmTemplateSchema
} from './types'
import { DEFAULT_PROTOCOL_TEMPLATE } from './defaultProtocol'
const isDev = !app.isPackaged

app.setName('ultraswarm')

function resolveIcon(): string | undefined {
  const candidates = [
    join(__dirname, '../../build/icon.png'),
    join(process.resourcesPath, 'build/icon.png')
  ]
  return candidates.find((p) => existsSync(p))
}

let mainWindow: BrowserWindow | null = null
let sleepBlockerId: number | null = null

function applySleepBlocker(prevent: boolean): void {
  if (prevent && sleepBlockerId === null) {
    sleepBlockerId = powerSaveBlocker.start('prevent-display-sleep')
  } else if (!prevent && sleepBlockerId !== null) {
    powerSaveBlocker.stop(sleepBlockerId)
    sleepBlockerId = null
  }
}

// Holds a macOS power assertion (via `caffeinate`) so the machine keeps running
// with the lid closed while agents are working. Electron's powerSaveBlocker maps
// to PreventUserIdleSystemSleep, which does NOT survive a clamshell close; only
// caffeinate's -s (PreventSystemSleep) does. We omit -d on purpose so the display
// is still free to sleep when the lid shuts (and startClamshellWatch() forces it
// off under a closed lid regardless). Note: like all such assertions, this is only
// honored while on AC power — on battery macOS still clamshell-sleeps.
let caffeinate: ChildProcess | null = null

function applyLidKeepAlive(): void {
  const enabled = settingsStore?.current().general.keepAwakeWithLidClosed ?? false
  const needed = process.platform === 'darwin' && enabled && (controller?.hasLiveAgents() ?? false)
  if (needed && !caffeinate) {
    // -s: prevent system sleep (survives lid close); -i: prevent idle sleep;
    // -w <pid>: self-destruct if this app dies without cleaning up.
    const child = spawn('caffeinate', ['-s', '-i', '-w', String(process.pid)], { stdio: 'ignore' })
    child.on('exit', () => { if (caffeinate === child) caffeinate = null })
    child.on('error', (e) => { console.error('[keepAwake] caffeinate failed:', e); if (caffeinate === child) caffeinate = null })
    caffeinate = child
  } else if (!needed && caffeinate) {
    try { caffeinate.kill() } catch { /* ignore */ }
    caffeinate = null
  }
  setSystemSleepDisabled(needed)
  if (needed) startClamshellWatch()
  else stopClamshellWatch()
}

// `pmset disablesleep 1` keeps the system awake under a closed lid, but as a side
// effect it also leaves the internal panel lit — a heat/wear hazard while the lid
// is shut. disablesleep only blocks *automatic* display sleep, not an explicit
// `pmset displaysleepnow`, so while keepalive is engaged we poll the clamshell
// sensor and force the panel off whenever the lid is closed. We never blank the
// display while the lid is open, so it can't interrupt the user.
let clamshellTimer: NodeJS.Timeout | null = null

function lidIsClosed(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('ioreg', ['-r', '-k', 'AppleClamshellState', '-d', '4'], (err, stdout) => {
      if (err) return resolve(false)
      resolve(/"AppleClamshellState"\s*=\s*Yes/i.test(stdout))
    })
  })
}

function startClamshellWatch(): void {
  if (clamshellTimer || process.platform !== 'darwin') return
  const tick = async (): Promise<void> => {
    if (await lidIsClosed()) execFile('pmset', ['displaysleepnow'], () => {})
  }
  void tick()
  clamshellTimer = setInterval(() => void tick(), 10000)
}

function stopClamshellWatch(): void {
  if (!clamshellTimer) return
  clearInterval(clamshellTimer)
  clamshellTimer = null
}

// `caffeinate` only holds on AC power. To also survive a lid close on *battery*
// we flip the system-wide `pmset -a disablesleep` flag, which needs admin rights.
// This persists across crash/reboot, so it is a footgun: we always revert it to 0
// when agents go idle and on quit, and clear any stale value left by a prior crash
// at startup (see clearStaleSleepDisabled). `pmsetActive` tracks what we last
// applied so we only prompt for a password on real transitions.
let pmsetActive = false

function runAdmin(shellCmd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Escape for embedding inside an AppleScript double-quoted string literal.
    const escaped = shellCmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const script = `do shell script "${escaped}" with administrator privileges`
    execFile('osascript', ['-e', script], (err) => (err ? reject(err) : resolve()))
  })
}

function setSystemSleepDisabled(on: boolean): void {
  if (process.platform !== 'darwin') return
  if (on === pmsetActive) return
  pmsetActive = on
  // macOS shows a native admin-password dialog on the first call (cached ~5 min).
  runAdmin(`/usr/bin/pmset -a disablesleep ${on ? 1 : 0}`).catch((e) => {
    console.error('[keepAwake] pmset disablesleep failed:', e)
    pmsetActive = !on // roll back so the next transition retries
  })
}

// If a previous run crashed while disablesleep was 1, the machine would never
// sleep again. At startup, read the (no-sudo) current value and, if it is stuck
// on with no agents running, mark it active so applyLidKeepAlive reverts it.
function clearStaleSleepDisabled(): void {
  if (process.platform !== 'darwin') return
  execFile('pmset', ['-g'], (err, stdout) => {
    if (err) return
    if (/SleepDisabled\s+1/i.test(stdout)) {
      pmsetActive = true // pretend we set it, so applyLidKeepAlive() flips it back to 0
      applyLidKeepAlive()
    }
  })
}

let profileStore: ProfileStore
let settingsStore: SettingsStore
let templateStore: SwarmTemplateStore
let runStore: RunStore
let workspaceManager: WorkspaceManager
let driver: ITermDriver
let controller: SwarmController
let telegram: TelegramBot

async function createWindow(): Promise<void> {
  const icon = resolveIcon()
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    title: 'ultraswarm',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1a1a1a',
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    await mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    await mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  ipcMain.handle('profiles:list', async () => profileStore.list())
  ipcMain.handle('profiles:get', async (_e, name: string) => profileStore.get(name))
  ipcMain.handle('profiles:save', async (_e, raw: unknown) => {
    const parsed = AgentProfileSchema.parse(raw)
    return profileStore.save(parsed)
  })
  ipcMain.handle('profiles:delete', async (_e, name: string) => profileStore.delete(name))

  ipcMain.handle('settings:load', async () => settingsStore.load())
  ipcMain.handle('settings:save', async (_e, raw: unknown) => {
    const parsed = SettingsSchema.parse(raw)
    const saved = await settingsStore.save(parsed)
    applySleepBlocker(saved.general.preventSleep)
    applyLidKeepAlive()
    await telegram.syncFromSettings()
    return saved
  })
  ipcMain.handle('settings:defaultProtocol', async () => DEFAULT_PROTOCOL_TEMPLATE)

  ipcMain.handle('telegram:test', async (_e, raw: unknown) => {
    const args = raw as { botToken?: string; chatId?: string }
    return telegram.test(args?.botToken ?? '', args?.chatId ?? '')
  })

  ipcMain.handle('templates:list', async () => templateStore.list())
  ipcMain.handle('templates:get', async (_e, name: string) => templateStore.get(name))
  ipcMain.handle('templates:save', async (_e, raw: unknown) => {
    const parsed = SwarmTemplateSchema.parse(raw)
    return templateStore.save(parsed)
  })
  ipcMain.handle('templates:delete', async (_e, name: string) => templateStore.delete(name))
  ipcMain.handle('templates:apply', async (_e, name: string) => {
    const tpl = await templateStore.get(name)
    if (!tpl) throw new Error(`Template '${name}' not found`)
    const current = await settingsStore.load()
    const next = SettingsSchema.parse({
      ...current,
      swarm: { ...current.swarm, agents: tpl.agents }
    })
    return settingsStore.save(next)
  })

  ipcMain.handle('tasks:list', async () => controller.list())
  ipcMain.handle('tasks:launch', async (_e, raw: unknown) => {
    const req = LaunchTaskRequestSchema.parse(raw)
    const summary = await controller.launch(req)
    if (Notification.isSupported()) {
      new Notification({
        title: 'ultraswarm — task launched',
        body: `${summary.displayName} · ${summary.agents.length} agents · skill installed`
      }).show()
    }
    void telegram.notify(
      `🚀 Launched: ${summary.displayName}\n` +
        `Agents: ${summary.agents.map((a) => a.name).join(', ')}`
    )
    return summary
  })
  ipcMain.handle('tasks:stop', async (_e, taskId: string) => {
    const run = controller.list().find((r) => r.taskId === taskId)
    await controller.stop(taskId)
    void telegram.notify(`🛑 Stopped: ${run?.displayName ?? taskId}`)
  })
  ipcMain.handle('tasks:stopAll', async () => {
    await controller.stopAll()
    void telegram.notify('🛑 Stopped all tasks')
  })
  ipcMain.handle('tasks:resendProtocols', async (_e, taskId: string) => {
    await controller.resendProtocols(taskId)
  })
  ipcMain.handle('tasks:resume', async (_e, taskId: string) => {
    const summary = await controller.resume(taskId)
    void telegram.notify(`▶️ Resumed: ${summary.displayName}\nAgents: ${summary.agents.map((a) => a.name).join(', ')}`)
    return summary
  })

  ipcMain.handle('runs:list', async () => runStore.list())
  ipcMain.handle('runs:get', async (_e, taskId: string) => runStore.get(taskId))
  ipcMain.handle('runs:delete', async (_e, taskId: string) => runStore.delete(taskId))

  ipcMain.handle('dialog:pickDirectory', async (_e, defaultPath?: string) => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    const opts: Electron.OpenDialogOptions = {
      properties: ['openDirectory', 'createDirectory'],
      ...(defaultPath ? { defaultPath } : {})
    }
    const result = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts)
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('shell:openPath', async (_e, p: string) => shell.openPath(p))

  ipcMain.handle('setup:check', async () => checkSetup())
  ipcMain.handle('setup:run', async () => runSetup())
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin' && app.dock) {
    const icon = resolveIcon()
    if (icon) {
      try {
        app.dock.setIcon(icon)
      } catch {
        /* ignore */
      }
    }
  }
  profileStore = new ProfileStore()
  settingsStore = new SettingsStore()
  templateStore = new SwarmTemplateStore()
  runStore = new RunStore()
  workspaceManager = new WorkspaceManager()
  const setupResult = await runSetup()
  if (setupResult.errors.length > 0) {
    console.warn('[setup]', setupResult.errors.join('; '))
  }

  await profileStore.init()
  await settingsStore.init()
  await templateStore.init()
  await runStore.init()

  const settings = settingsStore.current()
  applySleepBlocker(settings.general.preventSleep)
  driver = new ITermDriver(settings.pythonPath)
  controller = new SwarmController(profileStore, settingsStore, templateStore, workspaceManager, driver, runStore)
  telegram = new TelegramBot(settingsStore, controller, runStore)
  await telegram.syncFromSettings()

  controller.onEvent = (event) => {
    if (event.type === 'agents_exited') {
      void telegram.notify(`✅ All agents done: ${event.displayName}`)
    }
  }
  controller.onActiveChange = () => applyLidKeepAlive()
  clearStaleSleepDisabled()

  registerIpc()
  await createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', async () => {
  try {
    telegram?.stop()
    await controller?.stopAll()
    await driver?.stop()
    if (caffeinate) {
      try { caffeinate.kill() } catch { /* ignore */ }
      caffeinate = null
    }
    stopClamshellWatch()
  } catch {
    /* ignore */
  }
  if (process.platform !== 'darwin') app.quit()
})

// Last-resort revert: ensure we never leave the system unable to sleep. Runs
// synchronously so it completes before the process exits (admin auth is usually
// still cached from when it was enabled, so no prompt).
app.on('before-quit', () => {
  if (!pmsetActive) return
  pmsetActive = false
  try {
    execFileSync('osascript', [
      '-e',
      'do shell script "/usr/bin/pmset -a disablesleep 0" with administrator privileges'
    ])
  } catch (e) {
    console.error('[keepAwake] failed to revert disablesleep on quit:', e)
  }
})
