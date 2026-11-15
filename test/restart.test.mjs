/**
 * Restart orchestration: the arm/refuse decision and the helper readiness gate.
 *
 * The spawn seam is driven directly so the safety properties are pinned: DSH is
 * never asked to exit without a live relauncher, and a helper that never reports
 * readiness leaves the application running. The helper script itself is also
 * imported here, for the environment it must scrub before starting the app.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { deepEqual, equal, ok, run, test } from './harness.mjs'
import { armQuit, armRestart, describeCarrier, endApplication, powershellPath, startRelaunchHelper } from '../lib/restart.js'

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

/**
 * Stand in for the helper's first action: write its readiness marker.
 *
 * It resolves `--ready` by name and refuses to write anywhere but the scratch
 * tree — an earlier version of these tests looked up a flag that no longer
 * existed, fell back to `args[0]`, and overwrote the helper script itself.
 * @param args - the arguments the Host passed to the helper.
 */
function writeHelperMarker(args) {
  const index = args.indexOf('--ready')
  ok(index > 0, `the helper must be told where to report readiness (got ${JSON.stringify(args)})`)
  const marker = args[index + 1]
  ok(marker.startsWith(tmpdir()), `refusing to write a test marker outside the scratch tree: ${marker}`)
  writeFileSync(marker, '999', 'ascii')
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
        writeHelperMarker(args)
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

test('the helper is a detached Node process, told what to wait for', async () => {
  const home = scratch()
  try {
    let captured
    let options
    await startRelaunchHelper({
      pluginRoot: PLUGIN_ROOT,
      dshHome: home,
      logger: { info() {}, warn() {} },
      carrier: desktopCarrier,
      port: 23456,
      spawnImpl: (command, args, spawnOptions) => {
        captured = { command, args }
        options = spawnOptions
        writeHelperMarker(args)
        return { pid: 1, unref() {}, kill() {} }
      }
    })

    // The helper runs as Node through the application's own executable — the
    // Electron binary in Node mode — rather than through PowerShell, which
    // cannot survive being detached (it has no console to attach to).
    equal(captured.command, process.execPath)
    equal(options.env.ELECTRON_RUN_AS_NODE, '1')
    equal(options.detached, true, 'the helper must outlive the application')
    equal(options.stdio, 'ignore')
    equal(options.windowsHide, true)

    const arg = name => captured.args[captured.args.indexOf(name) + 1]
    ok(captured.args[0].endsWith('relaunch.mjs'), `expected the Node helper, got ${String(captured.args[0])}`)
    equal(arg('--wait-pid'), String(desktopCarrier.appPid))
    equal(arg('--port'), '23456')
    equal(arg('--exe'), desktopCarrier.exePath)
    ok(arg('--ready').endsWith('.ready'))
    ok(arg('--log').endsWith('relaunch.log'))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the helper does not start PowerShell any more', async () => {
  // A regression guard for the failure that made every restart refuse: the
  // PowerShell helper was started detached, exited at once, and never wrote its
  // readiness marker.
  const home = scratch()
  try {
    let command = ''
    await startRelaunchHelper({
      pluginRoot: PLUGIN_ROOT,
      dshHome: home,
      logger: { info() {}, warn() {} },
      carrier: desktopCarrier,
      spawnImpl: (candidate, args) => {
        command = candidate
        writeHelperMarker(args)
        return { pid: 1, unref() {}, kill() {} }
      }
    })
    ok(!/powershell/iu.test(command), `expected no PowerShell, got ${command}`)
    equal(existsSync(join(PLUGIN_ROOT, 'scripts', 'relaunch.ps1')), false, 'the PowerShell helper should be gone')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the relaunched application must not inherit the Node-mode switch', async () => {
  const { buildRelaunchEnv } = await import('../scripts/relaunch.mjs')
  const source = {
    PATH: 'C:\\Windows',
    ELECTRON_RUN_AS_NODE: '1',
    ELECTRON_NO_ATTACH_CONSOLE: '1',
    DSH_DESKTOP_NODE_EXECUTABLE: 'C:\\app.exe',
    DSH_HOME: 'C:\\Users\\x\\.dsh'
  }
  const built = buildRelaunchEnv(source)
  // An Electron executable started with this set would run as Node instead of
  // opening the application — the restart would silently do nothing visible.
  equal(built.ELECTRON_RUN_AS_NODE, undefined)
  equal(built.ELECTRON_NO_ATTACH_CONSOLE, undefined)
  equal(built.DSH_DESKTOP_NODE_EXECUTABLE, undefined)
  equal(built.PATH, source.PATH, 'everything else is inherited')
  equal(built.DSH_HOME, source.DSH_HOME)
  equal(source.ELECTRON_RUN_AS_NODE, '1', 'the caller environment is not mutated')
})

test('a quit ends the application without arranging a relaunch', async () => {
  const scheduled = []
  const ended = []
  const result = await armQuit({
    carrier: desktopCarrier,
    logger: { info() {}, warn() {} },
    schedule: (callback, delay) => { scheduled.push({ callback, delay }) },
    endImpl: options => { ended.push(options.appPid); return true }
  })

  equal(result.ok, true)
  equal(result.mode, 'quit')
  equal(result.appPid, desktopCarrier.appPid)
  equal(scheduled.length, 1, 'exactly one exit is armed')
  equal(ended.length, 0, 'the response is written before the process ends')
  scheduled[0].callback()
  deepEqual(ended, [desktopCarrier.appPid], 'and nothing will start it again')
})

test('a quit refuses to guess outside the Desktop', async () => {
  const scheduled = []
  const result = await armQuit({
    carrier: { desktop: false, selfPid: process.pid, appPid: 1, exePath: 'x', platform: process.platform },
    logger: { info() {}, warn() {} },
    schedule: (callback, delay) => { scheduled.push({ callback, delay }) },
    endImpl: () => { throw new Error('must not end anything') }
  })
  equal(result.ok, false)
  equal(result.mode, 'unsupported')
  equal(scheduled.length, 0, 'nothing is armed when there is no Desktop carrier')

  const noPid = await armQuit({
    carrier: { desktop: true, selfPid: process.pid, appPid: 0, exePath: 'x', platform: process.platform },
    logger: { info() {}, warn() {} },
    schedule: () => { throw new Error('must not schedule') }
  })
  equal(noPid.ok, false)
})

test('listening processes are read from the netstat table', async () => {
  const { parseNetstatOwners } = await import('../scripts/relaunch.mjs')
  const sample = [
    '',
    '活动连接',
    '',
    '  协议  本地地址          外部地址        状态           PID',
    '  TCP    127.0.0.1:19387        0.0.0.0:0              LISTENING       35072',
    '  TCP    127.0.0.1:19387        127.0.0.1:52344        ESTABLISHED     35072',
    '  TCP    127.0.0.1:1939         0.0.0.0:0              LISTENING       999',
    '  TCP    [::1]:19387            [::]:0                 LISTENING       35072',
    '  TCP    10.0.0.5:445           0.0.0.0:0              LISTENING       4'
  ].join('\r\n')
  deepEqual(parseNetstatOwners(sample, 19387), [35072])
  deepEqual(parseNetstatOwners(sample, 1939), [999])
  deepEqual(parseNetstatOwners(sample, 445), [4])
  deepEqual(parseNetstatOwners(sample, 12345), [])
  deepEqual(parseNetstatOwners('', 19387), [])
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
