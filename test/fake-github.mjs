/**
 * 内存版 GitHub Gist API：只实现本插件用到的端点，供测试注入 `fetchImpl`。
 */
export function createFakeGitHub({ id = 'a'.repeat(32) } = {}) {
  const gists = new Map()

  function json(status, payload) {
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(payload),
    }
  }

  function materialize(files = {}) {
    return Object.fromEntries(Object.entries(files).map(([name, file]) => [name, file?.content ?? '']))
  }

  function toPayload(gist) {
    return {
      id: gist.id,
      description: gist.description,
      updated_at: gist.updated_at,
      html_url: gist.html_url,
      files: Object.fromEntries(
        Object.entries(gist.files).map(([name, content]) => [name, {
          filename: name,
          content,
          size: content.length,
          truncated: false,
        }]),
      ),
    }
  }

  async function fetchImpl(url, options = {}) {
    const parsed = new URL(String(url))
    const method = String(options.method ?? 'GET').toUpperCase()
    const body = options.body ? JSON.parse(String(options.body)) : undefined

    if (parsed.host.endsWith('.trycloudflare.com')) {
      return json(200, { enabled: true })
    }

    if (parsed.pathname === '/gists' && method === 'POST') {
      const gist = {
        id,
        description: body?.description ?? '',
        files: materialize(body?.files),
        updated_at: new Date().toISOString(),
        html_url: `https://gist.github.com/${id}`,
      }
      gists.set(id, gist)
      return json(201, toPayload(gist))
    }

    const match = parsed.pathname.match(/^\/gists\/([0-9a-f]{20,64})$/)
    if (!match) return json(404, { message: `unexpected ${method} ${parsed.pathname}` })
    const gist = gists.get(match[1])
    if (!gist) return json(404, { message: 'Not Found' })

    if (method === 'GET') return json(200, toPayload(gist))
    if (method === 'PATCH') {
      for (const [name, file] of Object.entries(body?.files ?? {})) gist.files[name] = file?.content ?? ''
      if (typeof body?.description === 'string' && body.description.length > 0) gist.description = body.description
      gist.updated_at = new Date().toISOString()
      return json(200, toPayload(gist))
    }
    return json(405, { message: `method ${method} not allowed` })
  }

  /** 直接读出 Gist 里的某个文件内容，便于断言。 */
  function readFile(name) {
    return gists.get(id)?.files?.[name] ?? null
  }

  /** 模拟有人手改了 Gist。 */
  function writeFile(name, content) {
    const gist = gists.get(id)
    if (gist) gist.files[name] = content
  }

  return { fetchImpl, gists, readFile, writeFile, id }
}
