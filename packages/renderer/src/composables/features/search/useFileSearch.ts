/**
 * useFileSearch —— composer `#` 文件候选的前端编排（直读 + debounce）。
 *
 * 职责（单一变化轴「composer 文件候选加载编排」）：
 * - load：直调 composer.getFileCandidates（file.search），失败降级空数组
 * - debouncedLoad：debounce 包装（300ms），防浮层快速开关/输入抖动重复请求
 *
 * 无缓存直读（缓存治理 U1 1-3 裁决）：session 级候选缓存（原 fileSearchStore 壳单例）
 * 退役——外部建/删文件无 fileChange 帧时缓存永陈旧，失效链（setupInvalidation 订阅
 * file_changes ready 帧 → invalidate）随之整体拆除；文件树/搜索是低频操作，每次现拉。
 *
 * 范式对称 useFileTree（同属 composables/features）。
 *
 * 依赖方向：useFileSearch → api/composer。
 */
import { composer as composerApi } from '@/api'
import type { FileNode } from '@taiji/shared'

/** debounce 延迟（ms），防浮层开关/输入抖动重复触发全量递归 */
const DEBOUNCE_MS = 300

export function useFileSearch() {
  /** 在飞 debounce timer（闭包级单实例，真防抖合并连续调用） */
  let pendingTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * 加载 session 的文件候选（每次现拉，无缓存）。
   * @returns FileNode[]（新拉取；失败返回空数组，不抛——CommandPopover.loadCandidates 用 allSettled）
   */
  async function load(sessionId: string): Promise<FileNode[]> {
    try {
      return await composerApi.getFileCandidates(sessionId)
    } catch (e: unknown) {
      // file.search 失败（session 不存在/transport 断连）→ 降级空数组，浮层显空态，不抛。
      // RD-5#3：降级本身正确，但必须留痕——静默 return [] 会让「候选为空」与
      // 「后端挂了」不可分（红线 1：catch/丢弃后无日志无标记）。
      console.warn(`[fileSearch] load 失败降级为空候选: sid=${sessionId}`, e)
      return []
    }
  }

  /**
   * debounce 包装的 load（真防抖：连续调用合并，新调用清旧 timer——原形态每次独立建
   * timer，防重靠缓存命中隐式达成，缓存退役后改为显式合并）。返回 cancel 函数（组件卸载时调）。
   */
  function debouncedLoad(sessionId: string, onResult: (nodes: FileNode[]) => void): () => void {
    if (pendingTimer) clearTimeout(pendingTimer)
    pendingTimer = setTimeout(() => {
      pendingTimer = undefined
      void load(sessionId).then(onResult)
    }, DEBOUNCE_MS)
    return () => {
      if (pendingTimer) {
        clearTimeout(pendingTimer)
        pendingTimer = undefined
      }
    }
  }

  return { load, debouncedLoad }
}
