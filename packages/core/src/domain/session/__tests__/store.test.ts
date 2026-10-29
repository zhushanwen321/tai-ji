// store.test.ts —— core C04 簇合并产物（round5-G）。
// 共同被测业务模块：`src/domain/session/store.ts`。mock 相容：全簇零 vi.mock。
// 顶层正文按来源包 describe 纯前缀分节，it 层名零改动。
//
// 来源：
//   - src/domain/session/__tests__/create-session-flow.test.ts（11 用例，skip 0）
//   - src/domain/session/__tests__/live-state-pull.test.ts（7 用例，skip 0）
//   - src/domain/session/__tests__/live-state.test.ts（6 用例，skip 0）
//   - src/domain/session/__tests__/store.test.ts（16 用例，skip 0）
//   - src/domain/session/__tests__/use-session-refresh-history.test.ts（7 用例，skip 0）
//   - src/domain/session/__tests__/use-session.test.ts（43 用例，skip 0）

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { type Segment, type SessionSummary, type SessionGroup, type BatchDeleteResult, type SessionViewSnapshot, type ImageCacheWriteImage, type ImageCacheWriteResult, type Message } from '@taiji/shared'
import { createSessionStore } from '../store'
import { createSessionFlow, type CreateSessionFlowCtx, type CreateSessionFlowInput } from '../create-session-flow'
import { effectScope, computed, nextTick } from 'vue'
import { createUseSession, resetSessionListSubForTest, type UseSessionDeps, type SessionCleanupHooks, type ChatHydratePort } from '../use-session'
import { type SessionEntryPort } from '../api-port'
import { createSessionLiveState, type SessionLiveStateStore } from '../live-state'
import { createChatStore } from '../../chat/store'
import { setImageCacheWritePort, _resetImageCacheForTest } from '../../chat/image-cache'

// ======== 来源：create-session-flow.test.ts ========
describe("create-session-flow", () => {
  /** 构造测试 ctx：store 真实，api/applyModel/onCwdFallback 为 vi.fn。 */
  function makeCtx(overrides: Partial<CreateSessionFlowCtx> = {}): CreateSessionFlowCtx {
    const store = createSessionStore()
    return {
      store,
      api: {
        list: vi.fn(),
        switchSession: vi.fn(),
        create: vi.fn(
          async (cwd: string, label: string): Promise<SessionSummary> =>
            ({ id: 'ns', cwd, label, status: 'idle' }) as SessionSummary,
        ),
        rename: vi.fn(),
        remove: vi.fn(),
        archive: vi.fn(),
        removeByCwd: vi.fn(),
        migrateImage: vi.fn(async () => ({ path: '/data/attachments/ns/x.png' })),
        onConfigSessions: vi.fn(() => () => {}),
      },
      defaultCwd: '/home',
      onCwdFallback: vi.fn(),
      ...overrides,
    }
  }

  /** 构造 text 段。 */
  function textSeg(text: string): Segment {
    return { type: 'text', text }
  }

  /** 构造 image 段。 */
  function imageSeg(path: string, needsMigrate = false): Segment {
    return {
      type: 'image',
      id: path,
      path,
      fileName: path.split('/').pop() ?? 'x.png',
      displayName: path,
      needsMigrate,
    }
  }

  /** 构造 slash 命令段（D4-a 后命令 chip 的结构化形态，name 不含 '/' 前缀）。 */
  function slashSeg(name: string): Segment {
    return { type: 'slash', name }
  }

  describe('createSessionFlow', () => {
    let ctx: CreateSessionFlowCtx
    beforeEach(() => {
      ctx = makeCtx()
    })

    it('TC-1 label 派生三分支：纯 text / bash command / 非 text 仅贴图（兜底文案）', async () => {
      // ① 纯 text：前 10 codePoint（输入 12 字符 → 前 10 + 省略号）
      await createSessionFlow(ctx, { cwd: '/x', segments: [textSeg('帮我重构这段代码 abc')] })
      // 第 4 参 projectId（D14 创建时归属 activeProject）：未传 → undefined
      // 第 5-6 参 modelOverride/thinkingOverride（B3）：未传 → undefined
      expect(ctx.api.create).toHaveBeenCalledWith('/x', '帮我重构这段代码 a…', undefined, undefined, undefined, undefined, undefined)

      // ② bash command：label 从 command 取（无 ! 前缀）
      ctx = makeCtx()
      await createSessionFlow(ctx, {
        cwd: '/x',
        segments: [textSeg('!ls')],
        bashCommand: { command: 'ls -la', excludeFromContext: false },
      })
      expect(ctx.api.create).toHaveBeenCalledWith('/x', 'ls -la', undefined, undefined, undefined, undefined, undefined)

      // ③ 非 text 仅贴图：deriveSessionLabel('') 兜底「无提示词」
      ctx = makeCtx()
      await createSessionFlow(ctx, {
        cwd: '/x',
        segments: [imageSeg('/tmp/a.png', false)],
      })
      expect(ctx.api.create).toHaveBeenCalledWith('/x', '无提示词', undefined, undefined, undefined, undefined, undefined)
    })

    it('TC-1b slash 段视同 text-like 作 label 文本源（S-6）：landing 首发纯命令 → label 含 /tasks', async () => {
      // ① 纯命令首发（结构：[{type:'slash'}]）→ label 回退首个 slash 段拼 '/' + name，不退化为兜底文案
      await createSessionFlow(ctx, { cwd: '/x', segments: [slashSeg('tasks')] })
      expect(ctx.api.create).toHaveBeenCalledWith('/x', '/tasks', undefined, undefined, undefined, undefined, undefined)

      // ② 有非空 text 段 → 仍以 text 段为准（slash 段只在 trim 空时回退，不抢占 label）
      ctx = makeCtx()
      await createSessionFlow(ctx, { cwd: '/x', segments: [textSeg('总结'), slashSeg('compact')] })
      expect(ctx.api.create).toHaveBeenCalledWith('/x', '总结', undefined, undefined, undefined, undefined, undefined)

      // ③ text 段仅空白（trim 空）+ slash 段 → 回退 slash 段（对齐 base：命令拍平进 text 时的 label）
      ctx = makeCtx()
      await createSessionFlow(ctx, { cwd: '/x', segments: [textSeg('   '), slashSeg('tasks')] })
      expect(ctx.api.create).toHaveBeenCalledWith('/x', '/tasks', undefined, undefined, undefined, undefined, undefined)

      // ④ 无非 text 段且无 slash 段时仍走原兜底（guard 语义未变：空段不创建）
      ctx = makeCtx()
      const empty = await createSessionFlow(ctx, { cwd: '/x', segments: [] })
      expect(empty).toBeNull()
      expect(ctx.api.create).toHaveBeenCalledTimes(0)
    })

    it('TC-2 create 成功全编排序：create→appendSession→migrate（applyModel 步骤已随 D5 删除）', async () => {
      const appendSpy = vi.spyOn(ctx.store, 'appendSession')
      const input: CreateSessionFlowInput = {
        cwd: '/x',
        segments: [textSeg('hi')],
        pendingModel: 'openai/gpt-x',
      }
      const result = await createSessionFlow(ctx, input)

      // 编排序断言：create → appendSession → migrateImages（无图片段跳过）
      expect(ctx.api.create).toHaveBeenCalledTimes(1)
      expect(ctx.api.create).toHaveBeenCalledWith('/x', 'hi', undefined, undefined, 'openai/gpt-x', undefined, undefined)
      expect(appendSpy).toHaveBeenCalledTimes(1)
      expect(appendSpy).toHaveBeenCalledWith({ id: 'ns', cwd: '/x', label: 'hi', status: 'idle' })
      // [D5] step 7 applyModel 已删：模型经 create modelOverride 快照化一次到位，
      // 无 post-create 同值二次 RPC（ctx.applyModel 字段已随 U2d 壳清理删除）
      // 无图片段：migrateImage 未调
      expect(ctx.api.migrateImage).toHaveBeenCalledTimes(0)
      // 返回结构
      expect(result).not.toBeNull()
      expect(result?.session.id).toBe('ns')
      expect(result?.migratedSegments).toHaveLength(1)
      expect(result?.migratedSegments[0]).toEqual(textSeg('hi'))
      // store 终态：appendSession 真实生效
      expect(ctx.store.list.value.find((s) => s.id === 'ns')).toBeDefined()
    })

    it('TC-3 ES4 INV-7 降级：created.cwd !== 请求 cwd → onCwdFallback(reqCwd, actualCwd) 触发', async () => {
      // 降级场景：请求 /x/invalid，runtime 降级到 /home
      ctx = makeCtx({
        api: {
          ...makeCtx().api,
          create: vi.fn(async () => ({ id: 'ns', cwd: '/home', label: 'L' }) as SessionSummary),
        },
      })
      await createSessionFlow(ctx, { cwd: '/x/invalid', segments: [textSeg('hi')] })
      expect(ctx.onCwdFallback).toHaveBeenCalledTimes(1)
      expect(ctx.onCwdFallback).toHaveBeenCalledWith('/x/invalid', '/home')

      // 对照：cwd 一致场景 → onCwdFallback 不触发
      ctx = makeCtx()
      await createSessionFlow(ctx, { cwd: '/x', segments: [textSeg('hi')] })
      expect(ctx.onCwdFallback).toHaveBeenCalledTimes(0)
    })

    it('TC-4 pendingModel 空（无 explicit 模型）→ create 不带 modelOverride（终值由上游 resolve 给出）；presetId 透传 create', async () => {
      await createSessionFlow(ctx, {
        cwd: '/x',
        segments: [textSeg('hi')],
        presetId: 'preset-1',
        pendingModel: null,
      })
      expect(ctx.api.create).toHaveBeenCalledWith('/x', 'hi', 'preset-1', undefined, undefined, undefined, undefined)
      // applyModel 编排步骤已删（D5），无论 pendingModel 有无恒不调（字段已随 U2d 删除）
    })

    it('TC-5 空 content guard：无 text 且无非 text 段且无 bashCommand → 返回 null（不创建）', async () => {
      // 空段
      const r1 = await createSessionFlow(ctx, { cwd: '/x', segments: [] })
      expect(r1).toBeNull()
      expect(ctx.api.create).toHaveBeenCalledTimes(0)
      expect(ctx.store.list.value).toHaveLength(0)

      // 纯空白 text + 无 bashCommand → 同样 null（trimmed 空且 hasOnlyNonText false）
      const r2 = await createSessionFlow(ctx, { cwd: '/x', segments: [textSeg('   ')] })
      expect(r2).toBeNull()
      expect(ctx.api.create).toHaveBeenCalledTimes(0)
    })

    it('TC-6 migrateImages 更新 segments.path：needsMigrate 成功 → path 更新 + needsMigrate 重置 false', async () => {
      const input: CreateSessionFlowInput = {
        cwd: '/x',
        segments: [textSeg('看图'), imageSeg('/tmp/a.png', true)],
      }
      const result = await createSessionFlow(ctx, input)

      expect(ctx.api.migrateImage).toHaveBeenCalledTimes(1)
      expect(ctx.api.migrateImage).toHaveBeenCalledWith({
        fromPath: '/tmp/a.png',
        sessionId: 'ns',
        fileName: 'a.png',
      })
      expect(result?.migratedSegments).toHaveLength(2)
      // text 段原样
      expect(result?.migratedSegments[0]).toEqual(textSeg('看图'))
      // image 段 path 更新 + needsMigrate 重置
      const img = result?.migratedSegments[1] as Extract<Segment, { type: 'image' }>
      expect(img.path).toBe('/data/attachments/ns/x.png')
      expect(img.needsMigrate).toBe(false)
    })

    it('TC-7 migrateImages 降级：单文件 reject 不阻断 + 保留原 path（allSettled）', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      // i1 成功，i2 reject
      ctx = makeCtx({
        api: {
          ...makeCtx().api,
          migrateImage: vi.fn(async (p: { fromPath: string; sessionId: string; fileName: string }) => {
            if (p.fromPath === '/tmp/b.png') {
              throw new Error('os cleaned')
            }
            return { path: '/data/1.png' }
          }),
        },
      })
      const input: CreateSessionFlowInput = {
        cwd: '/x',
        segments: [imageSeg('/tmp/a.png', true), imageSeg('/tmp/b.png', true)],
      }
      const result = await createSessionFlow(ctx, input)

      // 不抛错（await 正常 resolve）
      expect(result).not.toBeNull()
      const segs = result?.migratedSegments as Extract<Segment, { type: 'image' }>[]
      // i1 迁移成功：path 更新
      expect(segs[0].path).toBe('/data/1.png')
      expect(segs[0].needsMigrate).toBe(false)
      // i2 失败：保留原 path + needsMigrate 保持 true
      expect(segs[1].path).toBe('/tmp/b.png')
      expect(segs[1].needsMigrate).toBe(true)
      // console.warn 包含失败 path
      expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('/tmp/b.png'))).toBe(true)
      warnSpy.mockRestore()
    })

    it('TC-8 defaultCwd 兜底：input.cwd=null → 用 ctx.defaultCwd 创建', async () => {
      ctx = makeCtx({ defaultCwd: '/home/user' })
      await createSessionFlow(ctx, { cwd: null, segments: [textSeg('hi')] })
      expect(ctx.api.create).toHaveBeenCalledWith('/home/user', 'hi', undefined, undefined, undefined, undefined, undefined)
    })

    it('TC-9 E7 两空 cwd：reqCwd 空串且 runtime 落 homedir → onCwdFallback("", actualCwd) 触发（不再静默）', async () => {
      // landing 两空：pendingCwd null 且 ctx.defaultCwd 空 → cwd='' → runtime create('')
      // 内部落 homedir（resolveCreateCwd existsSync('')=false）。空串检查曾跳过回调——
      // 放宽后两空场景也有 toast 提示（D10-E7「已在主目录创建」由壳侧文案承担）
      ctx = makeCtx({
        defaultCwd: '',
        api: {
          ...makeCtx().api,
          create: vi.fn(async () => ({ id: 'ns', cwd: '/home/user', label: 'L' }) as SessionSummary),
        },
      })
      await createSessionFlow(ctx, { cwd: null, segments: [textSeg('hi')] })
      expect(ctx.api.create).toHaveBeenCalledWith('', 'hi', undefined, undefined, undefined, undefined, undefined)
      expect(ctx.onCwdFallback).toHaveBeenCalledTimes(1)
      expect(ctx.onCwdFallback).toHaveBeenCalledWith('', '/home/user')
    })

    it('TC-10 clientUuid 幂等键透传（发现 B）：input.clientUuid → api.create 末参；缺省传 undefined', async () => {
      // 编译期契约：CreateSessionFlowInput.clientUuid 可选字段（与调用方的接口约定字段名）
      const inputWithUuid: CreateSessionFlowInput = {
        cwd: '/x',
        segments: [textSeg('hi')],
        clientUuid: 'u-create-1',
      }
      await createSessionFlow(ctx, inputWithUuid)
      // 运行时透传：clientUuid 原样到达 api.create 第 7 参（壳适配层据此填 RPC payload.clientUuid，
      // runtime 按其去重——同 uuid 重试返回已建 session，不重复 spawn/建号）
      expect(ctx.api.create).toHaveBeenCalledWith('/x', 'hi', undefined, undefined, undefined, undefined, 'u-create-1')

      // 缺省 clientUuid → 末参 undefined（向后兼容，api 侧 payload 不含该键；既有各 TC 已断言）
      ctx = makeCtx()
      await createSessionFlow(ctx, { cwd: '/x', segments: [textSeg('hi')] })
      expect(ctx.api.create).toHaveBeenCalledWith('/x', 'hi', undefined, undefined, undefined, undefined, undefined)
    })
  })
});

// ======== 来源：live-state-pull.test.ts ========
describe("live-state-pull", () => {
  /** 微任务清空（确定性 flush：mock 的 getState 返已 resolve 的 promise，数次 tick 必达） */
  async function flushMicrotasks(times = 6): Promise<void> {
    for (let i = 0; i < times; i++) await Promise.resolve()
  }

  function makeHooks(): SessionCleanupHooks {
    const noop = (): void => {}
    return {
      clearFileTree: noop, clearSubagent: noop, clearWorkflow: noop, clearExtensionUI: noop,
      clearExtensionHost: noop, evictChat: noop, evictVirtualKeys: noop, clearAgentCallMapping: noop,
      disposeChat: noop, invalidateStatus: noop, browserDestroy: noop,
    }
  }

  type Fixture = {
    session: ReturnType<typeof createUseSession>
    store: ReturnType<typeof createSessionStore>
    liveState: SessionLiveStateStore
    api: {
      list: ReturnType<typeof vi.fn>
      switchSession: ReturnType<typeof vi.fn>
      create: ReturnType<typeof vi.fn>
      rename: ReturnType<typeof vi.fn>
      remove: ReturnType<typeof vi.fn>
      archive: ReturnType<typeof vi.fn>
      removeByCwd: ReturnType<typeof vi.fn>
      migrateImage: ReturnType<typeof vi.fn>
      onConfigSessions: ReturnType<typeof vi.fn>
      getState: ReturnType<typeof vi.fn>
    }
    chat: ChatHydratePort & {
      getHistory: ReturnType<typeof vi.fn>
      isHydrated: ReturnType<typeof vi.fn>
      reconcileHistory: ReturnType<typeof vi.fn>
      markHistoryFailed: ReturnType<typeof vi.fn>
    }
    dispose: () => void
  }

  function makeFixture(opts: { withLiveState?: boolean } = {}): Fixture {
    const scope = effectScope(true)
    const store = scope.run(() => createSessionStore())!
    const liveState = scope.run(() => createSessionLiveState())!
    const api = {
      list: vi.fn().mockResolvedValue([]),
      switchSession: vi.fn().mockResolvedValue(undefined),
      create: vi.fn(),
      rename: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
      archive: vi.fn().mockResolvedValue(undefined),
      removeByCwd: vi.fn().mockResolvedValue({ cwd: '/a', deleted: [], failed: [] } as BatchDeleteResult),
      migrateImage: vi.fn(),
      onConfigSessions: vi.fn(() => vi.fn()),
      getState: vi.fn(),
    }
    const panel = {
      focusedSessionId: vi.fn(() => null),
      activePanelId: vi.fn(() => 'p1'),
      findPanelBySession: vi.fn(() => null),
      loadSession: vi.fn(),
      openPanel: vi.fn(),
    }
    const navigation = { push: vi.fn() }
    const chat = {
      getHistory: vi.fn().mockResolvedValue({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 }),
      isHydrated: vi.fn(() => false),
      hydrate: vi.fn(),
      reconcileHistory: vi.fn(),
      clearHistoryError: vi.fn(),
      markHistoryFailed: vi.fn(),
    } satisfies ChatHydratePort & Record<string, ReturnType<typeof vi.fn>>
    const deps: UseSessionDeps = {
      store,
      api,
      panel,
      navigation,
      chat,
      hooks: makeHooks(),
      ...(opts.withLiveState === false ? {} : { liveState }),
    }
    const session = scope.run(() => createUseSession(deps))!
    return { session, store, liveState, api, chat, dispose: () => scope.stop() }
  }

  describe('refreshLiveState（W2 权威拉取与冷读）', () => {
    beforeEach(() => {
      resetSessionListSubForTest()
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('打开视图时机：切入链尾部触发拉取，reply 落状态层（缓存缺失门控）', async () => {
      const f = makeFixture()
      f.api.getState.mockResolvedValue({ sessionId: 'sid-1', modelId: 'prov-a/model-a', thinkingLevel: 'high' })

      await f.session.selectSession('sid-1')
      // getState 在切入链内同步到达（refreshLiveState 的首个 await 之前）
      expect(f.api.getState).toHaveBeenCalledWith('sid-1')
      await flushMicrotasks()

      expect(f.liveState.liveStateOf('sid-1')).toEqual({ modelId: 'prov-a/model-a', thinkingLevel: 'high' })
      f.dispose()
    })

    it('缓存缺失门控：状态层已有条目 → 不发 RPC（不覆盖推送已更新的值）', async () => {
      const f = makeFixture()
      f.liveState.applyLiveState('sid-1', { modelId: 'prov-pushed/model-pushed', thinkingLevel: 'low' })

      await f.session.refreshLiveState('sid-1')

      expect(f.api.getState).not.toHaveBeenCalled()
      expect(f.liveState.liveStateOf('sid-1')).toEqual({ modelId: 'prov-pushed/model-pushed', thinkingLevel: 'low' })
      f.dispose()
    })

    it('拉取失败：静默不抛 + 状态层保持显式未知（不回退猜测）', async () => {
      const f = makeFixture()
      f.api.getState.mockRejectedValue(Object.assign(new Error('session not found'), { code: 'SESSION_NOT_FOUND' }))
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      await expect(f.session.refreshLiveState('ghost')).resolves.toBeUndefined()

      expect(f.liveState.liveStateOf('ghost')).toBeUndefined()
      expect(warn).toHaveBeenCalled()
      f.dispose()
    })

    it('字段级合并：拉取先落一维、状态消息补另一维，两维都在（同一 reducer）', async () => {
      const f = makeFixture()
      // 拉取只拿到 modelId（thinkingLevel 缺省 = 该维显式未知）
      f.api.getState.mockResolvedValue({ sessionId: 'sid-1', modelId: 'prov-a/model-a' })
      await f.session.refreshLiveState('sid-1')
      expect(f.liveState.liveStateOf('sid-1')).toEqual({ modelId: 'prov-a/model-a' })

      // 状态消息（thinkingLevelSet）补另一维——字段级合并，不清掉已落地的 modelId
      f.liveState.applyLiveState('sid-1', { thinkingLevel: 'high' })
      expect(f.liveState.liveStateOf('sid-1')).toEqual({ modelId: 'prov-a/model-a', thinkingLevel: 'high' })
      f.dispose()
    })

    it('未接线降级：liveState 缺省 → 跳过不抛；api.getState 缺省 → 同样跳过', async () => {
      const noLive = makeFixture({ withLiveState: false })
      await expect(noLive.session.refreshLiveState('sid-1')).resolves.toBeUndefined()
      expect(noLive.api.getState).not.toHaveBeenCalled()
      noLive.dispose()

      const noGetState = makeFixture()
      // 端口成员缺席（壳旧装配形态）
      const apiWithoutGetState = { ...noGetState.api } as Record<string, unknown>
      delete apiWithoutGetState.getState
      const scope = effectScope(true)
      const session = scope.run(() => createUseSession({
        store: noGetState.store,
        api: apiWithoutGetState as never,
        panel: noGetState.api as never,
        navigation: { push: vi.fn() },
        chat: noGetState.chat,
        hooks: makeHooks(),
        liveState: noGetState.liveState,
      }))!
      await expect(session.refreshLiveState('sid-1')).resolves.toBeUndefined()
      expect(noGetState.liveState.liveStateOf('sid-1')).toBeUndefined()
      scope.stop()
    })
  })

  describe('三源同一 reducer（设计 §7 验收项 8）', () => {
    beforeEach(() => {
      resetSessionListSubForTest()
    })

    it('订阅回放 + 状态消息 + 拉取全部经 applyLiveState，合并结果与 runtime 快照逐字段一致', async () => {
      const f = makeFixture()
      const applySpy = vi.spyOn(f.liveState, 'applyLiveState')
      // runtime 快照（权威终值）：三源各自携带不同子集，合并后应逐字段等于它
      const runtimeSnapshot = { modelId: 'prov-final/model-final', thinkingLevel: 'xhigh' }

      // 源 1（拉取，W2 新增的第三源）：缓存缺失时打开会话即拉，两维一次落地
      f.api.getState.mockResolvedValue({ sessionId: 'sid-1', modelId: 'prov-pull/model-pull', thinkingLevel: 'high' })
      await f.session.refreshLiveState('sid-1')
      expect(f.liveState.liveStateOf('sid-1')).toEqual({ modelId: 'prov-pull/model-pull', thinkingLevel: 'high' })

      // 源 2（状态消息）：session.state_changed 只带 modelId
      f.liveState.applyLiveState('sid-1', { modelId: 'prov-msg/model-msg' })
      // 源 3（订阅回放/档位回执）：session.thinkingLevelSet 只带 thinkingLevel
      f.liveState.applyLiveState('sid-1', { thinkingLevel: 'xhigh' })
      // 权威终态由最后到达的两条消息收敛（推是提示，覆盖同维度的拉取值）
      f.liveState.applyLiveState('sid-1', { modelId: runtimeSnapshot.modelId })

      expect(f.liveState.liveStateOf('sid-1')).toEqual(runtimeSnapshot)
      // 四次写入全部落在同一个写入口上（无第二套合并逻辑）
      expect(applySpy).toHaveBeenCalledTimes(4)
      expect(applySpy.mock.calls.map((c) => c[1])).toEqual([
        { modelId: 'prov-pull/model-pull', thinkingLevel: 'high' },
        { modelId: 'prov-msg/model-msg' },
        { thinkingLevel: 'xhigh' },
        { modelId: runtimeSnapshot.modelId },
      ])
      f.dispose()
    })

    it('拉取写入不带 sessionId 进状态层（键 = 入参 sessionId，不信任 reply 回显）', async () => {
      const f = makeFixture()
      // reply 的 sessionId 与请求不一致（协议漂移/恶意回显）时，落点仍是请求的 sid
      f.api.getState.mockResolvedValue({ sessionId: 'other', modelId: 'prov-a/model-a' })

      await f.session.refreshLiveState('sid-1')

      expect(f.liveState.liveStateOf('sid-1')).toEqual({ modelId: 'prov-a/model-a' })
      expect(f.liveState.liveStateOf('other')).toBeUndefined()
      f.dispose()
    })
  })
});

// ======== 来源：live-state.test.ts ========
describe("live-state", () => {
  function makeSession(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    return {
      label: overrides.id,
      cwd: '/work/a',
      status: 'idle',
      lastActiveAt: 0,
      ...overrides,
    }
  }

  function group(cwd: string, sessions: SessionSummary[]): SessionGroup {
    return { cwd, sessions }
  }

  describe('createSessionLiveState（状态层按会话 id 寄存，ADR-0049 分区范式）', () => {
    it('applyLiveState 字段级合并：patch 未提供的维度保留现值', () => {
      const live = createSessionLiveState()

      live.applyLiveState('s1', { modelId: 'p/a' })
      expect(live.liveStateOf('s1')).toEqual({ modelId: 'p/a' })

      live.applyLiveState('s1', { thinkingLevel: 'high' })
      expect(live.liveStateOf('s1')).toEqual({ modelId: 'p/a', thinkingLevel: 'high' })

      // 只改 modelId，thinkingLevel 保留
      live.applyLiveState('s1', { modelId: 'p/b' })
      expect(live.liveStateOf('s1')).toEqual({ modelId: 'p/b', thinkingLevel: 'high' })
    })

    it('侧栏列表之外的会话 id 同样写入：写入路径无 hidden / 列表成员判据（验收项 5）', () => {
      const live = createSessionLiveState()

      // btw 线（runtime hidden 注册）与任意不在侧栏列表的 id 走同一入口、同一形状
      live.applyLiveState('pi-line-1', { modelId: 'p/line', thinkingLevel: 'low' })
      live.applyLiveState('not-in-sidebar', { modelId: 'p/ghost' })
      live.applyLiveState('main-1', { modelId: 'p/main' })

      expect(live.liveStateOf('pi-line-1')).toEqual({ modelId: 'p/line', thinkingLevel: 'low' })
      expect(live.liveStateOf('not-in-sidebar')).toEqual({ modelId: 'p/ghost' })
      expect(live.liveStateOf('main-1')).toEqual({ modelId: 'p/main' })
    })

    it('缓存缺失 → undefined（显式未知，不回退其他会话的值）', () => {
      const live = createSessionLiveState()
      live.applyLiveState('s1', { modelId: 'p/a', thinkingLevel: 'high' })

      expect(live.liveStateOf('s2')).toBeUndefined()
      // 值不串台：不同 id 各自独立
      expect(live.liveStateOf('s1')).toEqual({ modelId: 'p/a', thinkingLevel: 'high' })
    })

    it('整表刷新 / 归档 / 项目过滤后，已缓存状态仍在（验收项 3）', () => {
      const live = createSessionLiveState()
      const nav = createSessionStore()

      const s1 = makeSession({ id: 's1', cwd: '/a', projectId: 'p1' })
      const s2 = makeSession({ id: 's2', cwd: '/b' })
      nav.applySnapshot({ groups: [group('/a', [s1]), group('/b', [s2])] })

      live.applyLiveState('s1', { modelId: 'p/a', thinkingLevel: 'high' })
      live.applyLiveState('s2', { modelId: 'p/b' })

      // ① 整表刷新（同内容重放）
      nav.applySnapshot({ groups: [group('/a', [s1]), group('/b', [s2])] })
      expect(live.liveStateOf('s1')).toEqual({ modelId: 'p/a', thinkingLevel: 'high' })
      expect(live.liveStateOf('s2')).toEqual({ modelId: 'p/b' })

      // ② 归档 / 删除后条目从列表消失（列表只剩 s1）
      nav.applySnapshot({ groups: [group('/a', [s1])] })
      expect(nav.list.value.map((s) => s.id)).toEqual(['s1'])
      expect(live.liveStateOf('s2')).toEqual({ modelId: 'p/b' })

      // ③ 项目过滤（分组集合变化，s1 归属被过滤掉）
      nav.applySnapshot({ groups: [group('/b', [s2])] })
      expect(nav.list.value.map((s) => s.id)).toEqual(['s2'])
      expect(live.liveStateOf('s1')).toEqual({ modelId: 'p/a', thinkingLevel: 'high' })
      expect(live.liveStateOf('s2')).toEqual({ modelId: 'p/b' })
    })

    it('removeLiveState 只移除显式请求的条目（会话删除时唯一清退口）', () => {
      const live = createSessionLiveState()
      live.applyLiveState('s1', { modelId: 'p/a' })
      live.applyLiveState('s2', { modelId: 'p/b' })

      live.removeLiveState('s1')
      expect(live.liveStateOf('s1')).toBeUndefined()
      expect(live.liveStateOf('s2')).toEqual({ modelId: 'p/b' })

      // 幂等：重复移除不抛
      expect(() => live.removeLiveState('s1')).not.toThrow()
    })

    it('响应式：liveStateOf 在状态写入后驱动 Vue computed 重算', async () => {
      const scope = effectScope()
      const live = createSessionLiveState()
      const value = scope.run(() => computed(() => live.liveStateOf('s1')))!

      expect(value.value).toBeUndefined()
      live.applyLiveState('s1', { modelId: 'p/a' })
      await nextTick()
      expect(value.value).toEqual({ modelId: 'p/a' })

      live.applyLiveState('s1', { thinkingLevel: 'max' })
      await nextTick()
      expect(value.value).toEqual({ modelId: 'p/a', thinkingLevel: 'max' })

      live.removeLiveState('s1')
      await nextTick()
      expect(value.value).toBeUndefined()
      scope.stop()
    })
  })
});

// ======== 来源：store.test.ts ========
describe("store", () => {
  function makeSession(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    return {
      label: overrides.id,
      cwd: '/work/a',
      status: 'idle',
      lastActiveAt: 0,
      ...overrides,
    }
  }

  describe('createSessionStore', () => {
    it('TC-1: applySnapshot 整表形态 → list 派生（flatMap 展平、顺序保持、跟随更新）', () => {
      const store = createSessionStore()
      const s1 = makeSession({ id: 's1', cwd: '/a' })
      const s2 = makeSession({ id: 's2', cwd: '/a' })
      const s3 = makeSession({ id: 's3', cwd: '/b' })

      store.applySnapshot({
        groups: [
          { cwd: '/a', sessions: [s1, s2] },
          { cwd: '/b', sessions: [s3] },
        ],
      })
      expect(store.list.value.map((s) => s.id)).toEqual(['s1', 's2', 's3'])

      // 整表快照换新数组后 list 同步变化（响应性，非一次性快照）
      store.applySnapshot({ groups: [{ cwd: '/b', sessions: [s3] }] })
      expect(store.list.value.map((s) => s.id)).toEqual(['s3'])
    })

    it('TC-2: appendSession 按 cwd 归组（命中入尾 / 新建组在末尾）', () => {
      const store = createSessionStore()
      const s1 = makeSession({ id: 's1', cwd: '/a' })
      const s2 = makeSession({ id: 's2', cwd: '/a' })
      const s3 = makeSession({ id: 's3', cwd: '/c' })

      store.applySnapshot({ groups: [{ cwd: '/a', sessions: [s1] }] })
      store.appendSession(s2)
      expect(store.groups.value).toEqual([{ cwd: '/a', sessions: [s1, s2] }])

      // 未命中 cwd → 新建组追加在末尾，原组顺序不变
      store.appendSession(s3)
      expect(store.groups.value.map((g) => g.cwd)).toEqual(['/a', '/c'])
      expect(store.groups.value[1].sessions.map((s) => s.id)).toEqual(['s3'])
    })

    it('TC-3: removeFromList 删 active 回退 list[0]、空组移除、删非 active 不影响 activeId', () => {
      const store = createSessionStore()
      const s1 = makeSession({ id: 's1', cwd: '/a' })
      const s2 = makeSession({ id: 's2', cwd: '/a' })
      const s3 = makeSession({ id: 's3', cwd: '/b' })
      store.applySnapshot({
        groups: [
          { cwd: '/a', sessions: [s1, s2] },
          { cwd: '/b', sessions: [s3] },
        ],
      })
      store.activeId.value = 's2'

      // 删 active → 回退删除后 list[0]（s1）
      store.removeFromList('s2')
      expect(store.activeId.value).toBe('s1')
      expect(store.groups.value).toEqual([{ cwd: '/a', sessions: [s1] }, { cwd: '/b', sessions: [s3] }])

      // 删非 active → activeId 不变
      store.removeFromList('s3')
      expect(store.activeId.value).toBe('s1')

      // 删空组：删 s1 后 /a 组清空 → 组移除，仅剩 /b 空组？/b 已删 s3 为空——应被整体移除
      store.removeFromList('s1')
      expect(store.groups.value).toEqual([])
      expect(store.activeId.value).toBeNull()
    })

    it('TC-4: applySnapshot 单 session 描述字段——undefined 跳过、未知 id 静默', () => {
      const store = createSessionStore()
      const s1 = makeSession({ id: 's1', label: 'old', status: 'idle' })
      store.applySnapshot({ groups: [{ cwd: '/a', sessions: [s1] }] })

      store.applySnapshot('s1', { label: '新名' })
      expect(store.list.value[0].label).toBe('新名')

      // 快照未涉及的字段（undefined）保留现值：只给 status，label 不变
      store.applySnapshot('s1', { status: 'active' })
      expect(store.list.value[0].status).toBe('active')
      expect(store.list.value[0].label).toBe('新名')

      // 未知 id 静默无副作用
      store.applySnapshot('nope', { label: 'x', status: 'dead' })
      expect(store.list.value[0].label).toBe('新名')
      expect(store.list.value[0].status).toBe('active')
    })

    it('TC-4a: D1b 合并规则——描述字段整字段覆盖（多字段一次到位）', () => {
      const store = createSessionStore()
      const s1 = makeSession({ id: 's1', label: 'old', status: 'idle' })
      store.applySnapshot({ groups: [{ cwd: '/a', sessions: [s1] }] })

      store.applySnapshot('s1', { label: '扫描名', status: 'done' })
      const after = store.list.value[0]
      expect(after.label).toBe('扫描名')
      expect(after.status).toBe('done')

      // status 也走同一合并路径（session.exited 类状态迁移）
      store.applySnapshot('s1', { status: 'dead' })
      expect(store.list.value[0].status).toBe('dead')
    })

    it('TC-4b: D1b 合并规则——显式空值覆盖（owner 声明空即空，不保留旧真值）', () => {
      const store = createSessionStore()
      const s1 = makeSession({ id: 's1', label: '旧名' })
      store.applySnapshot({ groups: [{ cwd: '/a', sessions: [s1] }] })

      // owner 权威空值（sessionName 空 = 未命名合法态，wire 到快照层为 label:''）覆盖
      store.applySnapshot('s1', { label: '' })
      expect(store.list.value[0].label).toBe('')
    })

    // ── [W1 会话架构四层分离] 状态字段不再由导航列表承载 ──────────────────
    // 设计 §3.3 删除清单：applySnapshot 不再写 modelId / thinkingLevel / tokenCount。
    // 状态权威 = domain/session/live-state（唯一写入口 applyLiveState）。
    // [W3] 三状态字段已从 SessionSummary 类型删除（状态归状态层，列表只承载导航）——
    // 原「列表条目带种子字段」的断言形态随之退役：不变量反向锁定为「状态帧里的同名
    // 字段落不进列表条目」（条目上无该属性）。以下用例维持该锁定。

    it('TC-W1-1: 单条快照带状态字段 → 列表条目不被写入（列表只托管描述字段）', () => {
      const store = createSessionStore()
      const s1 = makeSession({ id: 's1' })
      store.applySnapshot({ groups: [{ cwd: '/a', sessions: [s1] }] })

      store.applySnapshot('s1', { modelId: 'state/model', thinkingLevel: 'high', tokenCount: 999 })
      const after = store.list.value[0]
      // W3：条目上不再存在三状态字段（类型级删除），状态帧写入目标 = 状态层而非列表
      expect(after).not.toHaveProperty('modelId')
      expect(after).not.toHaveProperty('thinkingLevel')
      expect(after).not.toHaveProperty('tokenCount')
      expect(after.label).toBe('s1')
    })

    it('TC-W1-2: 列表外 id 的单条快照不写入任何条目（状态层才是列表外 id 的落点）', () => {
      const store = createSessionStore()
      const s1 = makeSession({ id: 's1' })
      store.applySnapshot({ groups: [{ cwd: '/a', sessions: [s1] }] })

      // btw 线 session id（runtime hidden 注册，不进侧栏列表）——列表不新增条目、不抛错
      store.applySnapshot('pi-line-1', { modelId: 'line/model', label: 'x' })
      expect(store.list.value.map((s) => s.id)).toEqual(['s1'])
    })

    it('TC-W1-3: 整表刷新只替换列表条目（描述字段随载荷），不涉及状态容器', () => {
      const store = createSessionStore()
      const s1 = makeSession({ id: 's1', label: 'a', status: 'idle' })
      store.applySnapshot({ groups: [{ cwd: '/a', sessions: [s1] }] })

      // 归档 / 项目过滤 / 刷新都只是整表替换：列表条目随载荷
      const next = makeSession({ id: 's1', label: 'a', status: 'done' })
      store.applySnapshot({ groups: [{ cwd: '/a', sessions: [next] }] })
      expect(store.list.value[0].status).toBe('done')

      // 状态层不受影响（此处只验证列表侧语义：列表 ≠ 状态容器，W1 后不变量见 live-state.test.ts）
      store.applySnapshot({ groups: [] })
      expect(store.list.value).toEqual([])
    })

    it('TC-4d: 单 session 快照 undefined → 整条静默跳过（描述字段全保留）', () => {
      const store = createSessionStore()
      const s1 = makeSession({ id: 's1', label: 'old', status: 'active' })
      store.applySnapshot({ groups: [{ cwd: '/a', sessions: [s1] }] })

      // 防御路径：广播 payload 缺失时快照可为 undefined
      ;(store.applySnapshot as (id: string, snapshot?: SessionViewSnapshot) => void)('s1', undefined)
      const after = store.list.value[0]
      expect(after.label).toBe('old')
      expect(after.status).toBe('active')
    })

    it('TC-4c: 乐观更新形态——本地入参只带乐观字段，权威广播回流幂等收敛', () => {
      const store = createSessionStore()
      const s1 = makeSession({ id: 's1', label: '旧名' })
      store.applySnapshot({ groups: [{ cwd: '/a', sessions: [s1] }] })

      // rename 乐观更新：applySnapshot 本地入参只带 label，UI 即时显示
      store.applySnapshot('s1', { label: '乐观名' })
      expect(store.list.value[0].label).toBe('乐观名')

      // config.sessions 权威整表回流：同一入口覆盖为 runtime 真值（重复写入幂等）
      const authoritative = makeSession({ id: 's1', label: '权威名' })
      store.applySnapshot({ groups: [{ cwd: '/a', sessions: [authoritative] }] })
      expect(store.list.value[0].label).toBe('权威名')
    })

    it('TC-5: markDead / revive 状态切换（revive 仅 dead→idle）', () => {
      const store = createSessionStore()
      const s1 = makeSession({ id: 's1', status: 'idle' })
      const s2 = makeSession({ id: 's2', status: 'active' })
      store.applySnapshot({ groups: [{ cwd: '/a', sessions: [s1, s2] }] })

      store.markDead('s1')
      expect(store.list.value.find((s) => s.id === 's1')?.status).toBe('dead')
      // 已是 dead 再 markDead 保持 dead
      store.markDead('s1')
      expect(store.list.value.find((s) => s.id === 's1')?.status).toBe('dead')

      store.revive('s1')
      expect(store.list.value.find((s) => s.id === 's1')?.status).toBe('idle')

      // 非 dead（active）revive 无副作用
      store.revive('s2')
      expect(store.list.value.find((s) => s.id === 's2')?.status).toBe('active')

      // 未知 id 静默
      store.markDead('nope')
      store.revive('nope')
      expect(store.list.value.length).toBe(2)
    })

    it('TC-5b: markDead 后全量快照保留 dead 态（session.exited 后紧接 config.sessions 全量覆盖不冲掉 dead）', () => {
      const store = createSessionStore()
      const s1 = makeSession({ id: 's1', cwd: '/a', status: 'active' })
      const s2 = makeSession({ id: 's2', cwd: '/a', status: 'active' })
      store.applySnapshot({ groups: [{ cwd: '/a', sessions: [s1, s2] }] })

      store.markDead('s1')
      expect(store.list.value.find((s) => s.id === 's1')?.status).toBe('dead')

      // runtime 全量广播 config.sessions：s1 来自磁盘 outcome（stopped），s2 正常 idle。
      // dead 是运行时进程态（比磁盘 outcome 新），不得被覆盖
      store.applySnapshot({
        groups: [
          {
            cwd: '/a',
            sessions: [
              makeSession({ id: 's1', cwd: '/a', status: 'stopped' }),
              makeSession({ id: 's2', cwd: '/a', status: 'idle' }),
            ],
          },
        ],
      })
      expect(store.list.value.find((s) => s.id === 's1')?.status).toBe('dead')
      expect(store.list.value.find((s) => s.id === 's2')?.status).toBe('idle')

      // 新列表中不存在的 dead session 不保留（首 turn 无文件死亡的终结语义：随列表消失）
      store.markDead('s2')
      store.applySnapshot({ groups: [{ cwd: '/a', sessions: [makeSession({ id: 's1', cwd: '/a', status: 'done' })] }] })
      expect(store.list.value.map((s) => s.id)).toEqual(['s1'])
      expect(store.list.value.find((s) => s.id === 's1')?.status).toBe('dead')
    })

    it('TC-5c: revive 后全量快照不再保持 dead（restoreSession 成功后磁盘态正常生效）', () => {
      const store = createSessionStore()
      const s1 = makeSession({ id: 's1', cwd: '/a', status: 'active' })
      store.applySnapshot({ groups: [{ cwd: '/a', sessions: [s1] }] })
      store.markDead('s1')
      store.revive('s1')
      expect(store.list.value.find((s) => s.id === 's1')?.status).toBe('idle')

      // revive 后全量刷新：新列表状态原样生效（不再被 dead 保留逻辑钉住）
      store.applySnapshot({ groups: [{ cwd: '/a', sessions: [makeSession({ id: 's1', cwd: '/a', status: 'idle' })] }] })
      expect(store.list.value.find((s) => s.id === 's1')?.status).toBe('idle')
    })

    // [W13 单入口薄壳，goal-audit 问题 3] markDead/revive 内部改经 applySnapshot(id, { status })
    // 局部快照——行为等价性固化：局部写不吞同条目其它托管字段（D1b undefined=快照未涉及），
    // status 变化保持响应式（侧栏 dead 置灰 / revive 恢复由同一链路驱动）。
    it('TC-5d: markDead/revive 经 applySnapshot 薄壳——局部快照不吞其它托管字段', () => {
      const store = createSessionStore()
      store.applySnapshot({
        groups: [{
          cwd: '/a',
          sessions: [makeSession({ id: 's1', label: '原名', status: 'active' })],
        }],
      })

      store.markDead('s1')
      const dead = store.list.value.find((s) => s.id === 's1')
      expect(dead?.status).toBe('dead')
      // 局部快照只带 status：label 等托管字段原样保留（不被 undefined 覆盖）
      // （W3 起 modelId 等三状态字段不在 SessionSummary 上，「不吞字段」断言收敛到描述字段）
      expect(dead?.label).toBe('原名')

      store.revive('s1')
      expect(store.list.value.find((s) => s.id === 's1')?.status).toBe('idle')
    })

    it('TC-6: listLoadError set/清空 + active 按 activeId 派生', () => {
      const store = createSessionStore()
      expect(store.listLoadError.value).toBeNull()

      store.setListLoadError('加载失败，点击重试')
      expect(store.listLoadError.value).toBe('加载失败，点击重试')

      store.setListLoadError(null)
      expect(store.listLoadError.value).toBeNull()

      // active 派生
      const s1 = makeSession({ id: 's1' })
      store.applySnapshot({ groups: [{ cwd: '/a', sessions: [s1] }] })
      expect(store.active.value).toBeNull() // activeId 未设

      store.activeId.value = 's1'
      expect(store.active.value?.id).toBe('s1')

      store.activeId.value = 'ghost'
      expect(store.active.value).toBeNull() // 未命中
    })
  })
});

// ======== 来源：use-session-refresh-history.test.ts ========
describe("use-session-refresh-history", () => {
  const SID = 'u9-rc-sid'

  /** session.history RPC 响应形状（ChatHydratePort.getHistory 的 await 返回） */
  type HistoryReply = Awaited<ReturnType<UseSessionDeps['chat']['getHistory']>>

  /** 完整 assistant 消息（complete 态 + piEntryId——reconcileHistory 窗口切分锚取 `piEntryId ?? id`） */
  function msg(id: string, piEntryId: string): Message {
    return { id, role: 'assistant', content: `msg-${id}`, status: 'complete', timestamp: 1, piEntryId }
  }

  function makeFixture() {
    const scope = effectScope(true)
    const chatStore = scope.run(() => createChatStore())!
    const sessionStore = scope.run(() => createSessionStore())!
    const getHistory = vi.fn<(sid: string) => Promise<HistoryReply>>()
    // chat 端口：getHistory mock（RPC 边界），其余成员透传真实 store（断言落到合并/窗口终端效果）
    const chat: UseSessionDeps['chat'] = {
      getHistory: (sid) => getHistory(sid),
      isHydrated: (sid) => chatStore.isHydrated(sid),
      hydrate: (sid, messages) => chatStore.hydrate(sid, messages),
      reconcileHistory: (sid, messages, window) => chatStore.reconcileHistory(sid, messages, window),
      clearHistoryError: (sid) => chatStore.clearHistoryError(sid),
      markHistoryFailed: (sid) => chatStore.markHistoryFailed(sid),
    }
    const api = {
      list: vi.fn().mockResolvedValue([]),
      switchSession: vi.fn().mockResolvedValue(undefined),
      create: vi.fn(),
      rename: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
      archive: vi.fn().mockResolvedValue(undefined),
      removeByCwd: vi.fn().mockResolvedValue({ cwd: '/a', deleted: [], failed: [] } as BatchDeleteResult),
      migrateImage: vi.fn(),
      onConfigSessions: vi.fn(() => vi.fn()),
    }
    const hooks: SessionCleanupHooks = {
      clearFileTree: vi.fn(), clearSubagent: vi.fn(), clearWorkflow: vi.fn(),
      clearExtensionUI: vi.fn(), clearExtensionHost: vi.fn(), evictChat: vi.fn(),
      evictVirtualKeys: vi.fn(), clearAgentCallMapping: vi.fn(), disposeChat: vi.fn(),
      invalidateStatus: vi.fn(), browserDestroy: vi.fn(),
    }
    const deps: UseSessionDeps = {
      store: sessionStore,
      api,
      panel: {
        focusedSessionId: vi.fn(() => null),
        activePanelId: vi.fn(() => null),
        findPanelBySession: vi.fn(() => null),
        loadSession: vi.fn(),
        openPanel: vi.fn(),
      },
      navigation: { push: vi.fn() },
      chat,
      hooks,
    }
    const session = scope.run(() => createUseSession(deps))!
    return {
      session,
      chatStore,
      getHistory,
      dispose: () => scope.stop(),
    }
  }

  /**
 * 构造「已加载更早历史」的分区形态（A2 加载更早成功后）：
 * 初始 hydrate 尾窗 2 轮（truncated=true）→ loadMore 前插 1 轮更早 + 窗口状态累计
 * （真实 loadMoreHistory 的写侧 = prependHistory + setHistoryWindow，useChat.ts 游标翻页）。
 */
  function seedPartitionWithEarlierHistory(f: ReturnType<typeof makeFixture>): void {
    const earlier = msg('m-e1', 'pi-e1')
    const w1 = msg('m-w1', 'pi-w1')
    const w2 = msg('m-w2', 'pi-w2')
    f.chatStore.hydrate(SID, [w1, w2], { truncated: true, loadedTurns: 2, totalTurnsEstimate: 5 })
    f.chatStore.prependHistory(SID, [earlier])
    f.chatStore.setHistoryWindow(SID, { truncated: true, loadedTurns: 3, totalTurnsEstimate: 5 })
  }

  describe('refreshHistory（U9/A6 对账编排公开方法）', () => {
    let f: ReturnType<typeof makeFixture>

    beforeEach(() => {
      resetSessionListSubForTest()
      _resetImageCacheForTest()
      f = makeFixture()
    })

    afterEach(() => {
      _resetImageCacheForTest()
      f.dispose()
    })

    it('窗口参数不丢：已加载更早历史在重连对账后保留（走窗口合并切分，非整体替换）', async () => {
      seedPartitionWithEarlierHistory(f)
      // 窗口响应：首条与分区窗口段首条同文件侧身份（pi-w1）→ 切分锚命中，更早历史保留
      f.getHistory.mockResolvedValue({
        messages: [msg('m-w1b', 'pi-w1'), msg('m-w2b', 'pi-w2'), msg('m-w3', 'pi-w3')],
        truncated: true, loadedTurns: 3, totalTurnsEstimate: 6,
      })

      await f.session.refreshHistory(SID)

      const msgs = f.chatStore.getMessages(SID)
      const ids = msgs.map((m) => m.id)
      // 更早历史 m-e1 保留（负面场景①的终端效果：裸 reconcileHistory 无 window 时整体
      // 合并，m-e1 被基线清掉）；窗口段被响应刷新 + 新增 w3。[turn-key 身份保留
      // 2026-10-24（store.ts mergeBaselineWithLive）] 已确认消息跨 reconcile 保留分区已
      // 建立 id（重连对账正是该修复点名场景——turnStableId/展开态跨对账稳定），窗口段
      // 同 piEntryId 命中 → id 取分区版本 m-w1/m-w2 而非响应的 m-w1b/m-w2b。
      expect(ids).toEqual(['m-e1', 'm-w1', 'm-w2', 'm-w3'])
      // 内容权威仍在基线副本：id 保留 ≠ 分区原样保留——窗口段内容已被响应刷新
      // （m-w1 的 content 来自响应副本 m-w1b），证明窗口合并非 no-op
      const w1 = msgs.find((m) => m.id === 'm-w1')!
      expect(w1.content).toBe('msg-m-w1b')
      expect(w1.piEntryId).toBe('pi-w1')
      expect(msgs.find((m) => m.id === 'm-w3')!.content).toBe('msg-m-w3')
    })

    it('截断窗口状态随对账响应刷新（truncated=true 保持「加载更早」入口；loadedTurns/totalTurnsEstimate 归一写入）', async () => {
      seedPartitionWithEarlierHistory(f)
      f.getHistory.mockResolvedValue({
        messages: [msg('m-w1b', 'pi-w1'), msg('m-w2b', 'pi-w2')],
        truncated: true, loadedTurns: 3, totalTurnsEstimate: 7,
      })

      await f.session.refreshHistory(SID)

      // 窗口状态 = 响应窗口（historyWindowFromReply 归一），非对账前残留的 loadMore 累计值
      expect(f.chatStore.getHistoryWindow(SID)).toEqual({ truncated: true, loadedTurns: 3, totalTurnsEstimate: 7 })
    })

    it('全量响应（truncated=false）窗口状态收敛收敛到 false（「加载更早」顶部条结构性消失）', async () => {
      seedPartitionWithEarlierHistory(f)
      f.getHistory.mockResolvedValue({
        messages: [msg('m-all1', 'pi-a1'), msg('m-all2', 'pi-a2')],
        truncated: false, loadedTurns: 4, totalTurnsEstimate: 4,
      })

      await f.session.refreshHistory(SID)

      expect(f.chatStore.getHistoryWindow(SID)).toEqual({ truncated: false, loadedTurns: 4, totalTurnsEstimate: 4 })
    })

    it('未 hydrate 会话 no-op：不拉取、不建分区（重连对账不承担首次回填——首次 hydrate 属切入链步 9）', async () => {
      await f.session.refreshHistory(SID)

      expect(f.getHistory).not.toHaveBeenCalled()
      expect(f.chatStore.isHydrated(SID)).toBe(false)
      expect(f.chatStore.getMessages(SID)).toEqual([])
    })

    it('getHistory 失败静默不抛、分区与窗口状态保持不变（对齐切入链已 hydrate 刷新失败语义：旧数据仍在）', async () => {
      seedPartitionWithEarlierHistory(f)
      const before = f.chatStore.getMessages(SID).map((m) => m.id)
      const windowBefore = f.chatStore.getHistoryWindow(SID)
      f.getHistory.mockRejectedValue(new Error('conn lost'))

      await expect(f.session.refreshHistory(SID)).resolves.toBeUndefined()

      // 不 markHistoryFailed（失败态语义属未 hydrate 通路——landing 重试出口；已 hydrate
      // 分区有旧数据可看，静默保留）
      expect(f.getHistory).toHaveBeenCalledTimes(1)
      expect(f.chatStore.getMessages(SID).map((m) => m.id)).toEqual(before)
      expect(f.chatStore.getHistoryWindow(SID)).toEqual(windowBefore)
    })

    it('图片落盘随行：对账拉回的 toolResult 图经 persistImagesNewestFirst 落盘（负面场景②旁路防御）；重复对账幂等不双写', async () => {
      const calls: Array<{ sessionId: string; order: string[] }> = []
      setImageCacheWritePort(
        vi.fn((sessionId: string, images: ImageCacheWriteImage[]): Promise<ImageCacheWriteResult> => {
          calls.push({ sessionId, order: images.map((i) => i.data) })
          return Promise.resolve({
            results: images.map((i) => ({ status: 'written' as const, path: `/cache/${i.data}.png`, bytes: 10 })),
            quotaFull: false,
          })
        }),
      )
      const withImage = (id: string, piEntryId: string, data: string): Message =>
        ({
          id, role: 'assistant', content: '', status: 'complete', timestamp: 1, piEntryId,
          toolCalls: [{ id: `t-${id}`, toolName: 'shot', input: {}, status: 'completed', startTime: 0, images: [{ data, mimeType: 'image/png' }] }],
        }) as unknown as Message
      f.chatStore.hydrate(SID, [msg('m-w1', 'pi-w1')], { truncated: false, loadedTurns: 1, totalTurnsEstimate: 1 })
      // 消息序（旧→新）old-1 在前、new-2 在后
      f.getHistory.mockResolvedValue({
        messages: [withImage('m-i1', 'pi-i1', 'old-1'), withImage('m-i2', 'pi-i2', 'new-2')],
        truncated: false, loadedTurns: 2, totalTurnsEstimate: 2,
      })

      await f.session.refreshHistory(SID)

      expect(calls).toHaveLength(1)
      expect(calls[0]!.sessionId).toBe(SID)
      // 落盘序契约：消息序反转为新→旧交 port（超帽弃最旧，D6-⑨ 顺序契约）
      expect(calls[0]!.order).toEqual(['new-2', 'old-1'])

      // 重复对账（重连反复触发）幂等：已落盘图按内容 hash 记账剔除，port 不再被调
      await f.session.refreshHistory(SID)
      expect(calls).toHaveLength(1)
    })

    it('切入链与对账共用同一编排入口：已 hydrate 切入的刷新产出与 refreshHistory 等价（窗口参数同随行）', async () => {
      // selectSession 步 9 已 hydrate 分支重构后即 refreshHistory 本体——断言同一入口下
      // 两触发点（切入/对账）在真实 store 上产出等价分区与窗口状态（编排序由既有
      // use-session.test.ts 锁定，本用例锁「共用单一编排定义点」本身）
      const reply = {
        messages: [msg('m-w1b', 'pi-w1'), msg('m-w2b', 'pi-w2'), msg('m-w3', 'pi-w3')],
        truncated: true, loadedTurns: 3, totalTurnsEstimate: 6,
      } satisfies Awaited<ReturnType<UseSessionDeps['chat']['getHistory']>>
      seedPartitionWithEarlierHistory(f)
      f.getHistory.mockResolvedValue(reply)

      await f.session.refreshHistory(SID)
      const afterRefresh = {
        ids: f.chatStore.getMessages(SID).map((m) => m.id),
        window: f.chatStore.getHistoryWindow(SID),
      }

      // 另一实例同初始态走切入链（已 hydrate 分支）——产出应与 refreshHistory 一致
      const f2 = makeFixture()
      seedPartitionWithEarlierHistory(f2)
      f2.getHistory.mockResolvedValue(reply)
      await f2.session.selectSession(SID)
      const afterSelect = {
        ids: f2.chatStore.getMessages(SID).map((m) => m.id),
        window: f2.chatStore.getHistoryWindow(SID),
      }

      expect(afterSelect).toEqual(afterRefresh)
      f2.dispose()
    })
  })
});

// ======== 来源：use-session.test.ts ========
describe("use-session", () => {
  /** 构造 SessionSummary 最小形状（类型收窄后字段由测试按需给全） */
  function summary(id: string, cwd = '/a'): SessionSummary {
    return { id, label: `label-${id}`, cwd, status: 'idle', lastActiveAt: 1 }
  }

  function makeHooks(log: string[]): SessionCleanupHooks & Record<string, ReturnType<typeof vi.fn>> {
    const names = [
      'clearFileTree', 'clearSubagent', 'clearWorkflow',
      'clearExtensionUI', 'clearExtensionHost', 'evictChat', 'evictVirtualKeys',
      'clearAgentCallMapping', 'disposeChat', 'invalidateStatus', 'browserDestroy',
      'clearTerminalQueue', 'clearSlashCommands', 'clearForkNotices',
    ] as const
    const hooks = {} as SessionCleanupHooks & Record<string, ReturnType<typeof vi.fn>>
    for (const n of names) {
      hooks[n] = vi.fn((...args: unknown[]) => log.push(`${n}(${args.join(',')})`))
    }
    return hooks
  }

  interface Fixture { // oe-exempt:20261027:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
    session: ReturnType<typeof createUseSession>
    store: ReturnType<typeof createSessionStore>
    api: {
      list: ReturnType<typeof vi.fn>
      switchSession: ReturnType<typeof vi.fn>
      create: ReturnType<typeof vi.fn>
      rename: ReturnType<typeof vi.fn>
      remove: ReturnType<typeof vi.fn>
      archive: ReturnType<typeof vi.fn>
      removeByCwd: ReturnType<typeof vi.fn>
      migrateImage: ReturnType<typeof vi.fn>
      onConfigSessions: ReturnType<typeof vi.fn>
    }
    panel: {
      focusedSessionId: ReturnType<typeof vi.fn>
      activePanelId: ReturnType<typeof vi.fn>
      findPanelBySession: ReturnType<typeof vi.fn>
      loadSession: ReturnType<typeof vi.fn>
      openPanel: ReturnType<typeof vi.fn>
    }
    navigation: { push: ReturnType<typeof vi.fn> }
    chat: {
      getHistory: ReturnType<typeof vi.fn>
      isHydrated: ReturnType<typeof vi.fn>
      hydrate: ReturnType<typeof vi.fn>
      reconcileHistory: ReturnType<typeof vi.fn>
      clearHistoryError: ReturnType<typeof vi.fn>
      markHistoryFailed: ReturnType<typeof vi.fn>
    }
    flow: { startFlow: ReturnType<typeof vi.fn>; currentSession: ReturnType<typeof vi.fn> }
    hooks: SessionCleanupHooks & Record<string, ReturnType<typeof vi.fn>>
    log: string[]
    dispose: () => void
  }

  function makeFixture(
    opts: {
      withFlow?: boolean
      selectSessionFallback?: (id: string) => Promise<void>
      sessionEntry?: SessionEntryPort
    } = {},
  ): Fixture {
    const scope = effectScope(true)
    const log: string[] = []
    const store = scope.run(() => createSessionStore())!
    const api = {
      list: vi.fn().mockResolvedValue([]),
      switchSession: vi.fn().mockResolvedValue(undefined),
      create: vi.fn(),
      rename: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
      archive: vi.fn().mockResolvedValue(undefined),
      removeByCwd: vi.fn().mockResolvedValue({ cwd: '/a', deleted: [], failed: [] } as BatchDeleteResult),
      migrateImage: vi.fn(),
      onConfigSessions: vi.fn(() => vi.fn()),
    }
    const panel = {
      focusedSessionId: vi.fn(() => null),
      activePanelId: vi.fn(() => 'p1'),
      findPanelBySession: vi.fn(() => null),
      loadSession: vi.fn(),
      openPanel: vi.fn(),
    }
    const navigation = { push: vi.fn() }
    const chat = {
      getHistory: vi.fn().mockResolvedValue({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 }),
      isHydrated: vi.fn(() => false),
      hydrate: vi.fn(),
      reconcileHistory: vi.fn(),
      clearHistoryError: vi.fn(),
      markHistoryFailed: vi.fn(),
    }
    const flow = { startFlow: vi.fn().mockResolvedValue(undefined), currentSession: vi.fn(() => null) }
    const hooks = makeHooks(log)
    const deps: UseSessionDeps = {
      store, api, panel, navigation, chat, hooks,
      ...(opts.withFlow ? { flow } : {}),
      ...(opts.selectSessionFallback ? { selectSessionFallback: opts.selectSessionFallback } : {}),
      ...(opts.sessionEntry ? { sessionEntry: opts.sessionEntry } : {}),
    }
    const session = scope.run(() => createUseSession(deps))!
    return { session, store, api, panel, navigation, chat, flow, hooks, log, dispose: () => scope.stop() }
  }

  /** 组装分组（applySnapshot 整表形态后 store.list 派生） */
  function seed(store: Fixture['store'], groups: SessionGroup[]): void {
    store.applySnapshot({ groups })
  }

  describe('selectSession', () => {
    it('TC-1 成功：switchSession→activeId→panel 载入→push→hydrate（D4 panel-first；13 步全序断言见下方切入链 describe）', async () => {
      const f = makeFixture()
      const msgs = [{ id: 'm1' } as never]
      f.chat.getHistory.mockResolvedValue({ messages: msgs, truncated: true, loadedTurns: 3, totalTurnsEstimate: 3 })
      await f.session.selectSession('sid-1')

      expect(f.api.switchSession).toHaveBeenCalledTimes(1)
      expect(f.api.switchSession).toHaveBeenCalledWith('sid-1')
      expect(f.store.activeId.value).toBe('sid-1')
      // hydrate 链路（后台 session reconcile：未 hydrate 分支走 reconcileHistory，等价 hydrate）
      expect(f.chat.isHydrated).toHaveBeenCalledWith('sid-1')
      expect(f.chat.getHistory).toHaveBeenCalledTimes(1)
      // [u4d] 窗口状态随 reconcile 写入（[u6] 契约三字段必填）
      expect(f.chat.reconcileHistory).toHaveBeenCalledWith('sid-1', msgs, { truncated: true, loadedTurns: 3, totalTurnsEstimate: 3 })
      expect(f.chat.clearHistoryError).toHaveBeenCalledWith('sid-1')
      // panel 载入（经 activePanelId 端口）
      expect(f.panel.activePanelId).toHaveBeenCalled()
      expect(f.panel.loadSession).toHaveBeenCalledWith('p1', 'sid-1')
      // 导航
      expect(f.navigation.push).toHaveBeenCalledWith({ view: 'chat', sessionId: 'sid-1' })
      f.dispose()
    })

    it('TC-2 失败：switchSession reject → activeId 不更新 + 异常上抛 + 显示编排短路（并行 getHistory 数据仍落库，session-cold-switch-perf §3.3-4）', async () => {
      const f = makeFixture()
      f.api.switchSession.mockRejectedValue(new Error('not found'))
      seed(f.store, [{ cwd: '/a', sessions: [summary('other')] }])
      f.store.activeId.value = 'other'

      await expect(f.session.selectSession('ghost')).rejects.toThrow('not found')
      expect(f.store.activeId.value).toBe('other')
      // [session-cold-switch-perf §3.3-4] 并行发出的 getHistory reply 处理独立于链短路：
      // switch 失败短路后续步骤（panel/navigation 不动），但已发出的 history 请求结果仍
      // 正常落库（pi 不可用时查看数据仍可得——场景 6 数据层断言的载体；显示层无载体
      // panel 不挂载 = 现状失败语义）
      expect(f.chat.reconcileHistory).toHaveBeenCalledTimes(1)
      expect(f.panel.loadSession).not.toHaveBeenCalled()
      expect(f.navigation.push).not.toHaveBeenCalled()
      f.dispose()
    })

    it('TC-3 hydrate 失败：getHistory reject → markHistoryFailed + 不抛 + activeId 已更新', async () => {
      const f = makeFixture()
      f.chat.getHistory.mockRejectedValue(new Error('io'))
      await expect(f.session.selectSession('sid-1')).resolves.toBeUndefined()
      expect(f.chat.markHistoryFailed).toHaveBeenCalledWith('sid-1')
      expect(f.store.activeId.value).toBe('sid-1')
      expect(f.panel.loadSession).toHaveBeenCalledWith('p1', 'sid-1')
      expect(f.navigation.push).toHaveBeenCalledWith({ view: 'chat', sessionId: 'sid-1' })
      f.dispose()
    })

    it('已 hydrate 的 session 切入时静默刷新（后台 session reconcile，2026-08-22）', async () => {
      const f = makeFixture()
      const msgs = [{ id: 'm2' } as never]
      f.chat.isHydrated.mockReturnValue(true)
      f.chat.getHistory.mockResolvedValue({ messages: msgs, truncated: false, loadedTurns: 1, totalTurnsEstimate: 1 })
      await f.session.selectSession('sid-1')
      // 旧幂等检查已废：后台（agent-managed）session 的 turn 可能在前端不在场时完成，
      // 切入必须刷新到最新 entries；失败静默（旧数据仍在，下次切入重试）
      expect(f.chat.getHistory).toHaveBeenCalledTimes(1)
      expect(f.chat.reconcileHistory).toHaveBeenCalledWith('sid-1', msgs, { truncated: false, loadedTurns: 1, totalTurnsEstimate: 1 })
      expect(f.chat.markHistoryFailed).not.toHaveBeenCalled()
      expect(f.store.activeId.value).toBe('sid-1')
      f.dispose()
    })

    it('已 hydrate 切入的窗口 reconcile 同步刷新 truncated 窗口状态（load-more 可恢复）', async () => {
      const f = makeFixture()
      f.chat.isHydrated.mockReturnValue(true)
      // 场景：hydrate（窗口 truncated=true）→ load-more 游标翻页 → 切走切回，
      // getHistory 又返回预算窗口（u4b）——[u6] reconcile 合并语义：窗口响应仅合并覆盖
      // 最近窗口，已加载更早历史保留；窗口状态同步刷新 truncated=true，顶部条重显。
      f.chat.getHistory.mockResolvedValue({ messages: [{ id: 'm2' } as never], truncated: true, loadedTurns: 2, totalTurnsEstimate: 2 })
      await f.session.selectSession('sid-1')
      expect(f.chat.reconcileHistory).toHaveBeenCalledWith('sid-1', [{ id: 'm2' }], { truncated: true, loadedTurns: 2, totalTurnsEstimate: 2 })
      f.dispose()
    })

    it('已 hydrate 切入的未截断响应（truncated=false）窗口状态同步收敛', async () => {
      const f = makeFixture()
      f.chat.isHydrated.mockReturnValue(true)
      f.chat.getHistory.mockResolvedValue({ messages: [{ id: 'm2' } as never], truncated: false, loadedTurns: 1, totalTurnsEstimate: 1 })
      await f.session.selectSession('sid-1')
      // 分区已被 reconcile 替换为响应内容（全量响应）→ 无更早历史可加载，窗口状态同步收敛
      expect(f.chat.reconcileHistory).toHaveBeenCalledWith('sid-1', [{ id: 'm2' }], { truncated: false, loadedTurns: 1, totalTurnsEstimate: 1 })
      f.dispose()
    })
  })

  describe('selectSession 13 步切入链（D3 端口束 / D4 壳版时序）', () => {
    /**
   * 记录型 sessionEntry fake（D3 接口级断言）：每端口一个 push 到数组的 spy。
   * touchRecency 被链内两步消费（步 6 切入 session / 步 11 panel 绑定 session），
   * 用调用序号 #1/#2 区分——同名端口两次调用的相对位置即统一链时序断言目标。
   */
    function makeEntrySpies(order: string[]) {
      let touchCount = 0
      return {
        cancelActiveFlow: vi.fn(() => { order.push('1.cancelActiveFlow') }),
        clearUnread: vi.fn((sid: string) => { order.push(`4.clearUnread(${sid})`) }),
        ensureStreamSubscription: vi.fn((sid: string) => { order.push(`5.ensureStreamSubscription(${sid})`) }),
        touchRecency: vi.fn((sid: string) => { order.push(`6/11.touchRecency#${++touchCount}(${sid})`) }),
        preloadFileTree: vi.fn((sid: string) => { order.push(`10.preloadFileTree(${sid})`) }),
        evictLru: vi.fn((sid: string | null) => { order.push(`12.evictLru(${sid ?? 'null'})`) }),
      }
    }

    it('13 步精确顺序（session-cold-switch-perf §3.3-4 并行切口后）：cancelActiveFlow→switch→hydrate落库→setActiveId→clearUnread→ensureStream→touch→sync→push→preload→touch(panel)→evict（步 13 异步不阻塞链）', async () => {
      const order: string[] = []
      const entry = makeEntrySpies(order)
      const f = makeFixture({ sessionEntry: entry })
      // 非 sessionEntry 步骤（api/store/panel/navigation/chat 端口）记录到同一数组，
      // 步骤号对齐统一链注释（use-session.selectSession 的 1-13 步；步 13 refreshLiveState
      // 为 fire-and-forget 不进 order 数组，独立用例见上方 refreshLiveState describe）
      f.api.switchSession.mockImplementation(async (id: string) => { order.push(`2.switchSession(${id})`) })
      const origSetActiveId = f.store.setActiveId.bind(f.store)
      f.store.setActiveId = (id: string | null) => { order.push(`3.setActiveId(${id})`); origSetActiveId(id) }
      f.panel.loadSession.mockImplementation((pid: string, sid: string | null) => {
        order.push(`7.syncSessionToPanel(${pid}<-${sid})`)
      })
      f.navigation.push.mockImplementation((route: { view: string }) => {
        order.push(`8.navigation.push(${route.view})`)
      })
      f.chat.reconcileHistory.mockImplementation((sid: string) => { order.push(`9.hydrateReconcile(${sid})`) })
      // panel 绑定 session 经 PanelOrchestrationPort.focusedSessionId 读取
      // （壳版 panel.currentLeaf.sessionId 与之同源——panel store layout.sessionId）
      f.panel.focusedSessionId.mockReturnValue('sid-1')

      await f.session.selectSession('sid-1')

      // [session-cold-switch-perf §3.3-4] 步 9 提前与步 2 并行发出：mock 端口均立即
      // resolve，getHistory 的落库回调（先注册的 microtask）在 switch await 恢复之前
      // 执行——9 位居 2 与 3 之间是并行切口的确定性时序；4-12 相对顺序与旧链一致
      //（步 9 await 同一 promise，链内后续步骤时序不变；步 13 refreshLiveState 为
      // fire-and-forget void 调用，不进 order 数组、不阻塞链尾）。
      expect(order).toEqual([
        '1.cancelActiveFlow',
        '2.switchSession(sid-1)',
        '9.hydrateReconcile(sid-1)',
        '3.setActiveId(sid-1)',
        '4.clearUnread(sid-1)',
        '5.ensureStreamSubscription(sid-1)',
        '6/11.touchRecency#1(sid-1)',
        '7.syncSessionToPanel(p1<-sid-1)',
        '8.navigation.push(chat)',
        '10.preloadFileTree(sid-1)',
        '6/11.touchRecency#2(sid-1)',
        '12.evictLru(sid-1)',
      ])
      expect(f.panel.focusedSessionId).toHaveBeenCalled()
      // touchRecency 双跳：切入 session（步 6）+ panel 绑定 session（步 11，exempt 前半）
      expect(entry.touchRecency).toHaveBeenCalledTimes(2)
      f.dispose()
    })

    it('panel 无绑定 session（focusedSessionId=null）：步 11 跳过，evictLru(null) 照常执行', async () => {
      const order: string[] = []
      const entry = makeEntrySpies(order)
      const f = makeFixture({ sessionEntry: entry })
      f.panel.focusedSessionId.mockReturnValue(null)

      await f.session.selectSession('sid-1')

      // 仅步 6 一次 touchRecency；步 11 的条件刷新跳过（对齐壳版 if (panel.currentLeaf.sessionId)）
      expect(entry.touchRecency).toHaveBeenCalledTimes(1)
      expect(entry.touchRecency).toHaveBeenCalledWith('sid-1')
      expect(entry.evictLru).toHaveBeenCalledTimes(1)
      expect(entry.evictLru).toHaveBeenCalledWith(null)
      f.dispose()
    })

    it('sessionEntry 全缺省：链完整执行不崩（no-op 步骤占位），主步骤照常', async () => {
      const f = makeFixture()
      await expect(f.session.selectSession('sid-1')).resolves.toBeUndefined()
      expect(f.api.switchSession).toHaveBeenCalledWith('sid-1')
      expect(f.store.activeId.value).toBe('sid-1')
      expect(f.chat.reconcileHistory).toHaveBeenCalledWith('sid-1', [], { truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 })
      expect(f.panel.loadSession).toHaveBeenCalledWith('p1', 'sid-1')
      expect(f.navigation.push).toHaveBeenCalledWith({ view: 'chat', sessionId: 'sid-1' })
      f.dispose()
    })

    it('成员级部分注入（仅 clearUnread）：其余成员缺省 no-op 不崩，链完整', async () => {
      const clearUnread = vi.fn()
      const f = makeFixture({ sessionEntry: { clearUnread } })
      await expect(f.session.selectSession('sid-1')).resolves.toBeUndefined()
      expect(clearUnread).toHaveBeenCalledWith('sid-1')
      expect(f.store.activeId.value).toBe('sid-1')
      expect(f.panel.loadSession).toHaveBeenCalledWith('p1', 'sid-1')
      expect(f.navigation.push).toHaveBeenCalledWith({ view: 'chat', sessionId: 'sid-1' })
      f.dispose()
    })

    it('switchSession reject：步 1 已执行、步 4 起全部短路 + 抛错上抛（失败语义不变）', async () => {
      const entry = makeEntrySpies([])
      const f = makeFixture({ sessionEntry: entry })
      f.api.switchSession.mockRejectedValue(new Error('not found'))

      await expect(f.session.selectSession('ghost')).rejects.toThrow('not found')
      // 步 1 在 switch 之前（对齐壳版 cancelFlow 先于 switchSession）
      expect(entry.cancelActiveFlow).toHaveBeenCalledTimes(1)
      expect(entry.clearUnread).not.toHaveBeenCalled()
      expect(entry.ensureStreamSubscription).not.toHaveBeenCalled()
      expect(entry.touchRecency).not.toHaveBeenCalled()
      expect(entry.preloadFileTree).not.toHaveBeenCalled()
      expect(entry.evictLru).not.toHaveBeenCalled()
      expect(f.panel.loadSession).not.toHaveBeenCalled()
      expect(f.navigation.push).not.toHaveBeenCalled()
      expect(f.store.activeId.value).toBeNull()
      f.dispose()
    })

    it('hydrate 失败（未 hydrate 分支）：markHistoryFailed 不抛穿，尾部步骤 10-12 照常执行', async () => {
      const entry = makeEntrySpies([])
      const f = makeFixture({ sessionEntry: entry })
      f.chat.getHistory.mockRejectedValue(new Error('io'))

      await expect(f.session.selectSession('sid-1')).resolves.toBeUndefined()
      expect(f.chat.markHistoryFailed).toHaveBeenCalledWith('sid-1')
      // D4 后 hydrate 在 panel 载入之后：panel 已挂载（先亮），历史失败不阻断文件树/驱逐
      expect(f.panel.loadSession).toHaveBeenCalledWith('p1', 'sid-1')
      expect(entry.preloadFileTree).toHaveBeenCalledWith('sid-1')
      expect(entry.evictLru).toHaveBeenCalledTimes(1)
      f.dispose()
    })
  })

  describe('deleteSession', () => {
    beforeEach(() => {
      resetSessionListSubForTest()
    })

    it('TC-4 S3 全 hooks 调用序：panel 解绑→removeFromList→11 必选 + G1 可选 3 hooks→triggerSessionCleanups', async () => {
      const f = makeFixture()
      seed(f.store, [{ cwd: '/a', sessions: [summary('del')] }])
      f.store.activeId.value = 'del'
      f.panel.findPanelBySession.mockReturnValue({ id: 'p1', sessionId: 'del' })

      await f.session.deleteSession('del')

      // panel 解绑（[U7] overlay 兜底清理已随 overlay 移除）
      expect(f.panel.loadSession).toHaveBeenCalledWith('p1', null)
      // removeFromList 生效（列表空）
      expect(f.store.list.value).toHaveLength(0)
      // 删 active 后列表空 → push chat 空态
      expect(f.navigation.push).toHaveBeenCalledWith({ view: 'chat' })
      // S3 全序（log 数组精确顺序断言）；末位 browserDestroy = B4 main 侧 WebContentsView 销毁接线，
      // 尾部 G1 三钩子 = 死清理 API 接线组（terminal 写队列 / slash 命令 / fork 通知 feed 分区）
      const expectedOrder = [
        'clearFileTree(del)', 'clearSubagent(del)', 'clearWorkflow(del)',
        'clearExtensionUI(del)', 'clearExtensionHost(del)', 'evictChat(del)',
        'evictVirtualKeys(del)', 'clearAgentCallMapping(del)', 'disposeChat(del)', 'invalidateStatus(del)',
        'browserDestroy(del)',
        'clearTerminalQueue(del)', 'clearSlashCommands(del)', 'clearForkNotices(del)',
      ]
      expect(f.log).toEqual(expectedOrder)
      // M1-03：extension-host 分区清理钩子被调用（壳层实现 emit session-destroyed）
      expect(f.hooks.clearExtensionHost).toHaveBeenCalledWith('del')
      f.dispose()
    })

    it('TC-4b G1 可选 hook 缺省容忍：不注入 clearTerminalQueue/clearSlashCommands/clearForkNotices 时删除链不炸', async () => {
      // [G1 / 2026-09-14 内存审计 §3.4] 三 hook 为可选成员（旧实现零破坏）——编排点 ?.
      // 调用，未注入即跳过（headless 形态 / 渐进接线期）。到类型层：仅必选 11 项即满足接口。
      const f = makeFixture()
      delete (f.hooks as Record<string, unknown>).clearTerminalQueue
      delete (f.hooks as Record<string, unknown>).clearSlashCommands
      delete (f.hooks as Record<string, unknown>).clearForkNotices
      seed(f.store, [{ cwd: '/a', sessions: [summary('del')] }])
      f.store.activeId.value = 'del'

      await expect(f.session.deleteSession('del')).resolves.toBeUndefined()

      // 删除链照常完成（removeFromList + 必选钩子不受可选缺省影响）
      expect(f.store.list.value).toHaveLength(0)
      expect(f.hooks.browserDestroy).toHaveBeenCalledWith('del')
      expect(f.log).not.toContain('clearTerminalQueue(del)')
      f.dispose()
    })

    it('TC-5 ES1 fallback：删 active 后 selectSession(next) reject → push({view:chat})，不抛', async () => {
      const f = makeFixture()
      seed(f.store, [{ cwd: '/a', sessions: [summary('a'), summary('b')] }])
      f.store.activeId.value = 'a'
      // 回退 selectSession('b') 的 switchSession 失败（网络抖动）
      f.api.switchSession.mockRejectedValue(new Error('net'))

      await expect(f.session.deleteSession('a')).resolves.toBeUndefined()
      // cleanup 后 activeId 回退到 list[0]（removeFromList 语义）
      expect(f.store.activeId.value).toBe('b')
      // selectSession('b') 失败 → ES1 fallback push chat 空态
      expect(f.api.switchSession).toHaveBeenCalledWith('b')
      expect(f.navigation.push).toHaveBeenCalledWith({ view: 'chat' })
      f.dispose()
    })

    it('TC-6 非 active 删除：无回退（selectSession 未调）+ 仍走 cleanup', async () => {
      const f = makeFixture()
      seed(f.store, [{ cwd: '/a', sessions: [summary('a'), summary('b')] }])
      f.store.activeId.value = 'a'

      await f.session.deleteSession('b')
      expect(f.store.activeId.value).toBe('a')
      expect(f.api.switchSession).not.toHaveBeenCalled()
      expect(f.navigation.push).not.toHaveBeenCalled()
      expect(f.hooks.clearFileTree).toHaveBeenCalledWith('b')
      expect(f.hooks.disposeChat).toHaveBeenCalledWith('b')
      // B4：非 active 删除同样触发 browserDestroy（与 store 分区清理同生命周期）
      expect(f.hooks.browserDestroy).toHaveBeenCalledWith('b')
      // G1：非 active 删除同样触发三可选钩子（terminal/slash/fork 分区同生命周期释放）
      expect(f.hooks.clearTerminalQueue).toHaveBeenCalledWith('b')
      expect(f.hooks.clearSlashCommands).toHaveBeenCalledWith('b')
      expect(f.hooks.clearForkNotices).toHaveBeenCalledWith('b')
      f.dispose()
    })

    it('selectSessionFallback 注入：wasActive 回退走壳版端口（core headless selectSession 不触达）', async () => {
      // C-W5-1 债务清偿：壳（useSidebar）注入含 ensureStreamSubscription 时序的 selectSession，
      // 删 active 回退不再走 core headless 路径（否则回退后流式订阅缺失，handoff 回复丢失事故同源）
      const fallback = vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined)
      const f = makeFixture({ selectSessionFallback: fallback })
      seed(f.store, [{ cwd: '/a', sessions: [summary('a'), summary('b')] }])
      f.store.activeId.value = 'a'

      await f.session.deleteSession('a')
      expect(fallback).toHaveBeenCalledTimes(1)
      expect(fallback).toHaveBeenCalledWith('b')
      expect(f.api.switchSession).not.toHaveBeenCalled()
      // 成功回退无空态出口
      expect(f.navigation.push).not.toHaveBeenCalled()
      f.dispose()
    })

    it('[D7] 空态承接：flow 接线时删空 → push chat + startFlow（landing 需 flow 活跃）', async () => {
      const f = makeFixture({ withFlow: true })
      seed(f.store, [{ cwd: '/a', sessions: [summary('del')] }])
      f.store.activeId.value = 'del'

      await f.session.deleteSession('del')
      expect(f.navigation.push).toHaveBeenCalledWith({ view: 'chat' })
      expect(f.flow.startFlow).toHaveBeenCalledTimes(1)
      f.dispose()
    })

    it('[D7] S4 兜底：回退失败 + flow 接线 → push chat + startFlow，不抛', async () => {
      const f = makeFixture({ withFlow: true })
      seed(f.store, [{ cwd: '/a', sessions: [summary('a'), summary('b')] }])
      f.store.activeId.value = 'a'
      f.api.switchSession.mockRejectedValue(new Error('net'))

      await expect(f.session.deleteSession('a')).resolves.toBeUndefined()
      expect(f.navigation.push).toHaveBeenCalledWith({ view: 'chat' })
      expect(f.flow.startFlow).toHaveBeenCalledTimes(1)
      f.dispose()
    })
  })

  describe('archiveSession（session-archive D14：发起侧编排与 delete 同款）', () => {
    beforeEach(() => {
      resetSessionListSubForTest()
    })

    it('AC-1 归档回调清理：api.archive → S3 全 hooks 调用序 → removeFromList（cleanupSessionState 同族）', async () => {
      const f = makeFixture()
      seed(f.store, [{ cwd: '/a', sessions: [summary('arc'), summary('b')] }])
      f.store.activeId.value = 'b'
      f.panel.findPanelBySession.mockReturnValue({ id: 'p1', sessionId: 'arc' })

      await f.session.archiveSession('arc')

      expect(f.api.archive).toHaveBeenCalledTimes(1)
      expect(f.api.archive).toHaveBeenCalledWith('arc')
      // panel 解绑（归档 session 绑定 panel 时清空绑定）
      expect(f.panel.loadSession).toHaveBeenCalledWith('p1', null)
      // removeFromList 生效（剩 b）
      expect(f.store.list.value.map((s) => s.id)).toEqual(['b'])
      // S3 全序与 deleteSession TC-4 同款（清理链完全同族，D14）
      const expectedOrder = [
        'clearFileTree(arc)', 'clearSubagent(arc)', 'clearWorkflow(arc)',
        'clearExtensionUI(arc)', 'clearExtensionHost(arc)', 'evictChat(arc)',
        'evictVirtualKeys(arc)', 'clearAgentCallMapping(arc)', 'disposeChat(arc)', 'invalidateStatus(arc)',
        'browserDestroy(arc)',
        'clearTerminalQueue(arc)', 'clearSlashCommands(arc)', 'clearForkNotices(arc)',
      ]
      expect(f.log).toEqual(expectedOrder)
      // 非 active 归档：无回退
      expect(f.api.switchSession).not.toHaveBeenCalled()
      expect(f.navigation.push).not.toHaveBeenCalled()
      f.dispose()
    })

    it('AC-2 wasActive 回退：归档的恰是当前查看的 session → 切回 list[0]', async () => {
      const f = makeFixture()
      seed(f.store, [{ cwd: '/a', sessions: [summary('a'), summary('b')] }])
      f.store.activeId.value = 'a'

      await f.session.archiveSession('a')

      // cleanup 后 activeId 回退到 list[0]（removeFromList 语义）
      expect(f.store.activeId.value).toBe('b')
      // 回退走完整切入（switchSession('b') 被调）
      expect(f.api.switchSession).toHaveBeenCalledWith('b')
      f.dispose()
    })

    it('AC-3 wasActive + 列表空 → [D7] 空态承接（push chat + startFlow）', async () => {
      const f = makeFixture({ withFlow: true })
      seed(f.store, [{ cwd: '/a', sessions: [summary('only')] }])
      f.store.activeId.value = 'only'

      await f.session.archiveSession('only')

      expect(f.navigation.push).toHaveBeenCalledWith({ view: 'chat' })
      expect(f.flow.startFlow).toHaveBeenCalledTimes(1)
      f.dispose()
    })

    it('AC-4 wasActive 回退失败（网络抖动）→ ES1 空态承接，不抛（S4 同款）', async () => {
      const f = makeFixture()
      seed(f.store, [{ cwd: '/a', sessions: [summary('a'), summary('b')] }])
      f.store.activeId.value = 'a'
      f.api.switchSession.mockRejectedValue(new Error('net'))

      await expect(f.session.archiveSession('a')).resolves.toBeUndefined()
      expect(f.navigation.push).toHaveBeenCalledWith({ view: 'chat' })
      f.dispose()
    })

    it('AC-5 api.archive 失败（error envelope reject）→ 抛出且零本地清理（RPC 先行，失败不误清）', async () => {
      const f = makeFixture()
      seed(f.store, [{ cwd: '/a', sessions: [summary('arc')] }])
      f.store.activeId.value = 'arc'
      f.api.archive.mockRejectedValue(new Error('会话正在生成中 (archive_generating)'))

      await expect(f.session.archiveSession('arc')).rejects.toThrow('archive_generating')
      // 失败路径零清理：列表保留、hooks 未触达、activeId 未动
      expect(f.store.list.value.map((s) => s.id)).toEqual(['arc'])
      expect(f.log).toEqual([])
      expect(f.store.activeId.value).toBe('arc')
      f.dispose()
    })
  })

  describe('deleteFolder', () => {
    it('TC-7 wasActiveInFolder 回退：逐个 cleanup + selectSession(list[0]) + 返回值透传', async () => {
      const f = makeFixture()
      seed(f.store, [
        { cwd: '/a', sessions: [summary('a1'), summary('a2')] },
        { cwd: '/b', sessions: [summary('b1', '/b')] },
      ])
      f.store.activeId.value = 'a1'
      const res: BatchDeleteResult = { cwd: '/a', deleted: ['a1', 'a2'], failed: [] }
      f.api.removeByCwd.mockResolvedValue(res)

      const returned = await f.session.deleteFolder('/a')
      expect(returned).toBe(res)
      // 逐个 cleanup（a1、a2 各一轮）
      expect(f.hooks.clearFileTree).toHaveBeenCalledTimes(2)
      expect(f.hooks.clearFileTree).toHaveBeenCalledWith('a1')
      expect(f.hooks.clearFileTree).toHaveBeenCalledWith('a2')
      expect(f.hooks.disposeChat).toHaveBeenCalledTimes(2)
      // B4：folder 批量删除逐 session 触发 browserDestroy（cleanupSessionState 复用路径）
      expect(f.hooks.browserDestroy).toHaveBeenCalledTimes(2)
      expect(f.hooks.browserDestroy).toHaveBeenCalledWith('a1')
      expect(f.hooks.browserDestroy).toHaveBeenCalledWith('a2')
      // G1：folder 批量删除逐 session 触发三可选钩子（同 cleanupSessionState 复用路径）
      expect(f.hooks.clearTerminalQueue).toHaveBeenCalledTimes(2)
      expect(f.hooks.clearSlashCommands).toHaveBeenCalledWith('a1')
      expect(f.hooks.clearForkNotices).toHaveBeenCalledWith('a2')
      // activeId 回退到列表首项 'b1'，selectSession 衔接
      expect(f.store.activeId.value).toBe('b1')
      expect(f.api.switchSession).toHaveBeenCalledWith('b1')
      f.dispose()
    })

    it('active 不在 folder：无回退，仅 cleanup', async () => {
      const f = makeFixture()
      seed(f.store, [
        { cwd: '/a', sessions: [summary('a1')] },
        { cwd: '/b', sessions: [summary('b1', '/b')] },
      ])
      f.store.activeId.value = 'b1'
      f.api.removeByCwd.mockResolvedValue({ cwd: '/a', deleted: ['a1'], failed: [] })

      await f.session.deleteFolder('/a')
      expect(f.store.activeId.value).toBe('b1')
      expect(f.api.switchSession).not.toHaveBeenCalled()
      expect(f.navigation.push).not.toHaveBeenCalled()
      expect(f.hooks.clearFileTree).toHaveBeenCalledWith('a1')
      f.dispose()
    })

    it('selectSessionFallback 注入：wasActiveInFolder 回退走壳版端口', async () => {
      const fallback = vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined)
      const f = makeFixture({ selectSessionFallback: fallback })
      seed(f.store, [
        { cwd: '/a', sessions: [summary('a1'), summary('a2')] },
        { cwd: '/b', sessions: [summary('b1', '/b')] },
      ])
      f.store.activeId.value = 'a1'
      f.api.removeByCwd.mockResolvedValue({ cwd: '/a', deleted: ['a1', 'a2'], failed: [] })

      const returned = await f.session.deleteFolder('/a')
      expect(returned.deleted).toEqual(['a1', 'a2'])
      // 回退 list[0]='b1' 走壳版端口，core headless 不触达
      expect(fallback).toHaveBeenCalledTimes(1)
      expect(fallback).toHaveBeenCalledWith('b1')
      expect(f.api.switchSession).not.toHaveBeenCalled()
      f.dispose()
    })
  })

  describe('loadSessions / retryHistory / renameSession / syncSessionToPanel', () => {
    it('TC-8 loadSessions 成功：applySnapshot 整表 + setListLoadError(null)', async () => {
      const f = makeFixture()
      const groups = [{ cwd: '/a', sessions: [summary('s1')] }]
      f.api.list.mockResolvedValue(groups)
      f.store.setListLoadError('stale')
      await f.session.loadSessions()
      expect(f.store.groups.value).toEqual(groups)
      expect(f.store.listLoadError.value).toBeNull()
      f.dispose()
    })

    it('TC-9 loadSessions 失败（ES2/S5）：setListLoadError(msg) + 不抛', async () => {
      const f = makeFixture()
      f.api.list.mockRejectedValue(new Error('conn lost'))
      seed(f.store, [{ cwd: '/a', sessions: [summary('s1')] }])
      await expect(f.session.loadSessions()).resolves.toBeUndefined()
      expect(f.store.listLoadError.value).toBe('conn lost')
      expect(f.store.list.value).toHaveLength(1)
      f.dispose()
    })

    it('TC-11 retryHistory 成功：clearHistoryError→getHistory→reconcile+窗口状态', async () => {
      const f = makeFixture()
      const msgs = [{ id: 'm1' } as never]
      f.chat.getHistory.mockResolvedValue({ messages: msgs, truncated: false, loadedTurns: 1, totalTurnsEstimate: 1 })
      await f.session.retryHistory('s1')
      expect(f.chat.clearHistoryError).toHaveBeenCalledWith('s1')
      expect(f.chat.getHistory).toHaveBeenCalledWith('s1')
      expect(f.chat.reconcileHistory).toHaveBeenCalledWith('s1', msgs, { truncated: false, loadedTurns: 1, totalTurnsEstimate: 1 })
      expect(f.chat.markHistoryFailed).not.toHaveBeenCalled()
      f.dispose()
    })

    it('TC-11 retryHistory 失败：markHistoryFailed + 不抛', async () => {
      const f = makeFixture()
      f.chat.getHistory.mockRejectedValue(new Error('io'))
      await expect(f.session.retryHistory('s1')).resolves.toBeUndefined()
      expect(f.chat.markHistoryFailed).toHaveBeenCalledWith('s1')
      f.dispose()
    })

    it('TC-13 renameSession：api.rename + 乐观更新 applySnapshot(label)', async () => {
      const f = makeFixture()
      seed(f.store, [{ cwd: '/a', sessions: [summary('s1')] }])
      await f.session.renameSession('s1', '新名字')
      expect(f.api.rename).toHaveBeenCalledWith('s1', '新名字')
      expect(f.store.list.value[0]!.label).toBe('新名字')
      f.dispose()
    })

    it('TC-13 syncSessionToPanel：loadSession(activePanelId, sessionId)', () => {
      const f = makeFixture()
      f.panel.activePanelId.mockReturnValue('p9')
      f.session.syncSessionToPanel('s1')
      expect(f.panel.loadSession).toHaveBeenCalledWith('p9', 's1')
      f.dispose()
    })
  })

  describe('newSession（延迟 create 语义）', () => {
    it('TC-12 currentSession null → push chat + 返回 null（延迟 create 路径）', async () => {
      const f = makeFixture({ withFlow: true })
      const result = await f.session.newSession()
      expect(result).toBeNull()
      expect(f.flow.startFlow).toHaveBeenCalledTimes(1)
      expect(f.navigation.push).toHaveBeenCalledWith({ view: 'chat' })
      expect(f.api.switchSession).not.toHaveBeenCalled()
      f.dispose()
    })

    it('TC-12 延迟 create 终态锁：flow 内部残留 session 也不被消费——恒返回 null + push chat 空态 + 不 switchSession', async () => {
      const f = makeFixture({ withFlow: true })
      // 对抗输入：旧世界「flow 产出 session → selectSession」链已退役（C-W3-2 延迟 create
      // 终态，startFlow 末尾恒 bindCurrentSession(null)，session 由首发提交创建绑定）。
      // 即便 flow.currentSession 残留非空（生产不可能态），编排也不得消费它走旧链。
      f.flow.currentSession.mockReturnValue(summary('new1'))
      const result = await f.session.newSession('/b')
      expect(result).toBeNull()
      expect(f.flow.startFlow).toHaveBeenCalledWith('/b')
      expect(f.api.switchSession).not.toHaveBeenCalled()
      expect(f.store.activeId.value).not.toBe('new1')
      expect(f.navigation.push).toHaveBeenCalledWith({ view: 'chat' })
      f.dispose()
    })

    it('TC-12 in-flight 检查：未 resolve 时二次调用直接返回 null', async () => {
      const f = makeFixture({ withFlow: true })
      let release!: () => void
      f.flow.startFlow.mockImplementation(() => new Promise<void>((r) => { release = r }))
      const first = f.session.newSession()
      const second = await f.session.newSession()
      expect(second).toBeNull()
      expect(f.flow.startFlow).toHaveBeenCalledTimes(1)
      release()
      await first
      f.dispose()
    })

    it('flow 未接线（deps.flow 缺省）：返回 null 降级', async () => {
      const f = makeFixture()
      const result = await f.session.newSession()
      expect(result).toBeNull()
      expect(f.navigation.push).not.toHaveBeenCalled()
      f.dispose()
    })
  })

  describe('bindSessionListBroadcast refCount', () => {
    beforeEach(() => {
      resetSessionListSubForTest()
    })

    it('TC-10 多实例只订阅一次；全销毁后 unsub 一次；handler emit 触发 applySnapshot 整表', async () => {
      const unsub = vi.fn()
      let capturedHandler: ((groups: SessionGroup[]) => void) | null = null
      const scopeA = effectScope(true)
      const scopeB = effectScope(true)
      const storeA = scopeA.run(() => createSessionStore())!
      const storeB = scopeB.run(() => createSessionStore())!
      const apiA = {
        list: vi.fn().mockResolvedValue([]),
        switchSession: vi.fn().mockResolvedValue(undefined),
        create: vi.fn(), rename: vi.fn(), remove: vi.fn(), archive: vi.fn(),
        removeByCwd: vi.fn(), migrateImage: vi.fn(),
        onConfigSessions: vi.fn((h: (g: SessionGroup[]) => void) => {
          capturedHandler = h
          return unsub
        }),
      }
      const baseDepsA = { store: storeA, api: apiA, panel: makePanel(), navigation: { push: vi.fn() }, chat: makeChat(), hooks: makeHooks([]) }
      const baseDepsB = { store: storeB, api: apiA, panel: makePanel(), navigation: { push: vi.fn() }, chat: makeChat(), hooks: makeHooks([]) }

      scopeA.run(() => createUseSession(baseDepsA))
      // 实例 B 共用同一 api（订阅只发生一次）
      scopeB.run(() => createUseSession(baseDepsB))
      expect(apiA.onConfigSessions).toHaveBeenCalledTimes(1)

      // handler 主动 emit 分组 → 实例 A 的 store 更新
      capturedHandler!([{ cwd: '/a', sessions: [summary('s1')] }])
      expect(storeA.groups.value).toHaveLength(1)

      // A 销毁（count 2→1 不退订）
      scopeA.stop()
      expect(unsub).not.toHaveBeenCalled()
      // B 销毁（count 1→0 退订一次）
      scopeB.stop()
      expect(unsub).toHaveBeenCalledTimes(1)

      resetSessionListSubForTest()
    })
  })

  /**
 * 图片落盘编排收敛测试（crash-resilience §3.3 D6-⑨，Gate B A9③ 缺陷#2 回流修复）。
 *
 * 断言 use-session 侧三条 hydrate 通路（首次切入 / 已 hydrate 刷新 / retryHistory）
 * 统一经 reconcileFromReply 触发 persistImagesNewestFirst——此前编排只挂
 * useChat.hydrateHistory，主流点击切入三处 reconcile 旁路致 cache 零写入。
 * 引擎级语义（新→旧反转 / 超帽即停 / 幂等去重）由 chat/__tests__/image-cache-orchestration.test.ts
 * 覆盖，此处只测编排点挂接：注入 recording write port 断言「被调用 + sessionId + 新→旧序」。
 */
  describe('hydrate 通路图片落盘编排收敛（D6-⑨ 缺陷#2）', () => {
    /** 记录型 write port：捕获 (sessionId, images 序)，回写全量 written。 */
    function makeRecordingPort() {
      const calls: Array<{ sessionId: string; order: string[] }> = []
      const port = vi.fn((sessionId: string, images: ImageCacheWriteImage[]): Promise<ImageCacheWriteResult> => {
        calls.push({ sessionId, order: images.map((i) => i.data) })
        return Promise.resolve({
          results: images.map((i) => ({ status: 'written' as const, path: `/cache/${sessionId}/${i.data}.png`, bytes: 10 })),
          quotaFull: false,
        })
      })
      return { calls, port }
    }

    /** 含单张 toolResult 图的 assistant 消息（collectImagesFromMessages 扫描对象）。 */
    function msgWithImage(id: string, data: string): never {
      return {
        id, role: 'assistant', content: '', status: 'complete', timestamp: 0,
        toolCalls: [{ id: `t-${id}`, toolName: 'shot', input: {}, status: 'completed', startTime: 0, images: [{ data, mimeType: 'image/png' }] }],
      } as never
    }

    beforeEach(() => {
      resetSessionListSubForTest()
      _resetImageCacheForTest()
    })

    afterEach(() => {
      _resetImageCacheForTest()
    })

    it('selectSession 首次切入（主流点击路径）：getHistory 含 toolResult 图 → 落盘编排被调，port 收新→旧序', async () => {
      const { calls, port } = makeRecordingPort()
      setImageCacheWritePort(port)
      const f = makeFixture()
      // 消息序（旧→新）：m-old 在前、m-new 在后
      f.chat.getHistory.mockResolvedValue({
        messages: [msgWithImage('m-old', 'old-1'), msgWithImage('m-new', 'new-2')],
        truncated: false, loadedTurns: 2, totalTurnsEstimate: 2,
      })

      await f.session.selectSession('sid-1')

      expect(f.chat.reconcileHistory).toHaveBeenCalledTimes(1)
      expect(calls).toHaveLength(1)
      expect(calls[0]!.sessionId).toBe('sid-1')
      // D6-⑨ 顺序契约：消息序反转为新→旧交 main 落盘（超帽弃最旧）
      expect(calls[0]!.order).toEqual(['new-2', 'old-1'])
      f.dispose()
    })

    it('selectSession 已 hydrate 刷新：reconcile 通路同样触发落盘编排', async () => {
      const { calls, port } = makeRecordingPort()
      setImageCacheWritePort(port)
      const f = makeFixture()
      f.chat.isHydrated.mockReturnValue(true)
      f.chat.getHistory.mockResolvedValue({
        messages: [msgWithImage('m1', 'img-1')],
        truncated: true, loadedTurns: 1, totalTurnsEstimate: 3,
      })

      await f.session.selectSession('sid-1')

      expect(f.chat.reconcileHistory).toHaveBeenCalledTimes(1)
      expect(calls).toHaveLength(1)
      expect(calls[0]!.sessionId).toBe('sid-1')
      expect(calls[0]!.order).toEqual(['img-1'])
      f.dispose()
    })

    it('retryHistory：reconcile 通路触发落盘编排', async () => {
      const { calls, port } = makeRecordingPort()
      setImageCacheWritePort(port)
      const f = makeFixture()
      f.chat.getHistory.mockResolvedValue({
        messages: [msgWithImage('m1', 'img-1')],
        truncated: false, loadedTurns: 1, totalTurnsEstimate: 1,
      })

      await f.session.retryHistory('s1')

      expect(f.chat.reconcileHistory).toHaveBeenCalledTimes(1)
      expect(calls).toHaveLength(1)
      expect(calls[0]!.sessionId).toBe('s1')
      f.dispose()
    })

    it('无图历史：port 不被调（collect 空列表零开销早退）；getHistory 失败短路：编排不触达', async () => {
      const { calls, port } = makeRecordingPort()
      setImageCacheWritePort(port)
      const f = makeFixture()

      // 无图消息（messages 无 toolCalls.images）
      f.chat.getHistory.mockResolvedValue({ messages: [{ id: 'm1' } as never], truncated: false, loadedTurns: 1, totalTurnsEstimate: 1 })
      await f.session.selectSession('sid-1')
      expect(calls).toHaveLength(0)
      f.dispose()

      // hydrate 失败（getHistory reject）：markHistoryFailed 分支不触达编排
      const f2 = makeFixture()
      f2.chat.getHistory.mockRejectedValue(new Error('io'))
      await expect(f2.session.selectSession('sid-1')).resolves.toBeUndefined()
      expect(f2.chat.markHistoryFailed).toHaveBeenCalledWith('sid-1')
      expect(calls).toHaveLength(0)
      f2.dispose()
    })

    it('重复切入幂等：已落盘图（内容 hash 记账）不重复交 port', async () => {
      const { calls, port } = makeRecordingPort()
      setImageCacheWritePort(port)
      const f = makeFixture()
      f.chat.getHistory.mockResolvedValue({
        messages: [msgWithImage('m1', 'img-1')],
        truncated: false, loadedTurns: 1, totalTurnsEstimate: 1,
      })

      await f.session.selectSession('sid-1')
      f.chat.isHydrated.mockReturnValue(true) // 第二次切入走已 hydrate 刷新分支
      await f.session.selectSession('sid-1')

      expect(calls).toHaveLength(1) // 第二次编排 pending 全被记账剔除，port 不再被调
      f.dispose()
    })
  })

  function makePanel() {
    return {
      focusedSessionId: vi.fn(() => null),
      activePanelId: vi.fn(() => 'p1'),
      findPanelBySession: vi.fn(() => null),
      loadSession: vi.fn(),
      openPanel: vi.fn(),
    }
  }

  function makeChat(): ChatHydratePort {
    return {
      getHistory: vi.fn().mockResolvedValue({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 }),
      isHydrated: vi.fn(() => false),
      hydrate: vi.fn(),
      reconcileHistory: vi.fn(),
      clearHistoryError: vi.fn(),
      markHistoryFailed: vi.fn(),
    }
  }
});
