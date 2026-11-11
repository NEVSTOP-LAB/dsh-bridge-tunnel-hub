import assert from 'node:assert/strict'
import test from 'node:test'
import {
  findTunnelEntry,
  parseTunnelEntries,
  removeTunnelEntry,
  sanitizeMachineName,
  serializeTunnelEntries,
  upsertTunnelEntry,
} from '../lib/tunnels.js'

test('机器名里的冒号与换行被收敛掉', () => {
  assert.equal(sanitizeMachineName('  工位:主机\n'), '工位 主机')
  assert.equal(sanitizeMachineName('  '), null)
  assert.equal(sanitizeMachineName(null), null)
})

test('解析跳过空行与注释，并按第一个冒号切分', () => {
  const text = [
    '# 手写备注',
    '',
    'pc-a:https://a.trycloudflare.com',
    'pc-b:https://b.trycloudflare.com?auth=secret',
  ].join('\n')
  assert.deepEqual(parseTunnelEntries(text), [
    { name: 'pc-a', url: 'https://a.trycloudflare.com' },
    { name: 'pc-b', url: 'https://b.trycloudflare.com?auth=secret' },
  ])
})

test('同名条目后者覆盖前者，位置保持不变', () => {
  const text = 'a:https://one\nb:https://two\na:https://three\n'
  assert.deepEqual(parseTunnelEntries(text), [
    { name: 'a', url: 'https://three' },
    { name: 'b', url: 'https://two' },
  ])
})

test('upsert 只改自己那一行，其他行原样保留', () => {
  const original = 'pc-a:https://a\ntablet:https://t\n'
  const updated = upsertTunnelEntry(original, { name: 'pc-a', url: 'https://a2' })
  assert.equal(updated, 'pc-a:https://a2\ntablet:https://t\n')
})

test('upsert 新机器时追加到末尾', () => {
  const updated = upsertTunnelEntry('pc-a:https://a\n', { name: 'laptop', url: 'https://l' })
  assert.equal(updated, 'pc-a:https://a\nlaptop:https://l\n')
})

test('机器名大小写不敏感地匹配', () => {
  const updated = upsertTunnelEntry('PC-A:https://a\n', { name: 'pc-a', url: 'https://b' })
  assert.equal(updated, 'pc-a:https://b\n')
})

test('删除条目与查找条目', () => {
  const text = 'pc-a:https://a\npc-b:https://b\n'
  assert.equal(removeTunnelEntry(text, 'PC-A'), 'pc-b:https://b\n')
  assert.deepEqual(findTunnelEntry(text, 'pc-b'), { name: 'pc-b', url: 'https://b' })
  assert.equal(findTunnelEntry(text, 'missing'), null)
})

test('序列化空集合得到空串', () => {
  assert.equal(serializeTunnelEntries([]), '')
})
