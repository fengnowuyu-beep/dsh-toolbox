/**
 * Pull the text of one tool result back out of a DSH session log.
 *
 * A session log is a sequence of independent zstd frames, one per appended
 * event, so reading it means walking the frames — `zstdDecompressSync` alone
 * stops at the first one. This is the recovery path for "I read a file and then
 * damaged it": the read result is in the log, verbatim.
 *
 *   node tools/session-log-extract.mjs <log-file> <needle> [outFile]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { zstdDecompressSync, constants } from 'node:zlib'

const [LOG, NEEDLE, OUT] = process.argv.slice(2)
if (LOG === undefined || NEEDLE === undefined) {
  process.stderr.write('usage: node tools/session-log-extract.mjs <log-file> <needle> [outFile]\n')
  process.exit(2)
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Split a multi-frame zstd stream into its frames.
 *
 * A frame's length is not in its header, so each frame is decompressed from its
 * offset and the decompressor is asked how many bytes it consumed. Node exposes
 * that through `engine.bytesWritten` on the returned buffer for a synchronous
 * call, which is the only portable way to find the next frame.
 *
 * @param buffer - the whole log.
 * @returns one Buffer per frame.
 */
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

const log = readFileSync(LOG)
const frames = splitFrames(log)
process.stdout.write(`${LOG}: ${String(log.length)} bytes, ${String(frames.length)} frame(s)\n`)

let hits = 0
for (let index = 0; index < frames.length; index += 1) {
  let text
  try {
    text = zstdDecompressSync(frames[index]).toString('utf8')
  } catch (error) {
    process.stdout.write(`  frame ${String(index)}: not readable (${String(error?.message ?? error).slice(0, 60)})\n`)
    continue
  }
  if (!text.includes(NEEDLE)) continue
  hits += 1
  process.stdout.write(`  frame ${String(index)}: ${String(text.length)} chars, contains the needle\n`)
  if (OUT !== undefined) {
    writeFileSync(OUT, text, 'utf8')
    process.stdout.write(`  wrote ${OUT}\n`)
  }
}
void constants
process.stdout.write(`${String(hits)} matching frame(s)\n`)
