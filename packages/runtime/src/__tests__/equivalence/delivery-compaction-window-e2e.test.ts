/**
 * 压缩窗口投递 equivalence e2e（投递所有权内核 V1 的机器化形态，A1 的 L3 形态）——
 * 设计 §3.1 失败故事 A 原景重写 / §4 V1「压缩中发送按序必达」/ P-e2e 探针。
 *
 * 形态与 send-queue-e2e.test.ts（S1）/ completion-backflow-e2e.test.ts（S2）同款：spawn 真实
 * pi rpc 子进程（目标 session），驱动器接上 **真实** SessionDeliveryRegistry（真 delivery 内核），
 * 仅 SessionService 由驱动器以最小内存态 view + 事件泵替换。压缩窗口由 runtime 权威投影
 * （`view.isCompacting`，生产路径 = session.compaction_start 置位）构造——被测语义是内核
 * 「不可投期间持有 → 压缩结束按 FIFO 逐条投递」，与压缩算法本身无关（压缩由 pi 执行）。
 *
 * 断言链（事件同步，禁固定 sleep；busy 前提结构化断言）：
 * 压缩中（isCompacting=true）经 registry.submit 提交两条（= delivery.submit 真实入口）→
 * 两条回执 lane='queued' 且内核 depth()===2（**压缩中零投递**：pi get_state.pendingMessageCount
 * ===0 且 transcript 无这两条文本——防「抢跑投递」假通过）→ 压缩结束（isCompacting=false +
 * agent_settled 边沿事件泵）→ 内核 flush 按 FIFO 逐条出站 → get_entries 断言两条 user entry
 * 在树且**顺序与提交序一致、各恰好一次**、各带自己的出站裸标记（D2 标记确认）→ 内核条目双终态
 * delivered（送达回执 message_end(user) 标记命中，D2 第二阶段）。
 *
 * 双车道事实（两条都在压缩结束后同批 flush，第二条的落点由 pi 当时状态决定，两条路径都合法）：
 * - pi 仍在 turn 1（faux TPS 节流制造流式窗口）→ prompt 撞 'Agent is already processing'
 *   → 内核适配器按 D6 转 steer 重试 → turn 边界注入（真实生产路径的同一分支）；
 * - pi 已 idle → 直投开新 turn。
 * 断言只锚终态（顺序 / 唯一性 / 标记 / delivered），不锚中间车道——车道是 pi 状态函数，
 * 结构上不可稳定构造（设计 D1 把 lane 判定收到 runtime 后仍是「当时状态」的函数）。
 *
 * 环境约定照抄 equivalence 族（pi-fixture.ts）。faux LLM 轨（L2.5）：被测语义是
 * 「压缩窗口的持有与释放按序投递」，非模型智能；门控 FAUX_PI_READY（只判 binary，凭证无关）。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/equivalence/delivery-compaction-window-e2e.test.ts
 * 登记：docs/testing/e2e-map.json E2E-EQUIV-01（equivalence 目录族，R2 按改动面触发）
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionDeliveryRegistry } from '../../services/session/session-delivery-registry.js'
import { applySessionOccupancyTransition } from '../../services/session/event-interpreter.js'
import type { IManagedSessionView } from '../../services/session/types.js'
import { spawnPiFixture, FAUX_PI_READY, FAUX_PI_SKIP_REASON, type PiFixture } from './pi-fixture.js'

/** 单步等待上限（任务护栏：每步最多 120s，真实进程轮次余量——与 send-queue-e2e 同口径） */
const STEP_TIMEOUT_MS = 120_000
/** 两条消息的唯一标记（user message 注入断言锚点；裸标记 = clientUuid 去 'u-' 前缀） */
const MARK_A = 'COMPACT-WINDOW-A:'
const MARK_B = 'COMPACT-WINDOW-B:'
const CLIENT_UUID_A = 'u-compact-window-a'
const CLIENT_UUID_B = 'u-compact-window-b'
const BARE_MARKER_A = 'compact-window-a'
const BARE_MARKER_B = 'compact-window-b'
/** turn 1 的 faux 节流（tokens/s）：计数序列 ≈ 30+ tokens → 秒级流式窗口，覆盖两次出站
 *  与断言链的测试侧耗时（第二条出站时 pi 大概率仍在 turn 1 → 走 D6 steer 重试分支） */
const FAUX_TPS = '6'
/** turn 1 的 faux 回复文本（计数序列——断言只锚 user entry 与标记，回复内容不参与） */
const LONG_TASK_TEXT = Array.from({ length: 36 }, (_, i) => String(i + 1)).join('\n')
/** turn 2 的 faux 回复（定局标记，run 尾部边沿锚点） */
const ACK_TEXT = 'COMPACT-WINDOW-ACK'

/** 驱动器内存态 view（runtime 侧状态标志的宿主：holdReason/lane 判定与内核 gate 读它） */
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
    // 压缩窗口前提：runtime 权威 occupancy 投影的压缩标志（生产 = compaction_start 置位）
    isCompacting: true,
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

describe.skipIf(!FAUX_PI_READY)(`delivery compaction window e2e faux pi${FAUX_PI_READY ? '' : `（skip：${FAUX_PI_SKIP_REASON}）`}`, () => {
  it('V1 压缩中提交两条 → 压缩窗口零投递 → 压缩结束按序逐条到达（标记确认 + delivered）', { timeout: 150_000 }, async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'cw-delivery-'))
    let targetFx: PiFixture | undefined
    let pump: ReturnType<typeof setInterval> | undefined
    let registry: ReturnType<typeof createSessionDeliveryRegistry> | undefined
    try {
      // ── 1. 真实 pi rpc 子进程（目标 session，fixture 不负责建目录）──
      process.env.TAIJI_FAUX_TPS = FAUX_TPS
      const targetDir = join(dataRoot, 'target')
      mkdirSync(targetDir, { recursive: true })
      targetFx = await spawnPiFixture({
        sessionDir: targetDir,
        fauxResponses: [{ text: LONG_TASK_TEXT }, { text: ACK_TEXT }],
      })

      const state = await targetFx.sendCommand('get_state')
      const targetSessionId = (state.data as { sessionId?: string }).sessionId
      expect(targetSessionId, '目标 pi get_state 应返回 sessionId').toBeTruthy()

      // ── 2. 驱动器组装最小 runtime 组合（真 registry + 真内核）──
      const view = makeView(targetSessionId!, targetFx.sessionDir, 'cw-target')

      // 事件泵：pi 事件流 → ①settled 边沿（内核 flush 触发点）②client.onEvent 订阅者
      // （送达回执 message_end(user) 的转发面——pi-fixture 是拉取式，故轮询转发）。
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

      // 适配器单例：生产 ensureActive 返回池内缓存句柄（同实例）——测试同样必须复用同一对象，
      // 否则每次返回新字面量会被 watchClient 判为「pi handle changed（respawned）」→ 触发
      // 无关的 pi-restored 对账（掩盖被测语义，日志噪音）。
      let clientAdapter: unknown
      registry = createSessionDeliveryRegistry({
        getSession: (sid) => (sid === targetSessionId ? view : undefined),
        ensureActive: async (sid: string) => {
          if (sid !== targetSessionId) throw new Error(`unexpected ensureActive target: ${sid}`)
          clientAdapter ??= {
            prompt: async (content: string, _sessionId?: string, streamingBehavior?: 'steer' | 'followUp') => {
              const resp = await targetFx!.sendCommand('prompt', {
                message: content,
                ...(streamingBehavior ? { streamingBehavior } : {}),
              }, STEP_TIMEOUT_MS)
              expect(resp.success, `目标 pi prompt 应受理成功：${JSON.stringify(resp)}`).toBe(true)
            },
            // 事件流（watchClient）：message_end(user) → 内核 confirmDelivered（D2 第二阶段）；
            // compaction_end → 持有释放条件（本用例的压缩窗口由 driver 直接结束，不依赖 pi 事件）
            onEvent: (cb: (event: unknown) => void) => {
              clientEventSubs.add(cb)
              return () => { clientEventSubs.delete(cb) }
            },
          }
          return clientAdapter as never
        },
        subscribeAgentSettled: (cb) => {
          settledCbs.push(cb)
          return () => {}
        },
        recordWorkspace: () => {},
        getMessageBus: () => null,
      })

      // ── 3. 压缩中提交两条（= delivery.submit 真实入口；renderer 统一提交语义）──
      const replyA = registry.submit(targetSessionId!, { content: `${MARK_A} 第一条`, clientUuid: CLIENT_UUID_A })
      const replyB = registry.submit(targetSessionId!, { content: `${MARK_B} 第二条`, clientUuid: CLIENT_UUID_B })

      // 压缩窗口 = 不可投 → lane/state 双 queued（D1 唯一判定源读 runtime 权威投影）
      expect(replyA, `压缩中提交应落 queued 车道：${JSON.stringify(replyA)}`).toMatchObject({ clientUuid: CLIENT_UUID_A, lane: 'queued', state: 'queued' })
      expect(replyB, `压缩中提交应落 queued 车道：${JSON.stringify(replyB)}`).toMatchObject({ clientUuid: CLIENT_UUID_B, lane: 'queued', state: 'queued' })
      const handle = registry.getOrCreateDelivery(targetSessionId!)
      expect(handle.depth(), '压缩中两条应全部持有在内核队列（depth = queued 计数）').toBe(2)

      // ── 4. 压缩窗口零投递结构化断言（防「抢跑投递」假通过）──
      const midState = await targetFx.sendCommand('get_state')
      const mid = midState.data as { isStreaming?: boolean; pendingMessageCount?: number }
      expect(
        mid.pendingMessageCount ?? 0,
        `压缩中不得向 pi 出站（pi 槽位应空），实际：${JSON.stringify(mid)}`,
      ).toBe(0)
      const entriesBefore = await targetFx.sendCommand('get_entries', {}, STEP_TIMEOUT_MS)
      const textsBefore = ((entriesBefore.data as { entries?: Array<{ type?: string; message?: { role?: string; content?: unknown } }> }).entries ?? [])
        .filter((e) => e.type === 'message' && e.message?.role === 'user')
        .map((e) => contentToText(e.message?.content))
      expect(
        textsBefore.some((t) => t.includes(MARK_A) || t.includes(MARK_B)),
        `压缩中两条消息不得进 transcript，实际 user entries：${JSON.stringify(textsBefore)}`,
      ).toBe(false)

      // ── 5. 压缩结束：置位释放 + settled 边沿（内核 flush 触发点，见 kernel ensureSettledSub）──
      // 'compacting-end' 行 = 生产路径的复位原语（event-interpreter flags: isCompacting=false，
      // 与 compacting_end 事件处理同点），不直写只读字段。
      applySessionOccupancyTransition(view, null, 'compacting-end')
      applySessionOccupancyTransition(view, null, 'idle')
      for (const cb of [...settledCbs]) cb(targetSessionId!)
      await registry.reconcile(targetSessionId!, 'compaction-end')

      // ── 6. 按序必达：两条 user entry 各恰好一次、顺序与提交序一致、各带裸标记 ──
      const readUserTexts = async (): Promise<string[]> => {
        const resp = await targetFx!.sendCommand('get_entries', {}, STEP_TIMEOUT_MS)
        return ((resp.data as { entries?: Array<{ type?: string; message?: { role?: string; content?: unknown } }> }).entries ?? [])
          .filter((e) => e.type === 'message' && e.message?.role === 'user')
          .map((e) => contentToText(e.message?.content))
      }
      await waitUntil(
        async () => {
          const texts = await readUserTexts()
          return texts.some((t) => t.includes(MARK_A)) && texts.some((t) => t.includes(MARK_B))
        },
        STEP_TIMEOUT_MS,
        async () => `transcript user entries = ${JSON.stringify(await readUserTexts())}／内核 depth=${handle.depth()}`,
      )

      const texts = await readUserTexts()
      const idxA = texts.findIndex((t) => t.includes(MARK_A))
      const idxB = texts.findIndex((t) => t.includes(MARK_B))
      expect(idxA, `第一条应在 transcript 中：${JSON.stringify(texts)}`).toBeGreaterThanOrEqual(0)
      expect(idxB, `第二条应在 transcript 中：${JSON.stringify(texts)}`).toBeGreaterThan(idxA)
      expect(
        texts.filter((t) => t.includes(MARK_A)).length,
        `第一条应恰好到达一次（无重复）：${JSON.stringify(texts)}`,
      ).toBe(1)
      expect(
        texts.filter((t) => t.includes(MARK_B)).length,
        `第二条应恰好到达一次（无重复）：${JSON.stringify(texts)}`,
      ).toBe(1)
      // 标记确认（D2）：两条出站文本各带自己的裸标记（逐消息身份，非计数/文本匹配）
      expect(texts[idxA], '第一条应带自己的出站裸标记').toContain(`<!--taiji:msg:${BARE_MARKER_A}-->`)
      expect(texts[idxB], '第二条应带自己的出站裸标记').toContain(`<!--taiji:msg:${BARE_MARKER_B}-->`)

      // ── 7. 内核条目终态 delivered（送达回执 message_end(user) 标记命中，D2 第二阶段）──
      await waitUntil(
        () => {
          const full = handle.entries()
          return [CLIENT_UUID_A, CLIENT_UUID_B].every((id) =>
            full.tombstones.some((t) => t.id === id && t.state === 'delivered'),
          )
        },
        STEP_TIMEOUT_MS,
        () => `内核 tombstone = ${JSON.stringify(handle.entries().tombstones)}`,
      )
      const full = handle.entries()
      expect(full.active, '两条送达后不留活跃条目').toHaveLength(0)
      expect(handle.depth(), '投递完成后内核队列清空').toBe(0)
      for (const id of [CLIENT_UUID_A, CLIENT_UUID_B]) {
        expect(
          full.tombstones.find((t) => t.id === id)?.state,
          `${id} 应经送达回执转 delivered`,
        ).toBe('delivered')
      }
    } finally {
      if (pump !== undefined) clearInterval(pump)
      registry?.disposeAll()
      await targetFx?.dispose().catch(() => {})
      delete process.env.TAIJI_FAUX_TPS
      rmSync(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
