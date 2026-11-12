/**
 * 汇总中枢：把"本机隧道地址"翻译成 Gist 里的一行，并回答所有机器的当前地址。
 *
 * 一次成功上报的完整流程：
 * 1. 采集：`detectTunnel()` 从 dsh-bridge 的落盘状态里取地址；
 * 2. 探活：`probePublicUrl()` 确认地址在当前网络真的通（通不过就不写，避免把死地址广播出去）；
 * 3. 合并：读 Gist → 只替换本机那一行 / 本机记录 → 有差异才回写（无差异不产生新版本）；
 * 4. 落盘：把结果记进本机状态文件，供工具与设置页查看。
 *
 * 另有一个整点心跳：每 `heartbeatHours` 小时在整点做一次采集 + 探活 + 写回，把
 * `updatedAt` 刷新成"最后一次确认在线的时间"，超过间隔未刷新即视为可能离线。
 *
 * @module dsh-bridge-tunnel-hub/hub
 */
import { watch } from 'node:fs'
import { basename, dirname } from 'node:path'
import { hostname as osHostname } from 'node:os'
import { detectTunnel, probePublicUrl } from './source.js'
import { GIST_DESCRIPTION, GistError, gistWebUrl, parseGistId } from './gist.js'
import { createGistTransport } from './transport.js'
import {
  LEGACY_TUNNELS_FILE,
  TUNNELS_FILE,
  findTunnelEntry,
  formatLocalTimestamp,
  parseTunnelEntries,
  removeTunnelEntry,
  sanitizeMachineName,
  upsertTunnelEntry,
} from './tunnels.js'
import {
  findMachineNameById,
  parseStatus,
  serializeStatus,
  upsertStatusMachine,
} from './status.js'

/** 状态文件：每台机器最近一次确认在线的时间与机器 ID。 */
export const STATUS_FILE = 'dsh-bridge-tunnel-hub.json'

/** 旧版状态文件名，仅用于迁移后删除。 */
export const LEGACY_STATUS_FILE = 'status.json'

/** 地址没变化时，每隔多久核对一次 Gist（防止 Gist 被删或本机那一行被别人覆盖）。 */
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000

/** 日志变化后的去抖时间：cloudflared 启动时一次会写好几十行。 */
const WATCH_DEBOUNCE_MS = 1500

/** 心跳允许的迟到宽限：超过「间隔 + 1 小时」未刷新即标记为可能离线。 */
const HEARTBEAT_GRACE_MS = 60 * 60 * 1000

/** ISO 时间。 */
function defaultNow() {
  return new Date()
}

/**
 * 距下一个「本地整点 + 间隔整数倍」还有多少毫秒。
 *
 * @param {number} hours 间隔小时数；非正数返回 null。
 * @param {Date} [now] 当前时间。
 * @returns {number|null} 毫秒数。
 */
export function msUntilNextAlignedHour(hours, now = new Date()) {
  if (!Number.isFinite(hours) || hours <= 0) return null
  const next = new Date(now.getTime())
  next.setMinutes(0, 0, 0)
  const remainder = next.getHours() % hours
  next.setHours(next.getHours() + (remainder === 0 ? hours : hours - remainder))
  while (next.getTime() <= now.getTime()) next.setHours(next.getHours() + hours)
  return next.getTime() - now.getTime()
}

export class TunnelHub {
  /**
   * @param {{ config: object, state: import('./state.js').LocalState, paths: { log: string, config: string }, logger?: any, fetchImpl?: typeof fetch, transport?: object|null }} options 依赖注入。
   */
  constructor({ config, state, paths, logger, fetchImpl = globalThis.fetch, transport = null, now = defaultNow, log = () => {} }) {
    this.config = config
    this.state = state
    this.paths = paths
    this.logger = logger
    this.fetchImpl = fetchImpl
    this.transport = transport
    this.nowFn = now
    this.log = log
    this.lastLoggedUrl = ''
    this.ready = null
    this.scanning = null
    this.stopped = true
    this.timer = null
    this.heartbeatTimer = null
    this.nextHeartbeatAt = ''
    this.watcher = null
    this.debounce = null
    this.lastReconcileAt = 0
    this.detection = null
    this.lastProbe = null
    this.lastPublish = { ok: false, at: '', url: '', error: '' }
    this.gistId = ''
    this.machineId = ''
    this.machineName = ''
  }

  /** 当前时间的 ISO 字符串；测试可注入时钟。 */
  nowIso() {
    return this.nowFn().toISOString()
  }

  /** 启动扫描器：先做一次立即上报，再定时扫描、整点心跳并监听日志变化。 */
  start() {
    this.stopped = false
    this.ready = this.init().catch((error) => {
      this.lastPublish = { ok: false, at: this.nowIso(), url: '', error: error?.message ?? String(error) }
      this.logger?.warn?.(`dsh-bridge-tunnel-hub: 初始化失败：${error?.message ?? error}`)
    })
    const intervalMs = Math.max(5, this.config.scanIntervalSec) * 1000
    this.timer = setInterval(() => { void this.scan() }, intervalMs)
    this.timer.unref?.()
    this.log('info', `启动：机器名 ${this.machineName}，心跳 ${this.config.heartbeatHours} 小时，Gist ${this.gistId || '待创建'}`)
    this.scheduleHeartbeat()
    this.watchLogFile()
  }

  /** 停止扫描器、心跳与文件监听。 */
  stop() {
    this.stopped = true
    this.log('info', '插件停止')
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer)
    this.heartbeatTimer = null
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = null
    try { this.watcher?.close() } catch { /* 关闭失败无需处理 */ }
    this.watcher = null
  }

  /** 初始化：读本机状态、确定机器名与 Gist，然后上报一次。 */
  async init() {
    const stored = await this.state.load()
    this.machineId = stored.machineId
    this.gistId = parseGistId(this.config.gistId) || parseGistId(this.config.gistUrl) || stored.gistId
    this.machineName = this.resolveMachineName()
    await this.scan({ force: false })
    return this
  }

  /** 机器名：配置优先，其次主机名。 */
  resolveMachineName() {
    return sanitizeMachineName(this.config.machineName)
      ?? sanitizeMachineName(osHostname())
      ?? 'unknown-machine'
  }

  /** 等待初始化完成；工具调用前使用。 */
  async whenReady() {
    if (this.ready) await this.ready
    return this
  }

  /** 取得 Gist 通道（gh 优先，REST 兜底），进程内只解析一次。 */
  async getTransport() {
    if (this.transport) return this.transport
    this.transport = await createGistTransport({ token: this.config.token, fetchImpl: this.fetchImpl })
    return this.transport
  }

  /** 立即上报（忽略"地址未变"的短路）。 */
  async publishNow() {
    await this.whenReady()
    return this.scan({ force: true })
  }

  /** 安排下一次整点心跳；间隔为 0 时不安排。 */
  scheduleHeartbeat() {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer)
    this.heartbeatTimer = null
    const hours = this.config.heartbeatHours
    if (!hours) {
      this.nextHeartbeatAt = ''
      return
    }
    const delay = msUntilNextAlignedHour(hours, new Date())
    if (delay === null) return
    this.nextHeartbeatAt = new Date(Date.now() + delay).toISOString()
    this.log('info', `下次整点刷新：${this.nextHeartbeatAt}`)
    this.heartbeatTimer = setTimeout(() => { void this.runHeartbeat() }, Math.max(1000, delay))
    this.heartbeatTimer.unref?.()
  }

  /** 执行一次心跳并安排下一次。 */
  async runHeartbeat() {
    if (this.stopped) return
    this.log('info', '整点刷新开始')
    try {
      await this.scan({ heartbeat: true })
    } catch (error) {
      this.logger?.warn?.(`dsh-bridge-tunnel-hub: 心跳失败：${error?.message ?? error}`)
    } finally {
      if (!this.stopped) this.scheduleHeartbeat()
    }
  }

  /**
   * 扫描一次：采集 → 需要时探活 → 需要时写 Gist。
   *
   * @param {{ force?: boolean, heartbeat?: boolean }} [options] `force` 忽略短路；`heartbeat` 刷新"最后在线时间"。
   * @returns {Promise<{ ok: boolean, unchanged?: boolean, url: string|null, gistUrl?: string, error?: string }>}
   */
  async scan({ force = false, heartbeat = false } = {}) {
    if (this.scanning) return this.scanning
    this.scanning = this.runScan({ force, heartbeat }).finally(() => { this.scanning = null })
    return this.scanning
  }

  /** 实际执行一次扫描（scan 已做并发去重）。 */
  async runScan({ force, heartbeat }) {
    let detection
    try {
      detection = await detectTunnel({
        manualUrl: this.config.manualUrl,
        bridgeConfigPath: this.paths.config,
        bridgeLogPath: this.paths.log,
      })
    } catch (error) {
      return this.fail(`采集隧道地址失败：${error?.message ?? error}`)
    }
    this.detection = detection

    if (!detection.url) {
      return this.fail(`没有找到隧道地址（日志：${this.paths.log}）。请确认 dsh-bridge 的 Cloudflare 隧道已开启。`)
    }
    if (detection.url !== this.lastLoggedUrl) {
      this.lastLoggedUrl = detection.url
      this.log('info', `采集到隧道地址 ${detection.url}（${detection.kind}，来源：${detection.source}）`)
    }

    const sameUrl = this.state.data.lastUrl === detection.url
    const recentlyReconciled = Date.now() - this.lastReconcileAt < RECONCILE_INTERVAL_MS
    if (!force && !heartbeat && sameUrl && recentlyReconciled) {
      return { ok: true, unchanged: true, url: detection.url }
    }

    // 只有地址变了、定期核对或心跳时才探活，避免每 20 秒向公网打一次请求。
    // 慢链路（Happy Eyeballs 单地址窗口、DNS 抖动）会偶发一次失败，重试一次再判死。
    let probe = await probePublicUrl(detection.url, {
      timeoutMs: this.config.probeTimeoutMs,
      fetchImpl: this.fetchImpl,
    })
    if (!probe.reachable) {
      await new Promise((resolve) => setTimeout(resolve, 1500))
      probe = await probePublicUrl(detection.url, {
        timeoutMs: this.config.probeTimeoutMs,
        fetchImpl: this.fetchImpl,
      })
    }
    this.lastProbe = { ...probe, at: this.nowIso() }
    // 心跳的意义是"确认这台机器还在线"：探活不过就不刷新时间，否则离线机器会被误判成在线。
    if (!probe.reachable && !force) {
      this.log('warn', `探活失败（${probe.error ?? '未知原因'}）：${detection.url}`)
      return this.fail(`隧道地址暂不可用（${probe.error ?? '探活失败'}），等它就绪后再上报：${detection.url}`)
    }
    if (force) this.log('info', `探活通过：${detection.url}`)
    if (!this.config.autoPublish && !force) {
      return { ok: true, url: detection.url, skipped: 'autoPublish=false' }
    }

    try {
      const result = await this.publish(detection, { heartbeat })
      this.lastReconcileAt = Date.now()
      return result
    } catch (error) {
      return this.fail(`写入 Gist 失败：${error?.message ?? error}`)
    }
  }

  /** 记录一次失败（只在本机状态里体现，不打断 DSH）。 */
  async fail(message) {
    this.lastPublish = { ok: false, at: this.nowIso(), url: this.detection?.url ?? '', error: message }
    this.logger?.warn?.(`dsh-bridge-tunnel-hub: ${message}`)
    this.log('error', message)
    try {
      if (this.state.data.lastError !== message) await this.state.save({ lastError: message })
    } catch { /* 状态文件写不进去不影响上报逻辑 */ }
    return { ok: false, url: this.detection?.url ?? null, error: message }
  }

  /** 组装本机在 Gist 里的记录（只保留判断在线所需的最小信息）。 */
  buildMachineEntry(detection, updatedAt) {
    return {
      name: this.machineName,
      machineId: this.machineId,
      url: detection.url,
      kind: detection.kind,
      updatedAt,
    }
  }

  /**
   * 写入 Gist：首次自动创建，之后读改写。
   *
   * @param {{ url: string, kind: string, source: string }} detection 本次采集结果。
   * @param {{ heartbeat?: boolean }} [options] `heartbeat` 为真时即使地址未变也刷新更新时间。
   */
  async publish(detection, { heartbeat = false } = {}) {
    const transport = await this.getTransport()
    const name = this.machineName
    const nowDate = this.nowFn()
    const now = nowDate.toISOString()

    if (!this.gistId) {
      const status = upsertStatusMachine(parseStatus(''), this.buildMachineEntry(detection, now), now)
      const created = await transport.create({
        description: GIST_DESCRIPTION,
        files: {
          [TUNNELS_FILE]: upsertTunnelEntry('', { name, url: detection.url, updatedAt: formatLocalTimestamp(now) }),
          [STATUS_FILE]: serializeStatus(status),
        },
      })
      this.gistId = created.id
      await this.state.save({ gistId: created.id, lastUrl: detection.url, lastPublishedAt: now, lastError: '' })
      this.lastPublish = { ok: true, at: now, url: detection.url, error: '' }
      this.logger?.info?.(`dsh-bridge-tunnel-hub: 已创建 Gist ${created.htmlUrl}，写入 ${name}:${detection.url}（通道 ${transport.kind}）`)
      this.log('info', `已创建 Gist 并写入 ${name}:${detection.url}（通道 ${transport.kind}）`)
      return { ok: true, created: true, url: detection.url, gistId: created.id, gistUrl: created.htmlUrl, updatedAt: now }
    }

    let gist
    try {
      gist = await transport.read({ id: this.gistId })
    } catch (error) {
      if (error instanceof GistError && error.status === 404) {
        // Gist 被删了：清掉本地记录的 ID，下次按创建流程走。
        this.gistId = ''
        await this.state.save({ gistId: '', lastError: '登记的 Gist 已不存在，将重新创建' })
        return this.publish(detection, { heartbeat })
      }
      throw error
    }

    const oldMarkdown = gist.files[TUNNELS_FILE] ?? ''
    const legacyText = gist.files[LEGACY_TUNNELS_FILE] ?? null
    const legacyStatus = gist.files[LEGACY_STATUS_FILE] ?? null
    const oldStatus = gist.files[STATUS_FILE] ?? legacyStatus ?? ''
    const status = parseStatus(oldStatus)

    // 先定"最后在线时间"：地址变了或心跳时取现在，否则沿用原值（避免无变化也刷新）。
    const existing = status.machines[name]
    const sameEntry = existing?.machineId === this.machineId && existing?.url === detection.url
    const updatedAt = (!sameEntry || heartbeat) ? now : (typeof existing?.updatedAt === 'string' ? existing.updatedAt : now)
    const displayTime = formatLocalTimestamp(updatedAt)

    // 机器改过名：先删掉旧名字的那一行，避免 Gist 里留下孤儿条目。
    const previousName = findMachineNameById(status, this.machineId)
    let tunnelsNext = oldMarkdown
    // 旧版 tunnels.txt 迁移：把旧文件里的条目并进来（同名以新文件为准），随后删除旧文件。
    if (legacyText !== null) {
      for (const legacyEntry of parseTunnelEntries(legacyText)) {
        if (!findTunnelEntry(tunnelsNext, legacyEntry.name)) {
          tunnelsNext = upsertTunnelEntry(tunnelsNext, legacyEntry)
        }
      }
    }
    if (previousName && previousName.toLowerCase() !== name.toLowerCase()) {
      tunnelsNext = removeTunnelEntry(tunnelsNext, previousName)
    }
    tunnelsNext = upsertTunnelEntry(tunnelsNext, { name, url: detection.url, updatedAt: displayTime })

    const entry = this.buildMachineEntry(detection, updatedAt)
    const statusNext = upsertStatusMachine(status, entry, status.generatedAt ?? now)
    const entryChanged = JSON.stringify(statusNext.machines) !== JSON.stringify(status.machines)
    if (entryChanged) statusNext.generatedAt = now
    const statusText = serializeStatus(statusNext)

    const changedFiles = {}
    if (tunnelsNext !== oldMarkdown) changedFiles[TUNNELS_FILE] = tunnelsNext
    if (legacyText !== null) changedFiles[LEGACY_TUNNELS_FILE] = null
    if (legacyStatus !== null) changedFiles[LEGACY_STATUS_FILE] = null
    if (statusText !== oldStatus || legacyStatus !== null) changedFiles[STATUS_FILE] = statusText

    if (Object.keys(changedFiles).length === 0) {
      await this.state.save({ lastUrl: detection.url, lastPublishedAt: this.state.data.lastPublishedAt || now, lastError: '' })
      this.lastPublish = { ok: true, at: this.state.data.lastPublishedAt || now, url: detection.url, error: '' }
      return { ok: true, unchanged: true, url: detection.url, gistId: this.gistId, gistUrl: gistWebUrl(this.gistId), updatedAt }
    }

    const patched = await transport.patch({
      id: this.gistId,
      description: GIST_DESCRIPTION,
      files: changedFiles,
    })
    await this.state.save({ lastUrl: detection.url, lastPublishedAt: now, lastError: '' })
    this.lastPublish = { ok: true, at: now, url: detection.url, error: '' }
    this.logger?.info?.(`dsh-bridge-tunnel-hub: 已更新 ${name}:${detection.url}（${Object.keys(changedFiles).join(', ')}）`)
    this.log('info', `已更新 ${name}:${detection.url}（${Object.keys(changedFiles).join(', ')}）`)
    return { ok: true, changed: Object.keys(changedFiles), url: detection.url, gistId: patched.id, gistUrl: patched.htmlUrl, updatedAt }
  }

  /** 本机视角：当前采集结果、最近一次上报、心跳安排、Gist 位置。 */
  async self() {
    await this.whenReady()
    if (!this.detection) {
      this.detection = await detectTunnel({
        manualUrl: this.config.manualUrl,
        bridgeConfigPath: this.paths.config,
        bridgeLogPath: this.paths.log,
      })
    }
    const gistId = this.gistId
    return {
      machine: {
        name: this.machineName,
        machineId: this.machineId,
      },
      tunnel: {
        kind: this.detection.kind,
        url: this.detection.url,
        source: this.detection.source,
      },
      probe: this.lastProbe,
      publish: {
        ok: this.lastPublish.ok,
        at: this.lastPublish.at,
        url: this.lastPublish.url,
        error: this.lastPublish.error,
        lastPublishedAt: this.state.data.lastPublishedAt,
        lastError: this.state.data.lastError,
      },
      heartbeat: {
        hours: this.config.heartbeatHours,
        nextAt: this.nextHeartbeatAt,
        lastAt: this.state.data.lastPublishedAt,
      },
      gist: {
        id: gistId,
        url: gistWebUrl(gistId),
        description: GIST_DESCRIPTION,
      },
      files: {
        log: this.paths.log,
        bridgeConfig: this.paths.config,
        logs: this.paths.logs ?? '',
      },
      config: {
        autoPublish: this.config.autoPublish,
        scanIntervalSec: this.config.scanIntervalSec,
        probeTimeoutMs: this.config.probeTimeoutMs,
        hasConfiguredToken: this.config.token.length > 0,
      },
    }
  }

  /**
   * 读取汇总：列出 Gist 里所有机器，并对每个地址做一次探活。
   *
   * @param {{ probe?: boolean }} [options] `probe` 为假时跳过探活。
   */
  async list({ probe = true } = {}) {
    const gistId = this.gistId
      || parseGistId(this.config.gistId)
      || parseGistId(this.config.gistUrl)
      || this.state.data.gistId
    if (!gistId) {
      return {
        gist: null,
        machines: [],
        warning: '还没有登记用的 Gist：本机首次成功上报后会自动创建，或在设置里填 Gist 链接',
      }
    }

    const transport = await this.getTransport()
    const gist = await transport.read({ id: gistId })
    const status = parseStatus(gist.files[STATUS_FILE] ?? gist.files[LEGACY_STATUS_FILE] ?? '')
    const lines = parseTunnelEntries(gist.files[TUNNELS_FILE] ?? gist.files[LEGACY_TUNNELS_FILE] ?? '')
    const now = Date.now()
    const heartbeatHours = this.config.heartbeatHours

    const machines = lines.map((line) => {
      const meta = status.machines[line.name] ?? null
      // 更新时间只认"这台机器自己"的记录：没有记录说明这一行是手写的，不借用别人的时间。
      const updatedAt = typeof meta?.updatedAt === 'string' ? meta.updatedAt : null
      const updatedMs = updatedAt ? Date.parse(updatedAt) : NaN
      const stale = heartbeatHours > 0 && Number.isFinite(updatedMs)
        ? (now - updatedMs) > heartbeatHours * 3600_000 + HEARTBEAT_GRACE_MS
        : null
      return {
        name: line.name,
        url: line.url,
        self: line.name.toLowerCase() === this.machineName.toLowerCase(),
        kind: meta?.kind ?? null,
        updatedAt,
        ageSeconds: Number.isFinite(updatedMs) ? Math.max(0, Math.round((now - updatedMs) / 1000)) : null,
        stale,
        reachable: null,
        probeError: null,
      }
    })

    if (probe) {
      const timeoutMs = Math.min(Math.max(1000, this.config.probeTimeoutMs), 6000)
      await Promise.all(machines.map(async (machine) => {
        const result = await probePublicUrl(machine.url, { timeoutMs, fetchImpl: this.fetchImpl })
        machine.reachable = result.reachable
        machine.probeError = result.error
      }))
    }

    return {
      gist: { id: gist.id, url: gist.htmlUrl || gistWebUrl(gist.id), updatedAt: gist.updatedAt },
      generatedAt: status.generatedAt,
      fetchedAt: this.nowIso(),
      heartbeatHours,
      machines,
      warning: null,
    }
  }

  /** 监听 cloudflared 日志所在目录：隧道重启会立刻写入新地址。 */
  watchLogFile() {
    const logPath = this.paths.log
    try {
      this.watcher = watch(dirname(logPath), { persistent: false }, (_eventType, filename) => {
        if (filename && String(filename).toLowerCase() !== basename(logPath).toLowerCase()) return
        this.scheduleScan()
      })
      this.watcher.on('error', () => { /* 监听失败时退回定时扫描 */ })
    } catch {
      this.watcher = null
    }
  }

  /** 去抖后触发一次扫描。 */
  scheduleScan() {
    if (this.stopped) return
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => { void this.scan() }, WATCH_DEBOUNCE_MS)
    this.debounce.unref?.()
  }
}
