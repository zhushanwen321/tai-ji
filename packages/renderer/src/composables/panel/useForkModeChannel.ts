/**
 * useForkModeChannel —— Composer fork 模式的跨组件触发通道（W3）。
 *
 * 背景：Composer.vue 持有 forkMode 状态真源（ref + enterForkMode/exitForkMode），
 * 但 Sidebar 全局快捷键（⌘⇧G → enterForkModeFromLastAssistant，在 useSidebar）也需要
 * 「从末条 assistant 进入 composer fork 模式」。Sidebar 无法直接拿 Composer 实例，
 * 也不应提升 forkMode 真源到 store（Composer 的发送/Esc/切 session 逻辑强耦合 forkMode ref）。
 *
 * 方案：模块级单例 signal ref。Sidebar 侧 `triggerEnterForkMode(srcSessionId, fromMessageId)`
 * 写入 signal（递增 id 避免重复值被 watch 忽略）；Composer 侧 watch signal 变化 → 调自身
 * enterForkMode。信号是「请求」语义而非「状态」语义，Composer 仍是状态真源，符合单向数据流。
 *
 * 模块级单例（非 pinia store）：通道无持久化需求、无派生计算、仅一个 signal ref，
 * 用 composable + 模块级 ref 比 store 更轻量（与 useSearchModal 的 open/close 模式一致）。
 */
import { ref } from 'vue'

/** fork 模式进入请求信号（id 递增确保每次都是新值，watch 不去重） */
interface ForkEnterRequest {
  id: number
  srcSessionId: string
  fromMessageId: string
}

/** 模块级单例 signal（跨组件树共享，同 useSearchModal 模式） */
let current: ForkEnterRequest | null = null
// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态，12 类未覆盖存量，登记草稿）：fork 进入请求 signal 单例（跨组件树共享，12 类未覆盖）
const signal = ref<ForkEnterRequest | null>(null)

/** Sidebar/全局快捷键侧调用：请求 Composer 进入 fork 模式（从指定 assistant） */
function triggerEnterForkMode(srcSessionId: string, fromMessageId: string): void {
  current = {
    id: current ? current.id + 1 : 1,
    srcSessionId,
    fromMessageId,
  }
  signal.value = current
}

/**
 * Composer 侧订阅通道：返回 signal ref，Composer watch 它变化 → 调自身 enterForkMode。
 * Sidebar 侧直接 import triggerEnterForkMode 调用（无需走 composable 实例化）。
 */
export function useForkModeChannel(): {
  signal: typeof signal
  } {
  return { signal }
}

export { triggerEnterForkMode }
