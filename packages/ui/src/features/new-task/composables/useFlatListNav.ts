/**
 * 扁平列表键盘导航 composable（R2 logic 层）。
 *
 * [w4 迁移] 自 renderer composables/logic/useFlatListNav.ts 原样迁移
 * （C-W4-3 归位 ui 包内部 features/new-task/composables/，对齐 features/chat/composables 先例）。
 * renderer 旧副本保留（w5 随旧组件删除）。
 *
 * DirSelectPopover / BranchSelectPopover 共用同一套键盘契约（spec §3.2/§3.3）：
 * 一个跨组扁平化的可选集（filtered 列表 + 尾部 N 个动作项），↑↓ 循环移动 activeIndex，
 * Enter 激活当前项，Esc 关闭。两处原为逐字复制，收敛到此。
 *
 * 设计：
 * - 导航状态（activeIndex / ↑↓ 循环 / Esc / Enter 入口）由本 composable 管理；
 * - 「激活哪一项」与「总数」随 popover 变化，经 getTotal / onActivate / onEscape 注入。
 * - 不处理 Tab 切类、跨分组跳跃（SearchModal 那种变体复杂度高，留后续单独抽象）。
 */
import { ref, type Ref } from 'vue'

/** 扁平列表导航所需配置（由调用方注入变化部分） */
export interface FlatListNavOptions {
  /** 可选项总数（filtered 列表 + 尾部动作项，响应式 getter 保证搜索过滤后即时更新） */
  getTotal: () => number
  /** Enter 时激活当前 activeIndex（调用方按索引落到列表项或动作项） */
  onActivate: (index: number) => void
  /** Esc 时回调（通常关闭 popover） */
  onEscape: () => void
}

/** 扁平列表键盘导航句柄（绑到容器 @keydown） */
export interface FlatListNav {
  /** 当前键盘焦点索引（跨组扁平化） */
  activeIndex: Ref<number>
  /** 键盘事件处理：↑↓ 循环 + Enter 派发 + Esc 回调 */
  onKeydown: (e: KeyboardEvent) => void
  /** 判断某索引是否为当前焦点项（模板高亮用） */
  isActiveItem: (index: number) => boolean
}

/**
 * 建立扁平列表键盘导航。
 *
 * ↑↓ 在 [0, total) 范围内循环（total=0 时停留在 0，不越界）；
 * Enter → onActivate(activeIndex)；Esc → onEscape。非相关键不拦截。
 */
export function useFlatListNav(options: FlatListNavOptions): FlatListNav {
  const activeIndex = ref(0)

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      options.onEscape()
      return
    }
    const total = options.getTotal()
    if (total <= 0) return // 空列表无可选项，忽略移动/激活
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      activeIndex.value = (activeIndex.value + 1) % total
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      activeIndex.value = (activeIndex.value - 1 + total) % total
    } else if (e.key === 'Enter') {
      e.preventDefault()
      options.onActivate(activeIndex.value)
    }
  }

  function isActiveItem(index: number): boolean {
    return index === activeIndex.value
  }

  return { activeIndex, onKeydown, isActiveItem }
}
