/**
 * Window control: when it is allowed at all, and the helper it starts.
 *
 * The PowerShell script itself was verified against a live window (the window was
 * `IsZoomed` afterwards); what these cases pin is the decision to run it and the
 * arguments it is given, so a regression cannot silently do nothing.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { equal, ok, run, test } from './harness.mjs'
import { MAXIMIZE_TIMEOUT_SECONDS, maximizeWindow, windowControlSupported } from '../lib/window.js'

const PLUGIN_ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1')

/** A scratch harness home. */
function scratch() {
  return mkdtempSync(join(tmpdir(), 'dsh-toolbox-window-'))
}

/** A Desktop carrier whose window belongs to `appPid`. */
const desktopCarrier = {
  desktop: true,
  selfPid: process.pid,
  appPid: 4242,
  exePath: 'C:\\app\\DeepSeek Harness.exe',
  platform: 'win32'
}

test('只有在 Windows 桌面端才动窗口', () => {
  equal(windowControlSupported(desktopCarrier, 'win32'), true)
  equal(windowControlSupported(desktopCarrier, 'linux'), false)
  equal(windowControlSupported({ ...desktopCarrier, desktop: false }, 'win32'), false)
})

test('maximizing is refused, with a reason, where there is no window', async () => {
  const home = scratch()
  try {
    const offPlatform = await maximizeWindow({
      pluginRoot: PLUGIN_ROOT,
      dshHome: home,
      platform: 'linux',
      carrier: desktopCarrier,
      spawnImpl: () => { throw new Error('must not spawn') }
    })
    equal(offPlatform.ok, false)
    equal(offPlatform.mode, 'unsupported')
    ok(offPlatform.error.includes('Windows'), `expected a platform reason, got ${offPlatform.error}`)

    const offDesktop = await maximizeWindow({
      pluginRoot: PLUGIN_ROOT,
      dshHome: home,
      platform: 'win32',
      carrier: { ...desktopCarrier, desktop: false },
      spawnImpl: () => { throw new Error('must not spawn') }
    })
    equal(offDesktop.ok, false)
    ok(offDesktop.error.includes('桌面端'), `expected a carrier reason, got ${offDesktop.error}`)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the helper is told which process owns the window', async () => {
  const home = scratch()
  try {
    let captured
    const result = await maximizeWindow({
      pluginRoot: PLUGIN_ROOT,
      dshHome: home,
      platform: 'win32',
      carrier: desktopCarrier,
      spawnImpl: (command, args, options) => {
        captured = { command, args, options }
        // A seam without events settles on the spawn itself, which is what a
        // caller that does not watch the script relies on.
        return { pid: 7, kill: () => {} }
      }
    })
    equal(result.ok, true)
    equal(result.mode, 'maximized')
    ok(captured.command.toLowerCase().includes('powershell'), `expected the script host, got ${captured.command}`)
    const arg = name => captured.args[captured.args.indexOf(name) + 1]
    ok(arg('-File').endsWith('maximize.ps1'), `expected maximize.ps1, got ${String(arg('-File'))}`)
    equal(arg('-ProcessId'), String(desktopCarrier.appPid))
    equal(arg('-TimeoutSeconds'), String(MAXIMIZE_TIMEOUT_SECONDS))
    ok(arg('-LogFile').endsWith('window.log'))
    // PowerShell needs a console; only the detached relaunch helper may skip it.
    equal(captured.options.detached, false)
    equal(captured.options.windowsHide, true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a script that found no window is reported, not swallowed', async () => {
  const home = scratch()
  try {
    const result = await maximizeWindow({
      pluginRoot: PLUGIN_ROOT,
      dshHome: home,
      platform: 'win32',
      carrier: desktopCarrier,
      spawnImpl: () => ({
        pid: 7,
        kill: () => {},
        on(event, handler) {
          // The script exits 1 when no visible window appeared in time.
          if (event === 'exit') setTimeout(() => handler(1), 0)
        }
      })
    })
    equal(result.ok, false)
    equal(result.mode, 'no-window')
    ok(result.error.includes('window.log'), `expected the log path in the message, got ${result.error}`)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

await run('window')
