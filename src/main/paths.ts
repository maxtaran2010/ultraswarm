import { app } from 'electron'
import { join } from 'path'
import { homedir } from 'os'

export const CCSWARM_HOME = join(homedir(), '.ccswarm')
export const AGENTS_DIR = join(CCSWARM_HOME, 'agents')
export const TEMPLATES_DIR = join(CCSWARM_HOME, 'templates')
export const RUNS_DIR = join(CCSWARM_HOME, 'runs')
export const CONFIG_FILE = join(CCSWARM_HOME, 'config.json')
export const DEFAULT_WORKSPACE_ROOT = join(CCSWARM_HOME, 'workspaces')

export function resourcesDir(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'resources')
  }
  return join(app.getAppPath(), 'resources')
}

export function presetsDir(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'resources', 'presets')
  }
  return join(app.getAppPath(), 'src', 'main', 'presets')
}

export function templatePresetsDir(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'resources', 'template-presets')
  }
  return join(app.getAppPath(), 'src', 'main', 'template-presets')
}

export function expandHome(p: string): string {
  if (p.startsWith('~')) return join(homedir(), p.slice(1))
  return p
}
