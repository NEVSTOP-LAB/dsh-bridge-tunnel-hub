/**
 * 配置定义与规范化。
 *
 * 配置里只放"用户需要决定"的东西；机器 ID、自动创建的 Gist ID、最近一次上报结果
 * 都放状态文件（见 state.js）。
 *
 * schemastery 只在宿主里可用：取不到时插件仍然加载，只是没有设置页、使用默认值。
 * 这样本仓库的纯函数测试不必安装依赖也能跑。
 *
 * @module dsh-bridge-tunnel-hub/config
 */

/** 扫描间隔下限：地址变化后最多等这么久就能写进 Gist。 */
export const MIN_SCAN_INTERVAL_SEC = 5

/** 探活超时下限与上限。 */
export const MIN_PROBE_TIMEOUT_MS = 1000
export const MAX_PROBE_TIMEOUT_MS = 30000

/** 整点心跳间隔上限（小时）。 */
export const MAX_HEARTBEAT_HOURS = 24

/** 配置缺省值（与设置页 schema 的默认值保持一致）。 */
export const DEFAULT_CONFIG = Object.freeze({
  machineName: '',
  gistUrl: '',
  gistId: '',
  token: '',
  logPath: '',
  bridgeConfigPath: '',
  scanIntervalSec: 20,
  probeTimeoutMs: 8000,
  autoPublish: true,
  manualUrl: '',
  heartbeatHours: 4,
})

let z = null
try {
  z = (await import('@deepseek-ai/schemastery')).default
} catch {
  z = null
}

/** 设置页 schema；schemastery 不可用时为 undefined（宿主按无 schema 处理）。 */
export const Config = z
  ? z.object({
      machineName: z.string().default('').description('本机在 Gist 里的名字；留空时用操作系统主机名'),
      gistUrl: z.string().default('').description('登记用的 secret Gist 链接；留空时首次启动自动创建'),
      gistId: z.string().default('').description('Gist ID；与 gistUrl 二选一'),
      token: z.string().default('').description('写入 Gist 用的 GitHub token（gist 权限）；留空时回退到本机 gh 登录'),
      logPath: z.string().default('').description('dsh-bridge 的 cloudflared.log 路径；留空时自动探测'),
      bridgeConfigPath: z.string().default('').description('dsh-bridge 的 config.json 路径；留空时自动探测'),
      scanIntervalSec: z.number().default(DEFAULT_CONFIG.scanIntervalSec).description('扫描隧道地址的间隔秒数（最小 5）'),
      probeTimeoutMs: z.number().default(DEFAULT_CONFIG.probeTimeoutMs).description('公网地址探活超时毫秒数'),
      autoPublish: z.boolean().default(DEFAULT_CONFIG.autoPublish).description('隧道地址变化时自动写入 Gist'),
      manualUrl: z.string().default('').description('本机隧道地址的兜底值；插件读不到日志时使用'),
      heartbeatHours: z.number().default(DEFAULT_CONFIG.heartbeatHours)
        .description('整点刷新间隔（小时），默认 4：每 4 小时整点刷新一次「最后在线时间」；0 表示关闭'),
    })
  : undefined

/**
 * 规范化配置：补默认值并收敛非法数值，避免错误配置让插件起不来。
 *
 * @param {unknown} raw 条目配置。
 * @returns {typeof DEFAULT_CONFIG} 规范化后的配置。
 */
export function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const merged = { ...DEFAULT_CONFIG, ...source }
  const text = (value, fallback = '') => (typeof value === 'string' ? value.trim() : fallback)
  const number = (value, fallback, min, max) => {
    const parsed = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(parsed)) return fallback
    return Math.min(max, Math.max(min, parsed))
  }
  return {
    machineName: text(merged.machineName),
    gistUrl: text(merged.gistUrl),
    gistId: text(merged.gistId),
    token: text(merged.token),
    logPath: text(merged.logPath),
    bridgeConfigPath: text(merged.bridgeConfigPath),
    scanIntervalSec: Math.round(number(merged.scanIntervalSec, DEFAULT_CONFIG.scanIntervalSec, MIN_SCAN_INTERVAL_SEC, 3600)),
    probeTimeoutMs: Math.round(number(merged.probeTimeoutMs, DEFAULT_CONFIG.probeTimeoutMs, MIN_PROBE_TIMEOUT_MS, MAX_PROBE_TIMEOUT_MS)),
    autoPublish: merged.autoPublish !== false,
    manualUrl: text(merged.manualUrl),
    heartbeatHours: Math.round(number(merged.heartbeatHours, DEFAULT_CONFIG.heartbeatHours, 0, MAX_HEARTBEAT_HOURS)),
  }
}
