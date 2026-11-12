/**
 * `tunnels.md` 的行格式与合并规则。
 *
 * 文件是可直接点开的 Markdown 列表，一行一台机器，链接后可跟"最后在线时间"：
 *
 * ```markdown
 * - [ThinkCentre-Yao](https://xxx.trycloudflare.com) — 2026-11-12 08:45 +08:00
 * ```
 *
 * 时间由写入那台机器按本地时区生成，带偏移量，跨时区读也不会歧义。
 * 也兼容旧格式 `机器名:地址`（`tunnels.txt` 时代）与无时间的链接行，用于迁移。
 *
 * @module dsh-bridge-tunnel-hub/tunnels
 */

/** 汇总文件：Markdown 列表，链接可点击。 */
export const TUNNELS_FILE = 'tunnels.md'

/** 旧版汇总文件：纯 `机器名:地址`，仅用于迁移后删除。 */
export const LEGACY_TUNNELS_FILE = 'tunnels.txt'

const MARKDOWN_LINK = /\[([^\]]+)\]\(([^)\s]+)\)/

/** 行尾的本地时间（带偏移量，可用空格分隔）或 UTC ISO 时间。 */
const DISPLAY_TIME = /\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?:\s?[+-]\d{2}:\d{2}|Z)?/

/**
 * 把时间格式化成"本地时间 + 偏移量"，例如 `2026-11-12 08:45 +08:00`。
 *
 * @param {Date|number|string} [value] 时间点，默认当前时间。
 * @returns {string} 可读时间。
 */
export function formatLocalTimestamp(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (number) => String(number).padStart(2, '0')
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absolute = Math.abs(offsetMinutes)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())} `
    + `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
}

/**
 * 把机器名收敛成可以写进 Markdown 链接文本的形态。
 *
 * @param {unknown} value 原始机器名。
 * @returns {string|null} 可用机器名；空名返回 null。
 */
export function sanitizeMachineName(value) {
  if (typeof value !== 'string') return null
  const cleaned = value
    .replace(/[\[\]():\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.length > 0 ? cleaned : null
}

/**
 * 解析汇总文件：优先按 Markdown 链接解析，同时兼容旧的 `机器名:地址` 行。
 *
 * 空行与 `#` 开头的注释行被忽略；同一机器名重复出现时后者覆盖前者，保留首次出现的位置。
 *
 * @param {string} text 文件内容。
 * @returns {Array<{ name: string, url: string, updatedAt?: string }>} 解析结果，顺序与文件一致。
 */
export function parseTunnelEntries(text) {
  const entries = new Map()
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue

    const link = line.match(MARKDOWN_LINK)
    if (link) {
      const name = link[1].trim()
      const url = link[2].trim()
      if (name.length === 0 || url.length === 0) continue
      const rest = line.slice((link.index ?? 0) + link[0].length)
      const time = rest.match(DISPLAY_TIME)
      entries.set(name.toLowerCase(), time ? { name, url, updatedAt: time[0] } : { name, url })
      continue
    }

    // 旧格式：第一个冒号前是机器名，其后是地址
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    const name = line.slice(0, separator).trim().replace(/^[-*+]\s+/, '')
    const url = line.slice(separator + 1).trim()
    if (name.length > 0 && /^https?:\/\//i.test(url)) entries.set(name.toLowerCase(), { name, url })
  }
  return [...entries.values()]
}

/** 把条目序列化成 `tunnels.md` 内容（非空时以换行结尾）。 */
export function serializeTunnelEntries(entries) {
  const lines = entries.map((entry) => {
    const time = typeof entry.updatedAt === 'string' && entry.updatedAt.length > 0 ? ` — ${entry.updatedAt}` : ''
    return `- [${entry.name}](${entry.url})${time}`
  })
  return lines.length > 0 ? `${lines.join('\n')}\n` : ''
}

/** 按机器名查找条目（大小写不敏感）。 */
export function findTunnelEntry(text, name) {
  const key = String(name ?? '').trim().toLowerCase()
  if (key.length === 0) return null
  return parseTunnelEntries(text).find((entry) => entry.name.toLowerCase() === key) ?? null
}

/**
 * 写入或更新一台机器的条目；其他机器的条目保持原位不动。
 *
 * @param {string} text 原文件内容。
 * @param {{ name: string, url: string, updatedAt?: string }} entry 要写入的条目；`updatedAt` 为行尾展示时间。
 * @returns {string} 新文件内容。
 */
export function upsertTunnelEntry(text, { name, url, updatedAt } = {}) {
  const entries = parseTunnelEntries(text)
  const key = name.toLowerCase()
  const index = entries.findIndex((entry) => entry.name.toLowerCase() === key)
  const next = typeof updatedAt === 'string' && updatedAt.length > 0 ? { name, url, updatedAt } : { name, url }
  if (index >= 0) entries[index] = next
  else entries.push(next)
  return serializeTunnelEntries(entries)
}

/** 删除某台机器的条目；不存在时原样返回。 */
export function removeTunnelEntry(text, name) {
  const key = String(name ?? '').trim().toLowerCase()
  if (key.length === 0) return text
  const entries = parseTunnelEntries(text).filter((entry) => entry.name.toLowerCase() !== key)
  return serializeTunnelEntries(entries)
}
