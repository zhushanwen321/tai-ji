/**
 * useFileSearch —— composer `#` 文件候选的前端编排（session 级缓存 + debounce + 失效）。
 *
 * 职责（单一变化轴「composer 文件候选加载编排」）：
 * - load：缓存命中直接返回，否则调 composer.getFileCandidates + 写 store
 * - debouncedLoad：debounce 包装（300ms），防浮层快速开关/输入抖动重复请求
 * - setupInvalidation：file_changes ready 转变（经共享 helper）→ store.invalidate（G9：删缓存不重拉）
 *
 * 范式对称 useFileTree（同属 composables/features，跨 store 编排在 composable 层 watch，
 * stores 间禁止 import）。
 *
 * 依赖方向：useFileSearch → fileSearchStore（core 单例壳适配，D7 收口）+ api/composer + chatStore（watch only）。
 */
import type { Ref } from 'vue'
import { useFileSearchStore } from '@/composables/features/search/useFileSearchStore'
import { composer as composerApi } from '@/api'
import { watchFileChangesForInvalidation } from '@/composables/features/file-tree/useFileChangeInvalidation'
import type { FileNode } from '@taiji/shared'

/** debounce 延迟（ms），防浮层开关/输入抖动重复触发全量递归 */
const DEBOUNCE_MS = 300

export function useFileSearch() {
  const store = useFileSearchStore()

  /**
   * 加载 session 的文件候选（缓存优先）。
   * - 缓存命中 → 直接返回（不重新递归）
   * - 未缓存 → 调 composer.getFileCandidates（file.search）+ 写 store
   * @returns FileNode[]（缓存或新拉取；失败返回空数组，不抛——浮层降级为空态）
   */
  async function load(sessionId: string): Promise<FileNode[]> {
    const cached = store.get(sessionId)
    if (cached) return cached
    try {
      const nodes = await composerApi.getFileCandidates(sessionId)
      store.set(sessionId, nodes)
      return nodes
    } catch {
      // file.search 失败（session 不存在/transport 断连）→ 降级空数组，浮层显空态
      // 不缓存失败结果（下次 load 仍尝试），不抛（CommandPopover.loadCandidates 用 allSettled）
      return []
    }
  }

  /** debounce 包装的 load（防抖动重复请求）。返回 cancel 函数（组件卸载时调） */
  function debouncedLoad(sessionId: string, onResult: (nodes: FileNode[]) => void): () => void {
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      void load(sessionId).then(onResult)
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }

  /**
   * 跨 store 失效编排（G9）：file_changes ready 转变（共享 helper 扫尾部消息 changeSetStatus）
   * → store.invalidate（删缓存，不重拉）。
   *
   * 共享触发 + ready 扫描逻辑在 useFileChangeInvalidation（W19/D-9 改 ready 帧驱动，与
   * useFileTree 共用）。此处仅表达 fileSearch 的全量语义——只要有新 ready 清单就以 sid
   * 整体失效缓存，下次 load 重拉。
   *
   * @param sessionIdRef session id 的 ref（变化时重订阅）
   * @returns unwatch 函数（组件 onBeforeUnmount 调用，避免泄漏）
   */
  function setupInvalidation(sessionIdRef: Ref<string>): () => void {
    return watchFileChangesForInvalidation(sessionIdRef, (sid) => {
      store.invalidate(sid)
    })
  }

  return { load, debouncedLoad, setupInvalidation }
}
