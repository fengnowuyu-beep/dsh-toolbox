/**
 * Host half: the route family, the settings round-trip, the update check, the
 * price refresh and the spend route — all driven through the real handler with a
 * fake web server, a fake transport and a scratch harness home.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { close, deepEqual, equal, ok, run, test } from './harness.mjs'
import { apply, PLUGIN_VERSION, ROUTE_PREFIX, Toolbox } from '../lib/index.js'
import { pricesPath, settingsPath, stateDir } from '../lib/settings.js'

const PLUGIN_ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1')
const fixture = name => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

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
    async *[Symbol.asyncIterator]() {
      if (payload !== '') yield Buffer.from(payload, 'utf8')
    }
  }
}

/** A response that captures what was written. */
function response() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers ?? {}
    },
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
      return undefined
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
    /** Call one route method and return `{ status, payload }`. */
    async call(method, body, callOptions = {}) {
      const res = response()
      await route.handler(request(method, body, callOptions), res)
      let payload
      try {
        payload = JSON.parse(res.body)
      } catch {
        payload = undefined
      }
      return { status: res.status, payload, headers: res.headers }
    },
    async dispose() {
      await rm(home, { recursive: true, force: true })
    }
  }
}

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
    equal(view.cost.enabled, true)
    equal(view.cost.currency, 'CNY')
    equal(view.tray.enabled, false)
    equal(view.settingsFile, settingsPath(box.home))
    equal(view.pricesFile, pricesPath(box.home))
    equal(view.stateDir, stateDir(box.home))
    equal(view.desktop, false, 'the test process is not the Desktop child')
    equal(view.restart.supported, false)
    // The background check runs at start-up; without a packaged feed it reports
    // 'unsupported' rather than leaving the state unset.
    equal(['unknown', 'unsupported'].includes(view.update.status), true)
    equal(view.prices.models.includes('deepseek-flash'), true)
    equal(typeof view.appVersion, 'string')
  } finally {
    await box.dispose()
  }
})

test('a settings update persists, normalizes, and is visible on the next read', async () => {
  const box = await harness()
  try {
    const saved = await box.call('settings.update', {
      settings: { sendKey: 'ctrlEnter', updateCheckHours: 99_999, cost: { currency: 'USD', enabled: false } }
    })
    equal(saved.status, 200)
    equal(saved.payload.settings.sendKey, 'ctrlEnter')
    equal(saved.payload.settings.cost.currency, 'USD')
    equal(saved.payload.settings.cost.enabled, false)
    equal(saved.payload.settings.updateCheckHours, 6, 'an out-of-band number falls back')

    const reread = await box.call('settings.get')
    equal(reread.payload.settings.sendKey, 'ctrlEnter')
    equal(reread.payload.settings.cost.currency, 'USD')

    const onDisk = JSON.parse(readFileSync(settingsPath(box.home), 'utf8'))
    equal(onDisk.sendKey, 'ctrlEnter')
    equal(onDisk.cost.currency, 'USD')
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

test('a price refresh adopts the vendor table and is cached to disk', async () => {
  const box = await harness()
  try {
    // The plugin's own transport is the only thing that fetches here, so the
    // refresh route is exercised through a toolbox built with a fake transport.
    const home = box.home
    const toolbox = new Toolbox({
      logger: logger(),
      config: { dshHome: home },
      pluginRoot: PLUGIN_ROOT,
      fetchImpl: async (url) => ({
        ok: true,
        status: 200,
        text: async () => (url.includes('/zh-cn/') ? fixture('deepseek-pricing.zh.html') : fixture('deepseek-pricing.en.html'))
      })
    })
    const result = await toolbox.refreshPrices({ manual: true })
    ok(result.document !== null, result.error)
    equal(toolbox.effectivePrices().source, 'deepseek-docs')

    const cached = JSON.parse(readFileSync(pricesPath(home), 'utf8'))
    equal(cached.source, 'deepseek-docs')
    ok(Math.abs(cached.models['deepseek-flash'].CNY.output.offPeak - 4) < 1e-9)

    // A stale cached document is picked up on the next start.
    const reloaded = new Toolbox({ logger: logger(), config: { dshHome: home }, pluginRoot: PLUGIN_ROOT, fetchImpl: async () => { throw new Error('offline') } })
    reloaded.loadCached()
    equal(reloaded.effectivePrices().source, 'deepseek-docs')
  } finally {
    await box.dispose()
  }
})

test('the spend route prices a live session and refuses an unknown one', async () => {
  const events = [
    assistantMessage(0, { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 })
  ]
  const sessions = new Map([['session-live', session(events)]])
  const box = await harness({ sessions })
  try {
    const live = await box.call('cost.session', { sessionId: 'session-live' })
    equal(live.status, 200)
    equal(live.payload.ok, true)
    const cost = live.payload.cost
    // Peak hour (Friday 02:00 UTC), CNY: 1M miss 2 + 1M output 8.
    close(cost.amount, 10, 1e-9)
    equal(cost.currency, 'CNY')
    equal(cost.hasUsage, true)
    equal(cost.samples, 1)
    equal(cost.peakSamples, 1)
    equal(cost.byModel[0].model, 'deepseek-flash')
    equal(cost.priceSource, 'builtin')
    ok(cost.priceUpdatedAt.length > 0)

    const missing = await box.call('cost.session', { sessionId: 'session-gone' })
    equal(missing.status, 404)
    equal(missing.payload.error.code, 'session-not-live')

    const absent = await box.call('cost.session', {})
    equal(absent.status, 400)
    equal(absent.payload.error.code, 'bad-session')
  } finally {
    await box.dispose()
  }
})

test('the spend route follows a currency change immediately', async () => {
  const sessions = new Map([['session-live', session([
    assistantMessage(0, { inputTokens: 0, outputTokens: 1_000_000 })
  ])]])
  const box = await harness({ sessions })
  try {
    const cny = await box.call('cost.session', { sessionId: 'session-live' })
    close(cny.payload.cost.amount, 8, 1e-9)
    await box.call('settings.update', { settings: { cost: { currency: 'USD' } } })
    const usd = await box.call('cost.session', { sessionId: 'session-live' })
    close(usd.payload.cost.amount, 1.2, 1e-9)
    equal(usd.payload.cost.currency, 'USD')
  } finally {
    await box.dispose()
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
    for (const method of ['settings.get', 'status', 'update.check', 'prices.get', 'tray.set']) {
      const result = await box.call(method, { enabled: false })
      equal(result.status, 200, `${method} status`)
      equal(result.payload.ok, true, `${method} ok`)
      equal(result.headers['cache-control'], 'no-store', `${method} cache-control`)
      ok(result.headers['content-type'].startsWith('application/json'), `${method} content-type`)
      seen.push(method)
    }
    deepEqual(seen, ['settings.get', 'status', 'update.check', 'prices.get', 'tray.set'])
  } finally {
    await box.dispose()
  }
})

close(0, 0)
await run('host')
