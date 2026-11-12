import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { LogStore } from '../lib/log-store.js'

async function withStore(fn, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'tunnel-hub-log-'))
  try {
    return await fn(directory, options)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('写入后按时间倒序读出，并带级别', async () => {
  await withStore(async (directory) => {
    let clock = new Date('2026-11-12T00:00:00.000Z')
    const store = new LogStore({ directory, now: () => new Date(clock) })
    await store.append('info', 'first')
    clock = new Date('2026-11-12T00:01:00.000Z')
    await store.append('error', 'second')

    const entries = await store.readRecent({ hours: 24 })
    assert.deepEqual(entries.map((entry) => entry.msg), ['second', 'first'])
    assert.equal(entries[0].level, 'error')
    assert.equal(entries[0].t, '2026-11-12T00:01:00.000Z')
  })
})

test('只返回窗口内的条目', async () => {
  await withStore(async (directory) => {
    let clock = new Date('2026-11-10T12:00:00.000Z')
    const store = new LogStore({ directory, now: () => new Date(clock) })
    await store.append('info', 'old')
    clock = new Date('2026-11-12T00:00:00.000Z')
    await store.append('info', 'fresh')

    const day = await store.readRecent({ hours: 24 })
    assert.deepEqual(day.map((entry) => entry.msg), ['fresh'])

    const week = await store.readRecent({ hours: 168 })
    assert.deepEqual(week.map((entry) => entry.msg), ['fresh', 'old'])
  })
})

test('超过单文件上限时轮转，读取仍能从两份文件合并', async () => {
  await withStore(async (directory) => {
    let clock = new Date('2026-11-12T00:00:00.000Z')
    const store = new LogStore({ directory, maxBytes: 1024, now: () => new Date(clock) })
    for (let index = 0; index < 80; index += 1) {
      clock = new Date(Date.parse('2026-11-12T00:00:00.000Z') + index * 1000)
      await store.append('info', `line-${index}-${'x'.repeat(60)}`)
    }

    const size = (await stat(store.filePath())).size
    assert.ok(size <= 1024, `主文件应被轮转，实际 ${size} 字节`)

    const entries = await store.readRecent({ hours: 24, limit: 500 })
    assert.ok(entries.length > 0)
    assert.equal(entries[0].msg.startsWith('line-79-'), true)
    // 只保留两份文件：最旧的条目已被丢弃，磁盘占用有上限
    assert.equal(entries.some((entry) => entry.msg.startsWith('line-0-')), false)
    const rotatedSize = (await stat(store.rotatedPath())).size
    assert.ok(rotatedSize <= 2048, `轮转文件应保持在上限附近，实际 ${rotatedSize} 字节`)
  })
})

test('坏行被跳过，不影响其它条目', async () => {
  await withStore(async (directory) => {
    const store = new LogStore({ directory, now: () => new Date('2026-11-12T00:00:00.000Z') })
    await store.append('info', 'good')
    const { appendFile, mkdir } = await import('node:fs/promises')
    await mkdir(directory, { recursive: true })
    await appendFile(store.filePath(), 'not-json\n{"t":\n', 'utf8')

    const entries = await store.readRecent({ hours: 24 })
    assert.deepEqual(entries.map((entry) => entry.msg), ['good'])
  })
})

test('日志文件写在给定目录下', async () => {
  await withStore(async (directory) => {
    const store = new LogStore({ directory, now: () => new Date('2026-11-12T00:00:00.000Z') })
    await store.append('info', 'hello')
    const text = await readFile(store.filePath(), 'utf8')
    assert.match(text, /"msg":"hello"/)
  })
})
