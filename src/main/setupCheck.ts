import { execFile, exec } from 'child_process'
import { promises as fs } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { ULTRASWARM_HOME, AGENTS_DIR, CONFIG_FILE } from './paths'
import { DEFAULT_PROTOCOL_TEMPLATE } from './defaultProtocol'

export interface SetupStatus {
  python3: { found: boolean; path: string | null }
  iterm2: { found: boolean; installing?: boolean }
  configExists: boolean
  agentProfileExists: boolean
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5000 }, (err, stdout) => {
      if (err) return reject(err)
      resolve(stdout.trim())
    })
  })
}

function runShell(cmd: string, timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: timeoutMs }, (err, stdout) => {
      if (err) return reject(err)
      resolve(stdout.trim())
    })
  })
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function findPython3(): Promise<string | null> {
  const home = homedir()

  // 1. Ask the shell first — picks up PATH from .zshrc/.bashrc
  for (const which of ['/usr/bin/which', '/bin/which']) {
    try {
      const p = await run(which, ['python3'])
      if (p && (await fileExists(p))) return p
    } catch {
      /* try next */
    }
  }

  // 2. Well-known static paths — ordered by preference
  const candidates = [
    // Homebrew Apple Silicon
    '/opt/homebrew/bin/python3',
    // Homebrew Intel
    '/usr/local/bin/python3',
    // System Python
    '/usr/bin/python3',
    // pyenv shims
    join(home, '.pyenv', 'shims', 'python3'),
    // uv managed python
    join(home, '.local', 'bin', 'python3'),
    // conda / miniforge / miniconda / anaconda (base env)
    join(home, 'miniforge3', 'bin', 'python3'),
    join(home, 'miniforge-pypy3', 'bin', 'python3'),
    join(home, 'miniconda3', 'bin', 'python3'),
    join(home, 'anaconda3', 'bin', 'python3'),
    join(home, 'mambaforge', 'bin', 'python3'),
    // Homebrew versioned (3.12, 3.11, 3.10)
    '/opt/homebrew/opt/python@3.12/bin/python3',
    '/opt/homebrew/opt/python@3.11/bin/python3',
    '/opt/homebrew/opt/python@3.10/bin/python3',
    '/usr/local/opt/python@3.12/bin/python3',
    '/usr/local/opt/python@3.11/bin/python3',
  ]
  for (const p of candidates) {
    if (await fileExists(p)) return p
  }

  // 3. Ask pyenv directly if installed
  try {
    const pyenvRoot = await runShell('pyenv root 2>/dev/null', 5000)
    if (pyenvRoot) {
      const p = join(pyenvRoot, 'shims', 'python3')
      if (await fileExists(p)) return p
    }
  } catch {
    /* pyenv not installed */
  }

  // 4. Ask uv to find a python
  try {
    const uvPath = await runShell('uv python find 2>/dev/null', 5000)
    if (uvPath && (await fileExists(uvPath))) return uvPath
  } catch {
    /* uv not installed */
  }

  return null
}

async function brewPath(): Promise<string | null> {
  for (const p of ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']) {
    if (await fileExists(p)) return p
  }
  try {
    return await run('/usr/bin/which', ['brew'])
  } catch {
    return null
  }
}

export async function checkSetup(): Promise<SetupStatus> {
  const python3Path = await findPython3()
  const python3Found = python3Path !== null

  let iterm2Found = false
  try {
    await fs.access('/Applications/iTerm.app')
    iterm2Found = true
  } catch {
    try {
      await fs.access(join(homedir(), 'Applications/iTerm.app'))
      iterm2Found = true
    } catch {
      /* not found */
    }
  }

  const configExists = await fileExists(CONFIG_FILE)
  const agentProfileExists = await fileExists(join(AGENTS_DIR, 'claude-code.json'))

  return {
    python3: { found: python3Found, path: python3Path },
    iterm2: { found: iterm2Found },
    configExists,
    agentProfileExists
  }
}

const BUILTIN_PROFILES: Record<string, object> = {
  'claude-code.json': {
    name: 'claude-code',
    displayName: 'Claude Code',
    command: 'claude',
    args: ['--dangerously-skip-permissions', '--session-id', '{{session_id}}'],
    resumeArgs: ['--dangerously-skip-permissions', '--resume', '{{session_id}}'],
    env: {},
    cwd: '${workspace}/agents/${name}',
    initialPrompt:
      'You are a Claude Code agent in a swarm. Read your inbox before each step and use the protocol above to coordinate with peers.',
    prelude: '\r',
    readyDelayMs: 500
  }
}

export async function runSetup(): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = []
  const status = await checkSetup()

  if (!status.python3.found) {
    errors.push('python3 not found — install via: brew install python3')
  }

  if (!status.iterm2.found) {
    const brew = await brewPath()
    if (brew) {
      console.log('[setup] iTerm2 not found — installing via brew…')
      try {
        await runShell(`${brew} install --cask iterm2`, 300_000)
        console.log('[setup] iTerm2 installed successfully')
      } catch (e) {
        errors.push(`iTerm2 auto-install failed: ${String(e)}. Run manually: brew install --cask iterm2`)
      }
    } else {
      errors.push('iTerm2 not found. Install via: brew install --cask iterm2')
    }
  }

  await fs.mkdir(ULTRASWARM_HOME, { recursive: true })
  await fs.mkdir(AGENTS_DIR, { recursive: true })

  if (!status.configExists) {
    const config = {
      workspaceRoot: '~/.ultraswarm/workspaces',
      terminal: 'iterm2',
      pythonPath: status.python3.path ?? 'python3',
      protocolTemplate: DEFAULT_PROTOCOL_TEMPLATE,
      swarm: {
        clientTemplate: 'claude-code',
        windowMode: 'windows',
        agents: [{ name: 'agent-1', role: '' }]
      },
      general: {
        autoStart: false,
        fontSize: 13
      }
    }
    await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', 'utf8')
  } else if (status.python3.path) {
    try {
      const raw = await fs.readFile(CONFIG_FILE, 'utf8')
      const config = JSON.parse(raw)
      if (config.pythonPath === 'python3' && status.python3.path !== 'python3') {
        config.pythonPath = status.python3.path
        await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', 'utf8')
      }
    } catch {
      /* leave config as-is */
    }
  }

  // Seed all builtin agent profiles (skip if already present — don't overwrite user edits)
  for (const [filename, profile] of Object.entries(BUILTIN_PROFILES)) {
    const dest = join(AGENTS_DIR, filename)
    if (!(await fileExists(dest))) {
      await fs.writeFile(dest, JSON.stringify(profile, null, 2) + '\n', 'utf8')
    }
  }

  return { ok: errors.length === 0, errors }
}
