/**
 * session-manager 真 pi 全链路 e2e（U9-S1 / U9-S2 + watch 桥三路径 U9-S3~S5）— 设计文档 §7.2 场景 1 + §7.3 重启恢复 + §4 场景 9（watch 开表/晚 respond/静默，D2/D4 watch 路由）的机器化。
 *
 * 与 session-manager-e2e-probe.test.ts（FakePiProcessIO，无真 pi 进程）的区别：本文件 spawn
 * **真实 pi**（--mode rpc + --extension extensions/universal/session-manager，真实 LLM turn 驱动 agent
 * 调用 create_managed_session），runtime 侧走仓库真实代码——event-adapter translate（marker
 * 检测）→ EventInterpreter（session-manager 路由）→ SessionManagerHandler（create 分发）→
 * extension_ui_response 回写 pi stdin——只有 SessionService 是最小 fake（create 返回固定
 * summary + 调真实 persistAgentBinding 落盘 sidecar）。测试对象是跨进程通道闭环本身：
 * extension 工具内 ctx.ui.select → pi stdout extension_ui_request → runtime 真实翻译/路由/处理
 * → sendExtensionUiResponse 回写 → 工具 await 拿到结果（设计文档 §10 首项检查点）。
 *
 * 用例（验收 id 在用例名词边界，cw 名字级比对）：
 * - U9-S1 真 pi 全链路 create：工具 60s 内返回 + sidecar 已写 + spawnSource='agent'
 * - U9-S2 重启恢复：scanPiSessions({force:true}) 重扫恢复 spawnSource + parentAgentSessionId
 * - U9-S3 watch 开表挂等：extension 经真实 marker select 通道开表 → handler 路由 deferred
 *  （零 respond）→ settle 兑现腿经同一写回通道 respond（设计 §4-9；faux 轨零 token）
 * - U9-S4 晚 respond catch-up：watch 到达时 claim 已 fulfilled → 立即快照 respond（D4）
 * - U9-S5 fail-closed 静默：watch 查无 claim → 立即 respond 'cancelled'（不携 sessionId，D-4）
 * - U9-D1 死亡收口：子会话意外退出 → watch 挂等 claim 恰收一条 reason:'exited'
 *  （携 exitCode/stderrTail + deathSeq/fulfillsN），destroy 迟到二次发声幂等（notify-once
 *  D5「死亡也通知恰一次」第一承诺的执行面）
 * - U9-D2 死亡词形分派：cause=delete → reason:'deleted'（不携退出现场字段）
 *
 * 环境约定照抄 equivalence 族（pi-fixture.ts）：真实 spawn（禁 mock 子进程）。faux LLM 轨
 * （L2.5 翻轨）：跨进程通道闭环（extension 工具 → ui_request → runtime 翻译/路由/处理 →
 * 回写 → 工具返回）是被测对象，agent 的工具调用由 fauxResponses 脚本固定；门控
 * FAUX_PI_READY（只判 binary，凭证无关、CI 可跑）。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/equivalence/session-manager-full-e2e.test.ts
 * 入口脚本：bash scripts/cw/session-manager-full-e2e.sh（标记行 U9-S1/U9-S2 PASS|FAIL）
 */

import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
// ↓ 真实实现 import（与 session-manager-e2e-probe.test.ts 同款区分力锚点，禁 try/catch 容错）
import { translate } from '../../infra/pi/event-adapter.js'
import { EventInterpreter } from '../../services/session/event-interpreter.js'
import { createClaimLedger } from '../../services/session/notify-claims.js'
import type { ClaimLedger } from '../../services/session/notify-claims.js'
import { SessionManagerHandler, deliverRespondTargets, collectStderrTail } from '../../transport/session-manager-handler.js'
import type { SessionManagerHandlerOptions } from '../../transport/session-manager-handler.js'
import {
  agentSidecarPath,
  invalidateScanDirCache,
  persistAgentBinding,
  scanPiSessions,
} from '../../infra/pi/session-file-utils.js'
import { SESSION_MANAGER_MARKER } from '@zhushanwen/extension-protocol'
import type { PiEvent } from '../../infra/pi/pi-protocol.js'
import type { ISessionService } from '../../interfaces.js'
import { spawnPiFixture, FAUX_PI_READY, FAUX_PI_SKIP_REASON, type PiFixture, type PiStreamEvent } from './pi-fixture.js'

/** 真 extension 源码路径（worktree 内 extensions/universal/session-manager，pi 原生 loader 加载 TS 源） */
// import.meta.url 仅测试可用（vitest ESM 环境）；禁止复制进 runtime src——CJS bundle 下
// import.meta.url 失效（架构约定 #12），check_runtime_meta_url.py 只扫 src 不拦测试。
const EXTENSION_PATH = fileURLToPath(new URL('../../../../../extensions/universal/session-manager', import.meta.url))
/** 单步等待上限（任务护栏：每步最多 60s） */
const STEP_TIMEOUT_MS = 60_000
/** 固定 create 参数（prompt 写死指令，防 agent 自由发挥） */
const FIXED_LABEL = 'u9-smoke'
/** watch 三路径轨的固定初始 prompt：携带 → willNotify:true → extension arm claim + 经 marker 通道开表 */
const FIXED_PROMPT = 'Run a trivial task and report done.'

/** respond 回写记录（sendExtensionUiResponse 捕获面；watch 断言按 requestId 过滤） */
interface RecordedRespond {
  requestId: string
  /** select value 原样（JSON 字符串）；cancelled（null）路径为 null */
  value: string | null
}

/** runFullChain 装配选项 */
interface ChainOptions {
  /** create 是否携带 prompt（产生 kind=claim 债权：willNotify:true → extension arm + 开表 watch） */
  withPrompt?: boolean
}

/** runFullChain 返回面（既有两用例消费 result/fx/cleanup；watch 三路径另消费账本/写回捕获/喂入通道） */
interface FullChain {
  result: FullChainResult
  fx: PiFixture
  cleanup: () => void
  claims: ClaimLedger
  handler: SessionManagerHandler
  responds: RecordedRespond[]
  /** 经真实 marker select 通道喂一个 ui_request（translate → interpreter → handler）并等 handle 收口 */
  feedUiRequest: (event: PiStreamEvent) => Promise<void>
}

/**
 * 从 marker select ui_request 事件解析 watch 请求的 notifyId（非 watch / 解析失败 → undefined）。
 * create 会开两表：claim notifyId（extension 侧 crypto 生成，tool result 里不回传）+
 * lifetimeNotifyId（tool result 回传）——调用方以「≠ lifetimeNotifyId」区分两者。
 */
function watchNotifyIdOf(e: PiStreamEvent): string | undefined {
  if (e.type !== 'extension_ui_request' || e.title !== SESSION_MANAGER_MARKER) return undefined
  const rawOptions = Array.isArray(e.options) ? e.options : []
  if (rawOptions.length === 0) return undefined
  try {
    const payload = JSON.parse(String(rawOptions[0])) as { action?: unknown; params?: { notifyId?: unknown } }
    if (payload.action !== 'watch') return undefined
    const notifyId = payload.params?.notifyId
    return typeof notifyId === 'string' ? notifyId : undefined
  } catch {
    return undefined
  }
}

/** 全链路执行结果（各验收用例的消费面） */
interface FullChainResult {
  parentSessionId: string
  childId: string
  childJsonl: string
  sidecarPath: string
  toolResultEvent: PiStreamEvent
  /** create 被调时的真实参数（断言 runtime 注入 spawnSource/parentAgentSessionId，不信任请求侧） */
  createCall: { cwd: unknown; label: unknown; opts: Record<string, unknown> }
  timings: Record<string, number>
}

/**
 * 驱动一条完整链路：spawn 真 pi（含 extension）→ prompt 指令 agent 调 create_managed_session
 * → 等 extension_ui_request → 真实 translate/interpreter/handler 处理 → 回写 → 等 turn_end 工具结果。
 *
 * options.withPrompt：create 携固定 prompt → runtime arm kind=claim（+自动 lifetime）→
 * 工具结果后 extension 经 marker 通道开表（watch ui_request 进事件流，供 U9-S3~S5 驱动）。
 *
 * faux LLM 轨（L2.5 翻轨）：agent 的工具调用由 fauxResponses 脚本固定（toolCalls 步骤
 * 100% 确定），真实 LLM 时代「agent 是否真调工具不受控」的 2 次重试护栏已随翻轨删除
 * （[HISTORICAL] 2026-09 真实轨曾因 LLM 偶尔不调工具连红；脚本化后不确定性结构性
 * 消失，单发 prompt 即达，断言强度不变）。
 */
async function runFullChain(options: ChainOptions = {}): Promise<FullChain> {
  // TAIJI_AGENT_DATA_DIR 指向本用例专属 tmp 根：scanPiSessions（getSessionsDir 派生自它）
  // 才能扫到同一 session-dir。目录名带 u9-smoke（孤儿 pi 进程核查锚点：pgrep -f u9-smoke）。
  const savedDataDir = process.env.TAIJI_AGENT_DATA_DIR
  const dataRoot = mkdtempSync(join(tmpdir(), 'u9-smoke-data-'))
  process.env.TAIJI_AGENT_DATA_DIR = dataRoot
  const sessionDir = join(dataRoot, 'agent', 'sessions', 'u9-smoke')
  mkdirSync(sessionDir, { recursive: true })

  const timings: Record<string, number> = {}
  const t0 = Date.now()
  // faux 轨：步骤 1 = 脚本化 toolCall（create_managed_session 固定参数，agent 链路
  // 100% 确定触发）；步骤 2 = 工具结果回填后的收尾文本（turn 定局）。
  // withPrompt 时携带 prompt → handler 受理点 arm kind=claim + markInjected（sendDirect
  // 受理回执）→ extension 工具结果后 willNotify:true + lifetimeNotifyId 双开表。
  const fx = await spawnPiFixture({
    extensions: [EXTENSION_PATH],
    sessionDir,
    commandTimeoutMs: STEP_TIMEOUT_MS,
    fauxResponses: [
      {
        toolCalls: [
          {
            name: 'create_managed_session',
            args: {
              cwd: sessionDir,
              label: FIXED_LABEL,
              ...(options.withPrompt ? { prompt: FIXED_PROMPT } : {}),
            },
          },
        ],
      },
      { text: 'create_managed_session returned.' },
    ],
  })
  timings.coldStartMs = Date.now() - t0

  // notify-once 债权账本（handler 的 claims 面）：watch 三路径的被路由对象。随 cleanup
  // dispose——内部 TTL 清扫 interval 不 unref，漏停会拖住 vitest worker teardown。
  const claims = createClaimLedger()
  const cleanup = (): void => {
    claims.dispose()
    process.env.TAIJI_AGENT_DATA_DIR = savedDataDir
    rmSync(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }

  try {
    // ── 1. 冷启动 get_state：父 pi 真实 sessionId（U9-S2 断言的 parentAgentSessionId 权威源）──
    const state = await fx.sendCommand('get_state')
    const stateData = state.data as { sessionId?: string } | undefined
    const parentSessionId = stateData?.sessionId
    if (!parentSessionId) throw new Error(`get_state 未返回 sessionId: ${JSON.stringify(state.data)}`)

    // ── 2. 最小 fake SessionService：create 落盘子 session JSONL header + 真实 persistAgentBinding ──
    // 生产路径由 pi 子进程自己写 session 文件（延迟 flush）；fake 模拟「子 session 已存在」，
    // 供 persistAgentBinding 的 existsSync 守卫（规则 #6）放行——sidecar 才能落在 JSONL 旁。
    const childId = `u9-smoke-child-${Date.now()}`
    const childJsonl = join(sessionDir, `${childId}.jsonl`)
    let createCall: FullChainResult['createCall'] | undefined
    const sessionService = {
      // u8（设计决策 D8）：handleCreate 开头会读父会话 summary 的 projectId 并透传给子会话。
      // 本 fake 返回「无 project 的父 summary」（只带 id）⇒ parentProjectId=undefined
      // ⇒ 子会话落默认项目。本 e2e 的被测对象是跨进程通道闭环（extension 工具 →
      // ui_request → runtime 翻译/路由/处理 → 回写），project 继承语义由
      // session-manager-handler.test.ts 的 u8 用例覆盖，此处只需保证新调用不打断链路。
      getSummary: (id: string) => ({
        id,
        // 归属材料（handleWatch respond 前二次归属校验 / isOwnedBy 的唯一读源）：子会话是
        // spawnSource='agent' 且归属本父会话的 managed child——生产路径由真实 SessionService
        // 提供，fake 同形物化否则 catch-up 腿会误判「归属失效 → cancelled」（U9-S4）。
        ...(id === childId ? { spawnSource: 'agent', parentAgentSessionId: parentSessionId } : {}),
      }),
      getSession: () => undefined, // resolveSessionFile 的内存态腿（sessionFile 缺席 → undefined，respond 不携该字段）
      create: async (cwd: unknown, label: unknown, opts: Record<string, unknown> = {}) => {
        createCall = { cwd, label, opts }
        writeFileSync(
          childJsonl,
          JSON.stringify({ type: 'session', id: childId, cwd: String(cwd ?? sessionDir), timestamp: new Date().toISOString() }) + '\n',
        )
        persistAgentBinding(childJsonl, 'agent', String(opts.parentAgentSessionId))
        return {
          id: childId,
          label: String(label ?? FIXED_LABEL),
          cwd: String(cwd ?? sessionDir),
          status: 'active',
          lastActiveAt: Date.now(),
          modelId: 'xiaomi-token-plan-cn/mimo-v2.6-flash',
          tokenCount: 0,
        }
      },
    } as unknown as ISessionService

    // ── 3. runtime 真实链路接线（与组合根 server.ts 同款；IO 层换成 pi fixture）──
    // delivery：最小 stub——create 带 prompt（watch 三路径轨）时 sendDirect 走置空 stub
    // （即受理回执锚，claim 随即 markInjected）；send action 不被驱动；真实排队链路由
    // session-manager-send-queue.test.ts 覆盖。
    const responds: RecordedRespond[] = []
    const handler = new SessionManagerHandler({
      sessionService,
      claims,
      delivery: {
        getOrCreateDelivery: () => {
          throw new Error('send not exercised in this e2e')
        },
        sendDirect: async () => {},
        dispose: () => {},
        disposeAll: () => {},
      } as unknown as SessionManagerHandlerOptions['delivery'],
      // wire 映射对齐真实 rpc-client.sendExtensionUiResponse 的 select 分支（String → value）；
      // 捕获进 responds（watch 断言按 requestId 过滤）；返回 true = D7①「已写入发起方 pi
      // pending 表」（watch respond 以 === true 判成败，void/undefined 会计失败 → orphaned）。
      sendExtensionUiResponse: (_sessionId, requestId, response) => {
        const value = response === null ? null : String(response)
        responds.push({ requestId, value })
        const payload = response === null
          ? { type: 'extension_ui_response' as const, id: requestId, cancelled: true }
          : { type: 'extension_ui_response' as const, id: requestId, value: String(response) }
        fx.writeLine(JSON.stringify(payload))
        return true
      },
      broadcastSessionList: () => {},
    })
    let handling: Promise<void> = Promise.resolve()
    const interpreter = new EventInterpreter(parentSessionId, {
      send: () => {},
      onExtensionUIRequest: () => {},
      onSessionManagerRequest: (requestId, _sid, action, params) => {
        // fire-and-forget（与组合根一致）；promise 暴露给测试 await
        handling = handler.handle(requestId, parentSessionId, action, params)
      },
    })
    // 经真实 marker select 通道喂入任意 ui_request（与下方 create 步同链：translate →
    // interpreter → handler）；watch 三路径用它驱动开表/晚达/查无 claim 三分支。
    const feedUiRequest = async (event: PiStreamEvent): Promise<void> => {
      interpreter.interpret(translate(event as unknown as PiEvent, parentSessionId))
      await handling
    }

    // ── 4. prompt（faux 脚本化 toolCall → create_managed_session → 等 marker ui_request）──
    // （真实轨 2 次重试护栏已随翻轨删除：脚本化 toolCall 100% 确定，见 runFullChain docstring）
    const instruction
      = `Call the create_managed_session tool now with cwd='${sessionDir}' and label='${FIXED_LABEL}'`
        + (options.withPrompt ? ` and prompt='${FIXED_PROMPT}'` : '')
        + '. Call exactly this one tool and report its raw result. Do not explore the filesystem.'
    const tPrompt = Date.now()
    let uiRequest: PiStreamEvent | undefined
    await fx.sendCommand('prompt', { message: instruction }, 10_000)
    uiRequest = await fx.waitForEvent(
      (e) => e.type === 'extension_ui_request' && e.title === SESSION_MANAGER_MARKER,
      { timeoutMs: STEP_TIMEOUT_MS },
    )
    if (!uiRequest) throw new Error('extension_ui_request with SESSION_MANAGER_MARKER not observed (agent did not call the tool)')
    timings.promptToUiRequestMs = Date.now() - tPrompt

    // ── 5. 真实翻译/路由/处理：pi stdout 原始事件 → translate → interpreter → handler ──
    const tDispatch = Date.now()
    interpreter.interpret(translate(uiRequest as unknown as PiEvent, parentSessionId))
    await handling
    timings.dispatchMs = Date.now() - tDispatch

    // ── 6. 等 pi 侧工具返回（turn_end.toolResults 携带 create_managed_session 产出）──
    const toolResultEvent = await fx.waitForEvent(
      (e) => e.type === 'turn_end'
        && Array.isArray(e.toolResults)
        && e.toolResults.some((tr) => (tr as { toolName?: string }).toolName === 'create_managed_session'),
      { timeoutMs: STEP_TIMEOUT_MS },
    )
    timings.uiRequestToToolResultMs = Date.now() - tPrompt - timings.promptToUiRequestMs - timings.dispatchMs

    if (!createCall) throw new Error('handler 未调用 SessionService.create（extension_ui_request 后链路断裂）')
    return {
      result: {
        parentSessionId,
        childId,
        childJsonl,
        sidecarPath: agentSidecarPath(childJsonl),
        toolResultEvent,
        createCall,
        timings,
      },
      fx,
      cleanup,
      claims,
      handler,
      responds,
      feedUiRequest,
    }
  } catch (e) {
    await fx.dispose().catch(() => {})
    cleanup()
    throw e
  }
}

/** watch 三路径共用前置面（openClaimWatchChain 产出） */
interface WatchChain extends FullChain {
  parentSessionId: string
  /** create 携 prompt 产生的 kind=claim 债权键（extension 侧 crypto 生成，tool result 不回传） */
  claimNotifyId: string
  /** create result 回传的终身死亡载体键（用作 claim watch 的排除判据） */
  lifetimeNotifyId: string
  /** claim 的 watch 开表事件（marker select ui_request，尚未喂入 handler） */
  watchEvent: PiStreamEvent
  /** 该事件的 extension_ui_request id（respond 回写寻址键 = watchId） */
  watchRequestId: string
}

/**
 * watch 三路径共用前置：create 携 prompt 全链路（faux 轨）→ 债权面核验（claim injected /
 * lifetime armed）→ 等 extension 经真实 marker select 通道开表（claim watch 进事件流，
 * 刻意不喂入——各用例自行控制喂入时机以构造 deferred / catch-up / fail-closed 三分支）。
 * 任一步失败先收收尾（fx.dispose + cleanup）再抛，防 fixture/账本泄漏。
 */
async function openClaimWatchChain(): Promise<WatchChain> {
  const chain = await runFullChain({ withPrompt: true })
  try {
    const { result, fx, claims } = chain
    // create 结果（turn_end.toolResults 原样回传 handler respond 的 JSON）：
    // willNotify:true = kind=claim 已 arm；lifetimeNotifyId = lifetime 已 arm（恒携）
    const toolResults = result.toolResultEvent.toolResults as Array<{ toolName: string; content: Array<{ type: string; text?: string }> }>
    const tr = toolResults.find((r) => r.toolName === 'create_managed_session')
    const toolText = tr?.content?.[0]?.text ?? 'null'
    const payload = JSON.parse(toolText) as { willNotify?: boolean; lifetimeNotifyId?: unknown }
    expect(payload.willNotify, `create 携 prompt 应 willNotify:true，实际：${toolText}`).toBe(true)
    if (typeof payload.lifetimeNotifyId !== 'string') throw new Error(`create result missing lifetimeNotifyId: ${toolText}`)
    const lifetimeNotifyId = payload.lifetimeNotifyId

    // 开表事件：两张 watch（claim 先、lifetime 后——extension onResult 代码序）经真实
    // marker select 通道进事件流；以「≠ lifetimeNotifyId」认领 claim 那张
    const watchEvent = await fx.waitForEvent(
      (e) => {
        const nid = watchNotifyIdOf(e)
        return nid !== undefined && nid !== lifetimeNotifyId
      },
      { timeoutMs: STEP_TIMEOUT_MS },
    )
    const claimNotifyId = watchNotifyIdOf(watchEvent)
    if (!claimNotifyId) throw new Error('claim watch notifyId unparsable from ui_request payload')
    const watchRequestId = String(watchEvent.id ?? '')
    if (watchRequestId === '') throw new Error('watch ui_request missing id')

    // 债权面核验：claim = armed → injected（create 路径 sendDirect 受理回执锚，D2）；
    // lifetime = armed（死亡载体健康稳态）；watch 尚未喂入 → 槽未登记
    const parentSessionId = result.parentSessionId
    expect(claims.getClaim(parentSessionId, claimNotifyId)?.state, 'claim 应为 injected（sendDirect 受理回执锚）').toBe('injected')
    expect(claims.getClaim(parentSessionId, lifetimeNotifyId)?.state, 'lifetime 应为 armed').toBe('armed')
    expect(claims.getClaim(parentSessionId, claimNotifyId)?.watchId, '开表前 claim 尚无 watch 槽').toBeUndefined()

    return { ...chain, parentSessionId, claimNotifyId, lifetimeNotifyId, watchEvent, watchRequestId }
  } catch (e) {
    await chain.fx.dispose().catch(() => {})
    chain.cleanup()
    throw e
  }
}

/** 开表挂等共用腿（U9-S3 / U9-D1 前置）：真实通道喂入 watch → deferred（wait）路由，断言零 respond。 */
async function feedWatchDeferring(w: WatchChain): Promise<void> {
  await w.feedUiRequest(w.watchEvent)
  expect(w.responds.filter((r) => r.requestId === w.watchRequestId), 'deferred 阶段不应有 respond').toHaveLength(0)
}

/** watch 回写断言共用腿：按 requestId 过滤恰一条 respond + JSON 解析 payload toMatchObject。 */
function expectSingleWatchRespond(w: WatchChain, payload: Record<string, unknown>, message: string): void {
  const watchResponds = w.responds.filter((r) => r.requestId === w.watchRequestId)
  expect(watchResponds, message).toHaveLength(1)
  expect(JSON.parse(watchResponds[0]?.value ?? 'null')).toMatchObject(payload)
}

/** claim 已销账断言（settle 兑现回收 / clearSession 清账 / 死亡收口后共用）。 */
function expectClaimRecycled(w: WatchChain): void {
  expect(w.claims.getClaim(w.parentSessionId, w.claimNotifyId)).toBeUndefined()
}

describe.skipIf(!FAUX_PI_READY)(`session-manager full e2e faux pi${FAUX_PI_READY ? '' : `（skip：${FAUX_PI_SKIP_REASON}）`}`, () => {
  it('U9-S1 真 pi 全链路 create：agent 调 create_managed_session → marker 通道 → 真实 handler → 回写 → 工具返回 + sidecar 写入', { timeout: 80_000 }, async () => {
    const { result, fx, cleanup } = await runFullChain()
    try {
      // 1. 工具在护栏内返回：turn_end.toolResults 含 create_managed_session 且结果 JSON 携带子 sessionId
      const toolResults = result.toolResultEvent.toolResults as Array<{ toolName: string; content: Array<{ type: string; text?: string }>; isError?: boolean }>
      const tr = toolResults.find((r) => r.toolName === 'create_managed_session')
      expect(tr, `turn_end.toolResults 应含 create_managed_session：${JSON.stringify(toolResults)}`).toBeDefined()
      expect(tr?.isError, `工具结果不应为 error：${JSON.stringify(tr?.content)}`).toBeFalsy()
      // extension 把 handler respond 的 JSON 原样作为 text 返回给 agent
      const toolPayload = JSON.parse(tr?.content?.[0]?.text ?? 'null') as { sessionId?: string; status?: string }
      expect(toolPayload.sessionId, `工具结果应含子 sessionId，实际：${JSON.stringify(tr?.content)}`).toBe(result.childId)
      expect(toolPayload.status, `工具结果 status 应为 created，实际：${JSON.stringify(tr?.content)}`).toBe('created')

      // 2. handler 以 runtime 注入的身份调用 create（spawnSource 服务端注入，不信任请求侧）
      expect(result.createCall.opts.spawnSource).toBe('agent')
      expect(result.createCall.opts.parentAgentSessionId).toBe(result.parentSessionId)
      expect(result.createCall.label).toBe(FIXED_LABEL)

      // 3. sidecar 已写入 JSONL 旁，内容 spawnSource='agent' + 父 id
      const sidecar = JSON.parse(readFileSync(result.sidecarPath, 'utf-8')) as { spawnSource: string; parentAgentSessionId: string }
      expect(sidecar.spawnSource).toBe('agent')
      expect(sidecar.parentAgentSessionId).toBe(result.parentSessionId)

      console.log('[u9-e2e] U9-S1 timings(ms):', JSON.stringify(result.timings))
    } finally {
      await fx.dispose().catch(() => {})
      cleanup()
    }
  })

  it('U9-S2 重启恢复：sidecar 落盘后 scanPiSessions({force:true}) 恢复 spawnSource/parentAgentSessionId', { timeout: 80_000 }, async () => {
    const { result, fx, cleanup } = await runFullChain()
    try {
      // 前置：U9-S1 同款落盘已完成（sidecar 存在）
      expect(readFileSync(result.sidecarPath, 'utf-8')).toContain('"spawnSource":"agent"')

      // 重启恢复语义：不依赖内存态，从磁盘重扫（force 旁路 1s 目录 TTL 缓存）
      invalidateScanDirCache()
      const scanned = scanPiSessions({ force: true })
      const recovered = scanned.find((m) => m.id === result.childId)
      expect(recovered, `scanPiSessions 应恢复出子 session ${result.childId}，实际扫描到：${scanned.map((m) => `${m.id}@${m.filePath}`).join(', ') || '(none)'}`).toBeDefined()
      expect(recovered?.spawnSource).toBe('agent')
      expect(recovered?.parentAgentSessionId).toBe(result.parentSessionId)

      console.log('[u9-e2e] U9-S2 timings(ms):', JSON.stringify(result.timings))
    } finally {
      await fx.dispose().catch(() => {})
      cleanup()
    }
  })

  // ── watch 桥三路径（设计 §4 场景 9 / D2 watch 路由三分支 / D4 兑现锚与 catch-up）────
  // 三用例共用前置 = openClaimWatchChain（create 携 prompt → claim injected + extension
  // 经真实 marker select 通道开表，watch 事件刻意不喂入，各用例自控喂入时机）。
  // 偏离登记（按 §4-9「handler 真实通道集成」意图的最小可达形态）：
  //   ① 入站 watch 与出站 respond 均走真实通道（translate → interpreter → handler →
  //     extension_ui_response 回写 pi stdin），但 U9-S3 的 settle 兑现腿由测试直调
  //     claims.settle + deliverRespondTargets（与组合根 index.ts 同函数同序）——faux 轨
  //     无真实子 pi 进程，产不出子会话 agent_settled 事件；
  //   ② U9-S5 的「查无 claim」以 claims.clearSession 构造（等价 D8-v1 runtime 重启内存
  //     账本全失形态），非真实 runtime 重启；
  //   ③ lifetime watch 开表后刻意不喂（fire-and-forget 悬 promise = P1 已知无害）。
  //   ④ U9-D1/D2 的死亡收口腿由测试直调 claims.onSessionDeath + deliverRespondTargets +
  //     clearSession（组合根 index.ts speakSessionDeath 同函数同序三步）——faux 轨无真实
  //     子 pi 进程可 kill（同①困境：进程死亡事件边界在组合根 pm.onSessionExit，不在本
  //     文件可触碰面），exit 现场以 pm 上报形态注入 extra（stderrTail 经真实 collectStderrTail）；
  //     被测面 = 死亡批分流 → 词形映射（toWatchRespondPayload cause 分派 exited/deleted +
  //     退出现场附加）→ watch 写回通道闭环 + 发声幂等。
  it('U9-S3 watch 开表挂等：marker 通道 watch → handler deferred → settle 兑现 respond', { timeout: 80_000 }, async () => {
    const w = await openClaimWatchChain()
    try {
      // 1. 开表：真实通道入站 → 路由 deferred（wait）——零 respond，watch 槽已登记
      await feedWatchDeferring(w)
      expect(w.claims.getClaim(w.parentSessionId, w.claimNotifyId)?.watchId, 'wait 路由应登记 watch 槽').toBe(w.watchRequestId)

      // 2. 后续 settle 兑现：injected → fulfilled + 经同一写回通道 respond
      //（与组合根 index.ts settle 兑现腿同函数同序；faux 轨无子 pi → 测试直调，见上方偏离登记）
      const batch = w.claims.settle(w.result.childId, 'done')
      expect(batch.targets, '已挂 watch 的 injected claim 应进 respond 批').toHaveLength(1)
      deliverRespondTargets(w.claims, batch.targets, w.handler.watchRespond)

      expectSingleWatchRespond(w, { reason: 'completed', sessionId: w.result.childId, settleSeq: 1, fulfillsN: 1 }, 'settle 后应恰有一条经真实通道回写的 respond')
      // onRespond(true) → 记录回收（extension 应答后的下一次 watch 将 fail-closed）
      expectClaimRecycled(w)
    } finally {
      await w.fx.dispose().catch(() => {})
      w.cleanup()
    }
  })

  it('U9-S4 晚 respond catch-up：watch 到达时 claim 已 fulfilled → 立即快照 respond', { timeout: 80_000 }, async () => {
    const w = await openClaimWatchChain()
    try {
      // 1. watch 尚未喂入前先兑现（fulfilled-no-watch：settle 零 respond 批，D4 锚先行）
      const batch = w.claims.settle(w.result.childId, 'error')
      expect(batch.targets, '兑现时 watch 未挂 → 零 respond 批').toHaveLength(0)
      expect(w.claims.getClaim(w.parentSessionId, w.claimNotifyId)?.state).toBe('fulfilled')

      // 2. 晚达 watch → 立即快照 respond（catch-up 分支，本次 handle 内收口）
      await w.feedUiRequest(w.watchEvent)
      // reason 'failed'：outcome 'error' → 协议词形 failed（映射单点 toWatchRespondPayload）
      expectSingleWatchRespond(w, { reason: 'failed', sessionId: w.result.childId, settleSeq: 1, fulfillsN: 1 }, 'catch-up 应在 handle 内立即回写')
      expectClaimRecycled(w)
    } finally {
      await w.fx.dispose().catch(() => {})
      w.cleanup()
    }
  })

  it('U9-S5 watch fail-closed：查无 claim → 立即 respond cancelled（静默收口）', { timeout: 80_000 }, async () => {
    const w = await openClaimWatchChain()
    try {
      // 1. 构造「查无 claim」：清空该 session 全部记录 ≙ D8-v1 runtime 重启内存账本全失形态
      const removed = w.claims.clearSession(w.result.childId)
      expect(removed, 'claim + lifetime 双记录应被清空').toBe(2)
      expectClaimRecycled(w)

      // 2. watch 经真实通道到达 → fail-closed 立即应答（防长挂 select 泄漏）
      await w.feedUiRequest(w.watchEvent)
      const watchResponds = w.responds.filter((r) => r.requestId === w.watchRequestId)
      expect(watchResponds, 'fail-closed 应立即回写').toHaveLength(1)
      // 无 claim 可回带 → 不携 sessionId（D-4）；extension 侧折叠静默 unregister 收口
      expect(JSON.parse(watchResponds[0]?.value ?? 'null')).toEqual({ reason: 'cancelled' })
    } finally {
      await w.fx.dispose().catch(() => {})
      w.cleanup()
    }
  })

  // ── 死亡收口（notify-once D5「死亡也通知恰一次」执行面；装配偏离见上方偏离登记④）────
  // 两用例共用前置 = openClaimWatchChain + 开表挂等（claim 经真实 handler wait 路由登记
  // watch 槽），死亡腿按组合根 speakSessionDeath 同函数同序三步直调（onSessionDeath →
  // deliverRespondTargets → clearSession），被测对象是死亡批 → 词形映射 → watch 写回通道
  // 的端到端闭环（账本内环语义由 notify-claims.test.ts / notify-claims-state.test.ts 覆盖）。
  it('U9-D1 死亡收口：子会话意外退出 → watch 挂等 claim 恰收一条 reason:exited（携 exitCode/stderrTail），destroy 迟到二次发声幂等', { timeout: 80_000 }, async () => {
    const w = await openClaimWatchChain()
    try {
      // 1. 开表挂等：真实通道入站 → handler wait 路由登记 watch 槽（U9-S3 同款，零 respond）
      await feedWatchDeferring(w)

      // 2. 子会话进程意外退出 → 死亡收口三步（偏离登记④）：「session 不在内存」腿 =
      //    fake SessionService.getSession 恒 undefined 的生产同判形态；退出现场 exitCode/
      //    stderrTail 以 pm.onSessionExit 上报形态注入，stderrTail 经真实 collectStderrTail
      const stderr = 'pi exited: Fatal error in extension handler\n  at onExit (...)\n'
      const batch = w.claims.onSessionDeath(w.result.childId, 'exit')
      expect(batch.targets, 'watch 挂等的 claim 应进死亡 respond 批').toHaveLength(1)
      deliverRespondTargets(w.claims, batch.targets, w.handler.watchRespond, {
        sessionFilePath: w.result.childJsonl,
        exitCode: 1,
        stderrTail: collectStderrTail(stderr),
      })
      w.claims.clearSession(w.result.childId)

      // 3. 恰一条经真实通道回写的 death respond：词形 exited + deathSeq/fulfillsN + 退出现场三件
      expectSingleWatchRespond(w, {
        reason: 'exited',
        sessionId: w.result.childId,
        deathSeq: 1,
        fulfillsN: 1,
        exitCode: 1,
        stderrTail: collectStderrTail(stderr),
      }, '死亡收口应恰有一条 respond')

      // 4. destroy 迟到二次发声：死亡腿重放对已销账账本空批空转（组合根 speakSessionDeath
      //    幂等——「重复调用空批空转」），watch 通道不再收第二条
      const replay = w.claims.onSessionDeath(w.result.childId, 'exit')
      expect(replay.terminated, '重放应空批（死亡已销账）').toHaveLength(0)
      deliverRespondTargets(w.claims, replay.targets, w.handler.watchRespond)
      w.claims.clearSession(w.result.childId)
      expect(w.responds.filter((r) => r.requestId === w.watchRequestId), 'destroy 迟到不得二次发声').toHaveLength(1)
      expectClaimRecycled(w)
    } finally {
      await w.fx.dispose().catch(() => {})
      w.cleanup()
    }
  })

  it('U9-D2 死亡词形分派：managed 删除（cause=delete）→ watch 恰收 reason:deleted（不携退出现场）', { timeout: 80_000 }, async () => {
    const w = await openClaimWatchChain()
    try {
      // 1. 开表挂等（同 U9-D1）
      await w.feedUiRequest(w.watchEvent)

      // 2. 组合根 delete 汇聚点（subscribeSessionDeathDisposition 'delete' → speakSessionDeath
      //    同函数同序，偏离登记④）：无退出现场 extra——delete 腿不携 exitCode/stderrTail
      const batch = w.claims.onSessionDeath(w.result.childId, 'delete')
      expect(batch.targets, 'watch 挂等的 claim 应进死亡 respond 批').toHaveLength(1)
      deliverRespondTargets(w.claims, batch.targets, w.handler.watchRespond)
      w.claims.clearSession(w.result.childId)

      // 3. 词形分派：cause=delete → reason:'deleted'（toWatchRespondPayload cause 分派单点）
      const watchResponds = w.responds.filter((r) => r.requestId === w.watchRequestId)
      expect(watchResponds, 'delete 死亡应恰有一条 respond').toHaveLength(1)
      const payload = JSON.parse(watchResponds[0]?.value ?? 'null')
      expect(payload).toMatchObject({ reason: 'deleted', sessionId: w.result.childId, deathSeq: 1, fulfillsN: 1 })
      expect(payload.exitCode, 'delete 词形不携退出现场').toBeUndefined()
      expect(payload.stderrTail, 'delete 词形不携退出现场').toBeUndefined()
    } finally {
      await w.fx.dispose().catch(() => {})
      w.cleanup()
    }
  })
})
