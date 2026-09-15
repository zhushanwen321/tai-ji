/**
 * file-search —— composer `#` 文件候选的前端编排（core 域迁移版，IF6）。
 *
 * [归位] 迁自 renderer composables/features/useFileSearch.ts（72 行），语义逐条等价。
 * C-W3-3：setupInvalidation 内部对 chatStore.messages 的 watch 改经注入的
 * FileChangeWatchPort.watchFileChanges（core 不 import chat store，D4 铁律）。
 * composerApi.getFileCandidates 经 FileCandidatesPort 注入（AC-4.5）。
 *
 * 职责（单一变化轴「composer 文件候选加载编排」）：
 * - load：缓存命中直接返回，否则调 fileCandidates + 写 store
 * - debouncedLoad：debounce 包装（300ms），防浮层快速开关/输入抖动重复请求
 * - setupInvalidation：watch 文件变更（端口）→ store.invalidate（G9：删缓存不重拉）
 *
 * 依赖方向：fileSearchStore + 注入端口（fileCandidates/watchFileChanges）。
 */
import { watch, type Ref } from 'vue'
import type { FileNode } from '@taiji/shared'
import type { FileCandidatesPort, FileChangeWatchPort } from './search-ports'
import type { createFileSearchStore } from './file-search-store'

/** debounce 延迟（ms），防浮层开关/输入抖动重复触发全量递归 */
const DEBOUNCE_MS = 300

export interface FileSearchDeps {
  fileSearchStore: ReturnType<typeof createFileSearchStore>
  /** composer `#` 文件候选拉取（AC-4.5 直调） */
  fileCandidates: FileCandidatesPort['getFileCandidates']
  /** 文件变更 watch（C-W3-3 替代 chatStore.messages watch） */
  watchFileChanges: FileChangeWatchPort['watchFileChanges']
}

export function useFileSearch(deps: FileSearchDeps) {
  const { fileSearchStore } = deps

  /**
   * 加载 session 的文件候选（缓存优先）。
   * - 缓存命中 → 直接返回（不重新递归）
   * - 未缓存 → 调 fileCandidates（file.search）+ 写 store
   * @returns FileNode[]（缓存或新拉取；失败返回空数组，不抛——浮层降级为空态）
   */
  async function load(sessionId: string): Promise<FileNode[]> {
    const cached = fileSearchStore.get(sessionId)
    if (cached) return cached
    try {
      const nodes = await deps.fileCandidates(sessionId)
      fileSearchStore.set(sessionId, nodes)
      return nodes
    } catch {
      // file.search 失败（session 不存在/transport 断连）→ 降级空数组，浮层显空态
      // 不缓存失败结果（下次 load 仍尝试），不抛（调用方用 allSettled）
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
   * 跨 store 失效编排（G9）：文件变更（端口 watch）→ store.invalidate（删缓存，不重拉）。
   *
   * @param sessionIdRef session id 的 ref（变化时重订阅）
   * @returns unwatch 函数（组件 onBeforeUnmount 调用，避免泄漏）
   */
  function setupInvalidation(sessionIdRef: Ref<string>): () => void {
    let unwatch: (() => void) | undefined
    const stopSidWatch = watch(
      () => sessionIdRef.value,
      (sid) => {
        if (unwatch) unwatch()
        if (sid) {
          unwatch = deps.watchFileChanges(sid, (s) => {
            fileSearchStore.invalidate(s)
          })
        }
      },
      { immediate: true },
    )
    return () => {
      if (unwatch) unwatch()
      stopSidWatch()
    }
  }

  return { load, debouncedLoad, setupInvalidation }
}
