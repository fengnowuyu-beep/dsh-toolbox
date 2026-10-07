/**
 * Browser half: the module loads in a DOM-shaped sandbox, its registrations land
 * where they should, and the keystroke translation — the one piece of behaviour
 * that touches the shell's composer — is exercised directly.
 */

import { readFileSync } from 'node:fs'
import vm from 'node:vm'

import { deepEqual, equal, ok, run, test } from './harness.mjs'

// ── the sandbox ─────────────────────────────────────────────────────────────

const listeners = new Map()

const fakeDocument = {
  documentElement: {
    _attributes: new Set(),
    hasAttribute(name) { return this._attributes.has(name) },
    style: { setProperty() {} }
  },
  addEventListener(type, handler) {
    if (!listeners.has(type)) listeners.set(type, new Set())
    listeners.get(type).add(handler)
  },
  removeEventListener(type, handler) {
    listeners.get(type)?.delete(handler)
  },
  createElement() {
    return { dataset: {}, style: {}, append() {}, remove() {} }
  },
  body: { append() {}, dataset: {} },
  querySelector() { return null }
}

class FakeElement {
  constructor({ composer = true } = {}) {
    this.composer = composer
    this.dispatched = []
  }
  closest(selector) {
    if (selector === '[contenteditable="true"]') return this
    if (selector.startsWith('[data-composer-input]')) return this.composer ? this : null
    return null
  }
  dispatchEvent(event) {
    this.dispatched.push(event)
    return true
  }
}

class FakeKeyboardEvent {
  constructor(type, init = {}) {
    this.type = type
    Object.assign(this, init)
  }
}

const reactShim = {
  default: {
    createElement: () => null,
    useCallback: fn => fn,
    useEffect: () => {},
    useMemo: fn => fn(),
    useRef: value => ({ current: value }),
    useState: value => [value, () => {}],
    useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot()
  }
}

const context = {
  console: { log() {}, warn() {}, error() {}, info() {} },
  setTimeout,
  clearTimeout,
  location: { origin: 'http://127.0.0.1:19387', href: 'http://127.0.0.1:19387/#/s/x', port: '19387' },
  window: { __ModuleLoader__: { load: definition => { context.__definition = definition } }, innerWidth: 1280 },
  document: fakeDocument,
  navigator: {},
  Element: FakeElement,
  KeyboardEvent: FakeKeyboardEvent,
  getComputedStyle: () => ({ getPropertyValue: () => '40px' }),
  fetch: async () => { throw new Error('no network in tests') },
  require: (id) => {
    if (id === 'react') return reactShim
    if (id === 'react-dom') return { createPortal: () => null }
    throw new Error(`unexpected require("${id}")`)
  }
}
context.globalThis = context
vm.createContext(context)

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
vm.runInContext(source, context, { filename: 'lib/client.js' })

const definition = context.__definition
ok(definition !== undefined, 'the module must register itself with the loader')
equal(definition.id, 'dsh-toolbox')
const exports = definition.factory(context.require)
const internals = exports.__internals

// ── the module contract ─────────────────────────────────────────────────────

test('the browser half declares the services it needs', () => {
  deepEqual(exports.inject, ['slots', 'locale'])
  equal(exports.NS, 'toolbox')
  equal(typeof exports.apply, 'function')
})

test('both dictionaries carry the same keys', () => {
  const zh = Object.keys(internals.zh).sort()
  const en = Object.keys(internals.en).sort()
  deepEqual(en, zh, 'a missing translation would render a raw key')
  ok(zh.length > 40)
})

test('apply registers into the four seats the plugin owns', () => {
  const registrations = []
  let pendingKey = ''
  const disposers = []
  const ctx = {
    locale: {
      bind: () => key => key,
      register: () => () => {},
      getSnapshot: () => ({ locale: 'zh' })
    },
    slots: {
      inject: (key, callback) => {
        pendingKey = key
        callback()
        return () => {}
      },
      register: (options) => {
        registrations.push({ key: pendingKey, options })
        return { dispose() {} }
      }
    },
    effect: (fn) => {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return () => {}
    }
  }
  exports.apply(ctx)

  const byKey = Object.fromEntries(registrations.map(entry => [entry.key, entry.options]))
  deepEqual(Object.keys(byKey).sort(), [
    'conversation.composer.dock',
    'settings.general.item',
    'settings.section',
    'shell.overlay'
  ])
  equal(byKey['shell.overlay'].id, 'toolbox.window-actions')
  equal(byKey['conversation.composer.dock'].id, 'toolbox.cost')
  equal(byKey['settings.general.item'].id, 'toolbox-send-key')
  equal(byKey['settings.section'].id, 'dsh-toolbox')
  equal(byKey['settings.section'].locale, 'toolbox')
  equal(byKey['settings.section'].label(), 'nav')

  // The send-key guard is installed on the document and removable again.
  ok(listeners.get('keydown')?.size > 0, 'a keydown listener must be installed')
  for (const dispose of disposers) dispose()
  equal(listeners.get('keydown')?.size ?? 0, 0, 'every listener must be removable')
})

// ── the send-key guard ──────────────────────────────────────────────────────

/** Drive one keydown through the installed guard and report what happened. */
function press({ mode, composer = true, key = 'Enter', ...modifiers }) {
  const dispose = internals.installSendKeyGuard(() => mode)
  const handler = [...listeners.get('keydown')].at(-1)
  const target = new FakeElement({ composer })
  const event = {
    key,
    keyCode: key === 'Enter' ? 13 : 65,
    isComposing: false,
    repeat: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    target,
    prevented: false,
    stopped: false,
    preventDefault() { this.prevented = true },
    stopImmediatePropagation() { this.stopped = true },
    ...modifiers
  }
  handler(event)
  dispose()
  return { event, replayed: target.dispatched }
}

test('the default mode leaves every keystroke to the shell', () => {
  const plain = press({ mode: 'enter' })
  equal(plain.event.prevented, false)
  equal(plain.replayed.length, 0)
  const ctrl = press({ mode: 'enter', ctrlKey: true })
  equal(ctrl.event.prevented, false)
  equal(ctrl.replayed.length, 0)
})

test('Ctrl+Enter sends by replaying a bare Enter', () => {
  const result = press({ mode: 'ctrlEnter', ctrlKey: true })
  equal(result.event.prevented, true)
  equal(result.event.stopped, true)
  equal(result.replayed.length, 1)
  equal(result.replayed[0].key, 'Enter')
  equal(result.replayed[0].shiftKey, false)
  equal(result.replayed[0].bubbles, true)
})

test('Cmd+Enter sends on macOS', () => {
  const result = press({ mode: 'ctrlEnter', metaKey: true })
  equal(result.replayed.length, 1)
  equal(result.replayed[0].shiftKey, false)
})

test('plain Enter inserts a newline by replaying Shift+Enter', () => {
  const result = press({ mode: 'ctrlEnter' })
  equal(result.event.prevented, true)
  equal(result.replayed.length, 1)
  equal(result.replayed[0].shiftKey, true)
})

test('Shift+Enter still inserts a newline and is not rewritten', () => {
  const result = press({ mode: 'ctrlEnter', shiftKey: true })
  equal(result.event.prevented, false)
  equal(result.replayed.length, 0)
})

test('Alt+Enter and Ctrl+Shift+Enter are left alone', () => {
  equal(press({ mode: 'ctrlEnter', altKey: true }).replayed.length, 0)
  equal(press({ mode: 'ctrlEnter', ctrlKey: true, shiftKey: true }).replayed.length, 0)
})

test('an in-flight keystroke repeat is not doubled', () => {
  const result = press({ mode: 'ctrlEnter', repeat: true })
  equal(result.replayed.length, 0)
})

test('an IME composition Enter is never hijacked', () => {
  const result = press({ mode: 'ctrlEnter', isComposing: true })
  equal(result.replayed.length, 0)
  const composingByKeyCode = press({ mode: 'ctrlEnter', keyCode: 229 })
  equal(composingByKeyCode.replayed.length, 0)
})

test('editors outside the composer keep plain Enter', () => {
  const result = press({ mode: 'ctrlEnter', composer: false })
  equal(result.event.prevented, false)
  equal(result.replayed.length, 0)
})

test('other keys are untouched', () => {
  const result = press({ mode: 'ctrlEnter', key: 'a' })
  equal(result.replayed.length, 0)
})

// ── pure helpers ────────────────────────────────────────────────────────────

test('money is formatted with the currency symbol and a useful precision', () => {
  equal(internals.formatMoney(0, 'CNY'), '¥0.000')
  equal(internals.formatMoney(0.0042, 'CNY'), '¥0.0042')
  equal(internals.formatMoney(0.421, 'CNY'), '¥0.421')
  equal(internals.formatMoney(12.3456, 'USD'), '$12.35')
  equal(internals.formatMoney(Number.NaN, 'USD'), '$0.000')
})

test('the token total sums every billing bucket', () => {
  equal(internals.usageTotal({ uncachedInputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 3, outputTokens: 4 }), 10)
  equal(internals.usageTotal(undefined), 0)
  equal(internals.usageTotal({ outputTokens: 7 }), 7)
})

test('a manual update check publishes its answer to the shared snapshot', async () => {
  const engine = internals.engine
  const original = context.fetch
  context.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      update: { status: 'ok', currentVersion: '0.2.0-rc.2', latestVersion: '0.2.0-rc.3', available: true }
    })
  })
  try {
    engine.store.patch({ snapshot: { pluginVersion: '1.0.0', update: { status: 'unknown', available: false } } })
    const update = await engine.checkUpdate()
    equal(update.available, true)
    // The title-bar icon reads the snapshot, so the answer must land there.
    equal(engine.store.getSnapshot().snapshot.update.latestVersion, '0.2.0-rc.3')
    equal(engine.store.getSnapshot().snapshot.update.available, true)
    equal(engine.store.getSnapshot().busy, '')
  } finally {
    context.fetch = original
    engine.store.patch({ snapshot: null })
  }
})

test('a failing update check records the reason instead of throwing away state', async () => {
  const engine = internals.engine
  const original = context.fetch
  context.fetch = async () => ({
    ok: false,
    status: 500,
    json: async () => ({ ok: false, error: { code: 'internal-error', message: 'boom' } })
  })
  try {
    engine.store.patch({ snapshot: { update: { available: false } }, error: '' })
    let failed = false
    await engine.checkUpdate().catch(() => { failed = true })
    equal(failed, true)
    equal(engine.store.getSnapshot().error, 'boom')
    equal(engine.store.getSnapshot().busy, '')
  } finally {
    context.fetch = original
    engine.store.patch({ snapshot: null, error: '' })
  }
})

test('every registered component is a renderable function', () => {
  for (const key of ['WindowActions', 'CostPill', 'SendKeyRow', 'SettingsSection']) {
    equal(typeof internals[key], 'function', `${key} must be a component`)
  }
})

test('the title-bar placement follows the overlay metrics when they are present', () => {
  context.window.innerWidth = 1000
  fakeDocument.documentElement._attributes.add('data-windows-titlebar')
  context.navigator.windowControlsOverlay = {
    getTitlebarAreaRect: () => ({ x: 0, width: 862 })
  }
  deepEqual(internals.measureTitlebar(), { chrome: true, right: 138, height: 40 })

  // Without a Windows title bar the buttons fall back to a plain inset.
  fakeDocument.documentElement._attributes.delete('data-windows-titlebar')
  deepEqual(internals.measureTitlebar(), { chrome: false, right: 8, height: 36 })
})

test('a missing overlay implementation still yields a usable offset', () => {
  fakeDocument.documentElement._attributes.add('data-windows-titlebar')
  delete context.navigator.windowControlsOverlay
  deepEqual(internals.measureTitlebar(), { chrome: true, right: 138, height: 40 })
})

test('a nonsense overlay rectangle falls back to the known caption width', () => {
  context.navigator.windowControlsOverlay = {
    getTitlebarAreaRect: () => { throw new Error('not ready') }
  }
  deepEqual(internals.measureTitlebar(), { chrome: true, right: 138, height: 40 })
})

await run('client')
