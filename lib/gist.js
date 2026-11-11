/**
 * GitHub Gist 客户端：只做本插件用到的四件事——创建、读取、更新、解析 ID。
 *
 * Gist 没有真正的"私有"档：secret Gist 不搜索、不列出，但持有链接的人可以读取。
 * 因此本插件只往 Gist 里写**裸地址**（不含 `?auth=` 免密凭据），并且从不把它当作
 * 安全边界；地址仍然受 dsh-bridge 自己的访问认证保护。
 *
 * @module dsh-bridge-tunnel-hub/gist
 */

/** Gist 的描述就是本插件的包名，用户在 GitHub 上一眼能认出来。 */
export const GIST_DESCRIPTION = 'dsh-bridge-tunnel-hub'

/** GitHub REST API 根地址。 */
const API_ORIGIN = 'https://api.github.com'

/** Gist 操作失败时抛出的错误，带上 HTTP 状态便于上层区分 401/403/404/409。 */
export class GistError extends Error {
  /**
   * @param {string} message 可读错误信息。
   * @param {{ status?: number|null, body?: unknown }} [details] HTTP 细节。
   */
  constructor(message, { status = null, body = null } = {}) {
    super(message)
    this.name = 'GistError'
    this.status = status
    this.body = body
  }
}

/**
 * 从 Gist 链接、`gist:<id>` 或裸 ID 中解析出 Gist ID。
 *
 * @param {unknown} value 用户输入。
 * @returns {string} 解析出的 ID；解析不到时为空串。
 */
export function parseGistId(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length === 0) return ''
  if (/^[0-9a-f]{20,64}$/i.test(text)) return text
  const prefixed = text.match(/^gist:([0-9a-f]{20,64})$/i)
  if (prefixed) return prefixed[1]
  const url = text.match(/gist\.github\.com\/(?:[^/]+\/)?([0-9a-f]{20,64})/i)
  return url ? url[1] : ''
}

/** 由 Gist ID 生成网页链接。 */
export function gistWebUrl(id) {
  return id ? `https://gist.github.com/${id}` : ''
}

/**
 * 底层请求：统一请求头、错误转换。
 *
 * @param {string} pathname API 路径。
 * @param {{ token?: string, method?: string, body?: unknown, fetchImpl?: typeof fetch }} options 请求选项。
 * @returns {Promise<any>} 解析后的响应体。
 */
async function request(pathname, { token, method = 'GET', body, fetchImpl = globalThis.fetch } = {}) {
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'dsh-bridge-tunnel-hub',
    'x-github-api-version': '2022-11-28',
  }
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'

  let response
  try {
    response = await fetchImpl(`${API_ORIGIN}${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (error) {
    const cause = error?.cause?.code ? `（${error.cause.code}）` : ''
    throw new GistError(`连接 GitHub 失败：${error?.message ?? String(error)}${cause}`)
  }

  const text = await response.text()
  let payload = null
  try {
    payload = text.length > 0 ? JSON.parse(text) : null
  } catch {
    payload = null
  }

  if (!response.ok) {
    const detail = payload?.message ?? text.slice(0, 200)
    const hint = response.status === 401 || response.status === 403
      ? '（token 无效或没有 gist 权限）'
      : response.status === 404
        ? '（Gist 不存在或 token 看不到它）'
        : ''
    throw new GistError(`GitHub ${response.status}：${detail}${hint}`, { status: response.status, body: payload })
  }
  return payload
}

/** 把 API 响应收敛成插件内部使用的 Gist 视图。 */
function normalizeGist(payload) {
  const files = {}
  for (const [name, file] of Object.entries(payload?.files ?? {})) {
    if (file && typeof file.content === 'string') files[name] = file.content
  }
  return {
    id: payload?.id ?? '',
    description: payload?.description ?? '',
    updatedAt: payload?.updated_at ?? '',
    htmlUrl: payload?.html_url ?? gistWebUrl(payload?.id ?? ''),
    files,
    rawFiles: payload?.files ?? {},
  }
}

/**
 * 创建 secret Gist。
 *
 * @param {{ token?: string, description?: string, files: Record<string, string>, fetchImpl?: typeof fetch }} options 创建参数。
 * @returns {Promise<{ id: string, htmlUrl: string, files: Record<string, string> }>}
 */
export async function createGist({ token, description = GIST_DESCRIPTION, files, fetchImpl } = {}) {
  const payload = await request('/gists', {
    token,
    method: 'POST',
    body: {
      description,
      public: false,
      files: Object.fromEntries(Object.entries(files ?? {}).map(([name, content]) => [name, { content }])),
    },
    fetchImpl,
  })
  const gist = normalizeGist(payload)
  if (!gist.id) throw new GistError('GitHub 没有返回 Gist ID')
  return gist
}

/**
 * 读取 Gist（token 可省略：secret Gist 凭 ID 即可匿名读取）。
 *
 * @param {{ id: string, token?: string, fetchImpl?: typeof fetch }} options 读取参数。
 * @returns {Promise<ReturnType<typeof normalizeGist>>}
 */
export async function readGist({ id, token, fetchImpl } = {}) {
  if (!id) throw new GistError('缺少 Gist ID')
  const payload = await request(`/gists/${id}`, { token, fetchImpl })
  const gist = normalizeGist(payload)
  // 单个文件过大时 API 只给 1MB 截断内容；本插件的文件很小，出现截断说明文件被外人改过。
  for (const [name, file] of Object.entries(gist.rawFiles ?? {})) {
    if (gist.files[name] === undefined && file?.truncated && file?.raw_url) {
      try {
        const raw = await fetchImpl(file.raw_url, { headers: { 'user-agent': 'dsh-bridge-tunnel-hub' } })
        if (raw.ok) gist.files[name] = await raw.text()
      } catch { /* 读不到就当作该文件不存在，由上层重建 */ }
    }
  }
  return gist
}

/**
 * 更新 Gist 中的文件（只更新传入的文件，其余文件不动）。
 *
 * @param {{ id: string, token?: string, description?: string, files: Record<string, string>, fetchImpl?: typeof fetch }} options 更新参数。
 * @returns {Promise<ReturnType<typeof normalizeGist>>}
 */
export async function patchGist({ id, token, description, files, fetchImpl } = {}) {
  if (!id) throw new GistError('缺少 Gist ID')
  const body = {
    files: Object.fromEntries(Object.entries(files ?? {}).map(([name, content]) => [name, { content }])),
  }
  if (typeof description === 'string' && description.length > 0) body.description = description
  const payload = await request(`/gists/${id}`, { token, method: 'PATCH', body, fetchImpl })
  return normalizeGist(payload)
}
