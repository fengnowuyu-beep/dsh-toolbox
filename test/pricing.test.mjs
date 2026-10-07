/** Pricing: the shipped table, the vendor-page reader, peak hours, and conversion. */

import { readFileSync } from 'node:fs'

import { close, deepEqual, equal, ok, run, test } from './harness.mjs'
import {
  BUILTIN_PRICES,
  builtinPriceDocument,
  canonicalModelName,
  convertAmount,
  isPeakInstant,
  isPriceDocumentStale,
  mergePriceDocuments,
  normalizeExternalJson,
  normalizePriceDocument,
  parseDeepSeekPricingHtml,
  parseHtmlTables,
  priceEntryFor,
  rateFor,
  refreshPrices
} from '../lib/pricing.js'

const fixture = name => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

test('the shipped table carries both published currencies', () => {
  const document = builtinPriceDocument()
  ok(document.label.length > 0)
  for (const model of ['deepseek-flash', 'deepseek-v4-pro']) {
    const entry = priceEntryFor(document, model)
    ok(entry !== null, `${model} must be priced`)
    for (const currency of ['USD', 'CNY']) {
      ok(entry[currency].cacheHit.offPeak > 0, `${model}/${currency} cache hit`)
      ok(entry[currency].output.peak > entry[currency].output.offPeak, `${model}/${currency} peak > off-peak`)
    }
  }
  close(BUILTIN_PRICES.models['deepseek-flash'].CNY.output.peak, 8)
  close(BUILTIN_PRICES.models['deepseek-v4-pro'].USD.output.peak, 3.96)
})

test('a merged document is detached from the frozen shipped table', () => {
  const copy = builtinPriceDocument()
  copy.models['deepseek-flash'].USD.output.peak = 99
  close(BUILTIN_PRICES.models['deepseek-flash'].USD.output.peak, 1.2)
})

test('verbatim shipped values cannot be mutated', () => {
  ok(Object.isFrozen(BUILTIN_PRICES))
  ok(Object.isFrozen(BUILTIN_PRICES.models['deepseek-flash'].USD.output))
})

test('peak hours are the published windows, in UTC, on weekdays', () => {
  const document = builtinPriceDocument()
  // Friday 02:00 UTC is inside 01:00-04:00.
  equal(isPeakInstant(Date.parse('2026-10-09T02:00:00Z'), document), true)
  // Friday 05:00 UTC is between windows.
  equal(isPeakInstant(Date.parse('2026-10-09T05:00:00Z'), document), false)
  // Saturday 02:00 UTC is a weekend hour despite the clock.
  equal(isPeakInstant(Date.parse('2026-10-10T02:00:00Z'), document), false)
  // Sunday 07:00 UTC is inside 06:00-10:00 but still a weekend.
  equal(isPeakInstant(Date.parse('2026-10-11T07:00:00Z'), document), false)
  // Monday 06:00 UTC opens the second window exactly.
  equal(isPeakInstant(Date.parse('2026-10-12T06:00:00Z'), document), true)
  // Monday 10:00 UTC closes it exactly.
  equal(isPeakInstant(Date.parse('2026-10-12T10:00:00Z'), document), false)
})

test('rateFor prefers the display currency and falls back to the other one', () => {
  const entry = priceEntryFor(builtinPriceDocument(), 'deepseek-flash')
  close(rateFor(entry, 'CNY', 'output', false), 4)
  close(rateFor(entry, 'CNY', 'output', true), 8)
  close(rateFor(entry, 'USD', 'output', false), 0.6)
  // No cache-write line exists on the vendor list: it is billed as a miss.
  close(rateFor(entry, 'CNY', 'cacheWrite', false), 1)
  equal(rateFor(null, 'CNY', 'output', false), null)
})

test('retired model names still price at their successor', () => {
  equal(canonicalModelName('deepseek-v4-flash'), 'deepseek-flash')
  equal(canonicalModelName('DeepSeek-Reasoner'), 'deepseek-flash')
  equal(canonicalModelName('deepseek-v4-pro'), 'deepseek-v4-pro')
  ok(priceEntryFor(builtinPriceDocument(), 'deepseek/deepseek-flash') !== null)
  equal(priceEntryFor(builtinPriceDocument(), 'gpt-5'), null)
})

test('currency conversion is symmetric', () => {
  close(convertAmount(1, 'USD', 'CNY', 7.1), 7.1)
  close(convertAmount(7.1, 'CNY', 'USD', 7.1), 1)
  close(convertAmount(5, 'CNY', 'CNY', 7.1), 5)
  close(convertAmount(2, 'USD', 'CNY', 0), 14.2, 1e-9, 'a zero rate falls back')
})

test('table grids honour colspan and rowspan', () => {
  const [grid] = parseHtmlTables('<table><tr><td colspan="2">a</td><td>b</td></tr><tr><td rowspan="2">c</td><td>d</td><td>e</td></tr><tr><td>f</td><td>g</td></tr></table>')
  deepEqual(grid, [['a', 'a', 'b'], ['c', 'd', 'e'], ['c', 'f', 'g']])
})

test('the vendor page reader finds both models in both currencies', () => {
  const usd = parseDeepSeekPricingHtml(fixture('deepseek-pricing.en.html'), 'USD', 'en')
  const cny = parseDeepSeekPricingHtml(fixture('deepseek-pricing.zh.html'), 'CNY', 'zh')
  ok(usd !== null, 'the English page must parse')
  ok(cny !== null, 'the Chinese page must parse')

  const merged = mergePriceDocuments(
    normalizePriceDocument(usd, BUILTIN_PRICES),
    normalizePriceDocument(cny, BUILTIN_PRICES)
  )
  const flash = priceEntryFor(merged, 'deepseek-flash')
  close(flash.USD.cacheHit.offPeak, 0.003)
  close(flash.USD.cacheMiss.peak, 0.3)
  close(flash.USD.output.peak, 1.2)
  close(flash.CNY.cacheHit.offPeak, 0.02)
  close(flash.CNY.cacheMiss.offPeak, 1)
  close(flash.CNY.output.peak, 8)
  const pro = priceEntryFor(merged, 'deepseek-v4-pro')
  close(pro.CNY.output.peak, 27)
  close(pro.USD.cacheMiss.peak, 1.32)
})

test('the vendor page reader ignores tables that are not the model list', () => {
  equal(parseDeepSeekPricingHtml('<table><tr><td>hello</td></tr></table>', 'USD', 'x'), null)
  equal(parseDeepSeekPricingHtml('', 'USD', 'x'), null)
  equal(parseDeepSeekPricingHtml('<table></table>', 'EUR', 'x'), null, 'only the two published currencies')
})

test('a malformed document is refused rather than half-applied', () => {
  equal(normalizePriceDocument(null), null)
  equal(normalizePriceDocument({ models: {} }), null)
  equal(normalizePriceDocument({ models: { a: { USD: { cacheHit: { offPeak: 1, peak: 2 } } } } }), null)
  const partial = normalizePriceDocument({
    models: {
      a: { USD: { cacheHit: { offPeak: 1, peak: 2 }, cacheMiss: { offPeak: 3, peak: 4 }, output: { offPeak: 5, peak: 6 } } },
      b: 'nonsense'
    }
  })
  ok(partial !== null)
  deepEqual(Object.keys(partial.models), ['a'])
})

test('a three-field JSON map is accepted as an external price source', () => {
  const document = normalizePriceDocument(normalizeExternalJson({
    currency: 'CNY',
    models: {
      'deepseek-flash': { cacheHit: 0.02, cacheMiss: 1, output: 4 },
      'deepseek-v4-pro': { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5, displayName: 'Pro' }
    }
  }), BUILTIN_PRICES)
  const flash = priceEntryFor(document, 'deepseek-flash')
  close(flash.CNY.cacheMiss.offPeak, 1)
  close(flash.CNY.cacheMiss.peak, 1, 1e-9, 'a flat rate applies to both periods')
  equal(priceEntryFor(document, 'deepseek-v4-pro').displayName, 'Pro')
})

test('a per-1K JSON source is rescaled', () => {
  const document = normalizePriceDocument(normalizeExternalJson({
    currency: 'USD',
    unit: 1000,
    models: { m: { cacheHit: 0.001, cacheMiss: 0.002, output: 0.003 } }
  }), BUILTIN_PRICES)
  close(priceEntryFor(document, 'm').USD.output.peak, 3)
})

test('staleness follows the configured window', () => {
  const now = Date.parse('2026-10-09T00:00:00Z')
  ok(isPriceDocumentStale({ updatedAt: '2026-10-01T00:00:00Z' }, 168, now) === true)
  ok(isPriceDocumentStale({ updatedAt: '2026-10-08T12:00:00Z' }, 168, now) === false)
  ok(isPriceDocumentStale(null, 168, now) === true)
  ok(isPriceDocumentStale({ updatedAt: 'not a date' }, 168, now) === true)
})

test('a refresh reads both published pages and reports its attempts', async () => {
  const seen = []
  const fetchImpl = async (url) => {
    seen.push(url)
    const body = url.includes('/zh-cn/') ? fixture('deepseek-pricing.zh.html') : fixture('deepseek-pricing.en.html')
    return { ok: true, status: 200, text: async () => body }
  }
  const result = await refreshPrices({ source: 'auto', fetchImpl, now: () => Date.parse('2026-10-09T00:00:00Z') })
  ok(result.document !== null, result.error)
  equal(seen.length, 2)
  equal(result.document.source, 'deepseek-docs')
  equal(result.document.updatedAt, '2026-10-09T00:00:00.000Z')
  close(priceEntryFor(result.document, 'deepseek-flash').CNY.output.offPeak, 4)
})

test('a refresh failure keeps the caller on the previous table', async () => {
  const result = await refreshPrices({
    source: 'auto',
    fetchImpl: async () => { throw new Error('offline') },
    logger: { warn: () => {} }
  })
  equal(result.document, null)
  ok(result.error.includes('offline'))
  equal(result.attempts.length, 2)
})

test('a json source without a URL is refused before any request', async () => {
  let called = 0
  const result = await refreshPrices({ source: 'json', pricingUrl: '', fetchImpl: async () => { called += 1 } })
  equal(called, 0)
  equal(result.document, null)
  ok(result.error.length > 0)
})

test('the builtin source never touches the network', async () => {
  let called = 0
  const result = await refreshPrices({ source: 'builtin', fetchImpl: async () => { called += 1 } })
  equal(called, 0)
  equal(result.document, null)
})

await run('pricing')
