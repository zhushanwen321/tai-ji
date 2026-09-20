/**
 * 空闲 pi 回收端到端集成测试（真进程，idle-pi-reclamation 设计 P1/P3/P7 + V1 可自动化主干，
 * 实施计划 u4，借 attach-lifecycle.test.ts 真进程先例 + relay-integration.test.ts 真进程模式）。
 *
 * 装配形态（最小真实组合，pi 进程零 mock）：
 * - 真 ProcessManager（真 spawn `pi --mode rpc` 子进程，session 落盘 $TAIJI_AGENT_DATA_DIR/agent/sessions
 *   ——globalSetup 已把 TAIJI_AGENT_DATA_DIR 指向 tmp，零真实数据污染）；
 * - 真 SessionLifecycle（svc/configStore/sessionStore/workspace 最小 fake，registerDeps 的
 *   adapterFactory 是真 EventAdapter + 真 EventInterpreter → send = 真 MessageBus.publish）；
 * - 真 MessageBus（P3 广播流连续的分区/seq/订阅者本体）；
 * - 真 SessionHistoryReader（pm + 真 PiSessionStore——P7 收益门的缓存/增量/fallback 三分支本体）；
 * - 真 ReclaimSeat + 真 reaper 判定循环（startIdlePiReaper 一拍）+ 真 reclaimManagedSession 七步编排。
 *
 * 场景链（单用例分阶段，每阶段真进程动作）：
 * 1. attach + 一轮真实对话（lifecycle.create 真 spawn + 真 LLM turn，证据落盘：session JSONL
 *    出现 user+assistant entry）；
 * 2. 回收（P1）：真 reaper 一拍（阈值压到 -1 = 「空闲超阈值」恒过，等价真机 TAIJI_RUNTIME_PI_RECLAIM_IDLE_MS
 *    调小形态）→ reclaimManagedSession 七步。断言：进程真死（pm 双 Map 摘除 + client.exited）、
 *    零死亡广播（pm.onSessionExit 死亡通知零调用 + client.onExit 零调用 + bus 无 session.exited
 *    帧——「计划内杀静默语义」的行为级终点；pi-crash-*.log 落盘依赖 initLogger，本进程未初始化时
 *    writePiCrashLog 结构性 no-op，crash 静默的源头断言即 exit handler 的 _killing 分支 = 上述
 *    死亡广播零调用）、session JSONL 逐字节原样、seat 释放、按拍合并广播恰一次；
 * 3. 恢复 + 历史无损（P1 续）：restoreSession 真 spawn 新 pi 附着同一文件 → getHistory 与回收前
 *    基线等价（消息数一致 + 暗号文本仍在）；
 * 4. P7 收益门：恢复后触发 getHistory，从日志判定走增量（getEntries since=leafId）还是
 *    "Entry not found"/其它 fallback——**记录式断言**（gate_pass=incremental / gate_fail=fallback
 *    二选一都算通过，结论由编排者登记；设计 D5 两分支均安全，悬而未决的只是收益大小）；
 * 5. 新回复流式到达（P3）：恢复后发第二条真实 prompt，回收前订阅的同一 BusClient 持续收到
 *    message.text_delta / message.complete，带 seq 帧相对回收前基线**严格 +1 递增无断裂**
 *    （分区保留 = seqCounter 连续 + 订阅者集合不断）。
 *
 * agent dir 与 faux 注入（L2.5 翻轨）：真 pm 链路的 RpcClient 注入 PI_CODING_AGENT_DIR =
 * $TAIJI_AGENT_DATA_DIR/agent（tmp 空目录）——faux 轨无需凭证播种；faux 装配改为：
 * - 测试把 svc.getExtensionPaths fake 换成 [faux-llm-ext.ts]（create 与 restore 两条
 *   spawn 路径都经它注入 --extension）+ create 传 modelOverride 'faux/faux-1'；
 * - 响应脚本写 workDir 下 faux-responses.json，process.env.TAIJI_FAUX_SCRIPT 指向它——
 *   RpcClient spawn env 以 process.env 为 parentEnv（rpc-client.ts buildPiOutboundEnv），
 *   create/restore 两次 spawn 都透传；restore 路径不拼 --model（inheritSessionModel），
 *   模型由 session 文件 model_change entry 恢复为 faux/faux-1。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/services/idle-pi-reclaim-integration.test.ts
 * skip 口径：pi binary 缺席 → describe.skipIf 整文件跳过不 fail（FAUX_PI_READY，凭证无关）。
 */
import { describe, it, expect, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SessionSummary } from '@taiji/shared'
import { FAUX_PI_READY, FAUX_PI_SKIP_REASON } from '../equivalence/pi-fixture.js'
import { ProcessManager } from '../../infra/pi/process-manager.js'
import { getPiAgentDir } from '../../infra/pi/pi-paths.js'
import { PiSessionStore } from '../../infra/pi/session-store.js'
import { EventAdapter } from '../../infra/pi/event-adapter.js'
import { SessionLifecycle, type ReclaimSessionDeps } from '../../services/session/session-lifecycle.js'
import type { ILifecycleSessionOps, ISessionRegisterDeps } from '../../services/session/session-internal.js'
import type { PiTranslatedEvent, ScannedSession } from '../../services/session/types.js'
import { SessionHistoryReader } from '../../services/session/history-rebuild-cache.js'
import { MessageBus } from '../../services/message-bus/message-bus.js'
import type { BusClient } from '../../services/message-bus/types.js'
import { EventInterpreter } from '../../services/session/event-interpreter.js'
import { ReclaimSeat, startIdlePiReaper, type IdlePiReaperHandle } from '../../services/session/idle-pi-reaper.js'
import type { IPiEngine } from '../../services/ports/pi-engine.js'
import type { IConfigStore } from '../../services/ports/config.js'
import type { ISessionStore } from '../../services/ports/session.js'
import type { IEventAdapter } from '../../interfaces.js'
import type { WorkspaceService } from '../../services/workspace/workspace-service.js'

/** 单轮真实 LLM turn 等待上限（对齐 attach-lifecycle 先例同量级：满载环境单轮可拖长，放宽不缩窄） */
const TURN_TIMEOUT_MS = 420_000
/** 用例总超时 = 3 次 spawn（create/restore + reaper 一拍内含 kill ≤2s）+ 两轮 turn + 多次 RPC 的和再留余量 */
const TEST_TIMEOUT_MS = 900_000
/** occupancy 回 idle 的轮询上限（turn 完成 → agent_settled → idle 转移，正常亚秒级） */
const OCCUPANCY_IDLE_TIMEOUT_MS = 30_000
/** occupancy 轮询间隔 */
const POLL_INTERVAL_MS = 100

/** faux 演员（L2.5）：create 覆盖模型与 configStore 默认模型（pi-fixture FAUX_MODEL 同款） */
const FAUX_MODEL_REF = 'faux/faux-1'
const [FAUX_PROVIDER, FAUX_MODEL_ID] = FAUX_MODEL_REF.split('/')
/** faux provider 注册 extension（spawn --extension 注入；与本文件同仓同 commit。
 *  本文件位于 src/__tests__/services/，extension 在 src/__tests__/fixtures/——一级上溯） */
const FAUX_LLM_EXT_PATH = fileURLToPath(new URL('../fixtures/faux-llm-ext.ts', import.meta.url))

/** pi 事件宽形态（只消费 type 字段） */
interface PiEventLike {
  type?: string
  [key: string]: unknown
}

/** bus 订阅者收到的帧（JSON.parse 后的 ServerMessage 宽形态，只断言 type/seq/payload） */
interface BusFrame {
  type: string
  seq?: number
  payload?: { sessionId?: string; delta?: string; [key: string]: unknown }
  [key: string]: unknown
}

/** session JSONL 的 entry 最小形态（逐行 JSON.parse，attach-lifecycle 先例同款等价读取） */
interface SessionFileEntry {
  type: string
  message?: { role?: string; [key: string]: unknown }
  [key: string]: unknown
}

function readSessionEntries(filePath: string): SessionFileEntry[] {
  return readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as SessionFileEntry)
}

/** 真实 agentDir（faux 轨不再消费；保留 getPiAgentDir 确保 agentDir 存在——RpcClient 注入
 *  PI_CODING_AGENT_DIR 指向它，目录缺省由 pi 自建亦安全，显式建齐避免依赖该行为） */
function ensureAgentDirExists(): void {
  mkdirSync(getPiAgentDir(), { recursive: true })
}

/**
 * faux 装配（L2.5 翻轨，取代凭证播种）：响应脚本（两轮 turn = 回收前 seed / 恢复后
 * beta）写 workDir，TAIJI_FAUX_SCRIPT 指向它——RpcClient spawn env 以 process.env 为
 * parentEnv 透传到 create/restore 两次 spawn 的 pi 子进程。
 */
function seedFauxScript(workDir: string): void {
  const scriptPath = join(workDir, 'faux-responses.json')
  writeFileSync(scriptPath, JSON.stringify([{ text: 'reclaim-seed-alpha' }, { text: 'reclaim-round-beta' }]))
  process.env.TAIJI_FAUX_SCRIPT = scriptPath
  // 本测试 restore 后继续对话：pi 进程内 factory 重跑（session_start 侧既有重载行为）必须
  // 重新播种，否则恢复进程的 core 空队列、第二 turn 命中 faux 耗尽 error（delta 断言红）。
  // 与 skill-reload 的防重放语义相反，经 fixture 的退出通道显式选择本侧语义。
  process.env.TAIJI_FAUX_RESEED_ON_RELOAD = '1'
}

function clearFauxScript(): void {
  delete process.env.TAIJI_FAUX_SCRIPT
  delete process.env.TAIJI_FAUX_RESEED_ON_RELOAD
}

/** 等 pi 事件流里的 agent_end（listener 先于 prompt 注册，消除快 turn 竞态） */
function waitForAgentEnd(client: IPiEngine, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub()
      reject(new Error(`agent_end not received within ${timeoutMs}ms`))
    }, timeoutMs)
    const unsub = client.onEvent((event: unknown) => {
      if ((event as PiEventLike).type === 'agent_end') {
        clearTimeout(timer)
        unsub()
        resolve()
      }
    })
  })
}

/** 发 prompt 并等本轮 agent_end（idle 起步形态，与 fixture runTurn 同构） */
async function runTurn(client: IPiEngine, message: string, timeoutMs: number): Promise<void> {
  const ended = waitForAgentEnd(client, timeoutMs)
  await client.prompt(message)
  await ended
}

/** 轮询等 occupancy 回 idle（turn 完成 → agent_settled → idle 转移，事件驱动挂点回写 session 记录） */
async function waitOccupancyIdle(lifecycle: SessionLifecycle, sid: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const occ = lifecycle.get(sid)?.occupancy
    if (occ && occ.turn === 'idle' && !occ.compacting && !occ.bash) return
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }
  throw new Error(`occupancy did not return to idle within ${timeoutMs}ms`)
}

/** 收集到的帧中带 seq 的最大值（无带 seq 帧时返回 0——seq 从 1 起分配） */
function maxSeq(frames: BusFrame[]): number {
  return frames.reduce((max, f) => (typeof f.seq === 'number' && f.seq > max ? f.seq : max), 0)
}

describe.skipIf(!FAUX_PI_READY)(
  `idle pi reclamation 端到端（faux 真进程${FAUX_PI_SKIP_REASON ? `｜skip：${FAUX_PI_SKIP_REASON}` : ''}）`,
  () => {
  it(
    '全链：create+真实轮次 → reaper 一拍回收（P1：静默/文件原样）→ restore 历史无损 → P7 收益门 → 新回复流式到达（P3）',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const workDir = mkdtempSync(join(tmpdir(), 'idle-reclaim-int-'))
      ensureAgentDirExists()
      seedFauxScript(workDir)

      // ── 装配（真组件 + 最小 fake deps，见文件头）──
      const bus = new MessageBus()
      // lifecycle 后置赋值（adapterFactory 闭包经 let 引用——组合根同款 temporal 模式）
      let lifecycle: SessionLifecycle | null = null
      // reaper 句柄外提：失败路径（中途断言红）也必须 stop，防周期 timer 残留
      let reaper: IdlePiReaperHandle | null = null
      let scannedTarget: ScannedSession | undefined
      const svc: ILifecycleSessionOps = {
        toSummary: (s) => ({
          id: s.id, label: s.label, cwd: s.cwd, status: 'idle', lastActiveAt: s.lastActiveAt,
        }) as unknown as SessionSummary,
        findScannedSession: (sid) => (scannedTarget?.id === sid ? scannedTarget : undefined),
        getSkillPaths: () => [],
        getExtensionPaths: async () => [FAUX_LLM_EXT_PATH],
        getReplaceSystemPrompt: () => undefined,
        getLaunchPresetOptions: async () => undefined,
        fetchAndBroadcastContext: async () => {},
        removeSessionEntry: () => {},
        notifySessionCreated: () => {},
        getActiveSummaries: () => [],
      }
      // adapterFactory：真 EventAdapter（pi 事件翻译）+ 真 EventInterpreter（编排）→ send = bus.publish。
      // onOccupancyTransition 接线 = 组合根 updateSessionOccupancy 的最小等价（回写 session 记录三维），
      // 让 reaper 的 occupancy 豁免读取真值（turn 结束后回 idle）。
      const registerDeps: ISessionRegisterDeps = {
        adapterFactory: (sid, send, cwd) => {
          const interpreter = new EventInterpreter(sid, {
            send,
            cwd,
            onOccupancyTransition: (transition) => {
              // 新形态（session-dead-structural-fixes D2）：transition 是字符串枚举，
              // occupancy 三字段按 SESSION_OCCUPANCY_TRANSITIONS 表推导（对齐
              // applySessionOccupancyTransition 的写模型；置 idle 枚举全集 =
              // idle / full-reset / reject-other / abort-stall-converged / abort-stall-force-kill，
              // 漏 idle 枚举会卡 settling 永不回 idle → waitOccupancyIdle 超时）。
              const rec = lifecycle?.get(sid)
              if (!rec) return
              const occ = rec.occupancy ?? { turn: 'idle' as const, compacting: false, bash: false }
              const t = transition
              const toIdle = t === 'idle' || t === 'full-reset' || t === 'reject-other' || t === 'abort-stall-converged' || t === 'abort-stall-force-kill'
              const resetAll = t === 'full-reset' || t === 'abort-stall-force-kill'
              rec.occupancy = {
                turn: t === 'dispatching' || t === 'generating' || t === 'settling' ? t : t === 'reject-processing' ? 'generating' : (toIdle ? 'idle' : occ.turn),
                compacting: t === 'compacting-start' ? true : t === 'compacting-end' || resetAll ? false : occ.compacting,
                bash: t === 'bash-start' ? true : t === 'bash-end' || resetAll ? false : occ.bash,
              }
            },
          })
          const adapter: IEventAdapter = new EventAdapter(sid, (events: PiTranslatedEvent[]) => interpreter.interpret(events))
          return adapter
        },
        getMessageBus: () => bus,
        broadcastGlobal: () => {},
        notifyMessageComplete: () => {},
      }
      const pm = new ProcessManager(tmpdir())
      lifecycle = new SessionLifecycle(
        svc,
        pm,
        { getDefaultModel: () => ({ provider: FAUX_PROVIDER!, modelId: FAUX_MODEL_ID! }) } as unknown as IConfigStore,
        { refreshAll: () => {}, invalidateScanCache: () => {}, scanSessions: () => [] } as unknown as ISessionStore,
        { record: () => {}, list: () => [] } as unknown as WorkspaceService,
        registerDeps,
      )
      // P7 收益门本体：真缓存链（HistoryRebuildCache + 真 PiSessionStore 重建）
      const historyReader = new SessionHistoryReader({ pm, sessionStore: new PiSessionStore() })
      const seat = new ReclaimSeat()

      try {
        // ══ 阶段 1：attach + 一轮真实对话（真 spawn + faux 轮，证据落盘）══
        const summary = await lifecycle!.create(workDir, 'reclaim-int', { modelOverride: FAUX_MODEL_REF })
        const sid = summary.id
        expect(sid).toBeTruthy()
        const firstClient = pm.getClient(sid)
        expect(firstClient).toBeDefined()

        // bus 订阅（renderer 全量订阅形态的等价物）：第一轮事件即从此订阅者经过
        const frames: BusFrame[] = []
        const ws: BusClient = {
          readyState: 1,
          send: (data: string) => { frames.push(JSON.parse(data) as BusFrame) },
        }
        bus.subscribe(sid, ws)

        await runTurn(firstClient!, `Reply with exactly the word: reclaim-seed-alpha`, TURN_TIMEOUT_MS)
        await waitOccupancyIdle(lifecycle!, sid, OCCUPANCY_IDLE_TIMEOUT_MS)

        // 证据落盘：session JSONL 出现 user + assistant entry（暗号匹配 user 提交原文——先例强断言形态）
        const state = await firstClient!.getState()
        const sessionFile = state?.sessionFile
        expect(typeof sessionFile).toBe('string')
        const beforeKillEntries = readSessionEntries(sessionFile as string)
        const seedUserIdx = beforeKillEntries.findIndex(
          (e) => e.type === 'message' && e.message?.role === 'user' && JSON.stringify(e.message).includes('reclaim-seed-alpha'),
        )
        expect(seedUserIdx).toBeGreaterThan(-1)
        expect(
          beforeKillEntries.slice(seedUserIdx + 1).some((e) => e.type === 'message' && e.message?.role === 'assistant'),
        ).toBe(true)

        // 历史基线（P7 前提：回收前 getHistory 建立 leafId 缓存；首次调用走全量重建分支）
        const baseline = await historyReader.getHistory(sid)
        expect(baseline.messages.length).toBeGreaterThan(0)

        // 死亡广播监听（生产链：pm.onSessionExit → session.exited 死亡通知；计划内杀必须零触发）
        const deathNotices: string[] = []
        pm.onSessionExit((id) => { deathNotices.push(id) })
        const clientExitSpy = vi.fn()
        firstClient!.onExit(clientExitSpy)

        // ══ 阶段 2：回收（P1）——真 reaper 一拍（阈值 -1 = 空闲超阈值恒过）══
        const reclaimDeps: ReclaimSessionDeps = {
          seat,
          listRelayChildrenByMainSession: () => [],
          reapBackgroundTasks: async () => {},
          clearPendingReload: () => {},
        }
        const broadcastSpy = vi.fn()
        reaper = startIdlePiReaper({
          seat,
          exemptions: {
            // occupancy 用真值（session 记录三维，由 interpreter 挂点回写）；
            // 其余六类豁免在最小装配下恒不命中（任务指定：清空豁免闭包）
            isOccupied: (target) => {
              const occ = lifecycle!.get(target)?.occupancy
              return !!occ && (occ.turn !== 'idle' || occ.compacting || occ.bash)
            },
            hasRunningBackgroundTasks: () => false,
            hasInflightRelayChildren: () => false,
            hasHandoffInflight: () => false,
            hasQueuedDeliveries: () => false,
            getLastViewedAt: () => undefined,
            isRestoring: () => false,
            hasPendingUiRequest: () => false,
          },
          getClientActivity: (target) => pm.getClient(target)?.lastActivityAt,
          listCandidateSessionIds: () => [sid],
          reclaim: (target) => lifecycle!.reclaimManagedSession(target, reclaimDeps),
          broadcast: broadcastSpy,
          // 集成用例把空闲阈值压到负值：idleMs > -1 恒真 = 「空闲超阈值」判定恒过，
          // 等价真机 TAIJI_RUNTIME_PI_RECLAIM_IDLE_MS 调小的 V1 形态（省真实等待）
          idleThresholdMs: -1,
        })
        await reaper.runOnce()
        reaper.stop()
        reaper = null
        // P1 断言组：
        // 进程真死（pm 双 Map 摘除 + kill 链完成 = client.exited）
        expect(pm.getClient(sid)).toBeUndefined()
        expect(pm.hasClient(sid)).toBe(false)
        expect(firstClient!.exited).toBe(true)
        // 零死亡广播（_killing 静默语义的行为级终点：exit handler 跳过 exitCallbacks 多播与
        // writeCrashLogIfNeeded——死亡通知零调用即「计划内杀不产生 session.exited / crash 上报链」）
        expect(deathNotices).toEqual([])
        expect(clientExitSpy).not.toHaveBeenCalled()
        expect(frames.some((f) => f.type === 'session.exited')).toBe(false)
        // 按拍合并广播恰一次（D3 第 7 步）
        expect(broadcastSpy).toHaveBeenCalledTimes(1)
        // 占座已释放（try/finally）
        expect(seat.heldSessionIds()).not.toContain(sid)
        // session JSONL 原样（回收从不触碰磁盘：pi 已死不再写，逐字节 deep equal）
        expect(readSessionEntries(sessionFile as string)).toEqual(beforeKillEntries)
        const preReclaimMaxSeq = maxSeq(frames)
        expect(preReclaimMaxSeq).toBeGreaterThan(0)

        // ══ 阶段 3：恢复 + 历史无损（P1 续）══
        const stat = statSync(sessionFile as string)
        scannedTarget = {
          id: sid,
          filePath: sessionFile as string,
          cwd: workDir,
          timestamp: new Date().toISOString(),
          name: 'reclaim-int',
          lastModified: stat.mtimeMs,
          size: stat.size,
          outcome: null,
        }
        await lifecycle!.restoreSession(sid)
        const restoredClient = pm.getClient(sid)
        expect(restoredClient).toBeDefined()
        expect(restoredClient).not.toBe(firstClient)
        expect(restoredClient!.exited).toBe(false)
        expect(lifecycle!.has(sid)).toBe(true)

        // ══ 阶段 4：P7 收益门（记录式断言）+ 历史完整 ══
        // 捕获窗口内日志，判定恢复后首次 getHistory 走的分支：
        // - 'getHistory cache fresh (empty delta)' / 'getHistory incremental for' → 增量命中
        // - 'getHistory incremental Entry-not-found' / 'parent-id invariant violated' / 无增量日志
        //   （无缓存 / leafId null / 全量重建）→ fallback
        const logSpy = vi.spyOn(console, 'log')
        const warnSpy = vi.spyOn(console, 'warn')
        logSpy.mockClear()
        warnSpy.mockClear()
        const postRestore = await historyReader.getHistory(sid)
        const capturedLogs = [...logSpy.mock.calls, ...warnSpy.mock.calls]
          .map((args) => args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
          .join('\n')
        logSpy.mockRestore()
        warnSpy.mockRestore()
        const incrementalHit =
          capturedLogs.includes('getHistory cache fresh (empty delta)') ||
          capturedLogs.includes('getHistory incremental for ')
        const gate: 'gate_pass=incremental' | 'gate_fail=fallback' = incrementalHit
          ? 'gate_pass=incremental'
          : 'gate_fail=fallback'
        // 记录实际路径（结论由编排者登记进计划；两分支都合法，不得断言特定一侧）
        console.log(`[P7 收益门] 实际路径=${gate}`)
        console.log(`[P7 收益门] 判定日志片段=${capturedLogs.split('\n').filter((l) => l.includes('getHistory')).join(' || ') || '(无 getHistory 相关日志)'}`)
        expect([ 'gate_pass=incremental', 'gate_fail=fallback' ]).toContain(gate)

        // P1 历史无损（不管 P7 走哪条分支，恢复后的历史都必须与回收前基线等价）
        expect(postRestore.messages.length).toBe(baseline.messages.length)
        expect(JSON.stringify(postRestore.messages)).toContain('reclaim-seed-alpha')

        // ══ 阶段 5：新回复流式到达（P3）══
        const framesBeforeSecondTurn = frames.length
        await runTurn(restoredClient!, `Reply with exactly the word: reclaim-round-beta`, TURN_TIMEOUT_MS)
        await waitOccupancyIdle(lifecycle!, sid, OCCUPANCY_IDLE_TIMEOUT_MS)
        const secondTurnFrames = frames.slice(framesBeforeSecondTurn)

        // 流式 delta 到达订阅者（同一 ws 实例横跨回收前后——分区保留 = 订阅者无需重订阅）
        const deltas = secondTurnFrames.filter((f) => f.type === 'message.text_delta')
        expect(deltas.length).toBeGreaterThan(0)
        expect(deltas.map((f) => (f.payload?.delta ?? '')).join('')).not.toBe('')
        expect(secondTurnFrames.some((f) => f.type === 'message.complete')).toBe(true)
        // 全程无 session.exited（回收与恢复两段都在订阅者视野内）
        expect(frames.some((f) => f.type === 'session.exited')).toBe(false)
        // seq 连续（无 gap）：回收前后的带 seq 帧全序列严格递增且相邻差 1（分区 seqCounter 未被
        // clearSession 重置——若被清，恢复后首帧 seq 从 1 重来即红）；恢复后确有新 seq 帧到达
        const seqs = frames.filter((f) => typeof f.seq === 'number').map((f) => f.seq as number)
        expect(seqs.length).toBeGreaterThan(0)
        expect(maxSeq(secondTurnFrames)).toBeGreaterThan(preReclaimMaxSeq)
        for (let i = 1; i < seqs.length; i++) {
          expect(seqs[i]! - seqs[i - 1]!).toBe(1)
        }

        // 收尾：销毁恢复出的真 pi 进程（workDir 删除在 finally）
        await pm.destroyAll()
      } catch (e) {
        // 失败路径也必须收掉残余真进程（恢复失败中途抛错时 pi 可能仍在跑）
        reaper?.stop()
        reaper = null
        await pm.destroyAll().catch(() => {})
        throw e
      } finally {
        clearFauxScript()
        rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      }
    },
  )
  },
)
