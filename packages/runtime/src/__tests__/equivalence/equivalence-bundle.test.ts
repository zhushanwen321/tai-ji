import { INTEGRATION_TESTS_ENABLED, INTEGRATION_TESTS_SKIP_REASON } from '../../../../../test-guard/integration-gate.ts';
import { applyEntry, createInitialChatViewState, replayEntries, type ChatViewState, type PiEntry } from '../../../../core/src/domain/chat/apply-entry.js';
import { translate } from '../../infra/pi/event-adapter.js';
import type { PiEvent } from '../../infra/pi/pi-protocol.js';
import { EventInterpreter } from '../../services/session/event-interpreter.js';
import { scanPlanStateEntries } from '../../services/session/plan-state-extractor.js';
import { spawnPiFixture, type PiFixture, type PiRpcResponse } from './pi-fixture.js';
import type { PlanStateView } from '@taiji/shared';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← src/__tests__/equivalence/live-reload.test.ts
// ======================================================================

import type { GetEntriesResponse, PiSessionEntry } from '../../infra/pi/pi-protocol.js';
import type { ServerMessage } from '@taiji/shared';
/** 等 turn 完成的上限（faux 层实际毫秒级；名义上限保留迁组前余量防 flake） */
const TURN_TIMEOUT_MS = 120_000

/** 用例总超时 = 冷启动 + 多轮 turn + bash + get_entries + dispose 的和再留余量 */
const TEST_TIMEOUT_MS = 300_000


/** 从 message_end 事件流提取实时重构 entry（生产翻译层 translate 同款路径）。 */
function collectLiveEntries(fx: PiFixture, sid: string): PiEntry[] {
  return fx
    .collectEvents((e) => e.type === 'message_end')
    .flatMap((e) => translate(e as unknown as PiEvent, sid))
    .filter(
      (ev) => ev.kind === 'message' && ev.message.type === ('message.message_end' as string),
    )
    .map((ev) => {
      const payload = (ev as { message: { payload: { entry: PiEntry } } }).message.payload
      return payload.entry
    })
}


/** get_entries reply → entry 列表（剥 id：live 侧 message_end 无 id，同派生规则对齐）。 */
async function fetchReloadEntriesStripped(fx: PiFixture): Promise<PiEntry[]> {
  const reloadResp = await fx.sendCommand('get_entries')
  const rawEntries: unknown = reloadResp.data?.entries
  if (!Array.isArray(rawEntries)) throw new Error('get_entries reply has no entries array')
  return rawEntries
    .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
    .map((e) => {
      const { id: _id, ...rest } = e as { id?: string } & Record<string, unknown>
      return rest as unknown as PiEntry
    })
}


/** bash 消息 timestamp 归一（live bash 走 RPC reply 无 message_end，timestamp 非同源）。 */
function normalizeBashTimestamps(state: ChatViewState): ChatViewState {
  return {
    ...state,
    messages: state.messages.map((m) =>
      m.bashExecution !== undefined
        ? { ...m, timestamp: 0, bashExecution: { ...m.bashExecution, timestamp: 0 } }
        : m,
    ),
  }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('live-reload', () => {
describe.skipIf(!INTEGRATION_TESTS_ENABLED)(
  `equivalence: live ≡ reload（faux-pi 子进程${INTEGRATION_TESTS_SKIP_REASON ? `｜skip：${INTEGRATION_TESTS_SKIP_REASON}` : ''}）`,
  () => {
  let fixture: PiFixture | null = null

  afterEach(async () => {
    if (fixture) {
      await fixture.dispose()
      fixture = null
    }
  })

  it(
    'store 级同构：实时累积 state == get_entries 重放 state（prompt 含工具调用）',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      // faux 脚本：turn1 = bash toolCall（真实执行 echo probe-w21）+ 总结文本——覆盖
      // user / assistant(toolCalls) / toolResult / assistant(summarize) 四种 message entry
      const fx = await spawnPiFixture({
        fauxResponses: [
          { toolCalls: [{ name: 'bash', args: { command: 'echo probe-w21' } }] },
          { text: 'probe-w21' },
        ],
      })
      fixture = fx
      const sid = 'equiv-live-reload'

      // 操作序列：prompt 触发一次工具调用（bash 工具，--approve 自动批准）——覆盖
      // user / assistant(with toolCalls) / toolResult / assistant(summarize) 四种 message entry。
      await fx.runTurn(
        {
          message: "Use the bash tool to run the command `echo probe-w21` and reply with its exact output.",
        },
        TURN_TIMEOUT_MS,
      )

      // live 侧：message_end 流经生产 translate() 重构 entry → 喂同一 reducer
      const liveEntries = collectLiveEntries(fx, sid)
      // 非空检查（防 0 == 0 空转）：至少 user prompt + assistant 两条
      expect(liveEntries.length).toBeGreaterThanOrEqual(2)
      const liveState = replayEntries(liveEntries)

      // reload 侧：get_entries 全量重放（剥 id 对齐派生规则）
      const reloadEntries = await fetchReloadEntriesStripped(fx)
      expect(reloadEntries.length).toBeGreaterThan(0)
      const reloadState = replayEntries(reloadEntries)

      // store 级快照 deep equal（逐字段：messages 的 role/content/toolCalls/contentBlocks/
      // usage/thinking + orphanToolResults + 配对锚点）。
      // 协议依据（W5）：message_end.message ≡ 持久化 entry.message（同一对象）。
      expect(liveState.messages).toEqual(reloadState.messages)
      expect(liveState.orphanToolResults).toEqual(reloadState.orphanToolResults)
      expect(liveState.lastAssistantWithToolCalls).toBe(reloadState.lastAssistantWithToolCalls)

      // 工具链路覆盖检查：assistant 带 toolCalls 且 toolResult 已回填（非孤儿）
      const assistantWithTool = reloadState.messages.find((m) => (m.toolCalls?.length ?? 0) > 0)
      expect(assistantWithTool).toBeDefined()
      expect(assistantWithTool?.toolCalls?.[0]?.output).toContain('probe-w21')
      expect(reloadState.orphanToolResults).toHaveLength(0)

      // dispose 后临时 session-dir 清理断言（契约锁定）
      const sessionDir = fx.sessionDir
      await fx.dispose()
      fixture = null
      expect(existsSync(sessionDir)).toBe(false)
    },
  )

  it(
    'store 级同构：bash 执行（独立持久化路径）+ 二次 prompt 的双通道合并',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      // 操作序列：prompt → agent_end → `bash`（recordBashResult 直接 appendMessage，无
      // message_end，live 侧从 RPC reply 合并）→ 二次 prompt（faux 队列逐轮消费两条文本响应）。
      const fx = await spawnPiFixture({
        fauxResponses: [{ text: 'pong' }, { text: 'ping' }],
      })
      fixture = fx
      const sid = 'equiv-bash'

      await fx.runTurn({ message: 'Reply with exactly the word: pong' }, TURN_TIMEOUT_MS)

      const bashReply = await fx.sendCommand('bash', { command: 'echo bash-probe-w21' })
      const bashResult = (bashReply.data ?? {}) as {
        output?: string
        exitCode?: number | null
        cancelled?: boolean
        truncated?: boolean
        fullOutputPath?: string
      }
      const bashAt = collectLiveEntries(fx, sid).length

      // runTurn 的 since 打点保证只等本轮（第二次）agent_end，取代 seenAgentEnds 计数谓词
      await fx.runTurn({ message: 'Reply with exactly the word: ping' }, TURN_TIMEOUT_MS)

      // live 侧：message_end 流 + bash entry（reply 到达点合并，位置 ≡ 持久化追加顺序）
      const liveEntries = collectLiveEntries(fx, sid)
      const bashEntry: PiEntry = {
        type: 'message',
        parentId: null,
        timestamp: new Date(0).toISOString(),
        message: {
          role: 'bashExecution',
          command: 'echo bash-probe-w21',
          output: typeof bashResult.output === 'string' ? bashResult.output : '',
          exitCode: typeof bashResult.exitCode === 'number' ? bashResult.exitCode : null,
          cancelled: bashResult.cancelled === true,
          truncated: bashResult.truncated === true,
          ...(typeof bashResult.fullOutputPath === 'string' ? { fullOutputPath: bashResult.fullOutputPath } : {}),
        },
      }
      liveEntries.splice(bashAt, 0, bashEntry)
      const liveState = replayEntries(liveEntries)

      const reloadState = replayEntries(await fetchReloadEntriesStripped(fx))

      // bashExecution.timestamp 非同源（reply 无 timestamp）→ 归一后全量对比
      expect(normalizeBashTimestamps(liveState)).toEqual(normalizeBashTimestamps(reloadState))
      // bash 消息检查：两侧各恰好一条 bashExecution 且输出一致
      const liveBash = liveState.messages.filter((m) => m.bashExecution !== undefined)
      const reloadBash = reloadState.messages.filter((m) => m.bashExecution !== undefined)
      expect(liveBash).toHaveLength(1)
      expect(reloadBash).toHaveLength(1)
      expect(liveBash[0]?.bashExecution?.output).toBe(reloadBash[0]?.bashExecution?.output)

      await fx.dispose()
      fixture = null
    },
  )

  it(
    '混沌注入：乱序 / 丢失 / 重复投递 → 各自脏 state 可检测（确定性单次断言 + 脏化判别）',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      // faux 脚本：bash toolCall（真实执行 echo chaos-w21）+ 总结文本——混沌注入的语料源
      const fx = await spawnPiFixture({
        fauxResponses: [
          { toolCalls: [{ name: 'bash', args: { command: 'echo chaos-w21' } }] },
          { text: 'chaos-w21' },
        ],
      })
      fixture = fx
      const sid = 'equiv-chaos'

      await fx.runTurn(
        {
          message: "Use the bash tool to run the command `echo chaos-w21` and reply with its exact output.",
        },
        TURN_TIMEOUT_MS,
      )

      const liveEntries = collectLiveEntries(fx, sid)
      expect(liveEntries.length).toBeGreaterThanOrEqual(3) // user + assistant + toolResult + ...
      const reloadEntries = await fetchReloadEntriesStripped(fx)
      const reloadState = replayEntries(reloadEntries)

      // ── 不变量 0：reducer 确定性——同一权威序列两次重放 deep equal ──
      expect(replayEntries(reloadEntries)).toEqual(reloadState)

      // ── 混沌 1：乱序（toolResult 提前到 assistant 之前）→ 脏 state ≠ 权威 ──
      const toolResultIdx = liveEntries.findIndex(
        (e) => e.type === 'message' && e.message.role === 'toolResult',
      )
      expect(toolResultIdx).toBeGreaterThan(0)
      const reordered = [...liveEntries]
      const [orphaned] = reordered.splice(toolResultIdx, 1)
      const assistantIdx = reordered.findIndex(
        (e) => e.type === 'message' && e.message.role === 'assistant',
      )
      reordered.splice(Math.max(assistantIdx, 0), 0, orphaned!)
      const chaoticState = replayEntries(reordered)
      // 乱序后分叉（toolResult 落在 assistant 之前 → 孤儿收集而非回填）
      expect(chaoticState.orphanToolResults.length).toBeGreaterThan(0)
      expect(chaoticState.messages).not.toEqual(reloadState.messages)

      // ── 混沌 2：丢失（drop 中间 entry）→ 脏 ──
      const dropped = liveEntries.filter((_, i) => i !== assistantIdx)
      const droppedState = replayEntries(dropped)
      expect(droppedState.messages.length).toBeLessThan(reloadState.messages.length)

      // ── 混沌 3：重复投递（同 message_end 喂两次）→ messages 多一条（可检测脏化）──
      const duplicated = [...liveEntries, liveEntries[0]!]
      const dupState = replayEntries(duplicated)
      expect(dupState.messages.length).toBe(reloadState.messages.length + 1)

      await fx.dispose()
      fixture = null
    },
  )
})
// seenAgentEnds 计数谓词已删：多轮 agent_end 等待由 runTurn 的 since 打点取代（fixture 原语）

// ── plan-state entry 等价（plan 模式重设计 A7——静态 fixture）──────────────────
//
// plan 状态派生视图的「live ≡ reload」由 scanPlanStateEntries 唯一派生代码构造性保证
// （plan-state-extractor.ts：live = SessionRecords 增量重新拉取的前缀切片派生；reload =
// getPlanState 磁盘全量派生——同一函数，冷热共用）。本组用静态 entry 序列（不 spawn pi
// 进程，与上方 faux 层 describe.skipIf 块正交、任何环境可跑）钉住该构造性：fixture 含旧
// 四字段与新七字段（skills/docs/reviewState 三 optional，D4）两种 schema entry + 噪声
// entry（message 载体 / 其他 extension custom / data 非对象的坏 plan-state——派生按
// 「跳过继续向前」语义穿越）。派生语义 = 最后一条合法 plan-state entry（extension 侧
// reconstructPlanState 逆序取首同构）。只 import 消费派生函数，禁改其本体。
describe('plan-state entry 等价（A7 静态 fixture）：live 增量折叠 ≡ reload 全量派生', () => {
  /** plan-state entry 构造（JSONL 反序列化形态：type:'custom'；data 参数放宽 unknown 供坏形态用例） */
  const planEntry = (data: unknown, id: string, ms: number) => ({
    type: 'custom',
    id,
    parentId: null,
    timestamp: new Date(ms).toISOString(),
    customType: 'plan-state',
    data,
  })
  /** 噪声 message entry（对话流载体，派生扫描应忽略） */
  const msgEntry = (text: string, id: string, ms: number) => ({
    type: 'message',
    id,
    parentId: null,
    timestamp: new Date(ms).toISOString(),
    message: { role: 'user', content: [{ type: 'text', text }], timestamp: ms },
  })

  // 序列：噪声 → 旧四字段 → 噪声（其他 extension）→ 坏 plan-state（data 非对象）→ 新七字段（终态）
  const SEQUENCE: unknown[] = [
    msgEntry('进入计划模式', '0198aabb-ccdd-7e01-8f00-000000000001', 1000),
    planEntry(
      { isActive: true, planFilePath: '/tmp/taiji-harness/auth/plan.md', requirement: '重构 auth 模块', templateName: 'refactor' },
      '0198aabb-ccdd-7e02-8f00-000000000002',
      2000,
    ),
    { type: 'custom', id: '0198aabb-ccdd-7e03-8f00-000000000003', parentId: null, timestamp: new Date(3000).toISOString(), customType: 'goal-context', data: { note: '其他 extension 的 custom entry，派生跳过' } },
    planEntry(null, '0198aabb-ccdd-7e04-8f00-000000000004', 4000),
    planEntry(
      {
        isActive: true,
        planFilePath: '/tmp/taiji-harness/auth/plan.md',
        requirement: '重构 auth 模块',
        templateName: 'refactor',
        skills: ['tech-design', 'dev-flow'],
        docs: [{ fileName: 'design.md', absPath: '/tmp/taiji-harness/auth/design.md', sourceSkill: 'tech-design', version: 1 }],
        reviewState: 'awaiting',
      },
      '0198aabb-ccdd-7e05-8f00-000000000005',
      5000,
    ),
  ]

  it('冷启动全量派生 ≡ 逐条前缀增量折叠（live 增量重新拉取镜像，构造性不变量）', () => {
    // reload 路径：getPlanState 磁盘全量 → 同一份派生函数
    const cold = scanPlanStateEntries(SEQUENCE)
    expect(cold).not.toBeNull()
    // live 路径镜像：SessionRecords 增量重新拉取（前缀切片）折叠
    // k=4 中段字面量锚点（不从生产函数取）：该前缀已穿越 goal-context 噪声与坏
    // plan-state（data 非对象），view 仍 = 前缀内最后一条合法 entry（旧四字段）的
    // 派生——钉住「跳过继续向前 + 最后一条合法 entry wins」的折叠语义
    let live: PlanStateView | null = null
    let midAfterBadEntry: PlanStateView | null = null
    for (let k = 1; k <= SEQUENCE.length; k++) {
      const view = scanPlanStateEntries(SEQUENCE.slice(0, k))
      if (view) live = view
      if (k === 4 && view) midAfterBadEntry = view
    }
    expect(midAfterBadEntry).toEqual({
      isActive: true,
      planFilePath: '/tmp/taiji-harness/auth/plan.md',
      requirement: '重构 auth 模块',
      templateName: 'refactor',
      state: 'planning',
    })
    expect(live).toEqual(cold)
  })

  it('新旧 schema 派生形态：旧 entry state 归一（恒携带）+ optional 缺省不设键；新 entry skills/docs 透传 + state 归一（旧字段不透出）', () => {
    // 旧 schema（前缀止于旧 entry，噪声 message 已被穿越）：state 恒携带（无 reviewState
    // 且 isActive → planning，D2 读方② 归一），新字段区不设键、旧字段不透出
    const legacyOnly = scanPlanStateEntries(SEQUENCE.slice(0, 2))
    expect(legacyOnly).toEqual({
      isActive: true,
      planFilePath: '/tmp/taiji-harness/auth/plan.md',
      requirement: '重构 auth 模块',
      templateName: 'refactor',
      state: 'planning',
    })
    expect('skills' in legacyOnly!).toBe(false)
    expect('docs' in legacyOnly!).toBe(false)
    expect('reviewState' in legacyOnly!).toBe(false)
    expect('reviewStateSource' in legacyOnly!).toBe(false)
    // 新 schema（全量终态）：skills/docs 逐字段透传 + reviewState 归一为 state
    //（awaiting→reviewing，旧字段不透出），两路径同形
    const cold = scanPlanStateEntries(SEQUENCE)
    expect(cold).toMatchObject({
      isActive: true,
      planFilePath: '/tmp/taiji-harness/auth/plan.md',
      requirement: '重构 auth 模块',
      templateName: 'refactor',
      skills: ['tech-design', 'dev-flow'],
      state: 'reviewing',
    })
    expect('reviewState' in cold!).toBe(false)
    expect(cold!.docs).toEqual([
      { fileName: 'design.md', absPath: '/tmp/taiji-harness/auth/design.md', sourceSkill: 'tech-design', version: 1 },
    ])
  })
})
});

// ======================================================================
// ← src/__tests__/equivalence/pending-notify-ledger-replay.test.ts
// ======================================================================

// ─── fixture 构造（JSONL 反序列化形态）──────────────────────────────────────

const ts = (ms: number): string => new Date(ms).toISOString()

const id = (n: number): string => `0198aabb-ccdd-7e0${n}-8f00-00000000000${n}`


function userMsg(text: string, n: number, ms: number): PiEntry {
  return {
    type: 'message',
    id: id(n),
    parentId: null,
    timestamp: ts(ms),
    message: { role: 'user', content: [{ type: 'text', text }], timestamp: ms },
  }
}


function assistantMsg(text: string, n: number, ms: number): PiEntry {
  return {
    type: 'message',
    id: id(n),
    parentId: null,
    timestamp: ts(ms),
    message: { role: 'assistant', content: [{ type: 'text', text }], timestamp: ms },
  }
}


/** pending:register plain custom entry（三键契约 {id=notifyId, type:'session', name}）。 */
function pendingRegister(notifyId: string, n: number, ms: number): PiEntry {
  return {
    type: 'custom',
    id: id(n),
    parentId: null,
    timestamp: ts(ms),
    customType: 'pending:register',
    data: {
      id: notifyId,
      type: 'session', // notify-once 扩展的 PendingType 新值（u-protocol 面）
      name: 'auth-refactor',
      status: 'active',
      registeredAt: ms,
      sessionId: 'parent-1',
    },
  }
}


/** pending:unregister plain custom entry（差集抵消键 = data.id）。 */
function pendingUnregister(notifyId: string, n: number, ms: number): PiEntry {
  return {
    type: 'custom',
    id: id(n),
    parentId: null,
    timestamp: ts(ms),
    customType: 'pending:unregister',
    data: { id: notifyId, reason: 'completed', status: 'completed' },
  }
}


/** v1 账本存量 entry（plain custom：ledger / ack 两通道——历史 session 文件在场）。 */
function v1LedgerEntry(customType: string, notifyId: string, n: number, ms: number): PiEntry {
  return {
    type: 'custom',
    id: id(n),
    parentId: null,
    timestamp: ts(ms),
    customType,
    data: { v: 1, notifyId, status: 'pending', content: 'Managed session "auth-refactor" finished.' },
  }
}


/** v2 投递日志 outbox entry（pi-delivery-port journal schema：{v:2, id, timing, payload, recordedAt}）。 */
function portOutboxEntry(entryId: string, n: number, ms: number): PiEntry {
  return {
    type: 'custom',
    id: id(n),
    parentId: null,
    timestamp: ts(ms),
    customType: 'delivery-port-outbox',
    data: {
      v: 2,
      id: entryId,
      timing: 'steer',
      payload: {
        kind: 'custom',
        customType: 'subagent-bg-notify',
        content: 'Subagent "auth-refactor" (sa-1) completed. Result:\nok',
        display: true,
        details: { id: 'sa-1', notifyId: 'sa-1', outcome: 'completed' },
      },
      recordedAt: ms,
    },
  }
}


/** v2 终局 entry（ack 主形态 outcome 缺省 / discard 带 outcome:"discarded"）。 */
function portAckEntry(entryId: string, n: number, ms: number, outcome?: 'discarded'): PiEntry {
  return {
    type: 'custom',
    id: id(n),
    parentId: null,
    timestamp: ts(ms),
    customType: 'delivery-port-ack',
    data: outcome === undefined ? { v: 2, id: entryId } : { v: 2, id: entryId, outcome },
  }
}


/**
 * 样本序列：user → register(sm-a) → assistant → register(sm-b) → v1 ledger(sm-a)
 * → unregister(sm-a) → v1 ack(sm-a) → v2 outbox(sm-b) → v2 ack(sm-b) → assistant。
 * 通知域 entry 全部夹在 message 之间，覆盖「穿越」与「不位移派生」两面；v1 存量
 * 与 v2 现行 schema 两个形态共存（升级过渡期的真实 session 文件形态）。
 */
function buildSequence(): PiEntry[] {
  return [
    userMsg('派发 auth 重构任务', 1, 1000),
    pendingRegister('sm-a', 2, 1100),
    assistantMsg('收到，开始执行', 3, 1200),
    pendingRegister('sm-b', 4, 1300),
    v1LedgerEntry('subagent-bg-notify-ledger', 'sm-a', 5, 1400),
    pendingUnregister('sm-a', 6, 1500),
    v1LedgerEntry('subagent-bg-notify-ack', 'sm-a', 7, 1600),
    portOutboxEntry('sm-b', 8, 1650),
    portAckEntry('sm-b', 9, 1700),
    assistantMsg('任务完成', 10, 1800),
  ]
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('pending-notify-ledger-replay', () => {
describe('equivalence：pending/投递日志 entry 样本的 applyEntry reducer 确定性（U5⑥，schema v1+v2）', () => {
  it('确定性：同一序列两次重放 deep-equal（消息列表 = entry 日志的纯函数）', () => {
    const seq = buildSequence()
    const first = replayEntries(seq)
    const second = replayEntries(seq)
    expect(first).toEqual(second)
    // 非空检查（防空转）：3 条 message entry（user + 2 assistant）全数映射出
    expect(first.messages).toHaveLength(3)
    expect(first.orphanToolResults).toHaveLength(0)
  })

  it('零派生：pending 差集与投递日志 entry（v1 存量 + v2 schema）不产消息、不位移 message 派生 id', () => {
    const seq = buildSequence()
    const full = replayEntries(seq)
    const messagesOnly = seq.filter((e) => e.type !== 'custom')
    const reduced = replayEntries(messagesOnly)
    // 通知域 custom entry 全部被派生穿越：消息集与仅 message 子序列重放逐字节一致
    expect(full.messages).toEqual(reduced.messages)
    expect(full.messages.map((m) => m.id)).toEqual(reduced.messages.map((m) => m.id))
    // 消息内容形态：夹缝中的通知 entry 不产生任何幽灵消息
    expect(full.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant'])
  })

  it('双 fold 路径同 reducer：applyEntry 单条逐喂 ≡ replayEntries 批量', () => {
    const seq = buildSequence()
    const folded = seq.reduce(applyEntry, createInitialChatViewState())
    expect(folded).toEqual(replayEntries(seq))
    // 中途快照同样确定（逐条 fold 任一前缀两次喂入一致）
    const prefix = seq.slice(0, 6)
    const prefixA = prefix.reduce(applyEntry, createInitialChatViewState())
    const prefixB = prefix.reduce(applyEntry, createInitialChatViewState())
    expect(prefixA).toEqual(prefixB)
    expect(prefixA.messages).toHaveLength(2)
  })
})
});

// ======================================================================
// ← src/__tests__/equivalence/pi-protocol-contract.test.ts
// ======================================================================

/** 等 turn 完成的上限（真实 LLM 调用；对齐 live-reload.test.ts 余量口径） */
const TURN_TIMEOUT_MS_m2 = 120_000

/** 用例总超时 = 冷启动 + 1 轮 LLM turn + 多次 RPC + dispose 的和再留余量 */
const TEST_TIMEOUT_MS_m2 = 240_000


/**
 * 事件范围实测的事件名清单。satisfies 编译期锚定到生产 PiEvent 联合（pi-protocol.ts，
 * ADR-0037 真契约）：上游事件改名的类型同步先落 pi-protocol.ts，此处立即跟着红——
 * 防「类型层已同步、契约断言仍用旧名」的静默脱钩。entry_appended 的特殊性见 D5 固化。
 */
const CONTRACT_EVENT_TYPES = [
  'session_info_changed',
  'thinking_level_changed',
  'queue_update',
  'message_end',
  'entry_appended',
] as const satisfies readonly PiEvent['type'][]


// ── ① RPC 命令范围：契约命令 union + reply 形状 guard（编译期穷举）──────────────

/** 数据治理消费方锁定的 RPC 命令 union（rpc-client.ts 实际调用的子集） */
type ContractRpcCommand =
  | 'set_session_name'
  | 'get_state'
  | 'get_session_stats'
  | 'get_entries'
  | 'get_commands'


/** unknown → Record 检查 */
function asRecord(v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null) throw new Error(`expected object, got: ${String(v)}`)
  return v as Record<string, unknown>
}


/**
 * reply 形状 guard：Record<ContractRpcCommand, ...> 对命令 union 编译期穷举——
 * union 增删成员而本表不同步 → tsc 报错（缺 key / 多余 key 双向）。
 * 违反形状时 throw（测试红 = 契约漂移信号）。
 */
const REPLY_GUARDS: Record<ContractRpcCommand, (resp: PiRpcResponse) => void> = {
  set_session_name: (resp) => {
    expect(resp.success).toBe(true)
    // pi rpc-mode success(id, "set_session_name") 不带 data（void 命令）
    if (resp.data !== undefined) throw new Error('set_session_name reply unexpectedly carries data')
  },
  get_state: (resp) => {
    // 镜像 pi RpcSessionState 必填字段（rpc-types.ts:94-107）——W7/W8 scalar 实例实际用到的字段
    const data = asRecord(resp.data)
    expect(typeof data.sessionId).toBe('string')
    expect(typeof data.thinkingLevel).toBe('string')
    expect(typeof data.isStreaming).toBe('boolean')
    expect(typeof data.messageCount).toBe('number')
    expect(typeof data.pendingMessageCount).toBe('number')
  },
  get_session_stats: (resp) => {
    // 镜像 pi SessionStats（agent-session.ts:225-242）；contextUsage 可选（无 turn 时缺省），
    // 出现时形状必须符合 usage 实例派生视图口径（tokens/percent 可为 null = 合法「无值」态）
    const data = asRecord(resp.data)
    expect(typeof data.sessionId).toBe('string')
    expect(typeof data.userMessages).toBe('number')
    expect(typeof data.assistantMessages).toBe('number')
    expect(typeof data.totalMessages).toBe('number')
    if (data.contextUsage !== undefined) {
      const cu = asRecord(data.contextUsage)
      const tokens = cu.tokens
      if (tokens !== null && typeof tokens !== 'number') {
        throw new Error(`contextUsage.tokens must be number|null, got: ${typeof tokens}`)
      }
      expect(typeof cu.contextWindow).toBe('number')
      const percent = cu.percent
      if (percent !== null && typeof percent !== 'number') {
        throw new Error(`contextUsage.percent must be number|null, got: ${typeof percent}`)
      }
    }
  },
  get_entries: (resp) => {
    // 编译期锚定生产契约类型 GetEntriesResponse（pi-protocol.ts：entries + leafId）
    const data = asRecord(resp.data)
    if (!Array.isArray(data.entries)) throw new Error('get_entries reply has no entries array')
    for (const e of data.entries) asRecord(e)
    // 形状对齐赋值：fixture 实测形态 ⊇ 生产类型声明（生产类型收紧 → 此处 tsc 红）
    const typed: GetEntriesResponse = {
      entries: data.entries as PiSessionEntry[],
      leafId: (data.leafId === null ? null : String(data.leafId)) as string | null,
    }
    expect(Array.isArray(typed.entries)).toBe(true)
  },
  get_commands: (resp) => {
    // pi rpc-mode get_commands：{ commands: [{ name, description, source, ... }] }
    const data = asRecord(resp.data)
    if (!Array.isArray(data.commands)) throw new Error('get_commands reply has no commands array')
    for (const c of data.commands) {
      const cmd = asRecord(c)
      expect(typeof cmd.name).toBe('string')
      expect(typeof cmd.source).toBe('string')
    }
  },
}


// ── ③ entry 面：PiEntry 联合穷举覆盖 reducer case（编译期 exhaustive）─────────

/** reducer（core applyEntry）的 case 清单（apply-entry.ts switch 分支一一对应） */
const REDUCER_CASE_TYPES = [
  'message',
  'custom',
  'label',
  'compaction',
  'branch_summary',
  'custom_message',
  'usage',
  'context_edit',
] as const


/**
 * 编译期 exhaustive（ADR-0037 手法）：switch 穷举 shared PiEntry 联合（get_entries wire
 * 契约 SSOT）。双向保证——
 * - PiEntry 联合新增成员而 reducer 无 case → default 分支 never 赋值 tsc 报错（漏类型）；
 * - 联合删成员而 reducer case 残留 → case 字面量可比性 tsc 报错（死 case）。
 * tsc --noEmit 通过即证穷举无漏（验收命令 1）。
 */
function assertReducerCaseCoverage(entry: PiEntry): void {
  switch (entry.type) {
    case 'message':
    case 'custom':
    case 'label':
    case 'compaction':
    case 'branch_summary':
    case 'custom_message':
    case 'usage':
    case 'context_edit':
      return
    default: {
      const uncovered: never = entry
      throw new Error(`PiEntry 联合成员未被 reducer case 覆盖: ${JSON.stringify(uncovered)}`)
    }
  }
}


/** taiji 刻意未建模的 pi entry 类型（pi-entry.ts 文件头注释清单；reducer default no-op） */
const DOCUMENTED_UNMODELED_ENTRY_TYPES = new Set([
  'thinking_level_change',
  'model_change',
  'session_info',
])


/** 真实 get_entries 产物的 entry.type 成员资格（清单外新类型 = 契约漂移 → 红） */
function assertObservedEntryTypesKnown(observedTypes: string[]): Set<string> {
  const known = new Set<string>([...REDUCER_CASE_TYPES, ...DOCUMENTED_UNMODELED_ENTRY_TYPES])
  for (const t of observedTypes) {
    if (!known.has(t)) {
      throw new Error(
        `pi get_entries 返回了建模清单外的 entry 类型 "${t}"（已知：${[...known].join(', ')}）` +
        '——pi 升级新增 entry 类型，须在 shared/pi-entry.ts 建模 + reducer 加 case 后再升级',
      )
    }
  }
  return new Set(observedTypes)
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('pi-protocol-contract', () => {
describe.skipIf(!INTEGRATION_TESTS_ENABLED)(
  `pi 协议契约（faux-pi 子进程，W25，集成测试门控${INTEGRATION_TESTS_SKIP_REASON ? `｜skip：${INTEGRATION_TESTS_SKIP_REASON}` : ''}）`,
  () => {
  let fixture: PiFixture | null = null

  afterEach(async () => {
    if (fixture) {
      await fixture.dispose()
      fixture = null
    }
  })

  it(
    '① RPC 命令范围：五个契约命令全部可调 + reply 形状 guard 全过（无 LLM 调用，空 session）',
    { timeout: TEST_TIMEOUT_MS_m2 },
    async () => {
      // faux 层空队列：本用例全程无 LLM turn（纯 RPC 面），队列耗尽即报错是意外 turn 的 fail-fast
      const fx = await spawnPiFixture({ fauxResponses: [] })
      fixture = fx
      // 契约锁定的 binary 版本证据（漂移归因用）
      const piVersion = execSync(`"${fx.piPath}" --version`, { encoding: 'utf-8' }).trim()
      console.log(`[W25 contract] pi binary: ${fx.piPath} (${piVersion})`)

      const commands: ContractRpcCommand[] = [
        'get_state',
        'get_session_stats',
        'get_entries',
        'get_commands',
        'set_session_name',
      ]
      for (const command of commands) {
        const params: Record<string, unknown> = command === 'set_session_name' ? { name: 'w25-rpc-face' } : {}
        const resp = await fx.sendCommand(command, params)
        // reply 配对契约：type response + command 回显 + success
        expect(resp.type).toBe('response')
        expect(resp.command).toBe(command)
        expect(resp.success).toBe(true)
        // 形状 guard（Record 编译期穷举 + 运行时逐字段）
        REPLY_GUARDS[command](resp)
      }

      // 新 session 的 get_entries 边界形态。实测定论（W25 固化）：pi 启动即为新 session
      // 写入元数据 entry（sdk.ts:367-373：model_change + thinking_level_change），故空对话
      // session 的 get_entries **不为空**、leafId 非空——真正的空态边界是「无 message entry」。
      // 顺序约束：set_session_name 会立即追加 session_info entry，本段边界断言在其之前测。
      const boundaryResp = await fx.sendCommand('get_entries')
      const boundaryData = asRecord(boundaryResp.data)
      const freshEntries = boundaryData.entries
      if (!Array.isArray(freshEntries)) throw new Error('get_entries reply has no entries array')
      const freshTypes = assertObservedEntryTypesKnown(
        freshEntries.map((e: unknown) => String(asRecord(e).type)),
      )
      expect(freshTypes.has('message')).toBe(false)
      expect(typeof boundaryData.leafId).toBe('string')

      await fx.dispose()
      fixture = null
    },
  )

  it(
    '② 事件范围五事件真实发射 + D5 固化（N 事件 0 条 message 载体 entry_appended）+ ③ entry 面穷举',
    { timeout: TEST_TIMEOUT_MS_m2 },
    async () => {
      // faux 层 reasoning 演员（thinking-level 二档互切的确定性前提）；一轮 turn 的
      // 响应由脚本固定
      const fx = await spawnPiFixture({ model: 'faux/faux-1-reasoning', fauxResponses: [{ text: 'w25-contract' }] })
      fixture = fx

      // ── 事件 1：session_info_changed（set_session_name RPC 触发）──
      await fx.sendCommand('set_session_name', { name: 'w25-event-face' })
      const sessionInfo = await fx.waitForEvent((e) => e.type === 'session_info_changed')
      expect(sessionInfo.name).toBe('w25-event-face')

      // ── 事件 2：thinking_level_changed（set_thinking_level 实际变更才发射，pi 源码
      //    setThinkingLevel 的 isChanging 检查——先读当前值再切到不同档）──
      const stateResp = await fx.sendCommand('get_state')
      const stateData = asRecord(stateResp.data)
      const currentLevel = stateData.thinkingLevel
      if (typeof currentLevel !== 'string') throw new Error(`get_state.thinkingLevel 非 string: ${String(currentLevel)}`)
      // 演员锁定 faux/faux-1-reasoning（reasoning: true，无 thinkingLevelMap → 档位
      // ['off','minimal','low','medium','high']，faux-llm-ext 注册点），二档互切必产生实际变更
      const targetLevel = currentLevel === 'off' ? 'low' : 'off'
      await fx.sendCommand('set_thinking_level', { level: targetLevel })
      const thinking = await fx.waitForEvent((e) => e.type === 'thinking_level_changed')
      expect(thinking.level).toBe(targetLevel)

      // ── 事件 3：message_end（真实 prompt 对话，user + assistant 各至少一条）──
      await fx.runTurn({ message: 'Reply with exactly the word: w25-contract' }, TURN_TIMEOUT_MS_m2)
      const messageEnds = fx.collectEvents((e) => e.type === 'message_end')
      expect(messageEnds.length).toBeGreaterThanOrEqual(2)
      const messageEndRoles = messageEnds.map((e) => e.message?.role)
      expect(messageEndRoles).toContain('user')
      expect(messageEndRoles).toContain('assistant')

      // ── 事件 4：queue_update（steer 入队触发；放在 prompt 之后，避免排队消息注入对话）──
      await fx.sendCommand('steer', { message: 'w25-queue-probe' })
      const queue = await fx.waitForEvent((e) => e.type === 'queue_update')
      expect(queue.steering).toContain('w25-queue-probe')

      // 事件范围核验完成：契约清单除 entry_appended（下方 D5 负向断言）外全部实测出现
      for (const t of CONTRACT_EVENT_TYPES) {
        if (t === 'entry_appended') continue
        expect(fx.collectEvents((e) => e.type === t).length).toBeGreaterThan(0)
      }

      // ── D5 固化（交付物 2）：message entry 不经 entry_appended 广播是当前契约。
      //    上面整段操作（改名 → entry 持久化、切 thinking → entry 持久化、真实对话 →
      //    message entry 持久化）产生 N 条事件流 + M 条持久化 entry，其中不得出现 message
      //    载体的 entry_appended——上游若补发射，此断言红 → 走 W21 预留换源适配，而非静默分叉。
      //    [2026-08 pi 0.84.4 升级核实] 断言从「0 条 entry_appended」收窄为「0 条 message 载体」：
      //    fixture 虽锁定无 --extension 参数，pi 全局扩展发现仍会加载 ~/.pi/agent 下已装扩展
      //    （如实测环境的 cache-probe），其 appendEntry 的 custom 载体广播属 extension 行为，
      //    不构成上游 message 语义漂移——A/B 对照（0.84.1 vs 0.84.4）确认 pi 两侧均未补发。
      const allEvents = fx.collectEvents()
      expect(allEvents.length).toBeGreaterThanOrEqual(10) // 非空转检查（实测 ~25+）
      const messageEntryAppended = fx
        .collectEvents((e) => e.type === 'entry_appended')
        .filter((e) => (e['entry'] as Record<string, unknown> | undefined)?.['type'] === 'message')
      expect(messageEntryAppended).toHaveLength(0)

      // ── ③ entry 面：真实 get_entries 产物 ──
      const entriesResp = await fx.sendCommand('get_entries')
      const entriesData = asRecord(entriesResp.data)
      const entries = entriesData.entries
      if (!Array.isArray(entries)) throw new Error('get_entries reply has no entries array')
      // 持久化非空检查：启动元数据 2 条（model_change + thinking_level_change）+ 改名 1 条 +
      // 切档 1 条 + 对话 ≥2 条（user/assistant message）——「M 条 entry 持久化 + 0 条
      // entry_appended」的 M 侧证据
      expect(entries.length).toBeGreaterThanOrEqual(5)
      const rawEntries = entries.map((e: unknown) => asRecord(e))

      const observedTypes = assertObservedEntryTypesKnown(rawEntries.map((e) => String(e.type)))
      // 本操作序列的必达集合：message（对话）+ session_info（改名 RPC 直写）
      expect(observedTypes.has('message')).toBe(true)
      expect(observedTypes.has('session_info')).toBe(true)

      // 真实产物侧证：get_entries 产出含 message entry 且能通过穷举检查。
      // 「case 全集可达性」的运行时循环已删——文件编译通过后类型化字面量恒命中
      // case（default 对 PiEntry 成员不可达），该循环不可能红，全集证明由
      // assertReducerCaseCoverage 的编译期 never 检查独自承载。
      const messageEntry = rawEntries.find((e) => e.type === 'message')
      expect(messageEntry).toBeDefined()
      assertReducerCaseCoverage(messageEntry as unknown as PiEntry)

      console.log(
        `[W25 contract] D5 固化证据：${allEvents.length} 事件 0 条 entry_appended | ` +
        `get_entries ${entries.length} 条（类型：${[...observedTypes].join(', ')}）`,
      )

      await fx.dispose()
      fixture = null
    },
  )
})
});

// ======================================================================
// ← src/__tests__/equivalence/session-manager-e2e-fixture-unit.test.ts
// ======================================================================

// runtime 包根（本文件位于 src/__tests__/equivalence/）——消费方相对路径基准，
// 输出形态与 REAL_PI_TESTS 成员一致（'src/...test.ts' / 'test/...test.ts'）
const RUNTIME_ROOT = resolve(__dirname, '..', '..', '..')


/** 递归收集 dir 下全部 .test.ts 的 POSIX 相对路径（标准库 readdirSync，勿引 glob 依赖） */
function collectTestFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectTestFiles(full))
    else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      out.push(relative(RUNTIME_ROOT, full).split(sep).join('/'))
    }
  }
  return out
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-manager-e2e-fixture-unit', () => {
describe('U9-U1 full-e2e 探针基建单元校验', () => {
  it('REAL_PI_TESTS 与 spawnPiFixture 消费方全量双向同步', () => {
    const configPath = resolve(RUNTIME_ROOT, 'vitest.config.ts')
    const config = readFileSync(configPath, 'utf-8')

    // 消费侧：src/ 与 test/ 两目录中 import spawnPiFixture 的 .test.ts 全集。
    // 文本匹配不做 AST 解析；import 存在单行与多行两种书写形态，故先把全文空白归一，
    // 再做「整句结构」匹配：导入清单花括号内含目标名，且来源模块指向 pi-fixture，两者
    // 同时成立才算消费方。不能退化为裸标识符匹配——本检查文件也在被扫描目录内，自身
    // 错误消息里的同名文案会造成自匹配假红。
    const importShape = /import\s*\{[^{}]*\bspawnPiFixture\b[^{}]*\}\s*from\s*['"][^'"]*pi-fixture(\.js)?['"]/
    // 轨道判定的 import 信号（同款「整句结构」匹配，防裸标识符自匹配）：REAL_PI_READY =
    // 真实 LLM 层门控（SSOT 在 real-pi-gate.ts，历史形态自 pi-fixture import 亦兼容）；
    // FAUX_PI_READY = faux 层门控（凭证无关）。
    const realReadyShape =
      /import\s*\{[^{}]*\bREAL_PI_READY\b[^{}]*\}\s*from\s*['"][^'"]*(pi-fixture|real-pi-gate)(\.js)?['"]/
    const fauxReadyShape = /import\s*\{[^{}]*\bFAUX_PI_READY\b[^{}]*\}\s*from\s*['"][^'"]*pi-fixture(\.js)?['"]/
    // 集成门控信号：文件 import INTEGRATION_TESTS_ENABLED（test-guard/integration-gate.ts
    // 或引擎包内 integration-gate.local 副本）→ spawnPiFixture 调用位于门控 describe 内，
    // 本地默认跳过、CI 由 env=1 启用——真进程面受控，豁免串行尾组登记（文件保留的
    // 快速用例继续占 main 满并行组）。
    const integrationGateShape =
      /import\s*\{[^{}]*\bINTEGRATION_TESTS_ENABLED\b[^{}]*\}\s*from\s*['"][^'"]*integration-gate(\.local)?(\.ts)?['"]/
    const consumers: string[] = []
    /** 纯 faux 层文件（有 FAUX 门控、无 REAL 门控 → 无真实 LLM turn 用例，豁免登记） */
    const fauxTrackFiles: string[] = []
    /** 集成门控文件（spawn 用例受 TAIJI_TEST_INTEGRATION 门控，豁免登记） */
    const integrationGatedFiles: string[] = []
    for (const dir of ['src', 'test']) {
      for (const rel of collectTestFiles(join(RUNTIME_ROOT, dir))) {
        const flattened = readFileSync(resolve(RUNTIME_ROOT, rel), 'utf-8').replace(/\s+/g, ' ')
        if (!importShape.test(flattened)) continue
        consumers.push(rel)
        if (!realReadyShape.test(flattened) && fauxReadyShape.test(flattened)) fauxTrackFiles.push(rel)
        if (integrationGateShape.test(flattened)) integrationGatedFiles.push(rel)
      }
    }

    // 配置侧：按字符串字面量静态提取（走配置 import 会拉起 globalSetup，超出 unit 校验边界）。
    // 数组成员行间穿插 // 注释，注释内可含方括号（如 [HISTORICAL ...]）——结束边界不能用
    // 「下一个 ']' 字符」判定：会命中注释内的闭合括号，把提取截断成空集（2026-10-20 真实
    // LLM 层用例登记后即触发「已登记却报未登记」误报）。改按行扫描：注释行跳过，行首
    // （去缩进）']' 即数组结束（'] as const' 同形态命中）。
    const extractPoolArray = (decl: string): string[] => {
      const start = config.indexOf(decl)
      expect(start, `vitest.config.ts 找不到 ${decl} 数组声明——检查提取逻辑需随配置形态更新`).toBeGreaterThanOrEqual(0)
      const members: string[] = []
      for (const line of config.slice(start).split('\n')) {
        const trimmed = line.trim()
        if (trimmed.startsWith('//')) continue
        if (trimmed.startsWith(']')) break
        for (const match of trimmed.matchAll(/['"]([^'"]+\.test\.ts)['"]/g)) {
          if (match[1]) members.push(match[1])
        }
      }
      return members
    }
    const registeredRealPi = extractPoolArray('const REAL_PI_TESTS = [')
    const registeredIntegration = extractPoolArray('const INTEGRATION_TESTS = [')
    const registered = [...registeredRealPi, ...registeredIntegration]
    // [L2.5 二批后允许空池] 全部真实 LLM 用例已迁组 faux，REAL_PI_TESTS 当前 0 成员是合法
    // 终态（数组保留为「新增真实 LLM 文件必须登记」的注册位）；检查的提取断言点 =
    // 数组声明可定位（上方 start），不再要求非空。

    // 双向 diff：漏登记（消费方未进任一尾组，落回 main 满并行组复发饿死超时；纯 faux
    // 层例外，见文件头豁免说明）+ 失效项（清单成员在磁盘已不存在，文件删除/改名后清单未同步）
    const unregistered = consumers
      .filter((p) => !registered.includes(p) && !fauxTrackFiles.includes(p) && !integrationGatedFiles.includes(p))
      .sort()
    const staleOnDisk = registered.filter((p) => !existsSync(resolve(RUNTIME_ROOT, p)))

    const problems: string[] = []
    if (unregistered.length > 0) {
      problems.push(
        `以下 ${unregistered.length} 个文件 import spawnPiFixture 但未登记任一尾组（REAL_PI_TESTS / INTEGRATION_TESTS）：\n`
          + unregistered.map((p) => `  ${p}`).join('\n')
          + '\n👉 真实 LLM 层文件把该路径加入 packages/runtime/vitest.config.ts 的 REAL_PI_TESTS；'
          + '真进程 / 真 IO 集成组文件加入 INTEGRATION_TESTS（用例挂 TAIJI_TEST_INTEGRATION 门控）；'
          + 'spawn 用例用例级门控（文件 import INTEGRATION_TESTS_ENABLED、快速用例留默认组）同样合法；'
          + '纯 faux 层文件（无真实 LLM turn 用例）改为门控 FAUX_PI_READY'
          + '（describe.skipIf(!FAUX_PI_READY) + spawn 传 fauxResponses）即豁免登记',
      )
    }
    if (staleOnDisk.length > 0) {
      problems.push(
        `REAL_PI_TESTS / INTEGRATION_TESTS 中 ${staleOnDisk.length} 个路径在磁盘上不存在（文件删除/改名后清单未同步）：\n`
          + staleOnDisk.map((p) => `  ${p}`).join('\n')
          + '\n👉 从 packages/runtime/vitest.config.ts 的对应数组移除失效路径',
      )
    }
    if (problems.length > 0) throw new Error(`\n${problems.join('\n\n')}`)
  })

  // [2026-09 测试舰队审查 r2-26] it2「writeLine 行以换行符结尾」已删：它构造等价闭包
  // （endsWith 条件追加）再断言闭包自身——恒真且与 pi-fixture.ts:521-523 真实实现
  // （无条件 `line + '\n'`）行为不一致，属「恒真 + 语义漂移」双重问题。
})
});

// ======================================================================
// ← src/__tests__/equivalence/tool-call-index.test.ts
// ======================================================================

// ── 探针抓包样本（照抄，2026-08-20 /tmp 隔离探针）──────────
// 0.84.1 历史样本（与实装的行为等价性见头部契约漂移注释）：message_update 恒无顶层
// message；toolcall_start 无 id（0.84.4 起增顶层 id/toolName）；toolcall_end 携带完整
// toolCall；id 与 tool_execution_start 同值。
const WIRE_TOOLCALL_START = {
  type: 'message_update',
  assistantMessageEvent: { type: 'toolcall_start', contentIndex: 1 },
}

const WIRE_TOOLCALL_END = {
  type: 'message_update',
  assistantMessageEvent: {
    type: 'toolcall_end',
    contentIndex: 1,
    toolCall: {
      type: 'toolCall',
      id: 'call_54c7b7e7b4d944c98f05c3db',
      name: 'bash',
      arguments: { command: 'echo PROBE-W3-DONE .' },
    },
  },
}

const WIRE_TOOL_EXECUTION_START = {
  type: 'tool_execution_start',
  toolCallId: 'call_54c7b7e7b4d944c98f05c3db',
  toolName: 'bash',
  args: { command: 'echo PROBE-W3-DONE .' },
}


/** 翻译 + 编排全链路（生产帧链同构 chaos.test.ts：translate → interpreter.interpret） */
async function runThroughInterpreter(events: object[], sid: string): Promise<ServerMessage[]> {
  const frames: ServerMessage[] = []
  const interpreter = new EventInterpreter(sid, { send: (msg) => frames.push(msg) })
  for (const ev of events) {
    interpreter.interpret(translate(ev as unknown as PiEvent, sid))
    // tool-call-start 的 hook 异步路径 flush（chaos.test.ts 同款 macrotask 间隔）
    await new Promise((r) => setTimeout(r, 0))
  }
  return frames
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('tool-call-index', () => {
describe('W3 tool-call-index: translate 提取（真实 wire 形态 mock，凭证无关）', () => {
  it('toolcall_end（wire 形态）产出 tool-call-index（toolCallId + contentIndex）', () => {
    const events = translate(WIRE_TOOLCALL_END as unknown as PiEvent, 's')
    expect(events).toEqual([
      { kind: 'tool-call-index', toolCallId: 'call_54c7b7e7b4d944c98f05c3db', contentIndex: 1 },
    ])
  })

  it('toolcall_start（0.84.1 历史 wire 形态：无 id、无顶层 message）noop 保留 + 追加 llm-first-output（设计 §3.2）', () => {
    // 旧 bug 回归锚：0.84.1 wire 上此事件拿不到 id（partial 被剥离；0.84.4 起增顶层
    // id/toolName，见头部契约漂移注释）；若实现退回从 event.message 提取，本用例与
    // 上一用例的组合即复现「恒 undefined 生产死」——tool-call-index 仍不得从 start 产出。
    // composer-genstats-ttft（设计 §3.2 首输出结算）：toolcall_start 追加 llm-first-output
    //（纯 tool_call 响应无 text_start，本子类型是该形态唯一首输出信号）；原 noop 翻译
    // 保留（无前端行为），仅追加采样信号。
    const events = translate(WIRE_TOOLCALL_START as unknown as PiEvent, 's')
    expect(events).toEqual([
      { kind: 'noop' },
      { kind: 'llm-first-output', sessionId: 's' },
    ])
  })

  it('全链路：tool-call-index 锚点附到 tool_call_start WS 帧 entry.contentIndex', async () => {
    const frames = await runThroughInterpreter(
      [WIRE_TOOLCALL_START, WIRE_TOOLCALL_END, WIRE_TOOL_EXECUTION_START],
      'w3-mock',
    )
    const startFrame = frames.find((f) => f.type === 'message.tool_call_start')
    expect(startFrame).toBeDefined()
    const entry = (startFrame as unknown as { payload: { entry?: { contentIndex?: number; toolCallId?: string } } }).payload.entry
    // 锚点语义：contentIndex 来自 toolcall_end（顺序锚点），toolCallId 与 tool_execution_start 配对
    expect(entry?.contentIndex).toBe(1)
    expect(entry?.toolCallId).toBe('call_54c7b7e7b4d944c98f05c3db')
  })
})
describe.skipIf(!INTEGRATION_TESTS_ENABLED)(
  `W3 tool-call-index: 真实 pi wire 契约锁定（faux-pi 子进程${INTEGRATION_TESTS_SKIP_REASON ? `｜skip：${INTEGRATION_TESTS_SKIP_REASON}` : ''}）`,
  () => {
  let fixture: PiFixture | null = null
  const sid = 'w3-toolcall'

  // 失败兜底（设计 U3/G1）：语料轮失败后在途 turn 由 recover 截断，防传染；幂等
  afterEach(async () => {
    await fixture?.recover()
  })

  // faux 层（L2.5 迁组）：toolCalls 步骤 100% 确定——真实 LLM 时代的「偶尔纯文本回复
  // 不调工具」三连发重试护栏 [HISTORICAL 2026-08-22] 已随迁组删除（脚本化 toolCall
  // 不存在不确定性；语料检查仍要求 toolcall 事件存在，断言强度不变）。hook 显式超时
  // 保留（[HISTORICAL] 2026-08-20 PR #185：vitest 默认 hookTimeout 10s 在负载下先杀
  // hook）。
  beforeAll(async () => {
    fixture = await spawnPiFixture({
      fauxResponses: [
        { toolCalls: [{ name: 'bash', args: { command: 'echo W3-TOOLCALL-ANCHOR .' } }] },
        { text: 'W3-TOOLCALL-ANCHOR' },
      ],
    })
    // runTurn 原语（设计 D4/U3）：原子化打点→prompt→只等本轮 agent_end
    await fixture.runTurn(
      {
        message:
          'Use the bash tool to run exactly: echo W3-TOOLCALL-ANCHOR . You must call the bash tool before replying; after the tool finishes, reply with the tool output text.',
      },
      120_000,
    )
  }, 420_000)

  afterAll(async () => {
    await fixture?.dispose()
  })

  it('wire 契约：全部 message_update 事件无顶层 message 字段', () => {
    const fx = fixture!
    const updates = fx.collectEvents((e) => e.type === 'message_update')
    // 语料检查：含工具调用的对话必有 message_update 流
    expect(updates.length).toBeGreaterThan(0)
    for (const u of updates) {
      expect('message' in u && u.message !== undefined).toBe(false)
    }
  })

  it('wire 契约：toolcall_end 携带 toolCall.id + contentIndex；toolcall_start 携带顶层 id/toolName（pi 0.84.4+）', () => {
    const fx = fixture!
    const subEvents = fx
      .collectEvents((e) => e.type === 'message_update')
      .map((e) => e.assistantMessageEvent as Record<string, unknown>)
    const ends = subEvents.filter((s) => s?.type === 'toolcall_end')
    const starts = subEvents.filter((s) => s?.type === 'toolcall_start')
    expect(ends.length).toBeGreaterThan(0)
    expect(starts.length).toBeGreaterThan(0)
    for (const s of ends) {
      expect(typeof (s.toolCall as { id?: unknown } | undefined)?.id).toBe('string')
      expect(typeof s.contentIndex).toBe('number')
    }
    for (const s of starts) {
      // [哨兵触发 2026-08-29] pi 0.84.4 起 toJsonAssistantMessageEvent 把 id/toolName 提升到
      // wire 顶层（dist/modes/json-event.js），0.84.1 形态（start 无 id）不再成立。生产提取点
      // 维持 toolcall_end（event-adapter.ts：toolCallId 与 tool_execution_start 配对，由
      // 「真实产出」用例锁定）；start.id 仅是更早锚点信息，提取点不前移。
      expect(s.toolCall).toBeUndefined()
      expect(typeof s.id).toBe('string')
      expect(typeof s.toolName).toBe('string')
    }
  })

  it('tool-call-index 真实产出：translate(真实 toolcall_end) 产出锚点事件，id 与 tool_execution_start 配对', () => {
    const fx = fixture!
    const events = fx.collectEvents()
    // translate 整流：所有 toolcall_end 事件都应产出 tool-call-index
    const toolcallEnds = events.filter(
      (e) => (e.assistantMessageEvent as { type?: string } | undefined)?.type === 'toolcall_end',
    )
    const anchorEvents = toolcallEnds.flatMap((e) => translate(e as unknown as PiEvent, sid))
    expect(anchorEvents.length).toBe(toolcallEnds.length)
    for (const a of anchorEvents) {
      expect(a.kind).toBe('tool-call-index')
    }
    // 配对语义：锚点 toolCallId ⊆ tool_execution_start 的 toolCallId 全集（顺序锚点可被
    // interpreter 缓存消费，前端按 contentIndex 有序插入）。
    const execIds = new Set(
      fx
        .collectEvents((e) => e.type === 'tool_execution_start')
        .map((e) => e.toolCallId as string),
    )
    expect(execIds.size).toBeGreaterThan(0)
    for (const a of anchorEvents) {
      if (a.kind === 'tool-call-index') {
        expect(execIds.has(a.toolCallId)).toBe(true)
      }
    }
  })

  it('时序锚点：首个 toolcall_end 事件到达于首个 tool_execution_start 之前', () => {
    const fx = fixture!
    const events = fx.collectEvents()
    const firstEndIdx = events.findIndex(
      (e) => (e.assistantMessageEvent as { type?: string } | undefined)?.type === 'toolcall_end',
    )
    const firstExecIdx = events.findIndex((e) => e.type === 'tool_execution_start')
    expect(firstEndIdx).toBeGreaterThanOrEqual(0)
    expect(firstExecIdx).toBeGreaterThanOrEqual(0)
    // toolcall_end（LLM 流中工具参数输出完成）恒早于 tool_execution_start（assistant
    // message 完成后执行工具）——顺序锚点语义的前提（§11 检查点 3）。
    expect(firstEndIdx).toBeLessThan(firstExecIdx)
  })
})
});
