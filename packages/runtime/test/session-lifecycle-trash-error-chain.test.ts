/**
 * G4/u-h4 错误链路端到端（timeout-audit-hygiene-batch 修复轮）：
 * infra trash throw → PiSessionStore.trash 传播（port Promise 语义，不再断头成
 * unhandledRejection）→ SessionLifecycle.delete 上抛 → deleteByCwd 聚合 failed[] →
 * handler 层 session.delete 绝不 reply session.deleted 成功（sendError 归
 * server.ts handleMessage 外层统一收口，P4-1）。
 *
 * Mock 策略：唯一 mock 点 = infra trash（模拟 Finder 繁忙故障注入）；PiSessionStore /
 * SessionLifecycle 用真实实例，错误传播链不被 mock 截断。session 文件用真实 tmp 文件
 * （过 existsSync 守卫，并断言 trash 失败后文件保留在原位置——G4 核心承诺）。
 * svc/pm/configStore/workspace 按 session-lifecycle-deletebycwd.test.ts 范式 mock。
 *
 * 运行：cd packages/runtime && npx vitest run test/session-lifecycle-trash-error-chain.test.ts
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/infra/system/trash.js', () => ({ trash: vi.fn() }))
import { trash } from '../src/infra/system/trash.js'
import { PiSessionStore } from '../src/infra/pi/session-store.js'
import { SessionLifecycle } from '../src/services/session/session-lifecycle.js'
import { SessionMessageHandler } from '../src/transport/session-message-handler.js'
import type { ILifecycleSessionOps } from '../src/services/session/session-internal.js'
import type { ScannedSession } from '../src/services/session/types.js'
import type { IEventAdapter } from '../src/interfaces.js'
import type { IProcessManager, IPiEngine } from '../src/services/ports/pi-engine.js'
import type { IConfigStore } from '../src/services/ports/config.js'
import type { WorkspaceService } from '../src/services/workspace/workspace-service.js'
import type { ClientMessage, SessionSummary } from '@taiji/shared'

const trashMock = vi.mocked(trash)

function makeTmpSessionFile(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'trash-error-chain-'))
  const file = join(dir, 'session-under-delete.jsonl')
  writeFileSync(file, '{}\n', 'utf-8')
  return { dir, file }
}

function makeLifecycle() {
  const workspace = { record: vi.fn() } as unknown as WorkspaceService
  const pm = { destroySession: vi.fn().mockResolvedValue(undefined) } as unknown as IProcessManager
  const configStore = { getDefaultModel: vi.fn(() => undefined) } as unknown as IConfigStore
  const store = new PiSessionStore()
  vi.spyOn(store, 'scanSessions').mockReturnValue([])
  vi.spyOn(store, 'invalidateScanCache').mockImplementation(() => {})
  vi.spyOn(store, 'refreshAll').mockImplementation(() => {})
  const svc = {
    getActiveSummaries: vi.fn((): SessionSummary[] => []),
    removeSessionEntry: vi.fn(),
    findScannedSession: vi.fn(),
  } as unknown as ILifecycleSessionOps
  // S3 迁移跟移（原 MERGE_HEAD 版按旧 ISessionServiceInternal + 5 参构造书写）：
  // sessions Map 所有权已入 SessionLifecycle（this.get 判 active），构造多第 6 参 registerDeps。
  const lifecycle = new SessionLifecycle(svc, pm, configStore, store, workspace, {
    adapterFactory: () => ({ attach: vi.fn(), detach: vi.fn() }) as unknown as IEventAdapter,
    getMessageBus: () => null,
    broadcastGlobal: () => {},
  })
  return { lifecycle, svc, store, pm }
}

function scannedEntry(filePath: string): ScannedSession {
  return { id: 's-trash-1', cwd: '/p', filePath } as unknown as ScannedSession
}

function trashFailure(): Error {
  return new Error(
    '移入废纸篓失败（Finder 未在 5s 内响应或命令失败）。文件已保留在原位置，未做任何删除：x。👉 稍后重试删除；或手动在访达中将该文件拖入废纸篓。',
  )
}

describe('G4/u-h4: trash 失败错误链路端到端（throw 必达调用方，永不静默成功）', () => {
  let tmpFile: string
  let tmpDir: string

  beforeEach(() => {
    trashMock.mockReset().mockRejectedValue(trashFailure())
    ;({ dir: tmpDir, file: tmpFile } = makeTmpSessionFile())
  })
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('① 中间层传播：PiSessionStore.trash 把 infra trash 的 rejection 原样上抛（不再吞成 unhandledRejection）', async () => {
    const { store } = makeLifecycle()
    await expect(store.trash(tmpFile)).rejects.toThrow('移入废纸篓失败')
  })

  it('② scanned 形态端到端：lifecycle.delete 上抛 + 文件保留在原位置（G4：要么废纸篓要么原地报错）', async () => {
    const { lifecycle, svc } = makeLifecycle()
    ;(svc.findScannedSession as ReturnType<typeof vi.fn>).mockReturnValue(scannedEntry(tmpFile))

    await expect(lifecycle.delete('s-trash-1')).rejects.toThrow('移入废纸篓失败')
    // trash 失败 = 文件保留（存在性是用户可验证的恢复前提）
    expect(existsSync(tmpFile)).toBe(true)
  })

  it('③ active 形态端到端：会话已终止（detach/destroy/removeEntry）+ delete 上抛 + 文件保留（V4-1 active 新语义）', async () => {
    const { lifecycle, svc, pm } = makeLifecycle()
    // S3 迁移跟移：active 判定读 lifecycle 自持 Map（this.get），真 registerSession 注册
    // （sessionFilePath 指向 tmp 文件），不再 stub svc.getSession（接口已无此方法）
    await lifecycle.registerSession('s-active-1', {} as unknown as IPiEngine, '/p', 'label', tmpFile)

    await expect(lifecycle.delete('s-active-1')).rejects.toThrow('移入废纸篓失败')
    // 会话已终止 + 条目已移除（报错发生在清理之后，显式声明的 active 形态语义）
    expect(pm.destroySession).toHaveBeenCalledWith('s-active-1')
    expect(svc.removeSessionEntry).toHaveBeenCalledWith('s-active-1')
    expect(existsSync(tmpFile)).toBe(true)
  })

  it('④ deleteByCwd 聚合：trash 失败项进 failed[]（error 含恢复指引），不中断批量', async () => {
    const { lifecycle, svc, store } = makeLifecycle()
    ;(store.scanSessions as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: 's-trash-1', cwd: '/p', filePath: tmpFile },
    ])
    ;(svc.findScannedSession as ReturnType<typeof vi.fn>).mockReturnValue(scannedEntry(tmpFile))

    const result = await lifecycle.deleteByCwd('/p')
    expect(result.deleted).toEqual([])
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]?.sessionId).toBe('s-trash-1')
    expect(result.failed[0]?.error).toContain('移入废纸篓失败')
    expect(result.failed[0]?.error).toContain('稍后重试')
  })

  it('⑤ handler 层：session.delete 遇 trash 失败 → 错误上抛、绝不 reply session.deleted（sendError 归 server.ts 外层收口）', async () => {
    const { lifecycle, svc } = makeLifecycle()
    ;(svc.findScannedSession as ReturnType<typeof vi.fn>).mockReturnValue(scannedEntry(tmpFile))
    const ctx = {
      send: vi.fn(),
      reply: vi.fn(),
      sendError: vi.fn(),
      sessionService: { delete: lifecycle.delete.bind(lifecycle) },
      nextPushId: vi.fn().mockReturnValue('p1'),
      broadcastSessionList: vi.fn(),
    }
    const handler = new SessionMessageHandler(ctx as unknown as ConstructorParameters<typeof SessionMessageHandler>[0])
    const msg = { type: 'session.delete', id: 'm1', payload: { sessionId: 's-trash-1' } } as unknown as ClientMessage

    // handler 不吞错误（真实链：lifecycle → store → infra trash 全真实，仅 trash 注入故障）
    await expect(handler.handleSessionMessage(msg, {} as never)).rejects.toThrow('移入废纸篓失败')
    // 关键：renderer 收不到 session.deleted 成功 reply（否则误判删除成功）
    expect(ctx.reply).not.toHaveBeenCalled()
  })
})
