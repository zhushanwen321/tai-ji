/**
 * fileSearchStore（core 域迁移版）—— composer `#` 文件候选的 session 级缓存（D-019 per-session）。
 *
 * 来源：packages/renderer/src/stores/fileSearch.ts（pinia setup store）迁移为纯 factory。
 * 迁移约束（IF1）：不依赖 pinia；状态/操作函数语义逐条等价；消费方自行 .value（无 pinia unwrap）。
 * 壳旧 store 已随双轨收口（D7）删除，本 factory 是 fileSearch 缓存的唯一实现。
 *
 * 职责：缓存 file.search 结果（FileNode[]），同 session 重复打开 CommandPopover 浮层
 * 不重新递归（大仓库下递归耗时）。失效由 useFileSearch.setupInvalidation 驱动
 * （watch chatStore fileChanges → invalidate，复用 useFileTree 的跨 store 编排模式）。
 *
 * 失效语义（G9）：invalidate 仅删缓存（loaded→invalidated），不主动重拉。
 * 浮层短命，下次打开（load）才重拉——这是可接受语义（浮层展示期内的文件变更
 * 不影响当前候选列表，下次打开生效）。
 *
 * domain 间禁止互相 import（与 fileTree/chat 一致）。
 */
import { ref, type Ref } from 'vue'
import type { FileNode } from '@taiji/shared'

/** Map<sessionId, T> 的 per-session 单值分桶 */
type SessionMap<T> = Map<string, T>

/**
 * 创建 file search store（纯 factory，无 pinia 依赖）。
 *
 * 返回形状与原 pinia setup store 一致（ref 原样返回）：
 * 消费方迁移时 storeToRefs 语义由显式 .value 取代。
 */
export function createFileSearchStore() {
  /** 文件候选缓存：sessionId → FileNode[]（全量递归结果） */
  const files: Ref<SessionMap<FileNode[]>> = ref(new Map())

  /** 取 session 的缓存（无则 undefined） */
  function get(sessionId: string): FileNode[] | undefined {
    return files.value.get(sessionId)
  }

  /** 写 session 缓存（load 成功后调用） */
  function set(sessionId: string, nodes: FileNode[]): void {
    files.value.set(sessionId, nodes)
  }

  /** 失效 session 缓存（fileChanges 变化时由 useFileSearch 调用，删缓存不重拉） */
  function invalidate(sessionId: string): void {
    files.value.delete(sessionId)
  }

  return { files, get, set, invalidate }
}
