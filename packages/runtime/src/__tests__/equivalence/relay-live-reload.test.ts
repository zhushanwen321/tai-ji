/**
 * relay live ≡ reload 等价性断言（E-4，subagent-realtime-channel.md §2.4 / §9 E-重开）。
 *
 * 不变量：同一 subagent 任务的 drawer 对话流，两条供数腿喂同一个 core reducer 产出全等 state——
 * - live 腿：真实 RelayTee（infra/relay/relay-tee.ts，生产 tee 翻译层）消费合成 child stdout
 *   字节流（pi RPC 事件 JSONL），产出的 session.subagentEntriesAppended entry 帧序列
 *   （PiToolCallEntryForm overlay 形态按 applySubagentEntries 同规则剔除，不进 reducer）
 *   → replayEntries；
 * - reload 腿：getSubagentHistory pi 直读链的转换尾段 getHistoryFromFilePath
 *   （parseJsonl + filterObjectEntries + mapSessionEntries + convertPiHistory，session-service.ts
 *   直读分支同款）→ Message[]。
 *
 * 断言形态对齐同目录 live-reload.test.ts（W21 store 级同构）——差异只在数据来源免真实 LLM：
 * 两腿 fixture 由同一逻辑会话常量派生（「同一任务」的结构性保证），stdout 事件序列 ≡ JSONL
 * 追加顺序的协议依据与主对话流相同（message_end 是持久化唯一触发点，event-adapter.ts W5 注释）。
 *
 * 归一化口径（物理差异非实现差异）：fixture JSONL entry 不写顶层 id——pi 在 emit message_end
 * **之后**才 appendMessage 分配 uuidv7（tee 侧结构性拿不到，live-reload.test.ts 因此剥 reload 侧
 * id），此处不写 id 使两腿 deriveBaseId 走同一 `e<N>` 派生；消息体 timestamp 两腿同源，
 * toolResult 回填不落时间戳字段，无其他归一点。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/equivalence/relay-live-reload.test.ts
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerMessage, PiToolCallEntryForm } from '@xyz-agent/shared'
import { subagentVirtualId } from '@xyz-agent/shared'
import { RelayTee } from '../../infra/relay/relay-tee.js'
import { getHistoryFromFilePath } from '../../services/session-history.js'
import { PiSessionStore } from '../../infra/pi/session-store.js'
import { replayEntries } from '../../../../core/src/domain/chat/apply-entry.js'
import type { PiEntry } from '../../../../core/src/domain/chat/apply-entry.js'

const MAIN_SID = 's-eq-relay-main'
const RECORD_ID = 'rec-eq-relay-1'
const VIRTUAL_ID = subagentVirtualId(MAIN_SID, RECORD_ID)

// ── 同一 subagent 任务的逻辑会话（两腿 fixture 的唯一事实源）──────────────────
//
// 两轮形态覆盖 chatMode 续聊轮（R1 根因场景）+ 工具调用全链（R2：assistant 带 toolCall →
// toolResult 回填 → 总结 assistant），usage/fileChanges 提取路径随消息体两侧同源透传。
const CONVERSATION = {
  round1: {
    user: { text: '分析这个仓库的入口文件', timestamp: 1000 },
    assistantWithTool: {
      text: '先读取入口文件',
      toolCall: { id: 'tc-eq-relay-1', name: 'read', arguments: { path: '/repo/src/main.ts' } },
      usage: { input: 120, output: 30 },
      stopReason: 'toolUse',
      timestamp: 1100,
    },
    toolResult: {
      toolCallId: 'tc-eq-relay-1',
      toolName: 'read',
      text: 'export function main() { bootstrap() }',
      isError: false,
      timestamp: 1200,
    },
    summary: {
      text: '入口是 main.ts\n导出 main 函数',
      stopReason: 'end_turn',
      timestamp: 1300,
    },
  },
  round2: {
    user: { text: '再看看测试目录', timestamp: 2000 },
    reply: { text: '测试目录包含 3 个用例文件', stopReason: 'end_turn', timestamp: 2100 },
  },
} as const

/** 逻辑会话 → pi session JSONL 行（reload 腿：SessionManager._persist 形态）。 */
function toSessionJsonlLines(): string[] {
  const c1 = CONVERSATION.round1
  const c2 = CONVERSATION.round2
  const line = (message: Record<string, unknown>): string =>
    JSON.stringify({ type: 'message', timestamp: new Date(Number(message.timestamp)).toISOString(), message })
  return [
    line({ role: 'user', content: [{ type: 'text', text: c1.user.text }], timestamp: c1.user.timestamp }),
    line({
      role: 'assistant',
      content: [
        { type: 'text', text: c1.assistantWithTool.text },
        { type: 'toolCall', ...c1.assistantWithTool.toolCall },
      ],
      usage: c1.assistantWithTool.usage,
      stopReason: c1.assistantWithTool.stopReason,
      timestamp: c1.assistantWithTool.timestamp,
    }),
    line({
      role: 'toolResult',
      toolCallId: c1.toolResult.toolCallId,
      toolName: c1.toolResult.toolName,
      content: [{ type: 'text', text: c1.toolResult.text }],
      isError: c1.toolResult.isError,
      timestamp: c1.toolResult.timestamp,
    }),
    line({
      role: 'assistant',
      content: [{ type: 'text', text: c1.summary.text }],
      stopReason: c1.summary.stopReason,
      timestamp: c1.summary.timestamp,
    }),
    line({ role: 'user', content: [{ type: 'text', text: c2.user.text }], timestamp: c2.user.timestamp }),
    line({
      role: 'assistant',
      content: [{ type: 'text', text: c2.reply.text }],
      stopReason: c2.reply.stopReason,
      timestamp: c2.reply.timestamp,
    }),
  ]
}

/**
 * 逻辑会话 → child stdout 事件行（live 腿：pi --mode rpc 事件流，顺序 ≡ JSONL 追加顺序）。
 * 含 message_start / text_delta / toolcall_end 锚点等 tee 全管线输入；事件 wire 字段名
 * （args/result/toolCallId/isError）以 pi-protocol.ts 为准（ADR-0037）。
 */
function toChildStdoutLines(): string[] {
  const c1 = CONVERSATION.round1
  const c2 = CONVERSATION.round2
  const msgStart = (ts: number): string =>
    JSON.stringify({ type: 'message_start', message: { role: 'assistant', content: [], timestamp: ts } })
  const deltas = (parts: string[]): string[] =>
    parts.map((d) => JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: d } }))
  return [
    // round 1：user message_end（pi agent-loop 开头逐 prompt emit，A-08 实测序）
    JSON.stringify({ type: 'message_start', message: { role: 'user', content: [], timestamp: c1.user.timestamp } }),
    JSON.stringify({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: c1.user.text }], timestamp: c1.user.timestamp } }),
    // assistant 流式：start → text_delta* → toolcall_end（contentIndex 锚点）
    msgStart(c1.assistantWithTool.timestamp),
    ...deltas(['先读取', '入口文件']),
    JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', toolCall: { id: c1.assistantWithTool.toolCall.id }, contentIndex: 1 } }),
    JSON.stringify({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: c1.assistantWithTool.text },
          { type: 'toolCall', ...c1.assistantWithTool.toolCall },
        ],
        usage: c1.assistantWithTool.usage,
        stopReason: c1.assistantWithTool.stopReason,
        timestamp: c1.assistantWithTool.timestamp,
      },
    }),
    // 工具执行：canonical 信息在 tool_execution_*（message_update.toolcall_* 数据不全）
    JSON.stringify({ type: 'tool_execution_start', toolCallId: c1.toolResult.toolCallId, toolName: c1.toolResult.toolName, args: { path: c1.assistantWithTool.toolCall.arguments.path } }),
    JSON.stringify({
      type: 'tool_execution_end',
      toolCallId: c1.toolResult.toolCallId,
      toolName: c1.toolResult.toolName,
      isError: c1.toolResult.isError,
      result: { content: [{ type: 'text', text: c1.toolResult.text }], details: null },
    }),
    // pi 对同一 toolResult 双发（R2-S1，chaos real-pi 同证）：message_end 携带持久化权威
    // timestamp（与 JSONL 腿同源 1200）。live 侧 endTime 经 U3 last-wins 收敛为权威值 ≡ reload；
    // 缺此帧则 live endTime = 客户端时钟（Gate A 实测漂移源）
    JSON.stringify({
      type: 'message_end',
      message: {
        role: 'toolResult',
        toolCallId: c1.toolResult.toolCallId,
        toolName: c1.toolResult.toolName,
        isError: c1.toolResult.isError,
        content: [{ type: 'text', text: c1.toolResult.text }],
        timestamp: c1.toolResult.timestamp,
      },
    }),
    // 总结 assistant + 清除帧触发（assistant 定稿 lines:undefined）
    msgStart(c1.summary.timestamp),
    ...deltas(['入口是 main.ts\n导出', ' main 函数']),
    JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: c1.summary.text }], stopReason: c1.summary.stopReason, timestamp: c1.summary.timestamp } }),
    // round 2（chatMode 续聊轮）：user → assistant
    JSON.stringify({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: c2.user.text }], timestamp: c2.user.timestamp } }),
    msgStart(c2.reply.timestamp),
    ...deltas(['测试目录包含 ', '3 个用例文件']),
    JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: c2.reply.text }], stopReason: c2.reply.stopReason, timestamp: c2.reply.timestamp } }),
  ]
}

describe('equivalence: relay live ≡ reload（tee entry 帧 × getSubagentHistory 直读链，免真实 LLM）', () => {
  let dir: string | null = null

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      dir = null
    }
  })

  it('tee entry 帧序列 replayEntries 产出 == JSONL 直读链产出（messages deep equal + reducer 确定性）', async () => {
    // ── live 腿：真实 RelayTee 消费合成 stdout → 收集两种 WS 帧 ──
    const frames: Array<{ sessionId: string; msg: ServerMessage }> = []
    const tee = new RelayTee({
      mainSessionId: MAIN_SID,
      recordId: RECORD_ID,
      publish: (sessionId, msg) => frames.push({ sessionId, msg }),
    })
    tee.feed(Buffer.from(toChildStdoutLines().map((l) => l + '\n').join(''), 'utf-8'))

    const entryFrames = frames.filter(
      (f): f is { sessionId: string; msg: ServerMessage & { payload: { entries: unknown[] } } } =>
        f.msg.type === 'session.subagentEntriesAppended',
    )
    // 非空守卫（防 0 == 0 空转）：8 帧各 1 entry = 6 条 message（user×2 / assistant×3 /
    // toolResult×1，R2-S1 双发含 message_end 权威帧）+ 1 条 toolCall overlay form。overlay
    // form 是 tool_execution_start 的 UI running 态载体（timestamp 运行时生成非确定值），
    // 不进 reducer 不变量——下方 liveEntries 按 applySubagentEntries 同规则剔除，此处只
    // 断言其存在与归属。
    const allEntries = entryFrames.flatMap((f) => f.msg.payload.entries)
    expect(entryFrames).toHaveLength(8)
    expect(allEntries).toHaveLength(8)
    const overlayForms = allEntries.filter(
      (e): e is PiToolCallEntryForm => (e as { type?: string }).type === 'toolCall',
    )
    expect(overlayForms).toHaveLength(1)
    expect(overlayForms[0]?.toolCallId).toBe('tc-eq-relay-1')

    // 帧归属契约（关键规则 7 / §4.3）：entry 帧路由 key = 主 sid，payload.sessionId 也是主 sid
    for (const f of entryFrames) {
      expect(f.sessionId).toBe(MAIN_SID)
      expect(f.msg.type).toBe('session.subagentEntriesAppended')
    }

    // stream_delta 帧契约（§4.3 打字机中间态）：payload.sessionId = 虚拟分区 id、lines 累积全文 split
    const deltaFrames = frames.filter(
      (f): f is { sessionId: string; msg: ServerMessage & { payload: { recordId: string; lines?: string[] | undefined } } } =>
        f.msg.type === 'subagent.stream_delta',
    )
    expect(deltaFrames.length).toBeGreaterThanOrEqual(6)
    for (const f of deltaFrames) {
      expect(f.msg.payload.recordId).toBe(RECORD_ID)
    }
    const typedDeltas = deltaFrames.filter((f) => f.msg.payload.lines !== undefined)
    expect(typedDeltas[0]?.msg.payload.lines).toEqual(['先读取'])
    expect(typedDeltas[1]?.msg.payload.lines).toEqual(['先读取入口文件'])
    // assistant 定稿清除帧：每条 assistant message_end 一条 lines:undefined（3 条 assistant）
    expect(deltaFrames.filter((f) => f.msg.payload.lines === undefined)).toHaveLength(3)

    // overlay 形态（toolCall form）按 applySubagentEntries 同规则剔除——store 层 UI 态不在
    // reducer 不变量内（§2.4 不变量只约束 reducer state）
    const liveEntries = allEntries.filter(
      (e): e is PiEntry => (e as { type?: string }).type !== 'toolCall',
    )
    // U3：R2-S1 双发的 message_end toolResult 帧计入（去重后仍占一个 entry 位）
    expect(liveEntries).toHaveLength(7)
    const liveState = replayEntries(liveEntries)

    // ── reload 腿：getSubagentHistory pi 直读链尾段（JSONL fixtures 驱动）──
    dir = await mkdtemp(join(tmpdir(), 'relay-equiv-'))
    const filePath = join(dir, 'subagent-session.jsonl')
    await writeFile(filePath, toSessionJsonlLines().join('\n') + '\n', 'utf-8')
    const { messages: reloadMessages } = await getHistoryFromFilePath(filePath, new PiSessionStore())

    // ── 等价性主断言（E-重开验收）：live ≡ reload ──
    expect(liveState.messages).toEqual(reloadMessages)

    // reducer 确定性（chaos 不变量 0 同款）：同一 live 序列两次重放全等
    expect(replayEntries(liveEntries)).toEqual(liveState)

    // 结构守卫：工具链路完整回填（非孤儿）、五条投影消息角色序符合两轮形态
    expect(liveState.orphanToolResults).toHaveLength(0)
    expect(reloadMessages.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant', 'user', 'assistant'])
    const withTool = reloadMessages[1]
    expect(withTool?.toolCalls?.[0]).toMatchObject({
      id: 'tc-eq-relay-1',
      status: 'completed',
      output: 'export function main() { bootstrap() }',
    })

    tee.dispose()
  })
})
