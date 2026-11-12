/**
 * dsh-bridge-tunnel-hub：把每台机器上 dsh-bridge 的公网隧道地址汇总到一个私有 Gist。
 *
 * dsh-bridge 的免登录临时隧道每次重启都会换域名，外部因此无法记住入口。本插件在
 * 地址变化时把它写进一个 Gist（一行 `机器名:地址`），并让任意一台机器随时查回
 * 全部机器的当前地址。
 *
 * 只做三件事：采集、探活、上报；不接管隧道、不改 dsh-bridge 的任何配置与日志，
 * 也绝不把带 `?auth=` 的免密地址写出去。
 *
 * @module dsh-bridge-tunnel-hub
 */
import { Config, normalizeConfig } from './config.js'
import { TunnelHub } from './hub.js'
import { LocalState } from './state.js'
import { resolveBridgeConfigPath, resolveBridgeLogPath, stateFilePath } from './paths.js'

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
  }
  const state = new LocalState(stateFilePath())
  const hub = new TunnelHub({ config, state, paths, logger })

  ctx.effect(() => {
    hub.start()
    return () => hub.stop()
  }, 'dsh-bridge-tunnel-hub: 隧道地址扫描')

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
}
