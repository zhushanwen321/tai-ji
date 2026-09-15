/**
 * 插件权限持久化存储
 *
 * 负责读写 <dir>/permissions.json。底层用 JsonStore（read-through + ENOENT 容错
 * + atomicWrite），对外保留 async load/save 签名以维持 PluginPermissionChecker /
 * PluginService 的调用契约不变（async 方法内调 sync IO 合法，KB 级文件无感）。
 */

import { join } from 'node:path'
import { normalizePermissionInput } from '@taiji/shared/plugin-permission-map'
import { JsonStore } from '../../utils/json-store.js'

const PERMISSIONS_FILE = 'permissions.json'

type PermissionsRecord = Record<string, string[]>

export class PermissionStorage {
  private store: JsonStore<PermissionsRecord>

  constructor(dir: string) {
    this.store = new JsonStore<PermissionsRecord>(
      join(dir, PERMISSIONS_FILE),
      {},
      {
        deserialize: (raw): PermissionsRecord => {
          const obj: PermissionsRecord = {}
          if (raw && typeof raw === 'object') {
            for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
              if (Array.isArray(v)) obj[k] = v
            }
          }
          return obj
        },
      },
    )
  }

  /**
   * 从磁盘加载权限数据。
   * 文件不存在或 JSON 损坏时返回空 Map。
   *
   * 旧数据迁移：磁盘上的历史持久化权限是声明形口径（SDK 常量 / manifest 短形 /
   * legacy 形态），逐条过 normalizePermissionInput 归一化为完整 RPC 方法名
   * （去重保序）。已是完整方法名的数据幂等透传，不变形。
   */
  async load(): Promise<Map<string, string[]>> {
    const record = this.store.read()
    const result = new Map<string, string[]>()
    for (const [pluginId, permissions] of Object.entries(record)) {
      const methods = new Set<string>()
      for (const p of permissions) {
        for (const method of normalizePermissionInput(p)) {
          methods.add(method)
        }
      }
      result.set(pluginId, [...methods])
    }
    return result
  }

  /**
   * 保存权限数据到磁盘（atomic write）。
   */
  async save(data: Map<string, string[]>): Promise<void> {
    const record: PermissionsRecord = {}
    for (const [k, v] of data) {
      record[k] = v
    }
    this.store.write(record)
  }
}
