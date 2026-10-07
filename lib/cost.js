/**
 * Per-conversation spend for `dsh-toolbox`.
 *
 * The amount is derived from the Session log, not from a separate ledger: every
 * durable `assistant/message` (or the usage sample inside an `assistant/attempt`
 * stream) carries the provider's own token counts, and the model that produced
 * it is named by the message source or by the request header in force when it
 * was appended. Pricing each sample at the hour it was reported is what makes
 * the off-peak/peak split exact rather than an average.
 *
 * The fold deliberately mirrors the `tokenUsage` session projection — the same
 * replace-on-repeat rule keyed by `(turn, step)`, and the same clearing on
 * `llm/retry-started` — so the amount always describes the same tokens the
 * composer's own token pill shows.
 *
 * @module dsh-toolbox/cost
 */

import {
  convertAmount,
  isPeakInstant,
  priceEntryFor,
  PRICE_UNIT,
  rateFor
} from './pricing.js'

/** Billing lines, in the order a breakdown shows them. */
export const BILLING_KINDS = Object.freeze(['cacheHit', 'cacheMiss', 'cacheWrite', 'output'])

/** The bucket each billing line reads from. */
const KIND_BUCKET = Object.freeze({
  cacheHit: 'cacheReadTokens',
  cacheMiss: 'uncachedInputTokens',
  cacheWrite: 'cacheWriteTokens',
  output: 'outputTokens'
})

/** @returns an all-zero bucket set. */
export function zeroBuckets() {
  return { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }
}

/** Map one provider `TokenUsage` onto billing buckets. */
export function bucketsFromUsage(usage) {
  return {
    uncachedInputTokens: Number(usage?.inputTokens ?? 0) || 0,
    outputTokens: Number(usage?.outputTokens ?? 0) || 0,
    cacheReadTokens: Number(usage?.cacheReadTokens ?? 0) || 0,
    cacheWriteTokens: Number(usage?.cacheWriteTokens ?? 0) || 0
  }
}

/** Add buckets into a target. */
function addBuckets(target, delta) {
  return {
    uncachedInputTokens: target.uncachedInputTokens + delta.uncachedInputTokens,
    cacheReadTokens: target.cacheReadTokens + delta.cacheReadTokens,
    cacheWriteTokens: target.cacheWriteTokens + delta.cacheWriteTokens,
    outputTokens: target.outputTokens + delta.outputTokens
  }
}

/** Subtract buckets from a target. */
function subtractBuckets(target, delta) {
  return {
    uncachedInputTokens: target.uncachedInputTokens - delta.uncachedInputTokens,
    cacheReadTokens: target.cacheReadTokens - delta.cacheReadTokens,
    cacheWriteTokens: target.cacheWriteTokens - delta.cacheWriteTokens,
    outputTokens: target.outputTokens - delta.outputTokens
  }
}

/** Whether two bucket sets are identical. */
function bucketsEqual(left, right) {
  return left.uncachedInputTokens === right.uncachedInputTokens
    && left.outputTokens === right.outputTokens
    && left.cacheReadTokens === right.cacheReadTokens
    && left.cacheWriteTokens === right.cacheWriteTokens
}

/** Total tokens across the billing buckets. */
export function totalTokens(buckets) {
  return buckets.uncachedInputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens + buckets.outputTokens
}

/** The newest usage sample inside an `assistant/attempt` stream. */
export function streamUsage(stream) {
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (record?.type === 'chunk' && record.chunk?.type === 'usage') return record.chunk.usage
  }
  return undefined
}

/** The usage one durable assistant settlement reports for its attempt. */
export function usageOfEvent(event) {
  if (event?.type === 'assistant/message' && event.data?.usage !== undefined) return event.data.usage
  if (event?.type !== 'assistant/message' && event?.type !== 'assistant/attempt') return undefined
  return streamUsage(event.data?.stream)
}

/**
 * Price one bucket set under one model and one billing hour.
 * @param options - price entry, display currency, rate fallback, peak flag and bucket set.
 * @returns `{ amount, priced, missing }` — `amount` covers only priced tokens.
 */
export function priceBuckets(options) {
  const {
    entry,
    displayCurrency,
    usdCny,
    peak,
    buckets,
    unit = PRICE_UNIT
  } = options
  if (entry === null) {
    return {
      amount: 0,
      priced: 0,
      missing: BILLING_KINDS
        .map(kind => ({ kind, tokens: buckets[KIND_BUCKET[kind]] }))
        .filter(line => line.tokens > 0)
    }
  }
  const missing = []
  let amount = 0
  let priced = 0
  for (const kind of BILLING_KINDS) {
    const tokens = buckets[KIND_BUCKET[kind]]
    if (tokens <= 0) continue
    // A cache write has no separate line on the DeepSeek price list: the tokens
    // being written are billed as cache misses, which is the rate the vendor
    // charges for the same tokens arriving uncached.
    const direct = rateFor(entry, displayCurrency, kind, peak)
    if (direct !== null) {
      amount += (tokens / unit) * direct
      priced += tokens
      continue
    }
    const other = displayCurrency === 'USD' ? 'CNY' : 'USD'
    const converted = rateFor(entry, other, kind, peak)
    if (converted !== null) {
      amount += convertAmount((tokens / unit) * converted, other, displayCurrency, usdCny)
      priced += tokens
      continue
    }
    missing.push({ kind, tokens })
  }
  return { amount, priced, missing }
}

/**
 * Fold a sequence of Session events into a spend total.
 * @param events - events in seq order.
 * @param options - price document, display currency, rate fallback and the state to continue from.
 * @returns the updated fold state.
 */
export function foldCost(events, options) {
  const {
    document,
    displayCurrency = 'CNY',
    usdCny = 7.1,
    state
  } = options
  const fold = state ?? {
    buckets: zeroBuckets(),
    amount: 0,
    pricedTokens: 0,
    unpricedTokens: 0,
    samples: 0,
    peakSamples: 0,
    /** Last sample seen, so a repeated `(turn, step)` replaces rather than adds. */
    lastSeen: null,
    /** Route in force, taken from `request/header` / `request/context`. */
    route: { provider: '', model: '' },
    /** Per-model totals, keyed by `provider\u0000model`. */
    byModel: new Map(),
    /** Models this document could not price. */
    unpricedModels: new Set()
  }

  for (const event of events) {
    if (event?.type === 'request/header') {
      const config = event.data?.header?.config
      if (config !== null && typeof config === 'object') {
        fold.route = {
          provider: typeof config.provider === 'string' ? config.provider : fold.route.provider,
          model: typeof config.model === 'string' ? config.model : fold.route.model
        }
      }
      continue
    }
    if (event?.type === 'request/context') {
      const context = event.data
      if (context !== null && typeof context === 'object') {
        fold.route = {
          provider: typeof context.provider === 'string' ? context.provider : fold.route.provider,
          model: typeof context.model === 'string' ? context.model : fold.route.model
        }
      }
      continue
    }
    if (event?.type === 'llm/retry-started') {
      const last = fold.lastSeen
      if (last !== null && last.turn === event.data?.turn && last.step === event.data?.step) {
        fold.buckets = subtractBuckets(fold.buckets, last.buckets)
        fold.amount -= last.amount
        fold.pricedTokens -= last.pricedTokens
        fold.unpricedTokens -= last.unpricedTokens
        if (last.key !== null) {
          const bucket = fold.byModel.get(last.key)
          if (bucket !== undefined) {
            bucket.buckets = subtractBuckets(bucket.buckets, last.buckets)
            bucket.amount -= last.amount
            bucket.pricedTokens -= last.pricedTokens
            bucket.unpricedTokens -= last.unpricedTokens
          }
        }
        if (last.peak) fold.peakSamples -= 1
        fold.samples -= 1
        fold.lastSeen = null
      }
      continue
    }

    const usage = usageOfEvent(event)
    if (usage === undefined) continue
    const turn = Number(event.data?.turn ?? 0)
    const step = Number(event.data?.step ?? 0)
    const buckets = bucketsFromUsage(usage)
    const previous = fold.lastSeen !== null && fold.lastSeen.turn === turn && fold.lastSeen.step === step
      ? fold.lastSeen
      : null
    if (previous !== null && bucketsEqual(previous.buckets, buckets)) continue

    const source = event.data?.message?.source
    const provider = typeof source?.provider === 'string' && source.provider !== '' ? source.provider : fold.route.provider
    const model = typeof source?.model === 'string' && source.model !== '' ? source.model : fold.route.model
    const timeMs = typeof event.time === 'number' ? event.time : Date.now()

    if (previous !== null) {
      fold.buckets = subtractBuckets(fold.buckets, previous.buckets)
      fold.amount -= previous.amount
      fold.pricedTokens -= previous.pricedTokens
      fold.unpricedTokens -= previous.unpricedTokens
      if (previous.key !== null) {
        const bucket = fold.byModel.get(previous.key)
        if (bucket !== undefined) {
          bucket.buckets = subtractBuckets(bucket.buckets, previous.buckets)
          bucket.amount -= previous.amount
          bucket.pricedTokens -= previous.pricedTokens
          bucket.unpricedTokens -= previous.unpricedTokens
        }
      }
      if (previous.peak) fold.peakSamples -= 1
      fold.samples -= 1
    }

    const peak = isPeakInstant(timeMs, document)
    const entry = priceEntryFor(document, model)
    const priced = priceBuckets({ entry, displayCurrency, usdCny, peak, buckets })
    const key = entry === null ? null : `${provider}\u0000${model}`

    fold.buckets = addBuckets(fold.buckets, buckets)
    fold.amount += priced.amount
    fold.pricedTokens += priced.priced
    fold.unpricedTokens += totalTokens(buckets) - priced.priced
    fold.samples += 1
    if (peak) fold.peakSamples += 1
    if (entry === null && totalTokens(buckets) > 0) fold.unpricedModels.add(model === '' ? '（未知模型）' : model)
    if (key !== null) {
      const bucket = fold.byModel.get(key) ?? {
        provider: provider === '' ? '（未知提供方）' : provider,
        model: model === '' ? '（未知模型）' : model,
        buckets: zeroBuckets(),
        amount: 0,
        pricedTokens: 0,
        unpricedTokens: 0,
        peakSamples: 0
      }
      bucket.buckets = addBuckets(bucket.buckets, buckets)
      bucket.amount += priced.amount
      bucket.pricedTokens += priced.priced
      bucket.unpricedTokens += totalTokens(buckets) - priced.priced
      if (peak) bucket.peakSamples += 1
      fold.byModel.set(key, bucket)
    }

    fold.lastSeen = {
      turn,
      step,
      buckets,
      amount: priced.amount,
      pricedTokens: priced.priced,
      unpricedTokens: totalTokens(buckets) - priced.priced,
      peak,
      key
    }
  }

  return fold
}

/**
 * Present one fold state as the JSON the browser half reads.
 * @param fold - the fold state.
 * @param extras - price document metadata and the session id.
 * @returns a JSON-safe spend report.
 */
export function presentCost(fold, extras = {}) {
  const byModel = [...fold.byModel.values()]
    .map(entry => ({
      provider: entry.provider,
      model: entry.model,
      buckets: entry.buckets,
      tokens: totalTokens(entry.buckets),
      amount: entry.amount,
      unpricedTokens: entry.unpricedTokens,
      peakSamples: entry.peakSamples
    }))
    .sort((left, right) => right.amount - left.amount)

  return {
    ...extras,
    samples: fold.samples,
    peakSamples: fold.peakSamples,
    buckets: fold.buckets,
    tokens: totalTokens(fold.buckets),
    amount: fold.amount,
    pricedTokens: fold.pricedTokens,
    unpricedTokens: fold.unpricedTokens,
    unpricedModels: [...fold.unpricedModels],
    byModel,
    hasUsage: fold.samples > 0 && totalTokens(fold.buckets) > 0
  }
}

/**
 * A per-session memo so the browser half can poll cheaply: a session whose log
 * has not advanced returns the previous report, and one that has advanced folds
 * only the events that arrived since.
 * @param options - limit on remembered sessions.
 * @returns `{ compute, invalidate, size }`.
 */
export function createCostLedger(options = {}) {
  const limit = Number.isFinite(Number(options.limit)) ? Number(options.limit) : 32
  const entries = new Map()

  const bound = () => {
    while (entries.size > limit) {
      const oldest = entries.keys().next()
      if (oldest.done === true) return
      entries.delete(oldest.value)
    }
  }

  return {
    /**
     * @param session - a live DSH Session.
     * @param context - price document, display currency, rate fallback and document stamp.
     * @returns the presented spend report.
     */
    compute(session, context) {
      const id = String(session?.id ?? '')
      const stamp = `${context.documentStamp ?? ''}|${context.displayCurrency ?? ''}|${context.usdCny ?? ''}`
      const seq = Number(session?.seq ?? 0)
      const cached = entries.get(id)

      if (cached !== undefined && cached.session === session && cached.stamp === stamp && cached.seq <= seq) {
        if (cached.seq === seq) return cached.report
        const tail = readEvents(session, cached.seq)
        cached.fold = foldCost(tail, { ...context, state: cached.fold })
        cached.seq = seq
        cached.report = presentCost(cached.fold, { sessionId: id, asOfSeq: seq })
        return cached.report
      }

      const events = readEvents(session, 0)
      const fold = foldCost(events, { ...context, state: undefined })
      const report = presentCost(fold, { sessionId: id, asOfSeq: seq })
      entries.set(id, { session, stamp, seq, fold, report })
      bound()
      return report
    },
    /** Forget every memo (used when the price document changes). */
    invalidate() {
      entries.clear()
    },
    get size() {
      return entries.size
    }
  }
}

/** Read a session's events from one sequence offset, tolerating a stale handle. */
function readEvents(session, fromSeq) {
  try {
    if (typeof session?.snapshotEvents !== 'function') return []
    const events = session.snapshotEvents(fromSeq)
    return Array.isArray(events) ? events : []
  } catch {
    try {
      const events = session.snapshotEvents()
      return Array.isArray(events) ? events : []
    } catch {
      return []
    }
  }
}
