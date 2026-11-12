import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { ROUTE_PATHS, createRouteHandlers } from '../lib/routes.js'

function createRequest({ method = 'GET', url = ROUTE_PATHS.status, body = '' } = {}) {
  const stream = Readable.from(body.length > 0 ? [body] : [])
  return Object.assign(stream, { method, url })
}

function createResponse() {
  const record = { status: 0, headers: null, body: '' }
  return {
    record,
    writeHead(status, headers) {
      record.status = status
      record.headers = headers
    },
    end(body) {
      record.body = body ?? ''
    },
  }
}

async function call(handler, request) {
  const response = createResponse()
  await handler(request, response)
  return {
    status: response.record.status,
    headers: response.record.headers,
    body: response.record.body ? JSON.parse(response.record.body) : null,
  }
}

function createHarness({ failStatus = false } = {}) {
  const calls = { readRecent: [], saveConfig: [] }
  const hub = {
    async self() {
      if (failStatus) throw new Error('boom')
      return { tunnel: { url: 'https://a.trycloudflare.com' }, machine: { name: 'pc-a' } }
    },
    async publishNow() {
      return { ok: true, url: 'https://a.trycloudflare.com', changed: ['tunnels.md'] }
    },
  }
  const logStore = {
    async readRecent(options) {
      calls.readRecent.push(options)
      return [{ t: '2026-11-12T00:00:00.000Z', level: 'info', msg: 'hello' }]
    },
  }
  const handlers = createRouteHandlers({
    hub,
    logStore,
    getConfigView: () => ({ machineName: 'pc-a', token: '', tokenConfigured: false }),
    saveConfig: async (patch) => {
      calls.saveConfig.push(patch)
      return { ...patch, token: '', tokenConfigured: false }
    },
  })
  return { handlers, calls }
}

test('GET /status 返回状态与配置视图', async () => {
  const { handlers } = createHarness()
  const result = await call(handlers.status, createRequest())
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.equal(result.body.status.tunnel.url, 'https://a.trycloudflare.com')
  assert.equal(result.body.config.tokenConfigured, false)
  assert.equal(result.headers['cache-control'], 'no-store')
})

test('GET /status 出错时返回 500', async () => {
  const { handlers } = createHarness({ failStatus: true })
  const result = await call(handlers.status, createRequest())
  assert.equal(result.status, 500)
  assert.equal(result.body.ok, false)
})

test('GET /logs 传递 hours 与 limit', async () => {
  const { handlers, calls } = createHarness()
  const result = await call(handlers.logs, createRequest({ url: `${ROUTE_PATHS.logs}?hours=6&limit=50` }))
  assert.equal(result.status, 200)
  assert.equal(result.body.entries.length, 1)
  assert.deepEqual(calls.readRecent[0], { hours: 6, limit: 50 })
})

test('POST /publish 触发立即更新，GET 被拒绝', async () => {
  const { handlers } = createHarness()
  const posted = await call(handlers.publish, createRequest({ method: 'POST', url: ROUTE_PATHS.publish }))
  assert.equal(posted.status, 200)
  assert.equal(posted.body.result.ok, true)

  const rejected = await call(handlers.publish, createRequest({ method: 'GET', url: ROUTE_PATHS.publish }))
  assert.equal(rejected.status, 405)
})

test('POST /config 保存配置，非法 JSON 返回 400', async () => {
  const { handlers, calls } = createHarness()
  const saved = await call(handlers.config, createRequest({
    method: 'POST',
    url: ROUTE_PATHS.config,
    body: JSON.stringify({ machineName: 'workstation' }),
  }))
  assert.equal(saved.status, 200)
  assert.equal(saved.body.ok, true)
  assert.deepEqual(calls.saveConfig[0], { machineName: 'workstation' })

  const invalid = await call(handlers.config, createRequest({ method: 'POST', url: ROUTE_PATHS.config, body: '{oops' }))
  assert.equal(invalid.status, 400)
})

test('GET /config 返回配置视图', async () => {
  const { handlers } = createHarness()
  const result = await call(handlers.config, createRequest({ url: ROUTE_PATHS.config }))
  assert.equal(result.status, 200)
  assert.equal(result.body.config.machineName, 'pc-a')
})
