/**
 * 统一投递 send 队列真机 e2e（u5a 改写：v3 受理即出站语义）— 统一消息投递重构设计 §3.6 /
 * §3.2 支撑事实①②的机器化。改写自 sd-u5 S1（v2「busy 排队（queued 语义）」断言）：
 * v3 受理即出站下文本提交即 `prompt(streamingBehavior)` 出站，pi 唯一队列忙时入队不拒
 * （agent-session.js:1515-1524）——被测语义从「内核本地排队等 settled 边沿」变为
 * 「受理即出站入 pi 队列 → pi 原生出队注入」（改写理由登记 runlog；断言不删不放宽，
 * 锚定的终态事实链不变：受理可达 → 队列快照可见 → turn 边界注入 → 送达终局）。
 *
 * 与 completion-backflow-e2e.test.ts（S2）同款驱动形态：spawn 真实 pi rpc 子进程
 * （目标 session），驱动器接上 **真实** SessionDeliveryRegistry（真 delivery 内核，
 * v3 on-accept 装配），仅 SessionService 由驱动器以最小内存态 view 替换（组合根
 * agent_settled 多播的事件泵形态）。
 *
 * 断言链（事件同步，禁固定 sleep；两条驱动纪律见原 design.md §4——busy 前提必须结构化断言）：
 * 长任务 prompt（dispatcher 同款先置位后 prompt）→ waitUntil assistant message_start（streaming
 * 证据）→ get_state 结构化断言 isStreaming === true（busy 前提，防 idle 假通过）→
 * 经 registry.submit（delivery.submit 真实入口）投递第二条 PROBE → 受理回执 lane='steer'
 *（活跃 run 期提交不排队，受理即出站——v2 同值：generating 本就不持；语义差由注释与
 * 出站时点断言承载）→ pi pendingMessageCount 增加（prompt(steer) 受理入队）→
 * **queue_update 快照消费**（§3.6 新增）：PROBE 入队后 registry.piQueueDepth ≥1（文本镜像
 * 口径）、出队注入后归 0 → waitUntil PROBE 作为 user message 出现（message_start 边沿）→
 * **在途登记回执关闭**（A8 功能等价）：message_end(user) 裸标记命中 → entriesFull 终态
 * delivered → PROBE turn 的 assistant ACK message_end（run 定局）→ 队列清空（depth === 0）→
 * get_entries 校验 PROBE user entry 晚于长任务 user entry（下一 turn 开头注入的持久化证据）。
 *
 * 环境约定照抄 equivalence 族（pi-fixture.ts）。faux LLM 轨（L2.5 翻轨）：被测语义是
 * 「受理即出站入 pi 队列 → turn 边界注入 → 队列快照归零 → 送达回执关闭」，非模型智能
 * ——长任务的「长」由 TAIJI_FAUX_TPS 节流制造，PROBE turn 的 ACK 回复由脚本固定。
 * 门控 FAUX_PI_READY（只判 binary，凭证无关、CI 可跑）。
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
/** PROBE 的 clientUuid（真 uuid 形态：出站裸标记身份判据只认 uuid 段，registry 侧
 * message_end 回执命中通道依赖它；compaction e2e 同款约束） */
const PROBE_UUID = 'u-2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e'
/** 长任务的 faux 节流（tokens/s）：1..40 数字串 ≈ 37 tokens → ~3s 流式窗口（窗口宽度 ≈
 *  token/TPS，保持远宽于测试注入动作），足够覆盖 get_state 结构化断言 + submit +
 *  队列快照观察的测试侧耗时 */
const FAUX_TPS = '12'
/** 长任务的 faux 回复文本（计数序列——断言只锚 user entry 与 PROBE/ACK，回复内容不参与） */
const LONG_TASK_TEXT = Array.from({ length: 40 }, (_, i) => String(i + 1)).join('\n')

/** 驱动器内存态 view（runtime 侧状态标志的宿主：holdReason 判定读它） */
function makeView(id: string, cwd: string, label: string): IManagedSessionView {
  return {
    id,
    cwd,
    label,
    modelId: 'xiaomi-token-plan-cn/mimo-v2.6-flash',
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

/** 轮询等待（事件/状态谓词；超时以最后一次快照报错——禁固定 sleep） */
async function waitUntil(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs: number,
  describeState: () => Promise<string> | string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) {
      throw new Error(`waitUntil timeout (${timeoutMs}ms)：${await describeState()}`)
    }
    await new Promise((r) => setTimeout(r, 100))
  }
}

describe.skipIf(!FAUX_PI_READY)(`send queue e2e faux pi${FAUX_PI_READY ? '' : `（skip：${FAUX_PI_SKIP_REASON}）`}`, () => {
  it('S1 目标 session streaming 期间 submit 第二条 → 受理即出站入 pi 队列（快照可见）→ turn 边界注入 → 回执关闭 delivered', { timeout: 150_000 }, async () => {
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

      // ── 2. 驱动器组装最小 runtime 组合（真 registry + 真内核，v3 on-accept 装配）──
      // 内存态 view：holdReason 判定读 runtime 侧标志（isCompacting 由事件泵在压缩边沿翻转）
      const view = makeView(targetSessionId!, targetFx.sessionDir, 'sd1-target')

      // settled 多播 + 事件泵（组合根 agentSettledListeners 的事件泵形态）：pi 事件流 →
      // ①settled 边沿（对账触发点 + 持有等待者多源唤醒）②client.onEvent 订阅者转发面
      // （送达回执 message_end(user) / queue_update 快照 → registry watchClient）。
      // 50ms 轮询与 fixture waitForEvent 的 EVENT_POLL_INTERVAL_MS 同构（事件边沿驱动）。
      const settledCbs: Array<(sid: string) => void> = []
      const clientEventSubs = new Set<(event: unknown) => void>()
      let lastSeenEventIdx = 0
      pump = setInterval(() => {
        const all = targetFx!.collectEvents()
        for (; lastSeenEventIdx < all.length; lastSeenEventIdx++) {
          const ev = all[lastSeenEventIdx]!
          for (const cb of [...clientEventSubs]) cb(ev)
          if (ev.type === 'agent_settled') {
            applySessionOccupancyTransition(view, null, 'idle')
            for (const cb of [...settledCbs]) cb(targetSessionId!)
          }
        }
      }, 50)

      // registry：真实实现（v3 受理即出站装配）；ensureActive 返回目标 pi 的最小 client
      // adapter（prompt → pi stdin JSONL，streamingBehavior 透传——pi preflight 受理即回；
      // onEvent → 事件泵转发面，激活 message_end 回执与 queue_update 快照消费）
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
            onEvent: (cb: (event: unknown) => void) => {
              clientEventSubs.add(cb)
              return () => { clientEventSubs.delete(cb) }
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
      // u3c readonly 收尾：经原语 #1 'dispatching' 行（对齐 dispatcher markSessionActive 语义）
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

      // ── 5. busy 前提结构化断言（核心：目标 idle 时场景同样满足，不断言则出站路径假通过）──
      const midState = await targetFx.sendCommand('get_state')
      const mid = midState.data as { isStreaming?: boolean; pendingMessageCount?: number }
      expect(mid.isStreaming, `streaming 中 get_state.isStreaming 应为 true，实际：${JSON.stringify(mid)}`).toBe(true)

      // ── 6. 经 registry.submit（delivery.submit 真实入口）投递第二条：受理即出站语义 ──
      // v3：活跃 run 期提交不排队（lane='steer'），内核 on-accept 受理即 prompt(steer)
      // 出站入 pi 队列（agent-session.js:1515-1524 忙时不拒）。
      const submitReply = registry.submit(targetSessionId!, {
        content: `${PROBE_MARK} The counting task is over now. Reply with exactly: ${ACK_MARK} and nothing else.`,
        clientUuid: PROBE_UUID,
      })
      expect(submitReply, `受理回执应落 steer 车道（受理即出站，不排队）：${JSON.stringify(submitReply)}`).toMatchObject({
        clientUuid: PROBE_UUID,
        lane: 'steer',
        state: 'queued',
      })
      const handle = registry.getOrCreateDelivery(targetSessionId!)
      // 在途登记表（A8 功能等价·受理登记）：提交后条目在册，port 链 prompt 受理后转
      // in-flight（confirmAccepted，dmg-r1-4）——受理登记状态源断言
      await waitUntil(
        () => handle.entriesFull().active.some((e) => e.id === PROBE_UUID && e.state === 'in-flight'),
        STEP_TIMEOUT_MS,
        () => `内核 active = ${JSON.stringify(handle.entriesFull().active)}`,
      )
      // pi 侧受理结构化断言（纪律①：结果必须结构化断言）：steer 队列 pending +1
      const afterState = await targetFx.sendCommand('get_state')
      const after = afterState.data as { isStreaming?: boolean; pendingMessageCount?: number }
      expect(
        (after.pendingMessageCount ?? 0) > (mid.pendingMessageCount ?? 0),
        `受理即出站后 pi pendingMessageCount 应增加（before=${mid.pendingMessageCount}, after=${JSON.stringify(after)}）`,
      ).toBe(true)

      // ── 7. queue_update 快照消费（§3.6 新增）：入队后快照可见（文本镜像计数 ≥1）→
      //    turn 边界注入 PROBE → 出队后快照归零 ──
      await waitUntil(
        () => registry.piQueueDepth(targetSessionId!) >= 1,
        STEP_TIMEOUT_MS,
        () => `piQueueDepth = ${registry.piQueueDepth(targetSessionId!)}（queue_update 快照未观测到 PROBE 入队）`,
      )
      await targetFx.waitForEvent(
        (e) => e.type === 'turn_start' && e !== firstTurnStart,
        { timeoutMs: STEP_TIMEOUT_MS },
      )
      const probeUser = await targetFx.waitForEvent(
        (e) => e.type === 'message_start' && e.message?.role === 'user' && contentToText(e.message?.content).includes(PROBE_MARK),
        { timeoutMs: STEP_TIMEOUT_MS },
      )
      expect(contentToText(probeUser.message?.content)).toContain(PROBE_MARK)
      await waitUntil(
        () => registry.piQueueDepth(targetSessionId!) === 0,
        STEP_TIMEOUT_MS,
        () => `piQueueDepth = ${registry.piQueueDepth(targetSessionId!)}（PROBE 出队后快照应归零）`,
      )

      // ── 8. 在途登记回执关闭（A8 功能等价·回执关闭/终局判重）：message_end(user) 裸标记
      //    命中 → 条目 delivered 终局（两阶段回执第二阶段，D2）──
      await waitUntil(
        () => {
          const full = handle.entriesFull()
          return full.tombstones.some((t) => t.id === PROBE_UUID && t.state === 'delivered')
        },
        STEP_TIMEOUT_MS,
        () => `内核 full = ${JSON.stringify(handle.entriesFull())}`,
      )

      // ── 9. PROBE turn 定局（assistant ACK 边沿 = run 尾部信号）──
      await targetFx.waitForEvent(
        (e) => e.type === 'message_end' && e.message?.role === 'assistant' && contentToText(e.message?.content).includes(ACK_MARK),
        { timeoutMs: STEP_TIMEOUT_MS },
      )

      // ── 10. 定局后断言队列清空（在途登记不留活跃条目）──
      expect(handle.depth(), 'PROBE 注入 + run 定局后队列应清空').toBe(0)

      // ── 11. get_entries 终态校验：PROBE user entry 晚于长任务 user entry（下一 turn 开头注入的持久化证据）──
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
