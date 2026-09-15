import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Check } from 'typebox/value'

/**
 * M3 pi 边界层（src/index.ts）单测（MF-6：此前该层零测试）。
 *
 * mock pi/ctx（as unknown as ExtensionAPI），测：
 * 1. execute 错误路径 throw（W4：pi 只对 execute throw 置 isError:true——agent-loop
 *    丢弃返回值里的 isError 字段，「错误轮被标成功」契约守护）
 * 2. session_start handler 的 ctx.mode!=='tui' 守卫
 * 3. registeredPis WeakSet 去重：同 pi 二次 session_start 不重复注册；不同 pi 可注册
 * 4. typeof ctx.ui.addAutocompleteProvider 运行时守卫（ui 缺方法 → 跳过，不崩）
 * 5. registerCommand + addAutocompleteProvider 组装（tui 模式下各注册一次）
 * 6. TypeBox schema 与 SessionReadParams 对齐：合法 params 过、非法 action/scope 拒
 * 7. U3 信号包采集降级：sessionManager 缺 getSessionDir 方法 / getSessionDir 抛错 →
 *    liveSessionDir 降级 undefined，find 正常返回不抛（ctx===undefined 形态由 1 覆盖）
 *
 * 不触碰真实文件系统：getAgentDir mock 固定假路径（execute 用例只触发 F5 抛错路径，
 * 不读盘）。
 */

// vi.mock 在 import 前 hoist；SessionManager stub 仅防 session-command/hash-provider
// 模块加载期缺导出（本文件用例不调用它）。u11：state/listAll 经 vi.hoisted 可控——
// getAgentDir 可指向真实 tmp fixture，listAll 为 spy，供 execute 接线断言。
const piMocks = vi.hoisted(() => {
  const state = { agentDir: '/tmp/pi-session-reader-test-agent' }
  const listAll = vi.fn(async (_dir: string) => [] as Array<Record<string, unknown>>)
  return { state, listAll }
})

vi.mock('@earendil-works/pi-coding-agent', () => ({
  getAgentDir: () => piMocks.state.agentDir,
  SessionManager: class {
    static listAll = piMocks.listAll
  },
}))

import sessionReaderExtension from '../index.js'

interface FakePi {
  pi: Record<string, unknown>
  registerTool: ReturnType<typeof vi.fn>
  registerCommand: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
}

function makeFakePi(): FakePi {
  const registerTool = vi.fn()
  const registerCommand = vi.fn()
  const on = vi.fn()
  return { pi: { registerTool, registerCommand, on }, registerTool, registerCommand, on }
}

interface FakeCtx {
  ctx: Record<string, unknown>
  addAutocompleteProvider: ReturnType<typeof vi.fn>
}

function makeFakeCtx(opts: { mode?: string; withUi?: boolean; sessionDir?: string } = {}): FakeCtx {
  const addAutocompleteProvider = vi.fn()
  const ctx: Record<string, unknown> = {
    mode: opts.mode ?? 'tui',
    sessionManager: { getSessionDir: () => opts.sessionDir ?? '/tmp/fake-session-dir' },
  }
  if (opts.withUi ?? true) {
    ctx.ui = { addAutocompleteProvider }
  } else {
    ctx.ui = {}
  }
  return { ctx, addAutocompleteProvider }
}

/** 触发 fake pi 的 session_start handler（取第一个注册的 handler）。 */
function fireSessionStart(on: ReturnType<typeof vi.fn>, ctx: Record<string, unknown>): void {
  const handler = on.mock.calls.find((c) => c[0] === 'session_start')?.[1]
  expect(handler).toBeTypeOf('function')
  handler({ type: 'session_start' }, ctx)
}

describe('sessionReaderExtension - execute 契约', () => {
  let fake: FakePi

  beforeEach(() => {
    fake = makeFakePi()
    sessionReaderExtension(fake.pi as unknown as ExtensionAPI)
  })

  it('handler 抛错 → execute 向 pi throw（W4：throw 才置 isError:true，返回值 isError 被 agent-loop 丢弃）', async () => {
    const toolDef = fake.registerTool.mock.calls[0][0] as {
      name: string
      execute: (
        toolCallId: string,
        params: unknown,
        signal: AbortSignal | undefined,
        onUpdate: unknown,
        ctx: unknown,
      ) => Promise<{ content: Array<{ type: string; text: string }> }>
    }
    expect(toolDef.name).toBe('session_read')
    // action=find 缺 query → F5 requireStr 抛错 → execute 原样传播（pi catch 后
    // isError:true + message 成为 toolResult content[0].text）
    await expect(
      toolDef.execute('tc-1', { action: 'find' }, undefined, undefined, undefined),
    ).rejects.toThrow(/👉/)
  })
})

describe('sessionReaderExtension - execute 信号包采集（U3：ctx 全形态降级）', () => {
  type ExecFn = (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<{ content: Array<{ type: string; text: string }> }>

  let execute: ExecFn

  beforeEach(() => {
    const fake = makeFakePi()
    sessionReaderExtension(fake.pi as unknown as ExtensionAPI)
    execute = (fake.registerTool.mock.calls[0][0] as { execute: ExecFn }).execute
  })

  // find 零匹配不抛（返回提示文本）——用例只断言「正常返回」降级语义，不碰真实数据目录
  //（mock agentDir = /tmp/pi-session-reader-test-agent 及其派生根均不存在，扫描瞬时零文件）
  const FIND_NO_MATCH = { action: 'find', query: 'zzznoindexmatch' } as const

  it('sessionManager 存在但缺 getSessionDir 方法 → 降级 liveSessionDir=undefined，find 正常返回不抛', async () => {
    const ctx = { mode: 'tui', sessionManager: {} }
    const r = await execute('tc-u3-1', FIND_NO_MATCH, undefined, undefined, ctx)
    expect(r.content[0]?.type).toBe('text')
  })

  it('getSessionDir 调用抛错 → 同样降级不抛（可选链只防缺失，调用抛错由 try/catch 兜住）', async () => {
    const ctx = {
      mode: 'tui',
      sessionManager: {
        getSessionDir: () => {
          throw new Error('boom')
        },
      },
    }
    const r = await execute('tc-u3-2', FIND_NO_MATCH, undefined, undefined, ctx)
    expect(r.content[0]?.type).toBe('text')
  })

  it('ctx 提供正常 getSessionDir → 信号被采集（调用一次）且 find 正常返回', async () => {
    const getSessionDir = vi.fn(() => '/tmp/pi-session-reader-test-live-dir')
    const ctx = { mode: 'tui', sessionManager: { getSessionDir } }
    const r = await execute('tc-u3-3', FIND_NO_MATCH, undefined, undefined, ctx)
    expect(getSessionDir).toHaveBeenCalledTimes(1)
    expect(r.content[0]?.type).toBe('text')
  })

  it('u8：doctor 经 execute 走通——env/bundleUrl 补采 + ctx===undefined 降级仍出环境判定与根表', async () => {
    // mock agentDir（/tmp/pi-session-reader-test-agent）及其派生根均不存在 → 根表全空仍渲染；
    // 残留 glob 基点 = /tmp，只读 readdir（无写操作），不触碰任何真实数据目录。
    const r = await execute('tc-u8-1', { action: 'doctor' }, undefined, undefined, undefined)
    const text = r.content[0]?.text as string
    expect(text).toContain('环境判定：')
    // bundleUrl 信号已采集：测试内 import.meta.url 为仓库源码路径 → dev（非打包资源目录）
    expect(text).toContain('发行形态：dev')
    expect(text).toContain('会话根（按优先级）')
  })

  it('u11：execute 构造 metadataProvider 接 SessionManager.listAll——keyword 标题命中端到端', async () => {
    // fixture：平铺 main 根（taiji 形态），session 首消息不含 query，标题经 mock listAll 注入
    const tmp = await mkdtemp(join(tmpdir(), 'index-u11-'))
    try {
      const agentDir = join(tmp, 'agent')
      const liveDir = join(agentDir, 'sessions')
      await mkdir(liveDir, { recursive: true })
      const id = 'm-wire-0001'
      await writeFile(
        join(liveDir, 'a.jsonl'),
        [
          JSON.stringify({ type: 'session', id, cwd: '/demo' }),
          JSON.stringify({
            type: 'message',
            id: `${id}-m1`,
            message: { role: 'user', content: [{ type: 'text', text: '完全无关的首消息' }] },
          }),
        ].join('\n') + '\n',
      )
      piMocks.state.agentDir = agentDir
      piMocks.listAll.mockResolvedValue([
        {
          path: join(liveDir, 'a.jsonl'),
          id,
          cwd: '/demo',
          name: '接线标题命中',
          modified: new Date(),
          firstMessage: '完全无关的首消息',
          created: new Date(),
          messageCount: 1,
          allMessagesText: '完全无关的首消息',
        },
      ])
      const ctx = { mode: 'rpc', sessionManager: { getSessionDir: () => liveDir } }
      const r = await execute('tc-u11-1', { action: 'find', query: '接线标题' }, undefined, undefined, ctx)
      // provider 已接线：listAll 被调，且实参恒为非空串（永传非空串 guard）
      expect(piMocks.listAll).toHaveBeenCalledTimes(1)
      expect(piMocks.listAll.mock.calls[0][0]).toBe(liveDir)
      expect(piMocks.listAll.mock.calls[0][0].length).toBeGreaterThan(0)
      // 标题命中路径端到端：文本与 details 都带 name
      const text = r.content[0]?.text as string
      expect(text).toContain('接线标题命中')
      const d = r.details as { matches: Array<{ sessionId: string; name?: string }> }
      expect(d.matches[0]?.sessionId).toBe(id)
      expect(d.matches[0]?.name).toBe('接线标题命中')
    } finally {
      // 还原 mock 态，不污染同文件其他用例
      piMocks.state.agentDir = '/tmp/pi-session-reader-test-agent'
      piMocks.listAll.mockReset()
      await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})

describe('sessionReaderExtension - session_start TUI 注册', () => {
  it('mode !== tui → 不注册 command/provider', () => {
    const fake = makeFakePi()
    sessionReaderExtension(fake.pi as unknown as ExtensionAPI)
    const { ctx } = makeFakeCtx({ mode: 'rpc', withUi: true })
    fireSessionStart(fake.on, ctx)
    expect(fake.registerCommand).not.toHaveBeenCalled()
  })

  it('tui 模式 → registerCommand(session-pick) + addAutocompleteProvider 各一次', () => {
    const fake = makeFakePi()
    sessionReaderExtension(fake.pi as unknown as ExtensionAPI)
    const { ctx, addAutocompleteProvider } = makeFakeCtx({ mode: 'tui' })
    fireSessionStart(fake.on, ctx)
    expect(fake.registerCommand).toHaveBeenCalledTimes(1)
    expect(fake.registerCommand.mock.calls[0][0]).toBe('session-pick')
    expect(addAutocompleteProvider).toHaveBeenCalledTimes(1)
  })

  it('同 pi 二次 session_start → 不重复注册（WeakSet 去重，防 provider 堆叠）', () => {
    const fake = makeFakePi()
    sessionReaderExtension(fake.pi as unknown as ExtensionAPI)
    fireSessionStart(fake.on, makeFakeCtx().ctx)
    fireSessionStart(fake.on, makeFakeCtx().ctx)
    expect(fake.registerCommand).toHaveBeenCalledTimes(1)
  })

  it('不同 pi 实例（resume 新 session）→ 各自可注册', () => {
    const fake1 = makeFakePi()
    const fake2 = makeFakePi()
    sessionReaderExtension(fake1.pi as unknown as ExtensionAPI)
    sessionReaderExtension(fake2.pi as unknown as ExtensionAPI)
    fireSessionStart(fake1.on, makeFakeCtx().ctx)
    fireSessionStart(fake2.on, makeFakeCtx().ctx)
    expect(fake1.registerCommand).toHaveBeenCalledTimes(1)
    expect(fake2.registerCommand).toHaveBeenCalledTimes(1)
  })

  it('ctx.ui 无 addAutocompleteProvider（typeof 守卫）→ 跳过注册不崩', () => {
    const fake = makeFakePi()
    sessionReaderExtension(fake.pi as unknown as ExtensionAPI)
    const { ctx } = makeFakeCtx({ withUi: false })
    fireSessionStart(fake.on, ctx)
    expect(fake.registerCommand).not.toHaveBeenCalled()
  })
})

describe('sessionReaderExtension - TypeBox schema 与 SessionReadParams 对齐', () => {
  it('合法完整 params 通过 schema 校验；非法 action/scope/类型被拒', () => {
    const fake = makeFakePi()
    sessionReaderExtension(fake.pi as unknown as ExtensionAPI)
    const toolDef = fake.registerTool.mock.calls[0][0] as { parameters: unknown }
    const schema = toolDef.parameters

    // 各 action 合法形态
    expect(Check(schema, { action: 'find', query: 'e6c96', limit: 5 })).toBe(true)
    expect(
      Check(schema, {
        action: 'search',
        session: '019e6c96',
        pattern: 'plugin',
        scope: 'toolResult',
      }),
    ).toBe(true)
    expect(Check(schema, { action: 'outline', session: 'e6c96', granularity: 'entry' })).toBe(true)
    expect(Check(schema, { action: 'export', session: 'e6c96', format: 'family' })).toBe(true)
    expect(
      Check(schema, { action: 'extract', session: 'e6c96', what: 'tool-results', tool: 'bash' }),
    ).toBe(true)
    // 全部可选字段齐全
    expect(
      Check(schema, {
        action: 'detail',
        session: 'e6c96',
        turns: 'T001-T003',
        includeToolResult: true,
        includeThinking: false,
        allBranches: true,
      }),
    ).toBe(true)

    // 非法值被拒（enum 约束生效）
    expect(Check(schema, { action: 'bogus' })).toBe(false)
    expect(Check(schema, { action: 'find', scope: 'nope' })).toBe(false)
    expect(Check(schema, { action: 'extract', what: 'everything' })).toBe(false)
    expect(Check(schema, { action: 42 })).toBe(false)
    expect(Check(schema, {})).toBe(false) // 缺必填 action
  })

  it('source 字段：合法值（main/subagent）通过、非法值拒绝；不传 source 向后兼容', () => {
    const fake = makeFakePi()
    sessionReaderExtension(fake.pi as unknown as ExtensionAPI)
    const toolDef = fake.registerTool.mock.calls[0][0] as { parameters: unknown }
    const schema = toolDef.parameters

    // 合法值通过（enum 约束）
    expect(Check(schema, { action: 'find', query: 'x', source: 'main' })).toBe(true)
    expect(Check(schema, { action: 'find', query: 'x', source: 'subagent' })).toBe(true)
    // 非法值被拒
    expect(Check(schema, { action: 'find', query: 'x', source: 'bogus' })).toBe(false)
    // 不传 source 向后兼容（既有合法形态仍 true）
    expect(Check(schema, { action: 'find', query: 'x' })).toBe(true)
  })

  it('TC-w6-schema-action：action enum 含 workflow + runId optional（w6）', () => {
    const fake = makeFakePi()
    sessionReaderExtension(fake.pi as unknown as ExtensionAPI)
    const toolDef = fake.registerTool.mock.calls[0][0] as { parameters: unknown }
    const schema = toolDef.parameters

    // action='workflow' 不传 runId（合法）
    expect(Check(schema, { action: 'workflow', session: 'e6c96' })).toBe(true)
    // action='workflow' 传 runId（合法）
    expect(Check(schema, { action: 'workflow', session: 'e6c96', runId: 'wf-1' })).toBe(true)
    // runId 传任意 action 均合法（其他 action 忽略 runId，不报错）
    expect(Check(schema, { action: 'find', query: 'x', runId: 'wf-1' })).toBe(true)
    // 不传 runId 向后兼容
    expect(Check(schema, { action: 'outline', session: 'e6c96' })).toBe(true)
    // runId 类型校验：非 string 被拒
    expect(Check(schema, { action: 'workflow', session: 'x', runId: 123 })).toBe(false)
  })

  it('TC-m3b-schema-recursive：recursive optional boolean（family 专用）', () => {
    const fake = makeFakePi()
    sessionReaderExtension(fake.pi as unknown as ExtensionAPI)
    const toolDef = fake.registerTool.mock.calls[0][0] as { parameters: unknown }
    const schema = toolDef.parameters

    // recursive=true（合法）
    expect(Check(schema, { action: 'family', session: 'e6c96', recursive: true })).toBe(true)
    // 不传 recursive（向后兼容，合法）
    expect(Check(schema, { action: 'family', session: 'e6c96' })).toBe(true)
    // recursive=false（合法）
    expect(Check(schema, { action: 'family', session: 'e6c96', recursive: false })).toBe(true)
    // recursive 非 boolean 被拒
    expect(Check(schema, { action: 'family', session: 'x', recursive: 'yes' })).toBe(false)
    expect(Check(schema, { action: 'family', session: 'x', recursive: 1 })).toBe(false)
  })

  it('limit 退化输入：minimum:1 在 schema 校验层拒绝 0/负数（不落入 find F1「无匹配」措辞面）', () => {
    const fake = makeFakePi()
    sessionReaderExtension(fake.pi as unknown as ExtensionAPI)
    const toolDef = fake.registerTool.mock.calls[0][0] as { parameters: unknown }
    const schema = toolDef.parameters

    // 0/负数被 schema 拒绝（minimum:1），不会进入 find/F1 输出「无匹配 session」
    expect(Check(schema, { action: 'find', query: 'x', limit: 0 })).toBe(false)
    expect(Check(schema, { action: 'find', query: 'x', limit: -3 })).toBe(false)
    // 正数合法；result 消费同一 limit 字段（正数合法）
    expect(Check(schema, { action: 'find', query: 'x', limit: 1 })).toBe(true)
    expect(Check(schema, { action: 'result', session: 'sa-x', limit: 100 })).toBe(true)
    // 不传 limit 向后兼容（缺省语义不变）
    expect(Check(schema, { action: 'find', query: 'x' })).toBe(true)
  })

  it('TC-u8-schema-doctor：action enum 含 doctor + includeSubagents optional boolean', () => {
    const fake = makeFakePi()
    sessionReaderExtension(fake.pi as unknown as ExtensionAPI)
    const toolDef = fake.registerTool.mock.calls[0][0] as { parameters: unknown }
    const schema = toolDef.parameters

    expect(Check(schema, { action: 'doctor' })).toBe(true)
    expect(Check(schema, { action: 'doctor', includeSubagents: true })).toBe(true)
    expect(Check(schema, { action: 'doctor', includeSubagents: false })).toBe(true)
    expect(Check(schema, { action: 'doctor', includeSubagents: 'yes' })).toBe(false)
    expect(Check(schema, { action: 'doctor', includeSubagents: 1 })).toBe(false)
  })
})
