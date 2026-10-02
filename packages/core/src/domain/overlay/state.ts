/**
 * overlay 开合态 SSOT —— display-containers §7.1/§6.5「统一壳的开关态放 core 新模块
 * core/domain/overlay/，单例 { kind, payload } 换内容」。
 *
 * **SSOT 迁移（u-w1-core，本文件即唯一权威）**：renderer workflow-viz-overlay.ts 的
 * overlayOpen / overlayCurrent 模块级 ref 已同 PR 退役（DAG 缓存留 renderer）——
 * 开合态只保留 core 一份，禁止 core/renderer 双权威并存。Esc 编排器、AppShell 宿主、
 * view 联动（W2）都读本份；W4 多实例 tab 条到来时也是本模块加维度。
 *
 * 状态不变量（types.ts OverlayControlState 语义，closeOverlay 构造性保证）：
 * - 单例：全局一份开合态，开新内容 = 换内容（isOpen 保持 true、current 替换）；
 * - 关浮层复位：isOpen=false 时 current 置 null（§7.4 发起会话删除级联同语义）。
 */
import { computed, reactive } from 'vue'
import type { ComputedRef } from 'vue'
import type { OverlayContent, OverlayControlState } from './types'

/**
 * 浮层开合态（模块级单例，全局一份——§6.5 单例换内容）。
 * taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态，12 类未覆盖存量，登记草稿）：
 * overlay 开合态 SSOT（display-containers §7.1 迁移落点，唯一权威）
 */
const overlayState = reactive<OverlayControlState>({
  isOpen: false,
  current: null,
})

/**
 * 读取浮层开合态（reactive 单例对象本身；coordination 层与编排器读取用）。
 * 只读消费建议经 useOverlayControl()；写入只经 openOverlay / closeOverlay
 * （直写会绕过「关浮层复位」不变量）。
 */
export function getOverlayControlState(): OverlayControlState {
  return overlayState
}

/**
 * 开合态视图（响应式 computed；AppShell 宿主 / Host 容器消费）。
 */
export function useOverlayControl(): {
  isOpen: ComputedRef<boolean>
  current: ComputedRef<OverlayContent | null>
  } {
  return {
    isOpen: computed(() => overlayState.isOpen),
    current: computed(() => overlayState.current),
  }
}

/**
 * 内部写原语（coordination 层专用；业务代码用 openOverlay / closeOverlay）。
 * ⚠️ 直接调用会绕过载荷校验。
 */
export const overlayControl = {
  /** 开/换内容：写 current + isOpen=true（单例换内容语义） */
  open(content: OverlayContent): void {
    overlayState.current = content
    overlayState.isOpen = true
  },
  /** 关浮层复位：isOpen=false 且 current 置 null（不变量，S5/S10 反向断言锚） */
  close(): void {
    overlayState.isOpen = false
    overlayState.current = null
  },
}

/**
 * 清空 overlay 域状态（测试隔离用；coordination._resetOverlayForTest 组合调用）。
 * 生产代码禁止调用。
 */
export function _resetOverlayControlForTest(): void {
  overlayState.isOpen = false
  overlayState.current = null
}
