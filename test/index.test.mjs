import assert from 'node:assert/strict'
import test from 'node:test'
import { configView, saveConfigPatch } from '../lib/index.js'
import { normalizeConfig } from '../lib/config.js'

test('配置视图隐藏 token 明文，只暴露是否已设置', () => {
  const view = configView(normalizeConfig({ machineName: 'pc-a', token: 'secret-token' }))
  assert.equal(view.machineName, 'pc-a')
  assert.equal(view.token, '')
  assert.equal(view.tokenConfigured, true)

  const empty = configView(normalizeConfig({}))
  assert.equal(empty.tokenConfigured, false)
})

test('保存配置只接受 schema 里的字段，并合并进已有配置', async () => {
  let edited = null
  const ctx = {
    fiber: { entry: { id: 'dsh-bridge-tunnel-hub' } },
    get: () => ({
      async edit(entry, mutate) {
        edited = mutate({ machineName: 'old-name', heartbeatHours: 4 })
      },
    }),
  }

  const view = await saveConfigPatch(ctx, { machineName: 'new-name', evil: 'ignored' })
  assert.equal(view.machineName, 'new-name')
  assert.equal(view.heartbeatHours, 4)
  assert.equal(Object.hasOwn(edited, 'evil'), false)
})

test('没有配置编辑器时给出可读错误', async () => {
  await assert.rejects(
    () => saveConfigPatch({ fiber: {}, get: () => undefined }, { machineName: 'x' }),
    /不支持从界面保存插件配置/,
  )
})

test('没有可保存字段时拒绝写入', async () => {
  const ctx = { fiber: { entry: {} }, get: () => ({ async edit() {} }) }
  await assert.rejects(() => saveConfigPatch(ctx, { unknown: 1 }), /没有可保存的配置项/)
})
