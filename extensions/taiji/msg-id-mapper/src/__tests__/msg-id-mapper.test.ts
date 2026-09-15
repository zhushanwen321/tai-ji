/**
 * msg-id-mapper extension 真实行为测试。
 *
 * 覆盖（替换原 expect(true) 占位）：
 * - input hook：clientUuid 提取（有/无/畸形 userEntryId 标记、非 rpc source、多标记全剥离）
 * - message_end：仅 user role + pendingClientUuid 时置 awaiting flag
 * - flush（message_start/turn_end/agent_end 三重安全网）：映射写入、幂等清空、
 *   leafId 未就绪重试、异常兜底（不抛出 + 保留 flag 供下次幂等重试）
 *
 * mock 策略：pi SDK 经 workspace node_modules 提供类型（import type 零运行时解析），
 * ExtensionAPI/ExtensionContext 用结构化桩（参照 subagent-workflow mocks/ 的最小桩模式，
 * 本包无 SDK 运行时依赖故不需要 alias 配置）。
 *
 * 运行：cd extensions/taiji/msg-id-mapper && npx vitest run
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@zhushanwen/pi-extension-logger', () => ({
  getLogger: () => loggerMock,
}))

import createMapper from '../index'
import type {
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  MessageEndEvent,
  MessageStartEvent,
  TurnEndEvent,
  AgentEndEvent,
} from '@earendil-works/pi-coding-agent'

const ENTRY_TYPE = 'taiji.client-msg-id'

/** 合法 uuid：`u-` + 36 字符（8-4-4-4-12 hex+连字符），与 TAG_MATCH 严格匹配 */
const UUID = 'u-123e4567-e89b-12d3-a456-426614174000'
const marker = (uuid: string): string => `<!--taiji:msg:${uuid}-->`

/** hook 注册表 + 可控桩（每个测试用例通过工厂重建，隔离闭包状态） */
interface Harness {
  appendEntry: ReturnType<typeof vi.fn>
  input: (text: string, source?: string) => unknown
  /** 传 event 对象本身（供畸形 event 兜底测试直接给非 InputEvent 输入） */
  inputRaw: (event: unknown) => unknown
  messageEnd: (role: string) => unknown
  /** 触发 flush 类 hook（message_start/turn_end/agent_end），ctx.getLeafId 返回 leafId */
  flush: (event: 'message_start' | 'turn_end' | 'agent_end', leafId?: string | null) => void
  /** ctx.getLeafId 为可注入实现（供 throw 场景） */
  flushWithLeafIdFn: (event: 'message_start' | 'turn_end' | 'agent_end', getLeafId: () => string | null) => void
}

function createHarness(): Harness {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const appendEntry = vi.fn()
  const pi = {
    on: (event: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(event, handler)
    },
    appendEntry,
  } as unknown as ExtensionAPI
  createMapper(pi)

  const makeCtx = (getLeafId: () => string | null): ExtensionContext =>
    ({ sessionManager: { getLeafId } }) as unknown as ExtensionContext

  return {
    appendEntry,
    input: (text: string, source = 'rpc') =>
      handlers.get('input')!({ type: 'input', text, source } satisfies InputEvent as unknown as InputEvent),
    inputRaw: (event: unknown) => handlers.get('input')!(event),
    messageEnd: (role: string) =>
      handlers.get('message_end')!({ type: 'message_end', message: { role } } as MessageEndEvent),
    flush: (event, leafId = 'e-user-entry-1') => {
      const ctx = makeCtx(() => leafId)
      if (event === 'message_start') handlers.get(event)!({ type: event } as MessageStartEvent, ctx)
      if (event === 'turn_end') handlers.get(event)!({ type: event } as TurnEndEvent, ctx)
      if (event === 'agent_end') handlers.get(event)!({ type: event } as AgentEndEvent, ctx)
    },
    flushWithLeafIdFn: (event, getLeafId) => {
      const ctx = makeCtx(getLeafId)
      if (event === 'message_start') handlers.get(event)!({ type: event } as MessageStartEvent, ctx)
      if (event === 'turn_end') handlers.get(event)!({ type: event } as TurnEndEvent, ctx)
      if (event === 'agent_end') handlers.get(event)!({ type: event } as AgentEndEvent, ctx)
    },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('input hook · clientUuid 提取（extractClientUuid）', () => {
  it('rpc + 合法标记 → transform 剥离标记，uuid 进入 pending（后续 flush 可写入映射）', () => {
    const h = createHarness()
    const result = h.input(`do the task ${marker(UUID)}`)

    expect(result).toEqual({ action: 'transform', text: 'do the task' })

    // pending 已捕获：走完 message_end + flush 应写出该 uuid 的映射
    h.messageEnd('user')
    h.flush('message_start')
    expect(h.appendEntry).toHaveBeenCalledWith(ENTRY_TYPE, {
      clientUuid: UUID,
      userEntryId: 'e-user-entry-1',
    })
  })

  it('rpc + 无标记 → continue（文本不动，无映射可写）', () => {
    const h = createHarness()
    expect(h.input('plain prompt without marker')).toEqual({ action: 'continue' })

    h.messageEnd('user')
    h.flush('message_start')
    expect(h.appendEntry).not.toHaveBeenCalled()
  })

  it('非 rpc source（interactive）+ 标记 → continue（不提取不剥离）', () => {
    const h = createHarness()
    expect(h.input(`interactive prompt ${marker(UUID)}`, 'interactive')).toEqual({ action: 'continue' })

    h.messageEnd('user')
    h.flush('message_start')
    expect(h.appendEntry).not.toHaveBeenCalled()
  })

  it('畸形 uuid（长度不足 36 / 非 hex 字符）→ 标记不匹配，continue 原文透传', () => {
    const h = createHarness()
    // 长度不足：u- + 短 hex
    expect(h.input(`short ${marker('u-abc')}`)).toEqual({ action: 'continue' })
    // 非 hex 字符（q/r/s 均不在 [0-9a-fA-F-] 内）
    expect(h.input(`badchar ${marker('u-123e4567e89b12d3a456426614174qrs')}`)).toEqual({
      action: 'continue',
    })

    h.messageEnd('user')
    h.flush('message_start')
    expect(h.appendEntry).not.toHaveBeenCalled()
  })

  it('裸 uuid 标记（无 u- 前缀，defer flush 确认标记）→ TAG_MATCH no-op：不提取不剥离不写映射（id 空间互斥）', () => {
    // [defer segments 化 / D-A1-2 检查点①] defer flush 提交尾部附加裸 uuid 确认标记
    //（<!--taiji:msg:<uuid>-->，无 u- 前缀）——msg-id-mapper 对其必须整体 no-op：
    // 不剥（标记全程存活服务 core ①a 确认 + reload 裸 id 提取）、不写 custom entry
    //（defer 条目回填走 sidecar deferEntryId 直查，与 clientUuid 映射链不相交）。
    const h = createHarness()
    const bare = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
    const result = h.input(`task\n<!--taiji:msg:${bare}-->`)

    // continue + 文本原样（含裸标记——TAG_MATCH 只认 u- 前缀形态）
    expect(result).toEqual({ action: 'continue' })

    h.messageEnd('user')
    h.flush('message_start')
    expect(h.appendEntry).not.toHaveBeenCalled()
  })

  it('多标记残留 → 全部剥离（TAG_STRIP 全局替换，非只剥第一个）', () => {
    const h = createHarness()
    const result = h.input(`task ${marker(UUID)}${marker('u-123e4567-e89b-12d3-a456-426614174111')}`)
    // 首个 uuid 进 pending
    expect(result).toEqual({ action: 'transform', text: 'task' })
    h.messageEnd('user')
    h.flush('message_start')
    expect(h.appendEntry).toHaveBeenCalledWith(ENTRY_TYPE, {
      clientUuid: UUID,
      userEntryId: 'e-user-entry-1',
    })
  })

  it('畸形 event（handler 内抛错）→ 兜底 return undefined 不外抛（logger.error 可观测）', () => {
    const h = createHarness()
    const errSpy = loggerMock.error
    // event 为 null → 取 event.source 即 throw，走 catch 兜底
    expect(h.inputRaw(null)).toBeUndefined()
    expect(errSpy).toHaveBeenCalledWith(
      'input hook error',
      { detail: expect.stringContaining('TypeError') },
    )
  })
})

describe('message_end hook · awaiting flag 门控', () => {
  it('assistant message_end → 不置 flag，flush 不写映射', () => {
    const h = createHarness()
    h.input(`task ${marker(UUID)}`)
    h.messageEnd('assistant')
    h.flush('message_start')
    expect(h.appendEntry).not.toHaveBeenCalled()
  })

  it('user message_end 但无 pendingClientUuid（无前序标记输入）→ flush 不写映射', () => {
    const h = createHarness()
    h.messageEnd('user')
    h.flush('message_start')
    expect(h.appendEntry).not.toHaveBeenCalled()
  })

  it('user message_end 但 pendingClientUuid 已被上一轮 flush 清空 → 不置 flag', () => {
    const h = createHarness()
    // 第一轮完整走完（写入并清空 pending）
    h.input(`task ${marker(UUID)}`)
    h.messageEnd('user')
    h.flush('message_start')
    expect(h.appendEntry).toHaveBeenCalledTimes(1)

    // 第二轮：无新标记输入，仅 user message_end → flush 不重复写
    h.messageEnd('user')
    h.flush('message_start')
    expect(h.appendEntry).toHaveBeenCalledTimes(1)
  })
})

describe('flush · 映射写入 / 幂等 / 重试 / 异常兜底（writeMapping）', () => {
  it('主路径：message_start 拿 leafId 写映射（clientUuid ↔ userEntryId）', () => {
    const h = createHarness()
    h.input(`task ${marker(UUID)}`)
    h.messageEnd('user')
    h.flush('message_start', 'e-leaf-user-42')
    expect(h.appendEntry).toHaveBeenCalledTimes(1)
    expect(h.appendEntry).toHaveBeenCalledWith(ENTRY_TYPE, {
      clientUuid: UUID,
      userEntryId: 'e-leaf-user-42',
    })
  })

  it('幂等清空：flush 后 pending 清空，重复触发（turn_end/agent_end 兜底再打）不再写', () => {
    const h = createHarness()
    h.input(`task ${marker(UUID)}`)
    h.messageEnd('user')
    h.flush('message_start')
    expect(h.appendEntry).toHaveBeenCalledTimes(1)

    h.flush('turn_end')
    h.flush('agent_end')
    expect(h.appendEntry).toHaveBeenCalledTimes(1)
  })

  it('abort 兜底：message_start 不来，turn_end 单独完成写入', () => {
    const h = createHarness()
    h.input(`task ${marker(UUID)}`)
    h.messageEnd('user')
    h.flush('turn_end')
    expect(h.appendEntry).toHaveBeenCalledTimes(1)
  })

  it('leafId 未就绪（null）→ 本次不写不抛错，pending 保留，下一 hook 重试成功', () => {
    const h = createHarness()
    h.input(`task ${marker(UUID)}`)
    h.messageEnd('user')
    // message_start 时 leafId 尚未更新（null）
    h.flush('message_start', null)
    expect(h.appendEntry).not.toHaveBeenCalled()

    // turn_end 时 leafId 就绪 → 补写
    h.flush('turn_end', 'e-leaf-late-1')
    expect(h.appendEntry).toHaveBeenCalledTimes(1)
    expect(h.appendEntry).toHaveBeenCalledWith(ENTRY_TYPE, {
      clientUuid: UUID,
      userEntryId: 'e-leaf-late-1',
    })
  })

  it('appendEntry 抛错 → flush 吞错不外抛，flag 未清，下次 hook 幂等重试', () => {
    const h = createHarness()
    const errSpy = loggerMock.error
    h.appendEntry.mockImplementation(() => {
      throw new Error('jsonl write failed')
    })

    h.input(`task ${marker(UUID)}`)
    h.messageEnd('user')
    expect(() => h.flush('message_start')).not.toThrow()
    expect(errSpy).toHaveBeenCalledWith('flush error', { detail: expect.stringContaining('jsonl write failed') })

    // 重试成功：appendEntry 恢复 → turn_end 补写（flag 未清的幂等重试语义）
    h.appendEntry.mockImplementation(() => {})
    h.flush('turn_end')
    expect(h.appendEntry).toHaveBeenCalledTimes(2) // 1 次失败 + 1 次成功
  })

  it('getLeafId 抛错 → flush 吞错不外抛（catch 兜底覆盖 writeMapping 全程）', () => {
    const h = createHarness()
    const errSpy = loggerMock.error
    h.input(`task ${marker(UUID)}`)
    h.messageEnd('user')

    expect(() =>
      h.flushWithLeafIdFn('message_start', () => {
        throw new Error('session manager gone')
      }),
    ).not.toThrow()
    expect(errSpy).toHaveBeenCalledWith('flush error', { detail: expect.stringContaining('session manager gone') })
  })

  it('无 user message_end（未置 flag）→ 三重安全网全不写', () => {
    const h = createHarness()
    h.input(`task ${marker(UUID)}`) // 只有 pending，没有 user 落盘
    h.flush('message_start')
    h.flush('turn_end')
    h.flush('agent_end')
    expect(h.appendEntry).not.toHaveBeenCalled()
  })
})
