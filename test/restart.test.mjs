/**
 * Restart orchestration: the arm/refuse decision and the helper readiness gate.
 *
 * The real helper is exercised separately with PowerShell; here the spawn seam is
 * driven directly so the two safety properties are pinned: DSH is never asked to
 * exit without a live relauncher, and a helper that never reports readiness
 * leaves the application running.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { deepEqual, equal, ok, run, test } from './harness.mjs'
import { armRestart, describeCarrier, endApplication, powershellPath, startRelaunchHelper } from '../lib/restart.js'

const PLUGIN_ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1')

/** A carrier that looks like the packaged Desktop child process. */
const desktopCarrier = {
  desktop: true,
  selfPid: process.pid,
  appPid: process.ppid,
  exePath: process.execPath,
  platform: process.platform
}

/** A scratch harness home. */
function scratch() {
  return mkdtempSync(join(tmpdir(), 'dsh-toolbox-restart-'))
}

test('the carrier reports whether this process is the Desktop child', () => {
  const carrier = describeCarrier()
  equal(carrier.selfPid, process.pid)
  equal(carrier.exePath, process.execPath)
  equal(carrier.platform, process.platform)
  equal(typeof carrier.desktop, 'boolean')
  // Outside the Desktop app there is no IPC channel to a parent shell.
  if (carrier.desktop) ok(carrier.appPid > 0)
  else equal(carrier.appPid, 0)
})

test('PowerShell is resolved from the system root', () => {
  const path = powershellPath()
  ok(path.length > 0)
  if (path.toLowerCase().endsWith('powershell.exe')) {
    ok(existsSync(path), `expected ${path} to exist`)
  }
})

test('a non-Desktop launch refuses to restart instead of guessing', async () => {
  const home = scratch()
  try {
    const result = await armRestart({
      pluginRoot: PLUGIN_ROOT,
      dshHome: home,
      logger: { info() {}, warn() {} },
      carrier: { desktop: false, selfPid: 1, appPid: 0, exePath: process.execPath, platform: process.platform },
      spawnImpl: () => { throw new Error('must not spawn') }
    })
    equal(result.ok, false)
    equal(result.mode, 'unsupported')
    ok(result.error.includes('web'))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a missing executable is refused', async () => {
  const home = scratch()
  try {
    const result = await armRestart({
      pluginRoot: PLUGIN_ROOT,
      dshHome: home,
      logger: { info() {}, warn() {} },
      carrier: { ...desktopCarrier, exePath: join(home, 'not-here.exe') },
      spawnImpl: () => { throw new Error('must not spawn') }
    })
    equal(result.ok, false)
    ok(result.error.includes('not-here.exe'))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a helper that never reports readiness leaves the application alone', async () => {
  const home = scratch()
  try {
    let killed = false
    const result = await armRestart({
      pluginRoot: PLUGIN_ROOT,
      dshHome: home,
      logger: { info() {}, warn() {} },
      carrier: desktopCarrier,
      // Spawned but silent: no marker file is ever written.
      spawnImpl: () => ({ pid: 4242, unref() {}, kill() { killed = true } }),
      readyTimeoutMs: 300,
      endImpl: () => { throw new Error('must not end the application') }
    })
    equal(result.ok, false)
    equal(result.mode, 'unsupported')
    ok(result.error.includes('就绪'))
    equal(killed, true, 'the useless helper is killed again')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a ready helper is the only thing that authorizes the exit', async () => {
  const home = scratch()
  try {
    const scheduled = []
    const ended = []
    let spawned = 0
    const result = await armRestart({
      pluginRoot: PLUGIN_ROOT,
      dshHome: home,
      logger: { info() {}, warn() {} },
      carrier: desktopCarrier,
      port: 19387,
      spawnImpl: (command, args) => {
        spawned += 1
        const markerIndex = args.indexOf('-ReadyFile') + 1
        // Stand in for the real helper's first action.
        writeFileSync(args[markerIndex], '999', 'ascii')
        return { pid: 4343, unref() {}, kill() {} }
      },
      schedule: (callback, delay) => { scheduled.push({ callback, delay }) },
      endImpl: options => { ended.push(options.appPid); return true }
    })

    equal(spawned, 1)
    equal(result.ok, true)
    equal(result.mode, 'relaunch')
    equal(result.helperPid, 4343)
    equal(result.appPid, desktopCarrier.appPid)
    equal(scheduled.length, 1, 'exactly one exit is armed')
    equal(ended.length, 0, 'the exit waits for the response to be written')
    scheduled[0].callback()
    deepEqual(ended, [desktopCarrier.appPid])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the helper is told which process and port to wait for', async () => {
  const home = scratch()
  try {
    let captured
    await startRelaunchHelper({
      pluginRoot: PLUGIN_ROOT,
      dshHome: home,
      logger: { info() {}, warn() {} },
      carrier: desktopCarrier,
      port: 23456,
      spawnImpl: (command, args) => {
        captured = { command, args }
        writeFileSync(args[args.indexOf('-ReadyFile') + 1], '1', 'ascii')
        return { pid: 1, unref() {}, kill() {} }
      }
    })
    equal(captured.command, powershellPath())
    ok(captured.args.includes('-WaitPid'))
    equal(captured.args[captured.args.indexOf('-WaitPid') + 1], String(desktopCarrier.appPid))
    equal(captured.args[captured.args.indexOf('-Port') + 1], '23456')
    equal(captured.args[captured.args.indexOf('-ExePath') + 1], desktopCarrier.exePath)
    ok(captured.args[captured.args.indexOf('-File') + 1].endsWith('relaunch.ps1'))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('ending a bogus process id is a no-op, not a crash', () => {
  const warnings = []
  const logger = { info() {}, warn: message => warnings.push(message) }
  equal(endApplication({ appPid: 0, logger }), false)
  equal(endApplication({ appPid: -1, logger }), false)
  equal(endApplication({ appPid: 1.5, logger }), false)
  equal(endApplication({ appPid: 42, logger, killImpl: () => { throw new Error('ESRCH') } }), false)
  equal(warnings.length, 1)
  equal(endApplication({ appPid: 42, logger, killImpl: () => {} }), true)
})

await run('restart')
