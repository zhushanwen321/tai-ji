/**
 * useForkActions —— sidebar fork 操作集合（从 useSidebar 提取，减行用）。
 *
 * 职责：fork 会话的三类入口编排（后台 fork / fork-to-ask / 末条 assistant 快捷键）。
 * 跨 api + stores 编排在此层完成（铁律 1：唯一跨 api + stores 的层）。
 *
 * 拆分原因：useSidebar 函数体超 max-lines-per-function(300)，fork 编排逻辑职责内聚，
 * 与 session CRUD / 启动编排正交，适合独立 composable。参照 useSidebarSessionActions 范式
 * （调用方注入 focusedSessionId ref，内部自行获取 stores/api）。
 */
import type { Ref } from 'vue'
import { segmentsToPrompt, textToSegments } from '@taiji/shared'
import { chat as chatApi, session as sessionApi } from '@/api'
import { useChatStore } from '@/stores/chat'
import { useSessionStore } from '@/stores/session'
import { ensureStreamSubscription, useChat } from '@/composables/features/chat/useChat'
import { triggerEnterForkMode } from '@/composables/panel/useForkModeChannel'
import { pushForkNoticeAsk } from '@/composables/effects/useForkNoticeEffect'

/**
 * Fork 操作 composable。
 *
 * @param focusedSessionId 焦点 panel 绑定的 session（来自 useSidebar，驱动 ⌘G/⌘⇧G 快捷键的 fork 源）。
 *   注入而非内部派生：focusedSessionId 是 useSidebar 的派生状态（代理 core use-session），复用避免重复定义 + 单一来源。
 */
export function useForkActions(focusedSessionId: Ref<string | null>) {
  const chat = useChatStore()
  const session = useSessionStore()
  // [W6] 顶层实例化 useChat：避免在 catch 内每次新建实例（composable 工厂模式反模式）。
  // disposeSession 用于 send 失败时清理新 session 的流式订阅 + per-session 状态。
  const { disposeSession } = useChat()

  /**
   * Fork 会话：从指定源 session 截断历史到 fork 点，新建 session（独立 pi 进程）。
   *
   * 语义（问题 6 AI 收尾 fork）：includeFrom=true → 保留到该 assistant（含），
   * openInStandby 打开另一 panel。原 session 不变。
   *
   * 实现：runtime 读源 session JSONL 按 piEntryId 截断 → 新进程 switch_session 加载。
   * 不再前端 hydrate（runtime 通过 switch_session 让 pi 加载截断历史，selectSession 的
   * getHistory 拉真实历史）。fork 需要 Message.piEntryId（文件路径读取时填充），
   * RPC 路径读取的 session 无 piEntryId 时报错提示。
   *
   * srcSessionId 显式传入：Turn 可能在非 active 的 standby panel，fork 源必须是其所在 session。
   */
  async function forkSession(
    srcSessionId: string,
    fromMessageId: string,
    opts?: { includeFrom?: boolean; openInStandby?: boolean },
  ): Promise<string> {
    // 从前端 Message.id 查到 piEntryId（runtime fork 截断定位用）
    const msgs = chat.getMessages(srcSessionId)
    const forkMsg = msgs.find((m) => m.id === fromMessageId)
    if (!forkMsg) {
      throw new Error(`fork: message ${fromMessageId} not found in session ${srcSessionId}`)
    }
    // [HISTORICAL] 2026-07-16：RPC 路径加载的 session 无 piEntryId，传 timestamp + role 让 runtime 读 JSONL 匹配
    const created = await sessionApi.fork(srcSessionId, {
      piEntryId: forkMsg.piEntryId,
      messageTimestamp: forkMsg.timestamp,
      messageRole: forkMsg.role,
      includeFrom: opts?.includeFrom,
    })
    session.appendSession(created)
    // [W2 fast-fork] 后台 fork 不切焦点：fork 后留在原线，对话流经 session.forkNotice 广播插反馈行
    // （FR-9/10），侧栏静默新增。openInStandby 选项保留为契约（调用方可能传入），但行为退化为「不切焦点」。
    return created.id
  }

  /**
   * Fork-to-Ask（FR-9/10 高频路径）：fork 新 session + 把 content 作为首条 user message 发送。
   *
   * 原子语义：
   * - fork 失败 → 不发送（forkSession 内部抛错自然短路，无占位 session 需回滚）。
   * - send 失败 → 回滚（sessionApi.remove + session.removeFromList）清理占位 session，避免悬挂空壳。
   *
   * 流式订阅：fork 成功后先 ensureStreamSubscription(newId) 建立对该新 session 事件通道的订阅，
   * 否则 pi 收到 prompt 生成的流式回复（message.*）经 events.dispatchSession(newId, msg) 路由时
   * 无订阅者被静默丢弃，agent 回复看不到。同步 appendUser + addPendingSend，与正常 send 路径一致，
   * 让用户消息经 chat store 正常显示 + pending 态填充 ack 空窗。
   *
   * 直接调 chatApi.send 而非 useChat().send：后者内部 try/catch 吞掉 send 错误（仅 toast），
   * 此处需要捕获 reject 触发回滚；其 busy→steer 路由对新 fork session 也不适用。
   * [W1] 错误反馈职责上移调用方：此处只做资源清理（disposeSession + remove + removeFromList），
   * 不 toast、不吞错——rethrow 让 handleForkSend 统一负责 toastError + restoreInput（避免草稿丢失）。
   * 主线 session 全程不参与（不写入、不 streaming、不 split）。
   */
  async function forkSessionAsk(
    srcSessionId: string,
    fromMessageId: string,
    content: string,
    staging?: { modelOverride?: string; thinkingOverride?: string },
  ): Promise<void> {
    // 解析 fork 点：尽量取 piEntryId（精确），取不到则降级传 fromMessageId（runtime 走 JSONL 兜底）。
    // 不像 forkSession 那样在消息缺失时硬抛——fork-ask 的核心有效负载是 content，fork 点缺失不应阻断。
    const forkMsg = chat.getMessages(srcSessionId).find((m) => m.id === fromMessageId)
    const created = await sessionApi.fork(srcSessionId, {
      piEntryId: forkMsg?.piEntryId,
      messageTimestamp: forkMsg?.timestamp,
      messageRole: forkMsg?.role,
      includeFrom: true,
      // Staging Mode（ADR-0056）：composer 暂存的模型覆盖，优先于源 preset。
      modelOverride: staging?.modelOverride,
      thinkingOverride: staging?.thinkingOverride,
    })
    session.appendSession(created)
    const newId = created.id
    // 空 content 守卫：不输入直接提交时退化为纯 fork（不发送首条 user），等价原 fork-background
    // （onFork）。新 session 留空放后台，由 runtime session.forkNotice 广播反馈行。
    if (!content.trim()) return
    const segments = textToSegments(content)
    const prompt = segmentsToPrompt(segments)
    // [fast-fork] 建立新 session 的流式订阅 + 写入用户消息 + 标记 pending（对齐正常 send 的前置编排，
    // 但跳过 send 的 busy→steer 检测与错误吞没）。订阅幂等：ensureStreamSubscription 已防重复。
    ensureStreamSubscription(newId, chat, session)
    chat.appendUser(newId, segments)
    chat.addPendingSend(newId)
    try {
      await chatApi.send(newId, prompt)
    } catch (e) {
      // send 失败回滚：删除占位 session（runtime + 列表），避免空壳悬挂。
      // 同步拆流式订阅 + 清 chat store 的 per-session 状态（含刚 appendUser 的消息 + pendingSend timer），
      // 否则订阅残留在模块级 Map、pendingSend timer 30s 后触发 finalizeSession 操作已删 session。
      // disposeSession 与 deleteSession 清理口径一致（取消 WS 订阅 + clearPendingSend + 清 messages）。
      // [W1] 只做资源清理，不 toast、不吞错——rethrow 让调用方 handleForkSend 统一反馈 + restoreInput。
      disposeSession(newId)
      await sessionApi.remove(newId).catch(() => {})
      session.removeFromList(newId)
      throw e
    }
    // [P2] fork + send 均成功 → 本地推送带 preview 的 ForkNotice，走 askedPrefix（"已在新分支提问"）。
    // 纯 fork（forkSession）走 runtime 广播（forkedPrefix），此处不重复推。
    // 提问内容首行作 preview（与侧栏分支标题语义一致），过长截断由渲染层处理。
    pushForkNoticeAsk(srcSessionId, newId, content.trim().split('\n')[0] || content.trim())
  }

  /**
   * 找当前焦点 session 的末条 assistant 消息（⌘G / ⌘⇧G 全局快捷键默认 fork 点）。
   * 全局快捷键无 hover 上下文，按 spec §2 层② 默认从末条 assistant fork。
   * 无焦点 session 或无 assistant 消息时返回 null（调用方静默 no-op）。
   */
  function lastAssistantOfFocused(): { sessionId: string; messageId: string } | null {
    const sid = focusedSessionId.value
    if (!sid) return null
    const msgs = chat.getMessages(sid)
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      if (msgs[i].role === 'assistant') {
        return { sessionId: sid, messageId: msgs[i].id }
      }
    }
    return null
  }

  /**
   * 从末条 assistant 后台 fork（FR-16 ⌘G）：空白 fork 新 session，留在原线。
   * 无末条 assistant 时静默 no-op（无消息可 fork）。
   */
  async function forkFromLastAssistant(): Promise<void> {
    const last = lastAssistantOfFocused()
    if (!last) return
    await forkSession(last.sessionId, last.messageId, { includeFrom: true, openInStandby: false })
  }

  /**
   * 从末条 assistant 进入 composer fork 模式（FR-16 ⌘⇧G）：
   * 经 useForkModeChannel 发 signal，Composer 监听后调自身 enterForkMode（聚焦输入框等用户键入）。
   * 无末条 assistant 时静默 no-op。
   */
  async function enterForkModeFromLastAssistant(): Promise<void> {
    const last = lastAssistantOfFocused()
    if (!last) return
    triggerEnterForkMode(last.sessionId, last.messageId)
  }

  return {
    forkSession,
    forkSessionAsk,
    forkFromLastAssistant,
    enterForkModeFromLastAssistant,
  }
}
