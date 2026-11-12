/**
 * 运行日志：滚动文件 + 只读最近一段时间的条目。
 *
 * 约束（用户要求"log 不要永远增加"）：
 * - 单文件超过 `maxBytes` 就轮转成 `.1` 并从空文件重新写，磁盘占用上限约 `2 × maxBytes`；
 * - 读取只返回最近 `retentionHours` 小时内的条目，界面不会越看越长；
 * - 每行是一个 JSON 对象，坏行在读取时跳过，不影响其它行。
 *
 * @module dsh-bridge-tunnel-hub/log-store
 */
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 日志文件基名。 */
export const LOG_FILE_NAME = 'dsh-bridge-tunnel-hub.log'

/** 单文件上限：256 KiB，轮转后最多两份。 */
export const DEFAULT_LOG_MAX_BYTES = 256 * 1024

/** 界面默认展示时长与条数。 */
export const DEFAULT_RETENTION_HOURS = 24
export const DEFAULT_LOG_LIMIT = 300
export const MAX_LOG_LIMIT = 500

/** 日志级别。 */
export const LOG_LEVELS = ['info', 'warn', 'error']

/** 允许的展示时长上限（小时）。 */
export const MAX_RETENTION_HOURS = 168

export class LogStore {
  /**
   * @param {{ directory: string, maxBytes?: number, now?: () => Date }} options 日志目录与上限。
   */
  constructor({ directory, maxBytes = DEFAULT_LOG_MAX_BYTES, now = () => new Date() }) {
    this.directory = directory
    this.maxBytes = Math.max(1024, maxBytes)
    this.now = now
    this.queue = Promise.resolve()
  }

  /** 当前日志文件路径。 */
  filePath() {
    return join(this.directory, LOG_FILE_NAME)
  }

  /** 轮转后的日志文件路径。 */
  rotatedPath() {
    return `${this.filePath()}.1`
  }

  /**
   * 追加一条日志。写失败只影响日志本身，不向上抛。
   *
   * @param {'info'|'warn'|'error'} level 级别。
   * @param {string} message 内容。
   * @returns {Promise<void>}
   */
  append(level, message) {
    const entry = {
      t: this.now().toISOString(),
      level: LOG_LEVELS.includes(level) ? level : 'info',
      msg: String(message ?? '').slice(0, 2000),
    }
    this.queue = this.queue
      .then(async () => {
        await mkdir(this.directory, { recursive: true })
        await appendFile(this.filePath(), `${JSON.stringify(entry)}\n`, 'utf8')
        await this.#rotateIfNeeded()
      })
      .catch(() => { /* 日志失败不影响主流程 */ })
    return this.queue
  }

  /**
   * 读取最近条目（新到旧）。
   *
   * @param {{ hours?: number, limit?: number }} [options] 展示时长与条数。
   * @returns {Promise<Array<{ t: string, level: string, msg: string }>>} 条目。
   */
  async readRecent({ hours = DEFAULT_RETENTION_HOURS, limit = DEFAULT_LOG_LIMIT } = {}) {
    const windowHours = Math.min(MAX_RETENTION_HOURS, Math.max(1, Number(hours) || DEFAULT_RETENTION_HOURS))
    const maxRows = Math.min(MAX_LOG_LIMIT, Math.max(1, Number(limit) || DEFAULT_LOG_LIMIT))
    const cutoff = this.now().getTime() - windowHours * 3600 * 1000

    const entries = []
    for (const file of [this.rotatedPath(), this.filePath()]) {
      let text = ''
      try {
        text = await readFile(file, 'utf8')
      } catch {
        continue
      }
      for (const line of text.split(/\r?\n/)) {
        if (line.length === 0) continue
        let parsed
        try {
          parsed = JSON.parse(line)
        } catch {
          continue
        }
        if (!parsed || typeof parsed.t !== 'string' || typeof parsed.msg !== 'string') continue
        const at = Date.parse(parsed.t)
        if (!Number.isFinite(at) || at < cutoff) continue
        entries.push({ t: parsed.t, level: LOG_LEVELS.includes(parsed.level) ? parsed.level : 'info', msg: parsed.msg })
      }
    }

    entries.sort((left, right) => Date.parse(right.t) - Date.parse(left.t))
    return entries.slice(0, maxRows)
  }

  /** 超过上限时轮转：旧文件覆盖 `.1`，主文件置空。 */
  async #rotateIfNeeded() {
    let size = 0
    try {
      size = (await stat(this.filePath())).size
    } catch {
      return
    }
    if (size <= this.maxBytes) return
    try {
      await rename(this.filePath(), this.rotatedPath())
    } catch {
      // Windows 上目标已存在时 rename 会失败：先删再重试一次。
      try {
        await writeFile(this.rotatedPath(), '', 'utf8')
        await rename(this.filePath(), this.rotatedPath())
      } catch {
        await writeFile(this.filePath(), '', 'utf8')
        return
      }
    }
    await writeFile(this.filePath(), '', 'utf8')
  }
}
