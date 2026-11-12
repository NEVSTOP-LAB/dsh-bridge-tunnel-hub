/**
 * 隧道地址采集：从 dsh-bridge 的落盘状态里找出本机当前对公网开放的地址，并做一次端到端探活。
 *
 * 采集顺序（先命中先生效）：
 * 1. 配置项 `manualUrl`：插件读不到日志时由用户手动指定。
 * 2. dsh-bridge 的固定域名模式：`config.json` 的 `cloudflared.hostname` 非空。
 * 3. 免登录临时隧道：`cloudflared.log` 中最后一次出现的 `*.trycloudflare.com` 地址。
 *
 * 对外地址一律收敛成 `scheme://host`，查询串与片段被丢弃——`?auth=` 一类免密凭据
 * 不进入本插件的任何出口。
 *
 * @module dsh-bridge-tunnel-hub/source
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

/** cloudflared 为免登录隧道分配的地址形态。 */
export const QUICK_TUNNEL_PATTERN = /https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com/g

/** 日志尾部读取上限：一次启动的横幅在文件末尾附近，滚到上限仍能命中最近一次启动。 */
export const DEFAULT_TAIL_BYTES = 262144

/**
 * 取文本中最后一个 `*.trycloudflare.com` 地址。
 *
 * 日志是追加写的：每次 cloudflared 启动都会再打印一次横幅，所以"最后一次"就是当前
 * 这次启动分配的地址；轮转后旧地址消失不影响结论。
 *
 * @param {string} text 日志文本。
 * @returns {string|null} 找到的地址，没有则为 null。
 */
export function findLastQuickTunnelUrl(text) {
  if (typeof text !== 'string' || text.length === 0) return null
  let last = null
  for (const match of text.matchAll(QUICK_TUNNEL_PATTERN)) last = match[0]
  return last
}

/**
 * 把地址收敛成 `scheme://host`：丢弃查询串、片段和路径，只保留主机。
 *
 * @param {unknown} raw 原始地址。
 * @returns {string|null} 收敛后的地址；不是 http(s) 地址时为 null。
 */
export function sanitizePublicUrl(raw) {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  let url
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  return `${url.protocol}//${url.host}`
}

/**
 * 读取文件末尾若干字节。
 *
 * @param {string} filePath 文件路径。
 * @param {number} maxBytes 最多读取的字节数。
 * @returns {string} 文件尾部文本；读不到时返回空串。
 */
export function readFileTail(filePath, maxBytes = DEFAULT_TAIL_BYTES) {
  let descriptor
  try {
    const size = statSync(filePath).size
    const length = Math.min(size, maxBytes)
    if (length === 0) return ''
    descriptor = openSync(filePath, 'r')
    const buffer = Buffer.alloc(length)
    readSync(descriptor, buffer, 0, length, size - length)
    return buffer.toString('utf8')
  } catch {
    return ''
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor) } catch { /* 关闭失败不影响读取结果 */ }
    }
  }
}

/** 读取 dsh-bridge 的 config.json；文件缺失或不是对象时返回 null。 */
export async function readBridgeConfig(filePath) {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * 解析固定域名模式填写的 hostname（允许带协议前缀）。
 *
 * @param {unknown} raw `cloudflared.hostname` 原始值。
 * @returns {string|null} 纯 hostname。
 */
export function sanitizeHostname(raw) {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    return new URL(candidate).host
  } catch {
    return null
  }
}

/**
 * 探测本机隧道地址在当前网络下是否真的可用。
 *
 * dsh-bridge 的 `/__dsh_bridge__/auth-status` 在访问认证之前处理，未登录也能拿到
 * JSON，因此它既能证明"请求到达了本机 bridge"，又不需要任何凭据。
 *
 * @param {string} url 对外地址。
 * @param {{ timeoutMs?: number, fetchImpl?: typeof fetch }} [options] 探活选项。
 * @returns {Promise<{ reachable: boolean, status: number|null, error: string|null }>}
 */
export async function probePublicUrl(url, { timeoutMs = 8000, fetchImpl = globalThis.fetch } = {}) {
  const base = sanitizePublicUrl(url)
  if (!base) return { reachable: false, status: null, error: '地址格式非法' }
  const target = `${base}/__dsh_bridge__/auth-status`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(500, timeoutMs))
  try {
    const response = await fetchImpl(target, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'user-agent': 'dsh-bridge-tunnel-hub' },
    })
    if (!response.ok) return { reachable: false, status: response.status, error: `HTTP ${response.status}` }
    const text = await response.text()
    let payload = null
    try { payload = JSON.parse(text) } catch { payload = null }
    if (payload === null || typeof payload !== 'object') {
      return { reachable: false, status: response.status, error: '响应不是 dsh-bridge 的 auth-status 格式' }
    }
    return { reachable: true, status: response.status, error: null }
  } catch (error) {
    const message = error?.name === 'AbortError' ? '探活超时' : (error?.message ?? String(error))
    return { reachable: false, status: null, error: message }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 采集本机当前的公网隧道地址。
 *
 * @param {{ manualUrl?: string, bridgeConfigPath?: string, bridgeLogPath?: string }} options 采集输入。
 * @returns {Promise<{ kind: 'manual'|'fixed'|'quick'|'none', url: string|null, source: string|null }>}
 */
export async function detectTunnel({ manualUrl, bridgeConfigPath, bridgeLogPath } = {}) {
  const manual = sanitizePublicUrl(manualUrl)
  if (manual) return { kind: 'manual', url: manual, source: 'manualUrl 配置' }

  if (bridgeConfigPath) {
    const config = await readBridgeConfig(bridgeConfigPath)
    const hostname = sanitizeHostname(config?.cloudflared?.hostname)
    if (hostname) {
      return { kind: 'fixed', url: `https://${hostname}`, source: 'dsh-bridge config.json（固定域名模式）' }
    }
  }

  if (bridgeLogPath) {
    const quick = findLastQuickTunnelUrl(readFileTail(bridgeLogPath))
    if (quick) return { kind: 'quick', url: quick, source: 'cloudflared.log' }
  }

  return { kind: 'none', url: null, source: null }
}
