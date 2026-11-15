/**
 * Remove *later* duplicate top-level `export function` blocks from a file.
 *
 * Written after an editing mistake left three copies of one function in
 * `lib/title.js`. Keeping the first definition is the mechanical rule; the tool
 * refuses to touch a file unless every duplicate is byte-identical, so it can
 * never silently delete a different implementation.
 *
 *   node tools/dedupe-export.mjs <file> <function-name> [--write] [--keep-first]
 */
import { readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const WRITE = args.includes('--write')
const KEEP_FIRST = args.includes('--keep-first')
const positional = args.filter(argument => !argument.startsWith('--'))
const [FILE, NAME] = positional
if (FILE === undefined || NAME === undefined) {
  process.stderr.write('usage: node tools/dedupe-export.mjs <file> <function-name> [--write] [--keep-first]\n')
  process.exit(2)
}

/**
 * Find every top-level `export function NAME(...) { ... }` block by counting
 * braces from the declaration line, so a body containing braces cannot fool it.
 *
 * @param lines - the file split into lines.
 * @param name - the function name.
 * @returns `{ start, end }` line indices (0-based, inclusive).
 */
function blocks(lines, name) {
  const found = []
  const header = new RegExp(`^export function ${name}\\s*\\(`, 'u')
  for (let index = 0; index < lines.length; index += 1) {
    if (!header.test(lines[index])) continue
    let depth = 0
    let started = false
    for (let cursor = index; cursor < lines.length; cursor += 1) {
      for (const character of lines[cursor]) {
        if (character === '{') {
          depth += 1
          started = true
        } else if (character === '}') {
          depth -= 1
        }
      }
      if (started && depth === 0) {
        found.push({ start: index, end: cursor })
        index = cursor
        break
      }
    }
  }
  return found
}

/** The doc comment immediately above a declaration, when there is one. */
function commentStart(lines, declarationLine) {
  let start = declarationLine
  while (start > 0 && lines[start - 1].trim() !== '') start -= 1
  return lines[start]?.trimStart().startsWith('/**') === true ? start : declarationLine
}

const original = readFileSync(FILE, 'utf8')
const lines = original.split('\n')
const found = blocks(lines, NAME)
process.stdout.write(`${FILE}: ${String(found.length)} definition(s) of ${NAME} at lines ${found.map(block => String(block.start + 1)).join(', ')}\n`)
if (found.length < 2) process.exit(0)

const winner = KEEP_FIRST ? found[0] : found.at(-1)
const losers = found.filter(block => block !== winner)
const winnerBody = lines.slice(winner.start, winner.end + 1).join('\n')
for (const loser of losers) {
  const body = lines.slice(loser.start, loser.end + 1).join('\n')
  if (body === winnerBody) continue
  process.stderr.write(`refusing: the definition at line ${String(loser.start + 1)} differs from the one at ${String(winner.start + 1)}\n`)
  process.exit(1)
}

const drop = new Set()
for (const loser of losers) {
  const from = commentStart(lines, loser.start)
  for (let index = from; index <= loser.end; index += 1) drop.add(index)
  // Absorb one following blank line so no double gap is left behind.
  if (lines[loser.end + 1] === '' && lines[loser.end + 2] === '') drop.add(loser.end + 1)
}
const kept = lines.filter((unused, index) => !drop.has(index))

if (WRITE) {
  writeFileSync(FILE, kept.join('\n'), 'utf8')
  process.stdout.write(`wrote ${FILE}: ${String(lines.length)} -> ${String(kept.length)} lines, kept the definition at line ${String(winner.start + 1)}\n`)
} else {
  process.stdout.write(`would remove ${String(drop.size)} line(s), keeping line ${String(winner.start + 1)}; pass --write to apply\n`)
}
