/**
 * Rebuild a file from its line-numbered read results in a DSH session log.
 *
 * A log holds every read the session performed, so the parts of a file that were
 * read can be recovered verbatim even after the file itself is destroyed. The
 * plan here is to know exactly which line numbers exist before writing anything:
 * `report` mode prints the coverage, and only a fully covered file is written.
 *
 *   node tools/session-log-file-recover.mjs <log> <file-name> [outFile] [--ranges]
 *
 * With `--ranges` and no `outFile` it prints the covered ranges instead of
 * writing, which is how a partial recovery gets reviewed before it is trusted.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const args = process.argv.slice(2)
const RANGES_ONLY = args.includes('--ranges')
const positional = args.filter(argument => argument !== '--ranges')
const [LOG, TARGET, OUT] = positional
if (LOG === undefined || TARGET === undefined) {
  process.stderr.write('usage: node tools/session-log-file-recover.mjs <log> <file-name> [outFile] [--ranges]\n')
  process.exit(2)
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const RAW_NEWLINE = /\\n/gu
/** One numbered line: `123→text` or `123: text`. */
const NUMBERED = /^\s*(\d+)(?:\u2192|:)\s?(.*)$/u

/** Split a multi-frame zstd stream. */
function splitFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = buffer.indexOf(ZSTD_MAGIC, offset)
    if (start < 0) break
    let end = buffer.indexOf(ZSTD_MAGIC, start + 4)
    if (end < 0) end = buffer.length
    frames.push(buffer.subarray(start, end))
    offset = end
  }
  return frames
}

/** Undo the JSON string escaping one event applied to its tool result. */
function unescapeJsonText(text) {
  let out = ''
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character !== '\\') {
      out += character
      continue
    }
    const next = text[index + 1]
    switch (next) {
      case 'n': out += '\n'; index += 1; break
      case 'r': out += ''; index += 1; break
      case 't': out += '\t'; index += 1; break
      case '"': out += '"'; index += 1; break
      case '\\': out += '\\'; index += 1; break
      case '/': out += '/'; index += 1; break
      case 'u': {
        const hex = text.slice(index + 2, index + 6)
        if (/^[0-9a-fA-F]{4}$/u.test(hex)) {
          out += String.fromCharCode(Number.parseInt(hex, 16))
          index += 5
        } else {
          out += character
        }
        break
      }
      default: out += character
    }
  }
  return out
}

/**
 * Whether one `<content>` block is a read result for the target file.
 *
 * Both a read result and a grep result carry numbered lines, so the block must
 * be preceded by the target's own path — the `<path>` metadata a read emits.
 */
function isTargetRead(frame, blockStart, parts) {
  const before = frame.slice(Math.max(0, blockStart - 400), blockStart)
  if (!before.includes(TARGET.replace(/\\/gu, '\\\\')) && !before.includes(TARGET)) return false
  return NUMBERED.exec(unescapeJsonText(parts[1] ?? '')) !== null
}

const lines = new Map()
for (const frame of splitFrames(readFileSync(LOG))) {
  let text
  try {
    text = zstdDecompressSync(frame).toString('utf8')
  } catch {
    continue
  }
  // The log carries a read result as JSON, so the file's real newlines are the
  // two-character sequence `\n`. Split on that *before* unescaping anything, or
  // the content stops being distinguishable from the surrounding JSON.
  let cursor = 0
  while (true) {
    const open = text.indexOf('<content>', cursor)
    if (open < 0) break
    const close = text.indexOf('</content>', open)
    if (close < 0) break
    cursor = close + 1
    const parts = text.slice(open + '<content>'.length, close).split(RAW_NEWLINE)
    if (parts.length < 2 || !isTargetRead(text, open, parts)) continue
    for (const part of parts) {
      const match = NUMBERED.exec(unescapeJsonText(part))
      if (match === null) continue
      const number = Number(match[1])
      const value = match[2]
      const previous = lines.get(number)
      if (previous === undefined || value.length > previous.length) lines.set(number, value)
    }
  }
}

if (lines.size === 0) {
  process.stderr.write(`no line-numbered read result for ${TARGET} was found\n`)
  process.exit(1)
}

const highest = Math.max(...lines.keys())
const ranges = []
let start = null
for (let number = 1; number <= highest + 1; number += 1) {
  const present = lines.has(number)
  if (present && start === null) start = number
  if (!present && start !== null) {
    ranges.push(`${String(start)}-${String(number - 1)}`)
    start = null
  }
}
const missing = []
for (let number = 1; number <= highest; number += 1) if (!lines.has(number)) missing.push(number)

process.stdout.write(`${TARGET}: covered lines ${ranges.join(', ')} (highest ${String(highest)}, missing ${String(missing.length)})\n`)
if (RANGES_ONLY || OUT === undefined) process.exit(0)

const output = []
for (let number = 1; number <= highest; number += 1) {
  output.push(lines.has(number) ? lines.get(number) : `<<<MISSING LINE ${String(number)}>>>`)
}
writeFileSync(OUT, `${output.join('\n')}\n`, 'utf8')
process.stdout.write(`wrote ${OUT}\n`)
