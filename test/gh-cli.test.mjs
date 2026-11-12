import assert from 'node:assert/strict'
import test from 'node:test'
import { createCliTransport, isGhAvailable, parseGhStatus } from '../lib/gh-cli.js'
import { createGistTransport, createRestTransport } from '../lib/transport.js'
import { createFakeGitHub } from './fake-github.mjs'

const GIST_ID = 'b'.repeat(32)

/** 模拟 `gh api`：只认本插件用到的三条命令。 */
function createFakeGh() {
  let gist = null

  async function runner(args, input) {
    if (args[0] === '--version') return { code: 0, stdout: 'gh version 2.0.0', stderr: '' }
    const method = args[args.indexOf('-X') + 1] ?? 'GET'
    const path = args.find((arg) => arg.startsWith('/')) ?? ''
    const body = input ? JSON.parse(input) : undefined

    if (path === '/gists' && method === 'POST') {
      gist = {
        id: GIST_ID,
        description: body.description,
        updated_at: '2026-11-11T00:00:00Z',
        html_url: `https://gist.github.com/${GIST_ID}`,
        files: Object.fromEntries(Object.entries(body.files ?? {}).map(([name, file]) => [name, { content: file.content }])),
      }
      return { code: 0, stdout: JSON.stringify(gist), stderr: '' }
    }
    if (path === `/gists/${GIST_ID}`) {
      if (!gist) return { code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' }
      if (method === 'PATCH') {
        for (const [name, file] of Object.entries(body?.files ?? {})) gist.files[name] = { content: file.content }
        if (body?.description) gist.description = body.description
        gist.updated_at = '2026-11-11T01:00:00Z'
      }
      return { code: 0, stdout: JSON.stringify(gist), stderr: '' }
    }
    return { code: 1, stdout: '', stderr: `gh: Not Found (HTTP 404)` }
  }

  return { runner }
}

test('gh 报错里的 HTTP 状态可以还原', () => {
  assert.equal(parseGhStatus('gh: Not Found (HTTP 404)'), 404)
  assert.equal(parseGhStatus('gh: Bad credentials (HTTP 401)'), 401)
  assert.equal(parseGhStatus('gh: Not Found'), 404)
  assert.equal(parseGhStatus('something else'), null)
})

test('gh 可用性探测', async () => {
  const { runner } = createFakeGh()
  assert.equal(await isGhAvailable(runner), true)
  assert.equal(await isGhAvailable(async () => ({ code: 1 })), false)
  assert.equal(await isGhAvailable(async () => { throw new Error('ENOENT') }), false)
})

test('走 gh 通道创建、读取、更新 Gist', async () => {
  const { runner } = createFakeGh()
  const transport = createCliTransport({ runner })
  assert.equal(transport.kind, 'gh-cli')

  const created = await transport.create({ description: 'dsh-bridge-tunnel-hub', files: { 'tunnels.txt': 'pc-a:https://a\n' } })
  assert.equal(created.id, GIST_ID)
  assert.equal(created.files['tunnels.txt'], 'pc-a:https://a\n')

  const read = await transport.read({ id: GIST_ID })
  assert.equal(read.files['tunnels.txt'], 'pc-a:https://a\n')

  await transport.patch({ id: GIST_ID, files: { 'tunnels.txt': 'pc-a:https://b\n' } })
  const updated = await transport.read({ id: GIST_ID })
  assert.equal(updated.files['tunnels.txt'], 'pc-a:https://b\n')
  assert.equal(updated.updatedAt, '2026-11-11T01:00:00Z')
})

test('gh 通道把 404 转成带状态码的错误', async () => {
  const { runner } = createFakeGh()
  const transport = createCliTransport({ runner })
  await assert.rejects(() => transport.read({ id: 'c'.repeat(32) }), (error) => error.status === 404)
})

test('gh 通道可以列出账号下的 Gist（用于加入已有登记）', async () => {
  const runner = async (args) => {
    if (args[0] === '--version') return { code: 0, stdout: 'gh version 2.0.0', stderr: '' }
    if (args[0] === 'api' && String(args[1]).startsWith('/gists?per_page=100')) {
      return {
        code: 0,
        stdout: JSON.stringify([{
          id: GIST_ID,
          description: 'dsh-bridge-tunnel-hub',
          created_at: '2026-11-11T00:00:00Z',
          updated_at: '2026-11-11T01:00:00Z',
          files: { 'tunnels.md': { filename: 'tunnels.md', size: 10 }, 'dsh-bridge-tunnel-hub.json': { filename: 'dsh-bridge-tunnel-hub.json', size: 10 } },
        }]),
        stderr: '',
      }
    }
    return { code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' }
  }
  const transport = createCliTransport({ runner })
  const gists = await transport.list()
  assert.equal(gists.length, 1)
  assert.equal(gists[0].id, GIST_ID)
  assert.equal(gists[0].description, 'dsh-bridge-tunnel-hub')
  assert.equal(gists[0].createdAt, '2026-11-11T00:00:00Z')
  assert.deepEqual(gists[0].files.sort(), ['dsh-bridge-tunnel-hub.json', 'tunnels.md'])
})

test('通道选择：有 gh 走 gh，没有 gh 走 REST', async () => {
  const fake = createFakeGitHub()
  const viaCli = await createGistTransport({ ghAvailable: async () => true })
  assert.equal(viaCli.kind, 'gh-cli')

  const viaRest = await createGistTransport({ token: 't', fetchImpl: fake.fetchImpl, ghAvailable: async () => false })
  assert.equal(viaRest.kind, 'rest')
})

test('REST 通道没有 token 时给出可读错误', () => {
  assert.throws(() => createRestTransport({ token: '' }), /没有可用的 GitHub token/)
})
