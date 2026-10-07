/**
 * dsh-toolbox — Host half.
 *
 * One plugin, one settings document, and four jobs:
 *
 *  1. **Restart.** {@link module:dsh-toolbox/restart} explains why a restart is
 *     a detached helper plus a deliberate exit of the Desktop application
 *     process, and why the exit only happens once the helper is live.
 *  2. **Update check.** The installed version is read from the installation
 *     itself and compared against the same feed `electron-updater` was
 *     configured with, so the answer matches what the shipped updater would do.
 *  3. **Pricing.** A price table for the DeepSeek models, shipped with the
 *     plugin and refreshable from the vendor's own published table.
 *  4. **Spend.** Per-conversation cost, folded from the Session log so it always
 *     describes the same tokens the composer's token pill shows.
 *
 * The browser half drives all of it through one POST-only route family; this
 * half owns every decision (what a restart means, what a version comparison
 * says, which price applies) so the two halves cannot disagree.
 *
 * @module dsh-toolbox
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { checkForUpdate, readAppVersion, resolveInstallPaths } from './appinfo.js'
import { createCostLedger } from './cost.js'
import {
  builtinPriceDocument,
  isPriceDocumentStale,
  loadCachedPrices,
  normalizeExternalJson,
  normalizePriceDocument,
  refreshPrices,
  saveCachedPrices,
  BUILTIN_PRICES
} from './pricing.js'
import { armRestart, describeCarrier } from './restart.js'
import {
  composeSettings,
  loadPersisted,
  logsDir,
  normalizeSettings,
  pricesPath,
  publicSettings,
  resolveDshHome,
  savePersisted,
  settingsPath,
  stateDir
} from './settings.js'
import { createTrayCompanion } from './tray.js'

/** Cordis services this Host half needs before it can mount its routes. */
export const inject = ['webServer']

/** The plugin's own version, surfaced to the settings page for support. */
export const PLUGIN_VERSION = '1.0.0'

/** Route family mounted on the Host webserver. */
export const ROUTE_PREFIX = '/dsh-toolbox/api'

/** Route methods the browser half (or the tray companion) may call. */
const ROUTE_KEYS = Object.freeze([
  'settings.get',
  'settings.update',
  'restart',
  'update.check',
  'prices.get',
  'prices.refresh',
  'cost.session',
  'tray.set',
  'status'
])

/** Bounded body size for these small JSON requests. */
const BODY_LIMIT = 256_000

/** One HTTP-level failure carrying its status. */
class HttpError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** Write one JSON response. */
function writeJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  })
  response.end(body)
}

/** Whether one address is loopback. */
function isLoopbackAddress(address) {
  const normalized = String(address).toLowerCase()
  if (normalized === '::1') return true
  const candidate = normalized.startsWith('::ffff:') ? normalized.slice(7) : normalized
  const parts = candidate.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/u.test(part) && Number(part) <= 255)
}

/** Whether one hostname names loopback. */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true
  return isLoopbackAddress(hostname)
}

/**
 * Loopback-only request fence, mirroring the `/api` gateway's posture: a
 * restart must never be reachable from another machine on the network.
 * @param request - the incoming request.
 * @returns whether the caller is this machine.
 */
function isTrusted(request) {
  const remote = request?.socket?.remoteAddress
  if (typeof remote === 'string' && !isLoopbackAddress(remote)) return false
  const host = request?.headers?.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).hostname === hostUrl.hostname
  } catch {
    return false
  }
}

/** The port this request arrived on, or 0. */
function portFromRequest(request) {
  const host = request?.headers?.host
  if (typeof host !== 'string') return 0
  try {
    const parsed = new URL(`http://${host}`)
    if (parsed.port !== '') return Number(parsed.port)
    return parsed.protocol === 'https:' ? 443 : 80
  } catch {
    return 0
  }
}

/** Read a JSON body with a hard size cap. */
async function readJsonBody(request, limit = BODY_LIMIT) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) throw new HttpError(413, 'payload-too-large', 'request body is too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'bad-json', 'request body is not valid JSON')
  }
}

/**
 * The live toolbox. Exposed for the offline test suite; the Loader only needs
 * {@link apply}.
 */
export class Toolbox {
  /**
   * @param options - resolved paths, logger and Loader config.
   */
  constructor(options) {
    this.logger = options.logger
    this.config = options.config ?? {}
    this.pluginRoot = options.pluginRoot
    this.dshHome = resolveDshHome(this.config.dshHome)
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.now = options.now ?? (() => Date.now())

    this.persisted = loadPersisted(this.logger, this.dshHome)
    this.settings = composeSettings(this.persisted, this.config)

    /** Version/feed facts, resolved lazily and cached for the process lifetime. */
    this.installation = undefined
    /**
     * Last update-check result. Named with a suffix so it cannot shadow the
     * `update()` method that persists settings — an instance property and a
     * prototype method with one name silently win for the property.
     */
    this.updateState = { status: 'unknown', currentVersion: '', latestVersion: '', available: false, error: '', checkedAt: 0 }
    /** Effective price document plus where it came from. */
    this.prices = { document: builtinPriceDocument(), error: '', attempts: [], fetchedAt: 0 }
    /** Spend memo, invalidated whenever the price document changes. */
    this.costs = createCostLedger({ limit: 48 })
    /** Last restart attempt, for the settings page. */
    this.lastRestart = { at: 0, ok: false, detail: '', error: '' }
    /** One check at a time. */
    this.updateCheck = undefined
    /** One price refresh at a time. */
    this.priceRefresh = undefined
    this.tray = createTrayCompanion({
      pluginRoot: this.pluginRoot,
      dshHome: this.dshHome,
      logger: this.logger,
      ...options.trayOptions === undefined ? {} : options.trayOptions
    })
    this.trayError = ''
  }

  /** Resolve (once) the installed version and the feed this installation checks. */
  facts() {
    if (this.installation === undefined) {
      const carrier = describeCarrier()
      const paths = resolveInstallPaths(carrier.exePath)
      const version = readAppVersion(paths)
      this.installation = {
        carrier,
        paths,
        appVersion: version.version,
        appVersionSource: version.source
      }
    }
    return this.installation
  }

  /**
   * The projection the browser half reads: the effective settings, everything
   * read off the installation, and the live state of each subsystem.
   */
  describe() {
    const { carrier, paths, appVersion, appVersionSource } = this.facts()
    const document = this.effectivePrices()
    return {
      ...publicSettings(this.settings, this.dshHome, {
        pluginVersion: PLUGIN_VERSION,
        platform: process.platform,
        desktop: carrier.desktop,
        appPid: carrier.appPid,
        selfPid: carrier.selfPid,
        exePath: carrier.exePath,
        appVersion,
        appVersionSource,
        appUpdateFile: paths.appUpdateFile
      }),
      update: this.updateProjection(),
      prices: {
        source: document.source,
        label: document.label,
        updatedAt: document.updatedAt,
        models: Object.keys(document.models),
        modelCount: Object.keys(document.models).length,
        currency: this.settings.cost.currency,
        stale: isPriceDocumentStale(document, this.settings.cost.refreshHours, this.now()),
        file: pricesPath(this.dshHome),
        error: this.prices.error,
        attempts: this.prices.attempts
      },
      restart: {
        // The carrier alone decides whether a restart is possible: the installed
        // version is a separate fact and must not gate the button.
        supported: carrier.desktop,
        mode: carrier.desktop ? 'relaunch' : 'unsupported',
        appPid: carrier.appPid,
        exePath: carrier.exePath,
        last: this.lastRestart
      },
      // The tray and cost keys are suffixed so they cannot shadow the settings
      // objects of the same name in the merged projection the page reads.
      trayStatus: { ...this.tray.status(), error: this.trayError || this.tray.status().error },
      costStats: { cachedSessions: this.costs.size }
    }
  }

  /** The update subsystem's public state. */
  updateProjection() {
    const { paths, appVersion, appVersionSource } = this.facts()
    return {
      ...this.updateState,
      currentVersion: this.updateState.currentVersion === '' ? appVersion : this.updateState.currentVersion,
      appVersion,
      appVersionSource,
      appUpdateFile: paths.appUpdateFile,
      autoCheck: this.settings.autoCheckUpdates,
      hours: this.settings.updateCheckHours
    }
  }

  /** The price document in force: the cached fetch when there is one, else the shipped table. */
  effectivePrices() {
    if (this.settings.cost.pricingSource === 'builtin') return builtinPriceDocument()
    return this.prices.document ?? builtinPriceDocument()
  }

  /** Adopt a price document and drop every memo derived from the previous one. */
  adoptPrices(document, meta = {}) {
    this.prices = {
      document: document ?? builtinPriceDocument(),
      error: meta.error ?? '',
      attempts: meta.attempts ?? [],
      fetchedAt: meta.fetchedAt ?? this.now()
    }
    this.costs.invalidate()
  }

  /** Load a cached price document, preferring the shipped table when none is usable. */
  loadCached() {
    const cached = loadCachedPrices(this.dshHome, this.logger)
    if (cached !== null) {
      this.adoptPrices(cached)
      return true
    }
    this.adoptPrices(builtinPriceDocument())
    return false
  }

  /**
   * Refresh the price table.
   * @param options - whether the caller is waiting for the result.
   * @returns `{ document, error, attempts }`.
   */
  async refreshPrices(options = {}) {
    if (this.priceRefresh !== undefined) return this.priceRefresh
    const { pricingSource, pricingUrl, refreshHours } = this.settings.cost
    const source = pricingSource === 'builtin' ? 'builtin' : pricingSource
    this.priceRefresh = (async () => {
      try {
        const result = await refreshPrices({
          source: source === 'auto' ? 'auto' : source,
          pricingUrl,
          fetchImpl: this.fetchImpl,
          logger: this.logger,
          now: this.now
        })
        if (result.document !== null) {
          this.adoptPrices(result.document, { error: '', attempts: result.attempts, fetchedAt: this.now() })
          try {
            await saveCachedPrices(this.dshHome, result.document)
          } catch (error) {
            this.logger?.warn?.(`toolbox: could not cache prices: ${String(error)}`)
          }
        } else if (result.error !== '') {
          // A failed refresh keeps whatever is already in force — the shipped
          // table or the last successful fetch — and only reports the reason.
          this.prices = { ...this.prices, error: result.error, attempts: result.attempts }
          this.logger?.warn?.(`toolbox: price refresh failed: ${result.error}`)
        }
        void refreshHours
        void options
        return { document: this.effectivePrices(), error: this.prices.error, attempts: this.prices.attempts }
      } finally {
        this.priceRefresh = undefined
      }
    })()
    return this.priceRefresh
  }

  /** Merge a settings patch, persist it, and re-apply the parts that need it. */
  async update(patch) {
    const requested = patch !== null && typeof patch === 'object' ? patch : {}
    const merged = {}
    for (const key of Object.keys(this.settings)) {
      merged[key] = requested[key] !== undefined ? requested[key] : this.settings[key]
    }
    const next = normalizeSettings(merged)
    this.persisted = next
    await savePersisted(next, this.dshHome)
    const previousCurrency = this.settings.cost.currency
    const previousUsdCny = this.settings.cost.usdCny
    const previousSource = this.settings.cost.pricingSource
    this.settings = composeSettings(this.persisted, this.config)
    if (previousCurrency !== this.settings.cost.currency || previousUsdCny !== this.settings.cost.usdCny) {
      this.costs.invalidate()
    }
    if (previousSource !== this.settings.cost.pricingSource) {
      if (this.settings.cost.pricingSource === 'builtin') this.adoptPrices(builtinPriceDocument())
      else this.loadCached()
    }
    return this.settings
  }

  /**
   * Ask the update feed whether something newer exists, joining any check
   * already in flight.
   * @param options - whether a failure should stay visible.
   * @returns the update projection.
   */
  async checkUpdate(options = {}) {
    if (this.updateCheck !== undefined) return this.updateCheck
    this.updateCheck = (async () => {
      const { paths, appVersion } = this.facts()
      try {
        const result = await checkForUpdate({
          appUpdateFile: paths.appUpdateFile,
          currentVersion: appVersion,
          fetchImpl: this.fetchImpl,
          logger: this.logger
        })
        this.updateState = {
          status: result.status,
          currentVersion: result.currentVersion,
          latestVersion: result.latestVersion,
          available: result.available === true,
          releaseDate: result.releaseDate ?? '',
          feedUrl: result.feedUrl ?? '',
          error: result.error ?? '',
          checkedAt: this.now()
        }
      } catch (error) {
        this.updateState = {
          ...this.updateState,
          status: 'error',
          currentVersion: appVersion,
          available: false,
          error: String(error?.message ?? error),
          checkedAt: this.now()
        }
      } finally {
        this.updateCheck = undefined
      }
      void options
      return this.updateProjection()
    })()
    return this.updateCheck
  }

  /**
   * A restart is only ever armed when the caller confirms and a Desktop carrier
   * exists; the helper's readiness marker gates ending the application.
   * @param options - the confirmation flag and the port to wait for.
   * @returns the restart outcome.
   */
  async restart(options = {}) {
    const { confirm = false, port = 0 } = options
    const result = await this.performRestart({ confirm, port })
    // Every attempt is recorded, refusals included: the settings page shows why
    // the button did nothing, and a missing record would read as "never tried".
    this.lastRestart = {
      at: this.now(),
      ok: result.ok === true,
      mode: result.mode ?? '',
      detail: result.detail ?? '',
      error: result.error ?? ''
    }
    return result
  }

  /** The restart decision itself, without the bookkeeping. */
  async performRestart({ confirm, port }) {
    if (confirm !== true) {
      return { ok: false, mode: 'refused', error: '重启需要显式确认（confirm: true）' }
    }
    const { carrier } = this.facts()
    if (!carrier.desktop) {
      return { ok: false, mode: 'unsupported', error: '当前不是 DSH 桌面端进程，无法自动重启（请手动重启你启动的 DSH 进程）' }
    }
    return await armRestart({
      pluginRoot: this.pluginRoot,
      dshHome: this.dshHome,
      logger: this.logger,
      port,
      carrier
    })
  }

  /**
   * Price one live session.
   * @param sessionId - the session to report on.
   * @returns the spend report.
   */
  sessionCost(sessionId) {
    const sessions = this.sessionsService()
    if (sessions === undefined) throw new HttpError(503, 'sessions-unavailable', 'sessions 服务不可用')
    const id = typeof sessionId === 'string' ? sessionId : ''
    if (id === '') throw new HttpError(400, 'bad-session', '缺少 sessionId')
    const session = sessions.get?.(id)
    if (session === undefined) throw new HttpError(404, 'session-not-live', `会话 ${id} 不在本进程中`)
    const document = this.effectivePrices()
    const report = this.costs.compute(session, {
      document,
      documentStamp: `${document.source}|${document.updatedAt}`,
      displayCurrency: this.settings.cost.currency,
      usdCny: this.settings.cost.usdCny
    })
    // The price a report was priced with travels with it, so the panel can say
    // which table produced the number instead of implying it is timeless.
    return {
      ...report,
      currency: this.settings.cost.currency,
      otherCurrency: this.settings.cost.currency === 'USD' ? 'CNY' : 'USD',
      priceSource: document.source,
      priceLabel: document.label,
      priceUpdatedAt: document.updatedAt
    }
  }

  /** The sessions service, when this composition mounts one. */
  sessionsService() {
    try {
      return this.ctx?.get?.('sessions')
    } catch {
      return undefined
    }
  }

  /**
   * Start or stop the companion tray icon.
   * @param enabled - desired state.
   * @param context - the browser-side origin and authenticated URL.
   */
  setTray(enabled, context = {}) {
    const status = this.tray.setEnabled(enabled, context)
    this.trayError = status.error ?? ''
    return status
  }

  /** Append one line to the plugin's own audit log. */
  async audit(entry) {
    try {
      const file = join(logsDir(this.dshHome), 'toolbox.log')
      await mkdir(dirname(file), { recursive: true })
      await appendFile(file, `${JSON.stringify({ at: new Date(this.now()).toISOString(), ...entry })}\n`, 'utf8')
    } catch {
      /* auditing never fails a request */
    }
  }

  /** Wire the background jobs. */
  start() {
    const hadCache = this.loadCached()

    // The vendor table is fetched in the background on first start and whenever
    // the cached copy has aged out, so the shipped table is a starting point
    // rather than the answer. A stale fetch keeps whatever is already in force.
    if (this.settings.cost.autoRefreshPrices && this.settings.cost.pricingSource !== 'builtin') {
      const current = this.prices.document ?? builtinPriceDocument()
      const stale = !hadCache || isPriceDocumentStale(current, this.settings.cost.refreshHours, this.now())
      if (stale) {
        void this.refreshPrices({ background: true }).catch(error => {
          this.logger?.warn?.(`toolbox: background price refresh failed: ${String(error)}`)
        })
      }
    }

    if (this.settings.autoCheckUpdates) {
      void this.checkUpdate().catch(() => {})
    }
  }

  /** Release every owned resource. */
  dispose() {
    this.tray.dispose()
  }
}

/**
 * Mount the Host half.
 * @param ctx - the Cordis host context (provides `webServer`).
 * @param config - optional Loader config (`enabled`, `dshHome`, defaults).
 */
export function apply(ctx, config) {
  if (config?.enabled === false) {
    ctx.logger?.info?.('toolbox: disabled by config')
    return
  }

  const logger = ctx.logger ?? console
  const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  const toolbox = new Toolbox({ logger, config, pluginRoot })
  toolbox.ctx = ctx

  ctx.effect(() => () => toolbox.dispose(), 'toolbox: companion tray')
  ctx.effect(() => {
    toolbox.start()
  }, 'toolbox: background jobs')

  // A background update check on the configured cadence, so a long-running DSH
  // notices a release without the user pressing anything.
  ctx.effect(() => {
    const hours = toolbox.settings.updateCheckHours
    if (toolbox.settings.autoCheckUpdates !== true || !Number.isFinite(hours) || hours <= 0) return () => {}
    const timer = setInterval(() => {
      void toolbox.checkUpdate().catch(() => {})
    }, Math.max(60_000, hours * 3600_000))
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'toolbox: update cadence')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (request, response) => {
      if (!isTrusted(request)) {
        writeJson(response, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        return
      }
      if (request.method !== 'POST') {
        writeJson(response, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
        return
      }
      const pathname = new URL(request.url ?? '/', 'http://dsh.internal').pathname
      const method = pathname.startsWith(`${ROUTE_PREFIX}/`)
        ? pathname.slice(ROUTE_PREFIX.length + 1)
        : undefined
      if (method === undefined || !ROUTE_KEYS.includes(method)) {
        writeJson(response, 404, { ok: false, error: { code: 'not-found', message: `unknown method "${String(method)}"` } })
        return
      }

      try {
        const payload = await readJsonBody(request)
        switch (method) {
          case 'settings.get':
          case 'status':
            writeJson(response, 200, { ok: true, settings: toolbox.describe() })
            return
          case 'settings.update': {
            await toolbox.update(payload?.settings ?? payload)
            writeJson(response, 200, { ok: true, settings: toolbox.describe() })
            return
          }
          case 'restart': {
            const port = Number.isSafeInteger(payload?.port) && payload.port > 0 ? payload.port : portFromRequest(request)
            const result = await toolbox.restart({ confirm: payload?.confirm === true, port })
            void toolbox.audit({ event: 'restart', ok: result.ok === true, mode: result.mode, error: result.error ?? '' })
            writeJson(response, 200, { ok: result.ok === true, restart: result, error: result.ok === true ? '' : result.error })
            return
          }
          case 'update.check': {
            const update = await toolbox.checkUpdate()
            void toolbox.audit({ event: 'update-check', status: update.status, latest: update.latestVersion })
            writeJson(response, 200, { ok: true, update })
            return
          }
          case 'prices.get':
            writeJson(response, 200, { ok: true, prices: toolbox.describe().prices, document: toolbox.effectivePrices() })
            return
          case 'prices.refresh': {
            const result = await toolbox.refreshPrices({ manual: true })
            writeJson(response, 200, {
              ok: true,
              prices: toolbox.describe().prices,
              document: result.document ?? toolbox.effectivePrices(),
              error: result.error ?? ''
            })
            return
          }
          case 'cost.session': {
            const cost = toolbox.sessionCost(payload?.sessionId)
            writeJson(response, 200, { ok: true, cost })
            return
          }
          case 'tray.set': {
            const enabled = payload?.enabled === true
            await toolbox.update({ ...toolbox.settings, tray: { enabled } })
            let status = toolbox.setTray(enabled, {
              origin: payload?.origin,
              appUrl: payload?.appUrl,
              locale: payload?.locale
            })
            // Starting the companion can fail (no Desktop carrier, no script, a
            // spawn error). The switch then reports off, so the next load does
            // not claim a tray that is not there — but the reason is kept, or the
            // page would show a switch that simply refused to move.
            if (enabled && status.running !== true) {
              const failure = status.error ?? ''
              await toolbox.update({ ...toolbox.settings, tray: { enabled: false } })
              status = { ...toolbox.setTray(false), error: failure }
              toolbox.trayError = failure
            }
            writeJson(response, 200, { ok: true, tray: status, settings: toolbox.describe() })
            return
          }
          default:
            writeJson(response, 404, { ok: false, error: { code: 'not-found', message: 'unknown method' } })
        }
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500
        const code = error instanceof HttpError ? error.code : 'internal-error'
        const message = error instanceof Error ? error.message : String(error)
        if (status >= 500) logger.warn?.(`toolbox: ${method} failed: ${message}`)
        writeJson(response, status, { ok: false, error: { code, message } })
      }
    }
  }), 'toolbox: routes')

  logger.info?.(`toolbox: mounted ${ROUTE_PREFIX} (state: ${stateDir(toolbox.dshHome)})`)
}

/**
 * A closed-over inspector for `dsh-tool-cordis` and the offline test suite: it
 * is deliberately side-effect free — no route, no timer, no child process.
 * @param ctx - any context of the app.
 * @returns the inspectable projection.
 */
export const inspector = (ctx) => {
  const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  const toolbox = new Toolbox({ logger: ctx?.logger ?? console, config: {}, pluginRoot })
  return {
    version: PLUGIN_VERSION,
    stateDir: stateDir(toolbox.dshHome),
    settingsFile: settingsPath(toolbox.dshHome),
    pricesFile: pricesPath(toolbox.dshHome),
    describe: () => toolbox.describe(),
    checkUpdate: () => toolbox.checkUpdate(),
    refreshPrices: () => toolbox.refreshPrices({ manual: true }),
    sessionCost: sessionId => toolbox.sessionCost(sessionId),
    normalizeExternalJson,
    normalizePriceDocument,
    builtin: BUILTIN_PRICES
  }
}
