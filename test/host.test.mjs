/**
 * Host half: the route family, the settings round-trip, the update check, the
 * window/tray control and the title route — all driven through the real handler
 * with a fake web server, a fake transport and a scratch harness home.
 *
 * The per-conversation spend readout is its own plugin now; its specs live in
 * `dsh-cost`.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { close, deepEqual, equal, ok, run, test } from './harness.mjs'
import { apply, PLUGIN_VERSION, ROUTE_PREFIX, Toolbox } from '../lib/index.js'
import { settingsPath, stateDir, logsDir } from '../lib/settings.js'
import { createTrayCompanion } from '../lib/tray.js'

const PLUGIN_ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1')

/** A quiet logger that remembers what was said. */
function logger() {
  const lines = []
  const record = kind => (...args) => lines.push(`${kind}: ${args.join(' ')}`)
  return { lines, info: record('info'), warn: record('warn'), debug: record('debug'), error: record('error') }
}

/** One live Session stand-in holding exactly the events given. */
function session(events, id = 'session-live') {
  return {
    id,
    seq: events.length,
    snapshotEvents: (fromSeq = 0) => events.filter(event => event.seq >= fromSeq)
  }
}

/** An `assistant/message` event with provider usage. */
function assistantMessage(seq, usage, model = 'deepseek-flash', time = Date.parse('2026-10-09T02:00:00Z')) {
  return {
    type: 'assistant/message',
    seq,
    time,
    data: {
      turn: seq,
      step: 0,
      message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek', model } },
      stream: [],
      usage
    }
  }
}

/** A POST request shaped the way the handler consumes one. */
function request(method, body, options = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  return {
    method: options.httpMethod ?? 'POST',
    url: `${ROUTE_PREFIX}/${method}`,
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
    headers: {
      host: options.host ?? '127.0.0.1:19387',
      ...options.headers ?? {}
    },
    /** The route registers close handlers on the request for its event stream. */
    on() {},
    async *[Symbol.asyncIterator]() {
      if (payload !== '') yield Buffer.from(payload, 'utf8')
    }
  }
}

/** A response that captures what was written, including streamed chunks. */
function response() {
  return {
    status: 0,
    headers: {},
    body: '',
    /** Every `write()` chunk, which is how a Server-Sent-Events body arrives. */
    chunks: [],
    writeHead(status, headers) {
      this.status = status
      this.headers = headers ?? {}
    },
    write(text) {
      this.chunks.push(String(text))
      return true
    },
    on() {},
    end(text) {
      this.body = text ?? ''
    }
  }
}

/** Build a toolbox over a scratch home and return its captured route handler. */
async function harness(options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-toolbox-host-'))
  const log = logger()
  const routes = []
  const sessions = options.sessions ?? new Map()
  const fakeContext = {
    logger: log,
    effect(fn) {
      const disposer = fn()
      return () => { if (typeof disposer === 'function') disposer() }
    },
    on() {},
    get(name) {
      if (name === 'sessions') return { get: id => sessions.get(id) }
      return options.context?.[name]
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      }
    }
  }
  apply(fakeContext, { dshHome: home, ...options.config ?? {} })
  const route = routes.at(-1)
  return {
    home,
    log,
    routes,
    sessions,
    route,
    /** Call one route method and return `{ status, payload, headers, response }`. */
    async call(method, body, callOptions = {}) {
      const res = response()
      await route.handler(request(method, body, callOptions), res)
      let payload
      try {
        payload = JSON.parse(res.body)
      } catch {
        payload = undefined
      }
      return { status: res.status, payload, headers: res.headers, response: res }
    },
    /** How many GUI pages currently hold the event stream open. */
    async dispose() {
      await rm(home, { recursive: true, force: true })
    }
  }
}

test('the plugin reports its own manifest version', () => {
  // Derived from package.json rather than duplicated: a missing manifest would
  // surface here as the '0.0.0' fallback instead of silently reporting a stale
  // hand-written number.
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  equal(PLUGIN_VERSION, manifest.version)
  ok(/^\d+\.\d+\.\d+/u.test(PLUGIN_VERSION), `expected a version, got ${PLUGIN_VERSION}`)
})

test('the plugin mounts exactly one prefix route', async () => {
  const box = await harness()
  try {
    equal(box.routes.length, 1)
    equal(box.route.kind, 'prefix')
    equal(box.route.path, ROUTE_PREFIX)
    equal(typeof box.route.handler, 'function')
    equal(box.log.lines.some(line => line.includes(`mounted ${ROUTE_PREFIX}`)), true)
  } finally {
    await box.dispose()
  }
})

test('closing DSH needs an explicit confirmation', async () => {
  const box = await harness()
  try {
    // Without `confirm: true` nothing may be ended — this route can take the
    // whole application down, so a stray call must not.
    const refused = await box.call('quit', {})
    equal(refused.status, 200)
    equal(refused.payload.ok, false)
    equal(refused.payload.quit.mode, 'refused')
    ok(refused.payload.quit.error.includes('确认'), `expected a confirmation demand, got ${refused.payload.quit.error}`)

    // With it, a non-Desktop runtime still refuses instead of guessing which
    // process to end (the test process is not an Electron child).
    const confirmed = await box.call('quit', { confirm: true })
    equal(confirmed.status, 200)
    equal(confirmed.payload.ok, false)
    equal(confirmed.payload.quit.mode, 'unsupported')
  } finally {
    await box.dispose()
  }
})

test('the window projection carries the start-up default and the last attempt', async () => {
  const box = await harness()
  try {
    const initial = await box.call('settings.get')
    equal(initial.payload.settings.window.startMaximized, true, 'maximize on start-up is on by default')
    equal(initial.payload.settings.startWindow.maximized, true, 'and it is part of the settings')
    equal(initial.payload.settings.quit.supported, false, 'this test process is not the Desktop child')

    const call = await box.call('window.maximize')
    equal(call.status, 200)
    equal(call.payload.ok, true)
    equal(call.payload.result.ok, false, 'a non-Desktop runtime cannot resize a window')
    ok(String(call.payload.result.error).length > 0, 'and it says why')
    ok(call.payload.window.logFile.endsWith('window.log'), 'the log path is projected for support')

    const after = await box.call('settings.get')
    equal(after.payload.settings.window.last.at > 0, true, 'the attempt is recorded for the settings page')
    equal(after.payload.settings.window.last.ok, false)
  } finally {
    await box.dispose()
  }
})

test('the tray menu strings and the script that reads them agree', () => {
  // A typo in a key is invisible at runtime: the companion falls back to the
  // built-in English default and the menu silently mixes languages.
  const copy = JSON.parse(readFileSync(new URL('../assets/tray-strings.json', import.meta.url), 'utf8'))
  const zh = Object.keys(copy.zh).sort()
  const en = Object.keys(copy.en).sort()
  deepEqual(zh, en, 'both locales must offer the same keys')
  const script = readFileSync(new URL('../scripts/tray.ps1', import.meta.url), 'utf8')
  const used = new Set()
  const pattern = /Msg\s+'([A-Za-z0-9_]+)'/gu
  let match = pattern.exec(script)
  while (match !== null) {
    used.add(match[1])
    match = pattern.exec(script)
  }
  ok(used.size > 10, `expected the script to read many keys, found ${String(used.size)}`)
  for (const key of used) {
    ok(copy.zh[key] !== undefined, `tray.ps1 reads "${key}", which the strings file does not define`)
  }
  // The new close action is present in both the menu and the copy.
  ok(copy.zh.quit !== undefined && copy.en.quit !== undefined, 'the close-item label must exist')
  ok(used.has('quitConfirmBody'), 'and the confirmation must be read from the copy')
})

test('the tray menu is exactly the agreed entries, in order', () => {
  // The menu is a contract the user reads, so it is pinned here: the order, what
  // each entry does, and the fact that a double-click toggles the window instead
  // of only opening the application.
  const script = readFileSync(new URL('../scripts/tray.ps1', import.meta.url), 'utf8')
  const added = [...script.matchAll(/^\$item(\w+) = \$menu\.Items\.Add\(\(Msg '([^']+)'/gmu)]
    .map(match => ({ variable: match[1], key: match[2] }))
  deepEqual(
    added,
    [
      { variable: 'Toggle', key: 'toggle' },
      { variable: 'Restart', key: 'restart' },
      { variable: 'Update', key: 'check' },
      { variable: 'Settings', key: 'settings' },
      { variable: 'Quit', key: 'quit' }
    ],
    'the menu must list show/hide, restart, check updates, settings, then close'
  )
  equal(script.includes('$menu.Items.Add(\'-\')'), false, 'no separators: the menu is these five')
  equal(script.includes('$itemToggle.add_Click({ Toggle-ApplicationWindow })'), true)
  equal(script.includes('$itemSettings.add_Click({ Open-Settings })'), true)
  equal(script.includes('$itemQuit.add_Click({ Stop-Application })'), true)
  equal(
    script.includes('$script:notify.add_MouseDoubleClick({ Toggle-ApplicationWindow })'),
    true,
    'a double-click shows or hides the window'
  )
})

test('the tray asks the page to open settings, because only a page can', () => {
  // The settings panel is the page's: the tray shows the window and asks the
  // Host, which pushes the request down the page's event stream.
  const script = readFileSync(new URL('../scripts/tray.ps1', import.meta.url), 'utf8')
  equal(script.includes("Invoke-ToolboxApi -Method 'page.request' -Body '{\"action\":\"settings\"}'"), true)
  equal(script.includes('delivered'), true, 'and it reports when no page was listening')
})

test('the tray toggles the window in its own process, not through the Host', () => {
  // Windows only lets a process raise another application's window when it owns
  // the foreground, and a click on this icon is what grants that: routing the
  // toggle through the Host would show the window without bringing it forward.
  const script = readFileSync(new URL('../scripts/tray.ps1', import.meta.url), 'utf8')
  const shared = readFileSync(new URL('../scripts/appwindow.ps1', import.meta.url), 'utf8')
  equal(script.includes(". (Join-Path $PSScriptRoot 'appwindow.ps1')"), true, 'the shared window code is dot-sourced')
  equal(script.includes('Invoke-AppWindowToggle -ProcessId $AppPid'), true, 'and the toggle runs here')
  for (const fn of ['Get-AppWindowHandle', 'Set-AppWindowShown', 'Set-AppWindowForeground', 'Invoke-AppWindowToggle']) {
    equal(shared.includes(`function ${fn}`), true, `appwindow.ps1 must define ${fn}`)
  }
  // A window hidden with SW_HIDE must come back at the size it had, so showing
  // uses SW_SHOW rather than SW_RESTORE (which would drop a maximized window).
  equal(shared.includes('$script:SW_SHOW = 5'), true)
  equal(shared.includes('$script:SW_HIDE = 0'), true)
  equal(shared.includes('if ($state.Iconic) { $script:SW_RESTORE } else { $script:SW_SHOW }'), true)
})

test('the maximize helper delegates to the shared window code', () => {
  const script = readFileSync(new URL('../scripts/maximize.ps1', import.meta.url), 'utf8')
  equal(script.includes(". (Join-Path $PSScriptRoot 'appwindow.ps1')"), true, 'one Win32 implementation, not two')
  equal(script.includes('Set-AppWindowMaximized'), true)
  equal(script.includes('Add-Type'), false, 'maximize.ps1 must not carry its own P/Invoke block')
  equal(script.includes('-RequireVisible'), true, 'it still waits for a window the shell has shown')
})

test('the page event stream carries a request from the tray', async () => {
  const box = await harness()
  try {
    // Only a page can open DSH's own settings panel, so the tray asks through
    // here; the page holds this stream open and the Host pushes down it.
    const stream = await box.call('events', undefined, { httpMethod: 'GET' })
    equal(stream.status, 200)
    equal(stream.headers['content-type'], 'text/event-stream; charset=utf-8')
    equal(stream.response.chunks[0], ': connected\n\n', 'the stream announces itself')
    const counted = await box.call('status')
    equal(counted.payload.settings.page.streams, 1, 'the open stream is counted in the projection')

    const asked = await box.call('page.request', { action: 'settings' })
    equal(asked.status, 200)
    equal(asked.payload.delivered, 1, 'the request reaches the open page')
    const pushed = stream.response.chunks.at(-1)
    ok(pushed.startsWith('event: page\ndata: '), `expected an SSE frame, got ${pushed}`)
    ok(pushed.includes('"action":"settings"'), 'carrying the action asked for')

    // The page then reports what happened, which is the only way to tell whether
    // the panel really opened.
    const report = await box.call('page.report', { action: 'settings', ok: true, via: 'trigger' })
    equal(report.status, 200)
    equal(report.payload.page.last.ok, true)
    equal(report.payload.page.last.via, 'trigger')

    const after = await box.call('settings.get')
    equal(after.payload.settings.page.last.ok, true, 'and the projection carries it for support')

    // The stream is the one non-POST route, and it refuses everything else.
    const wrong = await box.call('events', {})
    equal(wrong.status, 405)
    const missingAction = await box.call('page.request', {})
    equal(missingAction.status, 400)
  } finally {
    await box.dispose()
  }
})

test('an unknown method and a non-POST request are refused', async () => {
  const box = await harness()
  try {
    const unknown = await box.call('nope')
    equal(unknown.status, 404)
    equal(unknown.payload.ok, false)
    equal(unknown.payload.error.code, 'not-found')

    const get = await box.call('settings.get', undefined, { httpMethod: 'GET' })
    equal(get.status, 405)
    equal(get.payload.error.code, 'method-error')
  } finally {
    await box.dispose()
  }
})

test('a non-loopback caller cannot reach the route family', async () => {
  const box = await harness()
  try {
    const remote = await box.call('settings.get', undefined, { remoteAddress: '10.0.0.9' })
    equal(remote.status, 403)
    const crossSite = await box.call('settings.get', undefined, {
      headers: { 'sec-fetch-site': 'cross-site' }
    })
    equal(crossSite.status, 403)
  } finally {
    await box.dispose()
  }
})

test('the first settings read reports defaults and where they live', async () => {
  const box = await harness()
  try {
    const { status, payload } = await box.call('settings.get')
    equal(status, 200)
    equal(payload.ok, true)
    const view = payload.settings
    equal(view.pluginVersion, PLUGIN_VERSION)
    equal(view.sendKey, 'enter')
    equal(view.windowButtons.restart, true)
    equal(view.tray.enabled, false)
    equal(view.title.enabled, true)
    equal(view.settingsFile, settingsPath(box.home))
    equal(view.stateDir, stateDir(box.home))
    equal(view.cost, undefined, 'the spend readout is its own plugin')
    equal(view.prices, undefined)
    equal(view.desktop, false, 'the test process is not the Desktop child')
    equal(view.restart.supported, false)
    // The background check runs at start-up; without a packaged feed it reports
    // 'unsupported' rather than leaving the state unset.
    equal(['unknown', 'unsupported'].includes(view.update.status), true)
    equal(typeof view.appVersion, 'string')
  } finally {
    await box.dispose()
  }
})

test('a settings update persists, normalizes, and is visible on the next read', async () => {
  const box = await harness()
  try {
    const saved = await box.call('settings.update', {
      settings: { sendKey: 'ctrlEnter', updateCheckHours: 99_999, title: { enabled: false, maxInputKb: 8 }, tray: { enabled: false } }
    })
    equal(saved.status, 200)
    equal(saved.payload.settings.sendKey, 'ctrlEnter')
    equal(saved.payload.settings.title.enabled, false)
    equal(saved.payload.settings.title.maxInputKb, 8)
    equal(saved.payload.settings.updateCheckHours, 6, 'an out-of-band number falls back')

    const reread = await box.call('settings.get')
    equal(reread.payload.settings.sendKey, 'ctrlEnter')
    equal(reread.payload.settings.title.enabled, false)

    const onDisk = JSON.parse(readFileSync(settingsPath(box.home), 'utf8'))
    equal(onDisk.sendKey, 'ctrlEnter')
    equal(onDisk.title.enabled, false)
  } finally {
    await box.dispose()
  }
})

test('a restart is refused without an explicit confirmation', async () => {
  const box = await harness()
  try {
    const refused = await box.call('restart', {})
    equal(refused.status, 200)
    equal(refused.payload.ok, false)
    equal(refused.payload.restart.mode, 'refused')
    ok(refused.payload.error.includes('确认'))

    // Even with confirmation, a non-Desktop carrier cannot restart itself.
    const unsupported = await box.call('restart', { confirm: true })
    equal(unsupported.payload.ok, false)
    equal(unsupported.payload.restart.mode, 'unsupported')
  } finally {
    await box.dispose()
  }
})

test('the restart attempt is recorded for the settings page', async () => {
  const box = await harness()
  try {
    await box.call('restart', { confirm: true })
    const view = await box.call('settings.get')
    equal(view.payload.settings.restart.last.ok, false)
    ok(view.payload.settings.restart.last.error.length > 0)
  } finally {
    await box.dispose()
  }
})

test('an update check wins against a staged feed', async () => {
  const feed = 'version: 0.2.0-rc.9\nreleaseDate: "2026-10-08T00:00:00.000Z"\n'
  const { mkdtemp: mk, writeFile, rm: remove } = await import('node:fs/promises')
  const staging = await mk(join(tmpdir(), 'dsh-toolbox-feedstage-'))
  try {
    const appUpdateFile = join(staging, 'app-update.yml')
    await writeFile(appUpdateFile, 'provider: generic\nurl: https://feed.test/x/\nchannel: nightly\n', 'utf8')

    const home = await mk(join(tmpdir(), 'dsh-toolbox-hostfeed-'))
    try {
      const toolbox = new Toolbox({
        logger: logger(),
        config: { dshHome: home },
        pluginRoot: PLUGIN_ROOT,
        fetchImpl: async () => ({ ok: true, status: 200, text: async () => feed })
      })
      // Stand in for the installation facts this test cannot fabricate.
      toolbox.installation = {
        carrier: { desktop: false, selfPid: 1, appPid: 0, exePath: process.execPath, platform: process.platform },
        paths: { installDir: staging, resourcesDir: staging, asarPath: join(staging, 'app.asar'), appUpdateFile },
        appVersion: '0.2.0-rc.2',
        appVersionSource: 'test'
      }
      const update = await toolbox.checkUpdate()
      equal(update.status, 'ok')
      equal(update.currentVersion, '0.2.0-rc.2')
      equal(update.latestVersion, '0.2.0-rc.9')
      equal(update.available, true)
      ok(update.checkedAt > 0)

      // A second call joins the same answer rather than re-fetching.
      const again = await toolbox.checkUpdate()
      equal(again.latestVersion, '0.2.0-rc.9')
    } finally {
      await remove(home, { recursive: true, force: true })
    }
  } finally {
    await remove(staging, { recursive: true, force: true })
  }
})

test('the tray switch reports itself unsupported off Windows and rolls the setting back', async () => {
  const box = await harness()
  try {
    const on = await box.call('tray.set', { enabled: true, origin: 'http://127.0.0.1:19387' })
    equal(on.status, 200)
    const supported = process.platform === 'win32' && on.payload.settings.desktop === true
    if (!supported) {
      equal(on.payload.settings.tray.enabled, false, 'an unstartable tray must not stay switched on')
      equal(on.payload.tray.running, false)
      ok(String(on.payload.tray.error).length > 0)
    }
    const off = await box.call('tray.set', { enabled: false })
    equal(off.payload.settings.tray.enabled, false)
    equal(off.payload.tray.running, false)
  } finally {
    await box.dispose()
  }
})

test('the companion is given an http origin, never the page’s own scheme', () => {
  // The page's origin is `dsh-app://app` in the Desktop app, and PowerShell cannot
  // send a request to that scheme at all ("unrecognized URI prefix") — so every
  // tray menu action failed. The Host's own answer (taken from the request it
  // arrived on) has to win over anything the page reports.
  const spawned = []
  const tray = createTrayCompanion({
    pluginRoot: PLUGIN_ROOT,
    dshHome: tmpdir(),
    platform: 'win32',
    carrier: () => ({ desktop: true, selfPid: process.pid, appPid: 4242, exePath: 'C:\\app\\DeepSeek Harness.exe', platform: 'win32' }),
    spawnImpl: (command, args) => {
      spawned.push({ command, args })
      return { pid: 5150, on() {}, unref() {}, kill() {} }
    }
  })
  try {
    tray.setEnabled(true, { apiOrigin: 'http://127.0.0.1:19387', origin: 'dsh-app://app', appUrl: 'dsh-app://app' })
    equal(spawned.length, 1)
    const arg = name => spawned[0].args[spawned[0].args.indexOf(name) + 1]
    equal(arg('-BaseUrl'), 'http://127.0.0.1:19387', 'the companion must be able to call this')
    equal(arg('-AppUrl'), 'http://127.0.0.1:19387', 'and its open-fallback needs a launchable scheme too')
    equal(tray.status().origin, 'http://127.0.0.1:19387')

    // With only the page's own scheme available there is nothing usable, and the
    // reason must say so instead of spawning a companion that cannot call back.
    tray.dispose()
    const refused = []
    const second = createTrayCompanion({
      pluginRoot: PLUGIN_ROOT,
      dshHome: tmpdir(),
      platform: 'win32',
      carrier: () => ({ desktop: true, selfPid: process.pid, appPid: 4242, exePath: 'x', platform: 'win32' }),
      spawnImpl: () => { refused.push(1); return { pid: 1, on() {}, unref() {}, kill() {} } }
    })
    try {
      const status = second.setEnabled(true, { origin: 'dsh-app://app', appUrl: 'dsh-app://app' })
      equal(refused.length, 0, 'no companion may be started without a usable callback address')
      equal(status.running, false)
      ok(String(status.error).includes('http'), `expected an http explanation, got ${status.error}`)
    } finally {
      second.dispose()
    }
  } finally {
    tray.dispose()
  }
})

test('a malformed body is answered with a clear error, not a crash', async () => {
  const box = await harness()
  try {
    const res = response()
    const broken = request('settings.update')
    broken[Symbol.asyncIterator] = async function * () {
      yield Buffer.from('{ not json', 'utf8')
    }
    await box.route.handler(broken, res)
    equal(res.status, 400)
    equal(JSON.parse(res.body).error.code, 'bad-json')
  } finally {
    await box.dispose()
  }
})

test('every route answers with the documented envelope', async () => {
  const box = await harness()
  try {
    const seen = []
    for (const method of ['settings.get', 'status', 'update.check', 'tray.set']) {
      const result = await box.call(method, { enabled: false })
      equal(result.status, 200, `${method} status`)
      equal(result.payload.ok, true, `${method} ok`)
      equal(result.headers['cache-control'], 'no-store', `${method} cache-control`)
      ok(result.headers['content-type'].startsWith('application/json'), `${method} content-type`)
      seen.push(method)
    }
    deepEqual(seen, ['settings.get', 'status', 'update.check', 'tray.set'])
  } finally {
    await box.dispose()
  }
})

close(0, 0)
test('title.generate is fenced, validates its input, and answers in the route family', async () => {
  // A conversation that exists but holds nothing human-written yet.
  const empty = session([assistantMessage(1)], 'session-empty')
  const box = await harness({ sessions: new Map([['session-empty', empty]]) })
  try {
    // The title route spends tokens, so the loopback fence is the first thing to
    // prove: another machine on the network must not be able to drive it.
    const remote = await box.call('title.generate', { sessionId: 'session-empty' }, { remoteAddress: '10.0.0.9' })
    equal(remote.status, 403)
    equal(remote.payload.error.code, 'forbidden')

    const missing = await box.call('title.generate', {})
    equal(missing.status, 400)
    equal(missing.payload.error.code, 'bad-request')

    // An unknown session is a 404 with the reason the menu shows.
    const unknown = await box.call('title.generate', { sessionId: 'session-nope' })
    equal(unknown.status, 404)
    equal(unknown.payload.error.code, 'not-found')

    // A conversation with no human text refuses softly: 200 with `ok: false`, so
    // the row can explain itself without the page treating it as a failure.
    const refused = await box.call('title.generate', { sessionId: 'session-empty' })
    equal(refused.status, 200)
    equal(refused.payload.ok, false)
    equal(refused.payload.reason, 'no-messages')

    // Every attempt is audited, including the refusals: this is the only record
    // of what a click actually cost. The audit is appended without being awaited
    // by the route (a log write must never delay an answer), so this reads after
    // letting those writes land.
    await new Promise(resolve => setTimeout(resolve, 50))
    const logFile = join(logsDir(box.home), 'toolbox.log')
    const audit = readFileSync(logFile, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    const titles = audit.filter(entry => entry.event === 'title-generate')
    ok(titles.length >= 3, `expected the attempts to be audited, got ${String(titles.length)}`)
    ok(titles.some(entry => entry.reason === 'not-found'))
    ok(titles.some(entry => entry.reason === 'no-messages'))
  } finally {
    await box.dispose()
  }
})

test('title.generate carries the model call through to a pinned title', async () => {
  // The full path with a fake LLM: message selection, the auxiliary request's
  // shape, and the rename that pins the result.
  const events = [
    {
      type: 'user/message',
      seq: 1,
      time: 1,
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '登录接口报错了，帮我看看' }] }
    },
    {
      type: 'assistant/message',
      seq: 2,
      time: 2,
      data: { message: { role: 'assistant' }, usage: { inputTokens: 5, outputTokens: 5 } }
    }
  ]
  const live = {
    id: 'session-live',
    snapshotEvents: () => events,
    requestHeader: () => ({ config: { provider: 'deepseek-account', model: 'deepseek-flash' } })
  }
  const seen = []
  const renamed = []
  let current
  const box = await harness({
    sessions: new Map([['session-live', live]]),
    context: {
      llm: {
        stream(options) {
          seen.push(options)
          return (async function* replay() {
            yield { type: 'text-delta', index: 0, text: '登录接口空指针修复' }
            yield { type: 'usage', usage: { inputTokens: 1043, outputTokens: 14 } }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        }
      },
      sessionTitle: {
        get: () => current,
        rename: (target, title) => {
          renamed.push({ id: target.id, title })
          current = { title, eventSeq: 1, source: { kind: 'user' } }
          return current
        }
      }
    }
  })
  try {
    const answer = await box.call('title.generate', { sessionId: 'session-live' })
    equal(answer.status, 200)
    equal(answer.payload.ok, true)
    equal(answer.payload.title, '登录接口空指针修复')
    equal(answer.payload.source.kind, 'user')
    equal(answer.payload.source.model, 'deepseek-account/deepseek-flash')
    deepEqual(renamed, [{ id: 'session-live', title: '登录接口空指针修复' }])

    // The auxiliary call: reasoning is switched off by the purpose alone, and the
    // budget is enforced on what actually goes out.
    equal(seen.length, 1)
    equal(seen[0].purpose, 'session-title')
    equal(seen[0].reasoningEffort, undefined)
    equal(seen[0].maxTokens, 64)
    equal(seen[0].messages.length, 1)
    ok(answer.payload.inputBytes <= 4096, `input grew past the budget: ${String(answer.payload.inputBytes)}`)
  } finally {
    await box.dispose()
  }
})

test('title.generate prefers DSH\u2019s turn outline and logs how much it could see', async () => {
  // The outline is the whole point of the newer selection: it lets one 4 KiB
  // request describe a long conversation. This drives the route with a
  // projection mounted and checks both the payload and the audit trail.
  const live = {
    id: 'session-live',
    snapshotEvents: () => [],
    requestHeader: () => ({ config: { provider: 'deepseek-account', model: 'deepseek-flash' } })
  }
  const turns = Array.from({ length: 60 }, (unused, index) => ({
    turn: index + 1,
    seq: index,
    prompt: `第 ${String(index + 1)} 轮的提示词`,
    response: '这一轮的结论'
  }))
  const seen = []
  const box = await harness({
    sessions: new Map([['session-live', live]]),
    context: {
      sessionProjections: { stateOf: (unused, key) => (key === 'turnOutline' ? { turns, draft: '' } : undefined) },
      llm: {
        stream(options) {
          seen.push(options)
          return (async function* replay() {
            yield { type: 'text-delta', index: 0, text: '六十轮会话的主线' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        }
      },
      sessionTitle: {
        get: () => undefined,
        rename: (target, title) => ({ title, eventSeq: 1, source: { kind: 'user' } })
      }
    }
  })
  try {
    const answer = await box.call('title.generate', { sessionId: 'session-live' })
    equal(answer.status, 200)
    equal(answer.payload.ok, true)
    equal(answer.payload.title, '六十轮会话的主线')
    deepEqual(answer.payload.outline, { strategy: 'sample', totalTurns: 60, sampled: answer.payload.outline.sampled, withResponses: true })
    ok(answer.payload.outline.sampled >= 3, 'anchors plus at least one sampled turn')
    ok(answer.payload.inputBytes <= 4096, `input grew past the budget: ${String(answer.payload.inputBytes)}`)

    const body = seen[0].messages[0].content[0].text
    ok(body.startsWith('Generate the session title from this turn outline.'))
    ok(body.includes('"totalTurns":60'), 'the model is told the session is longer than the sample')
    ok(seen[0].system.includes('turn outline'))

    // The audit is what answers "is 4 KiB enough?" from real data.
    await new Promise(resolve => setTimeout(resolve, 50))
    const audit = readFileSync(join(logsDir(box.home), 'toolbox.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    const record = audit.filter(entry => entry.event === 'title-generate').at(-1)
    equal(record.source, 'outline')
    equal(record.totalTurns, 60)
    equal(record.strategy, 'sample')
    equal(record.withResponses, true)
    ok(record.sampledTurns >= 3)
  } finally {
    await box.dispose()
  }
})

test('title.generate falls back to reading the log when the outline is absent', async () => {
  // No projection mounted: identical behaviour to before the outline existed,
  // which is what makes the projection an upgrade rather than a dependency.
  const events = [
    { type: 'user/message', seq: 1, time: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第一个问题' }] } },
    { type: 'assistant/message', seq: 2, time: 2, data: { message: { role: 'assistant' } } },
    { type: 'user/message', seq: 3, time: 3, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '最后一个问题' }] } }
  ]
  const live = {
    id: 'session-live',
    snapshotEvents: () => events,
    requestHeader: () => ({ config: { provider: 'deepseek-account', model: 'deepseek-flash' } })
  }
  const seen = []
  const box = await harness({
    sessions: new Map([['session-live', live]]),
    context: {
      llm: {
        stream(options) {
          seen.push(options)
          return (async function* replay() {
            yield { type: 'text-delta', index: 0, text: '两个问题' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        }
      },
      sessionTitle: { get: () => undefined, rename: (target, title) => ({ title, eventSeq: 1, source: { kind: 'user' } }) }
    }
  })
  try {
    const answer = await box.call('title.generate', { sessionId: 'session-live' })
    equal(answer.payload.ok, true)
    equal(answer.payload.outline, undefined, 'no outline metadata on the log path')
    deepEqual(answer.payload.messageSeqs, [1, 3])
    ok(seen[0].messages[0].content[0].text.startsWith('Generate the session title from this JSON array'))

    await new Promise(resolve => setTimeout(resolve, 50))
    const audit = readFileSync(join(logsDir(box.home), 'toolbox.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    const record = audit.filter(entry => entry.event === 'title-generate').at(-1)
    equal(record.source, 'messages')
    equal(record.totalTurns, 0)
  } finally {
    await box.dispose()
  }
})

await run('host')
