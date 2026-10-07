/**
 * Price tables for `dsh-toolbox`.
 *
 * The shipped table is DeepSeek's published list price for the two models the
 * official DeepSeek route serves (`deepseek-flash`, `deepseek-v4-pro`), in both
 * the USD and the CNY list the vendor publishes, including the off-peak/peak
 * split: peak hours are 01:00–04:00 and 06:00–10:00 UTC, Monday through Friday,
 * and every other hour is billed at half the peak rate.
 *
 * A fetched document may replace the shipped one. The `deepseek-docs` reader
 * parses the vendor's own pricing page — a real HTML table with merged cells —
 * so the table follows the vendor instead of a copy of it; `json` reads a
 * normalized document from any URL; `auto` tries the docs and keeps whatever
 * already worked when the network or the page shape is not what it was.
 *
 * @module dsh-toolbox/pricing
 */

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { OFFICIAL_PRICING_URLS, pricesPath } from './settings.js'

/** Format version of the normalized price document. */
export const PRICE_FORMAT_VERSION = 1

/** Every rate in this document is quoted per this many tokens. */
export const PRICE_UNIT = 1_000_000

/** Billing currencies the shipped table carries. */
export const PRICE_CURRENCIES = Object.freeze(['USD', 'CNY'])

/** Peak windows, in UTC, Monday through Friday. */
export const PEAK_WINDOWS_UTC = Object.freeze([
  Object.freeze({ start: '01:00', end: '04:00' }),
  Object.freeze({ start: '06:00', end: '10:00' })
])

/** Peak weekdays, as `Date#getUTCDay` values (1 = Monday … 5 = Friday). */
export const PEAK_WEEKDAYS_UTC = Object.freeze([1, 2, 3, 4, 5])

/**
 * Model aliases: the vendor still accepts retired names and bills them at the
 * successor's price, so a session log that names one is priced correctly.
 */
export const MODEL_ALIASES = Object.freeze({
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  'deepseek-chat': 'deepseek-flash',
  'deepseek-reasoner': 'deepseek-flash'
})

/** The table shipped with this build (DeepSeek list price as published 2026-10-08). */
export const BUILTIN_PRICES = Object.freeze({
  formatVersion: PRICE_FORMAT_VERSION,
  source: 'builtin',
  label: 'DeepSeek 官方标价（随插件附带）',
  // Deliberately a date that is already past: a future stamp would both read
  // wrong on the settings page and make the auto-refresh wait for it.
  updatedAt: '2026-10-08T00:00:00.000Z',
  unit: PRICE_UNIT,
  peakWindowsUtc: PEAK_WINDOWS_UTC,
  peakWeekdaysUtc: PEAK_WEEKDAYS_UTC,
  models: Object.freeze({
    'deepseek-flash': Object.freeze({
      displayName: 'DeepSeek-V4.1-Flash',
      USD: Object.freeze({
        cacheHit: Object.freeze({ offPeak: 0.003, peak: 0.006 }),
        cacheMiss: Object.freeze({ offPeak: 0.15, peak: 0.3 }),
        output: Object.freeze({ offPeak: 0.6, peak: 1.2 }),
        cacheWrite: null
      }),
      CNY: Object.freeze({
        cacheHit: Object.freeze({ offPeak: 0.02, peak: 0.04 }),
        cacheMiss: Object.freeze({ offPeak: 1, peak: 2 }),
        output: Object.freeze({ offPeak: 4, peak: 8 }),
        cacheWrite: null
      })
    }),
    'deepseek-v4-pro': Object.freeze({
      displayName: 'DeepSeek-V4-Pro-0813',
      USD: Object.freeze({
        cacheHit: Object.freeze({ offPeak: 0.022, peak: 0.044 }),
        cacheMiss: Object.freeze({ offPeak: 0.66, peak: 1.32 }),
        output: Object.freeze({ offPeak: 1.98, peak: 3.96 }),
        cacheWrite: null
      }),
      CNY: Object.freeze({
        cacheHit: Object.freeze({ offPeak: 0.15, peak: 0.3 }),
        cacheMiss: Object.freeze({ offPeak: 4.5, peak: 9 }),
        output: Object.freeze({ offPeak: 13.5, peak: 27 }),
        cacheWrite: null
      })
    })
  })
})

/** @returns a detached copy of the shipped table. */
export function builtinPriceDocument() {
  return JSON.parse(JSON.stringify(BUILTIN_PRICES))
}

/** Whether a value is a usable rate pair. */
function pairFrom(value) {
  if (value === null) return null
  if (value === undefined || typeof value !== 'object') return undefined
  const offPeak = Number(value.offPeak)
  const peak = Number(value.peak)
  if (!Number.isFinite(offPeak) || offPeak < 0) return undefined
  if (!Number.isFinite(peak) || peak < 0) return undefined
  return { offPeak, peak }
}

/**
 * Coerce anything a feed returned into one valid price document.
 * @param raw - candidate document.
 * @param fallback - document whose metadata fills the gaps.
 * @returns a normalized document, or null when nothing usable was found.
 */
export function normalizePriceDocument(raw, fallback = BUILTIN_PRICES) {
  if (raw === null || typeof raw !== 'object') return null
  const sourceModels = raw.models !== null && typeof raw.models === 'object' ? raw.models : null
  if (sourceModels === null) return null

  const models = {}
  for (const [rawName, rawEntry] of Object.entries(sourceModels)) {
    const name = String(rawName).trim().toLowerCase()
    if (name === '' || rawEntry === null || typeof rawEntry !== 'object') continue
    const entry = {}
    if (typeof rawEntry.displayName === 'string') entry.displayName = rawEntry.displayName
    for (const currency of PRICE_CURRENCIES) {
      const table = rawEntry[currency]
      if (table === null || typeof table !== 'object') continue
      const cacheHit = pairFrom(table.cacheHit)
      const cacheMiss = pairFrom(table.cacheMiss)
      const output = pairFrom(table.output)
      if (cacheHit === undefined || cacheMiss === undefined || output === undefined) continue
      if (cacheHit === null || cacheMiss === null || output === null) continue
      const cacheWrite = pairFrom(table.cacheWrite)
      entry[currency] = {
        cacheHit,
        cacheMiss,
        output,
        cacheWrite: cacheWrite === undefined ? null : cacheWrite
      }
    }
    if (Object.keys(entry).filter(key => key !== 'displayName').length === 0) continue
    models[name] = entry
  }
  if (Object.keys(models).length === 0) return null

  const updatedAt = typeof raw.updatedAt === 'string' && !Number.isNaN(Date.parse(raw.updatedAt))
    ? new Date(raw.updatedAt).toISOString()
    : new Date().toISOString()

  const windows = Array.isArray(raw.peakWindowsUtc)
    ? raw.peakWindowsUtc
        .map(item => ({
          start: typeof item?.start === 'string' ? item.start : '',
          end: typeof item?.end === 'string' ? item.end : ''
        }))
        .filter(item => /^\d{1,2}:\d{2}$/u.test(item.start) && /^\d{1,2}:\d{2}$/u.test(item.end))
    : []
  const weekdays = Array.isArray(raw.peakWeekdaysUtc)
    ? raw.peakWeekdaysUtc.map(Number).filter(day => Number.isInteger(day) && day >= 0 && day <= 6)
    : []

  return {
    formatVersion: PRICE_FORMAT_VERSION,
    source: typeof raw.source === 'string' && raw.source !== '' ? raw.source : fallback.source,
    label: typeof raw.label === 'string' && raw.label !== '' ? raw.label : fallback.label,
    updatedAt,
    unit: Number.isFinite(Number(raw.unit)) && Number(raw.unit) > 0 ? Number(raw.unit) : PRICE_UNIT,
    peakWindowsUtc: windows.length > 0 ? windows : fallback.peakWindowsUtc,
    peakWeekdaysUtc: weekdays.length > 0 ? weekdays : fallback.peakWeekdaysUtc,
    models,
    ...typeof raw.notes === 'string' && raw.notes !== '' ? { notes: raw.notes } : {}
  }
}

/**
 * Merge a partially parsed document into a base one, overriding per rate.
 * @param base - the document that already holds what worked.
 * @param addition - the freshly parsed document.
 * @returns the merged document.
 */
export function mergePriceDocuments(base, addition) {
  if (addition === null) return base
  const models = JSON.parse(JSON.stringify(base.models))
  for (const [name, entry] of Object.entries(addition.models)) {
    models[name] = { ...(models[name] ?? {}), ...entry }
  }
  return {
    ...base,
    ...addition,
    models,
    peakWindowsUtc: addition.peakWindowsUtc ?? base.peakWindowsUtc,
    peakWeekdaysUtc: addition.peakWeekdaysUtc ?? base.peakWeekdaysUtc
  }
}

/** Resolve one model name through the alias table. */
export function canonicalModelName(model) {
  const name = typeof model === 'string' ? model.trim().toLowerCase() : ''
  if (name === '') return ''
  if (MODEL_ALIASES[name] !== undefined) return MODEL_ALIASES[name]
  return name
}

/**
 * The price entry for one model id.
 * @param document - normalized document.
 * @param model - wire model id from a session log.
 * @returns the entry, or null when the model is not priced.
 */
export function priceEntryFor(document, model) {
  if (document === null || typeof document !== 'object') return null
  const models = document.models ?? {}
  const canonical = canonicalModelName(model)
  if (canonical !== '' && models[canonical] !== undefined) return models[canonical]
  // Fall back to a suffix match so a provider-prefixed id (`deepseek/deepseek-flash`) still prices.
  const tail = typeof model === 'string' ? model.trim().toLowerCase().split('/').pop() : ''
  if (tail !== '' && models[tail] !== undefined) return models[tail]
  return null
}

/** Parse `HH:MM` into minutes past midnight, or null. */
function minutesOfDay(text) {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(typeof text === 'string' ? text : '')
  if (match === null) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 24 || minutes > 59) return null
  return hours * 60 + minutes
}

/**
 * Whether one instant falls in a peak window.
 * @param timeMs - epoch milliseconds.
 * @param document - normalized document (its windows are UTC).
 * @returns true for peak, false for off-peak.
 */
export function isPeakInstant(timeMs, document = BUILTIN_PRICES) {
  const date = new Date(Number.isFinite(Number(timeMs)) ? Number(timeMs) : Date.now())
  const weekdays = Array.isArray(document?.peakWeekdaysUtc) && document.peakWeekdaysUtc.length > 0
    ? document.peakWeekdaysUtc
    : PEAK_WEEKDAYS_UTC
  if (!weekdays.includes(date.getUTCDay())) return false
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes()
  const windows = Array.isArray(document?.peakWindowsUtc) && document.peakWindowsUtc.length > 0
    ? document.peakWindowsUtc
    : PEAK_WINDOWS_UTC
  return windows.some((window) => {
    const start = minutesOfDay(window.start)
    const end = minutesOfDay(window.end)
    if (start === null || end === null) return false
    return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end
  })
}

/**
 * Resolve the rate for one billing line.
 * @param entry - a model entry.
 * @param currency - requested currency.
 * @param kind - `cacheHit` | `cacheMiss` | `cacheWrite` | `output`.
 * @param peak - whether the instant is a peak hour.
 * @returns the rate per {@link PRICE_UNIT} tokens, or null when unknown.
 */
export function rateFor(entry, currency, kind, peak) {
  if (entry === null || entry === undefined) return null
  const table = entry[currency]
  if (table === null || table === undefined) return null
  const pair = table[kind] ?? (kind === 'cacheWrite' ? table.cacheMiss : null)
  if (pair === null || pair === undefined) return null
  const value = peak ? pair.peak : pair.offPeak
  return Number.isFinite(value) ? value : null
}

/**
 * Convert an amount between the two supported currencies.
 * @param amount - source amount.
 * @param from - source currency.
 * @param to - target currency.
 * @param usdCny - fallback rate, CNY per USD.
 * @returns the converted amount.
 */
export function convertAmount(amount, from, to, usdCny) {
  const value = Number(amount)
  if (!Number.isFinite(value) || from === to) return Number.isFinite(value) ? value : 0
  const rate = Number.isFinite(Number(usdCny)) && Number(usdCny) > 0 ? Number(usdCny) : 7.1
  if (from === 'USD' && to === 'CNY') return value * rate
  if (from === 'CNY' && to === 'USD') return value / rate
  return value
}

/** Decode the handful of HTML entities the vendor's tables use. */
function decodeEntities(text) {
  return text
    .replace(/&nbsp;/giu, ' ')
    .replace(/&sup\d?;/giu, ' ')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&amp;/giu, '&')
}

/** Reduce one table cell's markup to a single line of text. */
function cellText(html) {
  return decodeEntities(String(html)
    .replace(/<br\s*\/?>/giu, ' ')
    .replace(/<[^>]*>/gu, ' '))
    .replace(/\s+/gu, ' ')
    .trim()
}

/**
 * Expand every `<table>` in a document into a dense text grid, honouring
 * `colspan`/`rowspan` so merged headers repeat into the rows they cover.
 * @param html - the document.
 * @returns an array of grids; each grid is an array of rows of strings.
 */
export function parseHtmlTables(html) {
  if (typeof html !== 'string' || html === '') return []
  const tables = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/giu)].map(match => match[1])
  return tables.map((tableHtml) => {
    const rows = [...tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu)].map(match => match[1])
    const filled = new Map()
    const grid = []
    rows.forEach((rowHtml, rowIndex) => {
      const cells = [...rowHtml.matchAll(/<t[hd]\b([^>]*)>([\s\S]*?)<\/t[hd]>/giu)]
      const row = []
      let column = 0
      const take = () => {
        while (filled.has(`${rowIndex},${column}`)) {
          row[column] = filled.get(`${rowIndex},${column}`)
          column += 1
        }
      }
      for (const cell of cells) {
        const attrs = cell[1] ?? ''
        const text = cellText(cell[2] ?? '')
        const colspan = Math.max(1, Number(/\bcolspan\s*=\s*["']?(\d+)/iu.exec(attrs)?.[1] ?? 1))
        const rowspan = Math.max(1, Number(/\browspan\s*=\s*["']?(\d+)/iu.exec(attrs)?.[1] ?? 1))
        take()
        for (let offset = 0; offset < colspan; offset += 1) {
          row[column + offset] = text
          for (let below = 1; below < rowspan; below += 1) {
            filled.set(`${rowIndex + below},${column + offset}`, text)
          }
        }
        column += colspan
      }
      take()
      grid.push(row)
    })
    const width = grid.reduce((max, row) => Math.max(max, row.length), 0)
    return grid.map(row => Array.from({ length: width }, (_, index) => row[index] ?? ''))
  })
}

/** Classify one metric label into a billing line. */
function metricKind(label) {
  const text = label.toLowerCase()
  if (/cache\s*(write|creation)|缓存(写入|创建)/iu.test(text)) return 'cacheWrite'
  if (/cache\s*miss|uncached|缓存未命中/iu.test(text)) return 'cacheMiss'
  if (/cache\s*(hit|read)|缓存命中/iu.test(text)) return 'cacheHit'
  if (/output|输出/iu.test(text)) return 'output'
  if (/input|输入/iu.test(text)) return 'cacheMiss'
  return null
}

/** Classify one billing-period label. */
function periodKind(label) {
  const text = label.toLowerCase()
  if (/off[\s-]*peak|空闲/iu.test(text)) return 'offPeak'
  if (/peak|高峰/iu.test(text)) return 'peak'
  return null
}

/** Read the first number out of a price cell. */
function numberFromCell(text) {
  const cleaned = String(text).replace(/[,，\s]/gu, '')
  const match = /(-?\d+(?:\.\d+)?)/u.exec(cleaned)
  if (match === null) return null
  const value = Number(match[1])
  return Number.isFinite(value) ? value : null
}

/**
 * Parse one DeepSeek pricing page into a partial price document.
 *
 * The page is one HTML table whose model header row names the models and whose
 * pricing block repeats a metric label (cache hit / cache miss / output) and a
 * period label (off-peak / peak) across a merged first column. The reader
 * therefore keys off the model header row rather than fixed coordinates, so a
 * renamed or reordered row still prices.
 * @param html - the page body.
 * @param currency - the currency that page quotes.
 * @param url - the page URL, recorded as the document source.
 * @returns `{ models, peakWindowsUtc, peakWeekdaysUtc }`, or null.
 */
export function parseDeepSeekPricingHtml(html, currency, url = '') {
  if (!PRICE_CURRENCIES.includes(currency)) return null
  const tables = parseHtmlTables(html)
  for (const grid of tables) {
    let headerRow = -1
    let modelColumns = []
    for (let rowIndex = 0; rowIndex < grid.length; rowIndex += 1) {
      const columns = []
      grid[rowIndex].forEach((cell, column) => {
        if (/^deepseek-[a-z0-9.-]+/iu.test(cell)) columns.push(column)
      })
      if (columns.length > 0) {
        headerRow = rowIndex
        modelColumns = columns
        break
      }
    }
    if (headerRow < 0) continue
    const firstModelColumn = Math.min(...modelColumns)
    const modelNames = new Map(modelColumns.map((column) => {
      const match = /^(deepseek-[a-z0-9.-]+)/iu.exec(grid[headerRow][column])
      return [column, match === null ? '' : match[1].toLowerCase()]
    }))

    const models = {}
    for (let rowIndex = headerRow + 1; rowIndex < grid.length; rowIndex += 1) {
      const row = grid[rowIndex]
      let kind = null
      let period = null
      for (let column = 0; column < firstModelColumn; column += 1) {
        const cell = row[column]
        if (cell === '') continue
        if (kind === null) {
          const candidate = metricKind(cell)
          if (candidate !== null) {
            kind = candidate
            continue
          }
        }
        if (period === null) {
          const candidate = periodKind(cell)
          if (candidate !== null) period = candidate
        }
      }
      if (kind === null || period === null) continue
      for (const [column, name] of modelNames) {
        if (name === '') continue
        const value = numberFromCell(row[column])
        if (value === null) continue
        const entry = models[name] ?? (models[name] = {})
        const table = entry[currency] ?? (entry[currency] = {})
        const line = table[kind] ?? (table[kind] = {})
        line[period] = value
      }
    }

    const usable = Object.entries(models).filter(([, entry]) => {
      const table = entry[currency]
      return table !== undefined && table.output !== undefined
    })
    if (usable.length === 0) continue
    const normalizedModels = {}
    for (const [name, entry] of usable) {
      normalizedModels[name] = { [currency]: entry[currency] }
    }
    return {
      models: normalizedModels,
      peakWindowsUtc: PEAK_WINDOWS_UTC,
      peakWeekdaysUtc: PEAK_WEEKDAYS_UTC,
      label: url === '' ? `DeepSeek 官方标价（${currency}）` : `DeepSeek 官方标价（${currency}，${url}）`,
      source: url === '' ? 'deepseek-docs' : url,
      updatedAt: new Date().toISOString()
    }
  }
  return null
}

/**
 * Read the cached price document.
 * @param dshHome - resolved harness home.
 * @param logger - optional logger.
 * @returns the normalized document, or null.
 */
export function loadCachedPrices(dshHome, logger) {
  const file = pricesPath(dshHome)
  try {
    if (!existsSync(file)) return null
    return normalizePriceDocument(JSON.parse(readFileSync(file, 'utf8')), BUILTIN_PRICES)
  } catch (error) {
    logger?.warn?.(`toolbox: cached prices unreadable: ${String(error)}`)
    return null
  }
}

/** Atomically persist a price document. */
export async function saveCachedPrices(dshHome, document) {
  const file = pricesPath(dshHome)
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  await rename(temporary, file)
}

/** Whether a cached document is older than the configured freshness window. */
export function isPriceDocumentStale(document, refreshHours, now = Date.now()) {
  if (document === null || typeof document !== 'object') return true
  const stamp = Date.parse(document.updatedAt ?? '')
  if (Number.isNaN(stamp)) return true
  const hours = Number.isFinite(Number(refreshHours)) && Number(refreshHours) > 0 ? Number(refreshHours) : 168
  return now - stamp > hours * 3600_000
}

/** Fetch one URL as text with a deadline. */
async function fetchText(fetchImpl, url, timeoutMs) {
  const response = await fetchImpl(url, {
    headers: {
      accept: 'text/html, application/json, text/plain, */*',
      'accept-language': 'en,zh-CN;q=0.9',
      'user-agent': 'dsh-toolbox'
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
  return await response.text()
}

/**
 * Fetch a fresh price table.
 * @param options - source, URLs, transport, deadline and logger.
 * @returns `{ document, error, attempts }`; `document` is null when nothing was fetched.
 */
export async function refreshPrices(options = {}) {
  const {
    source = 'auto',
    pricingUrl = '',
    fetchImpl = globalThis.fetch,
    timeoutMs = 20_000,
    logger,
    now = Date.now
  } = options
  const attempts = []
  if (source === 'builtin') return { document: null, error: '', attempts }

  if (typeof fetchImpl !== 'function') {
    return { document: null, error: 'no fetch implementation available', attempts }
  }

  if (source === 'json') {
    const url = typeof pricingUrl === 'string' ? pricingUrl.trim() : ''
    if (url === '') return { document: null, error: '未配置 JSON 计价地址', attempts }
    try {
      const text = await fetchText(fetchImpl, url, timeoutMs)
      const parsed = normalizePriceDocument(normalizeExternalJson(JSON.parse(text)), BUILTIN_PRICES)
      if (parsed === null) return { document: null, error: `${url} 中没有可识别的价格表`, attempts: [url] }
      return { document: { ...parsed, source: url, updatedAt: new Date(now()).toISOString() }, error: '', attempts: [url] }
    } catch (error) {
      const message = `${url} → ${String(error?.message ?? error)}`
      logger?.warn?.(`toolbox: price refresh failed: ${message}`)
      return { document: null, error: message, attempts: [url] }
    }
  }

  let merged = null
  const urls = OFFICIAL_PRICING_URLS
  for (const url of urls) {
    const currency = url.includes('/zh-cn/') ? 'CNY' : 'USD'
    attempts.push(url)
    try {
      const html = await fetchText(fetchImpl, url, timeoutMs)
      const parsed = parseDeepSeekPricingHtml(html, currency, url)
      if (parsed === null) {
        attempts[attempts.length - 1] = `${url} → 表格结构无法识别`
        continue
      }
      merged = merged === null
        ? normalizePriceDocument({ ...parsed, source: 'deepseek-docs', label: `DeepSeek 官方标价（${new Date(now()).toISOString().slice(0, 10)} 抓取）` }, BUILTIN_PRICES)
        : mergePriceDocuments(merged, normalizePriceDocument(parsed, BUILTIN_PRICES))
    } catch (error) {
      attempts[attempts.length - 1] = `${url} → ${String(error?.message ?? error)}`
    }
  }
  if (merged === null) return { document: null, error: attempts.join('; '), attempts }
  const stamp = new Date(now()).toISOString()
  return {
    document: {
      ...merged,
      source: 'deepseek-docs',
      // One label for the merged document: both published pages contribute, so
      // naming only the page that happened to be read last would mislead.
      label: `DeepSeek 官方标价（${stamp.slice(0, 10)} 抓取，含 CNY/USD）`,
      updatedAt: stamp
    },
    error: '',
    attempts
  }
}

/**
 * Accept a few JSON shapes for `pricingSource: 'json'`: the normalized document,
 * a bare `{ model: { cacheHit, cacheMiss, output } }` map in one currency, or the
 * same map nested under `prices`/`models` with per-1K or per-1M rates.
 * @param raw - the parsed JSON body.
 * @returns a candidate normalized document.
 */
export function normalizeExternalJson(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const models = raw.models ?? raw.prices ?? raw
  if (models === null || typeof models !== 'object') return null
  const currency = PRICE_CURRENCIES.includes(raw.currency) ? raw.currency : 'USD'
  const scale = Number(raw.unit) === 1000 ? 1000 : 1
  const output = { models: {} }
  for (const [name, entry] of Object.entries(models)) {
    if (entry === null || typeof entry !== 'object') continue
    if (PRICE_CURRENCIES.some(code => entry[code] !== undefined)) {
      output.models[name] = entry
      continue
    }
    const read = (value) => {
      if (value === undefined || value === null) return undefined
      const number = Number(value)
      if (!Number.isFinite(number)) return undefined
      return { offPeak: number * scale, peak: number * scale }
    }
    const cacheHit = read(entry.cacheHit ?? entry.cache_read ?? entry.inputCacheHit)
    const cacheMiss = read(entry.cacheMiss ?? entry.input ?? entry.inputCacheMiss)
    const outputTokens = read(entry.output ?? entry.outputTokens)
    if (cacheHit === undefined || cacheMiss === undefined || outputTokens === undefined) continue
    output.models[name] = {
      ...typeof entry.displayName === 'string' ? { displayName: entry.displayName } : {},
      [currency]: { cacheHit, cacheMiss, output: outputTokens, cacheWrite: read(entry.cacheWrite ?? entry.cache_write) ?? null }
    }
  }
  return Object.keys(output.models).length === 0 ? null : output
}
