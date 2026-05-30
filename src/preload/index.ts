import { contextBridge, ipcRenderer } from 'electron'

const api = {
  profiles: {
    list: () => ipcRenderer.invoke('profiles:list'),
    get: (name: string) => ipcRenderer.invoke('profiles:get', name),
    save: (profile: unknown) => ipcRenderer.invoke('profiles:save', profile),
    delete: (name: string) => ipcRenderer.invoke('profiles:delete', name)
  },
  templates: {
    list: () => ipcRenderer.invoke('templates:list'),
    get: (name: string) => ipcRenderer.invoke('templates:get', name),
    save: (template: unknown) => ipcRenderer.invoke('templates:save', template),
    delete: (name: string) => ipcRenderer.invoke('templates:delete', name),
    apply: (name: string) => ipcRenderer.invoke('templates:apply', name)
  },
  settings: {
    load: () => ipcRenderer.invoke('settings:load'),
    save: (settings: unknown) => ipcRenderer.invoke('settings:save', settings),
    defaultProtocol: () => ipcRenderer.invoke('settings:defaultProtocol')
  },
  telegram: {
    test: (botToken: string, chatId: string) =>
      ipcRenderer.invoke('telegram:test', { botToken, chatId })
  },
  tasks: {
    list: () => ipcRenderer.invoke('tasks:list'),
    launch: (req: unknown) => ipcRenderer.invoke('tasks:launch', req),
    stop: (taskId: string) => ipcRenderer.invoke('tasks:stop', taskId),
    stopAll: () => ipcRenderer.invoke('tasks:stopAll'),
    resume: (taskId: string) => ipcRenderer.invoke('tasks:resume', taskId)
  },
  runs: {
    list: () => ipcRenderer.invoke('runs:list'),
    get: (taskId: string) => ipcRenderer.invoke('runs:get', taskId),
    delete: (taskId: string) => ipcRenderer.invoke('runs:delete', taskId)
  },
  dialog: {
    pickDirectory: (defaultPath?: string) =>
      ipcRenderer.invoke('dialog:pickDirectory', defaultPath)
  },
  shell: {
    openPath: (p: string) => ipcRenderer.invoke('shell:openPath', p)
  }
}

contextBridge.exposeInMainWorld('ccswarm', api)

export type CcswarmApi = typeof api
