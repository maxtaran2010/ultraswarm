import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
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
import {
  AgentProfileSchema,
  LaunchTaskRequestSchema,
  SettingsSchema,
  SwarmTemplateSchema
} from './types'
import { DEFAULT_PROTOCOL_TEMPLATE } from './defaultProtocol'
const isDev = !app.isPackaged

app.setName('ccswarm')

function resolveIcon(): string | undefined {
  const candidates = [
    join(__dirname, '../../build/icon.png'),
    join(process.resourcesPath, 'build/icon.png')
  ]
  return candidates.find((p) => existsSync(p))
}

let mainWindow: BrowserWindow | null = null
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
    title: 'ccswarm',
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
      swarm: {
        clientTemplate: tpl.clientTemplate,
        windowMode: tpl.windowMode,
        agents: tpl.agents
      }
    })
    return settingsStore.save(next)
  })

  ipcMain.handle('tasks:list', async () => controller.list())
  ipcMain.handle('tasks:launch', async (_e, raw: unknown) => {
    const req = LaunchTaskRequestSchema.parse(raw)
    const summary = await controller.launch(req)
    void telegram.notify(
      `🚀 ccswarm launched: ${summary.displayName}\n` +
        `task: ${summary.taskId}\n` +
        `agents: ${summary.agents.map((a) => a.name).join(', ')}`
    )
    return summary
  })
  ipcMain.handle('tasks:stop', async (_e, taskId: string) => {
    await controller.stop(taskId)
    void telegram.notify(`🛑 ccswarm stopped: ${taskId}`)
  })
  ipcMain.handle('tasks:stopAll', async () => {
    await controller.stopAll()
    void telegram.notify('🛑 ccswarm: stopped all tasks')
  })
  ipcMain.handle('tasks:resume', async (_e, taskId: string) => {
    const summary = await controller.resume(taskId)
    void telegram.notify(`▶️ ccswarm resumed: ${summary.displayName} (${summary.taskId})`)
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
  await profileStore.init()
  await settingsStore.init()
  await templateStore.init()
  await runStore.init()

  const settings = settingsStore.current()
  driver = new ITermDriver(settings.pythonPath)
  controller = new SwarmController(profileStore, settingsStore, templateStore, workspaceManager, driver, runStore)
  telegram = new TelegramBot(settingsStore, controller, runStore)
  await telegram.syncFromSettings()

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
  } catch {
    /* ignore */
  }
  if (process.platform !== 'darwin') app.quit()
})
