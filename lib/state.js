/**
 * 本机状态：机器 ID、自动创建的 Gist ID、最近一次成功上报的地址与时间、最近一次错误。
 *
 * 这些值不适合放插件配置：Gist 是本机首次启动时自动创建的，写进 profile 配置会让
 * 用户看到一堆不该关心的字段；而配置项一旦变化会重启插件。因此单独落一个状态文件。
 *
 * @module dsh-bridge-tunnel-hub/state
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** 状态文件缺省值。 */
const EMPTY_STATE = Object.freeze({
  machineId: '',
  gistId: '',
  lastUrl: '',
  lastPublishedAt: '',
  lastError: '',
})

/** 进程内状态仓库。 */
export class LocalState {
  /**
   * @param {string} filePath 状态文件路径。
   */
  constructor(filePath) {
    this.filePath = filePath
    this.data = { ...EMPTY_STATE }
  }

  /**
   * 读取状态文件；文件缺失或损坏时用空状态继续，并补上机器 ID。
   *
   * @returns {Promise<typeof EMPTY_STATE>} 当前状态。
   */
  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'))
      if (parsed && typeof parsed === 'object') {
        this.data = {
          ...EMPTY_STATE,
          ...Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === 'string')),
        }
      }
    } catch {
      this.data = { ...EMPTY_STATE }
    }
    if (!this.data.machineId) this.data.machineId = randomUUID()
    return this.data
  }

  /**
   * 合并写入状态（先写临时文件再改名，避免半截文件）。
   *
   * @param {Partial<typeof EMPTY_STATE>} patch 要更新的字段。
   * @returns {Promise<typeof EMPTY_STATE>} 更新后的状态。
   */
  async save(patch = {}) {
    this.data = { ...this.data, ...patch }
    const directory = dirname(this.filePath)
    await mkdir(directory, { recursive: true })
    const temporary = `${this.filePath}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8')
    await rename(temporary, this.filePath)
    return this.data
  }
}
