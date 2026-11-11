import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createFakeGitHub } from './fake-github.mjs'
import { normalizeConfig } from '../lib/config.js'
import { LocalState } from '../lib/state.js'
import { TunnelHub } from '../lib/hub.js'
import { createRestTransport } from '../lib/transport.js'

const silentLogger = { info() {}, warn() {}, error() {} }

async function withHarness(fn, { machineName = 'pc-a', autoPublish = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'tunnel-hub-'))
  const logPath = join(directory, 'cloudflared.log')
  const configPath = join(directory, 'config.json')
  const statePath = join(directory, 'state.json')
  const fake = createFakeGitHub()

  async function setQuickTunnel(host) {
    await writeFile(logPath, `INF |  https://${host}.trycloudflare.com  |\n`, 'utf8')
  }
  await setQuickTunnel('pc-a-first')
  await writeFile(configPath, JSON.stringify({ cloudflared: {} }), 'utf8')

  function createHub({ name = machineName, token = 'test-token' } = {}) {
    const config = normalizeConfig({
      machineName: name,
      token,
      logPath,
      bridgeConfigPath: configPath,
      autoPublish,
      scanIntervalSec: 5,
    })
    const state = new LocalState(statePath)
    return new TunnelHub({
      config,
      state,
      paths: { log: logPath, config: configPath },
      logger: silentLogger,
      fetchImpl: fake.fetchImpl,
      transport: createRestTransport({ token, fetchImpl: fake.fetchImpl }),
    })
  }

  try {
    return await fn({ directory, fake, setQuickTunnel, createHub, logPath, configPath })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('首次启动自动创建 Gist，并写入本机一行', async () => {
  await withHarness(async ({ fake, createHub }) => {
    const hub = createHub()
    await hub.init()
    assert.equal(hub.machineName, 'pc-a')
    assert.equal(fake.readFile('tunnels.txt'), 'pc-a:https://pc-a-first.trycloudflare.com\n')
    const status = JSON.parse(fake.readFile('status.json'))
    assert.equal(status.version, 1)
    assert.equal(status.machines['pc-a'].url, 'https://pc-a-first.trycloudflare.com')
    assert.equal(status.machines['pc-a'].kind, 'quick')
    assert.ok(status.machines['pc-a'].updatedAt)
  })
})

test('地址没变时不产生新的写入', async () => {
  await withHarness(async ({ fake, createHub }) => {
    const hub = createHub()
    await hub.init()
    const updatedAt = JSON.parse(fake.readFile('status.json')).machines['pc-a'].updatedAt
    const result = await hub.publishNow()
    assert.equal(result.unchanged, true)
    assert.equal(JSON.parse(fake.readFile('status.json')).machines['pc-a'].updatedAt, updatedAt)
  })
})

test('地址变化时只更新本机那一行，别的机器原样保留', async () => {
  await withHarness(async ({ fake, createHub, setQuickTunnel }) => {
    const hub = createHub()
    await hub.init()
    // 模拟另一台机器已经上报过
    fake.writeFile('tunnels.txt', `laptop:https://laptop.trycloudflare.com\n${fake.readFile('tunnels.txt')}`)

    await setQuickTunnel('pc-a-second')
    const result = await hub.publishNow()
    assert.equal(result.ok, true)
    assert.equal(result.url, 'https://pc-a-second.trycloudflare.com')
    assert.equal(
      fake.readFile('tunnels.txt'),
      'laptop:https://laptop.trycloudflare.com\npc-a:https://pc-a-second.trycloudflare.com\n',
    )
    const status = JSON.parse(fake.readFile('status.json'))
    assert.equal(status.machines['pc-a'].url, 'https://pc-a-second.trycloudflare.com')
    assert.equal(status.machines['laptop'], undefined)
  })
})

test('改机器名后旧名字那一行被删除', async () => {
  await withHarness(async ({ fake, createHub }) => {
    const hub = createHub()
    await hub.init()
    const renamed = createHub({ name: 'workstation' })
    await renamed.init()
    assert.equal(fake.readFile('tunnels.txt'), 'workstation:https://pc-a-first.trycloudflare.com\n')
    const status = JSON.parse(fake.readFile('status.json'))
    assert.deepEqual(Object.keys(status.machines), ['workstation'])
  })
})

test('autoPublish 关闭时只采集、不写 Gist', async () => {
  await withHarness(async ({ fake, createHub }) => {
    const hub = createHub()
    await hub.init()
    assert.equal(fake.readFile('tunnels.txt'), null)
    const self = await hub.self()
    assert.equal(self.tunnel.url, 'https://pc-a-first.trycloudflare.com')
  }, { autoPublish: false })
})

test('list 列出全部机器并标注可达性', async () => {
  await withHarness(async ({ fake, createHub }) => {
    const hub = createHub()
    await hub.init()
    fake.writeFile('tunnels.txt', `${fake.readFile('tunnels.txt')}laptop:https://laptop.trycloudflare.com\n`)
    const listed = await hub.list()
    assert.equal(listed.machines.length, 2)
    const laptop = listed.machines.find((machine) => machine.name === 'laptop')
    assert.equal(laptop.reachable, true)
    assert.equal(laptop.ageSeconds, null)
    const self = listed.machines.find((machine) => machine.self)
    assert.equal(self.name, 'pc-a')
    assert.ok(self.updatedAt)
  })
})

test('探活失败时不把死地址写出去', async () => {
  await withHarness(async ({ fake, createHub, setQuickTunnel }) => {
    const hub = createHub()
    await hub.init()
    fake.writeFile('tunnels.txt', 'pc-a:https://pc-a-first.trycloudflare.com\n')

    // 探活失败：让假 GitHub 拒绝隧道域名请求
    const failingFetch = async (url, options) => {
      if (String(url).includes('trycloudflare.com')) {
        return { ok: false, status: 502, text: async () => '' }
      }
      return fake.fetchImpl(url, options)
    }
    hub.fetchImpl = failingFetch
    await setQuickTunnel('pc-a-dead')
    const result = await hub.scan({ force: false })
    assert.equal(result.ok, false)
    assert.match(result.error, /暂不可用/)
    assert.equal(fake.readFile('tunnels.txt'), 'pc-a:https://pc-a-first.trycloudflare.com\n')
  })
})
