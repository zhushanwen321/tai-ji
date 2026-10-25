/**
 * message_end(assistant) 定稿权威重建与迟到帧锚定（chat-flow-consistency D3 + C1/C2）。
 *
 * 独立成文件的对齐先例 = effects/entry-overlay.ts / user-delivery.ts（registry 注册表的
 * 配套 helper 模块化，注册表本体只留 handler 接线）。
 *
 * 三件事：
 * - rebuildAssistantOnFinalize：message_end(assistant) 按载荷整条重建气泡（权威转换复用
 *   apply-entry-convert 的 collectContentParts / usageField——live ≡ reload 构造性保持），
 *   textFinalized 标记与重建共用同一次定位（C2 统一）。
 * - locateToolCallHost：tool_call_start 的属主定位三级次序（C1，迟到帧错挂新回合根治）。
 * - 两个 dev warn：C2 顺序不变量断言 / D3 补建留痕（各见函数注释）。
 */
import type { Message, PiMessageEntry, ThinkingBlock, ToolCall } from '@taiji/shared'
// [chat-flow-consistency D3] live 定稿重建复用 reload 侧权威转换（collectContentParts /
// usageField 导出共享——「live ≡ reload」构造性保持）
import { collectContentParts, normalizeContentParts, usageField } from '../apply-entry-convert'
import { toMs } from '../apply-entry-utils'
import { findLastAssistantIndex, findToolCallOwner } from '../chunk-processor'
import { commitMessages } from '../mutations'
import type { MessageEffectContext } from '../effect-types'
import { isDevMode } from '../../../platform/dev-mode'

/**
 * [chat-flow-consistency D3] message_end(assistant) 定稿权威重建（C2 textFinalized 统一落点）。
 *
 * 权威语义：entry 载荷（content parts 数组 + usage + 时间戳）是该消息内容的权威——随消息
 * 到达的内存数据，零读开销。本函数按载荷整条重建该气泡的 contentBlocks / thinking /
 * toolCalls / content / usage / endedAt，与重开路径共用同一转换函数
 * （apply-entry-convert 的 collectContentParts / usageField——「live ≡ reload」构造性保持）。
 * 重复思考在定稿时刻被重建消除（载荷只有一份思考条目 → 重建后只有一个思考块）。
 *
 * 定位：id 锚定优先、位置兜底（§6 呈报 1 采纳的升级）——帧级 messageId 是 interpreter
 * currentMessageId（runtime a-uuid，与 live 气泡 id 同一 id 空间，构造性可匹配）；锚点
 * 缺失（旧 runtime / 异常帧）时回退末条 streaming assistant 位置定位（行为与升级前一致）。
 * 不做 sealed 丢弃：已收尾成中断态的气泡，权威载荷到达时按载荷覆写（status 复原 complete，
 * error 文案退役——中断呈现是传输层事故的临时态；isInterrupted 是用户主动中止的事实标记，
 * 保留）。
 *
 * 关联不变量（D3 规则 4）：重建产物的 contentBlocks 引用 id 与思考/工具对象 id 一一对应
 * ——逐条 join 复用现有对象（保折叠态 / startTime / 已回填输出），未命中的载荷条目补建
 * 对象（不静默丢块），dev 下 warn 留痕。思考块实时 id 与载荷派生 id 不同源（pi thinking
 * part 无 id，实时 id 是 thinkingId 帧值或随机）——思考 join 的 id 匹配构造性恒 miss，
 * 生效路径是序位兜底；工具 join 的 id 匹配有效（pi content block id 与
 * tool_execution_start.toolCallId 同值，event-adapter 已核实）。
 *
 * textFinalized（C2 统一）：本函数是 textFinalized 的唯一写入点，标记与重建共用同一次
 * 定位——两者目标恒一致，消除此前「喂 reducer 前单独位置扫描」与重建定位的顺序前提重复。
 *
 * 顺序不变量（C2 dev 断言）：message.* 非工具帧保持 pi 事件序同步投递（翻译全程无
 * hook await，唯一异步后置 = tool-call-start/end 的 hook 改写，event-interpreter
 * handleToolCallStart/End）——末条 streaming assistant 在场时，锚定命中位置应恒等于它；
 * 不一致即契约破坏信号（未来若给 message_end 接异步翻译点会第一时间显形），warn 不阻断
 * （损害被限定为「同气泡错挂」，与 D3 错挂降级声明同构）。末条 streaming assistant 不在
 * 场（断连收尾后锚定命中已终态气泡）是 D3 规则 1 声明的合法迟到定稿覆写，不触发断言。
 */
export function rebuildAssistantOnFinalize(
  ctx: Pick<MessageEffectContext, 'messages'>,
  sid: string,
  entry: PiMessageEntry,
  anchorMessageId: string | undefined,
): void {
  const prev = ctx.messages.value.get(sid)?.value ?? []
  // 定位：id 锚定优先（含已终态气泡——不做 sealed 丢弃，见函数头）；位置兜底 = 末条
  // streaming assistant（无则 no-op，对齐升级前 markStreamingAssistantTextFinalized 的空态行为）。
  let idx = -1
  if (anchorMessageId !== undefined) {
    idx = prev.findIndex((m) => m.id === anchorMessageId && m.role === 'assistant')
  }
  let fallbackIdx = -1
  for (let i = prev.length - 1; i >= 0; i--) {
    const m = prev[i]
    if (m?.role === 'assistant' && m.status === 'streaming') {
      fallbackIdx = i
      break
    }
  }
  if (idx < 0) {
    idx = fallbackIdx
    if (idx < 0) return
  } else if (fallbackIdx >= 0 && idx !== fallbackIdx && isDevMode()) {
    // C2 顺序不变量 dev 断言：锚定命中 ≠ 末条 streaming assistant = 帧序契约破坏信号。
    // fallbackIdx < 0（断连收尾后已无 streaming 气泡）时锚定命中已终态气泡属 D3 规则 1
    // 声明的合法迟到定稿覆写，不算契约破坏，不 warn。
    console.warn(
      `[effects] message_end(assistant) anchor/position mismatch (sid=${sid}, anchorIdx=${idx}, lastStreamingIdx=${fallbackIdx})` +
        ' — message.* frame order contract broken (async translation point added?); rebuild follows the anchor',
    )
  }
  const target = prev[idx]
  const body = entry.message
  // 权威转换：与 reload 侧同一 collectContentParts（baseId 用气泡自身 id——重建不改气泡 id，
  // 派生 thinking/toolCall id 只要求与 contentBlocks 引用一一对应，同一命名空间内自洽）。
  const acc = collectContentParts(normalizeContentParts(body), target.id, body, target.timestamp)
  // join 复用：保 live 状态（thinking 折叠态/起止时刻、toolCall startTime/已回填输出与终态）
  const prevThinking = target.thinking ?? []
  const rebuiltThinking: ThinkingBlock[] = acc.thinking.map((derived, i) => {
    const existing = prevThinking[i]
    return existing ? { ...existing, id: derived.id, content: derived.content } : derived
  })
  const prevToolCalls = target.toolCalls ?? []
  let rebuiltCount = 0
  const rebuiltToolCalls: ToolCall[] = acc.toolCalls.map((derived, i) => {
    const existing = prevToolCalls.find((t) => t.id === derived.id) ?? prevToolCalls[i]
    if (existing) return { ...existing, id: derived.id, toolName: derived.toolName, input: derived.input }
    rebuiltCount++
    // 补建条目置 running：工具执行严格晚于所属 message_end（pi 事件序），载荷工具条目在
    // 重建时刻其执行开始消息尚未到达；随后 tool_call_start 的同 id 幂等检查按 running 接管。
    return { ...derived, status: 'running' }
  })
  if (rebuiltCount > 0 && isDevMode()) {
    console.warn(
      `[effects] D3 rebuild backfilled ${rebuiltCount} payload item(s) without live counterpart (sid=${sid}, msg=${target.id})` +
        ' — delta/stream events missed them; authority restored from entry payload',
    )
  }
  const usage = usageField(body).usage
  // endedAt = entry 落盘时刻（handleMessageEnd 以 body.timestamp 构造，与 reload 侧
  // applyEntryEndTimes 同源）；toMs 对畸形值降级 0——0 会以 nullish 穿透消费侧 ?? 回退，
  // 非 >0 不写（保持回退 timestamp 的既有缺省行为）。
  const entryMs = toMs(entry.timestamp)
  // 中断呈现随载荷覆写退役：error 文案（断连兜底）与载荷全文并存会双显；status 按规则 2
  // 正常路径不动（streaming 保持到回合末尾统一收尾——sealed guard 依赖）。
  const restored = target.status === 'streaming' ? target : { ...target, error: undefined }
  const rebuilt: Message = {
    ...restored,
    // status：规则 2 正常路径不动（streaming 保持——sealed guard 与后续消息定位依赖）；
    // 已终态（断连收尾的中断态）复原 complete（中断呈现是传输层事故的临时态，规则 1）。
    status: target.status === 'streaming' ? 'streaming' : 'complete',
    content: acc.textContent,
    contentBlocks: acc.contentBlocks,
    // 载荷无对应内容时显式清 undefined：重建是权威整条覆写，delta 阶段的残留（协议异常
    // 形态下的 thinking/toolCalls 块）不得存活过定稿（toEqual 语义下 undefined ≡ 缺失）。
    thinking: rebuiltThinking.length > 0 ? rebuiltThinking : undefined,
    toolCalls: rebuiltToolCalls.length > 0 ? rebuiltToolCalls : undefined,
    usage,
    ...(entryMs > 0 ? { endedAt: entryMs } : {}),
    textFinalized: true,
  }
  const next = [...prev]
  next[idx] = rebuilt
  commitMessages(ctx.messages, sid, next)
}

/**
 * [chat-flow-consistency C1] tool_call_start 的属主定位三级次序（迟到帧错挂新回合气泡根治）：
 *
 * interpreter 的 tool-call hook 是异步的（tool_call_start/end 帧可后置于其后的事件帧——
 * event-interpreter handleToolCallStart/End 在 hook await 后才 send），迟到形态下末条
 * assistant 可能已是下一回合的新气泡，纯位置定位会错挂。三级：
 *
 * ① findToolCallOwner 全局 ID 锚定（倒序扫全部 assistant）——同 callId 条目已在场即命中，
 *   上层幂等更新不重插（D3 定稿重建已补建的 running 条目的正确作用域：查重必须跨气泡，
 *   不能只在定位气泡内查）；已收尾条目同样命中且保持终态不倒退（attachRunningToolCall 先例）。
 * ② entry.messageId 精确命中（锚点 = interpreter 在 hook await 之前捕获的 currentMessageId
 *   ——事件到达时刻的归属事实，不因 hook 延迟漂移）：命中 streaming assistant 即属主；
 *   属主已终态且 ① 未命中 → 丢弃 + dev warn（禁止给终态气泡复活 running 块）。
 * ③ findLastAssistantIndex 位置回退（锚点缺失的兼容路径，行为与升级前一致）。
 */
export function locateToolCallHost(prev: Message[], callId: string, anchorMessageId: string | undefined): number {
  const owner = findToolCallOwner(prev, callId)
  if (owner >= 0) return owner
  if (anchorMessageId !== undefined) {
    const idx = prev.findIndex((m) => m.id === anchorMessageId)
    if (idx >= 0) {
      const host = prev[idx]
      if (host.role === 'assistant' && host.status === 'streaming') return idx
      if (isDevMode()) {
        console.warn(
          `[effects] message.tool_call_start dropped (call=${callId}, anchor=${anchorMessageId}, host status=${host.status})` +
            ' — anchored owner already terminal and call absent: refusing to revive running block on terminal bubble',
        )
      }
      return -1
    }
  }
  return findLastAssistantIndex(prev)
}
