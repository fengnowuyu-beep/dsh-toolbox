// List paths inside an app.asar from its header, without unpacking anything.
//
// Usage: node tools/asar-list.mjs <app.asar> [prefix] [maxDepth] [limit]
//
// The archive starts with a small JSON blob describing every file. Unpacking the
// whole archive takes minutes; reading this list takes milliseconds, which is
// what makes "which package ships feature X?" a question you can answer instead
// of guess. Same for `asar-grep.mjs`, which reuses the parser here.
import { openSync, readSync, closeSync, statSync } from 'node:fs'

/**
 * The JSON blob's last index, found by counting braces outside strings.
 * @param text - the archive prefix, starting at the JSON.
 * @returns the inclusive end index, or -1 when the object never closes.
 */
function findJsonEnd(text) {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/**
 * Read and parse the header JSON.
 * @param file - the app.asar path.
 * @returns the parsed file tree.
 */
export function readHeader(file) {
  const size = statSync(file).size
  const fd = openSync(file, 'r')
  try {
    // Measured layout of an Electron asar: [u32 4][u32 pickleSize][u32 pickleSize-4]
    // [u32 jsonLength][json from offset 16]. Reading the length at offset 8 instead
    // of 12 runs 4 bytes past the JSON and the parse then fails on trailing bytes.
    const head = Buffer.alloc(16)
    readSync(fd, head, 0, 16, 0)
    const jsonLength = head.readUInt32LE(12)
    if (jsonLength <= 2 || jsonLength > size) throw new Error(`implausible asar header length ${jsonLength}`)
    const buffer = Buffer.alloc(jsonLength)
    readSync(fd, buffer, 0, jsonLength, 16)
    const text = buffer.toString('utf8')
    try {
      return JSON.parse(text)
    } catch {
      // A length field that is a few bytes off is harmless: the object's own
      // braces say where it ends.
      const end = findJsonEnd(text)
      if (end < 0) throw new Error('the asar header JSON has no closing brace')
      return JSON.parse(text.slice(0, end + 1))
    }
  } finally {
    closeSync(fd)
  }
}

/**
 * Visit every header entry inside a prefix.
 *
 * Depth is measured FROM THE PREFIX, so `maxDepth 1` lists what sits directly
 * inside it rather than making the caller count path segments.
 *
 * @param node - one header node.
 * @param options - `{ prefix, maxDepth }`.
 * @param visit - called with `(kind, fullPath, entry)`; kind is 'dir' or 'file'.
 * @param path - the path so far (recursion detail).
 */
export function walkAsar(node, options, visit, path = '') {
  const { prefix = '', maxDepth = Number.POSITIVE_INFINITY } = options
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const full = path === '' ? name : `${path}/${name}`
    const matches = prefix === '' || full === prefix || full.startsWith(`${prefix}/`)
    // A directory that merely contains the prefix is not itself a match, but it
    // must still be descended into or the prefix is never reached.
    const leadsToPrefix = prefix !== '' && prefix.startsWith(`${full}/`)
    if (!matches && !leadsToPrefix) continue
    const below = prefix === '' ? full.split('/').length : full === prefix ? 0 : full.slice(prefix.length + 1).split('/').length
    const within = below <= maxDepth
    if (entry.files !== undefined) {
      if (matches && within) visit('dir', full, entry)
      walkAsar(entry, options, visit, full)
    } else if (matches && within) {
      visit('file', full, entry)
    }
  }
}

/** Read one entry's bytes out of the archive. */
export function readEntry(file, entry) {
  const size = Number(entry.size)
  const offset = headerByteLength(file) + Number(entry.offset)
  const fd = openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(size)
    readSync(fd, buffer, 0, size, offset)
    return buffer
  } finally {
    closeSync(fd)
  }
}

/** @returns the number of bytes the header occupies, i.e. where file data starts. */
export function headerByteLength(file) {
  const fd = openSync(file, 'r')
  try {
    const head = Buffer.alloc(16)
    readSync(fd, head, 0, 16, 0)
    return 8 + head.readUInt32LE(4)
  } finally {
    closeSync(fd)
  }
}

if (import.meta.main === true) {
  const [, , archivePath, prefix = '', depthArg = '3', limitArg = '500'] = process.argv
  if (archivePath === undefined) {
    process.stderr.write('usage: node tools/asar-list.mjs <app.asar> [prefix] [maxDepth] [limit]\n')
    process.exit(2)
  }
  const maxDepth = Number(depthArg)
  const limit = Number(limitArg)
  const rows = []
  walkAsar(readHeader(archivePath), { prefix, maxDepth }, (kind, full, entry) => {
    if (rows.length >= limit) return
    rows.push(kind === 'dir' ? `[dir]  ${full}/` : `       ${full}  (${Number(entry.size)})`)
  })
  process.stdout.write(`${rows.join('\n')}\n--- ${String(rows.length)} entries${rows.length >= limit ? ' (truncated)' : ''} ---\n`)
}
