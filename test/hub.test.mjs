import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createFakeGitHub } from './fake-github.mjs'
import { normalizeConfig } from '../lib/config.js'
import { LocalState } from '../lib/state.js'
import { TunnelHub, msUntilNextAlignedHour } from '../lib/hub.js'
import { createRestTransport } from '../lib/transport.js'
import { parseTunnelEntries } from '../lib/tunnels.js'
import { createGist } from '../lib/gist.js'

const silentLogger = { info() {}, warn() {}, error() {} }

/** 匹配"链接 + 最后在线时间"的一行（多行文本里按行匹配）。 */
function mdLinePattern(name, url) {
  const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^- \\[${name}\\]\\(${escaped}\\) — \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} [+-]\\d{2}:\\d{2}$`, 'm')
}

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

  function createHub({ name = machineName, token = 'test-token', now = () => new Date() } = {}) {
    const config = normalizeConfig({
      machineName: name,
      token,
      logPath,
      bridgeConfigPath: configPath,
      autoPublish,
      scanIntervalSec: 5,
      heartbeatHours: 4,
    })
    const state = new LocalState(statePath)
    return new TunnelHub({
      config,
      state,
      paths: { log: logPath, config: configPath },
      logger: silentLogger,
      fetchImpl: fake.fetchImpl,
      transport: createRestTransport({ token, fetchImpl: fake.fetchImpl }),
      now,
    })
  }

  try {
    return await fn({ directory, fake, setQuickTunnel, createHub, logPath, configPath })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('首次启动自动创建 Gist，写入可点击链接与最小状态字段', async () => {
  await withHarness(async ({ fake, createHub }) => {
    const hub = createHub()
    await hub.init()
    assert.equal(hub.machineName, 'pc-a')
    assert.match(fake.readFile('tunnels.md'), mdLinePattern('pc-a', 'https://pc-a-first.trycloudflare.com'))
    assert.equal(fake.readFile('tunnels.txt'), null)

    const status = JSON.parse(fake.readFile('dsh-bridge-tunnel-hub.json'))
    assert.equal(status.version, 1)
    const machine = status.machines['pc-a']
    assert.deepEqual(Object.keys(machine).sort(), ['kind', 'machineId', 'name', 'updatedAt', 'url'])
    assert.equal(machine.url, 'https://pc-a-first.trycloudflare.com')
    assert.equal(machine.kind, 'quick')
    assert.ok(machine.updatedAt)
    // 版本与平台类字段不再写入汇总，降低泄露后的信息量
    assert.equal(machine.bridgeVersion, undefined)
    assert.equal(machine.node, undefined)
    assert.equal(machine.platform, undefined)
  })
})

test('地址没变时不产生新的写入', async () => {
  await withHarness(async ({ fake, createHub }) => {
    const hub = createHub()
    await hub.init()
    const updatedAt = JSON.parse(fake.readFile('dsh-bridge-tunnel-hub.json')).machines['pc-a'].updatedAt
    const result = await hub.publishNow()
    assert.equal(result.unchanged, true)
    assert.equal(JSON.parse(fake.readFile('dsh-bridge-tunnel-hub.json')).machines['pc-a'].updatedAt, updatedAt)
  })
})

test('地址变化时只更新本机那一行，别的机器原样保留', async () => {
  await withHarness(async ({ fake, createHub, setQuickTunnel }) => {
    const hub = createHub()
    await hub.init()
    fake.writeFile('tunnels.md', `- [laptop](https://laptop.trycloudflare.com)\n${fake.readFile('tunnels.md')}`)

    await setQuickTunnel('pc-a-second')
    const result = await hub.publishNow()
    assert.equal(result.ok, true)
    assert.equal(result.url, 'https://pc-a-second.trycloudflare.com')
    const markdown = fake.readFile('tunnels.md')
    assert.match(markdown, /^- \[laptop\]\(https:\/\/laptop\.trycloudflare\.com\)\n/)
    assert.match(markdown, mdLinePattern('pc-a', 'https://pc-a-second.trycloudflare.com'))
    const status = JSON.parse(fake.readFile('dsh-bridge-tunnel-hub.json'))
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
    assert.match(fake.readFile('tunnels.md'), mdLinePattern('workstation', 'https://pc-a-first.trycloudflare.com'))
    const status = JSON.parse(fake.readFile('dsh-bridge-tunnel-hub.json'))
    assert.deepEqual(Object.keys(status.machines), ['workstation'])
  })
})

test('autoPublish 关闭时只采集、不写 Gist', async () => {
  await withHarness(async ({ fake, createHub }) => {
    const hub = createHub()
    await hub.init()
    assert.equal(fake.readFile('tunnels.md'), null)
    const self = await hub.self()
    assert.equal(self.tunnel.url, 'https://pc-a-first.trycloudflare.com')
  }, { autoPublish: false })
})

test('list 列出全部机器并标注可达性与心跳新鲜度', async () => {
  await withHarness(async ({ fake, createHub }) => {
    const hub = createHub()
    await hub.init()
    fake.writeFile('tunnels.md', `${fake.readFile('tunnels.md')}- [laptop](https://laptop.trycloudflare.com)\n`)
    const listed = await hub.list()
    assert.equal(listed.heartbeatHours, 4)
    assert.equal(listed.machines.length, 2)

    const laptop = listed.machines.find((machine) => machine.name === 'laptop')
    assert.equal(laptop.reachable, true)
    assert.equal(laptop.ageSeconds, null)
    assert.equal(laptop.stale, null)

    const self = listed.machines.find((machine) => machine.self)
    assert.equal(self.name, 'pc-a')
    assert.ok(self.updatedAt)
    assert.equal(self.stale, false)
  })
})

test('状态文件里本机条目不在末尾也不会被重写（避免两台机器轮流翻转顺序）', async () => {
  await withHarness(async ({ fake, createHub }) => {
    const hub = createHub()
    await hub.init()

    // 模拟另一台机器写过的顺序：本机在前、另一台在后
    const current = JSON.parse(fake.readFile('dsh-bridge-tunnel-hub.json'))
    const reordered = {
      version: current.version,
      generatedAt: current.generatedAt,
      machines: {
        'pc-a': current.machines['pc-a'],
        laptop: {
          name: 'laptop',
          machineId: 'id-laptop',
          url: 'https://laptop.trycloudflare.com',
          kind: 'quick',
          updatedAt: '2026-11-12T00:00:00.000Z',
        },
      },
    }
    const text = `${JSON.stringify(reordered, null, 2)}\n`
    fake.writeFile('dsh-bridge-tunnel-hub.json', text)
    fake.writeFile('tunnels.md', `${fake.readFile('tunnels.md')}- [laptop](https://laptop.trycloudflare.com) — 2026-11-12 08:00 +08:00\n`)

    const result = await hub.publishNow()
    assert.equal(result.unchanged, true)
    assert.equal(fake.readFile('dsh-bridge-tunnel-hub.json'), text, '状态文件不应被重写')
  })
})

test('心跳：地址不变也会刷新最后在线时间（链接与状态同步刷新）', async () => {
  await withHarness(async ({ fake, createHub }) => {
    let clock = new Date(2026, 10, 12, 8, 45, 0)
    const hub = createHub({ now: () => new Date(clock) })
    await hub.init()
    const beforeMarkdown = fake.readFile('tunnels.md')
    const beforeStatus = JSON.parse(fake.readFile('dsh-bridge-tunnel-hub.json')).machines['pc-a']

    clock = new Date(2026, 10, 12, 12, 0, 0)
    const result = await hub.scan({ heartbeat: true })
    assert.equal(result.ok, true)

    const afterMarkdown = fake.readFile('tunnels.md')
    const afterStatus = JSON.parse(fake.readFile('dsh-bridge-tunnel-hub.json')).machines['pc-a']
    assert.notEqual(afterMarkdown, beforeMarkdown)
    assert.notEqual(afterStatus.updatedAt, beforeStatus.updatedAt)
    assert.ok(Date.parse(afterStatus.updatedAt) > Date.parse(beforeStatus.updatedAt))

    // 链接本身不变，变的只有行尾时间
    const beforeEntry = parseTunnelEntries(beforeMarkdown)[0]
    const afterEntry = parseTunnelEntries(afterMarkdown)[0]
    assert.equal(afterEntry.name, 'pc-a')
    assert.equal(afterEntry.url, beforeEntry.url)
    assert.notEqual(afterEntry.updatedAt, beforeEntry.updatedAt)
    assert.match(afterEntry.updatedAt, /^2026-11-12 12:00 [+-]\d{2}:\d{2}$/)
  })
})

test('旧版 tunnels.txt 自动迁移成 tunnels.md 并删除旧文件', async () => {
  await withHarness(async ({ fake, createHub }) => {
    const hub = createHub()
    await hub.init()
    fake.writeFile('tunnels.txt', 'laptop:https://laptop.trycloudflare.com\n')
    await hub.publishNow()
    assert.equal(fake.readFile('tunnels.txt'), null)
    const markdown = fake.readFile('tunnels.md')
    assert.match(markdown, mdLinePattern('pc-a', 'https://pc-a-first.trycloudflare.com'))
    // 旧格式里的机器名没有时间，迁移后先保留无时间形态，等它自己上报时补上
    assert.match(markdown, /^- \[laptop\]\(https:\/\/laptop\.trycloudflare\.com\)$/m)
  })
})

test('旧版 status.json 自动迁移到 dsh-bridge-tunnel-hub.json 并删除旧文件', async () => {
  await withHarness(async ({ fake, createHub }) => {
    const hub = createHub()
    await hub.init()
    const statusText = fake.readFile('dsh-bridge-tunnel-hub.json')
    // 还原成"只存在旧文件名"的 Gist 状态
    fake.writeFile('status.json', statusText)
    fake.deleteFile('dsh-bridge-tunnel-hub.json')

    await hub.publishNow()
    assert.equal(fake.readFile('status.json'), null)
    assert.equal(fake.readFile('dsh-bridge-tunnel-hub.json'), statusText)

    // 读取侧也认旧文件名（迁移前的 Gist 仍可列出）
    fake.writeFile('status.json', statusText)
    fake.deleteFile('dsh-bridge-tunnel-hub.json')
    const listed = await hub.list({ probe: false })
    assert.equal(listed.machines[0].updatedAt, JSON.parse(statusText).machines['pc-a'].updatedAt)
  })
})

/** 把一台"已有登记"塞进假 GitHub：可指定 id、描述与创建时间。 */
async function seedGist(fake, { id, description, createdAt = '2026-11-11T00:00:00.000Z', files }) {
  const seedFake = createFakeGitHub({ id })
  await createGist({ token: 't', description, files, fetchImpl: seedFake.fetchImpl })
  const record = seedFake.gists.get(id)
  record.created_at = createdAt
  record.updated_at = createdAt
  fake.gists.set(id, record)
  return id
}

const REGISTRY_FILES = {
  'tunnels.md': '- [laptop](https://laptop.trycloudflare.com) — 2026-11-12 08:00 +08:00\n',
  'dsh-bridge-tunnel-hub.json': JSON.stringify({
    version: 1,
    generatedAt: '2026-11-12T00:00:00.000Z',
    machines: {
      laptop: {
        name: 'laptop',
        machineId: 'id-laptop',
        url: 'https://laptop.trycloudflare.com',
        kind: 'quick',
        updatedAt: '2026-11-12T00:00:00.000Z',
      },
    },
  }),
}

test('首次运行会先加入已有登记 Gist，而不是再建一个', async () => {
  await withHarness(async ({ fake, createHub }) => {
    const existingId = await seedGist(fake, { id: 'c'.repeat(32), description: 'dsh-bridge-tunnel-hub', files: REGISTRY_FILES })
    const hub = createHub()
    await hub.init()

    assert.equal(hub.gistId, existingId)
    assert.equal(fake.gists.size, 1, '不应新建第二个 Gist')
    const joined = fake.gists.get(existingId)
    const markdown = joined.files['tunnels.md']
    assert.match(markdown, /laptop/)
    assert.match(markdown, mdLinePattern('pc-a', 'https://pc-a-first.trycloudflare.com'))
    const status = JSON.parse(joined.files['dsh-bridge-tunnel-hub.json'])
    assert.deepEqual(Object.keys(status.machines).sort(), ['laptop', 'pc-a'])
  })
})

test('描述被改过的登记 Gist 也能按文件特征复用', async () => {
  await withHarness(async ({ fake, createHub }) => {
    const existingId = await seedGist(fake, { id: 'd'.repeat(32), description: '被改过的描述', files: REGISTRY_FILES })
    const hub = createHub()
    await hub.init()

    assert.equal(hub.gistId, existingId)
    assert.equal(fake.gists.size, 1)
    // 加入后写入会把描述改回插件名
    assert.equal(fake.gists.get(existingId).description, 'dsh-bridge-tunnel-hub')
  })
})

test('描述匹配优先于仅文件匹配', async () => {
  await withHarness(async ({ fake, createHub }) => {
    const fileOnlyId = await seedGist(fake, {
      id: 'e'.repeat(32),
      description: '被改过的描述',
      createdAt: '2026-11-10T00:00:00.000Z',
      files: REGISTRY_FILES,
    })
    const describedId = await seedGist(fake, {
      id: 'f'.repeat(32),
      description: 'dsh-bridge-tunnel-hub',
      createdAt: '2026-11-11T00:00:00.000Z',
      files: REGISTRY_FILES,
    })
    const hub = createHub()
    await hub.init()

    assert.equal(hub.gistId, describedId)
    assert.notEqual(hub.gistId, fileOnlyId)
  })
})

test('探活失败时不把死地址写出去', async () => {
  await withHarness(async ({ fake, createHub, setQuickTunnel }) => {
    const hub = createHub()
    await hub.init()
    fake.writeFile('tunnels.md', '- [pc-a](https://pc-a-first.trycloudflare.com)\n')

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
    assert.equal(fake.readFile('tunnels.md'), '- [pc-a](https://pc-a-first.trycloudflare.com)\n')
  })
})

test('心跳时间对齐到本地整点的整数倍', () => {
  const at0840 = new Date(2026, 10, 12, 8, 40, 0)
  assert.equal(msUntilNextAlignedHour(4, at0840), 3 * 3600_000 + 20 * 60_000)

  const at1200 = new Date(2026, 10, 12, 12, 0, 0)
  assert.equal(msUntilNextAlignedHour(4, at1200), 4 * 3600_000)

  const at2359 = new Date(2026, 10, 12, 23, 59, 0)
  assert.equal(msUntilNextAlignedHour(4, at2359), 60_000)

  assert.equal(msUntilNextAlignedHour(0, at0840), null)
})
