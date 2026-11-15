/**
 * Print the sampling tiers' real thresholds.
 *
 * The three strategies in `selectTitleTurns` trade coverage against detail, and
 * the thresholds depend on the outline's own clamps (a 50-character prompt
 * preview and a 120-character response preview). They are worth measuring rather
 * than assuming: the first guess at them was wrong by a factor of three, which
 * is exactly the kind of error a budget feature cannot afford.
 *
 *   node tools/title-budget-report.mjs
 */
import {
  TITLE_DEFAULT_MAX_INPUT_BYTES,
  frameTitleOutline,
  selectTitleTurns
} from '../lib/title.js'

/** One outline entry with the real clamps. */
function entry(turn, promptLength = 50, responseLength = 120) {
  return { turn, prompt: '汉'.repeat(promptLength), response: '复'.repeat(responseLength) }
}

/** The framed payload's UTF-8 byte length. */
function bytes(selection) {
  return Buffer.byteLength(frameTitleOutline(selection), 'utf8')
}

/** The first turn count for which the selector leaves the `all` strategy. */
function threshold(promptLength, responseLength) {
  for (let count = 1; count <= 400; count += 1) {
    const entries = Array.from({ length: count }, (unused, index) => entry(index + 1, promptLength, responseLength))
    const selection = selectTitleTurns(entries, TITLE_DEFAULT_MAX_INPUT_BYTES)
    if (selection.strategy !== 'all') return count
  }
  return -1
}

const budget = TITLE_DEFAULT_MAX_INPUT_BYTES
process.stdout.write(`budget: ${String(budget)} bytes, one full entry: ${String(Buffer.byteLength(JSON.stringify(entry(1)), 'utf8'))} bytes\n\n`)

process.stdout.write('prompt+response outline:\n')
for (const count of [5, 6, 7, 8, 12, 30, 120, 400]) {
  const entries = Array.from({ length: count }, (unused, index) => entry(index + 1))
  const selection = selectTitleTurns(entries, budget)
  process.stdout.write(`  turns=${String(count).padStart(3)} strategy=${selection.strategy.padEnd(7)} sent=${String(selection.entries.length).padStart(3)} bytes=${String(bytes(selection)).padStart(5)}\n`)
}

process.stdout.write('\nfirst count that stops fitting whole:\n')
process.stdout.write(`  full previews:  ${String(threshold(50, 120))}\n`)

process.stdout.write('\nprompt-only outline (responses dropped, so it spans far more turns):\n')
for (const count of [10, 20, 30, 60, 120]) {
  const huge = Array.from({ length: 400 }, (unused, index) => entry(index + 1, 90))
  const selection = selectTitleTurns([...huge.slice(0, count - 1), entry(count, 90)], budget)
  process.stdout.write(`  turns=${String(count).padStart(3)} strategy=${selection.strategy.padEnd(7)} sent=${String(selection.entries.length).padStart(3)} withResponses=${String(selection.includeResponse).padEnd(5)} bytes=${String(bytes(selection)).padStart(5)}\n`)
}
