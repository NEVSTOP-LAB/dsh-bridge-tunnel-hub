/**
 * `tunnels.txt` 的行格式与合并规则。
 *
 * 文件内容就是"一行一台机器"：`<机器名>:<公网地址>`。机器名里不允许出现冒号，
 * 地址部分允许（`https://...` 自带冒号），因此解析时按**第一个**冒号切分。
 * 本模块只做纯文本处理：读改写别的内容一行不动，便于人工查看和手改。
 *
 * @module dsh-bridge-tunnel-hub/tunnels
 */

/**
 * 把机器名收敛成可以写进 `tunnels.txt` 的形态：去掉冒号、换行和制表符。
 *
 * @param {unknown} value 原始机器名。
 * @returns {string|null} 可用机器名；空名返回 null。
 */
export function sanitizeMachineName(value) {
  if (typeof value !== 'string') return null
  const cleaned = value
    .replace(/[:\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.length > 0 ? cleaned : null
}

/**
 * 解析 `tunnels.txt`。
 *
 * 空行与 `#` 开头的注释行被忽略；同一机器名重复出现时后者覆盖前者，保留首次出现的位置。
 *
 * @param {string} text 文件内容。
 * @returns {Array<{ name: string, url: string }>} 解析结果，顺序与文件一致。
 */
export function parseTunnelEntries(text) {
  const entries = new Map()
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    const name = line.slice(0, separator).trim()
    const url = line.slice(separator + 1).trim()
    if (name.length === 0 || url.length === 0) continue
    entries.set(name.toLowerCase(), { name, url })
  }
  return [...entries.values()]
}

/** 把条目序列化成 `tunnels.txt` 内容（非空时以换行结尾）。 */
export function serializeTunnelEntries(entries) {
  const lines = entries.map((entry) => `${entry.name}:${entry.url}`)
  return lines.length > 0 ? `${lines.join('\n')}\n` : ''
}

/** 按机器名查找条目（大小写不敏感）。 */
export function findTunnelEntry(text, name) {
  const key = String(name ?? '').trim().toLowerCase()
  if (key.length === 0) return null
  return parseTunnelEntries(text).find((entry) => entry.name.toLowerCase() === key) ?? null
}

/**
 * 写入或更新一台机器的条目；同名的其他机器条目保持原位不动。
 *
 * @param {string} text 原文件内容。
 * @param {{ name: string, url: string }} entry 要写入的条目。
 * @returns {string} 新文件内容。
 */
export function upsertTunnelEntry(text, { name, url }) {
  const entries = parseTunnelEntries(text)
  const key = name.toLowerCase()
  const index = entries.findIndex((entry) => entry.name.toLowerCase() === key)
  if (index >= 0) entries[index] = { name, url }
  else entries.push({ name, url })
  return serializeTunnelEntries(entries)
}

/** 删除某台机器的条目；不存在时原样返回。 */
export function removeTunnelEntry(text, name) {
  const key = String(name ?? '').trim().toLowerCase()
  if (key.length === 0) return text
  const entries = parseTunnelEntries(text).filter((entry) => entry.name.toLowerCase() !== key)
  return serializeTunnelEntries(entries)
}
