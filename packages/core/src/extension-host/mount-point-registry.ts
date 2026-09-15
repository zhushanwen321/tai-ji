/**
 * mount-point-registry.ts —— MountPointRegistry（IF5）。
 *
 * 挂载点 SSOT（core 侧，AC10）：壳 bootstrap 注册可用挂载点，plugin contribution 经
 * ContributionRegistry.routeAll 路由到挂载点。挂载点是开放字符串（非枚举）：
 * 'sidebar.tab'/'panel.header'/'composer.toolbar'/'statusbar'/'drawer.tab'/...——
 * mobile 壳只注册 message-stream/slash/companion 子集，桌面壳注册全量（§6.3 壳注册制）。
 *
 * 契约（IF5）：
 * - 重复 register 同名：覆盖（幂等），不抛错
 * - unregister 不存在的挂载点：no-op 不抛错
 * - list() 返回当前已注册集合（AC10 core 侧）
 */
export interface MountPointHost {
  id: string
  /** 壳注册时携带的宿主句柄（s4 渲染件使用，s2 只存不消费） */
  render?: (ctx: unknown) => void
}

export class MountPointRegistry {
  private mounts = new Map<string, MountPointHost>()

  /** 注册可用挂载点（壳 bootstrap 调）。重复注册同名：覆盖（幂等）。 */
  register(name: string, host?: MountPointHost): void {
    this.mounts.set(name, host ?? { id: name })
  }

  /** 注销挂载点。不存在则 no-op。 */
  unregister(name: string): void {
    this.mounts.delete(name)
  }

  has(name: string): boolean {
    return this.mounts.has(name)
  }

  /** 当前已注册挂载点集合（AC10 core 侧 SSOT）。 */
  list(): string[] {
    return Array.from(this.mounts.keys())
  }
}
