/**
 * "Restart DeepSeek Harness", from inside DSH.
 *
 * ## Why this is a two-process dance
 *
 * The Desktop shell owns the process tree: the Electron main process is the
 * parent, and DSH's Node half runs as its IPC child. The main process is not
 * extensible from a plugin — it validates every message the child sends and
 * tears the whole application down on an unrecognized one — so a plugin cannot
 * ask it to relaunch, and it will not relaunch on its own when the child exits
 * (it treats that as a crash and raises the recovery dialog).
 *
 * What a plugin *can* do is (a) start a detached helper that outlives DSH and
 * (b) end the process it is a child of. Doing both, in that order, is a restart:
 *
 *   1. The helper is spawned first and writes a readiness marker, so the
 *      application is never stopped unless a live relauncher is already waiting
 *      for it. If the marker never appears, the restart is refused and the
 *      reason is reported instead of taking DSH down.
 *   2. Only then is the Electron main process terminated. Its IPC channel closes,
 *      which is exactly the signal DSH's Node half waits for: it runs its own
 *      graceful `shutdown(0)` — flushing session logs and jobs — and exits.
 *   3. The helper waits for both the application process and the HTTP port to go
 *      away, then starts the same executable again.
 *
 * The tradeoff is stated plainly for the user in the confirmation dialog:
 * Electron's own `before-quit` bookkeeping (window bounds, the update journal)
 * does not run, and work in progress is interrupted. DSH's own data is flushed
 * by step 2, which is what makes the interruption safe.
 *
 * @module dsh-toolbox/restart
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { logsDir, markersDir } from './settings.js'

/** How long the helper gets to report readiness before the restart is refused. */
export const READY_TIMEOUT_MS = 4_000

/** Delay between writing the HTTP response and ending the application, in milliseconds. */
export const KILL_DELAY_MS = 500

/** How long the helper waits for the application process to exit, in seconds. */
export const PROCESS_WAIT_SECONDS = 60

/**
 * Describe the process this plugin runs in.
 * @returns `{ desktop, selfPid, appPid, exePath, platform }`.
 */
export function describeCarrier() {
  const hasIpc = typeof process.send === 'function' && process.connected === true
  return {
    desktop: hasIpc,
    selfPid: process.pid,
    appPid: hasIpc ? process.ppid : 0,
    exePath: typeof process.execPath === 'string' ? process.execPath : '',
    platform: process.platform
  }
}

/**
 * Resolve the PowerShell host used for the helper scripts. Windows PowerShell
 * 5.1 is preferred: it is present on every supported Windows version and is the
 * one that can host WinForms for the tray companion.
 * @returns an absolute executable path, or a PATH name as a fallback.
 */
export function powershellPath() {
  const root = typeof process.env.SystemRoot === 'string' && process.env.SystemRoot !== ''
    ? process.env.SystemRoot
    : 'C:\\Windows'
  const candidate = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return existsSync(candidate) ? candidate : 'powershell.exe'
}

/** Quote one argument for a PowerShell `-File` invocation. */
function quote(value) {
  return `"${String(value).replace(/"/gu, '""')}"`
}

/**
 * Start the detached relaunch helper and wait until it is ready to relaunch.
 * @param options - plugin root, harness home, port, logger and test seams.
 * @returns `{ ready, pid, markerFile, logFile, error }`.
 */
export async function startRelaunchHelper(options) {
  const {
    pluginRoot,
    dshHome,
    logger,
    port = 0,
    carrier = describeCarrier(),
    spawnImpl = spawn,
    // Deliberately not unref'd: this wait is the one thing holding the restart
    // open, so it must keep the process alive until the answer arrives.
    sleep = milliseconds => new Promise(resolve => { setTimeout(resolve, milliseconds) }),
    readyTimeoutMs = READY_TIMEOUT_MS
  } = options

  if (!carrier.desktop || !Number.isInteger(carrier.appPid) || carrier.appPid <= 0) {
    return { ready: false, mode: 'unsupported', error: 'DSH 桌面包未提供可重启的应用进程（当前像是 web/CLI 启动）' }
  }
  if (typeof carrier.exePath !== 'string' || carrier.exePath === '' || !existsSync(carrier.exePath)) {
    return { ready: false, mode: 'unsupported', error: `无法定位 DSH 可执行文件：${String(carrier.exePath)}` }
  }

  const scriptPath = join(pluginRoot, 'scripts', 'relaunch.mjs')
  if (!existsSync(scriptPath)) {
    return { ready: false, mode: 'unsupported', error: `重启脚本缺失：${scriptPath}` }
  }

  const markerDirectory = markersDir(dshHome)
  const logDirectory = logsDir(dshHome)
  try {
    mkdirSync(markerDirectory, { recursive: true })
    mkdirSync(logDirectory, { recursive: true })
  } catch (error) {
    return { ready: false, mode: 'unsupported', error: `无法创建状态目录：${String(error?.message ?? error)}` }
  }

  const markerFile = join(markerDirectory, `relaunch-${carrier.appPid}.ready`)
  const logFile = join(logDirectory, 'relaunch.log')
  try {
    rmSync(markerFile, { force: true })
  } catch {
    /* a stale marker is rewritten by the helper anyway */
  }

  const args = [
    scriptPath,
    '--wait-pid', String(carrier.appPid),
    '--exe', carrier.exePath,
    '--ready', markerFile,
    '--port', String(port),
    '--wait-seconds', String(PROCESS_WAIT_SECONDS),
    '--log', logFile
  ]

  let child
  try {
    child = spawnImpl(process.execPath, args, {
      // Node tolerates having no console, so the OS-level detach that this design
      // needs actually works here. (Windows PowerShell 5.1, which this helper used
      // to be, exits immediately under DETACHED_PROCESS — see scripts/relaunch.mjs.)
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      cwd: pluginRoot,
      // The helper runs as Node even though `process.execPath` is the application
      // executable; it scrubs this variable again before starting the application.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    })
  } catch (error) {
    return { ready: false, mode: 'unsupported', error: `无法启动重启助手：${String(error?.message ?? error)}` }
  }
  child?.unref?.()

  // A helper that dies immediately is the one failure this design cannot see in
  // its own log — so the exit is observed here and reported as the reason.
  let earlyExit = null
  if (typeof child?.on === 'function') {
    child.on('exit', (code, signal) => { earlyExit = { code, signal } })
    child.on('error', (error) => { earlyExit = { code: null, signal: null, error } })
  }

  const deadline = Date.now() + readyTimeoutMs
  while (Date.now() < deadline) {
    if (existsSync(markerFile)) {
      logger?.info?.(`toolbox: relaunch helper ${String(child?.pid ?? '?')} ready; app ${String(carrier.appPid)}`)
      return { ready: true, mode: 'relaunch', pid: child?.pid ?? 0, markerFile, logFile, exePath: carrier.exePath, appPid: carrier.appPid }
    }
    if (earlyExit !== null) {
      const reason = earlyExit.error === undefined
        ? `code ${String(earlyExit.code)}${earlyExit.signal === null ? '' : ` signal ${String(earlyExit.signal)}`}`
        : String(earlyExit.error?.message ?? earlyExit.error)
      logger?.warn?.(`toolbox: relaunch helper exited before readiness (${reason})`)
      return {
        ready: false,
        mode: 'unsupported',
        error: `重启助手刚启动就退出了（${reason}），已取消重启`,
        logFile
      }
    }
    await sleep(120)
  }

  logger?.warn?.(`toolbox: relaunch helper did not report readiness; see ${logFile}`)
  try {
    child?.kill?.()
  } catch {
    /* the helper is gone or already detached */
  }
  return {
    ready: false,
    mode: 'unsupported',
    error: `重启助手未在 ${String(Math.round(readyTimeoutMs / 1000))} 秒内就绪，已取消重启（日志：${logFile}）`,
    logFile
  }
}

/**
 * End the Desktop application process, which makes DSH's Node half flush and
 * exit. Called from a timer so the HTTP response has already been written.
 * @param options - the parent pid, logger and test seams.
 * @returns whether the signal was delivered.
 */
export function endApplication(options) {
  const {
    appPid,
    logger,
    killImpl = process.kill.bind(process)
  } = options
  if (!Number.isInteger(appPid) || appPid <= 0) return false
  try {
    killImpl(appPid, 'SIGTERM')
    logger?.info?.(`toolbox: restart requested; app ${String(appPid)} asked to exit`)
    return true
  } catch (error) {
    logger?.warn?.(`toolbox: could not end app ${String(appPid)}: ${String(error?.message ?? error)}`)
    return false
  }
}

/**
 * Arm a quit: end the Desktop application without arranging a relaunch.
 *
 * There is no plugin surface for `app.quit()`, so this uses the same lever as the
 * restart — ending the Electron main process, whose exit is what makes DSH's Node
 * half run its own graceful shutdown and flush. What it deliberately does NOT do
 * is start the helper, because nothing should come back.
 *
 * @param options - the carrier, logger, delay and test seams.
 * @returns the outcome the caller reports.
 */
export async function armQuit(options) {
  const {
    carrier = describeCarrier(),
    logger,
    delayMs = KILL_DELAY_MS,
    schedule = (callback, milliseconds) => { setTimeout(callback, milliseconds).unref?.() },
    endImpl = endApplication
  } = options

  if (!carrier.desktop || !Number.isInteger(carrier.appPid) || carrier.appPid <= 0) {
    return { ok: false, mode: 'unsupported', error: '当前不是 DSH 桌面端进程，无法自动关闭（请手动关闭你启动的 DSH 进程）' }
  }

  schedule(() => {
    endImpl({ appPid: carrier.appPid, logger })
  }, delayMs)

  return {
    ok: true,
    mode: 'quit',
    appPid: carrier.appPid,
    detail: `已安排关闭：${String(delayMs)} 毫秒后结束当前进程；DSH 会先落盘再退出。`
  }
}

/**
 * Arm a restart: start the helper, and only once it is live schedule the exit.
 * @param options - plugin root, harness home, port, logger, delay and test seams.
 * @returns the outcome the settings page reports.
 */
export async function armRestart(options) {
  const {
    pluginRoot,
    dshHome,
    logger,
    port = 0,
    delayMs = KILL_DELAY_MS,
    carrier,
    schedule = (callback, milliseconds) => { setTimeout(callback, milliseconds).unref?.() },
    endImpl = endApplication,
    ...helperOptions
  } = options

  const helper = await startRelaunchHelper({
    pluginRoot,
    dshHome,
    logger,
    port,
    ...carrier === undefined ? {} : { carrier },
    ...helperOptions
  })
  if (helper.ready !== true) {
    return { ok: false, ...helper }
  }

  const appPid = helper.appPid
  schedule(() => {
    endImpl({ appPid, logger })
  }, delayMs)

  return {
    ok: true,
    mode: 'relaunch',
    helperPid: helper.pid,
    appPid,
    exePath: helper.exePath,
    logFile: helper.logFile,
    detail: `已启动重启助手（PID ${String(helper.pid)}），${String(delayMs)} 毫秒后结束当前进程并重新启动。`
  }
}
