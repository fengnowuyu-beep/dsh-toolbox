/**
 * dsh-toolbox — Host half.
 *
 * One plugin, one settings document, and three jobs:
 *
 *  1. **Restart.** {@link module:dsh-toolbox/restart} explains why a restart is
 *     a detached helper plus a deliberate exit of the Desktop application
 *     process, and why the exit only happens once the helper is live.
 *  2. **Update check.** The installed version is read from the installation
 *     itself and compared against the same feed electron-updater was
 *     configured with, so the answer matches what the shipped updater would do.
 *  3. **Window and tray control** — start-up maximizing, and the optional
 *     companion tray icon that can show/hide, restart, open settings or quit.
 *
 * The browser half drives all of it through one POST-only route family; this
 * half owns every decision (what a restart means, what a version comparison
 * says) so the two halves cannot disagree.
 *
 * The per-conversation spend readout lives in its own plugin (dsh-cost).
 *
 * @module dsh-toolbox
 */

import { readFileSync } from 'node:fs'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { checkForUpdate, readAppVersion, resolveInstallPaths } from './appinfo.js'
import { armQuit, armRestart, describeCarrier } from './restart.js'
import {
  composeSettings,
  loadPersisted,
  logsDir,
  normalizeSettings,
  publicSettings,
  resolveDshHome,
  savePersisted,
  settingsPath,
  stateDir
} from './settings.js'
import {
  TITLE_DEFAULT_MAX_INPUT_BYTES,
  TITLE_MAX_INPUT_BYTES,
  TITLE_MAX_OUTPUT_TOKENS,
  TITLE_MIN_INPUT_BYTES,
  TITLE_PROVIDER,
  generateSessionTitle,
  normalizeTitle,
  readTurnOutline,
  resolveRoute,
  selectTitleMessages,
  selectTitleTurns
} from './title.js'
import { createTrayCompanion } from './tray.js'
import { maximizeWindow, windowControlSupported } from './window.js'

/** Cordis services this Host half needs before it can mount its routes. */
export const inject = ['webServer']

/** The plugin's own root, used for the scripts and assets it ships. */
const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * The plugin's own version, surfaced to the settings page for support. Read from
 * the manifest instead of being duplicated, so the two cannot drift apart.
 */
export const PLUGIN_VERSION = readOwnVersion()

/** @returns the manifest version, or '0.0.0' when it cannot be read. */
function readOwnVersion() {
  try {
    const manifest = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8'))
    return typeof manifest?.version === 'string' && manifest.version !== '' ? manifest.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** Route family mounted on the Host webserver. */
export const ROUTE_PREFIX = '/dsh-toolbox/api'

/** Route methods the browser half (or the tray companion) may call. */
const ROUTE_KEYS = Object.freeze([
  'settings.get',
  'settings.update',
  'restart',
  'quit',
  'window.maximize',
  'update.check',
  'title.generate',
  'tray.set',
  'page.request',
  'page.report',
  'status'
])

/** Bounded body size for these small JSON requests. */
const BODY_LIMIT = 256_000

/**
 * Clamp a configured KiB value onto the input-byte budget.
 *
 * The settings schema already bounds it; this is the second line of defence so
 * a hand-edited `settings.json` can never make one click cost real money.
 *
 * @param maxInputKb - the configured value, in KiB.
 * @returns a byte budget inside `[TITLE_MIN_INPUT_BYTES, TITLE_MAX_INPUT_BYTES]`.
 */
function clampTitleBudget(maxInputKb) {
  const kib = Number(maxInputKb)
  if (!Number.isFinite(kib) || kib <= 0) return TITLE_DEFAULT_MAX_INPUT_BYTES
  const bytes = Math.round(kib * 1024)
  return Math.min(TITLE_MAX_INPUT_BYTES, Math.max(TITLE_MIN_INPUT_BYTES, bytes))
}

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

/**
 * The http origin this request arrived on, or '' when it cannot be told.
 *
 * The page cannot report this itself: in the Desktop app its own origin is
 * `dsh-app://app`, and Windows PowerShell cannot send a request to that scheme at
 * all ("unrecognized URI prefix"). The request's `Host` header is the server-side
 * truth, and the loopback fence has already rejected anything else by then.
 *
 * @param request - the incoming request.
 * @returns `http://host[:port]`, or '' when the header is unusable.
 */
function httpOriginFromRequest(request) {
  const host = request?.headers?.host
  if (typeof host !== 'string') return ''
  const trimmed = host.trim()
  if (trimmed === '') return ''
  return /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/iu.test(trimmed) ? `http://${trimmed}` : ''
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
    /** Last restart attempt, for the settings page. */
    this.lastRestart = { at: 0, ok: false, detail: '', error: '' }
    /** Last quit attempt, for the settings page and the tray report. */
    this.lastQuit = { at: 0, ok: false, detail: '', error: '' }
    /** Last window-maximize attempt. */
    this.lastWindow = { at: 0, ok: false, mode: '', error: '' }
    /**
     * Open responses of GUI pages, so the tray can ask a page to do something
     * only a page can do — opening DSH's own settings panel, for instance.
     */
    this.pageStreams = new Set()
    /** The last answer a page gave to such a request, for support. */
    this.lastPageAction = { at: 0, action: '', ok: false, via: '', error: '' }
    /** One check at a time. */
    this.updateCheck = undefined
    /** In-flight title generations, so an unload can cancel them. */
    this.titleCalls = new Set()
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
      restart: {
        // The carrier alone decides whether a restart is possible: the installed
        // version is a separate fact and must not gate the button.
        supported: carrier.desktop,
        mode: carrier.desktop ? 'relaunch' : 'unsupported',
        appPid: carrier.appPid,
        exePath: carrier.exePath,
        last: this.lastRestart
      },
      quit: {
        supported: carrier.desktop,
        appPid: carrier.appPid,
        last: this.lastQuit
      },
      window: {
        supported: windowControlSupported(carrier),
        startMaximized: this.settings.startWindow.maximized,
        logFile: join(logsDir(this.dshHome), 'window.log'),
        last: this.lastWindow
      },
      page: {
        streams: this.pageStreams.size,
        last: this.lastPageAction
      },
      // The tray and cost keys are suffixed so they cannot shadow the settings
      // objects of the same name in the merged projection the page reads.
      trayStatus: { ...this.tray.status(), error: this.trayError || this.tray.status().error }
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

  /** Merge a settings patch, persist it, and make it the live document. */
  async update(patch) {
    const requested = patch !== null && typeof patch === 'object' ? patch : {}
    const merged = {}
    for (const key of Object.keys(this.settings)) {
      merged[key] = requested[key] !== undefined ? requested[key] : this.settings[key]
    }
    const next = normalizeSettings(merged)
    this.persisted = next
    await savePersisted(next, this.dshHome)
    this.settings = composeSettings(this.persisted, this.config)
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
  sessionsService() {
    try {
      return this.ctx?.get?.('sessions')
    } catch {
      return undefined
    }
  }

  /**
   * Resolve one live session and the context that owns its services.
   *
   * The Typert agent lookup comes first because it resumes a persisted session
   * that this process has never loaded — the common case when the user
   * right-clicks an old conversation. `sessions` is the fallback, and it only
   * knows what is already live.
   *
   * @param sessionId - the session to rename.
   * @returns `{ session, context }`.
   * @throws {HttpError} 404 when the session cannot be found, 409 when it exists
   *   but is not live in this process.
   */
  async resolveSession(sessionId) {
    const id = typeof sessionId === 'string' ? sessionId : ''
    if (id === '' || id.length > 512) throw new HttpError(400, 'bad-request', '缺少 sessionId')
    let lookup
    try {
      lookup = this.ctx?.get?.('typert')?.lookups?.get?.('agent')
    } catch {
      lookup = undefined
    }
    if (lookup !== undefined && typeof lookup.resolve === 'function') {
      let agent
      try {
        agent = await lookup.resolve(id)
      } catch (error) {
        this.logger?.debug?.(`toolbox: agent lookup failed for ${id}: ${String(error)}`)
      }
      if (agent?.session !== undefined && agent.ctx !== undefined) {
        const sessions = agent.ctx.get?.('sessions')
        if (sessions?.get?.(id) === agent.session) return { session: agent.session, context: agent.ctx }
        throw new HttpError(409, 'not-live', '该会话已经不在本进程中运行了')
      }
    }
    const sessions = this.sessionsService()
    const session = sessions?.get?.(id)
    if (session === undefined) throw new HttpError(404, 'not-found', `找不到会话 ${id}`)
    return { session, context: this.ctx }
  }

  /**
   * Regenerate one session's title from its own model route.
   *
   * Everything expensive happens in {@link module:dsh-toolbox/title}: this
   * method only owns the ordering guarantees. The title is read *before* the
   * model call and compared *after* it, so a manual rename (or a second click)
   * during generation wins instead of being silently overwritten — the same
   * race the session-title service protects its own refreshes with.
   *
   * @param options - `{ sessionId }`.
   * @returns `{ ok, reason, title?, model?, messageSeqs?, inputBytes?, usage? }`.
   */
  async generateTitle(options = {}) {
    const settings = this.settings.title ?? {}
    if (settings.enabled === false) {
      return { ok: false, reason: 'disabled', error: 'AI 重命名已在设置中关闭' }
    }
    const { session, context } = await this.resolveSession(options.sessionId)
    const budget = clampTitleBudget(settings.maxInputKb)
    // DSH's own turn outline is preferred over reading the log directly: it is
    // already a bounded table of contents for the whole conversation (one human
    // prompt plus one assistant response per turn, injected context and tool
    // results excluded), so the same budget buys twenty-five turns of coverage
    // instead of three raw messages. When the projection is not mounted — or its
    // state is not the shape this build expects — the log is read directly, and
    // the outcome is identical to what this feature did before the outline
    // existed.
    const outline = readTurnOutline(context.get?.('sessionProjections'), session)
    const selection = outline.length > 0 ? selectTitleTurns(outline, budget) : undefined
    const messages = selection === undefined
      ? selectTitleMessages(session.snapshotEvents?.() ?? [], budget)
      : []
    // Selecting before reaching for the title service keeps the cheapest refusal
    // cheapest: a conversation with nothing human in it needs no service, no
    // model, and no tokens to say so.
    if (selection === undefined && messages.length === 0) {
      return { ok: false, reason: 'no-messages', error: '这个会话里还没有可用于生成标题的人类文字消息' }
    }
    if (selection !== undefined && selection.entries.length === 0) {
      return { ok: false, reason: 'no-messages', error: '这个会话的大纲里没有可用于生成标题的轮次' }
    }
    const titles = context.get?.('sessionTitle')
    if (titles === undefined || typeof titles.rename !== 'function') {
      throw new HttpError(503, 'service-unavailable', 'sessionTitle 服务不可用，无法写入标题')
    }
    const route = resolveRoute(context, session)
    if (route === undefined) {
      return { ok: false, reason: 'model-unavailable', error: '无法确定该会话使用的模型' }
    }
    const before = titles.get?.(session)?.eventSeq
    const controller = new AbortController()
    this.titleCalls.add(controller)
    const signal = options.signal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, options.signal])
    try {
      const result = await generateSessionTitle({
        llm: context.get?.('llm'),
        session,
        route,
        input: selection === undefined
          ? { source: 'messages', messages }
          : { source: 'outline', selection },
        signal,
        maxOutputTokens: TITLE_MAX_OUTPUT_TOKENS,
        maxTitleBytes: 80
      })
      // Re-check before writing: a rename or a second request during generation
      // must not be overwritten by this older answer.
      if ((titles.get?.(session)?.eventSeq ?? undefined) !== before) {
        return { ok: false, reason: 'superseded', error: '生成期间标题已被改动，结果已丢弃' }
      }
      const title = this.decorateTitle(result.title, settings.prefix)
      const accepted = titles.rename(session, title)
      const usage = result.usage ?? {}
      await this.audit({
        event: 'title-generate',
        ok: true,
        sessionId: session.id,
        provider: result.model.provider,
        model: result.model.model,
        // How much of the conversation the request could see, and by which rule:
        // this is the only way to answer "is 4 KiB enough?" from real data
        // instead of from an estimate.
        source: selection === undefined ? 'messages' : 'outline',
        // Which reasoning effort the auxiliary call actually ran under: "was
        // thinking really off?" is the first question any title failure asks,
        // and the adapter default is not visible anywhere else in this log.
        reasoningEffort: result.reasoningEffort ?? '',
        maxOutputTokens: result.maxTokens,
        strategy: result.outline?.strategy ?? '',
        totalTurns: result.outline?.totalTurns ?? 0,
        sampledTurns: result.outline?.sampled ?? 0,
        withResponses: result.outline?.withResponses ?? true,
        inputBytes: result.inputBytes,
        messages: result.messageSeqs.length,
        inputTokens: Number(usage.inputTokens) || 0,
        outputTokens: Number(usage.outputTokens) || 0,
        cacheReadTokens: Number(usage.cacheReadTokens) || 0,
        title
      })
      return {
        ok: true,
        title: accepted.title,
        source: { kind: 'user', provider: TITLE_PROVIDER, model: `${result.model.provider}/${result.model.model}` },
        messageSeqs: result.messageSeqs,
        ...result.outline === undefined ? {} : { outline: result.outline },
        inputBytes: result.inputBytes,
        usage
      }
    } finally {
      this.titleCalls.delete(controller)
    }
  }

  /** Apply the optional configured prefix, keeping the result inside the byte cap. */
  decorateTitle(title, prefix) {
    const marker = typeof prefix === 'string' ? prefix.trim() : ''
    if (marker === '') return title
    return normalizeTitle(`${marker} ${title}`, 80)
  }

  /** Cancel every in-flight title request (plugin unload). */
  abortTitles() {
    for (const controller of this.titleCalls) {
      try {
        controller.abort(new Error('toolbox unloaded'))
      } catch {
        /* an already-aborted controller is fine */
      }
    }
    this.titleCalls.clear()
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
  async audit(entry) {    try {
      const file = join(logsDir(this.dshHome), 'toolbox.log')
      await mkdir(dirname(file), { recursive: true })
      await appendFile(file, `${JSON.stringify({ at: new Date(this.now()).toISOString(), ...entry })}\n`, 'utf8')
    } catch {
      /* auditing never fails a request */
    }
  }

  /**
   * Hold one GUI page's event stream open.
   *
   * Some requests can only be carried out by a page — opening DSH's own settings
   * panel needs the page's own services and DOM — so the tray asks through here
   * instead of pretending the Host can do it.
   *
   * @param response - the open Server-Sent-Events response.
   * @returns a detach function.
   */
  attachPageStream(response) {
    this.pageStreams.add(response)
    return () => {
      this.pageStreams.delete(response)
    }
  }

  /**
   * Push one request to every connected page.
   * @param action - the action name, e.g. `settings`.
   * @returns how many pages received it.
   */
  broadcastPage(action) {
    const payload = `event: page\ndata: ${JSON.stringify({ action, at: this.now() })}\n\n`
    let delivered = 0
    for (const response of this.pageStreams) {
      try {
        response.write(payload)
        delivered += 1
      } catch {
        this.pageStreams.delete(response)
      }
    }
    return delivered
  }

  /**
   * Record what a page reported after such a request.
   * @param report - `{ action, ok, via, error }` from the page.
   */
  recordPageAction(report) {
    this.lastPageAction = {
      at: this.now(),
      action: typeof report?.action === 'string' ? report.action : '',
      ok: report?.ok === true,
      via: typeof report?.via === 'string' ? report.via : '',
      error: typeof report?.error === 'string' ? report.error : ''
    }
    void this.audit({ event: 'page-action', ...this.lastPageAction })
    return this.lastPageAction
  }

  /**
   * Maximize the Desktop window, through the OS.
   * @param options - whether this came from the start-up setting.
   * @returns the attempt outcome.
   */
  async maximizeWindow(options = {}) {
    const { carrier } = this.facts()
    const result = await maximizeWindow({
      pluginRoot: this.pluginRoot,
      dshHome: this.dshHome,
      logger: this.logger,
      carrier
    })
    this.lastWindow = { at: this.now(), ok: result.ok === true, mode: result.mode ?? '', error: result.error ?? '' }
    if (result.ok !== true) {
      this.logger?.warn?.(`toolbox: could not maximize the window: ${String(result.error)}`)
    } else if (options.fromStartup === true) {
      this.logger?.info?.('toolbox: window maximized at start-up')
    }
    return result
  }

  /**
   * End the Desktop application without relaunching it.
   * @param options - the confirmation flag.
   * @returns the outcome.
   */
  async quit(options = {}) {
    if (options.confirm !== true) {
      const refused = { ok: false, mode: 'refused', error: '关闭需要显式确认（confirm: true）' }
      this.lastQuit = { at: this.now(), ok: false, detail: '', error: refused.error }
      return refused
    }
    const { carrier } = this.facts()
    const result = await armQuit({ carrier, logger: this.logger })
    this.lastQuit = { at: this.now(), ok: result.ok === true, detail: result.detail ?? '', error: result.error ?? '' }
    return result
  }

  /** Wire the background jobs. */
  start() {
    if (this.settings.autoCheckUpdates) {
      void this.checkUpdate().catch(() => {})
    }

    // Start-up window state. The maximize helper waits for a visible window, so
    // this runs in the background and never delays the Host's own boot.
    if (this.settings.startWindow.maximized) {
      void this.maximizeWindow({ fromStartup: true }).catch(error => {
        this.logger?.warn?.(`toolbox: start-up maximize failed: ${String(error)}`)
      })
    }
  }

  /** Release every owned resource. */
  dispose() {
    this.abortTitles()
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
  const toolbox = new Toolbox({ logger, config, pluginRoot: PLUGIN_ROOT })
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
      const pathname = new URL(request.url ?? '/', 'http://dsh.internal').pathname
      const method = pathname.startsWith(`${ROUTE_PREFIX}/`)
        ? pathname.slice(ROUTE_PREFIX.length + 1)
        : undefined

      // The one non-POST route: the page keeps an event stream open so the tray
      // can ask it to do what only a page can do.
      if (method === 'events') {
        if (request.method !== 'GET') {
          writeJson(response, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
          return
        }
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          // Fenced to this origin, and this proxy-style header keeps anything in
          // between from buffering the stream.
          'x-accel-buffering': 'no'
        })
        response.write(': connected\n\n')
        const detach = toolbox.attachPageStream(response)
        request.on('close', detach)
        response.on('close', detach)
        return
      }

      if (request.method !== 'POST') {
        writeJson(response, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
        return
      }
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
          case 'quit': {
            // The response is written first and the application is ended from a
            // short timer, so the caller (the tray) gets its confirmation.
            const result = await toolbox.quit({ confirm: payload?.confirm === true })
            void toolbox.audit({ event: 'quit', ok: result.ok === true, mode: result.mode, error: result.error ?? '' })
            writeJson(response, 200, { ok: result.ok === true, quit: result, error: result.ok === true ? '' : result.error })
            return
          }
          case 'window.maximize': {
            const result = await toolbox.maximizeWindow({ fromStartup: false })
            void toolbox.audit({ event: 'maximize', ok: result.ok === true, mode: result.mode, error: result.error ?? '' })
            writeJson(response, 200, { ok: true, window: toolbox.describe().window, result, error: result.error ?? '' })
            return
          }
          case 'page.request': {
            // Something only a page can do (opening DSH's own settings panel).
            // The tray cannot reach the page itself, so it asks here and every
            // open page is told.
            const action = typeof payload?.action === 'string' ? payload.action : ''
            if (action === '') {
              writeJson(response, 400, { ok: false, error: { code: 'bad-request', message: 'action is required' } })
              return
            }
            const delivered = toolbox.broadcastPage(action)
            void toolbox.audit({ event: 'page-request', action, delivered })
            writeJson(response, 200, { ok: true, action, delivered })
            return
          }
          case 'page.report': {
            // The page says what happened when it tried, which is the only way
            // anyone can tell whether the settings panel really opened.
            const record = toolbox.recordPageAction(payload)
            writeJson(response, 200, { ok: true, page: toolbox.describe().page, record })
            return
          }
          case 'update.check': {
            const update = await toolbox.checkUpdate()
            void toolbox.audit({ event: 'update-check', status: update.status, latest: update.latestVersion })
            writeJson(response, 200, { ok: true, update })
            return
          }
          case 'title.generate': {
            // One click in the session menu. The reply is structured rather than
            // thrown for the "nothing to summarize" cases, because those are
            // normal outcomes the menu shows inline — only real transport or
            // upstream failures become an HTTP error.
            try {
              const result = await toolbox.generateTitle({ sessionId: payload?.sessionId })
              if (result.ok !== true) {
                void toolbox.audit({
                  event: 'title-generate',
                  ok: false,
                  sessionId: typeof payload?.sessionId === 'string' ? payload.sessionId : null,
                  reason: result.reason,
                  error: result.error
                })
              }
              writeJson(response, 200, result)
            } catch (error) {
              const reason = error instanceof HttpError ? error.code : 'failed'
              void toolbox.audit({
                event: 'title-generate',
                ok: false,
                sessionId: typeof payload?.sessionId === 'string' ? payload.sessionId : null,
                reason,
                error: String(error?.message ?? error)
              })
              throw error
            }
            return
          }
          case 'tray.set': {
            const enabled = payload?.enabled === true
            await toolbox.update({ ...toolbox.settings, tray: { enabled } })
            let status = toolbox.setTray(enabled, {
              // The real http address, taken from this request rather than from
              // the page's own origin: the Desktop page lives on `dsh-app://app`,
              // which PowerShell cannot call at all.
              apiOrigin: httpOriginFromRequest(request),
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
  const toolbox = new Toolbox({ logger: ctx?.logger ?? console, config: {}, pluginRoot: PLUGIN_ROOT })
  return {
    version: PLUGIN_VERSION,
    stateDir: stateDir(toolbox.dshHome),
    settingsFile: settingsPath(toolbox.dshHome),
    describe: () => toolbox.describe(),
    checkUpdate: () => toolbox.checkUpdate(),
    generateTitle: options => toolbox.generateTitle(options)
  }
}
