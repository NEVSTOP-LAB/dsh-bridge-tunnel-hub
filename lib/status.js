/**
 * `status.json` 的结构与合并规则。
 *
 * `tunnels.txt` 只放"机器名:地址"，便于人看；每台机器最近一次更新时间、机器 ID、
 * 隧道类型等信息放这里。两边以"机器名"关联，机器 ID 用来识别改名（改名后旧行会被删掉）。
 *
 * @module dsh-bridge-tunnel-hub/status
 */

/** 状态文件结构版本。 */
export const STATUS_VERSION = 1

/**
 * 解析 `status.json`；内容非法时返回空结构而不是抛错。
 *
 * @param {string} text 文件内容。
 * @returns {{ generatedAt: string|null, machines: Record<string, object> }}
 */
export function parseStatus(text) {
  try {
    const parsed = JSON.parse(String(text ?? ''))
    if (!parsed || typeof parsed !== 'object') return { generatedAt: null, machines: {} }
    const machines = parsed.machines && typeof parsed.machines === 'object' && !Array.isArray(parsed.machines)
      ? parsed.machines
      : {}
    return {
      generatedAt: typeof parsed.generatedAt === 'string' ? parsed.generatedAt : null,
      machines,
    }
  } catch {
    return { generatedAt: null, machines: {} }
  }
}

/**
 * 按机器 ID 找已登记的机器名（用于识别改名）。
 *
 * @param {{ machines: Record<string, object> }} status 状态结构。
 * @param {string} machineId 机器 ID。
 * @returns {string|null} 已登记的机器名。
 */
export function findMachineNameById(status, machineId) {
  if (!machineId) return null
  for (const [name, entry] of Object.entries(status?.machines ?? {})) {
    if (entry && typeof entry === 'object' && entry.machineId === machineId) return name
  }
  return null
}

/**
 * 写入或更新一台机器的状态，并按机器 ID 清掉同名/旧名条目。
 *
 * @param {{ generatedAt: string|null, machines: Record<string, object> }} status 原状态。
 * @param {object} machine 机器记录，至少包含 `name` 与 `machineId`。
 * @param {string} [now] 本次写入时间（ISO 字符串）。
 * @returns {{ generatedAt: string|null, machines: Record<string, object> }}
 */
export function upsertStatusMachine(status, machine, now = new Date().toISOString()) {
  const name = String(machine?.name ?? '').trim()
  if (name.length === 0) return { generatedAt: now, machines: { ...(status?.machines ?? {}) } }

  // 按原有位置替换，而不是删掉再追加：两台机器轮流写同一个文件时，追加会让顺序每轮翻转，
  // 顺序敏感的比较就会把"没变化"判成"有变化"，于是每 5 分钟产生一个无谓的 Gist 版本。
  const next = {}
  let placed = false
  for (const [existingName, entry] of Object.entries(status?.machines ?? {})) {
    const sameName = existingName.toLowerCase() === name.toLowerCase()
    const sameId = Boolean(machine.machineId) && Boolean(entry) && typeof entry === 'object' && entry.machineId === machine.machineId
    if (sameName || sameId) {
      if (!placed) {
        next[name] = { ...machine, updatedAt: machine.updatedAt ?? now }
        placed = true
      }
      continue
    }
    next[existingName] = entry
  }
  if (!placed) next[name] = { ...machine, updatedAt: machine.updatedAt ?? now }

  return { generatedAt: now, machines: next }
}

/** 序列化成 `status.json` 内容。 */
export function serializeStatus(status) {
  const payload = {
    version: STATUS_VERSION,
    generatedAt: status?.generatedAt ?? null,
    machines: status?.machines ?? {},
  }
  return `${JSON.stringify(payload, null, 2)}\n`
}
