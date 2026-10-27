import { __testing as bootstrapTesting } from '../bootstrap';
import enUS from '../locales/en-US';
import zhCN from '../locales/zh-CN';
import { REMOTE_TOKEN_STORAGE_KEY, createConnectionProfilePort, readQueryToken, resolveCredential, wsUrlFromHost } from '../platform/connection-profile';
import { createMobilePlatformAdapter } from '../platform/mobile-platform-adapter';
import { __testing, beginQueueEdit, clearQueueEditFor, editDelivery, peekDelivery, queueEditAnchorOf } from '../shell/app-runtime';
import { formQuestionsOf, isPlanReviewFrame, isRichInteractionFrame, scheduleDraftOf } from '../shell/form-protocol';
import { checkInboundEffectsAssembly, checkSessionEntryAssembly } from '@taiji/core';
import type { KVStorage } from '@taiji/core';
import type { ExtensionUIRequest } from '@taiji/core/transport/api/domains/extension';
import type { Segment } from '@taiji/shared';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← ac1-dependency-edge.test.ts
// ======================================================================

// vitest 运行时 cwd 即包根（vitest.config.ts 所在目录），package.json 在其下
const pkgRoot = process.cwd()

/** 允许依赖的 @taiji/* 包白名单（arch-fix-v2 分层：shared←core←dom-core←ui←mobile 装配层） */
const ALLOWED_TAIJI_DEPS = ['@taiji/core', '@taiji/dom-core', '@taiji/ui', '@taiji/shared'] as const

describe('AC1: mobile-renderer 包拓扑依赖边', () => {
  const pkg = JSON.parse(readFileSync(resolve(pkgRoot, 'package.json'), 'utf-8')) as {
    dependencies: Record<string, string>
  }

  it('package.json dependencies 含 @taiji/core（workspace:*）', () => {
    expect(pkg.dependencies['@taiji/core']).toBe('workspace:*')
  })

  it('package.json dependencies 含 @taiji/ui（workspace:*）', () => {
    expect(pkg.dependencies['@taiji/ui']).toBe('workspace:*')
  })

  it('所有 @taiji/* 依赖 ∈ 允许边白名单（core/dom-core/ui/shared）', () => {
    const taijiDeps = Object.keys(pkg.dependencies).filter((d) => d.startsWith('@taiji/'))
    expect(taijiDeps.length).toBeGreaterThan(0)
    for (const dep of taijiDeps) {
      expect(ALLOWED_TAIJI_DEPS).toContain(dep)
    }
  })
})

// ======================================================================
// ← assembly-check.test.ts
// ======================================================================

// vitest 运行时 cwd 即包根（ac1-dependency-edge 同款锚定）
const pkgRoot_m2 = process.cwd()

/** 注释提及 __testing 但无消费的生产文件（相对 src 路径）——新条目须随改动同 commit 裁决 */
const DOC_MENTION_ALLOWLIST = ['views/SubagentStatusLine.vue'] as const

/** 生产文件 = src 下 .ts/.vue，排除测试目录与测试文件命名 */
function isProductionFile(relPath: string): boolean {
  if (relPath.split('/').includes('__tests__')) return false
  return relPath.endsWith('.ts') || relPath.endsWith('.vue')
}

function listProductionFiles(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) return listProductionFiles(join(dir, entry.name), rel)
    return isProductionFile(rel) ? [rel] : []
  })
}

describe('D9① 移动壳装配检查（core 共享 helper）', () => {
  it('sessionEntry 端口束：切入链订阅/LRU 三成员非 no-op（S1 只看不发/S7 内存无界的装配锚点）', () => {
    const { ok, problems } = checkSessionEntryAssembly(__testing.sessionEntry)
    expect(problems).toEqual([])
    expect(ok).toBe(true)
  })

  it('effects 最小集：exited/restored/restoreFailed 三生命周期回调已接（S6 全弃的装配锚点）', () => {
    const { ok, problems } = checkInboundEffectsAssembly(bootstrapTesting.shellEffects)
    expect(problems).toEqual([])
    expect(ok).toBe(true)
  })
})

describe('D9② __testing 出口生产代码零消费（grep 断言）', () => {
  it('src 生产文件零消费 __testing（出口仅测试 import；定义点自证放行）', () => {
    const srcRoot = join(pkgRoot_m2, 'src')
    const offenders = listProductionFiles(srcRoot).filter((rel) => {
      const content = readFileSync(join(srcRoot, rel), 'utf-8')
      if (!content.includes('__testing')) return false
      // 出口定义文件自证放行（各定义点同款形态：export const __testing）
      if (content.includes('export const __testing')) return false
      return !DOC_MENTION_ALLOWLIST.includes(rel as (typeof DOC_MENTION_ALLOWLIST)[number])
    })
    expect(offenders).toEqual([])
  })
})

// ======================================================================
// ← mobile-locale.test.ts
// ======================================================================

/** 拍平嵌套文案树为完整 key 路径集合 */
function flattenKeyPaths(obj: unknown, prefix = ''): string[] {
  const paths: string[] = []
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const full = prefix ? `${prefix}.${key}` : key
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      paths.push(...flattenKeyPaths(value, full))
    } else {
      paths.push(full)
    }
  }
  return paths.sort()
}

describe('mobile 壳自有 locale 双侧结构一致', () => {
  it('zh-CN 与 en-US key 路径集合完全相等（无缺 key 无多 key）', () => {
    const zhKeys = flattenKeyPaths(zhCN)
    const enKeys = flattenKeyPaths(enUS)
    expect(zhKeys.length).toBeGreaterThan(0)
    expect(enKeys).toEqual(zhKeys)
  })

  it('顶层命名空间为 mobile（壳自有 key 与下沉域不混居）', () => {
    expect(Object.keys(zhCN)).toEqual(['mobile'])
    expect(Object.keys(enUS)).toEqual(['mobile'])
  })
})

// ======================================================================
// ← form-protocol.test.ts
// ======================================================================

function choiceReq(overrides: Partial<ExtensionUIRequest> = {}): ExtensionUIRequest {
  return {
    sessionId: 'sid-a',
    requestId: 'req-1',
    dialogKind: 'select',
    form: true,
    formQuestions: [
      { type: 'choice', question: '用哪个数据库？', options: [{ label: 'pg' }, { label: 'mysql' }] },
    ],
    ...overrides,
  }
}

describe('帧标记检查与字段收窄', () => {
  it('isRichInteractionFrame：form/planReview 放行；普通 dialog 帧拒绝；非对象安全 false', () => {
    expect(isRichInteractionFrame({ form: true })).toBe(true)
    expect(isRichInteractionFrame({ planReview: true })).toBe(true)
    expect(isRichInteractionFrame({ kind: 'select', options: ['a'] })).toBe(false)
    expect(isRichInteractionFrame(null)).toBe(false)
    expect(isRichInteractionFrame('form')).toBe(false)
  })

  it('isPlanReviewFrame 窄化 + selfReview 搬运；formQuestionsOf 过滤非法项；scheduleDraftOf 收窄', () => {
    const planFrame = { ...choiceReq(), planReview: true, selfReview: '自审结论' } as unknown as ExtensionUIRequest
    expect(isPlanReviewFrame(planFrame)).toBe(true)

    const mixed = choiceReq({
      formQuestions: [
        { type: 'choice', question: 'q1', options: [{ label: 'a' }] },
        { type: 'alien' },
        'not-an-object',
      ],
    })
    const qs = formQuestionsOf(mixed)
    expect(qs).toHaveLength(1)
    expect(formQuestionsOf({ ...choiceReq(), form: undefined })).toEqual([])

    const draft = { kind: 'once' as const, schedule: '30 14 2 10 *', prompt: 'p', models: ['m1'] }
    const draftReq = choiceReq({ scheduleCreate: true, scheduleDraft: draft })
    expect(scheduleDraftOf(draftReq)).not.toBeNull()
    expect(scheduleDraftOf(choiceReq({ scheduleCreate: true, scheduleDraft: { broken: true } }))).toBeNull()
    expect(scheduleDraftOf(choiceReq())).toBeNull()
  })
})

// ======================================================================
// ← connection-profile.test.ts
// ======================================================================

function makeStore(initial?: string): { storage: KVStorage; map: Map<string, string> } {
  const map = new Map<string, string>()
  if (initial !== undefined) map.set(REMOTE_TOKEN_STORAGE_KEY, initial)
  const storage: KVStorage = {
    get: async (key) => map.get(key) ?? null,
    set: async (key, value) => {
      map.set(key, value)
    },
    remove: async (key) => {
      map.delete(key)
    },
  }
  return { storage, map }
}

function makePort(opts: { search?: string; stored?: string; protocol?: string } = {}) {
  const { storage, map } = makeStore(opts.stored)
  const stripQuery = vi.fn()
  const onTokenInputRequired = vi.fn()
  const port = createConnectionProfilePort({
    storage,
    host: '192.168.1.5:3210',
    protocol: opts.protocol ?? 'http:',
    search: opts.search ?? '',
    stripQuery,
    onTokenInputRequired,
  })
  return { port, map, stripQuery, onTokenInputRequired }
}

describe('resolveCredential 纯裁决（D4）', () => {
  it('query 优先于 storage（轮换重扫：新凭据压过旧持久凭据）', () => {
    expect(resolveCredential('tok-new', 'tok-old')).toEqual({
      action: 'adopt',
      credential: { token: 'tok-new', source: 'query' },
    })
  })

  it('storage 兜底（无 query 时）', () => {
    expect(resolveCredential(null, 'tok-stored')).toEqual({
      action: 'adopt',
      credential: { token: 'tok-stored', source: 'storage' },
    })
  })

  it('皆无 → need-input', () => {
    expect(resolveCredential(null, null)).toEqual({ action: 'need-input' })
  })

  it('空串等同缺失（URLSearchParams 有 key 无值形态）', () => {
    expect(resolveCredential('', '')).toEqual({ action: 'need-input' })
  })
})

describe('readQueryToken / wsUrlFromHost', () => {
  it('?token= 提取；无 token 参数 / 空 search 返回 null', () => {
    expect(readQueryToken('?token=abc&x=1')).toBe('abc')
    expect(readQueryToken('?x=1')).toBeNull()
    expect(readQueryToken('')).toBeNull()
  })

  it('WS URL scheme 按页面协议派生：http: → ws://，https: → wss://，未知协议安全侧缺省 wss://', () => {
    expect(wsUrlFromHost('192.168.1.5:3210', 'http:')).toBe('ws://192.168.1.5:3210')
    expect(wsUrlFromHost('remote.example.com', 'https:')).toBe('wss://remote.example.com')
    expect(wsUrlFromHost('remote.example.com', 'file:')).toBe('wss://remote.example.com')
  })

  it('resolve 的连接目标随注入协议派生（https 托管形态 → wss://）', async () => {
    const { port } = makePort({ stored: 'tok-stored', protocol: 'https:' })
    const resolved = await port.resolve()
    expect(resolved.url).toBe('wss://192.168.1.5:3210')
  })
})

describe('D4 三分支补全（端口集成）', () => {
  it('分支①：query 验身成功覆盖 storage + 抹地址栏（轮换重扫恢复路径）', async () => {
    const { port, map, stripQuery } = makePort({ search: '?token=tok-new', stored: 'tok-old' })
    const resolved = await port.resolve()
    expect(resolved).toEqual({ url: 'ws://192.168.1.5:3210', token: 'tok-new' })
    await port.handleAuthSuccess()
    expect(map.get(REMOTE_TOKEN_STORAGE_KEY)).toBe('tok-new') // 覆盖写
    expect(stripQuery).toHaveBeenCalledTimes(1) // replaceState 抹地址栏
  })

  it('分支②：query 坏 token 验身失败不动好 storage + 落 token 输入视图（地址栏 query 保留）', async () => {
    const { port, map, stripQuery, onTokenInputRequired } = makePort({
      search: '?token=tok-bad',
      stored: 'tok-good',
    })
    await port.resolve()
    await port.handleAuthFailure()
    expect(map.get(REMOTE_TOKEN_STORAGE_KEY)).toBe('tok-good') // 好凭据无损
    expect(stripQuery).not.toHaveBeenCalled() // 刷新重试入口保留（D4 显式判定）
    expect(onTokenInputRequired).toHaveBeenCalledTimes(1)
  })

  it('分支③：storage 来源失效 → 清空 storage + 落 token 输入视图（E11）', async () => {
    const { port, map, onTokenInputRequired } = makePort({ stored: 'tok-stale' })
    const resolved = await port.resolve()
    expect(resolved).toEqual({ url: 'ws://192.168.1.5:3210', token: 'tok-stale' })
    await port.handleAuthFailure()
    expect(map.has(REMOTE_TOKEN_STORAGE_KEY)).toBe(false)
    expect(onTokenInputRequired).toHaveBeenCalledTimes(1)
  })

  it('皆无：resolve 不带凭据（E2 通路，连接发起侧无异常路径）；验身失败通知落输入视图', async () => {
    const { port, map, onTokenInputRequired } = makePort({})
    const resolved = await port.resolve()
    expect(resolved).toEqual({ url: 'ws://192.168.1.5:3210' })
    expect('token' in resolved).toBe(false)
    await port.handleAuthFailure()
    expect(map.has(REMOTE_TOKEN_STORAGE_KEY)).toBe(false)
    expect(onTokenInputRequired).toHaveBeenCalledTimes(1)
  })

  it('手输采纳：resolve 优先采纳（压过 query/storage）；验身成功落 storage + 抹地址栏（语义同 query）', async () => {
    const { port, map, stripQuery } = makePort({ search: '?token=tok-query', stored: 'tok-old' })
    port.adoptManualToken('tok-manual')
    const resolved = await port.resolve()
    expect(resolved).toEqual({ url: 'ws://192.168.1.5:3210', token: 'tok-manual' })
    await port.handleAuthSuccess()
    expect(map.get(REMOTE_TOKEN_STORAGE_KEY)).toBe('tok-manual')
    expect(stripQuery).toHaveBeenCalledTimes(1) // manual 同抹地址栏（漏抹则刷新时残留旧 query 压过新凭据成循环）
  })

  it('manual 验身成功后同会话再 resolve 走 storage 分支（旧 query 已消费，不再压过已落盘凭据）', async () => {
    // 循环场景锚：手输前地址栏残留坏旧 ?token=tok-old；deps.search 是 bootstrap 时刻快照
    // （replaceState 不回写快照），已消费的旧值必须在端口内消歧——否则 token 重试 / HMR
    // 重连再次 resolve 时旧值重复被采纳，手输成功被旧值顶掉。
    const { port, stripQuery } = makePort({ search: '?token=tok-old', stored: 'tok-stale' })
    port.adoptManualToken('tok-manual')
    await port.resolve()
    await port.handleAuthSuccess()
    expect(stripQuery).toHaveBeenCalledTimes(1)
    // 同会话再 resolve（token 重试 / HMR 重连路径）：旧 query 不再采纳 → storage 分支
    expect(await port.resolve()).toEqual({ url: 'ws://192.168.1.5:3210', token: 'tok-manual' })
    // 刷新形态（真实地址栏已被 replaceState 抹掉 query）：新装配 resolve 同样走 storage
    const fresh = makePort({ search: '', stored: 'tok-manual' })
    expect(await fresh.port.resolve()).toEqual({ url: 'ws://192.168.1.5:3210', token: 'tok-manual' })
  })

  it('query 来源验身成功后同会话再 resolve 同样走 storage（已消费值不重复采纳）', async () => {
    const { port, map, stripQuery } = makePort({ search: '?token=tok-new', stored: 'tok-old' })
    await port.resolve()
    await port.handleAuthSuccess()
    expect(stripQuery).toHaveBeenCalledTimes(1)
    // storage 改写异值消歧来源分支：若已消费 query 被重复采纳（消歧失效），此断言
    // 拿到旧 query 值 tok-new 而非 storage 异值——fixture 值恒等时两分支不可区分
    map.set(REMOTE_TOKEN_STORAGE_KEY, 'tok-rotated')
    expect(await port.resolve()).toEqual({ url: 'ws://192.168.1.5:3210', token: 'tok-rotated' })
  })

  it('stripQuery 抛错降级：handleAuthSuccess 正常完成、storage 已落盘、消费消歧不受影响', async () => {
    // replaceState 在受限环境（sandboxed iframe 等）会抛——connection-view 对
    // handleAuthSuccess 是 void 调用，直抛 = unhandled rejection；降级 = warn + 靠已落盘
    // storage 自愈（下次刷新走 storage 分支）。
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { port, map, stripQuery } = makePort({ search: '?token=tok-q', stored: 'tok-old' })
      stripQuery.mockImplementation(() => {
        throw new Error('replaceState blocked (sandboxed context)')
      })
      await port.resolve()
      await expect(port.handleAuthSuccess()).resolves.toBeUndefined()
      expect(map.get(REMOTE_TOKEN_STORAGE_KEY)).toBe('tok-q')
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(await port.resolve()).toEqual({ url: 'ws://192.168.1.5:3210', token: 'tok-q' })
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('storage 来源验身成功幂等（不重写、不抹地址栏）；普通重连（待定凭据已清）auth 成功 no-op', async () => {
    const { port, map, stripQuery } = makePort({ stored: 'tok-stored' })
    await port.resolve()
    await port.handleAuthSuccess()
    expect(map.get(REMOTE_TOKEN_STORAGE_KEY)).toBe('tok-stored')
    expect(stripQuery).not.toHaveBeenCalled()
    // pending 已清：重连成功的 auth 处置 no-op 不抛
    await port.handleAuthSuccess()
  })
})

// ======================================================================
// ← mobile-platform-adapter.test.ts
// ======================================================================

describe('LocalStorageKV 读降级（受限环境 localStorage.getItem 抛错）', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('正常路径：get 返回已存值 / 缺失 key 返回 null（happy-dom 真实 localStorage）', async () => {
    const { storage } = createMobilePlatformAdapter()
    await storage.set('taiji.remote-access.token', 'tok-a')
    expect(await storage.get('taiji.remote-access.token')).toBe('tok-a')
    expect(await storage.get('missing-key')).toBeNull()
  })

  it('getItem 抛错（SecurityError 形态）→ get 返回 null 不 reject，warn 留排障依据', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError: The document is sandboxed and lacks the allow-same-origin flag.')
      },
      setItem: () => {},
      removeItem: () => {},
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { storage } = createMobilePlatformAdapter()
    await expect(storage.get('taiji.remote-access.token')).resolves.toBeNull()
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('写降级回归锚：setItem / removeItem 抛错 → set / remove 正常完成不 reject', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError (Safari private mode form)')
      },
      removeItem: () => {
        throw new Error('QuotaExceededError (Safari private mode form)')
      },
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { storage } = createMobilePlatformAdapter()
    await expect(storage.set('k', 'v')).resolves.toBeUndefined()
    await expect(storage.remove('k')).resolves.toBeUndefined()
    expect(warnSpy).toHaveBeenCalledTimes(2)
  })
})

// ======================================================================
// ← app-runtime-delivery-passthrough.spec.ts
// ======================================================================

const chatApiMock = vi.hoisted(() => ({
  peekDelivery: vi.fn<(sid: string, clientUuid: string) => Promise<unknown>>(),
  editDelivery: vi.fn<
    (sid: string, clientUuid: string, content: string, segments?: unknown[]) => Promise<unknown>
  >(),
}))
// app-runtime 顶层消费 chat 域多成员（abort/send/...），部分展开只覆写 peek/edit 两个透传点
vi.mock('@taiji/core/transport/api/domains/chat', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  peekDelivery: chatApiMock.peekDelivery,
  editDelivery: chatApiMock.editDelivery,
}))

beforeEach(() => {
  chatApiMock.peekDelivery.mockReset()
  chatApiMock.editDelivery.mockReset()
  // 分区隔离：测试专用 sid（与组件级 spec 的 mock sid 空间不重叠）
  clearQueueEditFor('sid-passthrough')
})

describe('app-runtime 投递域透传出口（D6）', () => {
  it('peekDelivery 参数原样透传 core chat 域，回执直返', async () => {
    chatApiMock.peekDelivery.mockResolvedValue({ clientUuid: 'u-1', found: true, content: 'x' })
    await expect(peekDelivery('sid-passthrough', 'u-1')).resolves.toEqual({
      clientUuid: 'u-1',
      found: true,
      content: 'x',
    })
    expect(chatApiMock.peekDelivery).toHaveBeenCalledWith('sid-passthrough', 'u-1')
  })

  it('editDelivery 参数原样透传 core chat 域（含 segments 快照）', async () => {
    chatApiMock.editDelivery.mockResolvedValue({ clientUuid: 'u-1', edited: true })
    const segments: Segment[] = [{ type: 'text', text: 'edited' }]
    await expect(editDelivery('sid-passthrough', 'u-1', 'edited', segments)).resolves.toEqual({
      clientUuid: 'u-1',
      edited: true,
    })
    expect(chatApiMock.editDelivery).toHaveBeenCalledWith('sid-passthrough', 'u-1', 'edited', segments)
  })

  it('锚定分区三出口：无锚 null → started 登记 → 读口返回 → 解除归 null', () => {
    expect(queueEditAnchorOf('sid-passthrough')).toBeNull()
    expect(beginQueueEdit('sid-passthrough', 'u-1')).toBe('started')
    expect(queueEditAnchorOf('sid-passthrough')).toBe('u-1')
    clearQueueEditFor('sid-passthrough')
    expect(queueEditAnchorOf('sid-passthrough')).toBeNull()
  })

  it('锚定分区按 session 隔离：他行会话不受本会话登记/解除影响', () => {
    expect(beginQueueEdit('sid-passthrough', 'u-1')).toBe('started')
    // 首次调用即建分区（懒初始化），他会话分区独立
    expect(beginQueueEdit('sid-other', 'u-2')).toBe('started')
    clearQueueEditFor('sid-passthrough')
    expect(queueEditAnchorOf('sid-passthrough')).toBeNull()
    expect(queueEditAnchorOf('sid-other')).toBe('u-2')
    clearQueueEditFor('sid-other')
  })
})
