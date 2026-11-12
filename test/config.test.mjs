import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_CONFIG, MAX_PROBE_TIMEOUT_MS, MIN_SCAN_INTERVAL_SEC, normalizeConfig } from '../lib/config.js'

test('空配置得到全部默认值', () => {
  assert.deepEqual(normalizeConfig({}), { ...DEFAULT_CONFIG })
  assert.deepEqual(normalizeConfig(undefined), { ...DEFAULT_CONFIG })
  assert.deepEqual(normalizeConfig([]), { ...DEFAULT_CONFIG })
})

test('字符串配置去掉首尾空白', () => {
  const config = normalizeConfig({ machineName: '  工位主机  ', gistUrl: ' https://gist.github.com/x  ' })
  assert.equal(config.machineName, '工位主机')
  assert.equal(config.gistUrl, 'https://gist.github.com/x')
})

test('数值配置被夹到合法区间', () => {
  assert.equal(normalizeConfig({ scanIntervalSec: 1 }).scanIntervalSec, MIN_SCAN_INTERVAL_SEC)
  assert.equal(normalizeConfig({ scanIntervalSec: 'abc' }).scanIntervalSec, DEFAULT_CONFIG.scanIntervalSec)
  assert.equal(normalizeConfig({ probeTimeoutMs: 10 ** 9 }).probeTimeoutMs, MAX_PROBE_TIMEOUT_MS)
  assert.equal(normalizeConfig({ scanIntervalSec: 30.6 }).scanIntervalSec, 31)
})

test('autoPublish 只有显式 false 才关闭', () => {
  assert.equal(normalizeConfig({ autoPublish: false }).autoPublish, false)
  assert.equal(normalizeConfig({ autoPublish: 'no' }).autoPublish, true)
  assert.equal(normalizeConfig({}).autoPublish, true)
})

test('心跳间隔默认 4 小时，可关可夹', () => {
  assert.equal(normalizeConfig({}).heartbeatHours, 4)
  assert.equal(normalizeConfig({ heartbeatHours: 0 }).heartbeatHours, 0)
  assert.equal(normalizeConfig({ heartbeatHours: 100 }).heartbeatHours, 24)
  assert.equal(normalizeConfig({ heartbeatHours: 'abc' }).heartbeatHours, 4)
  assert.equal(normalizeConfig({ heartbeatHours: 6.4 }).heartbeatHours, 6)
})
