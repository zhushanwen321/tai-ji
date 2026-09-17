/**
 * SessionLifecycle × 迁移 gate（D8-3，perf W29，06 §3.3）时序测试。
 *
 * 锁定三条 gate 语义：
 * - create / restoreSession / forkSession 三处 spawn pi 前必须 await migrationGate
 *   （06 审查修正：fork 是第三处 spawn 点，初稿漏列）。
 * - gate pending 时三处都挂起（pm.createSession 不被调用）；resolve 后放行。
 * - gate 未注入（默认 resolved）时行为与旧版一致（无等待）。
 *
 * gate 是 session-lifecycle 模块级 holder（组合根经 setMigrationGate 注入）——
 * 测试直接 setMigrationGate(deferred) 控制时序；afterEach 重置为 resolved 防串扰。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/session-lifecycle-gate.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionLifecycle, setMigrationGate, getMigrationGate } from './session-lifecycle.js'
import { MODEL_NOT_CONFIGURED } from '../../utils/errors.js'
import { getSessionsDir } from '../../infra/pi/pi-paths.js'
// [U8a W5 fork 锚] fork 继承不再写 .model.json sidecar（写点退役），继承可见性断言 =
// 产物 JSONL 反向读（U8 起 scanSessionMeta 第七读同款直调 extractLatestModelFromJsonl）
import { extractLatestModelFromJsonl } from '../../infra/pi/session-file-utils.js'
import type { ILifecycleSessionOps, ISessionRegisterDeps } from './session-internal.js'
import type { IProcessManager, IPiEngine } from '../ports/pi-engine.js'
import type { IConfigStore } from '../ports/config.js'
import type { ISessionStore } from '../ports/session.js'
import type { WorkspaceService } from '../workspace/workspace-service.js'
import type { IManagedSessionView, ScannedSession } from './types.js'
import type { IEventAdapter } from '../../interfaces.js'
import type { SessionSummary } from '@taiji/shared'

function makeSummary(id: string): SessionSummary {
  return { id, label: 'test', cwd: '/tmp', status: 'idle', lastActiveAt: Date.now(), modelId: 'p/m', tokenCount: 0 }
}

/** fake EventAdapter（S3 迁移后 registerSession 真实现经 registerDeps.adapterFactory 装配 adapter）。 */
function makeFakeAdapter(): IEventAdapter {
  return { attach: vi.fn(), detach: vi.fn() } as unknown as IEventAdapter
}

/**
 * 构造最小 lifecycle 环境：svc/pm/configStore/sessionStore/workspaceService 全 mock。
 * S2 ISP 化（设计 §4.2 场景 B 主验收点）：svc 结构性满足 lifecycle 窄接口，svc stub 强转彻底消失。
 * S3 写点归位：initializeManagedSession 从 svc stub 移除（接口已删）——注册走真
 * registerSession（sessions Map 所有权在 lifecycle），装配依赖经 registerDeps 注入
 * fake adapterFactory；svc stub 面收窄为 10 方法 = 现接口实际消费面。
 */
function makeEnv() {
  const svc: ILifecycleSessionOps = {
    getExtensionPaths: vi.fn(async () => []),
    getSkillPaths: vi.fn(() => []),
    getReplaceSystemPrompt: vi.fn(() => undefined),
    getLaunchPresetOptions: vi.fn(async () => undefined),
    toSummary: vi.fn((s: IManagedSessionView) => makeSummary(s.id)),
    // S3-W2：创建入口收敛点（lifecycle 三处 return 前调用）
    notifySessionCreated: vi.fn(),
    findScannedSession: vi.fn(() => undefined),
    fetchAndBroadcastContext: vi.fn(async () => undefined),
    removeSessionEntry: vi.fn(),
    getActiveSummaries: vi.fn(() => []),
  }
  const client = {
    getState: vi.fn(async () => ({ sessionId: 'sess-1', sessionFile: undefined })),
    switchSession: vi.fn(async () => undefined),
  }
  const pm = {
    createSession: vi.fn(async () => client),
    rekey: vi.fn(),
    destroySession: vi.fn(async () => undefined),
    // D5② 短路预检读点（session-dead-structural-fixes）：undefined = 无 client → 不短路 → 全流程。
    getClient: vi.fn(() => undefined),
  } as unknown as IProcessManager
  const configStore = {
    getDefaultModel: vi.fn(() => ({ provider: 'test-provider', modelId: 'test-model' })),
  } as unknown as IConfigStore
  const sessionStore = {
    refreshAll: vi.fn(),
    invalidateScanCache: vi.fn(),
    persistPresetBinding: vi.fn(),
    persistProjectBinding: vi.fn(),
  } as unknown as ISessionStore
  const workspaceService = { record: vi.fn() } as unknown as WorkspaceService
  const registerDeps: ISessionRegisterDeps = {
    adapterFactory: () => makeFakeAdapter(),
    getMessageBus: () => null,
    broadcastGlobal: () => {},
    notifyMessageComplete: () => {},
  }

  const lifecycle = new SessionLifecycle(svc, pm, configStore, sessionStore, workspaceService, registerDeps)
  return { svc, pm, configStore, sessionStore, workspaceService, client, lifecycle, registerDeps }
}

/** 让当前微任务/宏任务队列排空（gate pending 断言前用）。 */
async function flushTicks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  // 重置模块级 gate——防测试间串扰（默认 resolved = 无 gate 语义）。
  setMigrationGate(Promise.resolve())
})

describe('SessionLifecycle × migration gate（D8-3）', () => {
  describe('create', () => {
    it('gate pending 时 create 挂起（pm.createSession 不被调用），resolve 后放行', async () => {
      const { lifecycle, pm, configStore } = makeEnv()
      let resolveGate!: (v: unknown) => void
      setMigrationGate(new Promise((res) => { resolveGate = res }))

      const cwd = mkdtempSync(join(tmpdir(), 'w29-gate-create-'))
      const pending = lifecycle.create(cwd, 't')
      await flushTicks()
      // gate 未 resolve：spawn 未发生，create 仍在挂起
      expect(pm.createSession).not.toHaveBeenCalled()
      expect(configStore.getDefaultModel).toHaveBeenCalledTimes(1)

      resolveGate(undefined)
      const summary = await pending
      expect(pm.createSession).toHaveBeenCalledTimes(1)
      expect(summary.id).toBe('sess-1')
      rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    it('gate 未注入（默认 resolved）时 create 不等待（与旧版一致）', async () => {
      const { lifecycle, pm } = makeEnv()
      // afterEach 已重置 gate；此处显式再设默认
      setMigrationGate(Promise.resolve())
      const cwd = mkdtempSync(join(tmpdir(), 'w29-gate-create-nogate-'))
      const summary = await lifecycle.create(cwd, 't')
      expect(pm.createSession).toHaveBeenCalledTimes(1)
      expect(summary.id).toBe('sess-1')
      rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })
  })

  describe('restoreSession', () => {
    it('gate pending 时 restore 挂起，resolve 后放行', async () => {
      const { lifecycle, pm, svc } = makeEnv()
      const dir = mkdtempSync(join(tmpdir(), 'w29-gate-restore-'))
      const filePath = join(dir, 'session.jsonl')
      writeFileSync(filePath, [
        { type: 'session', version: 3, id: 's-restore', timestamp: '2026-08-16T01:00:00.000Z', cwd: dir },
        { type: 'message', id: 'u1', parentId: null, timestamp: '2026-08-16T01:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
      ].map((l) => JSON.stringify(l)).join('\n') + '\n')
      const target: ScannedSession = { id: 's-restore', cwd: dir, filePath, name: 'restored', launchPresetId: undefined } as ScannedSession
      svc.findScannedSession = vi.fn(() => target) as never
      // S3 迁移：注册走真 registerSession（id = sessionId），makeEnv 的透传 toSummary
      // stub 保留 summary.id = 真 session.id 的行为绑定。

      let resolveGate!: (v: unknown) => void
      setMigrationGate(new Promise((res) => { resolveGate = res }))

      const pending = lifecycle.restoreSession('s-restore')
      await flushTicks()
      expect(pm.createSession).not.toHaveBeenCalled()

      resolveGate(undefined)
      const summary = await pending
      expect(pm.createSession).toHaveBeenCalledTimes(1)
      expect(summary.id).toBe('s-restore')
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })
  })

  describe('forkSession', () => {
    it('gate pending 时 fork 挂起，resolve 后放行', async () => {
      const { lifecycle, pm, svc } = makeEnv()
      // createForkedSessionFile 写入 getSessionsDir()（测试数据目录 sessions 子目录需先建）
      mkdirSync(getSessionsDir(), { recursive: true })
      const dir = mkdtempSync(join(tmpdir(), 'w29-gate-fork-'))
      const sourceFile = join(dir, 'source.jsonl')
      writeFileSync(sourceFile, [
        { type: 'session', version: 3, id: 's-fork-src', timestamp: '2026-08-16T01:00:00.000Z', cwd: dir },
        { type: 'message', id: 'u1', parentId: null, timestamp: '2026-08-16T01:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
        { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-08-16T01:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } },
      ].map((l) => JSON.stringify(l)).join('\n') + '\n')
      const source: ScannedSession = { id: 's-fork-src', cwd: dir, filePath: sourceFile, launchPresetId: undefined } as ScannedSession
      svc.findScannedSession = vi.fn(() => source) as never

      let resolveGate!: (v: unknown) => void
      setMigrationGate(new Promise((res) => { resolveGate = res }))

      const pending = lifecycle.forkSession('s-fork-src', 'a1', true, 'forked')
      await flushTicks()
      expect(pm.createSession).not.toHaveBeenCalled()

      resolveGate(undefined)
      const summary = await pending
      expect(pm.createSession).toHaveBeenCalledTimes(1)
      // S3 迁移：fork 新 session 由真 registerSession 注册（id = createForkedSessionFile
      // 生成的 forkedId，非固定值）——断言 summary 对应已入 Map 的新 session。
      expect(summary.id).not.toBe('s-fork-src')
      expect(lifecycle.has(summary.id)).toBe(true)
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })
    // [U8a W5 fork 锚迁移] 原 create-fork-anchor 的「fork 继承 sidecar 落盘」断言对象
    // 随写点退役消失，重设计为反向读可见断言——本文件 fork 走真实 createForkedSessionFile
    //（anchor 测试 mock 了 session-fork，无法承载产物内容断言）。fork 继承 = 源 path 上
    // 的 assistant entry 随产物进入新文件，extractLatestModelFromJsonl 反向读命中继承值
    //（与 pi 恢复读路径同源；thinkingLevel 无 entry → pi 默认 'off'）。
    it('fork 继承反向读可见：源 assistant entry 随产物继承，extractLatestModelFromJsonl 命中源模型', async () => {
      const { lifecycle, svc } = makeEnv()
      // createForkedSessionFile 写入 getSessionsDir()（测试数据目录 sessions 子目录需先建）
      mkdirSync(getSessionsDir(), { recursive: true })
      const dir = mkdtempSync(join(tmpdir(), 'u8a-fork-reverse-read-'))
      const sourceFile = join(dir, 'source.jsonl')
      writeFileSync(sourceFile, [
        { type: 'session', version: 3, id: 's-fork-src', timestamp: '2026-08-16T01:00:00.000Z', cwd: dir },
        { type: 'message', id: 'u1', parentId: null, timestamp: '2026-08-16T01:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
        { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-08-16T01:00:02.000Z', message: { role: 'assistant', provider: 'src-provider', model: 'src-model', content: [{ type: 'text', text: 'hello' }] } },
      ].map((l) => JSON.stringify(l)).join('\n') + '\n')
      const source: ScannedSession = { id: 's-fork-src', cwd: dir, filePath: sourceFile, launchPresetId: undefined } as ScannedSession
      svc.findScannedSession = vi.fn(() => source) as never

      const summary = await lifecycle.forkSession('s-fork-src', 'a1', true, 'forked')

      const forked = lifecycle.get(summary.id)
      const forkedFilePath = forked?.sessionFilePath
      expect(forkedFilePath).toBeTruthy()
      expect(extractLatestModelFromJsonl(forkedFilePath!)).toEqual({
        modelId: 'src-provider/src-model',
        thinkingLevel: 'off',
      })
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    // r2-S1：model 门禁优先级——configStore 无默认 model 且源 session 也不存在时，
    // 错误码必须是 MODEL_NOT_CONFIGURED（先于 source not found 报出），
    // 与 create/restore 的错误优先级一致（见 session-lifecycle.ts forkSession 头部 r5-S2 注释）。
    it('model 未配置且 source 不存在时报 MODEL_NOT_CONFIGURED（优先于 source not found）', async () => {
      const { lifecycle, configStore, pm, svc } = makeEnv()
      configStore.getDefaultModel = vi.fn(() => null)
      svc.findScannedSession = vi.fn(() => undefined) as never

      await expect(lifecycle.forkSession('no-such-src', 'a1', true, 'forked')).rejects.toMatchObject({
        code: MODEL_NOT_CONFIGURED,
      })
      // 源解析未发生（门禁在其之前）：spawn 更不可达
      expect(pm.createSession).not.toHaveBeenCalled()
    })
  })

  it('getMigrationGate 可读当前 gate（组合根注入后非默认）', () => {
    setMigrationGate(Promise.resolve())
    expect(getMigrationGate()).toBeInstanceOf(Promise)
    const deferred = new Promise(() => undefined)
    setMigrationGate(deferred)
    expect(getMigrationGate()).toBe(deferred)
  })
})

describe('SessionLifecycle.delete（W19：sidecar 四后缀全家族清理，W11 观察项收口）', () => {
  it('active 与 scanned 两分支都 unlink .meta/.preset/.project/.handoff 全部四后缀', async () => {
    const { lifecycle, svc, sessionStore } = makeEnv()
    const suffixes = ['.meta.json', '.preset.json', '.project.json', '.handoff.json']
    const setup = (tag: string) => {
      const f = join(mkdtempSync(join(tmpdir(), `w19-del-${tag}-`)), 's.jsonl')
      writeFileSync(f, '{"type":"session"}\n')
      suffixes.forEach((s) => writeFileSync(f + s, '{}'))
      return f
    }
    Object.assign(sessionStore, { trash: vi.fn(async () => {}), invalidateMetaCache: vi.fn() })
    const scanned = setup('scanned')
    svc.findScannedSession = vi.fn(() => ({ id: 's1', filePath: scanned })) as never
    await lifecycle.delete('s1')
    suffixes.forEach((s) => expect(existsSync(scanned + s)).toBe(false))
    // S3 迁移：active 分支判定改读 lifecycle 自持 Map——真 registerSession 注册 s2
    // （delete 内 detachSession 走所有者自查 + fake adapter；removeSessionEntry 仍经
    // svc 编排 stub），不再 stub svc.getSession。
    const active = setup('active')
    svc.removeSessionEntry = vi.fn() as never
    await lifecycle.registerSession('s2', {} as unknown as IPiEngine, tmpdir(), 'active', active)
    await lifecycle.delete('s2')
    suffixes.forEach((s) => expect(existsSync(active + s)).toBe(false))
  })
})
