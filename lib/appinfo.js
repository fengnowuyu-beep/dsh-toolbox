/**
 * Desktop facts for `dsh-toolbox`: which application version is installed, and
 * whether the update feed has something newer.
 *
 * Two facts have to be read off the installation rather than asked of DSH:
 *
 *  - **The installed version.** The Desktop shell runs its Node half in a child
 *    process, so `app.getVersion()` is out of reach. The version is read from
 *    the app archive's own `package.json` (the file Electron itself loads),
 *    which is what `app.getVersion()` returns in the main process.
 *  - **The feed.** `resources/app-update.yml` is the feed electron-builder wrote
 *    for this installation, so the check follows the same provider, URL and
 *    channel the shipped updater uses instead of a hard-coded address.
 *
 * @module dsh-toolbox/appinfo
 */

import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Feed file names probed, in order, for the `generic` provider. */
const FEED_FILE_FALLBACKS = Object.freeze(['latest.yml', 'latest-mac.yml'])

/** Default deadline for one metadata request. */
export const CHECK_TIMEOUT_MS = 20_000

/**
 * Read the `files` table out of an `@electron/asar` archive header.
 * @param archivePath - the archive to open.
 * @returns the header root, plus the byte offset its file data starts at.
 */
export function readAsarHeader(archivePath) {
  const fd = openSyncSafe(archivePath)
  if (fd === null) return null
  try {
    const head = Buffer.alloc(16)
    const read = readSyncSafe(fd, head, 0, 16, 0)
    if (read < 16) return null
    const headerSize = head.readUInt32LE(4)
    if (!Number.isSafeInteger(headerSize) || headerSize <= 0 || headerSize > 64 * 1024 * 1024) return null
    const buffer = Buffer.alloc(headerSize)
    const got = readSyncSafe(fd, buffer, 0, headerSize, 8)
    const text = buffer.subarray(0, got).toString('utf8')
    const start = text.indexOf('{"files"')
    if (start < 0) return null
    const length = readUInt32At(buffer, start - 4)
    if (length === null) return null
    const slice = text.slice(start, start + length)
    let header
    try {
      header = JSON.parse(slice)
    } catch {
      // A truncated read still usually ends on a complete JSON document once the
      // trailing padding is dropped, so retry against the balanced end.
      header = JSON.parse(balanceJson(slice))
    }
    const pad = (4 - ((start + length) % 4)) % 4
    return { header, dataOffset: 8 + start + length + pad }
  } catch {
    return null
  } finally {
    closeSyncSafe(fd)
  }
}

/** Read one little-endian uint32, or null when out of range. */
function readUInt32At(buffer, offset) {
  if (offset < 0 || offset + 4 > buffer.length) return null
  const value = buffer.readUInt32LE(offset)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

/** Drop everything after the balanced end of a JSON document. */
function balanceJson(text) {
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
    else if (char === '{' || char === '[') depth += 1
    else if (char === '}' || char === ']') {
      depth -= 1
      if (depth === 0) return text.slice(0, index + 1)
    }
  }
  return text
}

/** Open a file, returning null instead of throwing. */
function openSyncSafe(path) {
  try {
    return openSync(path, 'r')
  } catch {
    return null
  }
}

/** Read from a descriptor, returning 0 instead of throwing. */
function readSyncSafe(fd, buffer, offset, length, position) {
  try {
    return readSync(fd, buffer, offset, length, position)
  } catch {
    return 0
  }
}

/** Close a descriptor, ignoring failures. */
function closeSyncSafe(fd) {
  try {
    closeSync(fd)
  } catch {
    /* a descriptor that cannot close leaks nothing we can act on */
  }
}

/**
 * Extract the root `package.json` version from an app archive.
 * @param archivePath - `…/resources/app.asar`.
 * @returns the version string, or null.
 */
export function readAsarPackageVersion(archivePath) {
  const parsed = readAsarHeader(archivePath)
  if (parsed === null) return null
  const entry = parsed.header?.files?.['package.json']
  if (entry === undefined || entry === null || entry.files !== undefined) return null
  const size = Number(entry.size)
  const offset = Number(entry.offset)
  if (!Number.isSafeInteger(size) || !Number.isSafeInteger(offset) || size <= 0) return null
  const fd = openSyncSafe(archivePath)
  if (fd === null) return null
  try {
    const buffer = Buffer.alloc(size)
    const got = readSyncSafe(fd, buffer, 0, size, parsed.dataOffset + offset)
    if (got < size) return null
    const manifest = JSON.parse(buffer.toString('utf8'))
    return typeof manifest?.version === 'string' && manifest.version !== '' ? manifest.version : null
  } catch {
    return null
  } finally {
    closeSyncSafe(fd)
  }
}

/**
 * The layout of one Desktop installation.
 * @param exePath - `process.execPath` of the Desktop Node-mode child (the DSH executable).
 * @returns resolved paths; every field may be missing for a non-Desktop launch.
 */
export function resolveInstallPaths(exePath) {
  if (typeof exePath !== 'string' || exePath === '') return { installDir: '', resourcesDir: '', asarPath: '', appUpdateFile: '' }
  const installDir = dirname(exePath)
  const resourcesDir = join(installDir, 'resources')
  return {
    installDir,
    resourcesDir,
    asarPath: join(resourcesDir, 'app.asar'),
    appUpdateFile: join(resourcesDir, 'app-update.yml')
  }
}

/**
 * Resolve the installed application version.
 *
 * Order matters here. The Desktop shell's Node half runs under Electron, whose
 * `fs` is patched for archives: a path *inside* `app.asar` is a normal readable
 * file there, while the archive itself cannot be opened as a file at all (so the
 * byte-level reader below is useless in that process). A plain Node process is
 * the other way round. Both orders are therefore tried.
 *
 * @param options - install paths and an optional logger.
 * @returns `{ version, source }`; `version` is '' when nothing could be read.
 */
export function readAppVersion(options = {}) {
  const { asarPath = '', resourcesDir = '' } = options

  // 1. Inside Electron: read the archive's own manifest through the patched fs.
  if (asarPath !== '') {
    const inside = join(asarPath, 'package.json')
    try {
      const manifest = JSON.parse(readFileSync(inside, 'utf8'))
      if (typeof manifest?.version === 'string' && manifest.version !== '') {
        return { version: manifest.version, source: 'app.asar/package.json' }
      }
    } catch {
      /* not an Electron process, or no such archive */
    }
  }

  // 2. Outside Electron: read the archive header ourselves.
  if (asarPath !== '' && existsSync(asarPath)) {
    const version = readAsarPackageVersion(asarPath)
    if (version !== null) return { version, source: 'app.asar (archive header)' }
  }

  // 3. An unpackaged development build keeps the application manifest on disk.
  const unpacked = resourcesDir === '' ? '' : join(resourcesDir, 'app', 'package.json')
  if (unpacked !== '' && existsSync(unpacked)) {
    try {
      const manifest = JSON.parse(readFileSync(unpacked, 'utf8'))
      if (typeof manifest?.version === 'string' && manifest.version !== '') {
        return { version: manifest.version, source: 'resources/app/package.json' }
      }
    } catch {
      /* fall through to "unknown" */
    }
  }
  return { version: '', source: '' }
}

/**
 * Parse the small subset of YAML an `app-update.yml` uses: scalar `key: value`
 * pairs and nested block lists (which the caller only needs to skip).
 * @param text - the file contents.
 * @returns a flat map of the top-level scalars.
 */
export function parseAppUpdateYml(text) {
  const result = {}
  if (typeof text !== 'string') return result
  for (const rawLine of text.split(/\r?\n/u)) {
    if (/^\s/u.test(rawLine)) continue
    const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/u.exec(rawLine)
    if (match === null) continue
    const value = match[2].trim()
    if (value === '') continue
    result[match[1]] = value.replace(/^["']|["']$/gu, '')
  }
  return result
}

/**
 * Resolve the feed metadata URLs one installation checks, in probe order.
 * @param config - parsed `app-update.yml` scalars.
 * @returns absolute URLs (empty when the feed cannot be derived).
 */
export function resolveFeedUrls(config) {
  const url = typeof config?.url === 'string' ? config.url.trim() : ''
  if (url === '') return []
  const base = url.endsWith('/') ? url : `${url}/`
  const channel = typeof config?.channel === 'string' && config.channel.trim() !== '' ? config.channel.trim() : 'latest'
  const candidates = [`${base}${channel}.yml`]
  for (const name of FEED_FILE_FALLBACKS) {
    const candidate = `${base}${name}`
    if (!candidates.includes(candidate)) candidates.push(candidate)
  }
  return candidates
}

/**
 * Compare two dotted version strings, prerelease-aware.
 * @param left - a candidate version.
 * @param right - the baseline version.
 * @returns -1, 0 or 1.
 */
export function compareVersions(left, right) {
  const parse = (value) => {
    const text = typeof value === 'string' ? value.trim().replace(/^v/u, '') : ''
    const [core, ...rest] = text.split('+')
    const [numbers, ...preParts] = core.split('-')
    return {
      numbers: numbers.split('.').map(part => (/^\d+$/u.test(part) ? Number(part) : Number.NaN)),
      prerelease: preParts.join('-')
    }
  }
  const a = parse(left)
  const b = parse(right)
  const length = Math.max(a.numbers.length, b.numbers.length)
  for (let index = 0; index < length; index += 1) {
    const l = a.numbers[index] ?? 0
    const r = b.numbers[index] ?? 0
    if (Number.isNaN(l) || Number.isNaN(r)) break
    if (l !== r) return l > r ? 1 : -1
  }
  // A release outranks any prerelease of the same core version.
  if (a.prerelease === b.prerelease) return 0
  if (a.prerelease === '') return 1
  if (b.prerelease === '') return -1
  const leftParts = a.prerelease.split('.')
  const rightParts = b.prerelease.split('.')
  const count = Math.max(leftParts.length, rightParts.length)
  for (let index = 0; index < count; index += 1) {
    const l = leftParts[index]
    const r = rightParts[index]
    if (l === undefined) return -1
    if (r === undefined) return 1
    if (l === r) continue
    const lNum = /^\d+$/u.test(l) ? Number(l) : Number.NaN
    const rNum = /^\d+$/u.test(r) ? Number(r) : Number.NaN
    if (!Number.isNaN(lNum) && !Number.isNaN(rNum)) return lNum > rNum ? 1 : -1
    if (!Number.isNaN(lNum)) return -1
    if (!Number.isNaN(rNum)) return 1
    return l > r ? 1 : -1
  }
  return 0
}

/**
 * Read the `version:` scalar out of an electron-builder feed document.
 * @param text - the `.yml` body.
 * @returns the version, or null.
 */
export function parseFeedVersion(text) {
  if (typeof text !== 'string') return null
  const match = /^version\s*:\s*["']?([^\s"']+)["']?\s*$/mu.exec(text)
  return match === null ? null : match[1]
}

/**
 * Check one Desktop installation against its update feed.
 * @param options - install paths, current version, transport and deadline.
 * @returns `{ status, currentVersion, latestVersion, feedUrl, releaseDate, urls, error }`.
 */
export async function checkForUpdate(options = {}) {
  const {
    appUpdateFile = '',
    currentVersion = '',
    logger,
    fetchImpl = globalThis.fetch,
    timeoutMs = CHECK_TIMEOUT_MS
  } = options

  if (appUpdateFile === '' || !existsSync(appUpdateFile)) {
    return {
      status: 'unsupported',
      currentVersion,
      latestVersion: '',
      available: false,
      feedUrl: '',
      urls: [],
      error: 'resources/app-update.yml not found; this installation has no packaged update source'
    }
  }

  let config
  try {
    config = parseAppUpdateYml(readFileSync(appUpdateFile, 'utf8'))
  } catch (error) {
    return {
      status: 'error',
      currentVersion,
      latestVersion: '',
      available: false,
      feedUrl: '',
      urls: [],
      error: `app-update.yml unreadable: ${String(error?.message ?? error)}`
    }
  }

  const urls = resolveFeedUrls(config)
  if (urls.length === 0) {
    return {
      status: 'unsupported',
      currentVersion,
      latestVersion: '',
      available: false,
      feedUrl: '',
      urls: [],
      error: 'app-update.yml declares no feed url'
    }
  }
  if (typeof fetchImpl !== 'function') {
    return { status: 'error', currentVersion, latestVersion: '', available: false, feedUrl: urls[0], urls, error: 'no fetch implementation available' }
  }

  const failures = []
  for (const feedUrl of urls) {
    try {
      const response = await fetchImpl(feedUrl, {
        headers: {
          accept: 'text/yaml, text/plain, application/octet-stream, */*',
          'user-agent': 'dsh-toolbox'
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs)
      })
      if (!response.ok) {
        failures.push(`${feedUrl} → HTTP ${String(response.status)}`)
        continue
      }
      const text = await response.text()
      const latestVersion = parseFeedVersion(text)
      if (latestVersion === null) {
        failures.push(`${feedUrl} → no version field`)
        continue
      }
      const releaseDate = /^releaseDate\s*:\s*["']?([^\s"']+)["']?\s*$/mu.exec(text)?.[1] ?? ''
      const newer = currentVersion === '' ? false : compareVersions(latestVersion, currentVersion) > 0
      return {
        status: 'ok',
        currentVersion,
        latestVersion,
        feedUrl,
        releaseDate,
        urls,
        available: newer,
        error: ''
      }
    } catch (error) {
      failures.push(`${feedUrl} → ${String(error?.message ?? error)}`)
    }
  }

  return {
    status: 'error',
    currentVersion,
    latestVersion: '',
    available: false,
    feedUrl: urls[0] ?? '',
    urls,
    error: failures.join('; ')
  }
}
