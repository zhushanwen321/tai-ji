/**
 * activation-manager.ts —— ActivationManager（IF7/TC6）。
 *
 * [DORMANT] 懒激活机制当前未生效，等 runtime 激活 RPC 落地：
 * - 生产注入 no-op trigger（renderer useExtensionHostBridge.ts 装配点：
 *   `new ActivationManager({ trigger: { ensureActivated: async () => {} } })`）——
 *   runtime 侧无 plugin.triggerActivation RPC（plugin-message-handler 无该 case），
 *   壳无法适配真实 trigger。
 * - registerActivationEvents 生产零调用（activationEvents 注册表无人填充），
 *   仅测试调用——注册表未命中时 ensureActivated 恒 no-op。
 * - 类本身有真实消费方（CommandRegistry.execute → ensureActivated），但在上述
 *   两事实下整条激活链路等价于直通：不触发、不报错。
 * runtime 落地激活 RPC 后：壳装配点换真实 trigger 适配 + bootstrap 填注册表，
 * 本注释随之移除。
 *
 * 懒激活状态机：查 activationEvents 注册表 → 幂等判定 → 经注入的 ActivationTrigger 触发。
 * 单测注入 MockActivationTrigger（vi.fn 构造）驱动幂等与事件路由。
 *
 * 契约（IF7）：
 * - 幂等：同一 pluginId 重复 ensureActivated 只触发一次（isActivated 缓存判定）
 * - 未声明对应 activationEvent 的 plugin：ensureActivated no-op（不触发）
 * - 触发失败上抛（不静默，项目规则「失败要出声」）
 * - activationEvents 注册表自包含（registerActivationEvents 注入）——W1 ContributionRecord
 *   无 activationEvents 字段（parseContributes 未解析 view.activationEvent），从
 *   ContributionRegistry/builtin manifest 收集 activationEvent 的集成辅助归壳层/s5（clarify Q1）
 */
export type ActivationEvent =
  | 'onView'
  | 'onCommand'
  | 'onSlashCommand'
  | 'onStartupFinished'
  | 'onSessionCreate'

/** 触发契约接口（TC6）：壳适配 runtime 激活 RPC（plugin.triggerActivation，s3）注入。 */
export interface ActivationTrigger {
  ensureActivated(pluginId: string, event: ActivationEvent): Promise<void>
}

export interface ActivationManagerDeps {
  trigger: ActivationTrigger
  /** 外部已知已激活判定（如 runtime 报告某插件已 active）。存在时与本地 Set OR 语义。 */
  isActivated?: (pluginId: string) => boolean
}

export class ActivationManager {
  /** activationEvents 注册表：pluginId → 声明的事件集合（registerActivationEvents 注入）。 */
  private activationEvents = new Map<string, ActivationEvent[]>()
  /** 本次 session 内已触发过的插件缓存（幂等判定）。 */
  private activated = new Set<string>()

  constructor(private deps: ActivationManagerDeps) {}

  /** 注入 plugin 声明的激活事件（覆盖式注册，重复调用新集合生效）。 */
  registerActivationEvents(pluginId: string, events: ActivationEvent[]): void {
    this.activationEvents.set(pluginId, events)
  }

  /**
   * 懒激活入口：已激活（注入判定或本地缓存）→ 短路；注册表未命中该事件 → no-op；
   * 命中且未激活 → 调 trigger.ensureActivated 恰好一次，成功后本地缓存。
   */
  async ensureActivated(pluginId: string, event: ActivationEvent): Promise<void> {
    if (this.isActivated(pluginId)) return
    const events = this.activationEvents.get(pluginId)
    if (!events || !events.includes(event)) return
    await this.deps.trigger.ensureActivated(pluginId, event)
    this.activated.add(pluginId)
  }

  /** 激活状态：注入函数存在时 OR 本地缓存（外部已激活不重复触发），否则查本地缓存。 */
  isActivated(pluginId: string): boolean {
    if (this.deps.isActivated) return this.deps.isActivated(pluginId) || this.activated.has(pluginId)
    return this.activated.has(pluginId)
  }
}
