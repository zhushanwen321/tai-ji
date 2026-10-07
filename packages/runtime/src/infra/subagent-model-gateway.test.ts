/**
 * SubagentModelSwitchGateway 生产适配器测试（subagent-model-switch §7.1.1，U6）。
 *
 * 覆盖（三路主轴 + 映射 + 守卫 + handler 集成）：
 * - 成功：mock client.prompt 回调写 tmp 结果文件 → 应答映射（chat 两型 / run 级聚合）
 *   + 文件读后即删；
 * - 超时：fake timers 推进 + 迟到真值命中按真实结果应答；未命中 reject 通道失败
 *   （错误消息含恢复动作「重试切换」，§7.5 通道行）；
 * - 文件缺失：prompt 正常解析但无文件 → 通道失败；
 * - resolveSessionId 定位锚（run journal / record events 存在性）；
 * - handler 集成：生产网关注入 SubagentMessageHandler → 不再回 unwired 兜底。
 *
 * 测试框架：vitest（从子包目录运行）；timer 用 fake timers；落盘全在 mkdtemp tmp。
 * 运行：cd packages/runtime && npx vitest run src/infra/subagent-model-gateway.test.ts
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage, SubagentSetModelAggregateReply, SubagentSetModelMemberFailure, SubagentSetModelMemberState, SubagentSetModelReply } from '@taiji/shared'
import { SUBAGENT_SET_MODEL_ACCOUNTED_ERROR_CODES } from '@taiji/shared'
import { ACCOUNTED_SET_MODEL_ERROR_CODES, getSubagentModelSwitchResultsDir } from '@zhushanwen/subagent-core'
import type { RunSwitchAggregateResult, RunSwitchMemberFailure, RunSwitchMemberState } from '@zhushanwen/subagent-core'
import { SET_MODEL_ERROR_CODES } from '@zhushanwen/subagent-engine-sdk'

import { createSubagentModelSwitchGateway, MODEL_SWITCH_PROMPT_TIMEOUT_MS } from './subagent-model-gateway.js'
import type { SubagentModelGatewayDeps, SubagentModelPromptClient } from './subagent-model-gateway.js'
import type { ScannedSessionMeta } from '../services/ports/session.js'
import { SubagentMessageHandler } from '../transport/subagent-message-handler.js'
import type { SubagentHandlerContext } from '../transport/subagent-message-handler.js'

// ── fixture ──────────────────────────────────────────────────────────────

let root: string
let agentDir: string
let sessionCwd: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'subagent-model-gw-'))
  agentDir = join(root, 'agent')
  sessionCwd = join(root, 'proj')
  mkdirSync(join(agentDir, 'sessions', '--slug--'), { recursive: true })
  mkdirSync(sessionCwd, { recursive: true })
  // 通道机制用例的默认锚：record 事件文件在场 = 目标可解析（解析锚用例单独覆盖缺锚形态）
  seedRecordEvent('sa-1')
  seedRunJournal('wf-1')
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

const SESSION_ID = 'main-session-1'

function scannedSession(): ScannedSessionMeta {
  return {
    id: SESSION_ID,
    filePath: join(agentDir, 'sessions', '--slug--', `2026-01-01T00-00-00-000Z_${SESSION_ID}.jsonl`),
    cwd: sessionCwd,
    timestamp: '2026-01-01T00:00:00.000Z',
    name: null,
    lastModified: 0,
    size: 0,
    outcome: null,
  } as ScannedSessionMeta
}

/** mock client：prompt 调用记录 + 可注入回执写入行为（照 extension handler 侧真实动作）。 */
interface PromptStub extends SubagentModelPromptClient { // oe-exempt:20261006:test:测试专用 prompt 桩装配单实现为常态
  calls: string[]
}

function promptStub(action: 'write-and-resolve' | 'hang' | 'resolve-only' | 'reject', reply?: unknown): PromptStub {
  const stub: PromptStub = {
    calls: [],
    prompt(content: string): Promise<unknown> {
      stub.calls.push(content)
      if (action === 'write-and-resolve') {
        writeResultFileFromPayload(content, reply)
        return Promise.resolve({})
      }
      if (action === 'hang') return new Promise(() => {})
      if (action === 'reject') return Promise.reject(new Error('rpc pipe closed'))
      return Promise.resolve({})
    },
  }
  return stub
}

/** 结果文件路径与内容（requestId 由 prompt 载荷承载——与生产 extension 侧同构）。 */
function resultsDir(): string {
  return getSubagentModelSwitchResultsDir(agentDir, sessionCwd)
}

function writeResultFileFromPayload(promptContent: string, reply: unknown): void {
  const payload = JSON.parse(promptContent.slice('/subagent-model '.length)) as { requestId: string }
  mkdirSync(resultsDir(), { recursive: true })
  writeFileSync(join(resultsDir(), `${payload.requestId}.json`), JSON.stringify(reply))
}

function writeResultFileNamed(requestId: string, reply: unknown): void {
  mkdirSync(resultsDir(), { recursive: true })
  writeFileSync(join(resultsDir(), `${requestId}.json`), JSON.stringify(reply))
}

function deps(overrides?: Partial<SubagentModelGatewayDeps>): SubagentModelGatewayDeps {
  return {
    getClient: () => promptStub('resolve-only'),
    scanSessions: () => [scannedSession()],
    agentDir,
    ...overrides,
  }
}

function setModelParams(recordId?: string, runId?: string): {
  recordId?: string
  runId?: string
  provider: string
  modelId: string
  thinkingLevel?: string
} {
  return {
    ...(recordId !== undefined ? { recordId } : {}),
    ...(runId !== undefined ? { runId } : {}),
    provider: 'zai-coding-cn',
    modelId: 'glm-5.3-flash',
  }
}

/** 事件文件预置（归属判定锚：信封首行 + record-created 帧 rootSessionId === 会话 id——
 *  D3-A4 修复后目录存在性只作过滤，归属按 created 帧 rootSessionId 精确匹配；
 *  真实文件形态 = 首行 record-events 信封（无 rootSessionId）+ 第 2 行 created 帧，
 *  sa-ef73dfb7 实证——读取器按 type 过滤多行扫描，不假设行号）。 */
function seedRecordEvent(recordId: string, ownerSessionId: string = SESSION_ID): void {
  const recordsDir = join(agentDir, 'subagents', encodeCwdForTest(sessionCwd), 'records')
  mkdirSync(recordsDir, { recursive: true })
  const envelope = { type: 'record-events', id: recordId }
  const created = { type: 'record-created', seq: 1, ts: 1, id: recordId, rootSessionId: ownerSessionId }
  writeFileSync(
    join(recordsDir, `${recordId}.events`),
    `${JSON.stringify(envelope)}\n${JSON.stringify(created)}\n`,
  )
}
/** run journal 预置（resolveSessionId 定位锚：workflow-state journal 存在性）。 */
function seedRunJournal(runId: string): void {
  const journalDir = join(dirname(scannedSession().filePath), 'workflow-state')
  mkdirSync(journalDir, { recursive: true })
  writeFileSync(join(journalDir, `${runId}.record.jsonl`), '')
}
/** enc 段编码（测试侧镜像 core encodeCwd——布局单源在 path-encoding.ts，此处只造锚）。 */
function encodeCwdForTest(cwd: string): string {
  return '--' + cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-') + '--'
}

// ── 成功路：结果文件映射 + 读后即删 ──────────────────────────────────────

describe('createSubagentModelSwitchGateway — 成功路（写后读 + 映射 + 删除）', () => {
  it('chat 域已生效型：应答映射 effective + 结果文件已删', async () => {
    const client = promptStub('write-and-resolve', {
      scope: 'chat',
      reply: { kind: 'effective', effectiveModel: { provider: 'zai-coding-cn', modelId: 'glm-5.3' }, effectiveThinkingLevel: 'high' },
    })
    const gw = createSubagentModelSwitchGateway(deps({ getClient: () => client }))

    const reply = await gw.setModel(setModelParams('sa-1'))

    expect(reply).toEqual({
      kind: 'effective',
      effectiveModel: { provider: 'zai-coding-cn', modelId: 'glm-5.3' },
      effectiveThinkingLevel: 'high',
    })
    // 出站点命令形态（§7.1.1 要素 1：单行 JSON 载荷）
    expect(client.calls).toHaveLength(1)
    expect(client.calls[0]).toMatch(/^\/subagent-model \{/)
    const payload = JSON.parse(client.calls[0]!.slice('/subagent-model '.length)) as { requestId: string; recordId?: string }
    expect(payload.recordId).toBe('sa-1')
    expect(payload.requestId).toMatch(/^[\w-]+$/)
    // 读后即删（请求作用域生命周期，§7.1.1 要素 4）
    expect(existsSync(join(resultsDir(), `${payload.requestId}.json`))).toBe(false)
  })

  it('chat 域已记账型：core notice → wire note 唯一改名位', async () => {
    const client = promptStub('write-and-resolve', {
      scope: 'chat',
      reply: { kind: 'recorded', notice: '已记录，下次执行生效。' },
    })
    const gw = createSubagentModelSwitchGateway(deps({ getClient: () => client }))

    const reply = await gw.setModel(setModelParams('sa-1'))

    expect(reply).toEqual({ kind: 'recorded', note: '已记录，下次执行生效。' })
  })

  it('run 级聚合：members/failures/summary 三组件结构透传', async () => {
    const client = promptStub('write-and-resolve', {
      scope: 'workflow-run',
      aggregate: {
        members: [
          { runId: 'sa-a', state: 'switched', effectiveModel: { provider: 'p', modelId: 'm' }, effectiveThinkingLevel: 'low' },
          { runId: 'sa-b', state: 'not-active' },
        ],
        failures: [{ runId: 'sa-c', reason: 'engine_model_not_in_snapshot' }],
        summary: '已切换，未派发步骤生效',
      },
    })
    const gw = createSubagentModelSwitchGateway(deps({ getClient: () => client }))

    const reply = (await gw.setModel(setModelParams(undefined, 'wf-1'))) as Extract<SubagentSetModelReply, { members: unknown[] }>

    expect(reply.members).toHaveLength(2)
    expect(reply.failures).toEqual([{ runId: 'sa-c', reason: 'engine_model_not_in_snapshot' }])
    expect(reply.summary).toContain('未派发步骤生效')
    expect(client.calls[0]).toContain('"runId":"wf-1"')
  })
})

// ── 超时路：fake timers + 迟到真值 / 未命中 ─────────────────────────────

describe('createSubagentModelSwitchGateway — 超时（fake timers）', () => {
  it('超时前结果文件已落（迟到真值）：按真实结果应答，不吞真值', async () => {
    vi.useFakeTimers()
    const client = promptStub('hang')
    let payloadRequestId = ''
    const origPrompt = client.prompt.bind(client)
    client.prompt = (content: string) => {
      const payload = JSON.parse(content.slice('/subagent-model '.length)) as { requestId: string }
      payloadRequestId = payload.requestId
      writeResultFileNamed(payload.requestId, {
        scope: 'chat',
        reply: { kind: 'recorded', notice: '已记录，下次执行生效。' },
      })
      return origPrompt(content)
    }
    const gw = createSubagentModelSwitchGateway(deps({ getClient: () => client }))

    const pending = gw.setModel(setModelParams('sa-1'))
    const expectation = expect(pending).resolves.toEqual({ kind: 'recorded', note: '已记录，下次执行生效。' })
    await vi.advanceTimersByTimeAsync(MODEL_SWITCH_PROMPT_TIMEOUT_MS)
    await expectation
    expect(payloadRequestId).not.toBe('')
    expect(existsSync(join(resultsDir(), `${payloadRequestId}.json`))).toBe(false)
  })

  it('超时未命中：reject 通道失败，错误消息含恢复动作「重试切换」', async () => {
    vi.useFakeTimers()
    const gw = createSubagentModelSwitchGateway(deps({ getClient: () => promptStub('hang') }))

    const pending = gw.setModel(setModelParams('sa-1'))
    const expectation = expect(pending).rejects.toThrow('重试切换')
    await vi.advanceTimersByTimeAsync(MODEL_SWITCH_PROMPT_TIMEOUT_MS)
    await expectation
  })
})

// ── 文件缺失 / prompt 失败：通道失败分型 ─────────────────────────────────

describe('createSubagentModelSwitchGateway — 通道失败（§7.5 通道行）', () => {
  it('prompt 正常解析但结果文件缺失：reject 通道失败（不虚构未生效）', async () => {
    const gw = createSubagentModelSwitchGateway(deps({ getClient: () => promptStub('resolve-only') }))

    await expect(gw.setModel(setModelParams('sa-1'))).rejects.toThrow(
      /结果回执缺失.*重试切换/s,
    )
  })

  it('prompt 本身失败：通道失败 + 原始错误随行', async () => {
    const gw = createSubagentModelSwitchGateway(deps({ getClient: () => promptStub('reject') }))

    await expect(gw.setModel(setModelParams('sa-1'))).rejects.toThrow(/rpc pipe closed.*重试切换/s)
  })

  it('结果文件 scope 未知：通道形状损坏（不猜）', async () => {
    const client = promptStub('write-and-resolve', { scope: 'mystery' })
    const gw = createSubagentModelSwitchGateway(deps({ getClient: () => client }))

    await expect(gw.setModel(setModelParams('sa-1'))).rejects.toThrow(/形状损坏|scope 未知/)
  })

  it('chat 域 error 应答：分型 code 透传（handler 转 error envelope）', async () => {
    const client = promptStub('write-and-resolve', {
      scope: 'chat',
      reply: { kind: 'error', errorCode: 'engine_credential_missing', message: '模型 X 缺少 API key，切换未生效' },
    })
    const gw = createSubagentModelSwitchGateway(deps({ getClient: () => client }))

    const err = await gw.setModel(setModelParams('sa-1')).catch((e: Error & { code?: string }) => e)
    expect((err as Error & { code?: string }).code).toBe('engine_credential_missing')
    expect((err as Error).message).toContain('API key')
  })

  it('scope error（校验型失败）：域内 code + message 透传', async () => {
    const client = promptStub('write-and-resolve', { scope: 'error', message: 'run 已终局，无后续步骤可应用' })
    const gw = createSubagentModelSwitchGateway(deps({ getClient: () => client }))

    const err = await gw.setModel(setModelParams(undefined, 'wf-1')).catch((e: Error & { code?: string }) => e)
    expect((err as Error & { code?: string }).code).toBe('subagent_model_switch_failed')
    expect((err as Error).message).toContain('已终局')
  })
})

// ── 守卫：目标解析 / 会话激活 ────────────────────────────────────────────

describe('createSubagentModelSwitchGateway — 守卫', () => {
  it('目标解析不到（无 journal / events 锚）：subagent_target_not_found', async () => {
    const gw = createSubagentModelSwitchGateway(deps())
    const err = await gw.setModel(setModelParams('sa-ghost')).catch((e: Error & { code?: string }) => e)
    expect((err as Error & { code?: string }).code).toBe('subagent_target_not_found')
    expect((err as Error).message).toContain('未找到目标')
  })

  it('getClient 缺席（pi 进程不在场）：session_not_active + 恢复指引', async () => {
    seedRecordEvent('sa-1')
    const gw = createSubagentModelSwitchGateway(deps({ getClient: () => undefined }))
    await expect(gw.setModel(setModelParams('sa-1'))).rejects.toThrow(/not active.*激活该会话后重试/s)
  })

  it('resolveSessionId：recordId 按 events 存在性 + rootSessionId 归属命中；未知目标 undefined', () => {
    seedRecordEvent('sa-1')
    const gw = createSubagentModelSwitchGateway(deps())
    expect(gw.resolveSessionId({ recordId: 'sa-1' })).toBe(SESSION_ID)
    expect(gw.resolveSessionId({ recordId: 'sa-ghost' })).toBeUndefined()
    expect(gw.resolveSessionId({})).toBeUndefined()
  })

  it('resolveSessionId：共享 cwd 多会话时按 rootSessionId 归属判定，不误路由首个会话（D3-A4 回归）', () => {
    const OTHER_ID = 'main-session-2'
    const other = { ...scannedSession(), id: OTHER_ID, lastModified: 1 }
    seedRecordEvent('sa-1', OTHER_ID)
    const gw = createSubagentModelSwitchGateway(
      deps({ scanSessions: () => [scannedSession(), other as ScannedSessionMeta] }),
    )
    // events 文件在共享 recordsDir 下对两个会话都「存在」——归属必须命中 rootSessionId 所有权，非首序
    expect(gw.resolveSessionId({ recordId: 'sa-1' })).toBe(OTHER_ID)
  })

  it('resolveSessionId：runId 按 workflow-state journal 存在性命中', () => {
    const gw = createSubagentModelSwitchGateway(deps())
    expect(gw.resolveSessionId({ runId: 'wf-1' })).toBe(SESSION_ID)
  })
})

// ── handler 集成：生产网关注入后不再回 unwired ───────────────────────────

describe('SubagentMessageHandler ← 生产网关注入（组合根形态）', () => {
  function setModelMsg(payload: Record<string, unknown>, id = 'req-1'): ClientMessage {
    return { type: 'subagent.setModel', payload, id } as unknown as ClientMessage
  }

  it('注入 createSubagentModelSwitchGateway 产物：reply 回执而非 subagent_model_switch_unwired', async () => {
    seedRecordEvent('sa-1')
    const client = promptStub('write-and-resolve', {
      scope: 'chat',
      reply: { kind: 'effective', effectiveModel: { provider: 'p', modelId: 'm' }, effectiveThinkingLevel: 'high' },
    })
    const gateway = createSubagentModelSwitchGateway(deps({ getClient: () => client }))
    const reply = vi.fn()
    const sendError = vi.fn()
    const ctx: SubagentHandlerContext = { send: vi.fn(), sendError, reply, modelSwitchGateway: gateway }
    const handler = new SubagentMessageHandler(ctx)

    await handler.handleSubagentMessage(setModelMsg({ recordId: 'sa-1', provider: 'p', modelId: 'm' }), {} as WsType)

    expect(reply).toHaveBeenCalledTimes(1)
    expect(reply.mock.calls[0]?.[2]).toBe('subagent.modelSet')
    expect(sendError).not.toHaveBeenCalled()
  })
})

// ── core ↔ shared 聚合应答形状类型级对账（[F1-21]）─────────────────────────
//
// 防线背景：protocol.ts「两处漂移由 U1 接线测试对账」的落点即此处——core
// RunSwitch*（形状 SSOT）与 shared protocol SubagentSetModel*（wire 投影）是两份
// 独立声明（shared 不依赖 subagent-core，物理单源不可行），core 改形而无本对账时
// gateway 的 unknown→as 盲 cast 零编译红、wire 载荷静默漂移（击穿设计 §7.1
// 「聚合三组件恒保留」硬不变量）。断言形态 = 双向 extends 编译锁（字段类型漂移
// 即红）+ keyof 双向差集锁（字段改名/删除/新增即红——含可选字段：可选属性缺席
// 不破坏结构可赋值，双向 extends 对可选字段改名不红，缺口由差集在 keyof 层显形）
// + 错误码词表 ⊆ wire reason 联合：任一侧改形/扩位/改键名，本文件类型检查即红。
// 已知逃逸面（[F3-2]）：嵌套可选字段单侧扩位 MutuallyAssignable/SameKeys 均不抓
// （SameKeys 只比顶层键集，嵌套对象内部的可选扩位两侧互赋值仍成立），由 U1 接线
// 测试对账（shared/protocol.ts:1633「两处漂移由 U1 接线测试对账」声明）。

/** 双向结构可赋值断言原语（A extends B 且 B extends A）——结构类型语义的形状对账；
 *  严格 Equal 会因品牌/可选字段差异误红，对账目标是「core 改形 → 此处编译红」。 */
type MutuallyAssignable<A, B> = A extends B ? (B extends A ? true : never) : never

/** keyof 双向差集断言原语（两侧键集合相等）——补 MutuallyAssignable 的洞：可选
 *  字段改名/删除在双向 extends 下不红（可选属性缺席不破坏可赋值），键差集在此
 *  显形（任一侧多出/改名键 → Exclude 非空 → 不再是 true → 编译红）。 */
type SameKeys<A, B> = Exclude<keyof A, keyof B> extends never
  ? (Exclude<keyof B, keyof A> extends never ? true : never)
  : never

describe('core ↔ shared setModel 聚合应答形状对账（协议契约不变量）', () => {
  it('RunSwitchMemberState ≡ SubagentSetModelMemberState（双向 extends 编译锁）', () => {
    const check: MutuallyAssignable<RunSwitchMemberState, SubagentSetModelMemberState> = true
    expect(check).toBe(true)
  })

  it('RunSwitchMemberState ≡ SubagentSetModelMemberState（keyof 双向差集——可选生效值字段改名/删除即红）', () => {
    const check: SameKeys<RunSwitchMemberState, SubagentSetModelMemberState> = true
    expect(check).toBe(true)
  })

  it('RunSwitchMemberFailure ≡ SubagentSetModelMemberFailure 且 SET_MODEL_ERROR_CODES ⊆ wire reason 联合', () => {
    const shape: MutuallyAssignable<RunSwitchMemberFailure, SubagentSetModelMemberFailure> = true
    expect(shape).toBe(true)
    // 词表成员逐个可赋 reason 联合（词表扩位未同步 wire 联合时此处编译红 + 运行时断言失败）
    const reasonValues: SubagentSetModelMemberFailure['reason'][] = [...SET_MODEL_ERROR_CODES]
    expect(reasonValues).toHaveLength(SET_MODEL_ERROR_CODES.length)
  })

  it('RunSwitchAggregateResult ≡ SubagentSetModelAggregateReply（三组件恒保留）', () => {
    const check: MutuallyAssignable<RunSwitchAggregateResult, SubagentSetModelAggregateReply> = true
    expect(check).toBe(true)
  })

  it('RunSwitchAggregateResult ≡ SubagentSetModelAggregateReply（keyof 双向差集——组件改名/增删即红）', () => {
    const check: SameKeys<RunSwitchAggregateResult, SubagentSetModelAggregateReply> = true
    expect(check).toBe(true)
  })

  it('core 处置表「写记账后回错误」分型 ≡ shared SUBAGENT_SET_MODEL_ACCOUNTED_ERROR_CODES（词表值级对账——core 扩码 shared 漏跟即红）', () => {
    // 词表登记注释的机器锚（shared protocol.ts / core model-switch.ts 双侧注释同指本处）：
    // badge 亮灯词表必须与 core 处置表写面分型逐值一致——core 新增记账型错误码而 shared
    // 漏跟时，前端对新增分型静默不亮 badge（同族 SET_MODEL_ERROR_CODES ⊆ wire reason
    // 断言的姊妹锚）。
    expect([...ACCOUNTED_SET_MODEL_ERROR_CODES]).toEqual([...SUBAGENT_SET_MODEL_ACCOUNTED_ERROR_CODES])
    expect(ACCOUNTED_SET_MODEL_ERROR_CODES).toHaveLength(SUBAGENT_SET_MODEL_ACCOUNTED_ERROR_CODES.length)
  })
})
