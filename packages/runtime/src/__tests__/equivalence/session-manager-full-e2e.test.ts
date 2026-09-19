/**
 * session-manager 真 pi 全链路 e2e（U9-S1 / U9-S2）— 设计文档 §7.2 场景 1 + §7.3 重启恢复的机器化。
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
import { SessionManagerHandler } from '../../transport/session-manager-handler.js'
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

/** 全链路执行结果（两个验收用例的消费面） */
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
 * faux LLM 轨（L2.5 翻轨）：agent 的工具调用由 fauxResponses 脚本固定（toolCalls 步骤
 * 100% 确定），真实 LLM 时代「agent 是否真调工具不受控」的 2 次重试护栏已随翻轨删除
 * （[HISTORICAL] 2026-09 真实轨曾因 LLM 偶尔不调工具连红；脚本化后不确定性结构性
 * 消失，单发 prompt 即达，断言强度不变）。
 */
async function runFullChain(): Promise<{ result: FullChainResult; fx: PiFixture; cleanup: () => void }> {
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
  // 100% 确定触发）；步骤 2 = 工具结果回填后的收尾文本（turn 定局）
  const fx = await spawnPiFixture({
    extensions: [EXTENSION_PATH],
    sessionDir,
    commandTimeoutMs: STEP_TIMEOUT_MS,
    fauxResponses: [
      { toolCalls: [{ name: 'create_managed_session', args: { cwd: sessionDir, label: FIXED_LABEL } }] },
      { text: 'create_managed_session returned.' },
    ],
  })
  timings.coldStartMs = Date.now() - t0

  const cleanup = (): void => {
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
      getSummary: (id: string) => ({ id }),
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
          modelId: 'xiaomi-token-plan-cn/mimo-v2.5-pro',
          tokenCount: 0,
        }
      },
    } as unknown as ISessionService

    // ── 3. runtime 真实链路接线（与组合根 server.ts 同款；IO 层换成 pi fixture）──
    // delivery：最小 stub——本 e2e 的 create 不带 prompt（sendDirect 不触发）、
    // send action 不被驱动；真实排队链路由 session-manager-send-queue.test.ts 覆盖。
    const handler = new SessionManagerHandler({
      sessionService,
      delivery: {
        getOrCreateDelivery: () => {
          throw new Error('send not exercised in this e2e')
        },
        sendDirect: async () => {},
        dispose: () => {},
        disposeAll: () => {},
      } as unknown as SessionManagerHandlerOptions['delivery'],
      // wire 映射对齐真实 rpc-client.sendExtensionUiResponse 的 select 分支（String → value）
      sendExtensionUiResponse: (_sessionId, requestId, response) => {
        const payload = response === null
          ? { type: 'extension_ui_response' as const, id: requestId, cancelled: true }
          : { type: 'extension_ui_response' as const, id: requestId, value: String(response) }
        fx.writeLine(JSON.stringify(payload))
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

    // ── 4. prompt（faux 脚本化 toolCall → create_managed_session → 等 marker ui_request）──
    // （真实轨 2 次重试护栏已随翻轨删除：脚本化 toolCall 100% 确定，见 runFullChain docstring）
    const instruction
      = `Call the create_managed_session tool now with cwd='${sessionDir}' and label='${FIXED_LABEL}'. `
        + 'Call exactly this one tool and report its raw result. Do not explore the filesystem.'
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
    }
  } catch (e) {
    await fx.dispose().catch(() => {})
    cleanup()
    throw e
  }
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
})
