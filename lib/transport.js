/**
 * Gist 读写通道：优先 `gh api`，没有 gh 时退回 REST（需要 token）。
 *
 * 两条通道提供同一组方法，上层（hub / 工具）不需要知道用的是哪条。
 *
 * @module dsh-bridge-tunnel-hub/transport
 */
import { createGist, listGists, patchGist, readGist, GistError } from './gist.js'
import { createCliTransport, isGhAvailable } from './gh-cli.js'
import { resolveGithubToken } from './token.js'

/**
 * REST 通道：用 token 直接调 api.github.com。
 *
 * @param {{ token: string, fetchImpl?: typeof fetch }} options 通道参数。
 */
export function createRestTransport({ token, fetchImpl }) {
  if (!token) throw new GistError('没有可用的 GitHub token：请在插件设置里填一个有 gist 权限的 token，或先在本机登录 gh')
  return {
    kind: 'rest',
    create({ description, files }) {
      return createGist({ token, description, files, fetchImpl })
    },
    read({ id }) {
      return readGist({ id, token, fetchImpl })
    },
    patch({ id, description, files }) {
      return patchGist({ id, token, description, files, fetchImpl })
    },
    list(options) {
      return listGists({ token, fetchImpl, ...(options ?? {}) })
    },
  }
}

/**
 * 选择并创建 Gist 通道。
 *
 * 优先 gh：它用系统信任库，在 TLS 拦截（mitm）网络里通常能通，也不要求用户额外配 token。
 *
 * @param {{ token?: string, fetchImpl?: typeof fetch, preferCli?: boolean, ghAvailable?: () => Promise<boolean> }} [options]
 * @returns {Promise<{ kind: string, create: Function, read: Function, patch: Function }>}
 */
export async function createGistTransport({
  token = '',
  fetchImpl = globalThis.fetch,
  preferCli = true,
  ghAvailable = () => isGhAvailable(),
} = {}) {
  if (preferCli) {
    let available = false
    try {
      available = await ghAvailable()
    } catch {
      available = false
    }
    if (available) return createCliTransport()
  }
  const resolved = await resolveGithubToken(token)
  return createRestTransport({ token: resolved.token, fetchImpl })
}
