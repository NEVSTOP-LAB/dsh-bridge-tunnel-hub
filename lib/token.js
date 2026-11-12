/**
 * GitHub token 解析：写入 Gist 需要 `gist` 权限的 token。
 *
 * 解析顺序：插件配置里的 token → `gh auth token`（本机 gh 已登录时无需再配）。
 * 只读场景（其他机器查看地址）不需要 token，因此这里拿不到 token 也不算失败。
 *
 * @module dsh-bridge-tunnel-hub/token
 */
import { execFile } from 'node:child_process'

/** 进程级缓存：gh 每次调用约 100ms，配置没变时没必要反复取。 */
let cachedGhToken = ''

/**
 * 用 `gh auth token` 取当前登录账号的 token。
 *
 * @returns {Promise<string>} token；不可用时为空串。
 */
export function readGhToken() {
  return new Promise((resolve) => {
    execFile('gh', ['auth', 'token'], { timeout: 8000, windowsHide: true, shell: false }, (error, stdout) => {
      if (error) {
        resolve('')
        return
      }
      const token = String(stdout ?? '').trim()
      resolve(/^[A-Za-z0-9_]{20,}$/.test(token) ? token : '')
    })
  })
}

/**
 * 解析可用的 GitHub token。
 *
 * @param {string} [configured] 插件配置里的 token。
 * @returns {Promise<{ token: string, source: 'config'|'gh-cli'|'none' }>}
 */
export async function resolveGithubToken(configured) {
  const direct = typeof configured === 'string' ? configured.trim() : ''
  if (direct) return { token: direct, source: 'config' }
  if (cachedGhToken) return { token: cachedGhToken, source: 'gh-cli' }
  const token = await readGhToken()
  if (token) {
    cachedGhToken = token
    return { token, source: 'gh-cli' }
  }
  return { token: '', source: 'none' }
}

/** 清空进程级缓存（测试用）。 */
export function resetTokenCache() {
  cachedGhToken = ''
}
