/**
 * SessionLifecycle.restoreSession 的 cwd fallback 落点测试（W11 引入，W1 语义变更）。
 *
 * [W1 语义变更：直附着正式文件]（restore-fork-attach-fix）：原「读源文件 → strip →
 * 对 tmp 首行 header 应用 fallback → 写 $TMPDIR → switchSession(tmp) → unlink tmp」
 * 管线已整体删除——pi switch_session 永久重绑读写目标（pi-mono session-manager.ts
 * setSessionFile），附着 tmp 后每轮写按路径重建的 tmp 孤儿文件，原会话文件永不更新。
 *
 * 现行语义（F2/F3 分流）：
 * - cwd 活 + 无 session_end 行（F2）：switchSession 直接收 target.filePath，源文件零写
 * - cwd 死路径（F3）：spawn cwd 降级 homedir + 原文件被原地归一化——首行 header.cwd
 *   持久化为 homedir（W11「源文件 header 永久保持旧 cwd」声明已被 W1 取代）
 * - cwd 死 + 含 session_end 行（F3）：strip 与 cwd fallback 两种变换都发生在原文件上
 *
 * 运行：cd packages/runtime && npx vitest run test/session-lifecycle-w11.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

import { SessionLifecycle, setMigrationGate } from '../src/services/session/session-lifecycle.js'
import type { ILifecycleSessionOps, ISessionRegisterDeps } from '../src/services/session/session-internal.js'
import type { IProcessManager } from '../src/services/ports/pi-engine.js'
import type { IConfigStore } from '../src/services/ports/config.js'
import type { ISessionStore } from '../src/services/ports/session.js'
import type { WorkspaceService } from '../src/services/workspace/workspace-service.js'
import type { ScannedSession } from '../src/services/session/types.js'
import type { IEventAdapter } from '../src/interfaces.js'
import type { SessionSummary } from '@taiji/shared'

function makeSummary(id: string): SessionSummary {
  return { id, label: 'test', cwd: '/tmp', status: 'idle', lastActiveAt: Date.now(), modelId: 'p/m', tokenCount: 0 }
}

/** switchSession mock：记录 pi 实际收到的附着路径（W1 后 = 原文件路径本身）。 */
function makeEnv() {
  const switchCalls: string[] = []
  const client = {
    getState: vi.fn(async () => ({ sessionId: 's-1' })),
    switchSession: vi.fn(async (sessionPath: string) => {
      switchCalls.push(sessionPath)
    }),
  }
  // S3 写点归位：注册走真 registerSession（svc.initializeManagedSession 已从接口移除），
  // 装配依赖注入 fake adapterFactory。
  const svc: ILifecycleSessionOps = {
    getExtensionPaths: vi.fn(async () => [] as string[]),
    getSkillPaths: vi.fn(() => [] as string[]),
    getReplaceSystemPrompt: vi.fn(() => undefined),
    getLaunchPresetOptions: vi.fn(async () => undefined),
    toSummary: vi.fn(() => makeSummary('s-restore')),
    findScannedSession: vi.fn(() => undefined),
    removeSessionEntry: vi.fn(),
    fetchAndBroadcastContext: vi.fn(async () => undefined),
    notifySessionCreated: vi.fn(),
    // S2 ISP 化：结构性满足 lifecycle 窄接口（S3 后 10 方法 = 实际消费面），无强转
    getActiveSummaries: vi.fn(() => []),
  }
  const pm = {
    createSession: vi.fn(async () => client),
    destroySession: vi.fn(async () => undefined),
    // D5② 短路预检读点（session-dead-structural-fixes）：undefined = 无 client → 不短路 → 全流程。
    getClient: vi.fn(() => undefined),
  } as unknown as IProcessManager
  const configStore = {
    getDefaultModel: vi.fn(() => ({ provider: 'p', modelId: 'm' })),
  } as unknown as IConfigStore
  const sessionStore = {
    refreshAll: vi.fn(),
    invalidateScanCache: vi.fn(),
  } as unknown as ISessionStore
  const workspaceService = { record: vi.fn() } as unknown as WorkspaceService
  const registerDeps: ISessionRegisterDeps = {
    adapterFactory: () => ({ attach: vi.fn(), detach: vi.fn() }) as unknown as IEventAdapter,
    getMessageBus: () => null,
    broadcastGlobal: () => {},
    notifyMessageComplete: () => {},
  }

  const lifecycle = new SessionLifecycle(svc, pm, configStore, sessionStore, workspaceService, registerDeps)
  return { lifecycle, svc, pm, switchCalls }
}

/** 构造一个含 session header + 消息 entry 的 JSONL 文本。 */
function makeJsonl(cwd: string, opts: { sessionEnd?: boolean } = {}): string {
  const lines = [
    JSON.stringify({ type: 'session', version: 3, id: 's-restore', timestamp: '2026-08-16T01:00:00.000Z', cwd }),
    JSON.stringify({ type: 'message', id: 'u1', parentId: null, timestamp: '2026-08-16T01:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
  ]
  if (opts.sessionEnd) {
    lines.push(JSON.stringify({ type: 'session_end', outcome: 'done', timestamp: '2026-08-16T01:00:02.000Z' }))
  }
  return lines.join('\n') + '\n'
}

describe('restoreSession cwd fallback 落点（W11 → W1 直附着正式文件）', () => {
  let dir: string
  let env: ReturnType<typeof makeEnv>
  let filePath: string

  beforeEach(() => {
    vi.clearAllMocks()
    setMigrationGate(Promise.resolve())
    env = makeEnv()
    dir = mkdtempSync(join(tmpdir(), 'w11-restore-'))
    filePath = join(dir, 'session.jsonl')
  })

  afterEach(() => {
    setMigrationGate(Promise.resolve())
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  function mountTarget(cwd: string): void {
    const target: ScannedSession = {
      id: 's-restore', cwd, filePath, name: 'restored', launchPresetId: undefined,
    } as ScannedSession
    ;(env.svc.findScannedSession as ReturnType<typeof vi.fn>).mockReturnValue(target)
  }

  it('死路径 cwd（F3）：spawn cwd 降级 homedir，原文件 header.cwd 被归一化为 homedir', async () => {
    const deadCwd = join(dir, 'deleted-worktree')
    writeFileSync(filePath, makeJsonl(deadCwd))
    mountTarget(deadCwd)

    await env.lifecycle.restoreSession('s-restore')

    // spawn cwd 降级 homedir（C8：cwdFellBack 时 spawn cwd = homedir）
    expect(env.pm.createSession).toHaveBeenCalledWith('s-restore', homedir(), expect.anything())
    // pi 附着原路径（W1 语义变更：不再附着 $TMPDIR tmp 文件）
    expect(env.switchCalls).toEqual([filePath])
    // [W1 语义变更] 原文件被 F3 归一化原地覆盖：header.cwd 持久化为 homedir
    const after = readFileSync(filePath, 'utf-8')
    const header = JSON.parse(after.split('\n')[0]!)
    expect(header.cwd).toBe(homedir())
    // 消息 entry 保留
    expect(after).toContain('"u1"')
    // 目录无 .tmp-migrate- 临时名残留（rename 已原子完成）
    expect(readdirSync(dir).filter(f => f.includes('.tmp-migrate-'))).toEqual([])
  })

  it('活路径 cwd（F2）：header.cwd 保持原值，源文件零写（与迁移前一致）', async () => {
    const liveCwd = dir
    const original = makeJsonl(liveCwd)
    writeFileSync(filePath, original)
    mountTarget(liveCwd)

    await env.lifecycle.restoreSession('s-restore')

    expect(env.pm.createSession).toHaveBeenCalledWith('s-restore', liveCwd, expect.anything())
    expect(env.switchCalls).toEqual([filePath])
    expect(readFileSync(filePath, 'utf-8')).toBe(original)
  })

  it('死路径 cwd + 历史含 session_end 行（F3）：strip 与 cwd fallback 组合生效', async () => {
    const deadCwd = join(dir, 'another-deleted')
    writeFileSync(filePath, makeJsonl(deadCwd, { sessionEnd: true }))
    mountTarget(deadCwd)

    await env.lifecycle.restoreSession('s-restore')

    const after = readFileSync(filePath, 'utf-8')
    // session_end 行被 strip（防 pi _buildIndex 树索引污染，W9 动机经 W1 复核保留）
    expect(after).not.toContain('session_end')
    // 首行 header cwd 已降级并持久化在原文件
    const header = JSON.parse(after.split('\n')[0]!)
    expect(header.cwd).toBe(homedir())
    // 消息 entry 保留
    expect(after).toContain('"u1"')
    expect(env.switchCalls).toEqual([filePath])
  })
})
