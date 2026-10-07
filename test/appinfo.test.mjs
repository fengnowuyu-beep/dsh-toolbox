/** Installation facts: version comparison, the feed, and the archive reader. */

import { existsSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'

import { deepEqual, equal, ok, run, test } from './harness.mjs'
import {
  checkForUpdate,
  compareVersions,
  parseAppUpdateYml,
  parseFeedVersion,
  readAsarHeader,
  readAsarPackageVersion,
  readAppVersion,
  resolveFeedUrls,
  resolveInstallPaths
} from '../lib/appinfo.js'

/** The shipped feed document shape. */
const FEED = [
  'version: 0.2.0-rc.3',
  'files:',
  '  - url: deepseek-harness-0.2.0-rc.3-win-x64.exe',
  '    sha512: abc',
  '    size: 289313640',
  "path: deepseek-harness-0.2.0-rc.3-win-x64.exe",
  "releaseDate: '2026-10-01T10:35:27.666Z'"
].join('\n')

test('versions compare numerically, not as text', () => {
  equal(compareVersions('0.2.0-rc.10', '0.2.0-rc.2'), 1)
  equal(compareVersions('0.2.0-rc.2', '0.2.0-rc.10'), -1)
  equal(compareVersions('0.2.0', '0.2.0-rc.10'), 1)
  equal(compareVersions('0.2.0-rc.2', '0.2.0'), -1)
  equal(compareVersions('1.0.0', '0.9.9'), 1)
  equal(compareVersions('0.2.0', '0.2.0'), 0)
  equal(compareVersions('v0.3.0', '0.2.0'), 1)
  equal(compareVersions('0.2.1', '0.2'), 1)
  equal(compareVersions('0.2.0+build.7', '0.2.0'), 0)
  equal(compareVersions('1.0.0-beta.1', '1.0.0-alpha.9'), 1)
})

test('the feed version line is read without a YAML dependency', () => {
  equal(parseFeedVersion(FEED), '0.2.0-rc.3')
  equal(parseFeedVersion('version: "1.2.3"'), '1.2.3')
  equal(parseFeedVersion('files:\n  - url: x'), null)
  equal(parseFeedVersion(''), null)
})

test('app-update.yml yields its top-level scalars and nothing nested', () => {
  const config = parseAppUpdateYml([
    'provider: generic',
    'url: https://example.test/feeds/win-x64/',
    'channel: nightly',
    'updaterCacheDirName: @scope/app-updater',
    'publisherName:',
    '  - CN=Example'
  ].join('\n'))
  deepEqual(config, {
    provider: 'generic',
    url: 'https://example.test/feeds/win-x64/',
    channel: 'nightly',
    updaterCacheDirName: '@scope/app-updater'
  })
})

test('feed URLs follow the configured channel, with documented fallbacks', () => {
  deepEqual(resolveFeedUrls({ url: 'https://x.test/f/', channel: 'nightly' }), [
    'https://x.test/f/nightly.yml',
    'https://x.test/f/latest.yml',
    'https://x.test/f/latest-mac.yml'
  ])
  deepEqual(resolveFeedUrls({ url: 'https://x.test/f', channel: 'latest' }), [
    'https://x.test/f/latest.yml',
    'https://x.test/f/latest-mac.yml'
  ])
  deepEqual(resolveFeedUrls({ channel: 'nightly' }), [])
})

test('install paths are derived from the executable', () => {
  const exe = join(sep === '\\' ? 'C:\\opt\\dsh' : '/opt/dsh', 'DeepSeek Harness')
  const paths = resolveInstallPaths(exe)
  equal(paths.installDir, dirname(exe))
  equal(paths.resourcesDir, join(dirname(exe), 'resources'))
  ok(paths.asarPath.endsWith('app.asar'))
  deepEqual(resolveInstallPaths(''), { installDir: '', resourcesDir: '', asarPath: '', appUpdateFile: '' })
})

test('an installation without a feed reports itself as unsupported', async () => {
  const result = await checkForUpdate({ appUpdateFile: '/definitely/not/here.yml', currentVersion: '1.0.0' })
  equal(result.status, 'unsupported')
  equal(result.available, false)
  ok(result.error.length > 0)
})

test('a check reads the channel feed and compares it to the installed version', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const home = await mkdtemp(join(tmpdir(), 'dsh-toolbox-feed-'))
  try {
    const file = join(home, 'app-update.yml')
    await writeFile(file, 'provider: generic\nurl: https://example.test/f/\nchannel: nightly\n', 'utf8')
    const asked = []
    const fetchImpl = async (url) => {
      asked.push(url)
      if (url !== 'https://example.test/f/nightly.yml') return { ok: false, status: 404, text: async () => '' }
      return { ok: true, status: 200, text: async () => FEED }
    }
    const newer = await checkForUpdate({ appUpdateFile: file, currentVersion: '0.2.0-rc.2', fetchImpl })
    equal(newer.status, 'ok')
    equal(newer.latestVersion, '0.2.0-rc.3')
    equal(newer.available, true)
    equal(newer.releaseDate, '2026-10-01T10:35:27.666Z')
    deepEqual(asked, ['https://example.test/f/nightly.yml'])

    const same = await checkForUpdate({ appUpdateFile: file, currentVersion: '0.2.0-rc.3', fetchImpl })
    equal(same.available, false)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a failing feed is probed in order and its failures are reported', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const home = await mkdtemp(join(tmpdir(), 'dsh-toolbox-feed2-'))
  try {
    const file = join(home, 'app-update.yml')
    await writeFile(file, 'url: https://example.test/f/\nchannel: nightly\n', 'utf8')
    const asked = []
    const result = await checkForUpdate({
      appUpdateFile: file,
      currentVersion: '1.0.0',
      fetchImpl: async (url) => { asked.push(url); return { ok: false, status: 503, text: async () => '' } }
    })
    equal(result.status, 'error')
    equal(asked.length, 3)
    ok(result.error.includes('503'))
    ok(result.error.includes('latest.yml'))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('the archive reader refuses nonsense instead of throwing', () => {
  equal(readAsarHeader('/definitely/not/here.asar'), null)
  equal(readAsarPackageVersion('/definitely/not/here.asar'), null)
})

test('the real checkout exposes its version when one is installed', () => {
  // Outside a packaged installation there is nothing to read, so the case is
  // informational: it must never throw, and it must agree with itself.
  const exe = process.execPath
  const paths = resolveInstallPaths(exe)
  const version = readAppVersion(paths)
  ok(typeof version.version === 'string')
  if (existsSync(paths.asarPath)) {
    ok(version.version.length > 0, 'a present archive must yield a version')
    equal(version.source, 'app.asar/package.json')
    equal(readAsarPackageVersion(paths.asarPath), version.version)
  }
})

await run('appinfo')
