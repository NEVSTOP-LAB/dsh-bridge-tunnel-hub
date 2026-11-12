import assert from 'node:assert/strict'
import test from 'node:test'
import { createFakeGitHub } from './fake-github.mjs'
import {
  GIST_DESCRIPTION,
  createGist,
  gistWebUrl,
  parseGistId,
  patchGist,
  readGist,
} from '../lib/gist.js'

test('解析 Gist ID：裸 ID、链接、gist: 前缀都支持', () => {
  const id = 'a'.repeat(32)
  assert.equal(parseGistId(id), id)
  assert.equal(parseGistId(`https://gist.github.com/nevstop/${id}`), id)
  assert.equal(parseGistId(`gist:${id}`), id)
  assert.equal(parseGistId('https://gist.github.com/'), '')
  assert.equal(parseGistId('not an id'), '')
})

test('创建、读取、更新 Gist', async () => {
  const fake = createFakeGitHub()
  const created = await createGist({
    token: 't',
    files: { 'tunnels.txt': 'pc-a:https://a\n' },
    fetchImpl: fake.fetchImpl,
  })
  assert.equal(created.id, fake.id)
  assert.equal(created.htmlUrl, `https://gist.github.com/${fake.id}`)
  assert.equal(gistWebUrl(fake.id), `https://gist.github.com/${fake.id}`)

  const read = await readGist({ id: fake.id, token: 't', fetchImpl: fake.fetchImpl })
  assert.equal(read.files['tunnels.txt'], 'pc-a:https://a\n')
  assert.equal(read.description, GIST_DESCRIPTION)

  await patchGist({ id: fake.id, token: 't', files: { 'tunnels.txt': 'pc-a:https://b\n' }, fetchImpl: fake.fetchImpl })
  const updated = await readGist({ id: fake.id, fetchImpl: fake.fetchImpl })
  assert.equal(updated.files['tunnels.txt'], 'pc-a:https://b\n')
})

test('无 token 也能读 secret Gist', async () => {
  const fake = createFakeGitHub()
  await createGist({ token: 't', files: { 'tunnels.txt': 'x:y\n' }, fetchImpl: fake.fetchImpl })
  const read = await readGist({ id: fake.id, fetchImpl: fake.fetchImpl })
  assert.equal(read.files['tunnels.txt'], 'x:y\n')
})

test('patchGist 传 null 删除旧文件（迁移用）', async () => {
  const fake = createFakeGitHub()
  await createGist({ token: 't', files: { 'tunnels.txt': 'x\n', 'tunnels.md': '- [x](https://x)\n' }, fetchImpl: fake.fetchImpl })
  await patchGist({ id: fake.id, token: 't', files: { 'tunnels.txt': null }, fetchImpl: fake.fetchImpl })
  const read = await readGist({ id: fake.id, fetchImpl: fake.fetchImpl })
  assert.equal(read.files['tunnels.txt'], undefined)
  assert.equal(read.files['tunnels.md'], '- [x](https://x)\n')
})

test('HTTP 错误转成带状态码的 GistError', async () => {
  const unauthorized = async () => ({ ok: false, status: 401, text: async () => '{"message":"Bad credentials"}' })
  await assert.rejects(
    () => createGist({ token: 'bad', files: {}, fetchImpl: unauthorized }),
    (error) => error.status === 401 && /gitHub 401/i.test(error.message) && /gist 权限/.test(error.message),
  )

  const missing = async () => ({ ok: false, status: 404, text: async () => '{"message":"Not Found"}' })
  await assert.rejects(
    () => readGist({ id: 'b'.repeat(32), token: 't', fetchImpl: missing }),
    (error) => error.status === 404,
  )
})

test('网络异常转成可读错误', async () => {
  const offline = async () => { throw new Error('getaddrinfo ENOTFOUND api.github.com') }
  await assert.rejects(
    () => createGist({ token: 't', files: {}, fetchImpl: offline }),
    /连接 GitHub 失败/,
  )
})
