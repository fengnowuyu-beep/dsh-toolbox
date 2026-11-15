/**
 * dsh-toolbox — browser half.
 *
 * Four contributions, all of them driven by the Host half so the two can never
 * disagree about what a click means:
 *
 *  1. `shell.overlay` — the window-chrome icon buttons (settings, restart,
 *     update check), anchored to the right of the frame's title bar so they sit
 *     against the system caption buttons, with the restart behind a two-step
 *     confirmation.
 *  2. `settings.general.item` — the send-key choice (Enter vs Ctrl+Enter), right
 *     after the shell's own composer-entry row.
 *  3. `sidebar.workspaces.session.menu.item` — "rename with AI" in a Session
 *     row's own context menu: the Host regenerates the title from the messages
 *     that describe the conversation, so this half only shows the outcome.
 *  4. `settings.section` — the toolbox page: window buttons, update checking,
 *     send key, session titles and the optional companion tray.
 *
 * The conversation-spend pill used to live here too; it is its own plugin
 * (`dsh-cost`) now, with its own route family and settings page.
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

    /**
     * The shell's own menu primitives. Using them — rather than a plain button
     * with hand-written styles — is what makes this row look like the rename
     * and archive rows beside it, including their hover, focus and disabled
     * states, and keeps it correct in both themes for free.
     *
     * The loader hands this package to every Module Loader package as an
     * implicit baseline external, which is why it is reached through `require`
     * and never named in `inject`: an `inject` entry is a Cordis *service*, and
     * a package name there waits forever for a provider nobody can supply,
     * failing the whole web boot. The guard keeps a build without the package
     * loadable — both call sites below already fall back to the plugin's own row.
     */
    let primitives
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch {
      primitives = undefined
    }

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
    async function callApi(method, payload) {      let response
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

    /** Settings: a gear. */
    function IconGear(props) {
      return h(Icon, props,
        h('circle', { cx: 12, cy: 12, r: 3.1 }),
        h('path', { d: 'M12 3.2v2.1M12 18.7v2.1M4.8 7.6l1.8 1.1M17.4 15.3l1.8 1.1M4.8 16.4l1.8-1.1M17.4 8.7l1.8-1.1' }),
        h('circle', { cx: 12, cy: 12, r: 8.2 }))
    }

    // ── opening DSH's own settings page ──────────────────────────────────────

    /**
     * The shell's settings panel, as the shell itself marks it. The marker is a
     * stable attribute (not a hashed CSS-module class), which is why the panel
     * can be looked for at all.
     */
    const SETTINGS_MODAL_SELECTOR = '[data-shortcut-modal]'

    /** The command the shell's own Settings trigger and Ctrl+, both run. */
    const SETTINGS_COMMAND_ID = 'settings.open'

    /** How long a strategy may take to show its effect before the next is tried. */
    const SETTINGS_ATTEMPT_MS = 300

    /** Marks this plugin's own DOM, so it never mistakes itself for the shell. */
    const OWN_ROOT_ATTRIBUTE = 'data-dsh-toolbox-root'

    /**
     * Whether the settings panel is on screen right now.
     *
     * Two independent signals, because either can be the only one available: the
     * panel's own marker, and the `aria-expanded` the shell's trigger sets on
     * itself. Getting this wrong is not harmless — the shell's command *toggles*,
     * so a panel that opened but looked closed would be closed again by the next
     * strategy.
     *
     * @param trigger - the shell's trigger button, when one was found.
     * @returns true when the shell's own settings dialog is present.
     */
    function settingsPanelOpen(trigger) {
      try {
        if (document.querySelector(SETTINGS_MODAL_SELECTOR) !== null) return true
        const expanded = trigger ?? document.querySelector('button[aria-expanded][aria-haspopup="dialog"]')
        return expanded !== null && expanded !== undefined && expanded.getAttribute('aria-expanded') === 'true'
      } catch {
        return false
      }
    }

    /** Wait one rendering turn (short, but long enough for React to commit). */
    function settle(milliseconds) {
      return new Promise(resolve => { setTimeout(resolve, milliseconds) })
    }

    /** A session id short enough for a panel row, for a subagent with no title. */
    function shortSessionId(sessionId) {
      const id = String(sessionId ?? '')
      return id.length > 8 ? id.slice(0, 8) : id
    }

    /** Whether one element belongs to this plugin's own DOM. */
    function insideOwnRoot(element) {
      return typeof element?.closest === 'function' && element.closest(`[${OWN_ROOT_ATTRIBUTE}]`) !== null
    }

    /**
     * The plain Settings trigger the shell's own source describes.
     *
     * It renders as `<button aria-label={t('trigger')}>` for the
     * `settings.launcher` seat's *fallback* — so it only exists when nothing
     * occupies that seat. Kept because that is a legitimate deployment.
     *
     * @param label - the shell's own name for the trigger.
     * @returns the trigger button, or null.
     */
    function findPlainSettingsTrigger(label) {
      if (label === '') return null
      let buttons = []
      try {
        buttons = Array.from(document.querySelectorAll('button'))
      } catch {
        return null
      }
      for (const button of buttons) {
        if (insideOwnRoot(button)) continue
        if (button.getAttribute?.('aria-label') === label) return button
      }
      return null
    }

    /**
     * The sidebar-foot control that leads to the settings panel.
     *
     * This deployment occupies `settings.launcher` with the account menu, so the
     * plain trigger button is NOT in the DOM at all: the foot is a
     * `button[aria-haspopup="menu"]` whose first menu item calls
     * `openSettings()`. Nothing but the census could have told us that — a search
     * for a button labelled "设置" finds nothing, and no error is raised anywhere.
     *
     * @returns the trigger button, or null.
     */
    function findAccountMenuTrigger() {
      const selectors = [
        'button[aria-haspopup="menu"][data-signed-out]',
        'button[aria-haspopup="menu"][data-collapsed]',
        'button[aria-haspopup="menu"][aria-expanded]'
      ]
      for (const selector of selectors) {
        let found = []
        try {
          found = Array.from(document.querySelectorAll(selector))
        } catch {
          continue
        }
        for (const button of found) {
          if (!insideOwnRoot(button)) return button
        }
      }
      return null
    }

    /**
     * The settings entry of an open menu.
     * @param labels - names to look for; the shell's own label comes first.
     * @returns the menu item, or null when the menu is not open.
     */
    function findSettingsMenuItem(labels) {
      let items = []
      try {
        items = Array.from(document.querySelectorAll('[role="menuitem"]')).filter(item => !insideOwnRoot(item))
      } catch {
        return null
      }
      if (items.length === 0) return null
      const wanted = labels
        .filter(label => typeof label === 'string' && label.trim() !== '')
        .map(label => label.trim().toLowerCase())
      const named = items.find((item) => {
        const text = String(item.textContent ?? '').trim().toLowerCase()
        return wanted.some(label => text.startsWith(label) || text.includes(label))
      })
      // The settings entry is the menu's FIRST item; the ones after it are
      // "contact us", "sign in" and "sign out". Only used when the wording does
      // not match, i.e. when this build names it differently.
      return named ?? items[0]
    }

    /**
     * What the page can see, for a report nobody can act on otherwise.
     *
     * When the panel will not open, the useful question is "what is actually in
     * this DOM?" — which the user cannot answer and this plugin can. It is
     * bounded on purpose: it travels through a projection meant for humans.
     *
     * @param ctx - the client plugin context.
     * @returns one line of facts.
     */
    function domCensus(ctx) {
      const parts = []
      try {
        const label = typeof ctx?.locale?.bind === 'function' ? ctx.locale.bind('settings')('trigger') : '(no locale service)'
        parts.push(`label=${JSON.stringify(label)}`)
      } catch (error) {
        parts.push(`label threw: ${String(error?.message ?? error)}`)
      }
      try {
        const all = Array.from(document.querySelectorAll('button'))
        const outside = all.filter(button => !(typeof button.closest === 'function' && button.closest(`[${OWN_ROOT_ATTRIBUTE}]`) !== null))
        parts.push(`buttons=${all.length} outsideOwn=${outside.length}`)
        parts.push(outside.slice(0, 8).map((button, index) => {
          const attrs = ['aria-label', 'aria-haspopup', 'aria-expanded', 'aria-keyshortcuts', 'title']
            .map(name => {
              const value = button.getAttribute?.(name)
              return value === null || value === undefined || value === '' ? '' : `${name}=${value}`
            })
            .filter(part => part !== '')
            .join(' ')
          const text = String(button.textContent ?? '').trim().slice(0, 12)
          return `#${index}{${attrs}${text === '' ? '' : ` text=${text}`}}`
        }).join(' '))
        parts.push(`modalMarkers=${document.querySelectorAll(SETTINGS_MODAL_SELECTOR).length}`)
        parts.push(`ownRoots=${document.querySelectorAll(`[${OWN_ROOT_ATTRIBUTE}]`).length}`)
        parts.push(`dialogButtons=${all.filter(button => button.getAttribute?.('aria-haspopup') === 'dialog').length}`)
      } catch (error) {
        parts.push(`census failed: ${String(error?.message ?? error)}`)
      }
      return parts.join(' | ').slice(0, 1800)
    }

    /**
     * Open DSH's own settings page.
     *
     * There is no service that opens it and no seat this plugin may occupy, so
     * three DOM strategies are tried in order, each *checked* before the next:
     *
     *   1. the sidebar foot's account menu — click its trigger, then its settings
     *      item (this is what THIS deployment renders, see `findAccountMenuTrigger`);
     *   2. a plain trigger button carrying the shell's own label, for a build
     *      whose `settings.launcher` seat is free;
     *   3. the shell's command (`settings.open`), if the shortcut service is
     *      reachable — it is not for a dynamic client plugin here.
     *
     * A replayed `Ctrl+,` is deliberately NOT tried: the Desktop build drives
     * shortcuts through its native keyboard bridge, so a synthetic key event does
     * nothing except, on a panel the shell already opened, close it again.
     *
     * @param ctx - the client plugin context.
     * @returns `{ ok, via, attempts }` — `via` names the strategy that worked.
     */
    async function openSettingsPanel(ctx) {
      const attempts = []
      if (settingsPanelOpen()) return { ok: true, via: 'already-open', attempts }

      let label = ''
      try {
        label = typeof ctx?.locale?.bind === 'function' ? ctx.locale.bind('settings')('trigger') : ''
      } catch {
        label = ''
      }
      // A key-shaped answer means the shell published no such name.
      const names = label === '' || label === 'trigger' ? [] : [label]

      /** Whether the account menu is currently rendered. */
      const menuOpen = () => {
        try {
          return Array.from(document.querySelectorAll('[role="menuitem"]')).some(item => !insideOwnRoot(item))
        } catch {
          return false
        }
      }

      const strategies = [
        ['sidebar-menu', async () => {
          if (!menuOpen()) {
            const trigger = findAccountMenuTrigger()
            if (trigger === null) throw new Error('no sidebar account menu trigger found')
            trigger.click()
            await settle(180)
          }
          const item = findSettingsMenuItem(names)
          if (item === null) throw new Error('the account menu did not open (no menu items)')
          item.click()
        }],
        ['sidebar-trigger', () => {
          const trigger = findPlainSettingsTrigger(names[0] ?? '')
          if (trigger === null) throw new Error('no button carries the shell settings label')
          trigger.click()
        }],
        ['command', () => {
          const shortcuts = typeof ctx?.get === 'function' ? ctx.get('shortcuts') : undefined
          if (shortcuts === undefined || shortcuts === null || typeof shortcuts.invoke !== 'function') {
            throw new Error('the shortcut service is not reachable')
          }
          shortcuts.invoke(SETTINGS_COMMAND_ID, { modal: null })
        }]
      ]

      for (const [name, run] of strategies) {
        try {
          await run()
        } catch (error) {
          attempts.push(`${name}: ${String(error?.message ?? error)}`)
          continue
        }
        await settle(SETTINGS_ATTEMPT_MS)
        if (settingsPanelOpen()) return { ok: true, via: name, attempts }
        attempts.push(`${name}: the panel did not appear`)
      }

      // Nothing worked, so say what the page could see: whoever has to fix this
      // cannot look at the DOM, and this plugin can.
      attempts.push(`census: ${domCensus(ctx)}`)
      return { ok: false, via: '', attempts }
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
      /**
       * The client context, captured in `apply`. Slot components do not receive
       * it, and opening the settings panel needs it: the shell's command is
       * reached through `ctx.get('shortcuts')`.
       */
      pluginContext: null,

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
       * Open DSH's own settings page, and tell the Host how it went.
       *
       * Reporting the outcome is what makes this verifiable: the Host records it
       * (and shows it in the plugin's settings page), so "I pressed the button
       * and nothing happened" can be answered with which strategy was tried and
       * what each one said.
       *
       * @param ctx - the client plugin context, for the shortcut service. Slot
       * components do not receive it, so it falls back to the one `apply` kept.
       * @returns `{ ok, via, attempts }`.
       */
      async openSettings(ctx = engine.pluginContext) {
        const result = await openSettingsPanel(ctx)
        try {
          await callApi('page.report', {
            action: 'settings',
            ok: result.ok === true,
            via: result.via ?? '',
            error: result.ok === true ? '' : (result.attempts ?? []).join('; ')
          })
        } catch {
          /* the report is for support; failing to send it changes nothing here */
        }
        engine.store.patch({ snapshot: await engine.refreshSnapshot() })
        return result
      },

      /**
       * Report what this page can see. Asked for by the Host's `page.request`
       * action `census`, and used by whoever has to fix a DOM-dependent feature
       * without being able to look at the DOM.
       *
       * @param ctx - the client plugin context.
       * @returns the census text.
       */
      async reportCensus(ctx = engine.pluginContext) {
        const text = domCensus(ctx)
        try {
          await callApi('page.report', { action: 'census', ok: true, via: 'census', error: text })
        } catch {
          /* the report is for support */
        }
        return text
      },

      /** Re-read the projection, or keep the current one when that fails. */
      async refreshSnapshot() {
        try {
          const data = await callApi('settings.get')
          return data.settings
        } catch {
          return engine.store.getSnapshot().snapshot
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

      /** Maximize the Desktop window now (same path the start-up setting uses). */
      async maximize() {
        engine.store.patch({ busy: 'maximize' })
        try {
          const data = await callApi('window.maximize')
          const snapshot = engine.store.getSnapshot().snapshot
          if (snapshot !== null && data.window !== undefined) {
            engine.store.patch({ snapshot: { ...snapshot, window: data.window } })
          }
          engine.store.patch({ busy: '' })
          return data
        } catch (error) {
          engine.store.patch({ busy: '', error: String(error?.message ?? error) })
          throw error
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

      /**
       * Regenerate one session's title through the Host.
       *
       * The Host writes the title; this half only reports what happened. A
       * refused request comes back as `ok: false` with a reason instead of an
       * HTTP error, because "this conversation has no text yet" is an answer the
       * menu shows inline rather than a failure.
       */
      async generateTitle(sessionId) {
        return await callApi('title.generate', { sessionId })
      },

      /** Mirror the Electron updater's own state, which owns install actions. */
      setOfficialUpdate(state) {
        engine.store.patch({ officialUpdate: state ?? null })
      }
    }

    // ── an anchored panel ────────────────────────────────────────────────────

    /** Roughly how tall a panel gets before it scrolls; used to pick a side. */
    const PANEL_IDEAL_HEIGHT = 300

    /** Gap between the anchor and its panel, in CSS pixels. */
    const PANEL_GAP = 6

    /**
     * Where one panel goes, given the anchor and the viewport.
     *
     * The spend pill lives under the composer, i.e. against the bottom edge of the
     * window — a panel placed below it lands off-screen and looks like nothing
     * happened at all. So the side is chosen from the room actually available,
     * and the panel is capped to that room instead of overflowing it.
     *
     * @param anchorRect - `getBoundingClientRect()` of the anchor.
     * @param viewport - `{ width, height }` of the window.
     * @returns `{ side, top, bottom, right, maxHeight }` in CSS pixels.
     */
    function computePanelPosition(anchorRect, viewport) {
      const width = Number(viewport?.width) || 0
      const height = Number(viewport?.height) || 0
      const above = Math.max(0, anchorRect.top - PANEL_GAP)
      const below = Math.max(0, height - anchorRect.bottom - PANEL_GAP)
      // Prefer the roomier side, with a bias to opening upward: this panel is
      // opened from the bottom of the window, where "below" is usually nothing.
      const side = above >= below || above >= PANEL_IDEAL_HEIGHT ? 'above' : 'below'
      const room = side === 'above' ? above : below
      return {
        side,
        top: side === 'below' ? Math.round(anchorRect.bottom + PANEL_GAP) : undefined,
        bottom: side === 'above' ? Math.round(height - anchorRect.top + PANEL_GAP) : undefined,
        right: Math.max(8, Math.round(width - anchorRect.right)),
        maxHeight: Math.max(120, Math.min(PANEL_IDEAL_HEIGHT, room))
      }
    }

    /**
     * A `document.body` portal hung off one anchor, closed on an outside click,
     * Escape, a resize or a scroll.
     *
     * Portalling keeps the panel out of the composer's own overflow boxes and
     * above every column without depending on the anchor's stacking context —
     * which matters because the overlay layer deliberately sits below the shell's
     * own dialogs.
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
        setPosition(computePanelPosition(anchor.getBoundingClientRect(), {
          width: window.innerWidth,
          height: window.innerHeight
        }))

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
        // A fixed panel cannot follow a scrolling anchor, so it closes instead of
        // drifting away from the pill it belongs to.
        window.addEventListener('scroll', onClose, true)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKey, true)
          window.removeEventListener('resize', onClose)
          window.removeEventListener('scroll', onClose, true)
          node.remove()
        }
      }, [open, anchorRef, onClose])

      return { target, position }
    }

    /** Render one anchored panel with the given body. */
    function AnchoredPanel({ open, anchorRef, onClose, children }) {
      const { target, position } = useAnchoredPanel(open, anchorRef, onClose)
      if (target === null || position === null) return null
      const placement = {
        right: `${position.right}px`,
        maxHeight: `${position.maxHeight}px`,
        overflowY: 'auto'
      }
      if (position.side === 'above') placement.bottom = `${position.bottom}px`
      else placement.top = `${position.top}px`
      return reactDom.createPortal(
        h('div', { [OWN_ROOT_ATTRIBUTE]: '', style: { ...styles.panelSurface, ...placement } }, children),
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
      if (buttons.restart !== true && buttons.updateCheck !== true && buttons.settings !== true) return null
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

      const onSettingsClick = async () => {
        // The page opens the shell's own panel and then says what happened, so
        // "the button did nothing" is never the only available answer.
        const result = await engine.openSettings()
        if (result?.ok !== true) setNotice(`${t('settings.failed')}${result?.attempts?.join('; ') ?? ''}`)
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
      if (buttons.settings === true) {
        // Leftmost of the three: it is the least destructive action, so it sits
        // furthest from the window's own close button.
        items.push(h(ChromeButton, {
          key: 'settings',
          label: t('settings.open'),
          title: t('settings.openHint'),
          onClick: () => { void onSettingsClick() }
        }, h(IconGear, { size: 15 })))
      }
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
        // Marks this plugin's own DOM. The settings opener looks for the shell's
        // own trigger by its accessible name, and this plugin's gear is labelled
        // the same thing — so it has to be able to tell the two apart.
        [OWN_ROOT_ATTRIBUTE]: '',
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
    // ── the send-key guard ───────────────────────────────────────────────────

    /**
     * Marks the keystrokes this guard dispatched itself.
     *
     * A replayed event is dispatched on the editor with `bubbles: true`, so it
     * travels back through this same document-level capture listener. Without a
     * marker the guard would translate its own replacement — replaying a bare
     * Enter to submit would come straight back in and be turned into the newline
     * that mode exists to prevent.
     */
    const REPLAY_FLAG = '__dshToolboxReplay'

    /**
     * Translate one keystroke when the user prefers Ctrl+Enter to send.
     *
     * Only one direction needs rewriting. The shell's composer already treats a
     * bare Enter as "submit" and Shift+Enter as "newline", and it already treats
     * Ctrl/Cmd+Enter as an accelerated submit — so this guard simply stops the
     * bare Enter from submitting and hands the shell the newline gesture instead.
     * Ctrl+Enter is deliberately left alone: it is the shell's own submit
     * gesture, and re-synthesising it could only break it (a replayed event is
     * untrusted, and the shell's composition guard ignores one that arrives while
     * it still considers the editor to be composing).
     * @param readMode - reads the live `sendKey` value.
     * @returns the disposer.
     */
    function installSendKeyGuard(readMode) {
      if (typeof document === 'undefined') return () => {}

      /** Replay one Enter keystroke on the editor, marked as ours. */
      const replay = (element, modifiers) => {
        const event = new KeyboardEvent('keydown', {
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
        })
        event[REPLAY_FLAG] = true
        element.dispatchEvent(event)
      }

      const handler = (event) => {
        if (event[REPLAY_FLAG] === true) return
        if (readMode() !== 'ctrlEnter') return
        if (event.key !== 'Enter' || event.isComposing === true || event.keyCode === 229) return
        const target = event.target
        if (!(target instanceof Element)) return
        const editor = target.closest('[contenteditable="true"]')
        if (editor === null) return
        // Only the composer's editor: the conversation is the one region the
        // shell marks as a composer seat, so other editors keep plain Enter.
        if (editor.closest('[data-composer-input], [data-composer-seat], [data-composer-card]') === null) return

        // Accelerated submits belong to the shell, untouched.
        if (event.ctrlKey === true || event.metaKey === true) return
        // Shift+Enter and Alt+Enter are already the shell's newline gestures.
        if (event.shiftKey === true || event.altKey === true) return

        // Held keys keep inserting newlines, exactly as they would in the shell's
        // own newline gesture; the replacement is never treated as a repeat.
        event.preventDefault()
        event.stopImmediatePropagation()
        replay(editor, { shiftKey: true })
      }

      document.addEventListener('keydown', handler, true)
      return () => document.removeEventListener('keydown', handler, true)
    }

    // ── the composer hint ────────────────────────────────────────────────────

    /**
     * The quiet reminder beside the composer's submit action.
     *
     * Without it the choice is invisible: Enter and Ctrl+Enter look identical in
     * the interface until one of them is pressed, and the setting lives two
     * levels deep. It is a label rather than a control on purpose — a click here
     * would be too easy to hit while reaching for submit, and the send key has a
     * home in General settings.
     */
    function SendKeyHint(props) {
      const t = typeof props.t === 'function' ? props.t : key => key
      const state = useSyncExternalStore(engine.store.subscribe, engine.store.getSnapshot)
      const sendKey = state.snapshot?.sendKey ?? 'enter'
      const label = sendKey === 'ctrlEnter' ? t('sendKey.hint.ctrlEnter') : t('sendKey.hint.enter')
      return h('span', {
        style: styles.sendHint,
        title: t('sendKey.hintTitle'),
        'data-send-key-hint': sendKey
      }, label)
    }

    // ── AI session titles ────────────────────────────────────────────────────

    /** Fallback glyph for the row's icon, when the shell ships no sparkle icon. */
    function IconSparkle(props) {
      return h(Icon, props,
        h('path', { d: 'M12 3.4l1.6 4.6L18.2 9.6l-4.6 1.6L12 15.8l-1.6-4.6L5.8 9.6l4.6-1.6z' }),
        h('path', { d: 'M18.4 15.2l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z' }))
    }

    /**
     * Pick a themed icon out of the shell's primitives by name.
     *
     * The names are looked up rather than destructured so a primitive that this
     * DSH build does not ship (a renamed or added icon) degrades to the plugin's
     * own drawing instead of throwing during module evaluation, which would take
     * every other toolbox feature down with it.
     *
     * @param names - preferred export names, best first.
     * @returns a component to render.
     */
    function themedIcon(names) {
      for (const name of names) {
        const candidate = primitives?.[name]
        if (typeof candidate === 'function' || (candidate !== null && typeof candidate === 'object')) return candidate
      }
      return IconSparkle
    }

    /** How long a settled outcome stays on the row before it reads as idle again. */
    const TITLE_SETTLE_MS = 4000

    /**
     * "Rename with AI" inside one Session row's context menu.
     *
     * The outcome lives on this menu row: a spinner, then the new title or the
     * reason none was produced. The menu therefore stays open on select — it used
     * to close immediately, which meant a failed request changed nothing on
     * screen and the feature looked like it did nothing at all. Closing is still
     * one click away (anywhere outside, or merely moving the pointer off the
     * menu). Two clicks in a row cannot double-spend either — the button is
     * disabled while its request is in flight.
     *
     * @param props - the slot's Session share (`sessionId`, `displayTitle`) and
     *   the toolbox locale seat.
     */
    function RenameTitleMenuItem(props) {
      const { sessionId, t } = props
      const state = useSyncExternalStore(engine.store.subscribe, engine.store.getSnapshot)
      const [outcome, setOutcome] = useState(null)
      const enabled = state.snapshot?.title?.enabled !== false
      const busy = outcome?.kind === 'busy'

      // Every settled outcome clears itself, so reopening the menu never shows a
      // stale success from an earlier click on the same conversation.
      useEffect(() => {
        if (outcome === null || outcome.kind === 'busy') return undefined
        const timer = setTimeout(() => setOutcome(null), TITLE_SETTLE_MS)
        return () => clearTimeout(timer)
      }, [outcome])

      // A row for a different conversation is a different menu; drop the note.
      useEffect(() => { setOutcome(null) }, [sessionId])

      const label = busy
        ? t('title.busy')
        : outcome?.kind === 'ok'
          ? t('title.done')
          : outcome?.kind === 'refused'
            ? t('title.retry')
            : outcome?.kind === 'error'
              ? t('title.retry')
              : t('title.action')

      const onSelect = () => {
        // Deliberately not closing the menu: the outcome is rendered here, and a
        // closed menu would hide the only feedback a refusal ever produces.
        if (busy || !enabled) return
        setOutcome({ kind: 'busy' })
        engine.generateTitle(sessionId)
          .then((data) => {
            const title = typeof data?.title === 'string' ? data.title : ''
            if (data?.ok === true) setOutcome({ kind: 'ok', title })
            else setOutcome({ kind: 'refused', text: data?.error ?? t('title.failed') })
          })
          .catch((error) => {
            setOutcome({ kind: 'error', text: String(error?.message ?? error) })
          })
      }

      const MenuItemButton = primitives?.MenuItemButton
      const detail = outcome === null || outcome.kind === 'busy'
        ? null
        : h('span', { style: styles.menuDetail }, outcome.kind === 'ok'
          ? `「${outcome.title}」`
          : String(outcome.text ?? ''))

      // Without the shell's own row primitive the entry is still offered, with
      // the plugin's own styling: a missing primitive must not silently remove
      // a feature the user asked for.
      if (typeof MenuItemButton !== 'function') {
        return h('button', {
          type: 'button',
          role: 'menuitem',
          disabled: busy || !enabled,
          title: enabled ? t('title.hint') : t('title.disabled'),
          style: { ...styles.menuFallback, ...busy || !enabled ? styles.menuFallbackDisabled : {} },
          onClick: onSelect
        }, h(themedIcon(['IconSparkleOutlineRegular', 'IconMagicOutlineRegular', 'IconEditOutlineRegular']), { size: 16 }), h('span', null, label), detail)
      }

      return h(MenuItemButton, {
        icon: h(themedIcon(['IconSparkleOutlineRegular', 'IconMagicOutlineRegular', 'IconEditOutlineRegular'])),
        disabled: busy || !enabled,
        onSelect,
        children: [h('span', { key: 'label' }, label), detail]
      })
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
          title: snapshot.title,
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
        title: snapshot.title,
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

      const onMaximize = async () => {
        setMessage(null)
        try {
          const data = await engine.maximize()
          const result = data.result ?? data.window?.last ?? {}
          setMessage(result.ok === true
            ? { kind: 'ok', text: t('window.maximized') }
            : { kind: 'bad', text: `${t('window.maximizeFailed')}${result.error ?? ''}` })
        } catch (error) {
          setMessage({ kind: 'bad', text: `${t('window.maximizeFailed')}${String(error?.message ?? error)}` })
        }
      }

      const update = snapshot.update ?? {}
      const trayStatus = snapshot.trayStatus ?? {}
      const pageLast = snapshot.page?.last ?? {}
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
            label: t('buttons.settings'),
            hint: t('buttons.settingsHint'),
            checked: read(model, 'windowButtons.settings', true) === true,
            onChange: value => set('windowButtons.settings', value)
          }),
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

        // AI session titles ──────────────────────────────────────────────────
        h('div', { style: styles.section },
          h('div', { style: styles.sectionTitle }, t('title.section')),
          h('div', { style: styles.hint }, t('title.description')),
          h(SwitchRow, {
            label: t('title.enabled'),
            hint: t('title.enabledHint'),
            checked: read(model, 'title.enabled', true) === true,
            onChange: value => set('title.enabled', value)
          }),
          h(FieldRow, {
            label: t('title.budget'),
            hint: t('title.budgetHint'),
            type: 'number',
            value: String(read(model, 'title.maxInputKb', 4)),
            onChange: value => set('title.maxInputKb', Number(value))
          }),
          h(FieldRow, {
            label: t('title.prefix'),
            hint: t('title.prefixHint'),
            value: read(model, 'title.prefix', ''),
            placeholder: t('title.prefixPlaceholder'),
            onChange: value => set('title.prefix', value)
          }),
          h('div', { style: styles.metaList },
            h('div', null, t('title.costNote', { kb: String(read(model, 'title.maxInputKb', 4)) }))),
          h('div', { style: styles.hint }, t('title.note'))),

        // Start-up window ────────────────────────────────────────────────────
        h('div', { style: styles.section },
          h('div', { style: styles.sectionTitle }, t('window.title')),
          h('div', { style: styles.hint }, t('window.description')),
          h(SwitchRow, {
            label: t('window.maximized'),
            hint: t('window.maximizedHint'),
            checked: read(model, 'startWindow.maximized', true) === true,
            onChange: value => set('startWindow.maximized', value)
          }),
          h('div', { style: styles.buttonRow },
            h('button', {
              type: 'button',
              style: styles.buttonGhost,
              disabled: busy === 'maximize' || snapshot.window?.supported !== true,
              onClick: () => { void onMaximize() }
            }, busy === 'maximize' ? t('window.maximizing') : t('window.maximizeNow'))),
          h('div', { style: styles.metaList },
            h('div', null, `${t('window.state')}: ${read(model, 'startWindow.maximized', true) === true ? t('window.on') : t('window.off')}`),
            snapshot.window?.supported !== true ? h('div', { style: styles.noticeWarn }, t('window.unsupported')) : null,
            snapshot.window?.last?.at ? h('div', null, `${t('window.last')}: ${snapshot.window.last.ok === true ? t('window.lastOk') : t('window.lastFailed')}${snapshot.window.last.error ? ` · ${snapshot.window.last.error}` : ''}`) : null,
            snapshot.window?.logFile ? h('div', { style: styles.mono }, shortPath(snapshot.window.logFile)) : null),
          h('div', { style: styles.hint }, t('window.note'))),

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
      // composer hint
      sendHint: {
        fontSize: '11px',
        lineHeight: '16px',
        color: 'var(--dsw-alias-label-tertiary, #8A9199)',
        whiteSpace: 'nowrap',
        userSelect: 'none',
        padding: '0 2px',
        alignSelf: 'center'
      },
      noticeWarn: { marginTop: '6px', color: 'var(--dsw-alias-state-warning-primary, #E8A33D)' },
      noticeBad: { marginTop: '6px', color: 'var(--dsw-alias-state-error-primary, #F0616D)', wordBreak: 'break-all' },
      // Session-menu row
      menuDetail: { display: 'block', fontSize: '11px', lineHeight: '15px', maxWidth: '220px', whiteSpace: 'normal', opacity: 0.75 },
      menuFallback: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        width: '100%',
        appearance: 'none',
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary, #F2F4F7)',
        font: 'inherit',
        fontSize: '14px',
        lineHeight: '20px',
        textAlign: 'start',
        padding: '6px 10px',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        cursor: 'pointer'
      },
      menuFallbackDisabled: { opacity: 0.45, cursor: 'default' },
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
      subtitle: '重启 DSH、检查桌面端更新、选择发送键、用 AI 重新生成会话标题、启动时最大化窗口。',
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
      'settings.open': '设置',
      'settings.openHint': '打开 DSH 设置（与侧边栏底部的「设置」、Ctrl+, 相同）',
      'settings.failed': '没能打开设置页：',
      'page.title': '来自托盘/页面的请求',
      'page.last': '最近一次',
      'page.none': '还没有',
      'page.ok': '成功',
      'page.failed': '未成功',

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
      'buttons.settings': '显示设置图标',
      'buttons.settingsHint': '打开 DSH 自己的设置页（等同侧边栏底部的「设置」或 Ctrl+,）。',
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
      'sendKey.hint.enter': 'Enter 发送',
      'sendKey.hint.ctrlEnter': 'Ctrl+Enter 发送',
      'sendKey.hintTitle': '当前发送键。可在 设置 → 通用 → 发送键 里修改。',

      'window.title': '启动窗口',
      'window.description': 'DSH 的外壳没有给插件留窗口状态的扩展点，所以本插件通过系统接口调整 DSH 自己的窗口（等同于双击标题栏）。',
      'window.maximized': '启动时自动最大化',
      'window.maximizedHint': '每次 DSH 启动（含由本插件重启）都会最大化窗口。',
      'window.maximizeNow': '立即最大化',
      'window.maximizing': '正在最大化…',
      'window.maximized': '已最大化。',
      'window.maximizeFailed': '最大化失败：',
      'window.state': '当前设置',
      'window.on': '启动时最大化',
      'window.off': '保持上次窗口大小',
      'window.unsupported': '仅 Windows 桌面端支持。',
      'window.last': '上次执行',
      'window.lastOk': '成功',
      'window.lastFailed': '未成功',
      'window.note': '只对“已经显示出来”的窗口生效，因此不会在 DSH 自己把窗口显示出来之前抢先弹出白屏。',

      'title.section': 'AI 会话标题',
      'title.description': '在左侧会话列表里右键某个会话，选「AI 重命名」，就会用该会话的模型（思考关闭）按对话内容重新生成标题。',
      'title.enabled': '启用 AI 重命名',
      'title.enabledHint': '关掉后右键菜单里仍能看到这一项，但为禁用状态。',
      'title.budget': '上下文预算（KiB）',
      'title.budgetHint': '一次生成最多送给模型多少会话文字，默认 4 KiB。只会送你写的文字（你自己的消息、目标里的 objective），不含工具输出、文件内容和系统提示。',
      'title.prefix': '标题前缀',
      'title.prefixHint': '可选，例如填「🤖」就会生成「🤖 修复登录接口」。留空则不加。',
      'title.prefixPlaceholder': '例如 🤖',
      'title.note': '生成出来的标题会写入会话日志并固定下来（与手动改名同一机制），因此不会被自动命名覆盖；不满意就再点一次。',
      'title.costNote': '按 {kb} KiB 上限估算，一次生成约 1.1K tokens 输入、十几 tokens 输出，且思考 token 为 0（只有模型不提供关闭档时才会多花一点）；它与对话长度无关。',
      'title.action': 'AI 重命名',
      'title.busy': '正在生成标题…',
      'title.done': '标题已更新',
      'title.retry': '生成失败，点击重试',
      'title.failed': '生成失败',
      'title.hint': '用该会话的模型，按对话内容重新生成标题（思考关闭）',
      'title.disabled': 'AI 重命名已在设置里关闭',


      'tray.title': '托盘小程序',
      'tray.description': 'DSH 自带托盘菜单由 Electron 外壳拥有，插件无法往里加菜单项；开启后由本插件提供一个并排的小图标，右键菜单为：打开/隐藏 DeepSeek Harness、重启、检查更新、关闭 DeepSeek Harness（双击图标同样打开或隐藏窗口）。',
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
      'meta.stateDir': '状态目录',
      'meta.localTime': '本机时间'
    }

    const en = {
      nav: 'Personal toolbox',
      title: 'Personal toolbox',
      subtitle: 'Restart DSH, check for Desktop updates, choose the send key, rename a conversation with AI, and maximize the window on start-up.',
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
      'settings.open': 'Settings',
      'settings.openHint': 'Open DSH’s settings (the same as the sidebar foot button or Ctrl+,)',
      'settings.failed': 'Could not open the settings page: ',
      'page.title': 'Requests from the tray/page',
      'page.last': 'Last one',
      'page.none': 'none yet',
      'page.ok': 'succeeded',
      'page.failed': 'failed',

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
      'buttons.settings': 'Show the settings icon',
      'buttons.settingsHint': 'Opens DSH’s own settings page (the same thing as the sidebar foot button or Ctrl+,).',
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
      'sendKey.hint.enter': 'Enter sends',
      'sendKey.hint.ctrlEnter': 'Ctrl+Enter sends',
      'sendKey.hintTitle': 'The current send key. Change it in Settings → General → Send key.',

      'window.title': 'Start-up window',
      'window.description': 'The shell has no plugin surface for window state, so this plugin resizes DSH’s own window through the OS — the same thing a title-bar double-click does.',
      'window.maximized': 'Maximize on start-up',
      'window.maximizedHint': 'Every DSH launch — including a restart from this plugin — comes up maximized.',
      'window.maximizeNow': 'Maximize now',
      'window.maximizing': 'Maximizing…',
      'window.maximized': 'Maximized.',
      'window.maximizeFailed': 'Could not maximize: ',
      'window.state': 'Setting',
      'window.on': 'maximize on start-up',
      'window.off': 'keep the previous window size',
      'window.unsupported': 'Windows Desktop only.',
      'window.last': 'Last attempt',
      'window.lastOk': 'succeeded',
      'window.lastFailed': 'failed',
      'window.note': 'Only a window that is already visible is maximized, so DSH never flashes a blank frame ahead of its own timing.',

      'title.section': 'AI session titles',
      'title.description': 'Right-click a conversation in the sidebar and pick “Rename with AI” to regenerate its title from what the conversation is about, through that conversation’s own model with reasoning disabled.',
      'title.enabled': 'Offer AI renaming',
      'title.enabledHint': 'When off, the row stays in the menu but is disabled.',
      'title.budget': 'Context budget (KiB)',
      'title.budgetHint': 'How much conversation text one generation may send, 4 KiB by default. Only text you wrote is sent — your own messages and a goal’s objective — never tool output, file contents or the system prompt.',
      'title.prefix': 'Title prefix',
      'title.prefixHint': 'Optional, e.g. “🤖” turns 「修复登录接口」 into 「🤖 修复登录接口」. Leave empty for none.',
      'title.prefixPlaceholder': 'e.g. 🤖',
      'title.note': 'An accepted title is written to the session log and pinned (the same mechanism as a manual rename), so automatic naming will not overwrite it. Click again to regenerate.',
      'title.costNote': 'At a {kb} KiB cap one generation is roughly 1.1K input tokens and a dozen output tokens, with zero reasoning tokens (a model that cannot switch reasoning off costs a little more) — and it does not grow with the conversation.',
      'title.action': 'Rename with AI',
      'title.busy': 'Generating a title…',
      'title.done': 'Title updated',
      'title.retry': 'Could not generate — click to retry',
      'title.failed': 'Generation failed',
      'title.hint': 'Regenerate this title from the conversation, through its own model with reasoning disabled',
      'title.disabled': 'AI renaming is turned off in the settings',


      'tray.title': 'Companion tray icon',
      'tray.description': 'DSH’s own tray menu is owned by the Electron shell and cannot be extended by a plugin. Enabling this runs a small companion icon beside it, whose menu is: show/hide DeepSeek Harness, restart, check for updates, close DeepSeek Harness. Double-clicking the icon shows or hides the window too.',
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
      // Slot components never see this context, but opening the settings panel
      // needs it (the shell's own command lives on the shortcut service), so it
      // is kept on the engine for the title-bar button and for tray requests.
      engine.pluginContext = ctx
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

      // The tray cannot touch this page, so it asks the Host, which pushes here.
      // EventSource reconnects on its own, which is why there is no retry logic.
      ctx.effect(() => {
        if (typeof globalThis.EventSource !== 'function') return () => {}
        let source
        try {
          source = new globalThis.EventSource(`${ROUTE}/events`)
        } catch {
          return () => {}
        }
        const onPage = (event) => {
          let request
          try {
            request = JSON.parse(event.data)
          } catch {
            return
          }
          if (request?.action === 'settings') void engine.openSettings(ctx)
          // A diagnostic the Host (or a developer) can ask for: what this page
          // can see, reported through the same channel.
          else if (request?.action === 'census') void engine.reportCensus(ctx)
        }
        source.addEventListener('page', onPage)
        return () => {
          try {
            source.removeEventListener('page', onPage)
            source.close()
          } catch {
            /* already closed */
          }
        }
      }, 'toolbox: page requests')

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

      // The reminder sits inside the composer's standard controls, which the
      // shell renders immediately before the model seat and the submit action.
      ctx.effect(() => ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
        name: 'conversation.input.right',
        id: 'toolbox.send-hint',
        order: 10,
        locale: NS
      }, SendKeyHint)), 'toolbox: send-key hint')

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

      // The Session row's own context menu. Order 350 seats it between the
      // shell's rename (200) / fork (300) and its archive (400), which is where
      // "change this conversation's name" reads as one group.
      ctx.effect(() => ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
        name: 'sidebar.workspaces.session.menu.item',
        id: 'toolbox.ai-title',
        order: 350,
        locale: NS
      }, RenameTitleMenuItem)), 'toolbox: AI session title row')
    }

    exports.NS = NS
    exports.apply = apply
    exports.inject = inject
    exports.__internals = {
      createStore,
      computePanelPosition,
      openSettingsPanel,
      settingsPanelOpen,
      SETTINGS_MODAL_SELECTOR,
      installSendKeyGuard,
      measureTitlebar,
      REPLAY_FLAG,
      WindowActions,
      SendKeyRow,
      SendKeyHint,
      RenameTitleMenuItem,
      SettingsSection,
      engine,
      zh,
      en
    }

    return module.exports
  }
})
