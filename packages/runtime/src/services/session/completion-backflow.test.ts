/**
 * sd-u6（session-manager 完成回流）单元验收测试。
 *
 * 覆盖六条验收（describe/it fullName 词边界含验收 id，cw 名字级比对）：
 * - U6_SETTLED_CHAIN: settled → 查内存态打标 → parentDelivery 收到文案（真内核经 sd-u5 注册表）
 * - U6_NO_PARENT_SKIP: 无父 id / 非 agent session / session 不存在 → parentDelivery 零调用
 * - U6_EXIT_FAILBACK: onSessionExit 触发失败回流，文案含退出码/stderr 摘要/transcript 指针
 * - U6_SINGLETON_REUSE: 同父 session 与 send 排队（U5）共用同一 handle（§3.4 单例约束）
 * - U6_MULTI_RUN: 两次 settled 两次回流（每次投递任务完成各回流一次）
 * - U6_UNIT: 文案构造格式断言（buildBackflowContent 纯函数）
 *
 * 材料形态与 sd-u5 session-manager-send-queue.test.ts 同款：真 @zhushanwen/session-delivery
 * 内核 + 真 SessionDeliveryRegistry + 真 CompletionBackflow，仅装配材料（pi client / 内存态 /
 * settled 多播 / exit 多播）为 mock。kernel timer 依赖 vitest fake timers。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/completion-backflow.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createSessionDeliveryRegistry } from './session-delivery-registry.js'
import { createCompletionBackflow, buildBackflowContent } from './completion-backflow.js'
import { applySessionOccupancyTransition } from './event-interpreter.js'
import type { IManagedSessionView } from './types.js'

// ─── harness：真 kernel + 真 registry + 真 backflow，材料层 mock ──────────

/** harness 固定 session id（overrides 需要引用父 id 时直接用常量，防 TDZ 自引用） */
const CHILD_ID = 'child-1'
const PARENT_ID = 'parent-1'

/** 内存态 session view（含 session-lifecycle 打标的扩展字段） */
interface HarnessView extends IManagedSessionView {
  spawnSource?: 'user' | 'agent'
  parentAgentSessionId?: string
}

function makeView(id: string, overrides: Partial<HarnessView> = {}): HarnessView {
  return {
    id,
    cwd: `/ws/${id}`,
    label: `label-${id}`,
    modelId: 'm/x',
    createdAt: 1,
    lastActiveAt: 1_000,
    tokenCount: 0,
    inputTokens: 0,
    isGenerating: false,
    isCompacting: false,
    isBashRunning: false,
    bashRunToken: undefined,
    sessionFilePath: `/tmp/${id}.jsonl`,
    ...overrides,
  }
}

function makeHarness(overrides: {
  child?: Partial<HarnessView>
  parent?: Partial<HarnessView>
  outcome?: 'done' | 'error' | 'stopped' | null
} = {}) {
  const parent = makeView(PARENT_ID, overrides.parent)
  const child = makeView(CHILD_ID, {
    spawnSource: 'agent',
    parentAgentSessionId: PARENT_ID,
    ...overrides.child,
  })
  const views = new Map<string, HarnessView>([
    [PARENT_ID, parent],
    [CHILD_ID, child],
  ])
  const client = { prompt: vi.fn(async (..._args: unknown[]) => ({})) }
  const settledCbs: Array<(sid: string) => void> = []
  const exitCbs: Array<(sid: string, code: number | null, stderr: string) => void> = []
  const outcomeByPath = new Map<string, 'done' | 'error' | 'stopped'>([
    [`/tmp/${CHILD_ID}.jsonl`, (overrides.outcome ?? 'done')],
  ])

  const registry = createSessionDeliveryRegistry({
    getSession: (sid) => views.get(sid),
    ensureActive: async (sid: string) => {
      if (!views.has(sid)) throw new Error(`no session ${sid}`)
      return client as unknown as never
    },
    subscribeAgentSettled: (cb) => {
      settledCbs.push(cb)
      return () => {}
    },
    recordWorkspace: () => {},
    getMessageBus: () => null,
  })

  const backflow = createCompletionBackflow({
    getSession: (sid) => views.get(sid),
    subscribeAgentSettled: (cb) => {
      settledCbs.push(cb)
      return () => {}
    },
    subscribeSessionExit: (cb) => {
      exitCbs.push(cb)
      return () => {}
    },
    getSessionOutcome: (fp) => outcomeByPath.get(fp) ?? null,
    getDelivery: (parentSid) => registry.getOrCreateDelivery(parentSid),
  })

  /** 模拟组合根 agentSettledListeners 多播分发 */
  const emitSettled = (sid: string): void => {
    for (const cb of [...settledCbs]) cb(sid)
  }
  /** 模拟 ProcessManager exitCallbacks 分发 */
  const emitExit = (sid: string, code: number | null, stderr: string): void => {
    for (const cb of [...exitCbs]) cb(sid, code, stderr)
  }
  /** flush microtask 链（deliverText: ensureActive → prompt → 置位） */
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }
  return { registry, backflow, client, parent, child, views, emitSettled, emitExit, flush, outcomeByPath }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

// ─── U6_SETTLED_CHAIN: settled → 查标记 → 回流 ────────────────────────────

describe('U6_SETTLED_CHAIN 完成回流链路：settled → spawnSource/parentAgentSessionId → parentDelivery 收到通知', () => {
  it('子 session settled → 父 session 的 delivery handle 投递通知（steer），文案含 label/status/Full transcript', async () => {
    const h = makeHarness()
    h.emitSettled(h.child.id)
    await h.flush()

    expect(h.client.prompt).toHaveBeenCalledTimes(1)
    const [content, , streamingBehavior] = h.client.prompt.mock.calls[0] as unknown as [string, unknown, string]
    // 默认意图 turn 边界抢占 → streamingBehavior 'steer'（design D3）
    expect(streamingBehavior).toBe('steer')
    expect(content).toBe(
      `Managed session "label-child-1" (child-1) finished with status "completed".`
      + `\nFull transcript: /tmp/child-1.jsonl`,
    )
  })

  it('status 语义固化：session_end outcome error→failed / stopped→stopped / 未写入(null)→completed', async () => {
    const cases = [
      { outcome: 'error' as const, expected: 'failed' },
      { outcome: 'stopped' as const, expected: 'stopped' },
      { outcome: 'done' as const, expected: 'completed' },
      { outcome: null, expected: 'completed' },
    ]
    for (const { outcome, expected } of cases) {
      const h = makeHarness({ outcome })
      h.emitSettled(h.child.id)
      await h.flush()
      const content = (h.client.prompt.mock.calls[0] as unknown as [string])[0]
      expect(content, `outcome=${String(outcome)} 应映射 status "${expected}"`).toContain(
        `finished with status "${expected}"`,
      )
    }
  })

  it('sessionFile 缺失（pi 延迟写入窗口）省略 Full transcript 行', async () => {
    const h = makeHarness({ child: { sessionFilePath: undefined } })
    h.emitSettled(h.child.id)
    await h.flush()
    const content = (h.client.prompt.mock.calls[0] as unknown as [string])[0]
    expect(content).not.toContain('Full transcript:')
    expect(content).toBe(`Managed session "label-child-1" (child-1) finished with status "completed".`)
  })
})

// ─── U6_NO_PARENT_SKIP: 不满足条件跳过 ────────────────────────────────────

describe('U6_NO_PARENT_SKIP 无父 id / 非 agent session 完成不回流', () => {
  it('spawnSource=agent 但无 parentAgentSessionId → parentDelivery 零调用', async () => {
    const h = makeHarness({ child: { parentAgentSessionId: undefined } })
    h.emitSettled(h.child.id)
    await h.flush()
    expect(h.client.prompt).not.toHaveBeenCalled()
    expect(h.registry.getOrCreateDelivery(h.parent.id).depth()).toBe(0)
  })

  it('spawnSource=user（用户建的 session）→ 零调用', async () => {
    const h = makeHarness({ child: { spawnSource: 'user', parentAgentSessionId: PARENT_ID } })
    h.emitSettled(h.child.id)
    await h.flush()
    expect(h.client.prompt).not.toHaveBeenCalled()
  })

  it('session 不在内存态（已删除/未知 sid）→ 零调用且不抛错', async () => {
    const h = makeHarness()
    expect(() => h.emitSettled('ghost-sid')).not.toThrow()
    await h.flush()
    expect(h.client.prompt).not.toHaveBeenCalled()
  })

  it('父 session 自身 settled（非 agent-managed）不产生自我回流', async () => {
    const h = makeHarness()
    h.emitSettled(h.parent.id)
    await h.flush()
    expect(h.client.prompt).not.toHaveBeenCalled()
  })
})

// ─── U6_EXIT_FAILBACK: 进程 exit 失败回流 ─────────────────────────────────

describe('U6_EXIT_FAILBACK 进程 exit 失败回流：pi 死了也要通知父 agent', () => {
  it('onSessionExit(agent-managed 子) → 投递 status exited 通知，含退出码/stderr 摘要/transcript 指针', async () => {
    const h = makeHarness()
    h.emitExit(h.child.id, 1, 'FATAL: oom')
    await h.flush()

    expect(h.client.prompt).toHaveBeenCalledTimes(1)
    const [content] = h.client.prompt.mock.calls[0] as unknown as [string]
    expect(content).toContain(`finished with status "exited" (exit code: 1).`)
    expect(content).toContain('Stderr: FATAL: oom')
    expect(content).toContain('Full transcript: /tmp/child-1.jsonl')
  })

  it('code null（信号杀）与 stderr 空时省略 Stderr 行', async () => {
    const h = makeHarness()
    h.emitExit(h.child.id, null, '')
    await h.flush()
    const [content] = h.client.prompt.mock.calls[0] as unknown as [string]
    expect(content).toContain(`(exit code: null).`)
    expect(content).not.toContain('Stderr:')
  })

  it('非 agent-managed session 的 exit 不回流', async () => {
    const h = makeHarness({ child: { spawnSource: 'user' } })
    h.emitExit(h.child.id, 1, 'x')
    await h.flush()
    expect(h.client.prompt).not.toHaveBeenCalled()
  })

  it('stderr 超长截尾（保留尾部 400 字符，诊断价值在末段）', async () => {
    const h = makeHarness()
    h.emitExit(h.child.id, 2, `${'x'.repeat(1000)}-END`)
    await h.flush()
    const [content] = h.client.prompt.mock.calls[0] as unknown as [string]
    const stderrLine = content.split('\n').find((l) => l.startsWith('Stderr:')) ?? ''
    expect(stderrLine.length).toBeLessThanOrEqual('Stderr: '.length + 400)
    expect(stderrLine.endsWith('-END')).toBe(true)
  })
})

// ─── U6_SINGLETON_REUSE: 单例 handle 复用 ─────────────────────────────────

describe('U6_SINGLETON_REUSE 同父 session 的 send 排队与回流共用同一 handle', () => {
  it('U5 send 排队先建 handle → 回流经 registry.getOrCreateDelivery 拿到同一引用', async () => {
    const h = makeHarness()
    // U5 路径：agent 经 send_to_session 排队（idle 立即投）——建立父 session 的 handle
    const u5Handle = h.registry.getOrCreateDelivery(h.parent.id)
    await u5Handle.sendChecked({ payload: { kind: 'text', content: 'hello from agent' } })
    expect(h.client.prompt).toHaveBeenCalledTimes(1)

    // 父跑完第一条（sendChecked 的 D7 置位 isGenerating=true）→ 父 settled 后 idle；
    // 随后子 session 的回流 settled 到达（时序：父先处理完 agent 消息再收回流）
    // 父 settled 边沿 idle 复位（u3c readonly 收口：经原语 'idle' 行，isIdle 读同源三布尔）
    applySessionOccupancyTransition(h.parent, null, 'idle')
    h.emitSettled(h.child.id)
    await h.flush()

    expect(h.registry.getOrCreateDelivery(h.parent.id)).toBe(u5Handle)
    // 同一 handle 的 port：两条消息（U5 send + U6 回流）都经同一 client.prompt
    expect(h.client.prompt).toHaveBeenCalledTimes(2)
    const contents = h.client.prompt.mock.calls.map((c) => (c as unknown as [string])[0])
    expect(contents[0]).toBe('hello from agent')
    expect(contents[1]).toContain('Managed session "label-child-1"')
  })

  it('父 session busy 时回流走同一 handle 的排队路径（settled 边沿唤醒后注入）', async () => {
    const h = makeHarness({ parent: { isGenerating: true } })
    h.emitSettled(h.child.id)
    // busy：回流入队不立即投
    expect(h.registry.getOrCreateDelivery(h.parent.id).depth()).toBe(1)
    expect(h.client.prompt).not.toHaveBeenCalled()

    // 父 run 结束：settled 边沿 + idle 复核 → 同一 handle flush 注入
    // 父 settled 边沿 idle 复位（u3c readonly 收口：经原语 'idle' 行，isIdle 读同源三布尔）
    applySessionOccupancyTransition(h.parent, null, 'idle')
    h.emitSettled(h.parent.id)
    await h.flush()
    expect(h.client.prompt).toHaveBeenCalledTimes(1)
    expect((h.client.prompt.mock.calls[0] as unknown as [string])[0]).toContain('Managed session')
  })
})

// ─── U6_MULTI_RUN: 多次 run 多次回流 ──────────────────────────────────────

describe('U6_MULTI_RUN 两次 settled 两次回流（每次投递任务完成各回流一次）', () => {
  it('同一子 session 两个 run 各自 settled → 父收到两条独立通知', async () => {
    const h = makeHarness()
    // run 1
    h.emitSettled(h.child.id)
    await h.flush()
    // 父被唤醒后跑完又 idle（D7 置位 → 父 settled 复位），run 2
    // 父 settled 边沿 idle 复位（u3c readonly 收口：经原语 'idle' 行，isIdle 读同源三布尔）
    applySessionOccupancyTransition(h.parent, null, 'idle')
    h.emitSettled(h.child.id)
    await h.flush()

    expect(h.client.prompt).toHaveBeenCalledTimes(2)
    for (const call of h.client.prompt.mock.calls) {
      expect((call as unknown as [string])[0]).toContain(
        `Managed session "label-child-1" (child-1) finished with status "completed".`,
      )
    }
    expect(h.registry.getOrCreateDelivery(h.parent.id).depth()).toBe(0)
  })

  it('第二个 run 失败（outcome error）→ 第二条通知 status failed（status 逐 run 取终值）', async () => {
    const h = makeHarness({ outcome: 'done' })
    h.emitSettled(h.child.id)
    await h.flush()
    // 父 settled 边沿 idle 复位（u3c readonly 收口：经原语 'idle' 行，isIdle 读同源三布尔）
    applySessionOccupancyTransition(h.parent, null, 'idle')
    // 第二个 run 以 error 收场（session_end outcome 被覆盖为 error）
    h.outcomeByPath.set('/tmp/child-1.jsonl', 'error')
    h.emitSettled(h.child.id)
    await h.flush()

    expect(h.client.prompt).toHaveBeenCalledTimes(2)
    const second = (h.client.prompt.mock.calls[1] as unknown as [string])[0]
    expect(second).toContain(`finished with status "failed".`)
  })
})

// ─── U6_UNIT: 文案构造格式 ────────────────────────────────────────────────

describe('U6_UNIT buildBackflowContent 文案构造格式断言', () => {
  it('settled 完成形态：单行状态 + transcript 指针行（与 design.md §3.1 调用方 C 模板逐字符一致）', () => {
    expect(buildBackflowContent({
      label: 'scan-job', sessionId: 'sid-abc', status: 'completed', sessionFilePath: '/d/sid-abc.jsonl',
    })).toBe(
      'Managed session "scan-job" (sid-abc) finished with status "completed".'
      + '\nFull transcript: /d/sid-abc.jsonl',
    )
  })

  it('failed / stopped status 透传同一模板', () => {
    for (const status of ['failed', 'stopped'] as const) {
      expect(buildBackflowContent({ label: 'l', sessionId: 's', status, sessionFilePath: '/f' })).toContain(
        `finished with status "${status}".`,
      )
    }
  })

  it('exited 形态：exit code 附加在首行，stderr 行与 transcript 行按需追加', () => {
    const content = buildBackflowContent({
      label: 'l', sessionId: 's', status: 'exited', sessionFilePath: '/f', exitCode: 137, stderrTail: 'killed',
    })
    expect(content.split('\n')).toEqual([
      'Managed session "l" (s) finished with status "exited" (exit code: 137).',
      'Stderr: killed',
      'Full transcript: /f',
    ])
  })

  it('sessionFilePath 缺失省略整条 transcript 行（notifier buildLlmContent 同款约定）', () => {
    const content = buildBackflowContent({ label: 'l', sessionId: 's', status: 'completed' })
    expect(content).toBe('Managed session "l" (s) finished with status "completed".')
    expect(content).not.toContain('Full transcript')
  })
})
