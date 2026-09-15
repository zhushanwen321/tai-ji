/**
 * search-modal —— SearchModal 单实例状态（core 域迁移版，IF6）。
 *
 * [归位] 迁自 renderer composables/features/useSearchModal.ts（49 行），原样迁移（C-W3-6 无端口）。
 * C-NT-6 裁决：模块级单例保持（Q2=A 全局浮层状态非 per-session，不套 useSessionScopedState——
 * SearchModal 开关是全局 UI 流程状态，同一时刻仅一个浮层，无 per-session 分区语义）。
 * resetSearchModal 保留（测试隔离用，单实例状态跨调用共享）。
 */
import { ref } from 'vue'

/** SearchModal 打开参数：可指定初始搜索词 */
export interface OpenSearchModalOptions {
  query?: string
}

// ── 模块级单实例状态（Q2=A：跨 useSearchModal() 调用共享）──
/** 浮层开关 */
// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态，12 类未覆盖存量，登记草稿）：搜索弹窗开合单例 ref（12 类未覆盖）
const isOpen = ref(false)
/** 初始/当前搜索词（打开时设置） */
// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态，12 类未覆盖存量，登记草稿）：搜索查询单例 ref（同上）
const query = ref('')

/**
 * 重置 SearchModal 单实例状态（测试隔离用）。
 * 单实例状态跨 useSearchModal() 调用共享，测试需在 beforeEach 重置避免串扰。
 */
export function resetSearchModal(): void {
  isOpen.value = false
  query.value = ''
}

export function useSearchModal() {
  /** 打开搜索浮层，可指定初始 query */
  function open(initialQuery?: string): void {
    if (initialQuery !== undefined) query.value = initialQuery
    isOpen.value = true
  }

  /** 关闭搜索浮层 */
  function close(): void {
    query.value = ''
    isOpen.value = false
  }

  /** 切换开关 */
  function toggle(): void {
    if (isOpen.value) close()
    else open()
  }

  return {
    isOpen,
    query,
    open,
    close,
    toggle,
  }
}
