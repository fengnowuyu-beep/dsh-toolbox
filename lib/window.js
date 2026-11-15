/**
 * Window control for the Desktop shell.
 *
 * Only the OS can resize the application window from here. Electron's main
 * process owns it, and the plugin surfaces reach neither that process nor its
 * `BrowserWindow`: a page cannot resize a window it did not open, and the
 * preload's `dshDesktop` exposes no window geometry at all. So this runs a small
 * PowerShell script (Windows only, like the tray) that finds the application's
 * visible top-level window by process id and maximizes it through `user32.dll` —
 * the same operation the user's own title-bar double-click performs.
 *
 * The script waits for a *visible* window on purpose: the Host boots before the
 * shell shows its window, and forcing a hidden window visible would flash a blank
 * frame ahead of the shell's own timing.
 *
 * @module dsh-toolbox/window
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { describeCarrier, powershellPath } from './restart.js'
import { logsDir } from './settings.js'

/** How long the script may wait for the window to appear, in seconds. */
export const MAXIMIZE_TIMEOUT_SECONDS = 30

/** How long to give the script before giving up on it, in milliseconds. */
const SCRIPT_DEADLINE_MS = (MAXIMIZE_TIMEOUT_SECONDS + 10) * 1000

/** Whether this runtime can resize the window at all. */
export function windowControlSupported(carrier = describeCarrier(), platform = process.platform) {
  return platform === 'win32' && carrier.desktop === true
}

/**
 * Maximize the Desktop window.
 * @param options - plugin root, harness home, carrier, logger and test seams.
 * @returns `{ ok, mode, logFile, error }`.
 */
export async function maximizeWindow(options = {}) {
  const {
    pluginRoot,
    dshHome,
    logger,
    carrier = describeCarrier(),
    platform = process.platform,
    timeoutSeconds = MAXIMIZE_TIMEOUT_SECONDS,
    spawnImpl = spawn,
    deadlineMs = SCRIPT_DEADLINE_MS
  } = options

  if (!windowControlSupported(carrier, platform)) {
    return {
      ok: false,
      mode: 'unsupported',
      error: platform === 'win32' ? '当前不是 DSH 桌面端进程' : '仅 Windows 支持窗口最大化'
    }
  }

  const scriptPath = join(pluginRoot, 'scripts', 'maximize.ps1')
  if (!existsSync(scriptPath)) {
    return { ok: false, mode: 'unsupported', error: `最大化脚本缺失：${scriptPath}` }
  }

  const logFile = join(logsDir(dshHome), 'window.log')
  try {
    mkdirSync(logsDir(dshHome), { recursive: true })
  } catch {
    /* the script logs best effort */
  }

  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-WindowStyle', 'Hidden',
    '-File', scriptPath,
    '-ProcessId', String(carrier.appPid),
    '-TimeoutSeconds', String(timeoutSeconds),
    '-LogFile', logFile
  ]

  let child
  try {
    // Not detached: PowerShell needs a console, and this helper is short-lived
    // (see scripts/relaunch.mjs for the measurements behind that).
    child = spawnImpl(powershellPath(), args, {
      windowsHide: true,
      stdio: 'ignore',
      detached: false
    })
  } catch (error) {
    return { ok: false, mode: 'unsupported', logFile, error: `无法启动最大化助手：${String(error?.message ?? error)}` }
  }

  const exit = await new Promise((resolve) => {
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    if (typeof child?.on !== 'function') {
      // A test seam without events: treat the spawn itself as the outcome.
      done({ code: 0 })
      return
    }
    child.on('exit', code => done({ code: code ?? 0 }))
    child.on('error', error => done({ error }))
    const timer = setTimeout(() => {
      try {
        child.kill?.()
      } catch {
        /* already gone */
      }
      done({ code: null, timedOut: true })
    }, deadlineMs)
    timer.unref?.()
  })

  if (exit.timedOut === true) {
    return { ok: false, mode: 'timeout', logFile, error: `最大化助手超时（${String(deadlineMs / 1000)} 秒）` }
  }
  if (exit.error !== undefined) {
    return { ok: false, mode: 'unsupported', logFile, error: `最大化助手启动失败：${String(exit.error?.message ?? exit.error)}` }
  }
  // The script exits non-zero when no visible window showed up in time.
  const ok = exit.code === 0
  logger?.[ok ? 'info' : 'warn']?.(`toolbox: maximize window → exit ${String(exit.code)} (${logFile})`)
  return {
    ok,
    mode: ok ? 'maximized' : 'no-window',
    logFile,
    error: ok ? '' : '没有找到可见的 DSH 窗口（日志：' + logFile + '）'
  }
}
