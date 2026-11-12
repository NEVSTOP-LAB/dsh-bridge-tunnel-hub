/**
 * 界面用的本机 HTTP 路由：状态、日志、立即更新、配置读写。
 *
 * 路由挂在 DSH 自己的 Web 服务上，与界面同源——页面里的 fetch 自带会话，隧道访问也走
 * dsh-bridge 的认证门禁。这里不额外开端口，也不存任何浏览器状态。
 *
 * @module dsh-bridge-tunnel-hub/routes
 */

/** 路由路径。 */
export const ROUTE_PATHS = {
  status: '/__dsh-bridge-tunnel-hub/status',
  logs: '/__dsh-bridge-tunnel-hub/logs',
  publish: '/__dsh-bridge-tunnel-hub/publish',
  config: '/__dsh-bridge-tunnel-hub/config',
}

/** 请求体上限：配置字段都很小。 */
const MAX_BODY_BYTES = 64 * 1024

/**
 * 写 JSON 响应。
 *
 * @param {import('node:http').ServerResponse} res 响应对象。
 * @param {number} status HTTP 状态码。
 * @param {unknown} body 响应体。
 */
function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/**
 * 读取并解析 JSON 请求体。
 *
 * @param {import('node:http').IncomingMessage} req 请求对象。
 * @returns {Promise<unknown>} 解析后的值。
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let text = ''
    req.on('data', (chunk) => {
      text += chunk
      if (text.length > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        req.destroy()
      }
    })
    req.on('end', () => {
      if (text.trim().length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/** 解析 `?hours=&limit=`。 */
function parseLogQuery(url) {
  const query = new URL(url ?? '/', 'http://localhost').searchParams
  return {
    hours: Number(query.get('hours') ?? NaN),
    limit: Number(query.get('limit') ?? NaN),
  }
}

/**
 * 创建四个路由处理器。
 *
 * @param {{ hub: import('./hub.js').TunnelHub, logStore: import('./log-store.js').LogStore, getConfigView: () => object, saveConfig: (patch: object) => Promise<object>, log?: (level: string, message: string) => void }} options 依赖。
 * @returns {Record<keyof typeof ROUTE_PATHS, (req: any, res: any) => Promise<void>>} 处理器。
 */
export function createRouteHandlers({ hub, logStore, getConfigView, saveConfig, log = () => {} }) {
  async function status(req, res) {
    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    try {
      const status = await hub.self()
      sendJson(res, 200, { ok: true, status, config: getConfigView() })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error?.message ?? String(error) })
    }
  }

  async function logs(req, res) {
    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    try {
      const { hours, limit } = parseLogQuery(req.url)
      const entries = await logStore.readRecent({ hours, limit })
      sendJson(res, 200, {
        ok: true,
        hours: Number.isFinite(hours) && hours > 0 ? hours : 24,
        entries,
        total: entries.length,
      })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error?.message ?? String(error) })
    }
  }

  async function publish(req, res) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    try {
      log('info', '界面请求立即更新')
      const result = await hub.publishNow()
      sendJson(res, result.ok === false ? 409 : 200, { ok: result.ok !== false, result })
    } catch (error) {
      const message = error?.message ?? String(error)
      log('error', `界面立即更新失败：${message}`)
      sendJson(res, 500, { ok: false, error: message })
    }
  }

  async function config(req, res) {
    if (req.method === 'GET') {
      sendJson(res, 200, { ok: true, config: getConfigView() })
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    try {
      const patch = await readJsonBody(req)
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        sendJson(res, 400, { ok: false, error: '配置必须是对象' })
        return
      }
      const saved = await saveConfig(patch)
      log('info', `界面保存配置：${Object.keys(patch).join(', ') || '（无变化）'}`)
      sendJson(res, 200, { ok: true, config: saved, restarting: true })
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error?.message ?? String(error) })
    }
  }

  return { status, logs, publish, config }
}
