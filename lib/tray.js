/**
 * The optional companion tray icon for `dsh-toolbox`.
 *
 * ## Why a second icon instead of a new menu row
 *
 * DSH's own tray icon — and the menu behind it — is created and owned by the
 * Electron main process (`DesktopTray` in the shell). A plugin cannot add a row
 * to it: the shell has no plugin surface for that menu, and its IPC channel from
 * the Node half is closed to unknown messages by design (an unrecognized message
 * is treated as a host failure and stops the application). The only honest way
 * to put a restart behind a tray right-click is to own the icon, so this module
 * runs a small companion that sits next to DSH's own and offers the same
 * actions. It is opt-in, and it exits by itself as soon as DSH does.
 *
 * @module dsh-toolbox/tray
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { powershellPath, describeCarrier } from './restart.js'
import { logsDir } from './settings.js'

/** Whether this platform has a tray at all. */
export function traySupported(platform = process.platform) {
  return platform === 'win32'
}

/** Whether one process id is still alive. */
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means it exists but belongs to someone else — still alive.
    return error?.code === 'EPERM'
  }
}

/**
 * Own the companion tray process for one Host lifetime.
 * @param options - plugin root, harness home, icon, logger and test seams.
 * @returns `{ setEnabled, status, dispose }`.
 */
export function createTrayCompanion(options) {
  const {
    pluginRoot,
    dshHome,
    logger,
    spawnImpl = spawn,
    platform = process.platform,
    carrier = () => describeCarrier(),
    supported = traySupported(platform)
  } = options

  let child = null
  /** The child whose exit the current status describes. */
  let spawned = null
  let lastError = ''
  let lastOrigin = ''

  const scriptPath = join(pluginRoot, 'scripts', 'tray.ps1')
  const iconPath = join(pluginRoot, 'assets', 'icon.ico')

  const describe = () => ({
    supported,
    platform,
    running: child !== null && processAlive(child.pid),
    pid: child !== null && processAlive(child.pid) ? child.pid : 0,
    script: scriptPath,
    icon: iconPath,
    origin: lastOrigin,
    logFile: join(logsDir(dshHome), 'tray.log'),
    error: lastError
  })

  const stop = () => {
    if (child === null) return
    try {
      child.kill()
    } catch {
      /* the companion may already have exited with the application */
    }
    child = null
  }

  return {
    /**
     * Start or stop the companion.
     * @param enabled - desired state.
     * @param context - the browser-side origin and its authenticated URL.
     * @returns the tray status projection.
     */
    setEnabled(enabled, context = {}) {
      lastError = ''
      if (enabled !== true) {
        lastOrigin = ''
        stop()
        return describe()
      }
      if (!supported) {
        lastError = '当前平台不支持托盘小程序（仅 Windows）'
        return describe()
      }
      if (child !== null && processAlive(child.pid)) return describe()

      const facts = carrier()
      if (!facts.desktop || !Number.isInteger(facts.appPid) || facts.appPid <= 0) {
        lastError = 'DSH 桌面包未提供可监视的应用进程，托盘小程序无法启动'
        return describe()
      }
      if (!existsSync(scriptPath)) {
        lastError = `托盘脚本缺失：${scriptPath}`
        return describe()
      }

      // The companion calls the plugin's own routes over HTTP, so it needs an
      // http origin. The page's own origin is `dsh-app://app` in the Desktop app
      // and PowerShell rejects that scheme outright, so the Host's answer (taken
      // from the request it arrived on) wins; the page's value is only a fallback.
      const reported = typeof context.origin === 'string' ? context.origin.trim().replace(/\/+$/u, '') : ''
      const fromHost = typeof context.apiOrigin === 'string' ? context.apiOrigin.trim().replace(/\/+$/u, '') : ''
      const appUrl = typeof context.appUrl === 'string' ? context.appUrl.trim() : ''
      const baseUrl = [fromHost, reported, appUrl]
        .find(candidate => /^https?:\/\/[^\s/]+/iu.test(candidate ?? '')) ?? ''
      if (baseUrl === '') {
        lastError = `没有可用的 HTTP 回调地址（页面报告的来源是「${reported === '' ? appUrl : reported}」，托盘只能回调 http）`
        return describe()
      }
      lastOrigin = baseUrl

      const logFile = join(logsDir(dshHome), 'tray.log')
      const stringsFile = join(pluginRoot, 'assets', 'tray-strings.json')
      const locale = typeof context.locale === 'string' && /^en\b/iu.test(context.locale) ? 'en' : 'zh'
      try {
        mkdirSync(logsDir(dshHome), { recursive: true })
      } catch {
        /* the script logs best-effort */
      }

      const args = [
        '-STA',
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-WindowStyle', 'Hidden',
        '-File', scriptPath,
        '-AppPid', String(facts.appPid),
        '-BaseUrl', baseUrl,
        // The "open" fallback needs a scheme the shell can launch too, so it gets
        // the same http origin rather than the page's `dsh-app://app`.
        '-AppUrl', baseUrl,
        '-IconPath', existsSync(iconPath) ? iconPath : '',
        '-LogFile', logFile,
        '-StringsFile', existsSync(stringsFile) ? stringsFile : '',
        '-Locale', locale
      ]

      try {
        child = spawnImpl(powershellPath(), args, {
          // Not detached, for the same reason as the relaunch helper: Node's
          // Windows `detached` flag removes the child's console, and Windows
          // PowerShell 5.1 exits at once without one (measured — no log at all).
          // The companion still outlives the Host and ends itself when the
          // application pid it watches disappears.
          detached: false,
          windowsHide: true,
          stdio: 'ignore',
          cwd: pluginRoot
        })
        child?.unref?.()
        logger?.info?.(`toolbox: companion tray started (pid ${String(child?.pid ?? '?')})`)
        // An immediately exiting companion used to look "running" for the one
        // moment the status was read; its exit is now reported instead.
        if (typeof child?.on === 'function') {
          child.on('exit', (code) => {
            if (child !== spawned) return
            lastError = `托盘进程退出了（code ${String(code)}），请查看 ${logFile}`
            logger?.warn?.(`toolbox: companion tray exited with ${String(code)}`)
          })
          child.on('error', (error) => {
            lastError = `托盘进程启动失败：${String(error?.message ?? error)}`
          })
        }
        spawned = child
      } catch (error) {
        child = null
        lastError = `无法启动托盘小程序：${String(error?.message ?? error)}`
      }
      return describe()
    },
    status: describe,
    /** Stop the companion; the plugin's unload path calls this. */
    dispose: stop
  }
}
