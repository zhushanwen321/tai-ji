/**
 * live ≡ reload 等价性断言（W5 建立骨架，W21 升级为 store 级同构 + 混沌注入）。
 *
 * 不变量（W21，D5「单一 reducer 双路喂入」）：实时链路（message_end 事件流经 event-adapter
 * 重构 entry → applyEntry）与持久化链路（get_entries → replayEntries 同一 reducer）产出
 * **同一 ChatViewState**。这是构造性同构——断言不变量而非两个实现的等价：两侧喂同一个
 * core reducer，若 state 分叉只可能是喂入序列分叉（协议层 bug），不再是转换器实现漂移。
 *
 * 对应仓库规则 #9「对话流状态实时可见 + 重开 session 仍可见」的协议层基线。
 *
 * 归一化口径（喂入数据的物理差异，非实现差异，两侧同规则）：
 * - entry.id：live 侧 message_end 事件不带（pi 在 emit 之后才 appendMessage 分配 uuidv7，
 *   agent-session.ts:545-561）→ reload 侧剥 id，使两侧 deriveBaseId（`e<N>`）派生规则一致。
 * - bashExecution.timestamp：live 侧 bash 走 RPC reply（无 message_end 通道，recordBashResult
 *   直接 appendMessage），reply 无 timestamp → live 构造值与 reload 持久化值非同源，断言前归一。
 *
 * 边界（行为级留 P3 gate）：steer 消息投递依赖 streaming 窗口时序，其 user entry 与直接
 * prompt 同走 message_end 全量通道（本测试以多轮 prompt 覆盖 user/assistant/toolResult 序列）；
 * 后台 subagent 完成通知依赖扩展安装（fixture 无扩展），subagent 侧栏等价性留场景 3。
 *
 * faux LLM 轨（L2.5 翻轨）：验证对象是协议双通路（message_end 流 vs get_entries 重放）与
 * reducer 同构，非模型智能——turn 响应由 fauxResponses 脚本固定（bash toolCall + 文本回复，
 * 经 --approve 真实执行），断言语义与翻轨前一致。门控 FAUX_PI_READY（只判 binary，凭证无关、
 * CI 可跑，约定见 pi-fixture.ts 文件头）。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { existsSync } from 'node:fs'
import {
  spawnPiFixture,
  FAUX_PI_READY,
  FAUX_PI_SKIP_REASON,
  type PiFixture,
} from './pi-fixture.js'
import { translate } from '../../infra/pi/event-adapter.js'
import type { PiEvent } from '../../infra/pi/pi-protocol.js'
import {
  replayEntries,
  type ChatViewState,
  type PiEntry,
} from '../../../../core/src/domain/chat/apply-entry.js'

/** 等 turn 完成的上限（faux 轨实际毫秒级；名义上限保留翻轨前余量防 flake） */
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

describe.skipIf(!FAUX_PI_READY)(
  `equivalence: live ≡ reload（faux-pi 子进程${FAUX_PI_SKIP_REASON ? `｜skip：${FAUX_PI_SKIP_REASON}` : ''}）`,
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
      // 非空守卫（防 0 == 0 空转）：至少 user prompt + assistant 两条
      expect(liveEntries.length).toBeGreaterThanOrEqual(2)
      const liveState = replayEntries(liveEntries)

      // reload 侧：get_entries 全量重放（剥 id 对齐派生规则）
      const reloadEntries = await fetchReloadEntriesStripped(fx)
      expect(reloadEntries.length).toBeGreaterThan(0)
      const reloadState = replayEntries(reloadEntries)

      // store 级快照 deep equal（逐字段：messages 的 role/content/toolCalls/contentBlocks/
      // usage/thinking + clientUuidMap + orphanToolResults + 配对锚点）。
      // 协议依据（W5）：message_end.message ≡ 持久化 entry.message（同一对象）。
      expect(liveState.messages).toEqual(reloadState.messages)
      expect(liveState.clientUuidMap).toEqual(reloadState.clientUuidMap)
      expect(liveState.orphanToolResults).toEqual(reloadState.orphanToolResults)
      expect(liveState.lastAssistantWithToolCalls).toBe(reloadState.lastAssistantWithToolCalls)

      // 工具链路覆盖守卫：assistant 带 toolCalls 且 toolResult 已回填（非孤儿）
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
      // bash 消息守卫：两侧各恰好一条 bashExecution 且输出一致
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
    '混沌注入：乱序 / 丢失 / 重复投递 → 脏 state，权威重放后收敛到与纯重放一致',
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
      // 收敛：权威序列重放覆盖脏 state（快照对账——W22 broadcast≡get_state 全量化的基底）
      expect(replayEntries(reloadEntries)).toEqual(reloadState)

      // ── 混沌 2：丢失（drop 中间 entry）→ 脏；权威重放收敛 ──
      const dropped = liveEntries.filter((_, i) => i !== assistantIdx)
      const droppedState = replayEntries(dropped)
      expect(droppedState.messages.length).toBeLessThan(reloadState.messages.length)
      expect(replayEntries(reloadEntries)).toEqual(reloadState)

      // ── 混沌 3：重复投递（同 message_end 喂两次）→ messages 多一条（可检测脏化）；收敛 ──
      const duplicated = [...liveEntries, liveEntries[0]!]
      const dupState = replayEntries(duplicated)
      expect(dupState.messages.length).toBe(reloadState.messages.length + 1)
      // 收敛：reducer 确定性保证权威重放恒得同一 state（对账重建的依据）
      expect(replayEntries(reloadEntries)).toEqual(reloadState)

      await fx.dispose()
      fixture = null
    },
  )
})

// seenAgentEnds 计数谓词已删：多轮 agent_end 等待由 runTurn 的 since 打点取代（fixture 原语）
