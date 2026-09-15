/**
 * sd-u5 / 根单元聚合 send 排队真机 e2e（S1 场景）— design.md §4 S1 / G1 的机器化。
 *
 * 与 completion-backflow-e2e.test.ts（S2）同款驱动形态：spawn 真实 pi rpc 子进程
 * （目标 session），驱动器接上 **真实** SessionDeliveryRegistry（真 delivery 内核），
 * 仅 SessionService 由驱动器以最小内存态 view 替换（组合根 agent_settled 多播的事件泵形态）。
 *
 * 断言链（事件同步，禁固定 sleep；两条驱动纪律见 design.md §4——busy 前提必须结构化断言）：
 * 长任务 prompt（dispatcher 同款先置位后 prompt）→ waitUntil assistant message_start（streaming
 * 证据）→ get_state 结构化断言 isStreaming === true（busy 前提，防 idle 假通过）→
 * 经 registry（真实 delivery.sendChecked）投递第二条 PROBE → sendChecked resolve + 队列深度 1
 * （busy 入队不拒绝 = session-manager send 工具 `{queued: true}` 语义的投递入口侧机器化）→
 * waitUntil 第二个 turn_start（turn 边界）+ PROBE 作为 user message 出现（message_start 边沿）→
 * PROBE turn 的 assistant ACK message_end（run 定局）→ 队列清空（depth === 0）→
 * get_entries 校验 PROBE user entry 晚于长任务 user entry（下一 turn 开头注入的持久化证据）。
 *
 * 内核投递路径双形态均验收通过（design.md §3.3 实测结论，殊途同归到同一终态断言）：
 * 主路径 = agent_settled 边沿 → 事件泵复位 isGenerating + 多播 → 内核 flush → prompt(steer)；
 * 兜底路径 = 退避打满（100ms × 50）强制 doSend → streaming 期间 prompt(steer) 受理入 pi 队列，
 * turn 边界由 pi drain（streamingBehavior 是 runtime 通路的安全网）。
 *
 * 环境约定照抄 equivalence 族（pi-fixture.ts）。faux LLM 轨（L2.5 翻轨）：被测语义是
 * 「busy 期间 sendChecked 受理入队 → turn 边界注入 → 队列清空」，非模型智能——长任务
 * 的「长」由 TAIJI_FAUX_TPS 节流制造（真实 LLM 天然慢 vs faux 毫秒级，节流给出同等
 * 宽度的流式窗口，断言（pendingMessageCount / entry 顺序）不依赖节奏）；PROBE turn
 * 的 ACK 回复由脚本固定。门控 FAUX_PI_READY（只判 binary，凭证无关、CI 可跑）。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/equivalence/send-queue-e2e.test.ts
 * 入口脚本：bash scripts/cw-acceptance/sd-e2e.sh S1（标记行由外层 cw 命令包装，exit code 透传）
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionDeliveryRegistry } from '../../services/session/session-delivery-registry.js'
import { applySessionOccupancyTransition } from '../../services/session/event-interpreter.js'
import type { IManagedSessionView } from '../../services/session/types.js'
import { spawnPiFixture, FAUX_PI_READY, FAUX_PI_SKIP_REASON, type PiFixture } from './pi-fixture.js'

/** 单步等待上限（任务护栏：每步最多 120s，真实 LLM 轮次余量）。
 * 60s 在全量套件并发跑（469 文件 + real-pi 进程）时余量不足，曾观测单步超时
 * （事件流完整走到 agent_settled 但目标谓词未命中）；单跑 9s，120s = 13 倍余量，仅校准护栏量级。 */
const STEP_TIMEOUT_MS = 120_000
/** 第二条消息唯一标记（user message 注入断言锚点） */
const PROBE_MARK = 'PROBE-SD1:'
/** PROBE turn 的 assistant 定局标记（run 尾部边沿锚点） */
const ACK_MARK = 'SD1-ACK'
/** 长任务的 faux 节流（tokens/s）：1..40 数字串 ≈ 37 tokens → ~9s 流式窗口，足够
 *  覆盖 get_state 结构化断言 + sendChecked + 队列观察的测试侧耗时 */
const FAUX_TPS = '4'
/** 长任务的 faux 回复文本（计数序列——断言只锚 user entry 与 PROBE/ACK，回复内容不参与） */
const LONG_TASK_TEXT = Array.from({ length: 40 }, (_, i) => String(i + 1)).join('\n')

/** 驱动器内存态 view（runtime 侧状态标志的宿主：isIdle gate 读它） */
function makeView(id: string, cwd: string, label: string): IManagedSessionView {
  return {
    id,
    cwd,
    label,
    modelId: 'xiaomi-token-plan-cn/mimo-v2.5-pro',
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    tokenCount: 0,
    inputTokens: 0,
    isGenerating: false,
    isCompacting: false,
    isBashRunning: false,
    bashRunToken: undefined,
    sessionFilePath: undefined,
  }
}

/** pi message content 双形态（string / blocks 数组 [{type:'text',text}]）→ 纯文本 */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        typeof b === 'object' && b !== null && typeof (b as { text?: unknown }).text === 'string'
          ? (b as { text: string }).text
          : '',
      )
      .join('')
  }
  return ''
}

describe.skipIf(!FAUX_PI_READY)(`send queue e2e faux pi${FAUX_PI_READY ? '' : `（skip：${FAUX_PI_SKIP_REASON}）`}`, () => {
  it('S1 目标 session streaming 期间 sendChecked 第二条 → resolve 不拒绝（queued 语义）→ turn 边界注入 PROBE → 队列清空', { timeout: 150_000 }, async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'sd1-sendqueue-'))
    let targetFx: PiFixture | undefined
    let pump: ReturnType<typeof setInterval> | undefined
    try {
      // ── 1. 真实 pi rpc 子进程（目标 session，fixture 不负责建目录）──
      // faux 轨：TPS 节流制造长任务流式窗口（spawn 前设置，finally 恢复）；
      // 队列 = [长计数文本（turn 1）, PROBE turn 的 ACK 回复（turn 2）]
      process.env.TAIJI_FAUX_TPS = FAUX_TPS
      const targetDir = join(dataRoot, 'target')
      mkdirSync(targetDir, { recursive: true })
      targetFx = await spawnPiFixture({
        sessionDir: targetDir,
        fauxResponses: [{ text: LONG_TASK_TEXT }, { text: ACK_MARK }],
      })

      const state = await targetFx.sendCommand('get_state')
      const targetSessionId = (state.data as { sessionId?: string }).sessionId
      expect(targetSessionId, '目标 pi get_state 应返回 sessionId').toBeTruthy()

      // ── 2. 驱动器组装最小 runtime 组合（真 registry + 真内核）──
      // 内存态 view：isIdle gate 读 runtime 侧标志（isGenerating 由事件泵在 settled 边沿复位）
      const view = makeView(targetSessionId!, targetFx.sessionDir, 'sd1-target')

      // settled 多播（组合根 agentSettledListeners 的事件泵形态）：pi agent_settled 边沿 →
      // 复位 isGenerating + 分发订阅者。50ms 轮询与 fixture waitForEvent 的
      // EVENT_POLL_INTERVAL_MS 同构（事件边沿驱动，非固定 sleep）。
      const settledCbs: Array<(sid: string) => void> = []
      let lastSeenEventIdx = 0
      pump = setInterval(() => {
        const all = targetFx!.collectEvents()
        for (; lastSeenEventIdx < all.length; lastSeenEventIdx++) {
          if (all[lastSeenEventIdx]!.type === 'agent_settled') {
            applySessionOccupancyTransition(view, null, 'idle')
            for (const cb of [...settledCbs]) cb(targetSessionId!)
          }
        }
      }, 50)

      // registry：真实实现；ensureActive 返回目标 pi 的最小 client adapter
      // （prompt → pi stdin JSONL，streamingBehavior 透传——pi preflight 受理即回）
      const registry = createSessionDeliveryRegistry({
        getSession: (sid) => (sid === targetSessionId ? view : undefined),
        ensureActive: async (sid: string) => {
          if (sid !== targetSessionId) throw new Error(`unexpected ensureActive target: ${sid}`)
          return {
            prompt: async (content: string, _sessionId?: string, streamingBehavior?: 'steer' | 'followUp') => {
              const resp = await targetFx!.sendCommand('prompt', {
                message: content,
                ...(streamingBehavior ? { streamingBehavior } : {}),
              }, STEP_TIMEOUT_MS)
              expect(resp.success, `目标 pi prompt 应受理成功：${JSON.stringify(resp)}`).toBe(true)
            },
          } as unknown as never
        },
        subscribeAgentSettled: (cb) => {
          settledCbs.push(cb)
          return () => {}
        },
        recordWorkspace: () => {},
        getMessageBus: () => null,
      })

      // ── 3. 长任务（dispatcher 同款先置位后 prompt：busy 前提的 runtime 侧标志）──
      // u3c readonly 收口：经原语 #1 'dispatching' 行（对齐 dispatcher markSessionActive 语义）
      applySessionOccupancyTransition(view, null, 'dispatching')
      const sendResp = await targetFx.sendCommand('prompt', {
        message: 'Count from 1 to 40, one number per line, plain text only. Do not use any tools.',
      }, STEP_TIMEOUT_MS)
      expect(sendResp.success, '长任务 prompt 应受理成功').toBe(true)

      // ── 4. 事件同步：turn 1 开边沿 + assistant streaming 证据 ──
      const firstTurnStart = await targetFx.waitForEvent(
        (e) => e.type === 'turn_start',
        { timeoutMs: STEP_TIMEOUT_MS },
      )
      await targetFx.waitForEvent(
        (e) => e.type === 'message_start' && e.message?.role === 'assistant',
        { timeoutMs: STEP_TIMEOUT_MS },
      )

      // ── 5. busy 前提结构化断言（G1 核心：目标 idle 时场景同样满足，不断言则排队路径假通过）──
      const midState = await targetFx.sendCommand('get_state')
      const mid = midState.data as { isStreaming?: boolean; pendingMessageCount?: number }
      expect(mid.isStreaming, `streaming 中 get_state.isStreaming 应为 true，实际：${JSON.stringify(mid)}`).toBe(true)

      // ── 6. 经 registry 投递第二条（真实 delivery.sendChecked）：resolve = pi streaming 队列受理（{queued:true} 语义）──
      const handle = registry.getOrCreateDelivery(targetSessionId!)
      const beforePending = mid.pendingMessageCount ?? 0
      await expect(
        handle.sendChecked({ payload: { kind: 'text', content: `${PROBE_MARK} The counting task is over now. Reply with exactly: ${ACK_MARK} and nothing else.` } }),
        'busy 期间 sendChecked 应受理 resolve（pi streaming 受理即回，内核 #8），不得 reject',
      ).resolves.toBeUndefined()
      expect(handle.depth(), 'sendChecked 受理后消息应已出内核队列（入 pi streaming 队列，非内核滞留）').toBe(0)
      // pi 侧受理结构化断言（纪律①：结果必须结构化断言，不只依赖 resolve）：steer 队列 pending +1
      const afterState = await targetFx.sendCommand('get_state')
      const after = afterState.data as { isStreaming?: boolean; pendingMessageCount?: number }
      expect(
        (after.pendingMessageCount ?? 0) > beforePending,
        `直投受理后 pi pendingMessageCount 应增加（before=${beforePending}, after=${JSON.stringify(after)}）`,
      ).toBe(true)

      // ── 7. turn 边界注入：第二个 turn_start + PROBE 作为 user message 出现 ──
      await targetFx.waitForEvent(
        (e) => e.type === 'turn_start' && e !== firstTurnStart,
        { timeoutMs: STEP_TIMEOUT_MS },
      )
      const probeUser = await targetFx.waitForEvent(
        (e) => e.type === 'message_start' && e.message?.role === 'user' && contentToText(e.message?.content).includes(PROBE_MARK),
        { timeoutMs: STEP_TIMEOUT_MS },
      )
      expect(contentToText(probeUser.message?.content)).toContain(PROBE_MARK)

      // ── 8. PROBE turn 定局（assistant ACK 边沿 = run 尾部信号）──
      await targetFx.waitForEvent(
        (e) => e.type === 'message_end' && e.message?.role === 'assistant' && contentToText(e.message?.content).includes(ACK_MARK),
        { timeoutMs: STEP_TIMEOUT_MS },
      )

      // ── 9. settled 后断言队列清空 ──
      expect(handle.depth(), 'PROBE 注入 + run 定局后队列应清空').toBe(0)

      // ── 10. get_entries 终态校验：PROBE user entry 晚于长任务 user entry（下一 turn 开头注入的持久化证据）──
      const entriesResp = await targetFx.sendCommand('get_entries', {}, STEP_TIMEOUT_MS)
      const entries = (entriesResp.data as { entries?: Array<{ type?: string; message?: { role?: string; content?: unknown } }> }).entries ?? []
      const userIdx: number[] = []
      let longTaskIdx = -1
      let probeIdx = -1
      entries.forEach((e, i) => {
        if (e.type !== 'message' || e.message?.role !== 'user') return
        userIdx.push(i)
        const text = contentToText(e.message?.content)
        if (text.includes('Count from 1 to 40')) longTaskIdx = i
        if (text.includes(PROBE_MARK)) probeIdx = i
      })
      expect(userIdx.length, `应有两条 user message（长任务 + PROBE），实际：${JSON.stringify(entries.map((e) => ({ t: e.type, r: e.message?.role })))}`).toBeGreaterThanOrEqual(2)
      expect(longTaskIdx, '长任务 user message 应已入树').toBeGreaterThanOrEqual(0)
      expect(probeIdx, `PROBE user message 应已入树（${PROBE_MARK}）`).toBeGreaterThan(longTaskIdx)
    } finally {
      if (pump !== undefined) clearInterval(pump)
      await targetFx?.dispose().catch(() => {})
      delete process.env.TAIJI_FAUX_TPS
      rmSync(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
