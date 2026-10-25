/**
 * 容器导航执行器单测（§6.4 落点契约；容器扩展点统一 U5 验收①② + U13 验收②③）。
 *
 * 覆盖：全局 id 空间解析（歧义报错不取第一条）；族匹配→存在性→可打开性→才写状态
 * （先校验后动作——任一步失败 sink 零调用）；params 标量校验（嵌套对象/数组拒绝）；
 * 未知 params 键忽略 + 一行 warning；会话注入优先级（视图 scope sessionId >
 * getBoundSessionId）。U13 增量：§5.4 判定表行 5-8 对账（判定者/恢复动作逐行确定）+
 * 先校验后动作独立断言（六条失败行 sink 零写入组合断言 + 校验短路 + 失败可恢复）。
 * lookup/sink 经 mock 端口注入（本模块不感知容器位注册表实装）。
 *
 * 运行：cd packages/core && npx vitest run src/extension-host/__tests__/container-navigation.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { HostContainerAction } from '@zhushanwen/extension-protocol'
import {
  ContainerNavigationExecutor,
  type ContainerNavigationTarget,
  type ContainerSlotLookup,
  type ContainerNavigationSink,
  type ContainerNavigationResult,
} from '../container-navigation'
import { FAILURE_JUDGEMENT_TABLE } from '../failure-degradation'

/** 构造注册表命中声明（缺省 = drawer 族、session 归属、默认可打开）。 */
const makeTarget = (overrides?: Partial<ContainerNavigationTarget>): ContainerNavigationTarget => ({
  id: 'probe.tab',
  placement: 'drawer.tab',
  pluginId: 'probe-plugin',
  scope: 'session',
  openableWithoutData: true,
  ...overrides,
})

interface Harness { // oe-exempt:20261025:framework:测试 mock harness 形状，非抽象接口单实现
  executor: ContainerNavigationExecutor
  lookup: ContainerSlotLookup & { resolveTargets: ReturnType<typeof vi.fn>; hasData: ReturnType<typeof vi.fn> }
  sink: ContainerNavigationSink & { openDrawerTab: ReturnType<typeof vi.fn>; openOverlayContent: ReturnType<typeof vi.fn> }
  getBoundSessionId: ReturnType<typeof vi.fn<() => string | null>>
}

const makeHarness = (boundSessionId: string | null = 'bound-sid'): Harness => {
  const lookup = {
    resolveTargets: vi.fn<(tabId: string) => ContainerNavigationTarget[]>(() => [makeTarget()]),
    hasData: vi.fn<(t: ContainerNavigationTarget) => boolean>(() => true),
  }
  const sink = {
    openDrawerTab: vi.fn<ContainerNavigationSink['openDrawerTab']>(),
    openOverlayContent: vi.fn<ContainerNavigationSink['openOverlayContent']>(),
  }
  const getBoundSessionId = vi.fn<() => string | null>(() => boundSessionId)
  const executor = new ContainerNavigationExecutor({ lookup, sink, getBoundSessionId })
  return { executor, lookup, sink, getBoundSessionId }
}

const drawerAction = (overrides?: Partial<HostContainerAction>): HostContainerAction => ({
  kind: 'drawer',
  tabId: 'probe.tab',
  ...overrides,
})

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

// console.warn spy 跨用例复位（vi.spyOn 对同方法复用底层 mock，不 restore 会累积调用计数）
afterEach(() => {
  vi.restoreAllMocks()
})

describe('成功路径（先校验全通过才写状态）', () => {
  it('drawer 导航：唯一命中 + 族匹配 + 可打开 + 会话就绪 → sink.openDrawerTab 收到 (sessionId, tabId, params)', () => {
    const { executor, sink } = makeHarness()
    const result = executor.navigate(drawerAction({ params: { commandName: 'commit' } }), { viewSessionId: 'view-sid' })
    expect(result.ok).toBe(true)
    expect(sink.openDrawerTab).toHaveBeenCalledTimes(1)
    expect(sink.openDrawerTab).toHaveBeenCalledWith('view-sid', 'probe.tab', { commandName: 'commit' })
    expect(sink.openOverlayContent).not.toHaveBeenCalled()
  })

  it('overlay 导航 → sink.openOverlayContent 收到 (sessionId, contentId)', () => {
    const { executor, sink, lookup } = makeHarness()
    lookup.resolveTargets.mockReturnValue([makeTarget({ id: 'probe.panel', placement: 'overlay.content' })])
    const result = executor.navigate({ kind: 'overlay', tabId: 'probe.panel' }, { viewSessionId: 'view-sid' })
    expect(result.ok).toBe(true)
    expect(sink.openOverlayContent).toHaveBeenCalledTimes(1)
    expect(sink.openOverlayContent).toHaveBeenCalledWith('view-sid', 'probe.panel')
    expect(sink.openDrawerTab).not.toHaveBeenCalled()
  })

  it('params 缺省 → sink 收到空对象（可打开性 true 时不触发 hasData 查询）', () => {
    const { executor, sink, lookup } = makeHarness()
    const result = executor.navigate(drawerAction(), { viewSessionId: 'view-sid' })
    expect(result.ok).toBe(true)
    expect(sink.openDrawerTab).toHaveBeenCalledWith('view-sid', 'probe.tab', {})
    expect(lookup.hasData).not.toHaveBeenCalled()
  })
})

describe('全局 id 空间解析（§6.12：歧义报错不取第一条）', () => {
  it('命中多条 → ambiguous-target，不取第一条、sink 零调用，warning 含两侧归属插件', () => {
    const { executor, sink, lookup } = makeHarness()
    lookup.resolveTargets.mockReturnValue([
      makeTarget({ pluginId: 'plugin-a' }),
      makeTarget({ pluginId: 'plugin-b' }),
    ])
    const result = executor.navigate(drawerAction())
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('ambiguous-target')
    expect(sink.openDrawerTab).not.toHaveBeenCalled()
    expect(sink.openOverlayContent).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalledTimes(1)
    expect(String(vi.mocked(console.warn).mock.calls[0]?.[0])).toContain('plugin-a')
    expect(String(vi.mocked(console.warn).mock.calls[0]?.[0])).toContain('plugin-b')
  })

  it('命中零条 → unknown-target，sink 零调用，warning 含目标 id', () => {
    const { executor, sink, lookup } = makeHarness()
    lookup.resolveTargets.mockReturnValue([])
    const result = executor.navigate(drawerAction({ tabId: 'ghost.tab' }))
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('unknown-target')
    expect(sink.openDrawerTab).not.toHaveBeenCalled()
    expect(String(vi.mocked(console.warn).mock.calls[0]?.[0])).toContain('ghost.tab')
  })
})

describe('族匹配（kind 与目标位置族不匹配按不存在处理）', () => {
  it('drawer kind 指向 overlay 族目标 → family-mismatch，sink 零调用，warning 附实际族', () => {
    const { executor, sink, lookup } = makeHarness()
    lookup.resolveTargets.mockReturnValue([makeTarget({ id: 'probe.panel', placement: 'overlay.content' })])
    const result = executor.navigate(drawerAction({ tabId: 'probe.panel' }))
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('family-mismatch')
    expect(sink.openDrawerTab).not.toHaveBeenCalled()
    expect(sink.openOverlayContent).not.toHaveBeenCalled()
    expect(String(vi.mocked(console.warn).mock.calls[0]?.[0])).toContain('overlay.content')
  })
})

describe('可打开性（§6.15：不可无数据进入且无数据 → 不打开）', () => {
  it('openableWithoutData=false 且无数据 → not-openable，sink 零调用', () => {
    const { executor, sink, lookup } = makeHarness()
    lookup.resolveTargets.mockReturnValue([makeTarget({ openableWithoutData: false })])
    lookup.hasData.mockReturnValue(false)
    const result = executor.navigate(drawerAction())
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('not-openable')
    expect(sink.openDrawerTab).not.toHaveBeenCalled()
  })

  it('openableWithoutData=false 但有数据 → 通过（不打开空容器的边界是「无数据」）', () => {
    const { executor, sink, lookup } = makeHarness()
    lookup.resolveTargets.mockReturnValue([makeTarget({ openableWithoutData: false })])
    lookup.hasData.mockReturnValue(true)
    const result = executor.navigate(drawerAction())
    expect(result.ok).toBe(true)
    expect(sink.openDrawerTab).toHaveBeenCalledTimes(1)
  })
})

describe('params 标量校验（嵌套对象拒绝）', () => {
  it('嵌套对象值 → invalid-params，sink 零调用（零状态写入），不进入目标解析', () => {
    const { executor, sink, lookup } = makeHarness()
    const nested = { filePath: { nested: true } } as unknown as HostContainerAction['params']
    const result = executor.navigate(drawerAction({ params: nested }))
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('invalid-params')
    expect(sink.openDrawerTab).not.toHaveBeenCalled()
    expect(lookup.resolveTargets).not.toHaveBeenCalled()
  })

  it('数组值同样拒绝（非标量即拒绝，不取 typeof 宽松口径）', () => {
    const { executor, sink } = makeHarness()
    const arrayed = { filePath: ['/tmp/a.md'] } as unknown as HostContainerAction['params']
    const result = executor.navigate(drawerAction({ params: arrayed }))
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('invalid-params')
    expect(sink.openDrawerTab).not.toHaveBeenCalled()
  })

  it('标量三型（string/number/boolean）全部放行（执行器只判标量性，字段语义归容器）', () => {
    const { executor, sink } = makeHarness()
    const result = executor.navigate(
      drawerAction({ params: { commandName: 'commit', filePath: 1 } }),
      { viewSessionId: 'view-sid' },
    )
    expect(result.ok).toBe(true)
    expect(sink.openDrawerTab).toHaveBeenCalledWith('view-sid', 'probe.tab', { commandName: 'commit', filePath: 1 })
    // boolean 标量同样通过 params 校验段（落在已知键上原样透传）
    const boolResult = executor.navigate(drawerAction({ params: { commandName: true } }), { viewSessionId: 'view-sid' })
    expect(boolResult.ok).toBe(true)
    expect(sink.openDrawerTab).toHaveBeenLastCalledWith('view-sid', 'probe.tab', { commandName: true })
  })
})

describe('未知 params 键（忽略 + 一行 warning，不阻断动作）', () => {
  it('未知键被过滤、已知键透传、动作照常执行；warning 恰一次且含未知键名', () => {
    const { executor, sink } = makeHarness()
    const result = executor.navigate(
      drawerAction({ params: { filePath: '/tmp/report.md', mystery: 'x' } }),
      { viewSessionId: 'view-sid' },
    )
    expect(result.ok).toBe(true)
    expect(sink.openDrawerTab).toHaveBeenCalledWith('view-sid', 'probe.tab', { filePath: '/tmp/report.md' })
    expect(console.warn).toHaveBeenCalledTimes(1)
    expect(String(vi.mocked(console.warn).mock.calls[0]?.[0])).toContain('mystery')
  })

  it('overlay 族词表为空集：任何 params 键都是未知键，忽略后动作照常', () => {
    const { executor, sink, lookup } = makeHarness()
    lookup.resolveTargets.mockReturnValue([makeTarget({ id: 'probe.panel', placement: 'overlay.content' })])
    const result = executor.navigate(
      { kind: 'overlay', tabId: 'probe.panel', params: { whatever: 'x' } },
      { viewSessionId: 'view-sid' },
    )
    expect(result.ok).toBe(true)
    expect(sink.openOverlayContent).toHaveBeenCalledTimes(1)
    expect(console.warn).toHaveBeenCalledTimes(1)
    expect(String(vi.mocked(console.warn).mock.calls[0]?.[0])).toContain('whatever')
  })
})

describe('会话注入优先级（视图 scope sessionId > getBoundSessionId()）', () => {
  it('viewSessionId 在场 → 用视图会话，不咨询 getBoundSessionId', () => {
    const { executor, sink, getBoundSessionId } = makeHarness('bound-sid')
    executor.navigate(drawerAction(), { viewSessionId: 'view-sid' })
    expect(sink.openDrawerTab).toHaveBeenCalledWith('view-sid', 'probe.tab', {})
    expect(getBoundSessionId).not.toHaveBeenCalled()
  })

  it('viewSessionId 缺省 → 回退焦点会话（getBoundSessionId）', () => {
    const { executor, sink } = makeHarness('bound-sid')
    executor.navigate(drawerAction())
    expect(sink.openDrawerTab).toHaveBeenCalledWith('bound-sid', 'probe.tab', {})
  })

  it('两档皆无（无视图会话 + 无焦点会话）→ no-session，sink 零调用', () => {
    const { executor, sink } = makeHarness(null)
    const result = executor.navigate(drawerAction())
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('no-session')
    expect(sink.openDrawerTab).not.toHaveBeenCalled()
  })
})

// ── §5.4 失败降级三件套（U13）：判定表行 5-8 + 先校验后动作独立断言 ──────────

describe('§5.4 判定表行 5-8（U13 验收②：判定者/恢复动作逐行确定）', () => {
  it('判定表登记：行 5-8 判定者 = 导航执行器、行号 5-8 连续、种类值与执行器失败词表同名', () => {
    const navKinds = ['unknown-target', 'family-mismatch', 'not-openable', 'unknown-params-key'] as const
    navKinds.forEach((kind, i) => {
      expect(FAILURE_JUDGEMENT_TABLE[kind].row).toBe(5 + i)
      expect(FAILURE_JUDGEMENT_TABLE[kind].judge).toContain('导航执行器')
    })
  })

  it('行 5 unknown-target：warning 含目标 id + 恢复动作（恢复动作 = 判定表登记原文，单一登记处）', () => {
    const { executor, sink, lookup } = makeHarness()
    lookup.resolveTargets.mockReturnValue([])
    const result = executor.navigate(drawerAction({ tabId: 'ghost.tab' }))
    expect(result.reason).toBe('unknown-target')
    const warnText = String(vi.mocked(console.warn).mock.calls[0]?.[0])
    expect(warnText).toContain('ghost.tab')
    expect(warnText).toContain(FAILURE_JUDGEMENT_TABLE['unknown-target'].recovery)
    expect(sink.openDrawerTab).not.toHaveBeenCalled()
  })

  it('行 6 family-mismatch：warning 附实际族 + 恢复动作（改 kind 或改目标）', () => {
    const { executor, lookup } = makeHarness()
    lookup.resolveTargets.mockReturnValue([makeTarget({ id: 'probe.panel', placement: 'overlay.content' })])
    const result = executor.navigate(drawerAction({ tabId: 'probe.panel' }))
    expect(result.reason).toBe('family-mismatch')
    const warnText = String(vi.mocked(console.warn).mock.calls[0]?.[0])
    expect(warnText).toContain('overlay.content')
    expect(warnText).toContain(FAILURE_JUDGEMENT_TABLE['family-mismatch'].recovery)
  })

  it('行 7 not-openable：warning 恢复动作（先推数据或声明 openableWithoutData）', () => {
    const { executor, lookup } = makeHarness()
    lookup.resolveTargets.mockReturnValue([makeTarget({ openableWithoutData: false })])
    lookup.hasData.mockReturnValue(false)
    const result = executor.navigate(drawerAction())
    expect(result.reason).toBe('not-openable')
    const warnText = String(vi.mocked(console.warn).mock.calls[0]?.[0])
    expect(warnText).toContain(FAILURE_JUDGEMENT_TABLE['not-openable'].recovery)
  })

  it('行 8 unknown-params-key：动作照常执行 + warning 恢复动作（核对容器选项字段名登记表）', () => {
    const { executor, sink } = makeHarness()
    const result = executor.navigate(drawerAction({ params: { mystery: 'x' } }), { viewSessionId: 'view-sid' })
    expect(result.ok).toBe(true)
    expect(sink.openDrawerTab).toHaveBeenCalledTimes(1)
    const warnText = String(vi.mocked(console.warn).mock.calls[0]?.[0])
    expect(warnText).toContain(FAILURE_JUDGEMENT_TABLE['unknown-params-key'].recovery)
  })
})

describe('先校验后动作独立断言（U13 验收③：任一步失败零状态写入）', () => {
  interface FailureCase { // oe-exempt:20261025:framework:测试断言用例形状，非抽象接口单实现
    /** 失败种类（ContainerNavigationFailure） */
    reason: string
    /** 构造该失败行的导航输入 */
    act: (h: Harness) => ContainerNavigationResult
  }

  const failureCases: FailureCase[] = [
    {
      reason: 'invalid-params',
      act: (h) => h.executor.navigate(
        drawerAction({ params: { filePath: { nested: true } } as unknown as HostContainerAction['params'] }),
      ),
    },
    { reason: 'ambiguous-target', act: (h) => { h.lookup.resolveTargets.mockReturnValue([makeTarget({ pluginId: 'a' }), makeTarget({ pluginId: 'b' })]); return h.executor.navigate(drawerAction()) } },
    { reason: 'unknown-target', act: (h) => { h.lookup.resolveTargets.mockReturnValue([]); return h.executor.navigate(drawerAction()) } },
    { reason: 'family-mismatch', act: (h) => { h.lookup.resolveTargets.mockReturnValue([makeTarget({ placement: 'overlay.content' })]); return h.executor.navigate(drawerAction()) } },
    { reason: 'not-openable', act: (h) => { h.lookup.resolveTargets.mockReturnValue([makeTarget({ openableWithoutData: false })]); h.lookup.hasData.mockReturnValue(false); return h.executor.navigate(drawerAction()) } },
    { reason: 'no-session', act: (h) => h.executor.navigate(drawerAction()) },
  ]

  it.each(failureCases)('$reason 失败 → sink 双方法零调用（零状态写入，成功路径唯一的写入口未被触达）', (c) => {
    const h = makeHarness(c.reason === 'no-session' ? null : 'bound-sid')
    const result = c.act(h)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe(c.reason)
    expect(h.sink.openDrawerTab).not.toHaveBeenCalled()
    expect(h.sink.openOverlayContent).not.toHaveBeenCalled()
  })

  it('校验短路：params 非法不发生目标解析；族不匹配不咨询数据事实（失败越早，越不可能产生半程副作用）', () => {
    const invalid = makeHarness()
    invalid.executor.navigate(
      drawerAction({ params: { filePath: [1] } as unknown as HostContainerAction['params'] }),
    )
    expect(invalid.lookup.resolveTargets).not.toHaveBeenCalled()
    expect(invalid.lookup.hasData).not.toHaveBeenCalled()

    const mismatch = makeHarness()
    mismatch.lookup.resolveTargets.mockReturnValue([makeTarget({ placement: 'overlay.content' })])
    mismatch.executor.navigate(drawerAction())
    expect(mismatch.lookup.hasData).not.toHaveBeenCalled()
  })

  it('失败不污染状态且可恢复：同一执行器先失败（零写入）后修正输入重试成功（写入恰好一次）', () => {
    const { executor, sink, lookup } = makeHarness()
    lookup.resolveTargets.mockReturnValueOnce([]) // 第一次：目标不存在
    const failed = executor.navigate(drawerAction())
    expect(failed.ok).toBe(false)
    expect(sink.openDrawerTab).not.toHaveBeenCalled()
    // 修正后（注册表有目标了）重试成功——失败行未留下任何状态或抑制
    const ok = executor.navigate(drawerAction(), { viewSessionId: 'view-sid' })
    expect(ok.ok).toBe(true)
    expect(sink.openDrawerTab).toHaveBeenCalledTimes(1)
  })
})
