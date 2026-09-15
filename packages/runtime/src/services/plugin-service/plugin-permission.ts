/**
 * 插件权限检查器
 *
 * 规则（身份 = 通道反查，非消息体自报）：
 * - trusted 通道（Worker 级身份）: 全部放行——trusted 插件间互不设防是设计语义
 *   （同进程 JS 对等体物理上无法隔离，见设计文档 D1 信任模型澄清）
 * - sandbox 通道: 按通道唯一 pluginId 查 granted（存完整 RPC 方法名，
 *   经 normalizePermissionInput 归一化），has(method) 直接命中
 * - sandbox 通道无唯一 pluginId / 未授权方法: 拒绝（fail-closed）
 *
 * 权限口径 SSOT：grant/load 均把声明形（SDK 能力词汇 / manifest 短形 / legacy
 * 形态）归一化为完整方法名存储，check 收到的 method 即 dispatch 的 message.method
 * （完整方法名），两端口径一致。
 */

import type { PluginRegistry } from './plugin-registry.js'
import type { RpcIdentity } from './plugin-rpc-server.js'
import { normalizePermissionInput } from '@taiji/shared/plugin-permission-map'
import { PermissionStorage } from './plugin-permission-storage.js'

const EMPTY_GRANTS: ReadonlySet<string> = new Set<string>()

export class PluginPermissionChecker {
  private registry: PluginRegistry
  private granted = new Map<string, Set<string>>()
  private storage: PermissionStorage

  /** @param storage 权限持久化存储，由组合根注入（不再直连 infra 取默认目录）。 */
  constructor(registry: PluginRegistry, storage: PermissionStorage) {
    this.registry = registry
    this.storage = storage
  }

  /**
   * 检查通道身份是否有权调用指定方法。
   *
   * @param identity 通道反查身份（PluginRpcServer.resolveIdentity 的产物，
   *   宿主注册的权威值；消息体自报 pluginId 不进入本方法）
   * @param method 完整 RPC 方法名（如 'plugin.storage.global.set'）
   * @returns true 表示允许，false 表示拒绝
   */
  check(identity: RpcIdentity, method: string): boolean {
    // trusted 通道（Worker 级）：放行。built-in 插件均跑在 trusted 通道，同此分支
    if (identity.trustLevel === 'trusted') {
      return true
    }

    // sandbox 通道：必有唯一 pluginId（processId = sandbox-<pluginId> 一对一）；
    // 缺失 = 通道注册异常，fail-closed 拒绝
    if (!identity.pluginId) return false

    const permissions = this.granted.get(identity.pluginId)
    if (!permissions) return false
    return permissions.has(method)
  }

  /**
   * 授予插件权限。入参任意口径（SDK 常量 / manifest 短形 / legacy / 完整方法名）
   * 均经 normalizePermissionInput 归一化为完整方法名后追加，不覆盖已有权限。
   *
   * @param pluginId 插件 ID
   * @param permissions 权限列表（任意口径）
   */
  grant(pluginId: string, permissions: string[]): void {
    const existing = this.granted.get(pluginId) ?? new Set<string>()
    for (const p of permissions) {
      for (const method of normalizePermissionInput(p)) {
        existing.add(method)
      }
    }
    this.granted.set(pluginId, existing)
  }

  /**
   * 返回尚未审批的权限列表。
   * Activator 在激活插件时调用，用于判断是否需要弹出权限审批 UI。
   *
   * 声明侧与 granted 侧同经归一化对齐：声明的每个权限词映射到的全部方法都已在
   * granted 集合内 → 视为已批准。未知权限词（归一化为空）不进入未批准列表——
   * 无从审批也不阻断激活，执法点在 RPC 层（按未授权拒绝）。
   *
   * @param pluginId 插件 ID
   * @param permissions 插件声明的权限列表（任意口径）
   * @returns 尚未审批的权限子集（原样返回声明词，保持审批 UI 词汇一致）
   */
  getUnapproved(pluginId: string, permissions: string[]): string[] {
    const descriptor = this.registry.getDescriptor(pluginId)
    if (!descriptor) return permissions

    // trusted / built-in 插件不需要审批
    if (descriptor.trustLevel === 'trusted' || descriptor.source === 'built-in') {
      return []
    }

    const granted = this.granted.get(pluginId) ?? EMPTY_GRANTS
    return permissions.filter(p => {
      const methods = normalizePermissionInput(p)
      return methods.length > 0 && !methods.every(m => granted.has(m))
    })
  }

  /**
   * 撤销插件的所有权限。
   *
   * @param pluginId 插件 ID
   */
  revoke(pluginId: string): void {
    this.granted.delete(pluginId)
  }

  /**
   * 从磁盘加载已保存的权限数据。
   * storage.load 已对旧持久化数据逐条归一化（迁移）；此处再过一遍归一化作
   * 深度防御（完整方法名二次归一幂等，不变形）。
   */
  async load(): Promise<void> {
    const data = await this.storage.load()
    for (const [pluginId, permissions] of data) {
      const set = new Set<string>()
      for (const p of permissions) {
        for (const method of normalizePermissionInput(p)) {
          set.add(method)
        }
      }
      this.granted.set(pluginId, set)
    }
  }

  /**
   * 保存当前权限数据到磁盘（完整方法名形态；旧声明形在下次 load 时归一化迁移）。
   */
  async save(): Promise<void> {
    const data = new Map<string, string[]>()
    for (const [pluginId, permissions] of this.granted) {
      data.set(pluginId, [...permissions])
    }
    await this.storage.save(data)
  }
}
