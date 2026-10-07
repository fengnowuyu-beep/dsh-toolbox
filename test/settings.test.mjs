/** Settings contract: normalization, layering, and the persistence round-trip. */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { close, deepEqual, equal, ok, run, test } from './harness.mjs'
import {
  composeSettings,
  DEFAULTS,
  loadPersisted,
  normalizeSettings,
  publicSettings,
  resolveDshHome,
  savePersisted,
  settingsPath,
  SETTINGS_VERSION,
  stateDir
} from '../lib/settings.js'

test('defaults are complete and stable', () => {
  const settings = normalizeSettings({})
  equal(settings.version, SETTINGS_VERSION)
  equal(settings.sendKey, 'enter')
  equal(settings.windowButtons.restart, true)
  equal(settings.windowButtons.updateCheck, true)
  equal(settings.windowButtons.webFallback, false)
  equal(settings.cost.currency, 'CNY')
  equal(settings.cost.pricingSource, 'auto')
  equal(settings.cost.refreshHours, 168)
  equal(settings.tray.enabled, false)
  deepEqual(Object.keys(settings).sort(), Object.keys(DEFAULTS).sort())
})

test('hostile values fall back instead of reaching the rest of the plugin', () => {
  const settings = normalizeSettings({
    sendKey: 'space',
    updateCheckHours: -4,
    windowButtons: { restart: 'yes' },
    cost: { currency: 'EUR', usdCny: 0, refreshHours: 1e9, pricingSource: 'nope' },
    tray: { enabled: 'on' }
  })
  equal(settings.sendKey, 'enter')
  equal(settings.updateCheckHours, DEFAULTS.updateCheckHours)
  equal(settings.windowButtons.restart, true)
  equal(settings.cost.currency, 'CNY')
  equal(settings.cost.usdCny, DEFAULTS.cost.usdCny)
  equal(settings.cost.refreshHours, DEFAULTS.cost.refreshHours)
  equal(settings.cost.pricingSource, 'auto')
  equal(settings.tray.enabled, false)
})

test('numbers are clamped to their documented bands', () => {
  equal(normalizeSettings({ updateCheckHours: 0.1 }).updateCheckHours, DEFAULTS.updateCheckHours)
  equal(normalizeSettings({ updateCheckHours: 0.25 }).updateCheckHours, 0.25)
  equal(normalizeSettings({ updateCheckHours: 10_000 }).updateCheckHours, DEFAULTS.updateCheckHours)
  equal(normalizeSettings({ cost: { usdCny: 7.25 } }).cost.usdCny, 7.25)
  equal(normalizeSettings({ cost: { refreshHours: 1 } }).cost.refreshHours, 1)
})

test('a persisted scalar wins over the config layer, field by field', () => {
  const configured = { sendKey: 'ctrlEnter', cost: { currency: 'USD' }, updateCheckHours: 12 }
  const stored = { sendKey: 'enter' }
  const settings = composeSettings(stored, configured)
  equal(settings.sendKey, 'enter')
  equal(settings.cost.currency, 'USD')
  equal(settings.updateCheckHours, 12)
})

test('a stored nested object replaces the config one wholesale', () => {
  const settings = composeSettings(
    { cost: { currency: 'USD', enabled: false } },
    { cost: { currency: 'CNY', usdCny: 6.8, enabled: true } }
  )
  equal(settings.cost.currency, 'USD')
  equal(settings.cost.enabled, false)
  // A field the stored object does not carry still comes from the config layer.
  equal(settings.cost.usdCny, 6.8)
})

test('the effective document is always stamped current', () => {
  equal(composeSettings({ version: 99 }, {}).version, SETTINGS_VERSION)
})

test('DSH home resolution honours an explicit path, then the environment', () => {
  const previous = process.env.DSH_HOME
  try {
    delete process.env.DSH_HOME
    equal(resolveDshHome('/tmp/explicit'), '/tmp/explicit')
    ok(resolveDshHome(undefined).endsWith('.dsh'), 'the fallback home is ~/.dsh')
    process.env.DSH_HOME = ' /tmp/from-env '
    equal(resolveDshHome(''), '/tmp/from-env')
    equal(resolveDshHome('   '), '/tmp/from-env')
    equal(resolveDshHome('/tmp/explicit'), '/tmp/explicit', 'an explicit path outranks the environment')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('the settings document round-trips through disk', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-toolbox-settings-'))
  try {
    equal(settingsPath(home), join(home, 'toolbox', 'settings.json'))
    equal(stateDir(home), join(home, 'toolbox'))
    deepEqual(await loadPersisted(undefined, home), {})

    const written = normalizeSettings({ sendKey: 'ctrlEnter', cost: { currency: 'USD' } })
    await savePersisted(written, home)
    const reloaded = loadPersisted(undefined, home)
    equal(reloaded.sendKey, 'ctrlEnter')
    equal(reloaded.cost.currency, 'USD')
    const text = await readFile(settingsPath(home), 'utf8')
    ok(text.endsWith('\n'), 'the document should end with a newline')

    const view = publicSettings(written, home, { pluginVersion: '1.0.0' })
    equal(view.pluginVersion, '1.0.0')
    equal(view.settingsFile, settingsPath(home))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('an unreadable document yields defaults rather than an exception', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-toolbox-broken-'))
  try {
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(stateDir(home), { recursive: true })
    await writeFile(settingsPath(home), '{ not json', 'utf8')
    const warnings = []
    const reloaded = loadPersisted({ warn: message => warnings.push(message) }, home)
    deepEqual(reloaded, {})
    equal(warnings.length, 1)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

await run('settings')
close(0, 0)
