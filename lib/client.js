/**
 * dsh-toolbox — browser half.
 *
 * Four contributions, all of them driven by the Host half so the two can never
 * disagree about what a click means:
 *
 *  1. `shell.overlay` — the window-chrome icon buttons (restart, update check),
 *     anchored to the right of the frame's title bar so they sit against the
 *     system caption buttons, with the restart behind a two-step confirmation.
 *  2. `conversation.composer.dock` — the conversation's spend, next to the token
 *     pill the shell already draws there.
 *  3. `settings.general.item` — the send-key choice (Enter vs Ctrl+Enter), right
 *     after the shell's own composer-entry row.
 *  4. `settings.section` — the toolbox page: window buttons, update checking,
 *     send key, pricing and the optional companion tray.
 *
 * The send-key choice works by rewriting one keystroke, not by replacing the
 * composer: a capture-phase listener translates Enter into the Shift+Enter the
 * shell already treats as a newline, and Ctrl+Enter into the bare Enter it
 * already treats as a submit. Everything else — composition, popups, the busy
 * queue — stays the shell's behaviour.
 */

window.__ModuleLoader__.load({
  id: 'dsh-toolbox',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const reactDom = require('react-dom')
    const React = react.default ?? react
    const { createElement: h, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React

    /** Locale namespace owned by this plugin. */
    const NS = 'toolbox'

    /** Host route family mounted by the Node half. */
    const ROUTE = '/dsh-toolbox/api'

    /** Fallback title-bar height when the shell has not published its variable. */
    const FALLBACK_TITLEBAR_HEIGHT = 40

    /** Windows caption-button cluster width, used when the overlay metrics are unavailable. */
    const FALLBACK_CAPTION_WIDTH = 138

    // ── small utilities ───────────────────────────────────────────────────────

    /**
     * A minimal external store, so React reads plugin state through
     * `useSyncExternalStore` exactly as it reads the shell's own stores.
     * @param initial - the first snapshot.
     */
    function createStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        getSnapshot: () => value,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        set: (next) => {
          value = next
          for (const listener of [...listeners]) listener()
        },
        patch: (partial) => {
          value = { ...value, ...partial }
          for (const listener of [...listeners]) listener()
        }
      }
    }

    /**
     * Post one method to the plugin's host route family.
     * @param method - one of the Host half's ROUTE_KEYS.
     * @param payload - JSON body.
     * @returns the unwrapped response payload.
     */
    async function callApi(method, payload) {
      let response
      try {
        response = await fetch(`${ROUTE}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload ?? {})
        })
      } catch (error) {
        throw new Error(`无法连接宿主插件路由，请确认插件已随 Harness 启动。(${String(error?.message ?? error)})`)
      }
      let data
      try {
        data = await response.json()
      } catch {
        data = undefined
      }
      if (!response.ok || data?.ok !== true) {
        throw new Error(data?.error?.message ?? data?.error ?? `HTTP ${response.status}`)
      }
      return data
    }

    /** The Desktop product carrier, when this page runs inside the Desktop app. */
    function desktopCarrier() {
      const carrier = globalThis.dshDesktop
      return carrier?.protocolVersion === 1 ? carrier : undefined
    }

    /** Format a money amount with the currency's symbol and a useful precision. */
    function formatMoney(amount, currency) {
      const value = Number(amount)
      const safe = Number.isFinite(value) ? value : 0
      const symbol = currency === 'USD' ? '$' : '¥'
      const magnitude = Math.abs(safe)
      const digits = magnitude === 0 ? 3 : magnitude < 0.01 ? 4 : magnitude < 1 ? 3 : 2
      return `${symbol}${safe.toFixed(digits)}`
    }

    /** The other currency's rough equivalent, for the breakdown. */
    function otherCurrency(currency) {
      return currency === 'USD' ? 'CNY' : 'USD'
    }

    /** Format a token count compactly (1.2M) while the exact value stays in the panel. */
    function formatTokens(count, t) {
      const value = Number(count)
      if (!Number.isFinite(value) || value === 0) return '0'
      if (value < 1000) return String(Math.round(value))
      if (value < 1000000) return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)}K`
      return `${(value / 1000000).toFixed(2)}M`
    }

    /** Sum every billing bucket of one tokenUsage projection. */
    function usageTotal(usage) {
      if (usage === null || usage === undefined) return 0
      return (Number(usage.uncachedInputTokens) || 0)
        + (Number(usage.cacheReadTokens) || 0)
        + (Number(usage.cacheWriteTokens) || 0)
        + (Number(usage.outputTokens) || 0)
    }

    /** Quote one path for a `title` attribute. */
    function shortPath(path) {
      const text = typeof path === 'string' ? path : ''
      return text.length > 72 ? `…${text.slice(-69)}` : text
    }

    // ── icons ────────────────────────────────────────────────────────────────
    // Inline artwork keeps the buttons dependency-free; every glyph is drawn in
    // `currentColor` on a 24×24 grid so it reads at 14–16px inside the title bar.

    /** One stroked icon frame. */
    function Icon({ children, size = 16, className }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        className,
        'aria-hidden': true,
        focusable: false
      }, children)
    }

    /** Restart: a circular arrow, the conventional "start over" glyph. */
    function IconRestart(props) {
      return h(Icon, props,
        h('path', { d: 'M20.5 12a8.5 8.5 0 1 1-2.4-5.9' }),
        h('path', { d: 'M20.8 4.4v5.2h-5.2' }))
    }

    /** Update: an arrow into a tray, the conventional "download" glyph. */
    function IconUpdate(props) {
      return h(Icon, props,
        h('path', { d: 'M12 3.5v10.5' }),
        h('path', { d: 'M8 10.2 12 14.2l4-4' }),
        h('path', { d: 'M4.5 16.5v2A2 2 0 0 0 6.5 20.5h11a2 2 0 0 0 2-2v-2' }))
    }

    /** Up to date: a check, shown when a check found nothing newer. */
    function IconCheck(props) {
      return h(Icon, props, h('path', { d: 'M4.8 12.6 9.6 17.4 19.2 6.8' }))
    }

    /** Spend: a coin with the yuan/yen mark. */
    function IconCoin(props) {
      return h(Icon, props,
        h('circle', { cx: 12, cy: 12, r: 8.4 }),
        h('path', { d: 'M9.4 8.6 12 12.2l2.6-3.6' }),
        h('path', { d: 'M12 12.2v4.6' }),
        h('path', { d: 'M9.7 13.6h4.6M9.7 15.2h4.6' }))
    }

    /** Send key: a keyboard. */
    function IconKeyboard(props) {
      return h(Icon, props,
        h('rect', { x: 3, y: 6.5, width: 18, height: 11, rx: 2 }),
        h('path', { d: 'M7 10h.01M10.5 10h.01M14 10h.01M17 10h.01M7 13.5h.01M17 13.5h.01M9.5 13.5h5' }))
    }

    /** Warning: a triangle, used by the restart confirmation. */
    function IconWarning(props) {
      return h(Icon, props,
        h('path', { d: 'M10.3 3.9 2.6 17.4A1.6 1.6 0 0 0 4 19.8h16a1.6 1.6 0 0 0 1.4-2.4L13.7 3.9a1.6 1.6 0 0 0-2.8 0Z' }),
        h('path', { d: 'M12 9v4M12 16.2h.01' }))
    }

    // ── the plugin engine ────────────────────────────────────────────────────

    /**
     * One engine per plugin load: the shared snapshot, the API surface, and the
     * Desktop updater mirror. Every component reads the same store, so a save in
     * the settings page is visible in the title bar immediately.
     */
    const engine = {
      store: createStore({
        loaded: false,
        error: '',
        busy: '',
        snapshot: null,
        officialUpdate: null
      }),
      /** Last spend report per session, keyed by `sessionId\0tokenSignature`. */
      costCache: new Map(),

      /** Read the Host projection. */
      async load() {
        try {
          const data = await callApi('settings.get')
          engine.store.patch({ loaded: true, error: '', snapshot: data.settings })
          void engine.rearmTray(data.settings)
        } catch (error) {
          engine.store.patch({ loaded: true, error: String(error?.message ?? error) })
        }
      },

      /**
       * Persist a settings patch. The Host answers with the new projection, so a
       * normalised value (a clamped number, an unknown currency) is what the UI
       * then shows.
       */
      async save(patch) {
        engine.store.patch({ busy: 'settings' })
        try {
          const current = engine.store.getSnapshot().snapshot ?? {}
          const data = await callApi('settings.update', { settings: { ...current, ...patch } })
          engine.store.patch({ error: '', snapshot: data.settings, busy: '' })
          return data.settings
        } catch (error) {
          engine.store.patch({ busy: '', error: String(error?.message ?? error) })
          throw error
        }
      },

      /** Ask the Desktop feed whether something newer exists. */
      async checkUpdate() {
        engine.store.patch({ busy: 'update' })
        try {
          const data = await callApi('update.check')
          // Publish the answer into the shared snapshot, or the title-bar icon
          // would only turn green after the next full settings read.
          const snapshot = engine.store.getSnapshot().snapshot
          if (snapshot !== null && data.update !== undefined) {
            engine.store.patch({ snapshot: { ...snapshot, update: data.update } })
          }
          engine.store.patch({ busy: '' })
          return data.update
        } catch (error) {
          engine.store.patch({ busy: '', error: String(error?.message ?? error) })
          throw error
        }
      },

      /** Refresh the price table from its source. */
      async refreshPrices() {
        engine.store.patch({ busy: 'prices' })
        try {
          const data = await callApi('prices.refresh')
          engine.costCache.clear()
          await engine.load()
          engine.store.patch({ busy: '' })
          return data
        } catch (error) {
          engine.store.patch({ busy: '', error: String(error?.message ?? error) })
          throw error
        }
      },

      /** Arm a restart through the Host half. */
      async restart() {
        engine.store.patch({ busy: 'restart' })
        try {
          const port = Number.parseInt(String(globalThis.location?.port ?? ''), 10)
          const data = await callApi('restart', {
            confirm: true,
            ...Number.isSafeInteger(port) && port > 0 ? { port } : {}
          })
          return data.restart
        } finally {
          engine.store.patch({ busy: '' })
        }
      },

      /** The page locale, so the companion tray can label its own menu. */
      locale: () => 'zh',

      /** Start or stop the companion tray. */
      async setTray(enabled) {
        const data = await callApi('tray.set', {
          enabled,
          origin: globalThis.location?.origin ?? '',
          appUrl: globalThis.location?.href ?? '',
          locale: engine.locale()
        })
        engine.store.patch({ snapshot: data.settings })
        return data.tray
      },

      /**
       * A restarted Host loses the companion tray process, and a page reload
       * does not; asking again when the switch is on but nothing is running
       * keeps the two in step without a second process.
       */
      async rearmTray(snapshot) {
        if (snapshot?.tray?.enabled !== true) return
        if (snapshot?.trayStatus?.running === true) return
        try {
          await engine.setTray(true)
        } catch {
          /* the page reports the failure through the switch */
        }
      },

      /** Price one session, memoised by session and token watermark. */
      async cost(sessionId, signature) {
        const key = `${sessionId}\u0000${signature}`
        const cached = engine.costCache.get(key)
        if (cached !== undefined) return cached
        const data = await callApi('cost.session', { sessionId })
        engine.costCache.set(key, data.cost)
        while (engine.costCache.size > 24) {
          const oldest = engine.costCache.keys().next()
          if (oldest.done === true) break
          engine.costCache.delete(oldest.value)
        }
        return data.cost
      },

      /** Mirror the Electron updater's own state, which owns install actions. */
      setOfficialUpdate(state) {
        engine.store.patch({ officialUpdate: state ?? null })
      }
    }

    // ── an anchored panel ────────────────────────────────────────────────────

    /**
     * A `document.body` portal positioned under one anchor, closed on an outside
     * click, Escape or a window resize.
     *
     * Portalling keeps a panel out of the title bar's drag region and above every
     * column without depending on the anchor's stacking context — which matters
     * because the overlay layer deliberately sits below the shell's own dialogs.
     * @param open - whether the panel is showing.
     * @param anchorRef - the element the panel hangs from.
     * @param onClose - called when the panel should close.
     * @returns `{ target, position }`; the target is null while closed.
     */
    function useAnchoredPanel(open, anchorRef, onClose) {
      const [target, setTarget] = useState(null)
      const [position, setPosition] = useState(null)

      useEffect(() => {
        if (!open) {
          setTarget(null)
          setPosition(null)
          return undefined
        }
        const anchor = anchorRef.current
        if (anchor === null || anchor === undefined) return undefined
        const rect = anchor.getBoundingClientRect()
        setPosition({
          top: Math.round(rect.bottom + 6),
          right: Math.max(8, Math.round(window.innerWidth - rect.right))
        })

        const node = document.createElement('div')
        node.dataset.toolboxPanel = ''
        document.body.append(node)
        setTarget(node)

        const onPointerDown = (event) => {
          if (anchor.contains(event.target) || node.contains(event.target)) return
          onClose()
        }
        const onKey = (event) => {
          if (event.key === 'Escape') onClose()
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKey, true)
        window.addEventListener('resize', onClose)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKey, true)
          window.removeEventListener('resize', onClose)
          node.remove()
        }
      }, [open, anchorRef, onClose])

      return { target, position }
    }

    /** Render one anchored panel with the given body. */
    function AnchoredPanel({ open, anchorRef, onClose, children }) {
      const { target, position } = useAnchoredPanel(open, anchorRef, onClose)
      if (target === null || position === null) return null
      return reactDom.createPortal(
        h('div', {
          style: {
            ...styles.panelSurface,
            top: `${position.top}px`,
            right: `${position.right}px`
          }
        }, children),
        target
      )
    }

    // ── the window-chrome buttons ────────────────────────────────────────────

    /**
     * Measure the title-bar band the buttons ride in.
     * @returns `{ chrome, right, height }` in CSS pixels.
     */
    function measureTitlebar() {
      const root = document.documentElement
      const windowsTitlebar = root.hasAttribute('data-windows-titlebar')
      const declared = Number.parseFloat(getComputedStyle(root).getPropertyValue('--dsh-windows-titlebar-height'))
      const height = Number.isFinite(declared) && declared > 0 ? declared : FALLBACK_TITLEBAR_HEIGHT
      if (!windowsTitlebar) return { chrome: false, right: 8, height: 36 }
      const overlay = navigator.windowControlsOverlay
      if (overlay !== undefined && typeof overlay.getTitlebarAreaRect === 'function') {
        try {
          const rect = overlay.getTitlebarAreaRect()
          // `titlebarAreaRect` is the draggable region, so the caption buttons
          // occupy everything to its right — that offset is what makes the
          // buttons sit flush against them instead of guessing their width.
          const captionWidth = Math.max(0, Math.round(window.innerWidth - (rect.x + rect.width)))
          return { chrome: true, right: captionWidth > 0 ? captionWidth : FALLBACK_CAPTION_WIDTH, height }
        } catch {
          /* fall through to the known Windows caption width */
        }
      }
      return { chrome: true, right: FALLBACK_CAPTION_WIDTH, height }
    }

    /** Track the title-bar geometry, including a window resize or fullscreen change. */
    function useTitlebar() {
      const [placement, setPlacement] = useState(measureTitlebar)
      useEffect(() => {
        const remeasure = () => setPlacement(measureTitlebar())
        window.addEventListener('resize', remeasure)
        const overlay = navigator.windowControlsOverlay
        overlay?.addEventListener?.('geometrychange', remeasure)
        return () => {
          window.removeEventListener('resize', remeasure)
          overlay?.removeEventListener?.('geometrychange', remeasure)
        }
      }, [])
      return placement
    }

    /** One title-bar icon button. */
    function ChromeButton({ label, title, onClick, disabled, tone, children }) {
      const [hover, setHover] = useState(false)
      return h('button', {
        type: 'button',
        'aria-label': label,
        title,
        disabled: disabled === true,
        onClick,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        style: {
          ...styles.chromeButton,
          ...tone === 'available' ? styles.chromeButtonAvailable : {},
          ...hover && disabled !== true ? styles.chromeButtonHover : {},
          ...disabled === true ? styles.chromeButtonDisabled : {}
        }
      }, children)
    }

    /**
     * The restart and update buttons in the window chrome.
     *
     * Both act through the Host half; nothing is decided here beyond which
     * confirmation is owed and how the state reads.
     */
    function WindowActions(props) {
      const t = typeof props.t === 'function' ? props.t : key => key
      const state = useSyncExternalStore(engine.store.subscribe, engine.store.getSnapshot)
      const placement = useTitlebar()
      const snapshot = state.snapshot
      const [confirming, setConfirming] = useState(false)
      const [notice, setNotice] = useState('')
      const [checking, setChecking] = useState(false)
      const confirmRef = useRef(null)
      const closeConfirm = useCallback(() => setConfirming(false), [])

      const update = snapshot?.update ?? null
      const available = update?.available === true
      const official = state.officialUpdate

      // A fresh check that finds nothing newer is worth confirming, briefly.
      useEffect(() => {
        if (notice === '') return undefined
        const timer = setTimeout(() => setNotice(''), 4000)
        return () => clearTimeout(timer)
      }, [notice])

      if (snapshot === null) return null
      const buttons = snapshot.windowButtons ?? {}
      const carrier = desktopCarrier()
      if (buttons.restart !== true && buttons.updateCheck !== true) return null
      if (placement.chrome !== true && carrier === undefined && buttons.webFallback !== true) return null

      const restartBusy = state.busy === 'restart'
      const doRestart = async () => {
        setConfirming(false)
        try {
          const result = await engine.restart()
          setNotice(result?.ok === true ? t('window.restarting') : `${t('window.restartRefused')}${result?.error ?? ''}`)
        } catch (error) {
          setNotice(`${t('window.restartFailed')}${String(error?.message ?? error)}`)
        }
      }

      const onRestartClick = () => {
        if (snapshot.restartConfirm === true) setConfirming(true)
        else void doRestart()
      }

      const onUpdateClick = async () => {
        // When the shell already knows about a release its own dialog owns the
        // download and install, so the button hands over to it.
        if (available && carrier?.updates !== undefined) {
          try {
            await carrier.updates.open()
            return
          } catch {
            /* fall through to a plain re-check */
          }
        }
        setChecking(true)
        try {
          const next = await engine.checkUpdate()
          if (next?.available === true) setNotice('')
          else if (next?.status === 'ok') setNotice(t('window.upToDate'))
          else setNotice(`${t('window.checkFailed')}${next?.error ?? ''}`)
        } catch (error) {
          setNotice(`${t('window.checkFailed')}${String(error?.message ?? error)}`)
        } finally {
          setChecking(false)
        }
      }

      const versionLine = update === null || update.currentVersion === ''
        ? t('window.versionUnknown')
        : update.latestVersion === ''
          ? `${t('window.current')} ${update.currentVersion}`
          : `${t('window.current')} ${update.currentVersion} → ${t('window.latest')} ${update.latestVersion}`
      const updateTitle = available
        ? `${t('window.updateAvailable')}\n${versionLine}\n${t('window.updateHint')}`
        : `${t('window.checkUpdate')}\n${versionLine}`

      const items = []
      if (buttons.updateCheck === true) {
        items.push(h(ChromeButton, {
          key: 'update',
          label: available ? t('window.updateAvailable') : t('window.checkUpdate'),
          title: updateTitle,
          tone: available ? 'available' : 'plain',
          disabled: checking,
          onClick: () => { void onUpdateClick() }
        }, available
          ? h(IconUpdate, { size: 15 })
          : checking
            ? h(IconUpdate, { size: 15 })
            : h(IconCheck, { size: 15 })))
      }
      if (buttons.restart === true) {
        items.push(h(ChromeButton, {
          key: 'restart',
          label: t('window.restart'),
          title: `${t('window.restart')}\n${t('window.restartHint')}`,
          disabled: restartBusy,
          onClick: onRestartClick
        }, h(IconRestart, { size: 15 })))
      }

      return h('div', {
        style: {
          ...styles.chromeRoot,
          right: `${placement.right + 6}px`,
          height: `${placement.height}px`
        }
      },
      notice === '' ? null : h('span', { style: styles.chromeNotice }, notice),
      h('span', { ref: confirmRef, style: styles.chromeGroup }, ...items),
      h(AnchoredPanel, { open: confirming, anchorRef: confirmRef, onClose: closeConfirm },
        h('div', { style: styles.confirmTitle },
          h('span', { style: styles.confirmIcon }, h(IconWarning, { size: 15 })),
          t('window.confirmTitle')),
        h('div', { style: styles.confirmBody }, t('window.confirmBody')),
        h('div', { style: styles.confirmActions },
          h('button', { type: 'button', style: styles.buttonGhost, onClick: closeConfirm }, t('window.cancel')),
          h('button', { type: 'button', style: styles.buttonDanger, onClick: () => { void doRestart() } }, t('window.confirmRestart')))))
    }

    // ── conversation spend ───────────────────────────────────────────────────

    /** One `label / value` line inside the spend panel. */
    function DetailRow({ label, value, muted }) {
      return h('div', { style: styles.detailRow },
        h('span', { style: muted === true ? styles.detailLabelMuted : styles.detailLabel }, label),
        h('span', { style: styles.detailValue }, value))
    }

    /**
     * The conversation's spend, rendered in the composer dock beside the shell's
     * token pill. It refreshes whenever the token projection moves, which is the
     * same signal the token pill itself redraws on.
     */
    function CostPill(props) {
      const t = typeof props.t === 'function' ? props.t : key => key
      const sessionId = props.sessionId
      const useProjection = props.useProjection
      const state = useSyncExternalStore(engine.store.subscribe, engine.store.getSnapshot)
      const snapshot = state.snapshot
      const usage = typeof useProjection === 'function' ? useProjection('tokenUsage') : undefined
      const tokens = usageTotal(usage)
      const [report, setReport] = useState(null)
      const [failure, setFailure] = useState('')
      const [open, setOpen] = useState(false)
      const anchorRef = useRef(null)
      const close = useCallback(() => setOpen(false), [])

      const enabled = snapshot?.cost?.enabled === true && snapshot?.cost?.showInComposer === true
      const currency = snapshot?.cost?.currency ?? 'CNY'

      useEffect(() => {
        if (!enabled || sessionId === undefined || sessionId === '') return undefined
        let cancelled = false
        engine.cost(sessionId, `${tokens}`)
          .then((next) => {
            if (cancelled) return
            setReport(next)
            setFailure('')
          })
          .catch((error) => {
            if (cancelled) return
            setFailure(String(error?.message ?? error))
          })
        return () => { cancelled = true }
      }, [enabled, sessionId, tokens])

      if (snapshot === null || !enabled || sessionId === undefined || sessionId === '') return null
      // Nothing is shown until there is a priced report: a "calculating" pill
      // that never resolves (a session the Host no longer holds) is worse than
      // no pill, and a brand-new conversation has nothing to report yet.
      if (report === null || report.hasUsage !== true) return null

      const amount = report?.amount ?? 0
      const summary = report === null
        ? t('cost.title')
        : [
            `${t('cost.title')} ${formatMoney(amount, currency)}`,
            t('cost.formula'),
            report.unpricedTokens > 0 ? `${t('cost.unpriced')} ${formatTokens(report.unpricedTokens, t)}` : '',
            `${t('cost.priceSource')} ${report.priceLabel ?? ''}`.trim()
          ].filter(line => line !== '').join('\n')

      const panel = h('div', null,
        h('div', { style: styles.panelTitle },
          h('span', { style: styles.panelTitleIcon }, h(IconCoin, { size: 15 })),
          t('cost.title')),
        h('div', { style: styles.panelAmount }, formatMoney(amount, currency)),
        h('div', { style: styles.panelSubtitle }, report === null ? '' : `${t('cost.samples')} ${report.samples} · ${t('cost.tokens')} ${formatTokens(report.tokens, t)}`),
        report === null ? null : h('div', { style: styles.detailList },
          h(DetailRow, { label: t('cost.input'), value: formatTokens(report.buckets.uncachedInputTokens, t) }),
          h(DetailRow, { label: t('cost.cacheRead'), value: formatTokens(report.buckets.cacheReadTokens, t) }),
          report.buckets.cacheWriteTokens > 0
            ? h(DetailRow, { label: t('cost.cacheWrite'), value: formatTokens(report.buckets.cacheWriteTokens, t) })
            : null,
          h(DetailRow, { label: t('cost.output'), value: formatTokens(report.buckets.outputTokens, t) }),
          report.peakSamples > 0
            ? h(DetailRow, { label: t('cost.peakSamples'), value: `${report.peakSamples} / ${report.samples}` })
            : null),
        report === null || report.byModel.length === 0 ? null : h('div', { style: styles.detailList },
          h('div', { style: styles.detailHeading }, t('cost.byModel')),
          ...report.byModel.map(entry => h(DetailRow, {
            key: `${entry.provider}/${entry.model}`,
            label: entry.model,
            value: formatMoney(entry.amount, currency)
          }))),
        report === null || report.unpricedTokens === 0 ? null : h('div', { style: styles.noticeWarn },
          `${t('cost.unpriced')} ${formatTokens(report.unpricedTokens, t)}${report.unpricedModels.length > 0 ? `（${report.unpricedModels.join(', ')}）` : ''}`),
        failure === '' ? null : h('div', { style: styles.noticeBad }, `${t('cost.failed')}${failure}`),
        h('div', { style: styles.panelMeta },
          `${t('cost.priceSource')} ${report?.priceLabel ?? ''}`.trim(),
          h('br'),
          `${t('cost.priceUpdated')} ${report?.priceUpdatedAt === undefined ? '' : new Date(report.priceUpdatedAt).toLocaleString()}`))

      return h('span', { style: styles.costAnchor, ref: anchorRef },
        h('button', {
          type: 'button',
          style: { ...styles.pill, ...open ? styles.pillOpen : {} },
          title: summary,
          'aria-label': summary,
          onClick: () => setOpen(current => !current)
        },
        h(IconCoin, { size: 14 }),
        h('span', null, report === null ? t('cost.loading') : formatMoney(amount, currency))),
        h(AnchoredPanel, { open, anchorRef, onClose: close }, panel))
    }

    // ── the send-key guard ───────────────────────────────────────────────────

    /**
     * Translate one keystroke so Ctrl+Enter submits and Enter inserts a newline.
     *
     * The shell's composer already implements both: Shift+Enter inserts a
     * newline and a bare Enter submits. Rewriting the event and replaying it on
     * the editor therefore reuses the shell's own decision — popups, the busy
     * queue and composition all keep working — instead of reimplementing submit.
     * @param readMode - reads the live `sendKey` value.
     * @returns the disposer.
     */
    function installSendKeyGuard(readMode) {
      if (typeof document === 'undefined') return () => {}

      const replay = (element, modifiers) => {
        element.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          bubbles: true,
          cancelable: true,
          composed: true,
          // Spell out every modifier the shell's own handler reads, so the
          // replayed event is a faithful bare (or Shift+) Enter either way.
          ctrlKey: false,
          metaKey: false,
          shiftKey: false,
          altKey: false,
          ...modifiers
        }))
      }

      const handler = (event) => {
        if (readMode() !== 'ctrlEnter') return
        if (event.key !== 'Enter' || event.isComposing === true || event.keyCode === 229) return
        if (event.repeat === true) return
        const target = event.target
        if (!(target instanceof Element)) return
        const editor = target.closest('[contenteditable="true"]')
        if (editor === null) return
        // Only the composer's editor: the conversation is the one region the
        // shell marks as a composer seat, so other editors keep plain Enter.
        if (editor.closest('[data-composer-input], [data-composer-seat], [data-composer-card]') === null) return

        const accelerated = event.ctrlKey === true || event.metaKey === true
        if (accelerated && event.shiftKey !== true && event.altKey !== true) {
          event.preventDefault()
          event.stopImmediatePropagation()
          replay(editor, {})
          return
        }
        if (!accelerated && event.shiftKey !== true && event.altKey !== true) {
          event.preventDefault()
          event.stopImmediatePropagation()
          replay(editor, { shiftKey: true })
        }
      }

      document.addEventListener('keydown', handler, true)
      return () => document.removeEventListener('keydown', handler, true)
    }

    // ── the General-settings row ─────────────────────────────────────────────

    /** One half of the send-key choice. */
    function ChoiceButton({ active, label, hint, onClick }) {
      return h('button', {
        type: 'button',
        onClick,
        title: hint,
        style: { ...styles.choice, ...active ? styles.choiceActive : {} },
        'aria-pressed': active
      }, label)
    }

    /**
     * The send-key row inside the General settings section. It saves on click —
     * a single choice deserves immediate feedback — and it is the same value the
     * toolbox page shows.
     */
    function SendKeyRow(props) {
      const t = typeof props.t === 'function' ? props.t : key => key
      const state = useSyncExternalStore(engine.store.subscribe, engine.store.getSnapshot)
      const [failure, setFailure] = useState('')
      const sendKey = state.snapshot?.sendKey ?? 'enter'

      const choose = (next) => {
        if (next === sendKey) return
        setFailure('')
        engine.save({ sendKey: next }).catch(error => setFailure(String(error?.message ?? error)))
      }

      return h('div', { style: styles.generalRow },
        h('div', { style: styles.generalRowText },
          h('div', { style: styles.generalRowTitle }, t('sendKey.title')),
          h('div', { style: styles.generalRowHint }, t('sendKey.description')),
          failure === '' ? null : h('div', { style: styles.noticeBad }, failure)),
        h('div', { style: styles.choiceGroup },
          h(ChoiceButton, {
            active: sendKey === 'enter',
            label: t('sendKey.enter'),
            hint: t('sendKey.enterHint'),
            onClick: () => choose('enter')
          }),
          h(ChoiceButton, {
            active: sendKey === 'ctrlEnter',
            label: t('sendKey.ctrlEnter'),
            hint: t('sendKey.ctrlEnterHint'),
            onClick: () => choose('ctrlEnter')
          })))
    }

    // ── the settings page ────────────────────────────────────────────────────

    /** Read a nested settings value with a fallback. */
    function read(object, path, fallback) {
      let current = object
      for (const key of path.split('.')) {
        if (current === null || current === undefined || typeof current !== 'object') return fallback
        current = current[key]
      }
      return current === undefined ? fallback : current
    }

    /** Write a nested settings value into a cloned draft. */
    function write(draft, path, value) {
      const keys = path.split('.')
      const next = { ...draft }
      let cursor = next
      for (let index = 0; index < keys.length - 1; index += 1) {
        const key = keys[index]
        cursor[key] = { ...(cursor[key] ?? {}) }
        cursor = cursor[key]
      }
      cursor[keys[keys.length - 1]] = value
      return next
    }

    /** One labelled switch row. */
    function SwitchRow({ label, hint, checked, onChange, disabled }) {
      return h('label', { style: styles.switchRow },
        h('input', {
          type: 'checkbox',
          checked,
          disabled: disabled === true,
          onChange: event => onChange(event.target.checked)
        }),
        h('span', null,
          h('span', { style: styles.switchLabel }, label),
          hint === undefined || hint === '' ? null : h('span', { style: styles.switchHint }, hint)))
    }

    /** One labelled text or number input row. */
    function FieldRow({ label, hint, value, onChange, type = 'text', placeholder, disabled }) {
      return h('label', { style: styles.fieldRow },
        h('span', { style: styles.fieldLabel }, label),
        h('input', {
          type,
          value,
          placeholder: placeholder ?? '',
          disabled: disabled === true,
          style: styles.input,
          onChange: event => onChange(event.target.value)
        }),
        hint === undefined || hint === '' ? null : h('span', { style: styles.fieldHint }, hint))
    }

    /** One labelled select row. */
    function SelectRow({ label, hint, value, options, onChange }) {
      return h('label', { style: styles.fieldRow },
        h('span', { style: styles.fieldLabel }, label),
        h('select', { value, style: styles.select, onChange: event => onChange(event.target.value) },
          ...options.map(option => h('option', { key: option.value, value: option.value }, option.label))),
        hint === undefined || hint === '' ? null : h('span', { style: styles.fieldHint }, hint))
    }

    /**
     * The toolbox settings page.
     *
     * The page edits a draft and saves it whole, so a half-typed URL or a
     * transient number never reaches the Host document.
     */
    function SettingsSection(props) {
      const t = typeof props.t === 'function' ? props.t : key => key
      const state = useSyncExternalStore(engine.store.subscribe, engine.store.getSnapshot)
      const snapshot = state.snapshot
      const [draft, setDraft] = useState(null)
      const [message, setMessage] = useState(null)
      const [busy, setBusy] = useState('')
      const [restarting, setRestarting] = useState(false)

      useEffect(() => {
        if (snapshot !== null && draft === null) setDraft(JSON.parse(JSON.stringify({
          windowButtons: snapshot.windowButtons,
          restartConfirm: snapshot.restartConfirm,
          autoCheckUpdates: snapshot.autoCheckUpdates,
          updateCheckHours: snapshot.updateCheckHours,
          sendKey: snapshot.sendKey,
          cost: snapshot.cost,
          tray: snapshot.tray
        })))
      }, [snapshot, draft])

      if (state.loaded !== true) return h('div', { style: styles.muted }, t('loading'))
      if (snapshot === null) return h('div', { style: styles.noticeBad }, state.error)

      const model = draft ?? {
        windowButtons: snapshot.windowButtons,
        restartConfirm: snapshot.restartConfirm,
        autoCheckUpdates: snapshot.autoCheckUpdates,
        updateCheckHours: snapshot.updateCheckHours,
        sendKey: snapshot.sendKey,
        cost: snapshot.cost,
        tray: snapshot.tray
      }
      const set = (path, value) => setDraft(write(model, path, value))

      const save = async () => {
        setBusy('save')
        setMessage(null)
        try {
          await engine.save(model)
          setMessage({ kind: 'ok', text: t('saved') })
        } catch (error) {
          setMessage({ kind: 'bad', text: `${t('saveFailed')}${String(error?.message ?? error)}` })
        } finally {
          setBusy('')
        }
      }

      const applyTray = async (enabled) => {
        setBusy('tray')
        setMessage(null)
        try {
          const status = await engine.setTray(enabled)
          setDraft(null)
          if (enabled && status.running !== true) {
            setMessage({ kind: 'bad', text: `${t('tray.failed')}${status.error ?? ''}` })
          } else {
            setMessage({ kind: 'ok', text: enabled ? t('tray.started') : t('tray.stoppedNote') })
          }
        } catch (error) {
          setMessage({ kind: 'bad', text: `${t('tray.failed')}${String(error?.message ?? error)}` })
        } finally {
          setBusy('')
        }
      }

      const onRestart = async () => {
        setRestarting(true)
        setMessage(null)
        try {
          const result = await engine.restart()
          setMessage(result?.ok === true
            ? { kind: 'ok', text: t('restart.armed') }
            : { kind: 'bad', text: `${t('restart.refused')}${result?.error ?? ''}` })
        } catch (error) {
          setMessage({ kind: 'bad', text: `${t('restart.failed')}${String(error?.message ?? error)}` })
        } finally {
          setRestarting(false)
        }
      }

      const onCheck = async () => {
        setBusy('check')
        setMessage(null)
        try {
          const next = await engine.checkUpdate()
          setMessage(next?.status === 'ok'
            ? { kind: next.available === true ? 'ok' : 'muted', text: next.available === true ? t('update.available', { version: next.latestVersion }) : t('update.current') }
            : { kind: 'bad', text: `${t('update.failed')}${next?.error ?? ''}` })
        } catch (error) {
          setMessage({ kind: 'bad', text: `${t('update.failed')}${String(error?.message ?? error)}` })
        } finally {
          setBusy('')
        }
      }

      const onRefreshPrices = async () => {
        setBusy('prices')
        setMessage(null)
        try {
          const result = await engine.refreshPrices()
          setDraft(null)
          setMessage(result.error === ''
            ? { kind: 'ok', text: t('cost.refreshed') }
            : { kind: 'bad', text: `${t('cost.refreshFailed')}${result.error}` })
        } catch (error) {
          setMessage({ kind: 'bad', text: `${t('cost.refreshFailed')}${String(error?.message ?? error)}` })
        } finally {
          setBusy('')
        }
      }

      const update = snapshot.update ?? {}
      const prices = snapshot.prices ?? {}
      const trayStatus = snapshot.trayStatus ?? {}
      const carrier = desktopCarrier()

      return h('div', null,
        h('div', { style: styles.header },
          h('div', null,
            h('div', { style: styles.title }, t('title')),
            h('div', { style: styles.hint }, t('subtitle')))),
        state.error === '' ? null : h('div', { style: styles.noticeBad }, state.error),

        // Restart ────────────────────────────────────────────────────────────
        h('div', { style: styles.section },
          h('div', { style: styles.sectionTitle }, t('restart.title')),
          h('div', { style: styles.hint }, carrier === undefined
            ? t('restart.noDesktop')
            : `${t('restart.appPid')} ${snapshot.appPid} · ${shortPath(snapshot.exePath)}`),
          h('div', { style: styles.buttonRow },
            h('button', {
              type: 'button',
              style: styles.buttonPrimary,
              disabled: restarting || carrier === undefined,
              onClick: () => { void onRestart() }
            }, restarting ? t('restart.working') : t('restart.action')),
            h('span', { style: styles.hint }, t('restart.hint'))),
          h(SwitchRow, {
            label: t('restart.confirm'),
            hint: t('restart.confirmHint'),
            checked: model.restartConfirm === true,
            onChange: value => set('restartConfirm', value)
          })),

        // Window buttons ─────────────────────────────────────────────────────
        h('div', { style: styles.section },
          h('div', { style: styles.sectionTitle }, t('buttons.title')),
          h(SwitchRow, {
            label: t('buttons.restart'),
            hint: t('buttons.restartHint'),
            checked: read(model, 'windowButtons.restart', true) === true,
            onChange: value => set('windowButtons.restart', value)
          }),
          h(SwitchRow, {
            label: t('buttons.update'),
            hint: t('buttons.updateHint'),
            checked: read(model, 'windowButtons.updateCheck', true) === true,
            onChange: value => set('windowButtons.updateCheck', value)
          }),
          h(SwitchRow, {
            label: t('buttons.web'),
            hint: t('buttons.webHint'),
            checked: read(model, 'windowButtons.webFallback', false) === true,
            onChange: value => set('windowButtons.webFallback', value)
          })),

        // Updates ────────────────────────────────────────────────────────────
        h('div', { style: styles.section },
          h('div', { style: styles.sectionTitle }, t('update.title')),
          h('div', { style: styles.metaList },
            h('div', null, `${t('update.currentVersion')}: ${update.currentVersion === '' ? t('unknown') : update.currentVersion}`),
            h('div', null, `${t('update.latestVersion')}: ${update.latestVersion === '' ? t('unknown') : update.latestVersion}`),
            h('div', null, `${t('update.state')}: ${update.available === true ? t('update.availableShort') : t('update.current')}`),
            update.checkedAt ? h('div', null, `${t('update.checkedAt')}: ${new Date(update.checkedAt).toLocaleString()}`) : null,
            update.feedUrl ? h('div', { style: styles.mono }, `${t('update.feed')}: ${update.feedUrl}`) : null,
            update.error ? h('div', { style: styles.noticeWarn }, update.error) : null),
          h('div', { style: styles.buttonRow },
            h('button', {
              type: 'button',
              style: styles.buttonGhost,
              disabled: busy === 'check',
              onClick: () => { void onCheck() }
            }, busy === 'check' ? t('update.checking') : t('update.check')),
            update.available === true && carrier?.updates !== undefined
              ? h('button', {
                  type: 'button',
                  style: styles.buttonPrimary,
                  onClick: () => { void carrier.updates.open() }
                }, t('update.open'))
              : null),
          h(SwitchRow, {
            label: t('update.auto'),
            hint: t('update.autoHint'),
            checked: model.autoCheckUpdates === true,
            onChange: value => set('autoCheckUpdates', value)
          }),
          h(FieldRow, {
            label: t('update.hours'),
            hint: t('update.hoursHint'),
            type: 'number',
            value: String(model.updateCheckHours ?? 6),
            onChange: value => set('updateCheckHours', Number(value))
          })),

        // Send key ───────────────────────────────────────────────────────────
        h('div', { style: styles.section },
          h('div', { style: styles.sectionTitle }, t('sendKey.title')),
          h('div', { style: styles.hint }, t('sendKey.description')),
          h('div', { style: styles.choiceGroup },
            h(ChoiceButton, {
              active: model.sendKey === 'enter',
              label: t('sendKey.enter'),
              hint: t('sendKey.enterHint'),
              onClick: () => set('sendKey', 'enter')
            }),
            h(ChoiceButton, {
              active: model.sendKey === 'ctrlEnter',
              label: t('sendKey.ctrlEnter'),
              hint: t('sendKey.ctrlEnterHint'),
              onClick: () => set('sendKey', 'ctrlEnter')
            }))),

        // Cost ───────────────────────────────────────────────────────────────
        h('div', { style: styles.section },
          h('div', { style: styles.sectionTitle }, t('cost.section')),
          h(SwitchRow, {
            label: t('cost.enabled'),
            hint: t('cost.enabledHint'),
            checked: read(model, 'cost.enabled', true) === true,
            onChange: value => set('cost.enabled', value)
          }),
          h(SwitchRow, {
            label: t('cost.inComposer'),
            hint: t('cost.inComposerHint'),
            checked: read(model, 'cost.showInComposer', true) === true,
            onChange: value => set('cost.showInComposer', value)
          }),
          h(SelectRow, {
            label: t('cost.currency'),
            hint: t('cost.currencyHint'),
            value: read(model, 'cost.currency', 'CNY'),
            options: [
              { value: 'CNY', label: t('cost.cny') },
              { value: 'USD', label: t('cost.usd') }
            ],
            onChange: value => set('cost.currency', value)
          }),
          h(SelectRow, {
            label: t('cost.source'),
            hint: t('cost.sourceHint'),
            value: read(model, 'cost.pricingSource', 'auto'),
            options: [
              { value: 'auto', label: t('cost.sourceAuto') },
              { value: 'deepseek-docs', label: t('cost.sourceDocs') },
              { value: 'json', label: t('cost.sourceJson') },
              { value: 'builtin', label: t('cost.sourceBuiltin') }
            ],
            onChange: value => set('cost.pricingSource', value)
          }),
          read(model, 'cost.pricingSource', 'auto') === 'json'
            ? h(FieldRow, {
                label: t('cost.url'),
                hint: t('cost.urlHint'),
                value: read(model, 'cost.pricingUrl', ''),
                placeholder: 'https://…/prices.json',
                onChange: value => set('cost.pricingUrl', value)
              })
            : null,
          h(FieldRow, {
            label: t('cost.rate'),
            hint: t('cost.rateHint'),
            type: 'number',
            value: String(read(model, 'cost.usdCny', 7.1)),
            onChange: value => set('cost.usdCny', Number(value))
          }),
          h(SwitchRow, {
            label: t('cost.autoRefresh'),
            hint: t('cost.autoRefreshHint'),
            checked: read(model, 'cost.autoRefreshPrices', true) === true,
            onChange: value => set('cost.autoRefreshPrices', value)
          }),
          h('div', { style: styles.metaList },
            h('div', null, `${t('cost.tableSource')}: ${prices.label ?? ''}`),
            h('div', null, `${t('cost.tableUpdated')}: ${prices.updatedAt === undefined ? '' : new Date(prices.updatedAt).toLocaleString()}${prices.stale === true ? ` · ${t('cost.tableStale')}` : ''}`),
            h('div', null, `${t('cost.tableModels')}: ${(prices.models ?? []).join(', ')}`),
            prices.error ? h('div', { style: styles.noticeWarn }, prices.error) : null),
          h('div', { style: styles.buttonRow },
            h('button', {
              type: 'button',
              style: styles.buttonGhost,
              disabled: busy === 'prices',
              onClick: () => { void onRefreshPrices() }
            }, busy === 'prices' ? t('cost.refreshing') : t('cost.refresh'))),
          h('div', { style: styles.hint }, t('cost.note'))),

        // Tray ───────────────────────────────────────────────────────────────
        h('div', { style: styles.section },
          h('div', { style: styles.sectionTitle }, t('tray.title')),
          h('div', { style: styles.hint }, t('tray.description')),
          h(SwitchRow, {
            label: t('tray.enabled'),
            hint: trayStatus.supported === true ? t('tray.enabledHint') : t('tray.unsupported'),
            checked: model.tray?.enabled === true,
            disabled: trayStatus.supported !== true || busy === 'tray',
            onChange: value => { void applyTray(value) }
          }),
          h('div', { style: styles.metaList },
            h('div', null, `${t('tray.state')}: ${trayStatus.running === true ? t('tray.running') : t('tray.stopped')}`),
            trayStatus.pid ? h('div', null, `${t('tray.pid')}: ${trayStatus.pid}`) : null,
            trayStatus.error ? h('div', { style: styles.noticeWarn }, trayStatus.error) : null,
            trayStatus.logFile ? h('div', { style: styles.mono }, shortPath(trayStatus.logFile)) : null),
          h('div', { style: styles.hint }, t('tray.note'))),

        // Footer ─────────────────────────────────────────────────────────────
        h('div', { style: styles.footer },
          h('button', {
            type: 'button',
            style: styles.buttonPrimary,
            disabled: busy !== '',
            onClick: () => { void save() }
          }, busy === 'save' ? t('saving') : t('save')),
          h('button', {
            type: 'button',
            style: styles.buttonGhost,
            disabled: busy !== '',
            onClick: () => setDraft(null)
          }, t('reset')),
          message === null
            ? null
            : h('span', { style: message.kind === 'ok' ? styles.ok : message.kind === 'muted' ? styles.muted : styles.bad }, message.text)),

        h('div', { style: styles.metaList },
          h('div', null, `${t('meta.version')}: ${snapshot.pluginVersion ?? ''}`),
          h('div', null, `${t('meta.appVersion')}: ${snapshot.appVersion === '' ? t('unknown') : snapshot.appVersion}${snapshot.appVersionSource ? ` (${snapshot.appVersionSource})` : ''}`),
          h('div', null, `${t('meta.carrier')}: ${snapshot.desktop === true ? `Desktop · PID ${snapshot.appPid}` : 'web'}`),
          h('div', { style: styles.mono }, `${t('meta.settingsFile')}: ${shortPath(snapshot.settingsFile)}`),
          h('div', { style: styles.mono }, `${t('meta.pricesFile')}: ${shortPath(snapshot.pricesFile)}` ),
          h('div', { style: styles.mono }, `${t('meta.stateDir')}: ${shortPath(snapshot.stateDir)}`),
          h('div', null, `${t('meta.localTime')}: ${new Date().toLocaleString()}`)))
    }

    // ── styles ───────────────────────────────────────────────────────────────

    /** Theme-token styles with fallbacks, so a theme without them still renders. */
    const styles = {
      // window chrome
      chromeRoot: {
        position: 'absolute',
        top: 0,
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '0 2px',
        // The frame's title band is a drag region; the buttons must not be.
        WebkitAppRegion: 'no-drag'
      },
      chromeGroup: {
        display: 'flex',
        alignItems: 'center',
        gap: '2px',
        padding: '2px',
        borderRadius: '10px',
        background: 'var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.10))',
        border: '1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.22))'
      },
      chromeButton: {
        appearance: 'none',
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary, #C9CDD4)',
        width: '24px',
        height: '24px',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: '8px',
        cursor: 'pointer',
        padding: 0,
        lineHeight: 1
      },
      chromeButtonHover: { background: 'var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.18))', color: 'var(--dsw-alias-label-primary, #F2F4F7)' },
      chromeButtonAvailable: { color: 'var(--dsw-alias-state-success-primary, #34C08B)' },
      chromeButtonDisabled: { opacity: 0.45, cursor: 'default' },
      chromeNotice: {
        maxWidth: '240px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontSize: '11px',
        lineHeight: '16px',
        padding: '2px 8px',
        borderRadius: '999px',
        color: 'var(--dsw-alias-label-tertiary, #8A9199)',
        background: 'var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.10))'
      },
      // anchored panels
      panelSurface: {
        position: 'fixed',
        maxWidth: '340px',
        padding: '12px 14px',
        borderRadius: 'var(--dsw-radius-lg, 10px)',
        border: '1px solid var(--dsw-alias-border-l1, #3A3F47)',
        background: 'var(--dsw-alias-bg-layer-1, #1B1B1C)',
        color: 'var(--dsw-alias-label-primary, #F2F4F7)',
        boxShadow: 'var(--dsw-shadow-lg, 0 12px 32px rgba(0, 0, 0, 0.35))',
        fontSize: '12px',
        lineHeight: '18px',
        zIndex: 2147483000
      },
      confirmTitle: { display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600, fontSize: '13px', marginBottom: '6px' },
      confirmIcon: { display: 'inline-flex', color: 'var(--dsw-alias-state-warning-primary, #E8A33D)' },
      confirmBody: { color: 'var(--dsw-alias-label-secondary, #C9CDD4)', marginBottom: '10px' },
      confirmActions: { display: 'flex', justifyContent: 'flex-end', gap: '8px' },
      panelTitle: { display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600, fontSize: '13px' },
      panelTitleIcon: { display: 'inline-flex', color: 'var(--dsw-alias-label-secondary, #C9CDD4)' },
      panelAmount: { fontSize: '20px', fontWeight: 600, margin: '6px 0 2px' },
      panelSubtitle: { color: 'var(--dsw-alias-label-tertiary, #8A9199)', marginBottom: '8px' },
      panelMeta: { marginTop: '10px', paddingTop: '8px', borderTop: '1px solid var(--dsw-alias-border-l1, #3A3F47)', color: 'var(--dsw-alias-label-tertiary, #8A9199)', wordBreak: 'break-all' },
      detailList: { display: 'flex', flexDirection: 'column', gap: '2px', marginTop: '8px' },
      detailHeading: { color: 'var(--dsw-alias-label-tertiary, #8A9199)', marginTop: '2px' },
      detailRow: { display: 'flex', justifyContent: 'space-between', gap: '12px' },
      detailLabel: { color: 'var(--dsw-alias-label-secondary, #C9CDD4)' },
      detailLabelMuted: { color: 'var(--dsw-alias-label-tertiary, #8A9199)' },
      detailValue: { fontVariantNumeric: 'tabular-nums' },
      noticeWarn: { marginTop: '6px', color: 'var(--dsw-alias-state-warning-primary, #E8A33D)' },
      noticeBad: { marginTop: '6px', color: 'var(--dsw-alias-state-error-primary, #F0616D)', wordBreak: 'break-all' },
      // composer pill
      costAnchor: { display: 'inline-flex' },
      pill: {
        appearance: 'none',
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary, #C9CDD4)',
        font: 'inherit',
        fontSize: '12px',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        padding: '2px 6px',
        borderRadius: '999px',
        cursor: 'pointer'
      },
      pillOpen: { background: 'var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.18))' },
      // settings page
      header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', marginBottom: '6px' },
      title: { fontSize: '14px', fontWeight: 600, color: 'var(--dsw-alias-label-primary, #F2F4F7)' },
      subtitle: { marginTop: '4px', fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary, #8A9199)' },
      section: { marginTop: '16px', paddingTop: '12px', borderTop: '1px solid var(--dsw-alias-border-l1, #3A3F47)' },
      sectionTitle: { fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-primary, #F2F4F7)', marginBottom: '8px' },
      hint: { marginTop: '4px', fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary, #8A9199)' },
      muted: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, #8A9199)' },
      ok: { fontSize: '12px', color: 'var(--dsw-alias-state-success-primary, #34C08B)' },
      bad: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary, #F0616D)', wordBreak: 'break-all' },
      switchRow: { display: 'flex', alignItems: 'flex-start', gap: '8px', marginTop: '8px', cursor: 'pointer' },
      switchLabel: { display: 'block', fontSize: '13px', color: 'var(--dsw-alias-label-primary, #F2F4F7)' },
      switchHint: { display: 'block', fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary, #8A9199)' },
      fieldRow: { display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '10px' },
      fieldLabel: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #C9CDD4)' },
      fieldHint: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary, #8A9199)' },
      input: {
        padding: '5px 8px',
        fontSize: '12px',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        border: '1px solid var(--dsw-alias-border-l1, #3A3F47)',
        background: 'var(--dsw-alias-bg-layer-2, transparent)',
        color: 'var(--dsw-alias-label-primary, #F2F4F7)'
      },
      select: {
        padding: '5px 8px',
        fontSize: '12px',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        border: '1px solid var(--dsw-alias-border-l1, #3A3F47)',
        background: 'var(--dsw-alias-bg-layer-2, transparent)',
        color: 'var(--dsw-alias-label-primary, #F2F4F7)'
      },
      choiceGroup: { display: 'inline-flex', gap: '6px', marginTop: '8px' },
      choice: {
        appearance: 'none',
        border: '1px solid var(--dsw-alias-border-l1, #3A3F47)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary, #C9CDD4)',
        font: 'inherit',
        fontSize: '12px',
        padding: '5px 12px',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        cursor: 'pointer'
      },
      choiceActive: {
        borderColor: 'var(--dsw-alias-brand-primary, #4C8DFF)',
        background: 'var(--dsw-alias-brand-primary, #4C8DFF)',
        color: '#0E1116',
        fontWeight: 600
      },
      generalRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', paddingTop: '8px', flexWrap: 'wrap' },
      generalRowText: { minWidth: '0', flex: '1 1 240px' },
      generalRowTitle: { fontSize: '13px', color: 'var(--dsw-alias-label-primary, #F2F4F7)' },
      generalRowHint: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary, #8A9199)' },
      buttonRow: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '10px', flexWrap: 'wrap' },
      buttonPrimary: {
        appearance: 'none',
        border: 'none',
        background: 'var(--dsw-alias-brand-primary, #4C8DFF)',
        color: '#0E1116',
        font: 'inherit',
        fontSize: '12px',
        fontWeight: 600,
        padding: '6px 14px',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        cursor: 'pointer'
      },
      buttonGhost: {
        appearance: 'none',
        border: '1px solid var(--dsw-alias-border-l1, #3A3F47)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary, #C9CDD4)',
        font: 'inherit',
        fontSize: '12px',
        padding: '5px 12px',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        cursor: 'pointer'
      },
      buttonDanger: {
        appearance: 'none',
        border: 'none',
        background: 'var(--dsw-alias-state-error-primary, #F0616D)',
        color: '#0E1116',
        font: 'inherit',
        fontSize: '12px',
        fontWeight: 600,
        padding: '6px 14px',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        cursor: 'pointer'
      },
      footer: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '16px', flexWrap: 'wrap' },
      metaList: { marginTop: '10px', fontSize: '12px', lineHeight: '19px', color: 'var(--dsw-alias-label-tertiary, #8A9199)', wordBreak: 'break-all' },
      mono: { fontFamily: 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)' }
    }

    // ── copy ─────────────────────────────────────────────────────────────────

    const zh = {
      nav: '自用工具库',
      title: '自用工具库',
      subtitle: '重启 DSH、检查桌面端更新、选择发送键、显示本对话消费金额。',
      loading: '正在读取设置…',
      save: '保存',
      saving: '保存中…',
      saved: '已保存，立即生效。',
      reset: '放弃修改',
      saveFailed: '保存失败：',
      unknown: '未知',

      'window.restart': '重启 DeepSeek Harness',
      'window.restartHint': '更新插件后重启即可生效。',
      'window.restarting': '正在重启…',
      'window.restartRefused': '重启未执行：',
      'window.restartFailed': '重启失败：',
      'window.checkUpdate': '检查更新',
      'window.updateAvailable': '有新版本可用',
      'window.updateHint': '点击打开官方更新流程。',
      'window.upToDate': '已是最新版本。',
      'window.checkFailed': '检查更新失败：',
      'window.current': '当前',
      'window.latest': '最新',
      'window.versionUnknown': '版本未知',
      'window.confirmTitle': '确认重启？',
      'window.confirmBody': '将结束当前 DSH 进程并重新启动。进行中的对话与后台任务会被中断，会话记录会在退出前落盘。',
      'window.cancel': '取消',
      'window.confirmRestart': '重启',

      'restart.title': '重启 DSH',
      'restart.action': '立即重启',
      'restart.working': '正在重启…',
      'restart.armed': '已安排重启，DSH 即将退出并重新启动。',
      'restart.refused': '重启未执行：',
      'restart.failed': '重启失败：',
      'restart.hint': '先启动重启助手，确认就绪后再退出当前进程，因此不会出现“关掉起不来”。',
      'restart.confirm': '点击重启时二次确认',
      'restart.confirmHint': '标题栏按钮即使关闭确认也仍然需要点击一次。',
      'restart.noDesktop': '当前不是 DSH 桌面端进程（例如 dsh web），无法自动重启。',
      'restart.appPid': '应用进程',

      'buttons.title': '标题栏按钮',
      'buttons.restart': '显示重启图标',
      'buttons.restartHint': '显示在窗口标题栏右侧、系统最小化/最大化/关闭按钮左边。',
      'buttons.update': '显示检查更新图标',
      'buttons.updateHint': '有更新时图标变绿。',
      'buttons.web': '在浏览器中也显示',
      'buttons.webHint': '默认只在 DSH 桌面端显示，纯网页端不占用界面。',

      'update.title': '桌面端更新',
      'update.currentVersion': '当前版本',
      'update.latestVersion': '最新版本',
      'update.state': '状态',
      'update.availableShort': '有新版本',
      'update.current': '已是最新',
      'update.available': '发现新版本 {version}，点击“打开官方更新”安装。',
      'update.checkedAt': '上次检查',
      'update.feed': '更新源',
      'update.check': '立即检查',
      'update.checking': '检查中…',
      'update.open': '打开官方更新',
      'update.failed': '检查失败：',
      'update.auto': '后台自动检查',
      'update.autoHint': '按下面的间隔静默检查，有新版本时标题栏图标变绿。',
      'update.hours': '检查间隔（小时）',
      'update.hoursHint': '默认 6 小时。',

      'sendKey.title': '发送键',
      'sendKey.description': '选择用什么按键发送消息；切换后立即生效。',
      'sendKey.enter': '回车发送',
      'sendKey.enterHint': 'Enter 发送，Shift+Enter 换行（DSH 默认）。',
      'sendKey.ctrlEnter': 'Ctrl+回车发送',
      'sendKey.ctrlEnterHint': 'Enter 换行，Ctrl+Enter（macOS 为 ⌘+Enter）发送。',

      'cost.section': '消费金额',
      'cost.title': '本对话消费',
      'cost.loading': '计算中…',
      'cost.current': '本对话消费',
      'cost.formula': '按官方标价、缓存命中/未命中分别计价，并区分高峰/空闲时段。',
      'cost.unpriced': '未定价 token',
      'cost.priceSource': '价格来源',
      'cost.priceUpdated': '价格更新时间',
      'cost.samples': '计费样本',
      'cost.tokens': 'Token 合计',
      'cost.input': '输入（缓存未命中）',
      'cost.cacheRead': '输入（缓存命中）',
      'cost.cacheWrite': '缓存写入',
      'cost.output': '输出',
      'cost.peakSamples': '高峰时段样本',
      'cost.byModel': '按模型',
      'cost.failed': '计算失败：',
      'cost.enabled': '启用消费金额',
      'cost.enabledHint': '在对话输入框下方显示本对话的消费金额。',
      'cost.inComposer': '显示在输入框下方',
      'cost.inComposerHint': '与 token 用量并排显示。',
      'cost.currency': '显示货币',
      'cost.currencyHint': '官方同时公布人民币与美元标价。',
      'cost.cny': '人民币 ¥',
      'cost.usd': '美元 $',
      'cost.source': '计价来源',
      'cost.sourceHint': '“自动”会抓取 DeepSeek 官方价格页，失败时回退到插件内置价格。',
      'cost.sourceAuto': '自动（官方页面）',
      'cost.sourceDocs': '仅官方页面',
      'cost.sourceJson': '自定义 JSON 地址',
      'cost.sourceBuiltin': '仅内置价格（离线）',
      'cost.url': 'JSON 计价地址',
      'cost.urlHint': '支持插件格式，或 {模型: {cacheHit, cacheMiss, output}} 的简单格式（每百万 token）。',
      'cost.rate': '美元兑人民币汇率',
      'cost.rateHint': '仅当某个模型缺少对应货币标价时用于换算。',
      'cost.autoRefresh': '自动刷新价格',
      'cost.autoRefreshHint': '价格过期时在后台抓取一次官方价格页。',
      'cost.refresh': '刷新价格',
      'cost.refreshing': '刷新中…',
      'cost.refreshed': '价格已更新。',
      'cost.refreshFailed': '刷新失败：',
      'cost.tableSource': '当前价格表',
      'cost.tableUpdated': '价格表时间',
      'cost.tableStale': '已过期',
      'cost.tableModels': '已定价模型',
      'cost.note': '高峰时段为 UTC 周一至周五 01:00–04:00 与 06:00–10:00，其余时间按半价（空闲时段）计费；中国法定节假日无法自动识别。缓存写入按缓存未命中价格计费。',

      'tray.title': '托盘小程序',
      'tray.description': 'DSH 自带托盘菜单由 Electron 外壳拥有，插件无法往里加菜单项；开启后由本插件提供一个并排的小图标，提供同样的重启与检查更新。',
      'tray.enabled': '开启托盘小程序',
      'tray.enabledHint': '随 DSH 启动，DSH 退出时自动消失。',
      'tray.unsupported': '仅 Windows 支持。',
      'tray.state': '状态',
      'tray.running': '运行中',
      'tray.stopped': '未运行',
      'tray.pid': '进程号',
      'tray.started': '托盘小程序已启动。',
      'tray.stoppedNote': '托盘小程序已关闭。',
      'tray.failed': '托盘小程序启动失败：',
      'tray.note': '左键双击打开 DSH，右键菜单包含重启与检查更新。',

      'meta.version': '插件版本',
      'meta.appVersion': 'DSH 版本',
      'meta.carrier': '运行环境',
      'meta.settingsFile': '设置文件',
      'meta.pricesFile': '价格缓存',
      'meta.stateDir': '状态目录',
      'meta.localTime': '本机时间'
    }

    const en = {
      nav: 'Personal toolbox',
      title: 'Personal toolbox',
      subtitle: 'Restart DSH, check for Desktop updates, choose the send key, and show what this conversation cost.',
      loading: 'Reading settings…',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved; it applies immediately.',
      reset: 'Discard changes',
      saveFailed: 'Save failed: ',
      unknown: 'unknown',

      'window.restart': 'Restart DeepSeek Harness',
      'window.restartHint': 'Reloads plugins and the Host.',
      'window.restarting': 'Restarting…',
      'window.restartRefused': 'Restart not started: ',
      'window.restartFailed': 'Restart failed: ',
      'window.checkUpdate': 'Check for updates',
      'window.updateAvailable': 'Update available',
      'window.updateHint': 'Click to open the official update flow.',
      'window.upToDate': 'Already up to date.',
      'window.checkFailed': 'Update check failed: ',
      'window.current': 'current',
      'window.latest': 'latest',
      'window.versionUnknown': 'version unknown',
      'window.confirmTitle': 'Restart now?',
      'window.confirmBody': 'This ends the running DSH process and starts it again. Work in progress is interrupted; session logs are flushed before exit.',
      'window.cancel': 'Cancel',
      'window.confirmRestart': 'Restart',

      'restart.title': 'Restart DSH',
      'restart.action': 'Restart now',
      'restart.working': 'Restarting…',
      'restart.armed': 'Restart armed; DSH is about to exit and start again.',
      'restart.refused': 'Restart not started: ',
      'restart.failed': 'Restart failed: ',
      'restart.hint': 'The relaunch helper is started first and must report ready before this process exits, so DSH never stops without something waiting to start it.',
      'restart.confirm': 'Ask before restarting',
      'restart.confirmHint': 'The title-bar button always requires one click.',
      'restart.noDesktop': 'This is not a DSH Desktop process (for example dsh web), so it cannot restart itself.',
      'restart.appPid': 'Application process',

      'buttons.title': 'Title-bar buttons',
      'buttons.restart': 'Show the restart icon',
      'buttons.restartHint': 'Rendered in the window title bar, left of the system minimize/maximize/close buttons.',
      'buttons.update': 'Show the update-check icon',
      'buttons.updateHint': 'Turns green when an update is available.',
      'buttons.web': 'Show them in a browser too',
      'buttons.webHint': 'Off by default: a plain web client keeps its chrome untouched.',

      'update.title': 'Desktop updates',
      'update.currentVersion': 'Installed',
      'update.latestVersion': 'Latest',
      'update.state': 'State',
      'update.availableShort': 'update available',
      'update.current': 'up to date',
      'update.available': 'Version {version} is available; use “Open the official update”.',
      'update.checkedAt': 'Last checked',
      'update.feed': 'Feed',
      'update.check': 'Check now',
      'update.checking': 'Checking…',
      'update.open': 'Open the official update',
      'update.failed': 'Check failed: ',
      'update.auto': 'Check in the background',
      'update.autoHint': 'Silently checks at the interval below and turns the title-bar icon green.',
      'update.hours': 'Interval (hours)',
      'update.hoursHint': 'Six hours by default.',

      'sendKey.title': 'Send key',
      'sendKey.description': 'Which keystroke submits a message. The change applies immediately.',
      'sendKey.enter': 'Enter sends',
      'sendKey.enterHint': 'Enter sends, Shift+Enter inserts a newline (the DSH default).',
      'sendKey.ctrlEnter': 'Ctrl+Enter sends',
      'sendKey.ctrlEnterHint': 'Enter inserts a newline; Ctrl+Enter (⌘+Enter on macOS) sends.',

      'cost.section': 'Spend',
      'cost.title': 'Conversation spend',
      'cost.loading': 'Calculating…',
      'cost.current': 'Conversation spend',
      'cost.formula': 'Priced from the official list, cache hits and misses separately, at the hour each sample was reported.',
      'cost.unpriced': 'Unpriced tokens',
      'cost.priceSource': 'Price source',
      'cost.priceUpdated': 'Prices updated',
      'cost.samples': 'Billed samples',
      'cost.tokens': 'Tokens',
      'cost.input': 'Input (cache miss)',
      'cost.cacheRead': 'Input (cache hit)',
      'cost.cacheWrite': 'Cache write',
      'cost.output': 'Output',
      'cost.peakSamples': 'Peak-hour samples',
      'cost.byModel': 'By model',
      'cost.failed': 'Could not price this session: ',
      'cost.enabled': 'Show the conversation spend',
      'cost.enabledHint': 'Adds the amount under the composer, next to the token pill.',
      'cost.inComposer': 'Show under the composer',
      'cost.inComposerHint': 'Rendered beside the shell’s own token usage.',
      'cost.currency': 'Display currency',
      'cost.currencyHint': 'DeepSeek publishes both a CNY and a USD list.',
      'cost.cny': 'CNY ¥',
      'cost.usd': 'USD $',
      'cost.source': 'Price source',
      'cost.sourceHint': '“Automatic” reads DeepSeek’s published table and falls back to the shipped one.',
      'cost.sourceAuto': 'Automatic (official page)',
      'cost.sourceDocs': 'Official page only',
      'cost.sourceJson': 'Custom JSON URL',
      'cost.sourceBuiltin': 'Shipped table only (offline)',
      'cost.url': 'JSON price URL',
      'cost.urlHint': 'Accepts this plugin’s document, or a plain {model: {cacheHit, cacheMiss, output}} map per 1M tokens.',
      'cost.rate': 'USD→CNY rate',
      'cost.rateHint': 'Only used when a model has no table in the display currency.',
      'cost.autoRefresh': 'Refresh prices automatically',
      'cost.autoRefreshHint': 'Fetches the official table in the background once it is stale.',
      'cost.refresh': 'Refresh prices',
      'cost.refreshing': 'Refreshing…',
      'cost.refreshed': 'Prices updated.',
      'cost.refreshFailed': 'Refresh failed: ',
      'cost.tableSource': 'Current table',
      'cost.tableUpdated': 'Table updated',
      'cost.tableStale': 'stale',
      'cost.tableModels': 'Priced models',
      'cost.note': 'Peak hours are 01:00–04:00 and 06:00–10:00 UTC, Monday to Friday; every other hour is billed at half price. Chinese public holidays are not detected. Cache writes are billed at the cache-miss rate.',

      'tray.title': 'Companion tray icon',
      'tray.description': 'DSH’s own tray menu is owned by the Electron shell and cannot be extended by a plugin. Enabling this runs a small companion icon beside it with the same restart and update actions.',
      'tray.enabled': 'Enable the companion tray',
      'tray.enabledHint': 'Starts with DSH and disappears when DSH exits.',
      'tray.unsupported': 'Windows only.',
      'tray.state': 'State',
      'tray.running': 'running',
      'tray.stopped': 'stopped',
      'tray.pid': 'Process',
      'tray.started': 'Companion tray started.',
      'tray.stoppedNote': 'Companion tray stopped.',
      'tray.failed': 'Could not start the companion tray: ',
      'tray.note': 'Double-click opens DSH; the context menu has restart and update check.',

      'meta.version': 'Plugin version',
      'meta.appVersion': 'DSH version',
      'meta.carrier': 'Runtime',
      'meta.settingsFile': 'Settings file',
      'meta.pricesFile': 'Price cache',
      'meta.stateDir': 'State directory',
      'meta.localTime': 'Local time'
    }

    /** Cordis services this browser half needs. */
    const inject = ['slots', 'locale']

    /**
     * Mount the browser half.
     * @param ctx - the Cordis browser context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'toolbox: dictionaries')

      // The companion tray runs outside the page, so it is told which language
      // to label its menu in rather than reading the document.
      engine.locale = () => {
        try {
          return ctx.locale.getSnapshot?.().locale ?? ctx.locale.getLocale?.().locale ?? 'zh'
        } catch {
          return 'zh'
        }
      }

      // The Desktop updater owns download and install; this half only mirrors its
      // state so the title-bar button can hand over to it.
      ctx.effect(() => {
        const carrier = desktopCarrier()
        if (carrier?.updates === undefined) return () => {}
        let disposed = false
        const publish = (state) => {
          if (!disposed) engine.setOfficialUpdate(state)
        }
        const unsubscribe = typeof carrier.updates.subscribe === 'function' ? carrier.updates.subscribe(publish) : () => {}
        if (typeof carrier.updates.status === 'function') {
          Promise.resolve(carrier.updates.status()).then(publish).catch(() => {})
        }
        return () => {
          disposed = true
          unsubscribe()
        }
      }, 'toolbox: desktop update mirror')

      ctx.effect(() => {
        void engine.load()
        return () => {}
      }, 'toolbox: settings load')

      ctx.effect(
        () => installSendKeyGuard(() => engine.store.getSnapshot().snapshot?.sendKey ?? 'enter'),
        'toolbox: send-key guard'
      )

      ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'toolbox.window-actions',
        order: 20,
        locale: NS
      }, WindowActions)), 'toolbox: window buttons')

      ctx.effect(() => ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
        name: 'conversation.composer.dock',
        id: 'toolbox.cost',
        order: 5,
        locale: NS
      }, CostPill)), 'toolbox: conversation spend')

      ctx.effect(() => ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item',
        id: 'toolbox-send-key',
        order: 21,
        locale: NS
      }, SendKeyRow)), 'toolbox: general send-key row')

      ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-toolbox',
        order: 250,
        label: () => t('nav'),
        locale: NS
      }, SettingsSection)), 'toolbox: settings page')
    }

    exports.NS = NS
    exports.apply = apply
    exports.inject = inject
    exports.__internals = {
      createStore,
      formatMoney,
      formatTokens,
      usageTotal,
      installSendKeyGuard,
      measureTitlebar,
      WindowActions,
      CostPill,
      SendKeyRow,
      SettingsSection,
      engine,
      zh,
      en
    }

    return module.exports
  }
})
