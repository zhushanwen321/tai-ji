/**
 * file-search —— composer `#` 文件候选的前端编排（core 域迁移版，IF6）。
 *
 * [归位] 迁自 renderer composables/features/useFileSearch.ts，语义等价。
 * composerApi.getFileCandidates 经 FileCandidatesPort 注入（AC-4.5）。
 *
 * 职责（单一变化轴「composer 文件候选加载编排」）：
 * - load：直调 fileCandidates（file.search），失败降级空数组（不抛——浮层降级为空态）
 * - debouncedLoad：debounce 包装（300ms），防浮层快速开关/输入抖动重复请求
 *
 * 无缓存直读（缓存治理 U1 1-3 裁决）：session 级候选缓存（原 fileSearchStore）退役——
 * 外部建/删文件无 fileChange 帧时缓存永陈旧，失效链（watchFileChanges 端口订阅 +
 * setupInvalidation 编排）随之整体拆除；文件树/搜索是低频操作，每次现跑 file.search
 * RPC（runtime 侧 fd 式递归同 tui 对照形态）。
 *
 * 依赖方向：注入端口（fileCandidates）。
 */
import type { FileNode } from '@taiji/shared'
import type { FileCandidatesPort } from './search-ports'

/** debounce 延迟（ms），防浮层开关/输入抖动重复触发全量递归 */
const DEBOUNCE_MS = 300

export interface FileSearchDeps {
  /** composer `#` 文件候选拉取（AC-4.5 直调） */
  fileCandidates: FileCandidatesPort['getFileCandidates']
}

export function useFileSearch(deps: FileSearchDeps) {
  /** 在飞 debounce timer（闭包级单实例，真防抖合并连续调用） */
  let pendingTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * 加载 session 的文件候选（每次现拉，无缓存）。
   * @returns FileNode[]（新拉取；失败返回空数组，不抛——调用方用 allSettled）
   */
  async function load(sessionId: string): Promise<FileNode[]> {
    try {
      return await deps.fileCandidates(sessionId)
    } catch {
      // file.search 失败（session 不存在/transport 断连）→ 降级空数组，浮层显空态，不抛
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
