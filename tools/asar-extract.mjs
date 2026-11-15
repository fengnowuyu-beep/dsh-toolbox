// Extract selected subtrees of an @electron/asar archive (the DSH Desktop app).
//
//   node tools/asar-extract.mjs <app.asar> <prefix> <outDir>
//
// Example: read the composer the plugin rewrites keystrokes for
//
//   node tools/asar-extract.mjs "D:/Software/DeepSeek Harness/resources/app.asar" \
//     dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation /tmp/ui-conversation
//
// Only non-unpacked files are written; native payloads kept outside the archive
// are left to app.asar.unpacked.
import fs from 'node:fs'
import path from 'node:path'

const [ARCHIVE, PREFIX, OUTDIR] = process.argv.slice(2)
if (ARCHIVE === undefined || PREFIX === undefined || OUTDIR === undefined) {
  console.error('usage: node tools/asar-extract.mjs <app.asar> <prefix> <outDir>')
  process.exit(2)
}

/** Read the archive header (a pickle whose JSON starts after a 16-byte prefix). */
function readHeader(archivePath) {
  const fd = fs.openSync(archivePath, 'r')
  try {
    const sizeBuffer = Buffer.alloc(16)
    fs.readSync(fd, sizeBuffer, 0, 16, 0)
    // The JSON payload length sits at offset 12; the JSON itself starts at 16.
    const jsonLength = sizeBuffer.readUInt32LE(12)
    const headerBuffer = Buffer.alloc(jsonLength)
    fs.readSync(fd, headerBuffer, 0, jsonLength, 16)
    const start = headerBuffer.indexOf(0x7b)
    const text = headerBuffer.subarray(start).toString('utf8')
    return { header: JSON.parse(text), dataOffset: 16 + Math.ceil(jsonLength / 4) * 4 }
  } finally {
    fs.closeSync(fd)
  }
}

const { header, dataOffset } = readHeader(ARCHIVE)
const files = []
const walk = (node, prefix) => {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const current = prefix === '' ? name : `${prefix}/${name}`
    if (entry.files !== undefined) walk(entry, current)
    else files.push({ path: current, size: Number(entry.size), offset: Number(entry.offset), unpacked: entry.unpacked })
  }
}
walk(header, '')

const selected = files.filter(file => file.path.startsWith(`${PREFIX}/`))
const fd = fs.openSync(ARCHIVE, 'r')
let written = 0
try {
  for (const file of selected) {
    if (file.unpacked === true) continue
    const destination = path.join(OUTDIR, file.path.slice(PREFIX.length + 1))
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    const buffer = Buffer.alloc(file.size)
    if (file.size > 0) fs.readSync(fd, buffer, 0, file.size, dataOffset + file.offset)
    fs.writeFileSync(destination, buffer)
    written += 1
  }
} finally {
  fs.closeSync(fd)
}
console.log(`extracted ${written} files from ${PREFIX} to ${OUTDIR}`)
