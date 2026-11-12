/**
 * 路径解析：本插件运行在 DSH 宿主进程内，只能按 DSH 与 dsh-bridge 的落盘约定去找文件。
 *
 * - dsh-bridge 的配置：`$DSH_HOME/dsh-bridge/config.json`（未设 DSH_HOME 时为 `~/.dsh/...`）。
 * - cloudflared 日志：dsh-bridge 默认写在 `~/.dsh-bridge/cloudflared.log`（插件配置 `home`
 *   可改，不在本插件可见范围内），因此两个候选都探测。
 * - 本插件自己的状态：`$DSH_HOME/dsh-bridge-tunnel-hub/state.json`。
 *
 * @module dsh-bridge-tunnel-hub/paths
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** DSH 主目录：与宿主一致的 `$DSH_HOME` 回退规则。 */
export function dshHome() {
  const value = process.env.DSH_HOME
  return typeof value === 'string' && value.length > 0 ? value : join(homedir(), '.dsh')
}

/** dsh-bridge 配置文件的候选路径，按优先级排列。 */
export function bridgeConfigCandidates() {
  return [
    join(dshHome(), 'dsh-bridge', 'config.json'),
    join(homedir(), '.dsh-bridge', 'config.json'),
  ]
}

/** cloudflared 日志的候选路径，按优先级排列。 */
export function bridgeLogCandidates() {
  return [
    join(homedir(), '.dsh-bridge', 'cloudflared.log'),
    join(dshHome(), 'dsh-bridge', 'cloudflared.log'),
  ]
}

/** 返回第一个存在的候选路径；都不存在时返回首个候选（后续读取会给出空结果）。 */
export function pickExisting(candidates) {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return candidates[0]
}

/** 生效的 dsh-bridge 配置文件路径；配置项非空时以配置项为准。 */
export function resolveBridgeConfigPath(configured) {
  const value = typeof configured === 'string' ? configured.trim() : ''
  return value || pickExisting(bridgeConfigCandidates())
}

/** 生效的 cloudflared 日志路径；配置项非空时以配置项为准。 */
export function resolveBridgeLogPath(configured) {
  const value = typeof configured === 'string' ? configured.trim() : ''
  return value || pickExisting(bridgeLogCandidates())
}

/** 本插件状态目录。 */
export function stateDirectory() {
  return join(dshHome(), 'dsh-bridge-tunnel-hub')
}

/** 本插件状态文件。 */
export function stateFilePath() {
  return join(stateDirectory(), 'state.json')
}

/** 本插件日志目录。 */
export function logsDirectory() {
  return join(stateDirectory(), 'logs')
}
