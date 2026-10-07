// Walk a dumped asar header JSON (from _asar_header.js) and list paths.
// Usage: node asar-walk.mjs <header.json> <prefix> <depthBelowPrefix> <limit>
import fs from 'node:fs'

const HEADER_JSON = process.argv[2]
const PREFIX = process.argv[3] ?? ''
const DEPTH = Number(process.argv[4] ?? 3)
const LIMIT = Number(process.argv[5] ?? 400)

const header = JSON.parse(fs.readFileSync(HEADER_JSON, 'utf8').replace(/^\uFEFF/, ''))
const out = []
const walk = (node, prefix, level) => {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name
    const matches = PREFIX === '' || p === PREFIX || p.startsWith(`${PREFIX}/`)
    let childLevel = level
    if (matches) childLevel = level + 1
    if (matches && childLevel > DEPTH) continue
    if (entry.files) {
      if (matches) out.push(`[dir]  ${p}/`)
      walk(entry, p, childLevel)
    } else if (matches) {
      out.push(`       ${p}  (${Number(entry.size)})`)
    }
  }
}
walk(header, '', 0)
console.log(out.slice(0, LIMIT).join('\n'))
console.log(`--- total ${out.length} entries ---`)
