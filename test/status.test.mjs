import assert from 'node:assert/strict'
import test from 'node:test'
import {
  findMachineNameById,
  parseStatus,
  serializeStatus,
  upsertStatusMachine,
} from '../lib/status.js'

const machine = {
  name: 'pc-a',
  machineId: 'id-a',
  url: 'https://a.trycloudflare.com',
  kind: 'quick',
}

test('解析非法内容得到空结构', () => {
  assert.deepEqual(parseStatus('not json'), { generatedAt: null, machines: {} })
  assert.deepEqual(parseStatus(''), { generatedAt: null, machines: {} })
  assert.deepEqual(parseStatus('{"machines":[]}'), { generatedAt: null, machines: {} })
})

test('写入机器记录并保留其他机器', () => {
  const first = upsertStatusMachine(parseStatus(''), machine, '2026-11-11T00:00:00.000Z')
  const second = upsertStatusMachine(first, { name: 'pc-b', machineId: 'id-b', url: 'https://b' }, '2026-11-11T01:00:00.000Z')
  assert.equal(second.generatedAt, '2026-11-11T01:00:00.000Z')
  assert.deepEqual(Object.keys(second.machines).sort(), ['pc-a', 'pc-b'])
  assert.equal(second.machines['pc-a'].updatedAt, '2026-11-11T00:00:00.000Z')
})

test('改名按机器 ID 换键，不留孤儿条目', () => {
  const before = upsertStatusMachine(parseStatus(''), machine, '2026-11-11T00:00:00.000Z')
  const renamed = upsertStatusMachine(before, { ...machine, name: 'workstation' }, '2026-11-11T02:00:00.000Z')
  assert.deepEqual(Object.keys(renamed.machines), ['workstation'])
  assert.equal(findMachineNameById(renamed, 'id-a'), 'workstation')
})

test('按原有位置替换条目，不把本机条目挪到末尾', () => {
  const base = upsertStatusMachine(parseStatus(''), machine, '2026-11-11T00:00:00.000Z')
  const other = upsertStatusMachine(base, { name: 'pc-b', machineId: 'id-b', url: 'https://b' }, '2026-11-11T01:00:00.000Z')
  assert.deepEqual(Object.keys(other.machines), ['pc-a', 'pc-b'])

  // 本机条目本来在第一位：再写一次仍应在第一位，否则两台机器会轮流翻转顺序、每次都算"有变化"
  const again = upsertStatusMachine(other, { ...machine, url: 'https://a2' }, '2026-11-11T02:00:00.000Z')
  assert.deepEqual(Object.keys(again.machines), ['pc-a', 'pc-b'])
  assert.equal(again.machines['pc-a'].url, 'https://a2')
})

test('序列化后能再解析回来', () => {
  const status = upsertStatusMachine(parseStatus(''), machine, '2026-11-11T00:00:00.000Z')
  const round = parseStatus(serializeStatus(status))
  assert.equal(round.generatedAt, '2026-11-11T00:00:00.000Z')
  assert.deepEqual(round.machines['pc-a'], status.machines['pc-a'])
})
