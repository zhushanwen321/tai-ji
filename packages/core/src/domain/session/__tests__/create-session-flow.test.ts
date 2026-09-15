/**
 * createSessionFlow 单测（IF5，w4）。
 *
 * 覆盖 TC-1..TC-9 + TC-1b（label 三分支 + slash 段回退 label 文本源 / 编排序 / ES4+E7 降级 /
 * applyModel 步骤已删 / 空 content guard / migrateImages path 更新 / 降级 allSettled / defaultCwd 兜底）。
 * mock 注入点即 ctx 依赖注入点：
 * api.create / api.migrateImage 用 vi.fn；applyModel / onCwdFallback 用 vi.fn；store 用真实
 * createSessionStore（w1 交付，appendSession 终态断言需真实响应式）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Segment, SessionSummary } from '@taiji/shared'
import { createSessionStore } from '../store'
import { createSessionFlow } from '../create-session-flow'
import type { CreateSessionFlowCtx, CreateSessionFlowInput } from '../create-session-flow'

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
    expect(ctx.api.create).toHaveBeenCalledWith('/x', '帮我重构这段代码 a…', undefined, undefined, undefined, undefined)

    // ② bash command：label 从 command 取（无 ! 前缀）
    ctx = makeCtx()
    await createSessionFlow(ctx, {
      cwd: '/x',
      segments: [textSeg('!ls')],
      bashCommand: { command: 'ls -la', excludeFromContext: false },
    })
    expect(ctx.api.create).toHaveBeenCalledWith('/x', 'ls -la', undefined, undefined, undefined, undefined)

    // ③ 非 text 仅贴图：deriveSessionLabel('') 兜底「无提示词」
    ctx = makeCtx()
    await createSessionFlow(ctx, {
      cwd: '/x',
      segments: [imageSeg('/tmp/a.png', false)],
    })
    expect(ctx.api.create).toHaveBeenCalledWith('/x', '无提示词', undefined, undefined, undefined, undefined)
  })

  it('TC-1b slash 段视同 text-like 作 label 文本源（S-6）：landing 首发纯命令 → label 含 /tasks', async () => {
    // ① 纯命令首发（结构：[{type:'slash'}]）→ label 回退首个 slash 段拼 '/' + name，不退化为兜底文案
    await createSessionFlow(ctx, { cwd: '/x', segments: [slashSeg('tasks')] })
    expect(ctx.api.create).toHaveBeenCalledWith('/x', '/tasks', undefined, undefined, undefined, undefined)

    // ② 有非空 text 段 → 仍以 text 段为准（slash 段只在 trim 空时回退，不抢占 label）
    ctx = makeCtx()
    await createSessionFlow(ctx, { cwd: '/x', segments: [textSeg('总结'), slashSeg('compact')] })
    expect(ctx.api.create).toHaveBeenCalledWith('/x', '总结', undefined, undefined, undefined, undefined)

    // ③ text 段仅空白（trim 空）+ slash 段 → 回退 slash 段（对齐 base：命令拍平进 text 时的 label）
    ctx = makeCtx()
    await createSessionFlow(ctx, { cwd: '/x', segments: [textSeg('   '), slashSeg('tasks')] })
    expect(ctx.api.create).toHaveBeenCalledWith('/x', '/tasks', undefined, undefined, undefined, undefined)

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
    expect(ctx.api.create).toHaveBeenCalledWith('/x', 'hi', undefined, undefined, 'openai/gpt-x', undefined)
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
    expect(ctx.api.create).toHaveBeenCalledWith('/x', 'hi', 'preset-1', undefined, undefined, undefined)
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
    expect(ctx.api.create).toHaveBeenCalledWith('/home/user', 'hi', undefined, undefined, undefined, undefined)
  })

  it('TC-9 E7 两空 cwd：reqCwd 空串且 runtime 落 homedir → onCwdFallback("", actualCwd) 触发（不再静默）', async () => {
    // landing 两空：pendingCwd null 且 ctx.defaultCwd 空 → cwd='' → runtime create('')
    // 内部落 homedir（resolveCreateCwd existsSync('')=false）。空串守卫曾跳过回调——
    // 放宽后两空场景也有 toast 提示（D10-E7「已在主目录创建」由壳侧文案承担）
    ctx = makeCtx({
      defaultCwd: '',
      api: {
        ...makeCtx().api,
        create: vi.fn(async () => ({ id: 'ns', cwd: '/home/user', label: 'L' }) as SessionSummary),
      },
    })
    await createSessionFlow(ctx, { cwd: null, segments: [textSeg('hi')] })
    expect(ctx.api.create).toHaveBeenCalledWith('', 'hi', undefined, undefined, undefined, undefined)
    expect(ctx.onCwdFallback).toHaveBeenCalledTimes(1)
    expect(ctx.onCwdFallback).toHaveBeenCalledWith('', '/home/user')
  })
})
