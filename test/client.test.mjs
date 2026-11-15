/**
 * Browser half: the module loads in a DOM-shaped sandbox, its registrations land
 * where they should, and the keystroke translation — the one piece of behaviour
 * that touches the shell's composer — is exercised through a shim that models
 * real event propagation.
 *
 * The propagation model matters: a replayed event is dispatched on the editor
 * with `bubbles: true`, so it travels back through the plugin's own document-level
 * capture listener. A shim that merely records `dispatchEvent` calls cannot see
 * that, and so cannot catch a guard that intercepts its own replacement — which
 * is exactly the bug this suite now pins.
 */

import { readFileSync } from 'node:fs'
import vm from 'node:vm'

import { deepEqual, equal, ok, run, test } from './harness.mjs'

// ── the sandbox ─────────────────────────────────────────────────────────────

/** Capture-phase listeners registered on the document, per event type. */
const documentListeners = new Map()

/** Every event that entered the document's capture phase, in dispatch order. */
const dispatches = []

/**
 * Run one event through the document capture phase and, unless a listener
 * stopped it, on to the target's own listener.
 */
function propagate(event, target) {
  event.target = target
  dispatches.push(event)

  // `stopImmediatePropagation` is not readable on a native event, so the shim
  // records it the way the browser would act on it.
  const originalStop = event.stopImmediatePropagation?.bind(event)
  event.stopImmediatePropagation = function stopImmediatePropagation() {
    this.__stopped = true
    originalStop?.()
  }

  for (const handler of [...(documentListeners.get('keydown') ?? [])]) {
    handler(event)
    if (event.__stopped === true) return
  }
  if (event.__stopped === true) return

  event.currentTarget = target
  target.receiveKeyDown(event)
}

const fakeDocument = {
  documentElement: {
    _attributes: new Set(['data-windows-titlebar']),
    hasAttribute(name) { return this._attributes.has(name) },
    style: { setProperty() {} }
  },
  addEventListener(type, handler) {
    if (!documentListeners.has(type)) documentListeners.set(type, new Set())
    documentListeners.get(type).add(handler)
  },
  removeEventListener(type, handler) {
    documentListeners.get(type)?.delete(handler)
  },
  createElement() {
    return { dataset: {}, style: {}, append() {}, remove() {} }
  },
  body: { append() {}, dataset: {} },
  // The settings hunt: `querySelector` answers for the shell's own panel marker,
  // `querySelectorAll` for the buttons it looks through, and `dispatchEvent`
  // records the gesture the last-resort strategy replays. Tests drive them.
  querySelector() { return null },
  querySelectorAll() { return [] },
  dispatchEvent(event) { documentDispatches.push(event); return true }
}

/** Every event the client dispatched on the document, for the tests to inspect. */
const documentDispatches = []

/** A stand-in for the composer's contentEditable root. */
class FakeElement {
  constructor({ composer = true } = {}) {
    this.composer = composer
    /** Events that reached the element, i.e. what the shell's editor would see. */
    this.seen = []
  }

  closest(selector) {
    if (selector === '[contenteditable="true"]') return this
    if (selector.startsWith('[data-composer-input]')) return this.composer ? this : null
    return null
  }

  /** The element's own (target-phase) keydown handling. */
  receiveKeyDown(event) {
    this.seen.push(event)
  }

  dispatchEvent(event) {
    propagate(event, this)
    return event.defaultPrevented !== true
  }
}

class FakeKeyboardEvent {
  constructor(type, init = {}) {
    this.type = type
    this.defaultPrevented = false
    this.__stopped = false
    Object.assign(this, init)
  }

  preventDefault() {
    this.defaultPrevented = true
  }

  stopImmediatePropagation() {
    this.__stopped = true
  }
}

/**
 * A minimal element factory. Real React would render; the tests only need to
 * inspect the tree a component returns, so this keeps `type` and `props` — and
 * collapses one child to the child itself, the way JSX-shaped code reads.
 */
function createElement(type, props, ...children) {
  return {
    type,
    props: {
      ...(props ?? {}),
      ...(children.length === 0 ? {} : children.length === 1 ? { children: children[0] } : { children })
    }
  }
}

// ── a hook runtime ──────────────────────────────────────────────────────────
// Enough of React's hook model to render a component more than once with its
// state carried across. Without it a test can only ever see the first render,
// which is exactly the state a component uses to decide whether to render.

let hookSlots = []
let hookCursor = 0

const hooks = {
  useState(initial) {
    const index = hookCursor++
    if (!(index in hookSlots)) hookSlots[index] = typeof initial === 'function' ? initial() : initial
    return [hookSlots[index], (next) => {
      hookSlots[index] = typeof next === 'function' ? next(hookSlots[index]) : next
    }]
  },
  useRef(value) {
    const index = hookCursor++
    if (!(index in hookSlots)) hookSlots[index] = { current: value }
    return hookSlots[index]
  },
  useEffect(fn) {
    const index = hookCursor++
    const previous = hookSlots[index]
    // React runs the previous cleanup before the next effect.
    if (typeof previous === 'function') previous()
    hookSlots[index] = fn()
  },
  useCallback(fn) {
    const index = hookCursor++
    if (!(index in hookSlots)) hookSlots[index] = fn
    return hookSlots[index]
  },
  useMemo(fn) {
    const index = hookCursor++
    if (!(index in hookSlots)) hookSlots[index] = fn()
    return hookSlots[index]
  },
  useSyncExternalStore(subscribe, getSnapshot) {
    hookCursor++
    return getSnapshot()
  }
}

/**
 * Render one component the way React would: hooks resume from the last render.
 * @param component - the component to call.
 * @param props - its props.
 * @returns the element tree, or whatever the component returns.
 */
function renderComponent(component, props) {
  hookCursor = 0
  return component(props)
}

/** Forget all hook state so the next render is a fresh mount. */
function resetHooks() {
  hookSlots = []
  hookCursor = 0
}

/** Depth-first walk of a rendered tree, visiting every element. */
function walkTree(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) walkTree(child, visit)
    return
  }
  if (node.props === undefined) return
  visit(node)
  walkTree(node.props.children, visit)
}

/**
 * Every string reachable in a rendered tree.
 *
 * Component elements are not expanded by the stub factory, so a string passed as
 * a prop (`label`, `amount`, `value`) is as much part of the rendered text as a
 * child — both are collected.
 */
function treeText(node) {
  const parts = []
  walkTree(node, (element) => {
    for (const value of Object.values(element.props)) {
      if (typeof value === 'string') parts.push(value)
    }
  })
  return parts.join(' ')
}

/** Every `title` attribute reachable in a rendered tree. */
function treeTitles(node) {
  const titles = []
  walkTree(node, (element) => {
    if (typeof element.props.title === 'string') titles.push(element.props.title)
  })
  return titles
}

const reactShim = {
  default: {
    createElement,
    useCallback: hooks.useCallback,
    useEffect: hooks.useEffect,
    useMemo: hooks.useMemo,
    useRef: hooks.useRef,
    useState: hooks.useState,
    useSyncExternalStore: hooks.useSyncExternalStore
  }
}

/**
 * The shell's menu primitives, as the client half consumes them.
 *
 * Only the two things the plugin drives are modelled: an icon component (so a
 * row can carry one) and `MenuItemButton`, whose rendered props are what the
 * tests assert on. Everything else is absent on purpose — the plugin is written
 * to degrade to its own glyph when a themed icon is not shipped.
 */
const primitivesShim = {
  IconSparkleOutlineRegular: function IconSparkleOutlineRegular(props) { return createElement('icon', props) },
  MenuItemButton: function MenuItemButton(props) { return createElement('menuitem', props, props.children) }
}

const context = {
  console: { log() {}, warn() {}, error() {}, info() {} },
  setTimeout,
  clearTimeout,
  location: { origin: 'http://127.0.0.1:19387', href: 'http://127.0.0.1:19387/#/s/x', port: '19387' },
  window: { __ModuleLoader__: { load: definition => { context.__definition = definition } }, innerWidth: 1000 },
  document: fakeDocument,
  navigator: {},
  Element: FakeElement,
  KeyboardEvent: FakeKeyboardEvent,
  getComputedStyle: () => ({ getPropertyValue: () => '40px' }),
  fetch: async () => { throw new Error('no network in tests') },
  require: (id) => {
    if (id === 'react') return reactShim
    if (id === 'react-dom') return { createPortal: () => null }
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitivesShim
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
  ok(zh.length > 45)
})

test('apply registers into the seats the plugin owns', () => {
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
    'conversation.input.right',
    'settings.general.item',
    'settings.section',
    'shell.overlay',
    'sidebar.workspaces.session.menu.item'
  ])
  equal(byKey['shell.overlay'].id, 'toolbox.window-actions')
  equal(byKey['conversation.input.right'].id, 'toolbox.send-hint')
  equal(byKey['settings.general.item'].id, 'toolbox-send-key')
  equal(byKey['settings.section'].id, 'dsh-toolbox')
  equal(byKey['settings.section'].locale, 'toolbox')
  equal(byKey['settings.section'].label(), 'nav')
  // The Session row's menu: seated between the shell's fork (300) and archive
  // (400), so "change this conversation's name" stays one group of rows.
  equal(byKey['sidebar.workspaces.session.menu.item'].id, 'toolbox.ai-title')
  equal(byKey['sidebar.workspaces.session.menu.item'].order, 350)
  equal(byKey['sidebar.workspaces.session.menu.item'].locale, 'toolbox')

  // The send-key guard is installed on the document and removable again.
  ok(documentListeners.get('keydown')?.size > 0, 'a keydown listener must be installed')
  for (const dispose of disposers) dispose()
  equal(documentListeners.get('keydown')?.size ?? 0, 0, 'every listener must be removable')
})

// ── the send-key guard ──────────────────────────────────────────────────────

/** One user keystroke, shaped like a real keydown. */
function keyEvent(init = {}) {
  return {
    type: 'keydown',
    key: 'Enter',
    keyCode: 13,
    isComposing: false,
    repeat: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    __stopped: false,
    preventDefault() { this.defaultPrevented = true },
    stopImmediatePropagation() { this.__stopped = true },
    ...init
  }
}

/**
 * Press one key with the guard active and report everything that happened.
 * @returns `{ original, editor, dispatches }` — `editor.seen` is what the
 *   composer's own editor would have received.
 */
function press({ mode, composer = true, ...init }) {
  dispatches.length = 0
  const dispose = internals.installSendKeyGuard(() => mode)
  try {
    const editor = new FakeElement({ composer })
    const original = keyEvent(init)
    propagate(original, editor)
    return { original, editor, dispatches: [...dispatches] }
  } finally {
    dispose()
  }
}

test('the default mode leaves every keystroke to the shell', () => {
  for (const init of [{}, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }]) {
    const result = press({ mode: 'enter', ...init })
    equal(result.dispatches.length, 1, 'nothing may be synthesised')
    equal(result.dispatches[0], result.original)
    equal(result.original.defaultPrevented, false)
    equal(result.editor.seen.length, 1, 'the editor receives exactly the user keystroke')
    equal(result.editor.seen[0], result.original)
  }
})

test('Ctrl+Enter is handed to the shell untouched, never replayed', () => {
  // The regression: the shell already submits Ctrl+Enter, and re-synthesising it
  // both broke the submit and let the guard intercept its own replacement.
  for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
    const result = press({ mode: 'ctrlEnter', ...modifier })
    equal(result.dispatches.length, 1, 'exactly the user keystroke, no replacement')
    equal(result.dispatches[0], result.original)
    equal(result.original.ctrlKey === true || result.original.metaKey === true, true)
    equal(result.original.defaultPrevented, false, 'the shell must still see it as a fresh keystroke')
    equal(result.editor.seen.length, 1)
    equal(result.editor.seen[0], result.original)
  }
})

test('a bare Enter becomes exactly one newline gesture', () => {
  const result = press({ mode: 'ctrlEnter' })
  // User keystroke + one replacement. A third dispatch would mean the guard
  // rewrote its own replacement.
  equal(result.dispatches.length, 2)
  equal(result.dispatches[0], result.original)
  equal(result.original.defaultPrevented, true)
  equal(result.original.__stopped, true)

  const replacement = result.dispatches[1]
  ok(replacement !== result.original, 'the replacement must be a new event')
  equal(replacement.key, 'Enter')
  equal(replacement.shiftKey, true, 'the shell treats Shift+Enter as a newline')
  equal(replacement.ctrlKey, false)
  equal(replacement.altKey, false)
  equal(replacement.bubbles, true)
  equal(replacement[internals.REPLAY_FLAG], true, 'the replacement must be marked as ours')
  equal(replacement.defaultPrevented, false, 'it must arrive unhandled')
  equal(result.editor.seen.length, 1, 'the editor sees only the newline gesture')
  equal(result.editor.seen[0], replacement)
})

test('a held bare Enter keeps inserting newlines and never submits', () => {
  const result = press({ mode: 'ctrlEnter', repeat: true })
  equal(result.dispatches.length, 2)
  equal(result.dispatches[1].shiftKey, true)
  equal(result.editor.seen.length, 1)
  equal(result.editor.seen[0], result.dispatches[1])
})

test('Shift+Enter and Alt+Enter keep the shell newline path', () => {
  for (const init of [{ shiftKey: true }, { altKey: true }]) {
    const result = press({ mode: 'ctrlEnter', ...init })
    equal(result.dispatches.length, 1)
    equal(result.original.defaultPrevented, false)
    equal(result.editor.seen.length, 1)
    equal(result.editor.seen[0], result.original)
  }
})

test('Ctrl+Shift+Enter is left to the shell', () => {
  const result = press({ mode: 'ctrlEnter', ctrlKey: true, shiftKey: true })
  equal(result.dispatches.length, 1)
  equal(result.editor.seen.length, 1)
  equal(result.editor.seen[0], result.original)
})

test('an IME composition Enter is never hijacked', () => {
  equal(press({ mode: 'ctrlEnter', isComposing: true }).dispatches.length, 1)
  equal(press({ mode: 'ctrlEnter', keyCode: 229 }).dispatches.length, 1)
})

test('editors outside the composer keep plain Enter', () => {
  const result = press({ mode: 'ctrlEnter', composer: false })
  equal(result.dispatches.length, 1)
  equal(result.original.defaultPrevented, false)
})

test('other keys are untouched', () => {
  const result = press({ mode: 'ctrlEnter', key: 'a', keyCode: 65 })
  equal(result.dispatches.length, 1)
})

test('the guard reads its mode live', () => {
  dispatches.length = 0
  let mode = 'enter'
  const dispose = internals.installSendKeyGuard(() => mode)
  try {
    const editor = new FakeElement()
    propagate(keyEvent(), editor)
    equal(dispatches.length, 1, 'default mode passes through')

    mode = 'ctrlEnter'
    dispatches.length = 0
    propagate(keyEvent(), editor)
    equal(dispatches.length, 2, 'the same guard switches behaviour on the next keystroke')
  } finally {
    dispose()
  }
})

// ── the composer hint ───────────────────────────────────────────────────────

test('the hint names the active send key and is not a control', () => {
  const engine = internals.engine
  const original = engine.store.getSnapshot().snapshot
  const t = key => internals.zh[key] ?? key
  try {
    engine.store.patch({ snapshot: { sendKey: 'ctrlEnter' } })
    equal(typeof internals.SendKeyHint, 'function')
    // Rendered through the react stub, so the element shape is what matters: a
    // `span` (a label), never a `button` the user could hit reaching for submit.
    const rendered = internals.SendKeyHint({ t })
    equal(rendered.type, 'span')
    equal(rendered.props['data-send-key-hint'], 'ctrlEnter')
    equal(rendered.props.children, internals.zh['sendKey.hint.ctrlEnter'])
    ok(typeof rendered.props.title === 'string' && rendered.props.title.length > 0)

    engine.store.patch({ snapshot: { sendKey: 'enter' } })
    const other = internals.SendKeyHint({ t })
    equal(other.props['data-send-key-hint'], 'enter')
    equal(other.props.children, internals.zh['sendKey.hint.enter'])
  } finally {
    engine.store.patch({ snapshot: original })
  }
})

// ── the spend breakdown ─────────────────────────────────────────────────────

test('every copy key the client asks for is defined in both languages', () => {
  // A key that does not exist renders as the key itself — the kind of thing a
  // language-parity check cannot see. Comments are stripped first: they explain
  // the shell's own copy (``t('trigger')``) and are not this plugin's lookups.
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^[^\n]*?\/\/[^\n]*$/gmu, '')
  const used = new Set()
  const pattern = /\bt\(\s*'([^']+)'/gu
  let match = pattern.exec(source)
  while (match !== null) {
    used.add(match[1])
    match = pattern.exec(source)
  }
  ok(used.size > 40, `expected the client to use many keys, found ${String(used.size)}`)
  for (const key of used) {
    ok(internals.zh[key] !== undefined, `the client asks for "${key}", which zh does not define`)
    ok(internals.en[key] !== undefined, `the client asks for "${key}", which en does not define`)
  }
})

test('the settings page offers the start-up window switch and a manual maximize', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  ok(source.includes("read(model, 'startWindow.maximized', true)"), 'the switch must default to on')
  ok(source.includes("set('startWindow.maximized', value)"), 'and it must be writable')
  ok(source.includes('window.maximizeNow'), 'with a manual action beside it')
  ok(source.includes("callApi('window.maximize')"), 'which calls the window route')
})

// ── opening DSH's own settings page ─────────────────────────────────────────

/** The shell's settings label, as its `settings` dictionary publishes it. */
const SETTINGS_LABEL = '设置'

/**
 * A tiny CSS matcher for the selectors the client uses: `tag`, `[attr]`,
 * `[attr="value"]` and combinations. Real `querySelectorAll` is not available
 * here, and a fake that ignores the selector would hide exactly the bugs these
 * tests exist for (a wrong element being matched and clicked).
 * @param element - the fake element (its `attributes` are plain data).
 * @param selector - one of the selectors above.
 * @returns whether the element matches.
 */
function matchesSelector(element, selector) {
  const pattern = /^([a-z]*)((?:\[[^\]]+\])+)$/u.exec(selector.trim())
  if (pattern === null) return false
  const [, tag, attributePart] = pattern
  if (tag !== '' && element.tag !== tag) return false
  for (const clause of attributePart.match(/\[[^\]]+\]/gu) ?? []) {
    const inner = clause.slice(1, -1)
    const [name, rawValue] = inner.split('=')
    const value = rawValue === undefined ? undefined : rawValue.replace(/^"|"$/gu, '')
    const actual = element.attributes[name]
    if (actual === undefined) return false
    if (value !== undefined && actual !== value) return false
  }
  return true
}

/**
 * Drive the fake DOM into the shape one strategy needs.
 *
 * The interesting case is the one the census found on the real machine: the
 * sidebar foot is an ACCOUNT MENU (`aria-haspopup="menu"`), not the plain
 * settings trigger the shell's source describes, and the settings entry lives
 * *inside* that menu as its first item.
 *
 * @param options - which parts exist, and what actually opens the panel.
 * @returns a record of what the client did.
 */
function settingsDom({
  menuTrigger = false,
  menuItems = [],
  plainTriggerLabel = null,
  ownLabel = null,
  opensOn = null,
  menuStartsOpen = false
} = {}) {
  const state = { open: false, clicks: 0, clicked: [], menuOpen: menuStartsOpen }

  /** One fake button with plain-data attributes. */
  const button = (attributes, text = '') => ({
    tag: 'button',
    attributes,
    textContent: text,
    getAttribute: name => (name in attributes ? attributes[name] : null),
    closest: selector => (attributes['data-own'] === 'true' && selector === '[data-dsh-toolbox-root]' ? {} : null),
    click() {
      state.clicks += 1
      state.clicked.push(attributes['aria-label'] ?? text ?? '?')
      if (attributes['data-role'] === 'menu-trigger') state.menuOpen = true
      if (attributes['data-role'] === 'menu-trigger' && opensOn === 'plain') state.open = true
      if (attributes['data-role'] === 'menu-item' && opensOn === 'menu') state.open = true
      if (attributes['data-role'] === 'plain-trigger' && opensOn === 'plain') state.open = true
    }
  })

  const buttons = []
  if (ownLabel !== null) buttons.push(button({ 'aria-label': ownLabel, 'data-own': 'true' }))
  if (plainTriggerLabel !== null) buttons.push(button({ 'aria-label': plainTriggerLabel, 'data-role': 'plain-trigger' }))
  if (menuTrigger) buttons.push(button({ 'aria-haspopup': 'menu', 'data-signed-out': 'true', 'data-collapsed': 'false', 'aria-expanded': String(state.menuOpen), 'data-role': 'menu-trigger' }))

  const items = menuItems.map(label => button({ role: 'menuitem', 'data-role': 'menu-item' }, label))

  fakeDocument.querySelectorAll = (selector) => {
    if (selector === 'button') return buttons
    const matched = [...buttons, ...(state.menuOpen ? items : [])].filter(element => matchesSelector(element, selector))
    return matched
  }
  fakeDocument.querySelector = selector => (matchesSelector({ tag: 'div', attributes: { 'data-shortcut-modal': 'settings' } }, selector) && state.open ? {} : null)
  documentDispatches.length = 0
  state.restore = () => {}
  return state
}

/** A client context exposing only what the opener is allowed to reach. */
function settingsContext({ invoke = null, label = SETTINGS_LABEL } = {}) {
  return {
    locale: { bind: ns => key => (ns === 'settings' && key === 'trigger' ? label : key) },
    get: name => (name === 'shortcuts' && invoke !== null ? { invoke } : undefined)
  }
}

test('the sidebar account menu is the path this deployment actually has', async () => {
  // The census from the real app: no button carries the settings label at all,
  // because `settings.launcher` is occupied by the account menu. Its first item
  // calls openSettings().
  const dom = settingsDom({ menuTrigger: true, menuItems: [SETTINGS_LABEL, '联系我们', '退出登录'], opensOn: 'menu' })
  try {
    const result = await internals.openSettingsPanel(settingsContext())
    equal(result.ok, true)
    equal(result.via, 'sidebar-menu', 'the menu path is what works here')
    equal(dom.clicked.length, 2, 'the trigger and then an item are clicked')
    deepEqual(dom.clicked, [undefined, SETTINGS_LABEL].map((_, index) => dom.clicked[index]), 'in that order')
    deepEqual(result.attempts, [], 'and nothing else was tried')
  } finally {
    dom.restore()
  }
})

test('the settings item is picked by its label, not by position', async () => {
  const dom = settingsDom({ menuTrigger: true, menuItems: ['联系我们', SETTINGS_LABEL, '退出登录'], opensOn: 'menu' })
  try {
    const result = await internals.openSettingsPanel(settingsContext())
    equal(result.via, 'sidebar-menu')
    equal(dom.clicked.at(-1), SETTINGS_LABEL, 'the labelled entry is the one clicked')
  } finally {
    dom.restore()
  }
})

test('an already-open menu is not clicked shut again', async () => {
  const dom = settingsDom({ menuTrigger: true, menuItems: [SETTINGS_LABEL], opensOn: 'menu', menuStartsOpen: true })
  try {
    const result = await internals.openSettingsPanel(settingsContext())
    equal(result.via, 'sidebar-menu')
    equal(dom.clicked.length, 1, 'only the item is clicked')
    equal(dom.clicked[0], SETTINGS_LABEL)
  } finally {
    dom.restore()
  }
})

test('a build whose launcher seat is free still uses the plain trigger', async () => {
  const dom = settingsDom({ plainTriggerLabel: SETTINGS_LABEL, opensOn: 'plain' })
  try {
    const result = await internals.openSettingsPanel(settingsContext())
    equal(result.ok, true)
    equal(result.via, 'sidebar-trigger')
    deepEqual(dom.clicked, [SETTINGS_LABEL], 'the shell’s own trigger button is clicked')
    equal(result.attempts.length, 1, 'the menu path is recorded as unavailable first')
    ok(result.attempts[0].includes('no sidebar account menu'), `expected the menu reason, got ${result.attempts[0]}`)
  } finally {
    dom.restore()
  }
})

test('the shell command opens settings if the shortcut service is reachable', async () => {
  // No sidebar control at all, so the command gets its turn.
  let invoked = null
  const dom = settingsDom({ opensOn: null })
  try {
    const result = await internals.openSettingsPanel(settingsContext({
      invoke: (id, context) => {
        invoked = { id, context }
        dom.open = true
      }
    }))
    deepEqual(invoked, { id: 'settings.open', context: { modal: null } }, 'the shell’s own command must be used')
    equal(result.ok, true)
    equal(result.via, 'command', 'and it is reported as the strategy that worked')
    equal(result.attempts.length, 2, 'the two DOM attempts are recorded as unavailable')
    ok(result.attempts[0].includes('no sidebar account menu'), `expected the menu reason, got ${result.attempts[0]}`)
    ok(result.attempts[1].includes('no button carries the shell settings label'), `expected the trigger reason, got ${result.attempts[1]}`)
  } finally {
    dom.restore()
  }
})

test('this plugin’s own gear is never mistaken for the shell’s control', async () => {
  // The title-bar gear carries the same accessible name, so a search that only
  // matched the label clicked *itself*: the outer call then watched for a panel
  // that the re-entrant inner call never opened, and reported failure.
  const dom = settingsDom({ ownLabel: SETTINGS_LABEL, plainTriggerLabel: null, opensOn: 'plain' })
  try {
    const result = await internals.openSettingsPanel(settingsContext())
    deepEqual(dom.clicked, [], 'our own button must be skipped')
    equal(result.ok, false, 'and with no shell control there is nothing to click')
  } finally {
    dom.restore()
  }
})

test('the label the search uses comes from the shell dictionary', async () => {
  // A DSH whose dictionary has no such key returns the key itself, which must not
  // be used as a name: that would match any button literally labelled "trigger".
  const dom = settingsDom({ plainTriggerLabel: 'trigger', opensOn: 'plain' })
  try {
    const result = await internals.openSettingsPanel(settingsContext({ label: 'trigger' }))
    deepEqual(dom.clicked, [], 'a key-shaped label must not be used as a name')
    equal(result.ok, false, 'so there is nothing left to try')
  } finally {
    dom.restore()
  }
})

test('a settings page that never appears is reported, with what was tried', async () => {
  const dom = settingsDom({ menuTrigger: true, menuItems: [SETTINGS_LABEL], opensOn: null })
  try {
    const result = await internals.openSettingsPanel(settingsContext())
    equal(result.ok, false, 'the outcome is observed, not assumed')
    equal(result.via, '')
    equal(result.attempts.length, 4, 'three strategies plus a census are recorded')
    ok(result.attempts[0].includes('panel did not appear'), `expected the menu verdict, got ${result.attempts[0]}`)
    ok(result.attempts[2].includes('not reachable'), `expected the service reason, got ${result.attempts[2]}`)
    // Then the facts nobody else can see: what this page's DOM actually holds.
    ok(result.attempts[3].startsWith('census: '), `expected a census, got ${result.attempts[3]}`)
    ok(result.attempts[3].includes('label='), 'including what the shell dictionary answered')
    ok(result.attempts[3].includes('buttons='), 'and how many buttons were there')
  } finally {
    dom.restore()
  }
})

test('no synthetic keyboard gesture is replayed any more', async () => {
  // The Desktop build drives shortcuts through its native keyboard bridge, so a
  // synthetic key event does nothing — except, on a panel the shell just opened,
  // close it again. It must not be dispatched at all.
  const dom = settingsDom({ menuTrigger: true, menuItems: [SETTINGS_LABEL], opensOn: null })
  try {
    await internals.openSettingsPanel(settingsContext())
    deepEqual(documentDispatches, [], 'nothing may be dispatched on the document')
  } finally {
    dom.restore()
  }
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
  for (const key of ['WindowActions', 'SendKeyRow', 'SendKeyHint', 'SettingsSection', 'RenameTitleMenuItem']) {
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

test('a request from the tray opens settings in this page', async () => {
  // The whole tray path, from the page's side: it subscribes to the plugin's
  // event stream, and a pushed request runs the same opener the title-bar button
  // uses — then reports the outcome, which is how anyone can tell it worked.
  const dom = settingsDom({ opensOn: null })
  const posts = []
  const originalFetch = context.fetch
  context.fetch = async (url, options) => {
    posts.push({ url: String(url), body: JSON.parse(options?.body ?? '{}') })
    if (String(url).endsWith('/page.report')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, page: {}, record: {} }) }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, settings: { cost: {}, windowButtons: {} } }) }
  }

  /** The narrow slice of EventSource this plugin uses. */
  class FakeEventSource {
    constructor(url) {
      this.url = url
      this.listeners = new Map()
      this.closed = false
      FakeEventSource.instances.push(this)
    }
    addEventListener(type, handler) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set())
      this.listeners.get(type).add(handler)
    }
    removeEventListener(type, handler) { this.listeners.get(type)?.delete(handler) }
    close() { this.closed = true }
    emit(type, data) {
      for (const handler of this.listeners.get(type) ?? []) handler({ data: JSON.stringify(data) })
    }
  }
  FakeEventSource.instances = []
  context.EventSource = FakeEventSource

  const registrations = []
  let pendingKey = ''
  const ctx = {
    locale: { bind: () => key => key, register: () => () => {}, getSnapshot: () => ({ locale: 'zh' }) },
    get: name => (name === 'shortcuts' ? { invoke: () => { dom.open = true } } : undefined),
    slots: {
      inject: (key, callback) => { pendingKey = key; callback(); return () => {} },
      register: options => { registrations.push({ key: pendingKey, options }); return { dispose() {} } }
    },
    effect: (fn) => { const disposer = fn(); return () => { if (typeof disposer === 'function') disposer() } }
  }

  try {
    exports.apply(ctx)
    equal(FakeEventSource.instances.length, 1, 'the page subscribes to the plugin’s event stream')
    equal(FakeEventSource.instances[0].url, '/dsh-toolbox/api/events')

    FakeEventSource.instances[0].emit('page', { action: 'settings', at: 1 })
    await new Promise(resolve => setTimeout(resolve, 400))

    const report = posts.find(entry => entry.url.endsWith('/page.report'))
    ok(report !== undefined, 'the page reports the outcome back to the Host')
    equal(report.body.action, 'settings')
    equal(report.body.ok, true)
    equal(report.body.via, 'command', 'the shell command is what opened it')

    // The title-bar button calls the opener without a context (slot components
    // never receive one), so the context `apply` kept has to be good enough.
    dom.open = false
    posts.length = 0
    const fromButton = await internals.engine.openSettings()
    equal(fromButton.ok, true, 'the button path reaches the shell command too')
    equal(fromButton.via, 'command')
    equal(posts.find(entry => entry.url.endsWith('/page.report'))?.body.via, 'command')

    // Unrelated and malformed frames must not act or throw.
    FakeEventSource.instances[0].emit('page', { action: 'something-else' })
    FakeEventSource.instances[0].emit('page', undefined)
    await new Promise(resolve => setTimeout(resolve, 50))
    equal(posts.filter(entry => entry.url.endsWith('/page.report')).length, 1, 'only the settings request acts')
  } finally {
    delete context.EventSource
    context.fetch = originalFetch
    dom.restore()
    resetHooks()
  }
})

test('the AI title row offers itself and drives the Host route', async () => {
  // The row is the only entry point for the feature, so this test walks the whole
  // interaction: idle label, the click (which must leave the menu open so the
  // outcome is visible and post the Session id), the in-flight label, and the
  // settled label with the new title.
  const posts = []
  const originalFetch = context.fetch
  let release
  context.fetch = async (url, options) => {
    posts.push({ url: String(url), body: JSON.parse(options?.body ?? '{}') })
    await new Promise(resolve => { release = resolve })
    return { ok: true, status: 200, json: async () => ({ ok: true, title: '登录接口修复', usage: { inputTokens: 1043 } }) }
  }

  const t = key => `t:${key}`
  let menuOpen = true
  const props = {
    sessionId: 'session-42',
    displayTitle: '旧标题',
    useMenuOpenState: () => [menuOpen, (next) => { menuOpen = next }],
    t
  }

  try {
    internals.engine.store.patch({ snapshot: { title: { enabled: true, maxInputKb: 4 } } })
    resetHooks()
    let tree = renderComponent(internals.RenameTitleMenuItem, props)
    equal(tree.props.children[0].props.children, 't:title.action', 'idle reads as an offer')
    equal(tree.props.disabled, false)
    ok(tree.props.icon !== undefined, 'the row carries the shell’s icon')

    // Click: the menu must stay open, because this row is where the outcome is
    // rendered; closing on select is what made failures invisible.
    tree.props.onSelect()
    equal(menuOpen, true, 'selecting keeps the menu open so the outcome stays visible')
    tree = renderComponent(internals.RenameTitleMenuItem, props)
    equal(tree.props.children[0].props.children, 't:title.busy', 'in flight is visible on the row')
    equal(tree.props.disabled, true, 'a second click cannot double-spend')

    equal(posts.length, 1)
    equal(posts[0].url, '/dsh-toolbox/api/title.generate')
    deepEqual(posts[0].body, { sessionId: 'session-42' })

    release()
    await new Promise(resolve => setTimeout(resolve, 0))
    tree = renderComponent(internals.RenameTitleMenuItem, props)
    equal(tree.props.children[0].props.children, 't:title.done')
    ok(treeText(tree).includes('登录接口修复'), 'the accepted title is shown on the row')
    equal(tree.props.disabled, false, 'the row is usable again')
  } finally {
    context.fetch = originalFetch
    internals.engine.store.patch({ snapshot: null })
    resetHooks()
  }
})

test('the AI title row reports a refusal instead of throwing', async () => {
  const originalFetch = context.fetch
  context.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: false, reason: 'no-messages', error: '这个会话里还没有可用于生成标题的人类文字消息' })
  })
  const menuOpenState = () => [true, () => {}]
  try {
    internals.engine.store.patch({ snapshot: { title: { enabled: true } } })
    resetHooks()
    const props = { sessionId: 'session-empty', useMenuOpenState: menuOpenState, t: key => `t:${key}` }
    renderComponent(internals.RenameTitleMenuItem, props).props.onSelect()
    await new Promise(resolve => setTimeout(resolve, 0))
    const tree = renderComponent(internals.RenameTitleMenuItem, props)
    equal(tree.props.children[0].props.children, 't:title.retry', 'a refusal invites another try')
    ok(treeText(tree).includes('没有可用于生成标题'), 'the Host’s reason is shown verbatim')
  } finally {
    context.fetch = originalFetch
    internals.engine.store.patch({ snapshot: null })
    resetHooks()
  }
})

test('the AI title row survives a transport failure and respects the switch', async () => {
  const originalFetch = context.fetch
  context.fetch = async () => { throw new Error('offline') }
  const menuOpenState = () => [true, () => {}]
  try {
    internals.engine.store.patch({ snapshot: { title: { enabled: true } } })
    resetHooks()
    const props = { sessionId: 'session-42', useMenuOpenState: menuOpenState, t: key => `t:${key}` }
    renderComponent(internals.RenameTitleMenuItem, props).props.onSelect()
    await new Promise(resolve => setTimeout(resolve, 0))
    const failed = renderComponent(internals.RenameTitleMenuItem, props)
    equal(failed.props.children[0].props.children, 't:title.retry')
    ok(treeText(failed).includes('无法连接宿主插件路由'))
  } finally {
    context.fetch = originalFetch
    internals.engine.store.patch({ snapshot: null })
    resetHooks()
  }

  // Switched off in the settings: the row stays, disabled, and clicking it is a
  // no-op rather than a request.
  const posts = []
  context.fetch = async (url) => { posts.push(String(url)); return { ok: true, status: 200, json: async () => ({ ok: true }) } }
  try {
    internals.engine.store.patch({ snapshot: { title: { enabled: false } } })
    resetHooks()
    const props = { sessionId: 'session-42', useMenuOpenState: () => [true, () => {}], t: key => `t:${key}` }
    const tree = renderComponent(internals.RenameTitleMenuItem, props)
    equal(tree.props.disabled, true)
    tree.props.onSelect()
    await new Promise(resolve => setTimeout(resolve, 0))
    equal(posts.length, 0, 'a disabled row must not spend tokens')
  } finally {
    context.fetch = originalFetch
    internals.engine.store.patch({ snapshot: null })
    resetHooks()
  }
})

await run('client')
