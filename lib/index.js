/**
 * dsh-bridge-tunnel-hub：把每台机器上 dsh-bridge 的公网隧道地址汇总到一个私有 Gist。
 *
 * dsh-bridge 的免登录临时隧道每次重启都会换域名，外部因此无法记住入口。本插件在
 * 地址变化时把它写进一个 Gist（一行 `机器名:地址`，Markdown 链接可直接点开），每 4 小时
 * 整点刷新一次在线状态，并让任意一台机器随时查回全部地址。
 *
 * 本文件负责挂载：扫描器、Agent 工具、设置页用的本机 HTTP 路由与运行日志。
 *
 * @module dsh-bridge-tunnel-hub
 */
import { Config, DEFAULT_CONFIG, normalizeConfig } from './config.js'
import { TunnelHub } from './hub.js'
import { LogStore } from './log-store.js'
import { LocalState } from './state.js'
import { ROUTE_PATHS, createRouteHandlers } from './routes.js'
import {
  logsDirectory,
  resolveBridgeConfigPath,
  resolveBridgeLogPath,
  stateFilePath,
} from './paths.js'

export const name = 'dsh-bridge-tunnel-hub'

/** 工具注册表；本插件提供查询与手动上报工具。 */
export const inject = ['tools']

export { Config }

/** 工具输出的统一渲染：把返回值原样序列化成 JSON 文本。 */
const OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}

/**
 * 界面可见的配置视图：token 只返回"是否已设置"，不回传明文。
 *
 * @param {object} config 规范化后的配置。
 * @returns {object} 供设置页渲染的配置。
 */
export function configView(config) {
  const { token, ...rest } = config
  return {
    ...rest,
    token: '',
    tokenConfigured: typeof token === 'string' && token.length > 0,
  }
}

/**
 * 从设置页保存配置：走宿主的配置编辑器，只接受插件 schema 里声明过的字段。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 * @param {object} patch 要合并的字段。
 * @returns {Promise<object>} 保存后的配置视图。
 */
export async function saveConfigPatch(ctx, patch) {
  const entry = ctx.fiber?.entry
  const editor = ctx.get('configEditor')
  if (!entry || !editor || typeof editor.edit !== 'function') {
    throw new Error('当前 profile 不支持从界面保存插件配置')
  }
  const allowed = new Set(Object.keys(DEFAULT_CONFIG))
  const next = {}
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (allowed.has(key)) next[key] = value
  }
  if (Object.keys(next).length === 0) {
    throw new Error('没有可保存的配置项')
  }

  let merged = null
  await editor.edit(entry, (current) => {
    merged = { ...(current ?? {}), ...next }
    return merged
  })
  return configView(normalizeConfig(merged ?? next))
}

/**
 * 挂载插件。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 * @param {unknown} rawConfig 条目配置。
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const logger = typeof ctx.logger === 'function' ? ctx.logger(name) : ctx.logger
  const paths = {
    log: resolveBridgeLogPath(config.logPath),
    config: resolveBridgeConfigPath(config.bridgeConfigPath),
    logs: logsDirectory(),
  }
  const store = new LogStore({ directory: logsDirectory() })
  const log = (level, message) => { void store.append(level, message) }
  const hub = new TunnelHub({ config, state: new LocalState(stateFilePath()), paths, logger, log })

  ctx.effect(() => {
    hub.start()
    return () => hub.stop()
  }, 'dsh-bridge-tunnel-hub: 隧道地址扫描')

  // 设置页的本机接口：状态 / 日志 / 立即更新 / 配置读写。
  ctx.inject(['webServer'], (scope) => {
    const webServer = scope.get('webServer')
    if (!webServer || typeof webServer.register !== 'function') return
    const handlers = createRouteHandlers({
      hub,
      logStore: store,
      getConfigView: () => configView(config),
      saveConfig: (patch) => saveConfigPatch(ctx, patch),
      log,
    })
    for (const [key, path] of Object.entries(ROUTE_PATHS)) {
      scope.effect(
        () => webServer.register({ kind: 'exact', path, handler: handlers[key] }),
        `dsh-bridge-tunnel-hub: ${key} 路由`,
      )
    }
  })

  ctx.tools.register({
    name: 'tunnel_self',
    description: '本机 tunnel 信标：返回本机 dsh-bridge 的公网隧道地址、采集来源、最近一次上报结果、下一次整点刷新时间与 Gist 位置。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: OUTPUT,
    async execute() {
      return hub.self()
    },
  })

  ctx.tools.register({
    name: 'tunnel_list',
    description: '读取隧道地址汇总：列出 Gist 里登记的全部机器、当前地址、最后在线时间，以及每个地址现在是否可达；超过心跳间隔未刷新的机器会标为可能离线。',
    parameters: {
      type: 'object',
      properties: {
        probe: {
          type: 'boolean',
          description: '是否对每个地址做一次可用性探测；默认 true，关掉可更快拿到结果但看不到可达性。',
        },
      },
      additionalProperties: false,
    },
    output: OUTPUT,
    async execute(args) {
      return hub.list({ probe: args?.probe !== false })
    },
  })

  ctx.tools.register({
    name: 'tunnel_publish',
    description: '立即把本机当前隧道地址重新写入汇总 Gist（用于手动纠正或验证写入链路）。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: OUTPUT,
    async execute() {
      return hub.publishNow()
    },
  })

  logger?.info?.(`dsh-bridge-tunnel-hub: 已挂载（日志 ${paths.log}，Gist ${hub.gistId || '待创建'}）`)
  log('info', `已挂载（日志 ${paths.log}，Gist ${hub.gistId || '待创建'}）`)
}
