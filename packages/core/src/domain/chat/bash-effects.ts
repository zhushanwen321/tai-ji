/**
 * Bash 执行相关 message effect（composer-bash-execute W3 → W1 fix-chat-flow-order entry 化）。
 *
 * 从 chat-message-effects.ts 巨石提取（超 500 行 ESLint max-lines）。
 *
 * [W1 fix-chat-flow-order D2] bash live 入流全走 applyEntryFrame（reducer 唯一入流通道），
 * 镜像 pi recordBashResult 双分支（streaming 缓存到级联末 / 空闲立即——dispatcher 侧延迟，
 * 本文件只消费帧）：
 * - message.bashStart：不再创建 messages 数组项——写 per-session ephemeral 执行态
 *   executingBash（Map 分区槽；不进 messages、不持久化）。执行期间的「实时可见」由该
 *   ephemeral 态承担（MessageStream 瞬时执行行），run 结束后 bashExecution entry 作
 *   turn 内 notice 承担持久语义——规则 9 双通路以此分工（设计 D2 张力声明）。
 * - message.bashResult（dispatcher 双分支延迟或立即发布）：构造 bashExecution message
 *   entry（形态对照 apply-entry.ts bashExecution case 消费的 PiEntry 结构）→
 *   applyEntryFrameWithOverlay 骨架（喂 per-session reducer state + overlay 投影 + commit，
 *   effects/entry-overlay.ts——[u6.2 D13 联动] 从本文件与 registry 三处 effect 内联收敛）。
 *
 * 探针 ①（0.84.1 dist 实测，excludeFromContext bash 是否写 session entry）：**写**。
 * recordBashResult 对 exclude 无分支（agent-session.js:2225-2248，excludeFromContext 只是
 * bashMessage 的字段 :2235），streaming/idle 两分支都经 sessionManager.appendMessage
 * 无条件落盘（session-manager.js:766-776 无过滤）；abort 也落盘（bash-executor.js:86-109
 * abort 返回 cancelled 结果而非 throw → recordBashResult 照跑）。故该类 bash 与普通 bash
 * 同路径 entry 化，无需 liveOnly 例外（liveOnly 标记归 stream_warn，W3 wave）。
 *
 * 与 toolCall 互斥（bash 不走工具链，不挂 assistant turn，作独立 system 消息穿插渲染）。
 */
// type-only import：编译期擦除，不构成运行时循环依赖（主文件 runtime import 本文件的 handler 值）
import type { Message, ServerMessage } from '@xyz-agent/shared'
import type { PiMessageEntry } from '@xyz-agent/shared'
import type { MessageEffectContext, MessageEffectHandler } from './effect-types'
import { readString, readNumber, readBool } from './readers'
import { commitMessages, type MessagesRef } from './mutations'
import { applyEntryFrameWithOverlay } from './effects/entry-overlay'
import { shallowRef } from 'vue'

/** payload 读取用宽松 record（与主文件其他 effect 一致，readers 安全窄化） */
type Payload = Record<string, unknown>

// ── executingBash：per-session ephemeral 执行态（W1 fix-chat-flow-order）──────────
//
// ADR-0049 Map 分区范式：per-session 槽，跨 session 不串扰。归属定案（D3 closure，
// conversation-turn-attribution-closure）：形态保留 bash-effects 模块级分区 Map——store 是
// factory 模式（createChatStore，renderer 经 pinia 包装），渲染层 getExecutingBash 是模块级
// import（MessageStream computed 直调），迁入 store 实例会迫使读方改走 pinia 解包（超出
// 「读方签名不变」约束）；架构目标以「cleanup 编排可达」达成——store.disposeSession 同点
// 调 clearExecutingBash（session 删除无残留，与 messages 分区同编排清理）。
// 不进 messages、不持久化（live 瞬时态）。
// 唯一写方（成对保证）：bashStartEffect 置 / bashResultEffect 清 / markBashError 清
// （abortBash RPC 失败的前端兜底错误路径）。

/** 执行中 bash 的最小瞬时态（渲染「命令 + 转圈」行用）。 */
export interface ExecutingBash {
  command: string
  startedAt: number
}

/**
 * per-session 执行态分区（shallowRef 整体替换保响应式；读方 = 渲染层/测试）。
 * taste:allow-no-data-owner W24-EX-B（已落定非草稿）：bash 执行中瞬时反馈态（非任何数据源
 * 的缓存投影——唯一事实来源就是 bashStart/bashResult 帧本身，终态即清、不持久化）；
 * 生命周期挂接 store.disposeSession 统一 cleanup 编排（D3 closure，见文件头注释）。
 * 2026-09-14 内存审计复核：量级维持可控，维持不治裁决（docs/design/memory-leak-remediation.md §2.5）
 * （防翻案锚：断连残留裁决曾翻案过一次，见 §2.5 executingBash 行与重审条件）
 */
const executingBashMap = shallowRef(new Map<string, ExecutingBash>())

/** 读指定 session 的执行中 bash（无则 undefined）。渲染层（MessageStream 瞬时执行行）消费。 */
export function getExecutingBash(sessionId: string): ExecutingBash | undefined {
  return executingBashMap.value.get(sessionId)
}

function setExecutingBash(sessionId: string, state: ExecutingBash): void {
  executingBashMap.value = new Map(executingBashMap.value).set(sessionId, state)
}

/** 清指定 session 执行态（幂等）。写方三腿 + store.disposeSession cleanup 编排共四处调用。 */
export function clearExecutingBash(sessionId: string): void {
  if (!executingBashMap.value.has(sessionId)) return
  const next = new Map(executingBashMap.value)
  next.delete(sessionId)
  executingBashMap.value = next
}

/**
 * [S7 PR#116 review] 找到 messages 里最后一条 streaming bash 消息的索引（无则 -1）。
 *
 * [W1 fix-chat-flow-order] bashStart 不再创建消息后，正常流转中不会再有 streaming bash
 * 消息（bashExecution entry 恒 status:'complete'）；保留本函数供 markBashError 的既有
 * 调用契约（手动注入 streaming bash 消息的种子场景仍可定位）。
 *
 * 判定条件：`m.bashExecution`（bash 消息标志）+ `status === 'streaming'`。
 */
export function findLastStreamingBashIndex(messages: Message[], sessionId?: string): number {
  // sessionId 仅作日志/可读性占位，定位靠 messages 内容（与原三处实现一致）。
  void sessionId
  // [Q1-9] 倒序 for 替代 [...messages].reverse().findIndex（免数组拷贝 + 反转，语义等价：
  // 反向首个匹配 = 原数组最后一个匹配）。
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.bashExecution && m.status === 'streaming') return i
  }
  return -1
}

/**
 * message.bashStart：写 per-session ephemeral 执行态（executingBash），不建 messages 项。
 *
 * [W1 fix-chat-flow-order D2] 执行中反馈 ephemeral 化——bashStart 帧保留（dispatcher 照发），
 * 但不再直插消息数组（原直插是「重开前后 bash 位置分叉」的 live 侧根源之一）；执行态由
 * bashResult 到达（或错误路径 markBashError）清除，成对保证无残留 spinner。
 */
export const bashStartEffect: MessageEffectHandler = (_ctx: MessageEffectContext, sid: string, payload: Payload) => {
  const command = readString(payload, 'command') ?? ''
  setExecutingBash(sid, { command, startedAt: readNumber(payload, 'timestamp') ?? Date.now() })
}

/**
 * message.bashResult：构造 bashExecution message entry → applyEntryFrame（reducer 唯一
 * 入流通道）+ overlay 投影 commit（customStart 同款范式）。
 *
 * dispatcher 的双分支（streaming 待落列延迟到 agent_settled / 空闲立即）保证本帧到达时序
 * 构造性等于 pi 落盘时序——本 handler 无论延迟或立即到达都走同一条 entry 化路径。
 */
export const bashResultEffect: MessageEffectHandler = (ctx: MessageEffectContext, sid: string, payload: Payload) => {
  const command = readString(payload, 'command') ?? ''
  const cancelled = readBool(payload, 'cancelled')
  // abortBash 合成哨兵帧（command:'' + cancelled:true，dispatcher.abortBash 兜底广播，
  // 见 message-dispatcher abortBash）：无文件对应物，只清 executingBash，不产 entry。
  // [D1 closure] 正常 abort 路径 live/file 已一致：sendBash await 返回的真实 cancelled 结果
  // 照常发布并 entry 化（与 pi recordBashResult 落盘同位同值，原「live/file 分歧」例外①
  // 消灭）。command === '' 独占哨兵形态是结构性不变式（dispatcher sendBash 入口空命令
  // 早退守卫保证，r3 审查补）——真实帧 command 恒非空，两类帧永不混淆。
  // 收窄例外（仅剩场景）：sendBash catch 分支（transport 抛错，无真实数据可发布）跳过
  // 发布，live 无 cancelled entry 而 pi 进程独立落盘有——触发条件「abort 且 transport
  // 抛错」，登记 data-source-registry #7。
  if (command === '' && cancelled) {
    clearExecutingBash(sid)
    return
  }
  const ts = readNumber(payload, 'timestamp') ?? Date.now()
  const fullOutputPath = readString(payload, 'fullOutputPath')
  // entry 形态对齐 apply-entry.ts bashExecution case 消费的 PiMessageEntry（探针 ①：
  // excludeFromContext bash 仍写 entry，与普通 bash 同路径——见文件头注释）。timestamp 双写
  // （entry ISO + message ms，同源）镜像 pi 持久化形态；id 客户端生成（customStart 同款
  // 先例）：reducer 从 entry.id 派生，overlay 投影与 reducer state 同 id（重开侧为 pi
  // uuidv7 entry id——id 值异源属 W21 已裁决的 live/reload 差异类）。
  const entry: PiMessageEntry = {
    type: 'message',
    id: `bash-${crypto.randomUUID()}`,
    parentId: null,
    timestamp: new Date(ts).toISOString(),
    message: {
      role: 'bashExecution',
      command,
      output: readString(payload, 'output') ?? '',
      exitCode: readNumber(payload, 'exitCode') ?? null,
      cancelled,
      truncated: readBool(payload, 'truncated'),
      excludeFromContext: readBool(payload, 'excludeFromContext'),
      timestamp: ts,
      ...(fullOutputPath !== undefined && { fullOutputPath }),
    },
  }
  // 权威喂入 + overlay 投影 + commit（骨架 helper）：bashExecution 投影不依赖前置
  // state（apply-entry bashExecution case 无条件 append），空 state 派生即本条消息。
  applyEntryFrameWithOverlay(ctx, sid, entry)
  // 终态到达清执行态（与 bashStartEffect 置位成对）
  clearExecutingBash(sid)
}

/** 供 messageEffects 表展开的类型化入口 */
export const bashEffects: Partial<Record<ServerMessage['type'], MessageEffectHandler>> = {
  'message.bashStart': bashStartEffect,
  'message.bashResult': bashResultEffect,
}

/**
 * W2：abortBash RPC 失败时，主动将 streaming bash 消息推到 error 态。
 * bashResult 广播依赖 abortBash RPC 成功，失败时该广播不会到达，
 * bash 消息会永久卡在 streaming。此方法在 useChat.abortBash catch 中调用兜底。
 *
 * [W1 fix-chat-flow-order] entry 化后正常流转无 streaming bash 消息（消息查找分支退化为
 * 手动种子场景防御），本方法的主职责收敛为清 executingBash（abortBash RPC 失败时无任何
 * bashResult 帧到达，执行态会永久残留——此为唯一兜底清点）。
 *
 * 导出为独立函数（非 effect handler），由 useChat 直接调用。
 *
 * [B2 PR#116 review] 调用方必须传入 store 真正的 messages ref（storeToRefs(chat).messages），
 * 不可传 `{ value: chat.messages }` 这样的 plain wrapper——后者只改写临时对象的 .value，
 * store 真正的 shallowRef 不会被更新（catch 形同虚设）。
 */
export function markBashError(
  messages: MessagesRef,
  sessionId: string,
  errorText: string,
): void {
  // 错误路径清执行态（写方成对保证的第三腿：bashStart 置 / bashResult 清 / 此处兜底清）
  clearExecutingBash(sessionId)
  const prev = messages.value.get(sessionId)?.value ?? []
  // [S7] 复用 findLastStreamingBashIndex（手动注入 streaming bash 消息的种子场景防御）。
  const realIdx = findLastStreamingBashIndex(prev, sessionId)
  if (realIdx === -1) return
  const next = prev.map((m, i) => i === realIdx ? {
    ...m,
    status: 'error' as const,
    error: errorText,
    bashExecution: { ...m.bashExecution!, cancelled: true },
  } : m)
  commitMessages(messages, sessionId, next)
}
