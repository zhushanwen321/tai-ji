/**
 * plugin-modal-slot.ts —— plugin modal 全局单槽（AP-2 单例语义的 core 侧承载）。
 *
 * 「同一时刻全应用只有一个 plugin modal」：全局槽状态不属于 per-session（search-modal.ts
 * 先例：模块级单例裁决），modal 内容数据才是 per-session 分区（ViewHostStore / D1）。
 * 本模块 = 槽位仲裁记录（当前 open 槽 owner {pluginId, modalId, sessionId, epoch}），
 * 由 plugin:modalState 帧（runtime 仲裁结果的 S→C 全局广播，单一真相帧）驱动保持镜像：
 * - open：同 (pluginId, modalId) 重复 open 不算换主（不产生 replaced、槽 owner 不变），
 *   但 epoch 递增并反映在最新 open 记录；不同 owner 的 open 以 replaced 关闭旧者
 *   （replaced 语义随返回值上浮；对旧插件 owner 的 plugin.ui.modalClosed 通知由 runtime 承担）
 * - close：校验 (pluginId, modalId, epoch) 三元组——陈旧 epoch（关闭在途时的重开）或
 *   owner 不匹配 → not-applied（槽不变，防陈旧 dismiss 误关刚重开的新层）；命中 → 槽清空
 *
 * epoch 契约：正整数、按每次生效 open 严格递增（runtime 侧单调计数器的镜像；
 * ≤ 高水位的 open 视为陈旧丢弃——帧流内乱序/重复帧的防御，对齐 AP-2 lastEpoch 丢弃规则）。
 *
 * 状态载体 = 模块级 shallowRef（整记录替换、无深变异）：renderer（PluginModalHost）直接消费。
 * resetPluginModalSlot 保留（测试隔离用，单例状态跨测试共享——search-modal 同款）。
 */
import { shallowRef } from 'vue'
import type { InternalEventBus } from './internal-event-bus'
import type { PluginModalClosedReason } from './types'

/** 当前 open 槽记录（plugin:modalState open 帧的槽位投影：payload 去 state/reason）。 */
export interface PluginModalSlotRecord {
  pluginId: string
  modalId: string
  sessionId: string
  epoch: number
  title?: string
  width?: 'sm' | 'md' | 'lg'
}

/** open 请求（直接调用形态可缺省 epoch——槽内高水位自增；帧驱动形态必须携带帧内 epoch）。 */
export interface PluginModalOpenRequest {
  pluginId: string
  modalId: string
  sessionId: string
  title?: string
  width?: 'sm' | 'md' | 'lg'
  epoch?: number
}

/** open 结果：outcome=replaced 时 replaced 携带被关闭的旧槽记录。 */
export type ModalOpenResult =
  | { applied: true; outcome: 'opened' | 'reopened' | 'replaced'; record: PluginModalSlotRecord; replaced?: PluginModalSlotRecord }
  | { applied: false; notApplied: 'stale-epoch' }

/** close 结果：notApplied 三态可判定（槽未开 / owner 不匹配 / epoch 陈旧）。 */
export type ModalCloseResult =
  | { applied: true; closed: PluginModalSlotRecord; reason: PluginModalClosedReason }
  | { applied: false; notApplied: 'not-open' | 'owner-mismatch' | 'epoch-mismatch' }

// ── 模块级单例状态（全局槽非 per-session，search-modal 同款）──
// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态，对照 search-modal.ts 同族先例；
// 登记待补：data-source-registry.md ⑧ EX-B 补登一行——登记表不在 u4a 单元领地内，
// 由 data-source-registry 修改方〔u4b 首动作〕随批落定，见 u4a deviations）
const currentSlot = shallowRef<PluginModalSlotRecord | null>(null)
/** 已生效 open 的最高 epoch（单调水位；close 不回退水位）。 */
let highWaterEpoch = 0
let unsubscribe: (() => void) | null = null

/**
 * 打开/换主仲裁。同 (pluginId, modalId) → reopened（epoch 递增、记录更新为最新调用参数，
 * 无 replaced）；不同 owner → replaced（旧记录随返回值上浮）；epoch ≤ 高水位 → 陈旧丢弃。
 */
export function openPluginModal(req: PluginModalOpenRequest): ModalOpenResult {
  const epoch = req.epoch ?? highWaterEpoch + 1
  if (epoch <= highWaterEpoch) {
    return { applied: false, notApplied: 'stale-epoch' }
  }
  const prev = currentSlot.value
  const record: PluginModalSlotRecord = {
    pluginId: req.pluginId,
    modalId: req.modalId,
    sessionId: req.sessionId,
    epoch,
    title: req.title,
    width: req.width,
  }
  highWaterEpoch = epoch
  currentSlot.value = record
  if (prev && (prev.pluginId !== req.pluginId || prev.modalId !== req.modalId)) {
    return { applied: true, outcome: 'replaced', record, replaced: prev }
  }
  return { applied: true, outcome: prev ? 'reopened' : 'opened', record }
}

/**
 * 关闭：三元组 (pluginId, modalId, epoch) 与当前槽全匹配才生效（槽清空）；
 * 陈旧 epoch / owner 不匹配 / 槽未开（closed 后再 close 的幂等面）→ not-applied 且槽不变。
 */
export function closePluginModal(
  pluginId: string,
  modalId: string,
  epoch: number,
  reason: PluginModalClosedReason = 'dismissed',
): ModalCloseResult {
  const owner = currentSlot.value
  if (!owner) return { applied: false, notApplied: 'not-open' }
  if (owner.pluginId !== pluginId || owner.modalId !== modalId) {
    return { applied: false, notApplied: 'owner-mismatch' }
  }
  if (owner.epoch !== epoch) return { applied: false, notApplied: 'epoch-mismatch' }
  currentSlot.value = null
  return { applied: true, closed: owner, reason }
}

/** 当前槽（未开返回 null）。 */
export function getPluginModalSlot(): PluginModalSlotRecord | null {
  return currentSlot.value
}

/**
 * 清槽（AP-1 生命周期：插件崩溃/禁用/卸载 → reason='plugin-gone'）。
 * 槽 owner 非该插件时 no-op（not-applied 可判定）。
 */
export function clearPluginModalForPlugin(pluginId: string): ModalCloseResult {
  const owner = currentSlot.value
  if (!owner) return { applied: false, notApplied: 'not-open' }
  if (owner.pluginId !== pluginId) return { applied: false, notApplied: 'owner-mismatch' }
  return closePluginModal(owner.pluginId, owner.modalId, owner.epoch, 'plugin-gone')
}

/**
 * 订阅 plugin:modalState 帧驱动槽镜像（open → openPluginModal / closed → closePluginModal）。
 * 幂等：已订阅时返回既有取消函数（防 listener 翻倍，项目规则#2）。
 * close not-applied（陈旧 epoch / owner 不匹配 / 槽未开）是设计内合法产出（AP-2 关①：
 * 忽略 + 日志），warn 留痕供陈旧帧排查，不阻断帧流。
 */
export function subscribePluginModalSlot(bus: InternalEventBus): () => void {
  if (unsubscribe) return unsubscribe
  unsubscribe = bus.on('plugin:modalState', (e) => {
    const frame = e.modalState
    if (frame.state === 'open') {
      openPluginModal({
        pluginId: frame.pluginId,
        modalId: frame.modalId,
        sessionId: frame.sessionId,
        title: frame.title,
        width: frame.width,
        epoch: frame.epoch,
      })
    } else {
      const result = closePluginModal(frame.pluginId, frame.modalId, frame.epoch, frame.reason ?? 'dismissed')
      if (!result.applied) {
        console.warn(
          `[plugin-modal-slot] close not-applied（${result.notApplied}）: pluginId=${frame.pluginId} modalId=${frame.modalId} epoch=${frame.epoch}`,
        )
      }
    }
  })
  return unsubscribe
}

/** 重置单例状态并解除帧订阅（测试隔离用）。 */
export function resetPluginModalSlot(): void {
  currentSlot.value = null
  highWaterEpoch = 0
  unsubscribe?.()
  unsubscribe = null
}
