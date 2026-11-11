import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  detectTunnel,
  findLastQuickTunnelUrl,
  probePublicUrl,
  readFileTail,
  sanitizeHostname,
  sanitizePublicUrl,
} from '../lib/source.js'

async function withTempDir(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'tunnel-hub-source-'))
  try {
    return await fn(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('取日志里最后一个临时隧道地址', () => {
  const log = [
    'INF https://first-tunnel.trycloudflare.com',
    'some noise',
    'INF https://second-tunnel.trycloudflare.com',
    'INF Registered tunnel connection',
  ].join('\n')
  assert.equal(findLastQuickTunnelUrl(log), 'https://second-tunnel.trycloudflare.com')
})

test('日志里没有地址时返回 null，且不匹配普通的 http 地址', () => {
  assert.equal(findLastQuickTunnelUrl('nothing here'), null)
  assert.equal(findLastQuickTunnelUrl('http://x.trycloudflare.com'), null)
})

test('对外地址只保留 scheme 与 host，丢掉查询串（含 auth 凭据）', () => {
  assert.equal(
    sanitizePublicUrl('https://pc-a.trycloudflare.com/?auth=secret#x'),
    'https://pc-a.trycloudflare.com',
  )
  assert.equal(sanitizePublicUrl(' https://pc-a.trycloudflare.com '), 'https://pc-a.trycloudflare.com')
  assert.equal(sanitizePublicUrl('ftp://example.com'), null)
  assert.equal(sanitizePublicUrl('not a url'), null)
  assert.equal(sanitizePublicUrl(undefined), null)
})

test('hostname 收敛：允许带协议前缀与端口', () => {
  assert.equal(sanitizeHostname('dsh.example.com'), 'dsh.example.com')
  assert.equal(sanitizeHostname('https://dsh.example.com/path'), 'dsh.example.com')
  assert.equal(sanitizeHostname('  '), null)
})

test('readFileTail 只读尾部，读不到时返回空串', async () => {
  await withTempDir(async (directory) => {
    const file = join(directory, 'tail.log')
    await writeFile(file, '0123456789', 'utf8')
    assert.equal(readFileTail(file, 4), '6789')
    assert.equal(readFileTail(join(directory, 'missing.log')), '')
  })
})

test('手动地址优先于固定域名与临时隧道', async () => {
  await withTempDir(async (directory) => {
    const configPath = join(directory, 'config.json')
    const logPath = join(directory, 'cloudflared.log')
    await writeFile(configPath, JSON.stringify({ cloudflared: { hostname: 'dsh.example.com' } }), 'utf8')
    await writeFile(logPath, 'INF https://abc.trycloudflare.com', 'utf8')

    const manual = await detectTunnel({ manualUrl: 'https://manual.example.com', bridgeConfigPath: configPath, bridgeLogPath: logPath })
    assert.deepEqual(manual, { kind: 'manual', url: 'https://manual.example.com', source: 'manualUrl 配置' })

    const fixed = await detectTunnel({ bridgeConfigPath: configPath, bridgeLogPath: logPath })
    assert.equal(fixed.kind, 'fixed')
    assert.equal(fixed.url, 'https://dsh.example.com')

    const quick = await detectTunnel({ bridgeConfigPath: join(directory, 'missing.json'), bridgeLogPath: logPath })
    assert.equal(quick.kind, 'quick')
    assert.equal(quick.url, 'https://abc.trycloudflare.com')

    const none = await detectTunnel({ bridgeConfigPath: join(directory, 'missing.json'), bridgeLogPath: join(directory, 'missing.log') })
    assert.deepEqual(none, { kind: 'none', url: null, source: null })
  })
})

test('探活：JSON 2xx 视为可达，非 JSON 与网络错误视为不可达', async () => {
  const okFetch = async () => ({ ok: true, status: 200, text: async () => '{"enabled":true}' })
  assert.equal((await probePublicUrl('https://x.trycloudflare.com', { fetchImpl: okFetch })).reachable, true)

  const htmlFetch = async () => ({ ok: true, status: 200, text: async () => '<html></html>' })
  const html = await probePublicUrl('https://x.trycloudflare.com', { fetchImpl: htmlFetch })
  assert.equal(html.reachable, false)
  assert.match(html.error, /auth-status/)

  const notFound = async () => ({ ok: false, status: 502, text: async () => '' })
  assert.equal((await probePublicUrl('https://x.trycloudflare.com', { fetchImpl: notFound })).reachable, false)

  const throwFetch = async () => { throw new Error('boom') }
  assert.equal((await probePublicUrl('https://x.trycloudflare.com', { fetchImpl: throwFetch })).reachable, false)
})
