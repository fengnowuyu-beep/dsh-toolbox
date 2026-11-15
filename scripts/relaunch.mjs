// dsh-toolbox - the detached relaunch helper.
//
// Started by the plugin's Host half *before* DSH is asked to exit, so the
// application is only ever stopped while a live relauncher is already waiting
// for it. It is spawned detached so it outlives DSH.
//
// Why Node instead of PowerShell, which this used to be:
//
//   * Node's Windows `detached: true` starts the child with DETACHED_PROCESS,
//     i.e. without a console — and Windows PowerShell 5.1 exits immediately
//     (code 0, no output) when it cannot attach one. Measured: the helper wrote
//     neither its readiness marker nor a single log line, so every restart was
//     refused by the readiness gate. Node tolerates having no console, so the
//     OS-level detach this design needs actually works.
//   * The relaunched application must NOT inherit `ELECTRON_RUN_AS_NODE`: the
//     Host sets it for its own process, and an Electron executable started with
//     it runs the given arguments as a Node script instead of opening the GUI.
//     A helper that inherits its environment has to scrub that variable
//     deliberately (see buildRelaunchEnv), which is easy to miss in a shell.
//
// Sequence, in order:
//   1. write the readiness marker (the Host refuses the restart without it),
//   2. wait for the watched application process to disappear,
//   3. wait for the HTTP port to be released, and only if a process running the
//      SAME executable still holds it, stop that stale instance,
//   4. start the same executable again, with a scrubbed environment.
//
// Every step is logged to --log so a restart that did not happen can be
// explained afterwards.
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { basename, dirname } from 'node:path'
import { parseArgs } from 'node:util'

/** Default how long to wait for the application process to exit. */
export const DEFAULT_WAIT_SECONDS = 60

/** Default how long to wait for the HTTP port before touching a stale instance. */
export const DEFAULT_PORT_WAIT_SECONDS = 45

/** Settle time before starting the replacement, in milliseconds. */
export const SETTLE_MS = 700

/**
 * The environment a relaunched application must see.
 *
 * The one thing that must not survive is `ELECTRON_RUN_AS_NODE`: the Host runs
 * with it set, and any Electron executable started with it in the environment
 * would run its arguments as a Node script instead of opening the application.
 * @param env - the helper's own environment.
 * @returns a copy safe to hand to the application.
 */
export function buildRelaunchEnv(env = process.env) {
  const next = { ...env }
  delete next.ELECTRON_RUN_AS_NODE
  delete next.ELECTRON_NO_ATTACH_CONSOLE
  delete next.DSH_DESKTOP_NODE_EXECUTABLE
  return next
}

/** @returns whether one process id is alive. */
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** Sleeping without keeping anything else alive. */
function sleep(ms) {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/**
 * Connect-probe one port. A listener whose accept backlog is full refuses the
 * connection, so this is only ever a second opinion (see parseNetstatOwners).
 */
function portAccepts(port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    const done = (value) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/**
 * Pids listening on one port, parsed out of a netstat table.
 * @param output - `netstat -ano -p tcp` output.
 * @param port - the port to inspect.
 * @returns distinct pids.
 */
export function parseNetstatOwners(output, port) {
  const owners = new Set()
  if (typeof output !== 'string' || !Number.isInteger(port)) return []
  const pattern = new RegExp(`[:.]${String(port)}\\s+\\S+\\s+(?:LISTENING|LISTEN)\\s+(\\d+)\\s*$`, 'u')
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim()
    if (!line.includes('LISTEN')) continue
    const match = pattern.exec(line)
    if (match === null) continue
    const pid = Number(match[1])
    if (Number.isSafeInteger(pid) && pid > 0) owners.add(pid)
  }
  return [...owners]
}

/**
 * Process ids listening on one TCP port, from the platform's own table.
 * @param port - the port to inspect.
 * @returns distinct pids (empty when nothing listens or the table is unavailable).
 */
export function getPortOwners(port) {
  const args = process.platform === 'win32' ? ['-ano', '-p', 'tcp'] : ['-an', '-p', 'tcp']
  let output = ''
  try {
    const result = spawnSync('netstat', args, { encoding: 'utf8', windowsHide: true })
    output = result.stdout ?? ''
  } catch {
    return []
  }
  return parseNetstatOwners(output, port)
}

/** Whether anything still listens on one port (table first, connect as cross-check). */
async function portListening(port) {
  if (!Number.isInteger(port) || port <= 0) return false
  if (getPortOwners(port).length > 0) return true
  return await portAccepts(port)
}

/** The image name of one process, or '' when it cannot be read. */
export function processImageName(pid) {
  if (process.platform !== 'win32') return ''
  try {
    const result = spawnSync('tasklist', ['/FI', `PID eq ${String(pid)}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true
    })
    const line = (result.stdout ?? '').trim().split('\n').at(0) ?? ''
    const match = /^"([^"]+)"/u.exec(line.trim())
    return match === null ? '' : match[1].toLowerCase()
  } catch {
    return ''
  }
}

/** @returns whether a process name is the executable we are relaunching. */
function matchesExecutable(name, exePath) {
  if (name === '') return false
  return name === basename(exePath).toLowerCase()
}

/** The helper's append-only log; never allowed to break the restart. */
function makeLogger(logFile) {
  if (typeof logFile !== 'string' || logFile === '') return () => {}
  try {
    mkdirSync(dirname(logFile), { recursive: true })
  } catch {
    /* the log is best effort */
  }
  return (message) => {
    try {
      appendFileSync(logFile, `${new Date().toISOString()} [relaunch] ${message}\n`, 'utf8')
    } catch {
      /* logging must never stop a restart */
    }
  }
}

/**
 * Run the relaunch.
 * @param options - parsed arguments.
 * @returns the exit code to report.
 */
export async function runHelper(options) {
  const {
    waitPid,
    exePath,
    readyFile,
    port = 0,
    waitSeconds = DEFAULT_WAIT_SECONDS,
    portWaitSeconds = DEFAULT_PORT_WAIT_SECONDS,
    logFile = ''
  } = options
  const log = makeLogger(logFile)

  // Step 1 — announce readiness. The marker is the Host's proof that stopping
  // the application will be followed by a relaunch.
  try {
    mkdirSync(dirname(readyFile), { recursive: true })
    writeFileSync(readyFile, String(process.pid), 'ascii')
    log(`ready pid=${process.pid} waiting for app pid=${waitPid} exe=${exePath} port=${port}`)
  } catch (error) {
    log(`could not write readiness marker: ${String(error?.message ?? error)}`)
    return 1
  }

  // Step 2 — wait for the application process to exit.
  const processDeadline = Date.now() + Math.max(5, waitSeconds) * 1000
  while (Date.now() < processDeadline && processAlive(waitPid)) {
    await sleep(200)
  }
  log('application process is gone')

  // Step 3 — the port, then a stale instance of the same executable if any.
  if (Number.isInteger(port) && port > 0) {
    const portDeadline = Date.now() + Math.max(1, portWaitSeconds) * 1000
    while (Date.now() < portDeadline && await portListening(port)) {
      await sleep(300)
    }
    if (!await portListening(port)) {
      log(`port ${port} released`)
    } else {
      log(`port ${port} still listening after ${String(portWaitSeconds)}s; checking for a stale instance`)
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (!await portListening(port)) break
        const owners = getPortOwners(port)
        if (owners.length === 0) break
        let stoppedSomeone = false
        let metForeignProcess = false
        for (const pid of owners) {
          const name = processImageName(pid)
          if (!matchesExecutable(name, exePath)) {
            log(`port ${port} is held by unrelated process ${pid} (${name === '' ? 'unknown' : name}); leaving it alone`)
            metForeignProcess = true
            continue
          }
          try {
            process.kill(pid)
            stoppedSomeone = true
            log(`stopped stale instance pid=${pid} (${name}) holding port ${port}`)
          } catch (error) {
            log(`could not stop stale instance pid=${pid}: ${String(error?.message ?? error)}`)
          }
        }
        if (metForeignProcess && !stoppedSomeone) break
        await sleep(300)
      }
      log(await portListening(port)
        ? `port ${port} is still listening; the new instance may refuse to start`
        : `port ${port} released after cleanup`)
    }
  }

  // Step 4 — start the same executable again, with a scrubbed environment.
  await sleep(SETTLE_MS)
  try {
    // A packaged installation is an .exe, but a development checkout may be a
    // command wrapper; Node cannot execute a batch file without a shell.
    const batched = /\.(?:cmd|bat)$/iu.test(exePath)
    const child = spawn(exePath, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      shell: batched,
      cwd: dirname(exePath),
      env: buildRelaunchEnv(process.env)
    })
    child.unref()
    log(`relaunched ${exePath} (pid ${String(child.pid ?? '?')})`)
  } catch (error) {
    log(`relaunch failed: ${String(error?.message ?? error)}`)
  }

  try {
    rmSync(readyFile, { force: true })
  } catch {
    /* a leftover marker is harmless: the Host deletes it before each attempt */
  }
  return 0
}

/** Parse the helper's arguments. */
export function parseHelperArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'wait-pid': { type: 'string' },
      exe: { type: 'string' },
      ready: { type: 'string' },
      port: { type: 'string' },
      'wait-seconds': { type: 'string' },
      'port-wait-seconds': { type: 'string' },
      log: { type: 'string' }
    }
  })
  return {
    waitPid: Number(values['wait-pid']),
    exePath: values.exe ?? '',
    readyFile: values.ready ?? '',
    port: Number(values.port ?? 0),
    waitSeconds: Number(values['wait-seconds'] ?? DEFAULT_WAIT_SECONDS),
    portWaitSeconds: Number(values['port-wait-seconds'] ?? DEFAULT_PORT_WAIT_SECONDS),
    logFile: values.log ?? ''
  }
}

if (import.meta.main === true) {
  const options = parseHelperArgs(process.argv.slice(2))
  if (!options.readyFile || !options.exePath || !Number.isInteger(options.waitPid)) {
    process.stderr.write('relaunch: --wait-pid, --exe and --ready are required\n')
    process.exit(2)
  }
  process.exitCode = await runHelper(options)
}
