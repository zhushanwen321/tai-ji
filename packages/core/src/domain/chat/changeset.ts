/**
 * FileChanges 子域（W10，ADR-0024 D5 baseline diff）—— 从 chat store 抽取的内聚模块。
 *
 * 本模块是 chat store 的一个子关注点：追踪 changeSet 的 5 态状态机
 * （accumulating/ready/partially-reviewed/resolved/superseded）、合并 incoming FileChange
 * 增量、暴露读状态。原逻辑散落在三处：
 * - chat.ts：changeSetStatuses map + applyFileChanges + markChangeSetsSuperseded
 * - chat-readers.ts：mergeFileChanges（纯函数）
 * 此处收口为一个内聚模块。
 *
 * 设计选择（option b，非 defineStore）：
 * applyFileChanges 同时写 messages（chat store 拥有）与 changeSetStatuses。若拆成独立的
 * defineStore('chat-changeset')，changeset store 要反过来改 chat store 的 messages ref，
 * 形成 chat.ts → chat-changeset → useChatStore() → chat.ts 的循环依赖，协调不干净。
 * 故采用「工厂模块」：chat store 拥有 messages ref，传入本工厂；工厂内部创建并独占
 * changeSetStatuses ref，闭包封装所有变更集逻辑。chat store 再原样透出公共 API，
 * 行为零变化。
 *
 * 纯函数 mergeFileChanges 直接 export（无状态依赖，从 chat-readers 平移至此）。
 */
import { ref } from 'vue'
import type { Ref } from 'vue'
import type { ChangeSetStatus, FileChange } from '@taiji/shared'
import { findLastAssistantIndex } from './chunk-processor'
// 相对路径直达定义处（mutations.ts）：经 '@taiji/core' barrel 回引会成环，ESM 序隐患
import { commitMessages, type MessagesRef } from './mutations'

/** 审查态集合（单向守卫内拦 ready 覆盖用）：用户交互驱动的终态，runtime 帧不得改写 */
const REVIEW_STATUSES: ReadonlySet<ChangeSetStatus> = new Set(['partially-reviewed', 'resolved', 'superseded'])

/**
 * 合并 FileChange[]（accumulating 增量合并）。同 filePath 取最新项（后者覆盖前者），
 * 保留 addLines/delLines（若新项未带则沿用旧项）。ready 帧传 [] 作 baseline 即全集替换。
 */
export function mergeFileChanges(incoming: FileChange[], baseline: FileChange[]): FileChange[] {
  const byPath = new Map<string, FileChange>()
  for (const c of baseline) byPath.set(c.filePath, c)
  for (const c of incoming) {
    const prev = byPath.get(c.filePath)
    byPath.set(c.filePath, {
      filePath: c.filePath,
      status: c.status,
      ...(c.addLines !== undefined ? { addLines: c.addLines } : prev?.addLines !== undefined ? { addLines: prev.addLines } : {}),
      ...(c.delLines !== undefined ? { delLines: c.delLines } : prev?.delLines !== undefined ? { delLines: prev.delLines } : {}),
    })
  }
  return Array.from(byPath.values())
}

/**
 * 变更集控制器（chat store 经 createChangeSetController(messages) 组合）。
 *
 * - messages：chat store 拥有并注入（applyFileChanges 据此定位目标 assistant message）。
 * - changeSetStatuses：本控制器创建并独占，记录每条变更集的状态。
 */
export interface ChangeSetController {
  /** 按 `${sessionId}:${messageId}` 分区的变更集状态表（ChangeSetCard 5 态） */
  changeSetStatuses: Ref<Map<string, ChangeSetStatus>>
  /** 取指定 message 的变更集状态（ChangeSetCard 渲染用，无则 undefined） */
  getChangeSetStatus: (sessionId: string, messageId: string) => ChangeSetStatus | undefined
  /** 设置变更集状态（用户 Accept/Reject 驱动 partially-reviewed/resolved/superseded） */
  setChangeSetStatus: (sessionId: string, messageId: string, status: ChangeSetStatus) => void
  /** 处理 runtime 推送的文件变更帧（合并 fileChanges + 记录变更集状态） */
  applyFileChanges: (
    sessionId: string,
    messageId: string,
    changes: FileChange[],
    changeSetStatus: ChangeSetStatus,
    isFullSet: boolean,
  ) => void
  /** 标记指定 session 的所有非 resolved 变更集为已过期（superseded） */
  markChangeSetsSuperseded: (sessionId: string) => void
}

/**
 * 构造变更集控制器（chat store 在 setup 内调用一次，传入其拥有的 messages ref）。
 *
 * 返回的控制器内部创建 changeSetStatuses ref，并闭包封装 get/set/apply/supersede 逻辑。
 * chat store 把返回的成员原样挂到 store 的 return 上，公共 API 与原实现完全一致。
 */
export function createChangeSetController(
  messages: MessagesRef,
): ChangeSetController {
  /** 按 `${sessionId}:${messageId}` 分区的变更集状态（W10，ChangeSetCard 5 态） */
  const changeSetStatuses = ref<Map<string, ChangeSetStatus>>(new Map())

  /** 取指定 message 的变更集状态（ChangeSetCard 渲染用，无则 undefined） */
  function getChangeSetStatus(sessionId: string, messageId: string): ChangeSetStatus | undefined {
    return changeSetStatuses.value.get(`${sessionId}:${messageId}`)
  }

  /** 设置变更集状态（用户 Accept/Reject 驱动 partially-reviewed/resolved/superseded） */
  function setChangeSetStatus(sessionId: string, messageId: string, status: ChangeSetStatus): void {
    changeSetStatuses.value = new Map(changeSetStatuses.value).set(`${sessionId}:${messageId}`, status)
  }

  /**
   * 处理 runtime 推送的文件变更帧（flow-2 FileChanges 通道，ADR-0024 D6/D7）。
   *
   * accumulating 帧（isFullSet=false）增量合并进目标 assistant message.fileChanges；
   * ready 帧（isFullSet=true）用 git 对账后的全集替换（真值收口）。
   * 同 filePath 合并、status 取最新。变更集卡 5 态状态机的审查态
   * （partially-reviewed/resolved/superseded）由前端用户交互驱动，不经此函数。
   *
   * 单向守卫（W18 纵深防御，03 D3-3；W18 review 扩展）：变更集状态只允许
   * accumulating → ready → 审查态单向推进，任何帧都不得覆盖已推进的状态。
   * runtime 侧串行 diff 链是帧序的主保证；此处防御未来任何顺序漏洞：
   * - 迟到的 accumulating 帧（目标 message 已 ready/进入审查态）整体丢弃：既不回写 status
   *   （「待审查」徽章回退「生成中」），也不合并 fileChanges（避免污染 ready 全集真值）；
   * - 迟到的 ready 帧（目标 message 已进入审查态）整体丢弃：W18 review 后 runtime 的 ready
   *   绕过 turnGen 代际守卫恒推（否则变更集卡永久停在 accumulating），迟到 ready 可能晚于
   *   用户审查操作到达——不得把已接受/已过期的卡写回「待审查」。
   */
  function applyFileChanges(
    sessionId: string,
    messageId: string,
    changes: FileChange[],
    changeSetStatus: ChangeSetStatus,
    isFullSet: boolean,
  ): void {
    // 单向守卫（见上方 applyFileChanges JSDoc）：
    // - accumulating 只能作为首帧或承接 accumulating；已推进到 ready/审查态后不再回退；
    // - ready 不覆盖审查态（partially-reviewed/resolved/superseded）；ready → ready 幂等重放放行
    //   （runtime 重推的同 messageId ready 全集，状态与数据均无害）。
    const guardKey = `${sessionId}:${messageId}`
    const prevStatus = changeSetStatuses.value.get(guardKey)
    if (changeSetStatus === 'accumulating' && prevStatus !== undefined && prevStatus !== 'accumulating') {
      return
    }
    if (changeSetStatus === 'ready' && prevStatus !== undefined && REVIEW_STATUSES.has(prevStatus)) {
      return
    }

    const prev = messages.value.get(sessionId)?.value ?? []
    if (prev.length === 0) return
    const idx = prev.findIndex((m) => m.id === messageId)
    // messageId 未命中时挂到最后一条 assistant message（防御：runtime/前端 id 偶发不一致）
    const targetIdx = idx >= 0 ? idx : findLastAssistantIndex(prev)
    if (targetIdx < 0) return

    const target = prev[targetIdx]
    // ready 全集直接替换（git 对账真值）；accumulating 增量合并（同 filePath 取最新 status/行数）
    const merged = isFullSet
      ? mergeFileChanges(changes, [])
      : mergeFileChanges(changes, target.fileChanges ?? [])

    const next = [...prev]
    next[targetIdx] = { ...target, fileChanges: merged }
    commitMessages(messages, sessionId, next)

    // 记录变更集状态（供 ChangeSetCard 渲染 5 态；guardKey 同 `${sessionId}:${messageId}`）
    changeSetStatuses.value = new Map(changeSetStatuses.value).set(guardKey, changeSetStatus)
  }

  /**
   * 标记指定 session 的所有变更集为已过期（superseded）。
   *
   * D5 重构：git.commit 成功后工作区 diff 重置，runtime 广播 message.changeSetInvalidated，
   * 前端把该 session 的非 resolved 态 changeSet 推 superseded（保留已 resolved 的历史审查记录）。
   * resolved 态不覆盖——用户已明确接受的变更不应因后续 commit 而状态丢失。
   */
  function markChangeSetsSuperseded(sessionId: string): void {
    const prefix = `${sessionId}:`
    let changed = false
    const next = new Map(changeSetStatuses.value)
    for (const [key, status] of next) {
      if (key.startsWith(prefix) && status !== 'resolved') {
        next.set(key, 'superseded')
        changed = true
      }
    }
    if (changed) changeSetStatuses.value = next
  }

  return {
    changeSetStatuses,
    getChangeSetStatus,
    setChangeSetStatus,
    applyFileChanges,
    markChangeSetsSuperseded,
  }
}
