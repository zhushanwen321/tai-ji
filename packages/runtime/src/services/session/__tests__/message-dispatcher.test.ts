/**
 * MessageDispatcher 三入口 skill 注入器挂载单测（composer-multi-skill-injection D9）。
 *
 * 覆盖：sendPrompt/steerMessage/followUpMessage 各恰好调用注入器一次（结构化幂等）、
 * 调用点在 BeforeSend hook 之后 / client.prompt/steer/followUp 之前（顺序断言）、
 * session.skillNotice 广播 payload 形状符合 protocol 契约（含 clientUuid 提取与
 * steer/followUp 无 clientUuid 的缺省形态）、失败路径不发布提示。
 * 另含 busy 预检裁决单测（session-dead-structural-fixes D2 settling 预检裁决，u3b 验收③）：
 * 预检读 occupancy 投影，settling 计为忙 → send.rejected{busy}。
 * 全部协作对象 fake 注入，不 spawn pi 进程。
 */
import { describe, expect, it, vi } from 'vitest'
import { MessageDispatcher } from '../message-dispatcher.js'
import type { SkillInjector, SkillNotice, SkillInjectionResult } from '../skill-injector.js'
import type { IDispatcherSessionOps } from '../session-internal.js'
import type { IPiEngine, IProcessManager } from '../../ports/pi-engine.js'
import type { IMessageBus } from '../../message-bus/message-bus.js'
import type { ServerMessage } from '@taiji/shared'

// ── fakes ──

const CLIENT_UUID = 'u-12345678-1234-1234-1234-1234567890ab'

interface Harness {
  dispatcher: MessageDispatcher
  calls: string[]
  client: { prompt: ReturnType<typeof vi.fn>; steer: ReturnType<typeof vi.fn>; followUp: ReturnType<typeof vi.fn> }
  published: ServerMessage[]
  injectMock: ReturnType<typeof vi.fn>
  hookMock: ReturnType<typeof vi.fn>
  /** 注入器 spy 的可配置返回（不替换实现，保住 calls 调用序记录）。 */
  injectState: { notices: SkillNotice[] }
}

interface HarnessOptions {
  hookModifiedContent?: string
  promptError?: Error
  sessionByClient?: Record<string, unknown>
  /** [A1 接线] svc.getSession 的返回视图（steer/followUp 的 cwd 透传断言用；缺省 undefined 同既有行为）。 */
  sessionView?: Record<string, unknown>
}

/**
 * 组装被测 dispatcher：注入器 spy 产 `INJECTED::` 前缀文本（与输入可区分），调用序
 * 统一记入 calls 数组供顺序断言（hook → inject → prompt/steer/followUp）。
 */
function makeHarness(opts: HarnessOptions = {}): Harness {
  const calls: string[] = []
  const client = {
    prompt: vi.fn(async () => {
      calls.push('prompt')
      if (opts.promptError) throw opts.promptError
      return {}
    }),
    steer: vi.fn(async () => {
      calls.push('steer')
      return {}
    }),
    followUp: vi.fn(async () => {
      calls.push('followUp')
      return {}
    }),
    // touchActivity：sendPrompt 入口同步 touch（idle-pi-reclamation D6-1）经 pm.getClient
    // 到达 fake client——fake 须补齐该接口成员
    touchActivity: vi.fn(),
  }
  const svc = {
    ensureActive: vi.fn(async () => {
      calls.push('ensureActive')
      return client as unknown as IPiEngine
    }),
    getSessionByClient: vi.fn(() => opts.sessionByClient as never),
    persistSessionOutcome: vi.fn(),
    getSession: vi.fn(() => opts.sessionView as never),
    removeSessionEntry: vi.fn(),
    detachSession: vi.fn(),
  } as unknown as IDispatcherSessionOps
  const pm = { getClient: vi.fn(() => client as unknown as IPiEngine) } as unknown as IProcessManager
  const workspaceService = { record: vi.fn() } as never
  const published: ServerMessage[] = []
  const messageBus = { publish: vi.fn((_sid: string, msg: ServerMessage) => published.push(msg)) } as unknown as IMessageBus
  const hookMock = vi.fn(async () => {
    calls.push('hook')
    // SendMessageHook 契约：blocked 必填（hookResult?.modifiedContent 为 transform 语义可选字段）
    return opts.hookModifiedContent !== undefined
      ? { blocked: false, modifiedContent: opts.hookModifiedContent }
      : { blocked: false }
  })
  const injectState = { notices: [] as SkillNotice[] }
  const injectMock = vi.fn(async (_client: IPiEngine, text: string): Promise<SkillInjectionResult> => {
    calls.push('inject')
    return { text: `INJECTED::${text}`, notices: injectState.notices }
  })
  const injector = { inject: injectMock } as unknown as SkillInjector
  const dispatcher = new MessageDispatcher(svc, pm, workspaceService, messageBus, injector)
  dispatcher.setSendMessageHook(hookMock)
  return { dispatcher, calls, client, published, injectMock, hookMock, injectState }
}

const notice = (reason: SkillNotice['reason'], skills: string[]): SkillNotice => ({ reason, skills })

describe('MessageDispatcher × SkillInjector 挂载（D9）', () => {
  it('sendPrompt：注入器恰好一次，调用顺序 hook → inject → ensureActive 之后 prompt 之前，prompt 收注入文本', async () => {
    const h = makeHarness()
    const result = await h.dispatcher.sendMessage('s1', '原始 <taiji-skill name="a"/> 文本')
    expect(result).toEqual({ blocked: false })
    expect(h.injectMock).toHaveBeenCalledTimes(1)
    expect(h.client.prompt).toHaveBeenCalledTimes(1)
    expect(h.client.prompt).toHaveBeenCalledWith('INJECTED::原始 <taiji-skill name="a"/> 文本', undefined)
    // hook 审核原文 → 注入器处理 hook 产物 → 最后 client.prompt
    expect(h.calls).toEqual(['hook', 'ensureActive', 'inject', 'prompt'])
    expect(h.hookMock).toHaveBeenCalledWith('s1', '原始 <taiji-skill name="a"/> 文本')
  })

  it('sendPrompt：hook 改写文本时注入器收到改写后文本（hook 之后语义）', async () => {
    const h = makeHarness({ hookModifiedContent: '改写后 <taiji-skill name="a"/>' })
    await h.dispatcher.sendMessage('s1', '用户原文')
    expect(h.injectMock).toHaveBeenCalledWith(expect.anything(), '改写后 <taiji-skill name="a"/>', undefined)
    expect(h.client.prompt).toHaveBeenCalledWith('INJECTED::改写后 <taiji-skill name="a"/>', undefined)
  })

  it('sendPrompt / steer：session cwd 作 inject 第三参透传（A1 接线，D7 project 扫描基准）', async () => {
    // sendPrompt 走 activeSession.cwd（getSessionByClient 视图）；视图缺失（默认 harness）= undefined（global-only 映射，宁缺毋错）
    const h = makeHarness({ sessionByClient: { cwd: '/w/s1', occupancy: { turn: 'idle', compacting: false, bash: false } } })
    await h.dispatcher.sendMessage('s1', '文本')
    expect(h.injectMock).toHaveBeenCalledWith(expect.anything(), '文本', '/w/s1')
    // steer / followUp 走 svc.getSession(sessionId)?.cwd
    const h2 = makeHarness({ sessionView: { cwd: '/w/s2' } })
    await h2.dispatcher.steerMessage('s1', 'steer 文本')
    expect(h2.injectMock).toHaveBeenCalledWith(expect.anything(), 'steer 文本', '/w/s2')
    await h2.dispatcher.followUpMessage('s1', 'followUp 文本')
    expect(h2.injectMock).toHaveBeenCalledWith(expect.anything(), 'followUp 文本', '/w/s2')
  })

  it('sendPrompt：notices 在 prompt 成功后逐条发布，payload 含 clientUuid（从发送文本标记提取）', async () => {
    const h = makeHarness()
    h.injectState.notices = [notice('budget_exceeded', ['skill-a']), notice('skill_missing', ['ghost'])]
    const sentText = `正文\n<!--taiji:msg:${CLIENT_UUID}-->`
    await h.dispatcher.sendMessage('s1', sentText)
    const skillNotices = h.published.filter((m) => m.type === 'session.skillNotice')
    expect(skillNotices).toHaveLength(2)
    expect(skillNotices[0]).toEqual({
      type: 'session.skillNotice',
      payload: { sessionId: 's1', clientUuid: CLIENT_UUID, reason: 'budget_exceeded', skills: ['skill-a'] },
    })
    expect(skillNotices[1]?.payload).toEqual({
      sessionId: 's1',
      clientUuid: CLIENT_UUID,
      reason: 'skill_missing',
      skills: ['ghost'],
    })
  })

  it('sendPrompt：纯文本消息（无 clientUuid 标记）payload 缺省该字段', async () => {
    const h = makeHarness()
    h.injectState.notices = [notice('context_window_unavailable', ['skill-a'])]
    await h.dispatcher.sendMessage('s1', '纯文本，非 segments 序列化')
    const msg = h.published.find((m) => m.type === 'session.skillNotice')
    expect(msg?.payload).toEqual({ sessionId: 's1', reason: 'context_window_unavailable', skills: ['skill-a'] })
    expect('clientUuid' in (msg?.payload ?? {})).toBe(false)
  })

  it('sendPrompt：prompt 失败不发布 skillNotice（message.error 已覆盖，提示不空投）', async () => {
    const h = makeHarness({ promptError: new Error('rpc dead') })
    h.injectState.notices = [notice('skill_missing', ['ghost'])]
    const result = await h.dispatcher.sendMessage('s1', '带 skill 的消息')
    expect(result.blocked).toBe(true)
    expect(h.published.filter((m) => m.type === 'session.skillNotice')).toHaveLength(0)
  })

  it('sendPrompt：无 notices 时不发布任何 skillNotice', async () => {
    const h = makeHarness()
    await h.dispatcher.sendMessage('s1', '普通消息')
    expect(h.published).toHaveLength(0)
  })

  it('sendPrompt：busy 预检拒绝时注入器不被调用（消息不发送，无需注入）', async () => {
    // [u3b 预检改读 occupancy] 预检输入 = occupancy 投影（D1 立场），turn='generating' 计忙
    const h = makeHarness({ sessionByClient: { occupancy: { turn: 'generating', compacting: false, bash: false } } })
    const result = await h.dispatcher.sendMessage('s1', '消息')
    expect(result).toEqual({ blocked: true, rejected: true, reason: 'busy' })
    expect(h.injectMock).not.toHaveBeenCalled()
    expect(h.client.prompt).not.toHaveBeenCalled()
  })

  it('steerMessage：注入器恰好一次且在 client.steer 之前，notices payload 无 clientUuid 字段', async () => {
    const h = makeHarness()
    h.injectState.notices = [notice('marker_malformed', [])]
    await h.dispatcher.steerMessage('s1', 'steer 文本')
    expect(h.injectMock).toHaveBeenCalledTimes(1)
    expect(h.calls).toEqual(['inject', 'steer'])
    expect(h.client.steer).toHaveBeenCalledWith('INJECTED::steer 文本')
    expect(h.published).toHaveLength(1)
    // steer 路径无 sidecar/clientUuid 链路：字段缺省（类型可空，u5 按可空消费）
    expect(h.published[0]).toEqual({
      type: 'session.skillNotice',
      payload: { sessionId: 's1', reason: 'marker_malformed', skills: [] },
    })
  })

  it('followUpMessage：注入器恰好一次且在 client.followUp 之前，注入文本透传', async () => {
    const h = makeHarness()
    await h.dispatcher.followUpMessage('s1', 'followUp 文本')
    expect(h.injectMock).toHaveBeenCalledTimes(1)
    expect(h.calls).toEqual(['inject', 'followUp'])
    expect(h.client.followUp).toHaveBeenCalledWith('INJECTED::followUp 文本')
    expect(h.published).toHaveLength(0)
  })
})

/**
 * busy 预检裁决单测（session-dead-structural-fixes D2 settling 预检裁决，u3b 验收条款③）。
 *
 * 预检门改读 occupancy 投影（D1 立场「occupancy 为体」）：turn !== 'idle' / compacting / bash
 * 任一命中即拒。关键行为变更 = **settling 计为忙**（原三布尔读法在 settling 窗口 isGenerating
 * 已复位 false → 误判闲放行，与前端 D1 双门相反），拒绝转 send.rejected{busy} → 前端 defer
 * 队列入队 → agent_settled idle 帧自动投递。
 */
describe('MessageDispatcher busy 预检裁决（D2 settling 计忙，u3b）', () => {
  it.each([
    ['dispatching', 'busy'],
    ['generating', 'busy'],
    ['settling', 'busy'],
  ] as const)('turn=%s 计忙：拒绝转 send.rejected{reason:%s}，prompt 不发送', async (turn, reason) => {
    const h = makeHarness({ sessionByClient: { occupancy: { turn, compacting: false, bash: false } } })
    const result = await h.dispatcher.sendMessage('s1', 'settling 窗口内的消息')
    expect(result).toEqual({ blocked: true, rejected: true, reason: 'busy' })
    expect(h.client.prompt).not.toHaveBeenCalled()
    expect(h.published).toContainEqual({
      type: 'send.rejected',
      payload: { sessionId: 's1', reason, message: 'Agent 正在处理' },
    })
  })

  it('settling 且三布尔全 false（pi post-run 窗口）→ 拒绝（旧读法会放行）', async () => {
    const h = makeHarness({
      sessionByClient: {
        isGenerating: false,
        isCompacting: false,
        isBashRunning: false,
        occupancy: { turn: 'settling', compacting: false, bash: false },
      },
    })
    const result = await h.dispatcher.sendMessage('s1', '消息')
    expect(result).toEqual({ blocked: true, rejected: true, reason: 'busy' })
    expect(h.client.prompt).not.toHaveBeenCalled()
    expect(h.injectMock).not.toHaveBeenCalled()
  })

  it('compacting 命中：分型保持 reason=compacting（renderer 兜底入队触发源）', async () => {
    const h = makeHarness({
      sessionByClient: { occupancy: { turn: 'idle', compacting: true, bash: false } },
    })
    const result = await h.dispatcher.sendMessage('s1', '消息')
    expect(result).toEqual({ blocked: true, rejected: true, reason: 'compacting' })
    expect(h.published).toContainEqual({
      type: 'send.rejected',
      payload: { sessionId: 's1', reason: 'compacting', message: '压缩进行中，消息将自动排队' },
    })
  })

  it('bash 命中：回执 reason=bash（D6/u5a 三态拆分），广播线保持 busy 词表', async () => {
    const h = makeHarness({
      sessionByClient: { occupancy: { turn: 'idle', compacting: false, bash: true } },
    })
    const result = await h.dispatcher.sendMessage('s1', '消息')
    expect(result).toEqual({ blocked: true, rejected: true, reason: 'bash' })
    expect(h.published).toContainEqual(expect.objectContaining({ type: 'send.rejected' }))
  })

  it('occupancy 全 idle：预检放行（对照组——直发成功不受影响，V7④）', async () => {
    const h = makeHarness({
      sessionByClient: { occupancy: { turn: 'idle', compacting: false, bash: false } },
    })
    const result = await h.dispatcher.sendMessage('s1', '空闲期消息')
    expect(result).toEqual({ blocked: false })
    expect(h.client.prompt).toHaveBeenCalledTimes(1)
    expect(h.published.filter((m) => m.type === 'send.rejected')).toHaveLength(0)
  })
})
