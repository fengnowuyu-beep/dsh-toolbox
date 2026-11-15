// Search the text inside an app.asar without unpacking it.
//
// Usage: node tools/asar-grep.mjs <app.asar> <regex> [pathSubstring] [limit]
//
// Unpacking 121 MB of archive to find which shipped file contains one string is
// slow and pointless: the header already records every entry's offset and size,
// so this reads only the entries whose path matches and tests them in memory.
// That is how "who registers the settings seat?" became a one-second question.
import { readHeader, walkAsar, readEntry } from './asar-list.mjs'

const [, , archivePath, pattern, pathFilter = '', limitArg = '40'] = process.argv
if (archivePath === undefined || pattern === undefined) {
  process.stderr.write('usage: node tools/asar-grep.mjs <app.asar> <regex> [pathSubstring] [limit]\n')
  process.exit(2)
}

const limit = Number(limitArg)
const expression = new RegExp(pattern, 'u')
const header = readHeader(archivePath)
const candidates = []
walkAsar(header, { prefix: '', maxDepth: Number.POSITIVE_INFINITY }, (kind, full, entry) => {
  if (kind !== 'file') return
  if (pathFilter !== '' && !full.includes(pathFilter)) return
  // Only text-ish payloads; a PNG or a native module cannot hold the answer.
  if (!/\.(?:js|cjs|mjs|json|ts|css|html|md|yml|yaml|txt)$/u.test(full)) return
  if (Number(entry.size) > 12 * 1024 * 1024) return
  // Symlinked entries carry a `link` instead of bytes, so there is no offset to
  // read from; including them made the reader fail with a NaN position.
  if (!Number.isFinite(Number(entry.offset))) return
  candidates.push({ full, entry })
})

let matches = 0
for (const { full, entry } of candidates) {
  let text
  try {
    text = readEntry(archivePath, entry).toString('utf8')
  } catch (error) {
    process.stderr.write(`skipped ${full}: ${String(error?.message ?? error)}\n`)
    continue
  }
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    if (!expression.test(lines[index])) continue
    matches += 1
    if (matches > limit) break
    process.stdout.write(`${full}:${String(index + 1)}: ${lines[index].trim().slice(0, 220)}\n`)
  }
  if (matches > limit) break
}

process.stdout.write(`--- ${String(matches)} matching line(s) across ${String(candidates.length)} file(s) ---\n`)
