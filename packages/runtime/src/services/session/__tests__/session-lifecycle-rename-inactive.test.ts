/**
 * SessionLifecycle.renameSession 非活跃分支（p1p4-closure W1：D3 未命中 throw +
 * findings #4 死 cwd 降级）测试。
 *
 * Mock 策略沿用 session-lifecycle-gate.test.ts 的 makeEnv 形态：svc/pm/sessionStore
 * 全 mock，直接 new SessionLifecycle。pm.withEphemeralPi mock 在「附着瞬间」（fn 执行前）
 * 读目标文件——归一化（若有）必须已发生在附着前，据此断言附着时看到的文件状态。
 * 真实 spawn/RPC 行为归 process-manager-ephemeral.test.ts 与 P1 行为级验收，此处锁
 * renameSession 的编排契约：
 * - 未命中（findScannedSession undefined）→ reject，错误含 sessionId 与恢复指引（D3）
 * - 死 cwd fixture → 附着前归一化：header cwd → homedir、session_end strip、路径不变
 * - 正常 fixture（cwd 活、无 session_end）→ 零变换：附着时字节与 mtime 不变
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/session-lifecycle-rename-inactive.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { SessionLifecycle } from '../session-lifecycle.js'
import type { ILifecycleSessionOps, ISessionRegisterDeps } from '../session-internal.js'
import type { IEventAdapter } from '../../../interfaces.js'
import type { IProcessManager } from '../../ports/pi-engine.js'
import type { IConfigStore } from '../../ports/config.js'
import type { ISessionStore } from '../../ports/session.js'
import type { WorkspaceService } from '../../workspace/workspace-service.js'
import type { ScannedSession } from '../types.js'

/**
 * 构造最小 lifecycle 环境（renameSession 非活跃分支路径）：svc 只需
 * findScannedSession；pm 只需 withEphemeralPi（附着瞬间读文件供断言）。
 */
function makeEnv(scanned?: ScannedSession) {
  // S2 ISP 化：结构性满足 lifecycle 窄接口（10 方法 = 实际消费面），无强转。
  // 本测试路径只真实消费 findScannedSession，其余空 vi.fn 仅为满足接口面
  const svc: ILifecycleSessionOps = {
    findScannedSession: vi.fn(() => scanned ?? undefined),
    toSummary: vi.fn(),
    getSkillPaths: vi.fn(),
    getExtensionPaths: vi.fn(),
    getReplaceSystemPrompt: vi.fn(),
    getLaunchPresetOptions: vi.fn(),
    fetchAndBroadcastContext: vi.fn(),
    removeSessionEntry: vi.fn(),
    notifySessionCreated: vi.fn(),
    getActiveSummaries: vi.fn(),
  }
  const setSessionName = vi.fn(async (_name: string) => ({ success: true }))
  let attachedContent: string | null = null
  const withEphemeralPi = vi.fn(async (sessionFile: string, fn: (client: unknown) => Promise<unknown>) => {
    // 附着瞬间快照：归一化（若发生）必须已落盘，此处看到的即 pi 将附着的文件状态
    attachedContent = readFileSync(sessionFile, 'utf-8')
    return fn({ setSessionName })
  })
  const pm = { withEphemeralPi } as unknown as IProcessManager
  const configStore = {} as unknown as IConfigStore
  const sessionStore = {
    refreshAll: vi.fn(),
    invalidateScanCache: vi.fn(),
  } as unknown as ISessionStore
  const workspaceService = {} as unknown as WorkspaceService

  // S3 写点归位：注册走真 registerSession（svc.initializeManagedSession 已从接口移除），
  // 装配依赖注入 fake adapterFactory。
  const registerDeps: ISessionRegisterDeps = {
    adapterFactory: () => ({ attach: vi.fn(), detach: vi.fn() }) as unknown as IEventAdapter,
    getMessageBus: () => null,
    broadcastGlobal: () => {},
    notifyMessageComplete: () => {},
  }

  const lifecycle = new SessionLifecycle(svc, pm, configStore, sessionStore, workspaceService, registerDeps)
  return { svc, lifecycle, withEphemeralPi, setSessionName, getAttachedContent: () => attachedContent }
}

/** 写最小 session JSONL fixture（header + 一条 user message，可选尾部 session_end 行）。 */
function writeFixture(dir: string, cwd: string, opts?: { sessionEnd?: boolean }): string {
  const filePath = join(dir, 's-rename.jsonl')
  const lines = [
    JSON.stringify({ type: 'session', version: 3, id: 's-rename', timestamp: '2026-08-19T01:00:00.000Z', cwd }),
    JSON.stringify({ type: 'message', id: 'u1', parentId: null, timestamp: '2026-08-19T01:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
  ]
  if (opts?.sessionEnd) {
    lines.push(JSON.stringify({ type: 'session_end', timestamp: '2026-08-19T01:00:02.000Z' }))
  }
  writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8')
  return filePath
}

function makeScanned(cwd: string, filePath: string): ScannedSession {
  return { id: 's-rename', cwd, filePath, name: null, launchPresetId: undefined } as ScannedSession
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('SessionLifecycle.renameSession 非活跃分支（p1p4-closure W1）', () => {
  it('D3：findScannedSession 未命中 → reject，错误含 sessionId 字面值与恢复指引，不附着', async () => {
    const { lifecycle, withEphemeralPi } = makeEnv()

    await expect(lifecycle.renameSession('s-missing', 'new-name'))
      .rejects.toThrow(/s-missing/)
    await expect(lifecycle.renameSession('s-missing', 'new-name'))
      .rejects.toThrow(/refresh the sidebar and verify the session still exists/)
    expect(withEphemeralPi).not.toHaveBeenCalled()
  })

  it('findings #4：死 cwd fixture → 附着前归一化（header cwd → homedir、session_end strip），附着原路径且无新文件，setSessionName 被调', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'w1-rename-deadcwd-'))
    // 死 cwd：不 mkdir 的子路径（模拟 worktree 清理后残留 header）
    const deadCwd = join(dir, 'gone-worktree')
    const filePath = writeFixture(dir, deadCwd, { sessionEnd: true })
    const beforeFiles = readdirSync(dir).sort()
    const { lifecycle, withEphemeralPi, setSessionName, getAttachedContent } = makeEnv(makeScanned(deadCwd, filePath))

    await lifecycle.renameSession('s-rename', 'renamed-name')

    // 附着瞬间（归一化后）文件状态：header cwd 归一化为 homedir、session_end 已剔除、正文保留
    const attached = getAttachedContent()
    expect(attached).not.toBeNull()
    const header = JSON.parse((attached as string).split('\n')[0])
    expect(header.cwd).toBe(homedir())
    expect(attached).not.toContain('session_end')
    expect(attached).toContain('"u1"')
    // 附着目标 = 原文件路径；目录内无新文件产生（tmp-migrate 临时名已被 rename-over 消费）
    expect(withEphemeralPi).toHaveBeenCalledTimes(1)
    expect(withEphemeralPi.mock.calls[0][0]).toBe(filePath)
    expect(readdirSync(dir).sort()).toEqual(beforeFiles)
    // mock 链路等价断言：RPC 以新名在附着的 client 上执行
    expect(setSessionName).toHaveBeenCalledTimes(1)
    expect(setSessionName).toHaveBeenCalledWith('renamed-name')
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('正常 fixture（cwd 活、无 session_end）→ 零变换：附着时与完成后文件字节、mtime 均不变', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'w1-rename-normal-'))
    const filePath = writeFixture(dir, dir)
    const before = readFileSync(filePath)
    const beforeMtime = statSync(filePath).mtimeMs
    const { lifecycle, setSessionName, getAttachedContent } = makeEnv(makeScanned(dir, filePath))

    await lifecycle.renameSession('s-rename', 'renamed-name')

    // 附着瞬间零变换：pi 将附着的文件与 fixture 字节一致
    expect(getAttachedContent()).toBe(before.toString('utf-8'))
    // 完成后仍未被改写（无归一化写盘、mock 链路不写文件）
    expect(readFileSync(filePath).equals(before)).toBe(true)
    expect(statSync(filePath).mtimeMs).toBe(beforeMtime)
    expect(setSessionName).toHaveBeenCalledTimes(1)
    expect(setSessionName).toHaveBeenCalledWith('renamed-name')
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
})
