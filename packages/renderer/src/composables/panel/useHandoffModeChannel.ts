/**
 * useHandoffModeChannel —— Composer handoff 模式的跨组件触发通道（fast-handoff）。
 *
 * 背景：Composer.vue 持有 handoffMode 状态真源（ref + enterHandoffMode/exitHandoffMode），
 * 但 Sidebar 全局快捷键（⌘H → handoffFromLastAssistant，在 useSidebar）也需要
 * 「从末条 assistant 进入 composer handoff 模式」。Sidebar 无法直接拿 Composer 实例，
 * 也不应提升 handoffMode 真源到 store（Composer 的发送/Esc/切 session 逻辑强耦合 handoffMode ref）。
 *
 * 与 fork 通道（useForkModeChannel）对称独立：handoff 是 session 级语义（从末条 assistant 打包文档到新 session，
 * 无 fromMessageId 锚点——始终取末条 assistant），不复用 fork 的 srcSessionId+fromMessageId 通道。
 *
 * 方案：模块级单例 signal ref。Sidebar 侧 `triggerEnterHandoffMode(srcSessionId)`
 * 写入 signal（递增 id 避免重复值被 watch 忽略）；Composer 侧 watch signal 变化 → 调自身
 * enterHandoffMode。信号是「请求」语义而非「状态」语义，Composer 仍是状态真源，符合单向数据流。
 *
 * 模块级单例（非 pinia store）：通道无持久化需求、无派生计算、仅一个 signal ref，
 * 用 composable + 模块级 ref 比 store 更轻量（与 useForkModeChannel 模式一致）。
 */
import { ref, type Ref } from 'vue'

/** handoff 模式进入请求信号（id 递增确保每次都是新值，watch 不去重） */
interface HandoffEnterRequest {
  /** 自增 id，保证每次请求是新的 ref 值（避免同值 watch 不触发） */
  id: number
  /** 源 session id（handoff 出发的 session，始终从末条 assistant 打包） */
  srcSessionId: string
}

/** 模块级自增 id（仅用于生成递增 id，确保每次请求是新的 ref 值，watch 不去重） */
let nextId = 0
/** 模块级单例 signal（跨组件树共享，同 useForkModeChannel 模式） */
// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态，12 类未覆盖存量，登记草稿）：handoff 进入请求 signal 单例（跨组件树共享，12 类未覆盖）
const signal = ref<HandoffEnterRequest | null>(null)

/** Sidebar/全局快捷键侧调用：请求 Composer 进入 handoff 模式（从指定 session 的末条 assistant） */
function triggerEnterHandoffMode(srcSessionId: string): void {
  nextId += 1
  signal.value = { id: nextId, srcSessionId }
}

/**
 * Composer 侧订阅通道：返回 signal ref，Composer watch 它变化 → 调自身 enterHandoffMode。
 * Sidebar 侧直接 import triggerEnterHandoffMode 调用（无需走 composable 实例化）。
 */
export function useHandoffModeChannel(): {
  signal: Ref<HandoffEnterRequest | null>
  } {
  return { signal }
}

export { triggerEnterHandoffMode }
