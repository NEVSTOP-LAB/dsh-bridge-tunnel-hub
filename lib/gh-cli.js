/**
 * `gh api` 通道：用本机已登录的 GitHub CLI 读写 Gist。
 *
 * 为什么优先走 gh：部分网络环境对 GitHub 做了 TLS 拦截，Node 自带信任库不认中间证书
 * （`fetch failed` / `UNABLE_TO_VERIFY_LEAF_SIGNATURE`），而 gh 走系统信任库，通常正常。
 * 走 gh 还有一个好处：写入用的凭据与 `gh auth token` 是同一个，用户不需要单独配 token。
 *
 * 请求体一律通过 stdin 传给 `--input -`，避免把含引号的 JSON 拼进命令行。
 *
 * @module dsh-bridge-tunnel-hub/gh-cli
 */
import { spawn } from 'node:child_process'
import { GistError } from './gist.js'

/** 默认的子进程执行器；测试可整体替换。 */
export function spawnGh(args, input) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn('gh', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      reject(error)
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (error) => reject(error))
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
    if (input === undefined) {
      child.stdin?.end()
    } else {
      child.stdin?.write(input)
      child.stdin?.end()
    }
  })
}

/** gh 是否可用（装没装、能不能执行）。 */
export async function isGhAvailable(runner = spawnGh) {
  try {
    const result = await runner(['--version'], undefined)
    return result?.code === 0
  } catch {
    return false
  }
}

/** 从 gh 的报错里还原 HTTP 状态码。 */
export function parseGhStatus(stderr) {
  const text = String(stderr ?? '')
  const explicit = text.match(/HTTP\s+(\d{3})/)
  if (explicit) return Number(explicit[1])
  if (/not found/i.test(text)) return 404
  if (/bad credentials|requires authentication|unauthorized/i.test(text)) return 401
  if (/forbidden|missing the .* scope/i.test(text)) return 403
  return null
}

/**
 * 创建 gh 通道。
 *
 * @param {{ runner?: typeof spawnGh }} [options] 可替换的子进程执行器。
 */
export function createCliTransport({ runner = spawnGh } = {}) {
  async function call(args, input) {
    const result = await runner(args, input)
    if (result.code !== 0) {
      const message = String(result.stderr ?? '').trim() || `gh 退出码 ${result.code}`
      throw new GistError(message, { status: parseGhStatus(result.stderr) })
    }
    const text = String(result.stdout ?? '').trim()
    if (text.length === 0) return null
    try {
      return JSON.parse(text)
    } catch (error) {
      throw new GistError(`gh 返回的不是 JSON：${error?.message ?? error}`)
    }
  }

  return {
    kind: 'gh-cli',

    /**
     * @param {{ description: string, files: Record<string, string> }} options 创建参数。
     * @returns {Promise<{ id: string, htmlUrl: string, files: Record<string, string> }>}
     */
    async create({ description, files }) {
      const payload = await call(
        ['api', '-X', 'POST', '/gists', '--input', '-'],
        JSON.stringify({ description, public: false, files: toFilePayload(files) }),
      )
      const gist = normalize(payload)
      if (!gist.id) throw new GistError('gh 没有返回 Gist ID')
      return gist
    },

    /**
     * @param {{ id: string }} options 读取参数。
     */
    async read({ id }) {
      if (!id) throw new GistError('缺少 Gist ID')
      return normalize(await call(['api', `/gists/${id}`]))
    },

    /**
     * @param {{ id: string, description?: string, files: Record<string, string> }} options 更新参数。
     */
    async patch({ id, description, files }) {
      if (!id) throw new GistError('缺少 Gist ID')
      const body = { files: toFilePayload(files) }
      if (typeof description === 'string' && description.length > 0) body.description = description
      return normalize(await call(['api', '-X', 'PATCH', `/gists/${id}`, '--input', '-'], JSON.stringify(body)))
    },

    /**
     * 列出账号下的 Gist（最多两页 200 个），用于"加入已有登记"。
     *
     * @param {{ maxPages?: number }} [options] 分页上限。
     */
    async list({ maxPages = 2 } = {}) {
      const gists = []
      for (let page = 1; page <= Math.max(1, maxPages); page += 1) {
        const payload = await call(['api', `/gists?per_page=100&page=${page}`])
        if (!Array.isArray(payload)) break
        for (const item of payload) {
          gists.push({
            id: item?.id ?? '',
            description: item?.description ?? '',
            createdAt: item?.created_at ?? '',
            updatedAt: item?.updated_at ?? '',
          })
        }
        if (payload.length < 100) break
      }
      return gists
    },
  }
}

/** 把 `{文件名: 内容}` 转成 GitHub API 要求的 `{文件名: {content}}`；值为 null 表示删除。 */
function toFilePayload(files) {
  return Object.fromEntries(
    Object.entries(files ?? {}).map(([name, content]) => [name, content === null ? null : { content }]),
  )
}

/** 把 gh 返回的 Gist 收敛成插件内部视图（与 gist.js 的 REST 视图一致）。 */
function normalize(payload) {
  const files = {}
  for (const [name, file] of Object.entries(payload?.files ?? {})) {
    if (file && typeof file.content === 'string') files[name] = file.content
  }
  return {
    id: payload?.id ?? '',
    description: payload?.description ?? '',
    updatedAt: payload?.updated_at ?? '',
    htmlUrl: payload?.html_url ?? (payload?.id ? `https://gist.github.com/${payload.id}` : ''),
    files,
  }
}
