/**
 * 删会话级联删除粘贴图片附件目录单测。
 *
 * 锁定：`SessionLifecycle.delete`（scanned 分支 → 级联的**整树软删**）删除
 * `<root>/<sessionId>/` 整棵树——附件目录（shared getAttachmentsDir 公式 =
 * `<root>/<sid>/attachments`）随树回收；重复删除幂等不抛。
 *
 * [session-store-layout-inversion D5] 附件目录的删除面从「purgeSessionSidecars 内
 * rmSync 逐域删」收敛为「整树软删」——落点公式不变（shared SSOT），删除单元变成树。
 *
 * 整树软删走真实 trashDirectory：platform 钉 linux（任何宿主机都走非 mac 降级
 * rmSync 分支，断言落盘效果）；child_process 整模块 mock 兜底锁定零子进程（不触真实
 * 废纸篓）。附件目录经 shared 公式推导落在 globalSetup 钉扎的 tmp 数据目录内
 * （仓规测试红线：禁触碰真实数据目录）。
 *
 * 运行：cd packages/runtime && vitest run src/services/session/__tests__/session-attachment-cascade.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { getAttachmentsDir, getSessionStoreDir } from '@taiji/shared/paths'
import { SessionLifecycle } from '../session-lifecycle.js'
import { trashDirectory } from '../../../infra/system/trash.js'
import type { ILifecycleSessionOps, ISessionRegisterDeps } from '../session-internal.js'
import type { IProcessManager } from '../../ports/pi-engine.js'
import type { IConfigStore } from '../../ports/config.js'
import type { ISessionStore } from '../../ports/session.js'
import type { WorkspaceService } from '../../workspace/workspace-service.js'

// D5 整树软删（trashDirectory）确定性化：platform 钉 linux → 非 mac 降级 rmSync 分支
// （真实 fs 效果，落在 globalSetup 钉扎的 tmp 数据目录内）；execFileSync mock 兜底
// 锁定零子进程（任何残留 mac 分支都不会触真实废纸篓）。
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, platform: () => 'linux' }
})
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFileSync: vi.fn() }
})

/** 唯一 sessionId（须匹配 getAttachmentsDir 的 `^[A-Za-z0-9_-]+$` 穿越校验）。 */
function uniqueSid(): string {
  return 'attachcascade' + Math.random().toString(36).slice(2, 10)
}

function makeLifecycle(sid: string, filePath: string, cwd: string): SessionLifecycle {
  const svc = {
    findScannedSession: vi.fn(() => ({
      id: sid,
      filePath,
      cwd,
      timestamp: new Date().toISOString(),
      name: 'test',
      outcome: null,
      lastModified: Date.now(),
      size: 100,
    })),
    removeSessionEntry: vi.fn(),
  } as unknown as ILifecycleSessionOps
  const sessionStore = {
    trash: vi.fn(async () => {}),
    // D5 整树软删经 ISessionStore.trashDirectory 端口（组合根注入 infra trashDirectory）：
    // mock 同源委托真实 infra 函数——platform 钉 linux 走 rmSync 分支，保住「真实 fs
    // 落盘效果」断言意图（no-op mock 会让树留在原地、断言必红）。
    trashDirectory: (dirPath: string) => trashDirectory(dirPath),
    invalidateMetaCache: vi.fn(),
    invalidateScanCache: vi.fn(),
    refreshAll: vi.fn(),
  } as unknown as ISessionStore
  const registerDeps = {
    adapterFactory: vi.fn(),
    getMessageBus: vi.fn(() => null),
    broadcastGlobal: vi.fn(),
  } as unknown as ISessionRegisterDeps
  return new SessionLifecycle(
    svc,
    {} as unknown as IProcessManager,
    {} as unknown as IConfigStore,
    sessionStore,
    {} as unknown as WorkspaceService,
    registerDeps,
  )
}

/**
 * 级联删除用例骨架：建 tmp 会话文件 +（seedAttachmentDir 时）树内附件目录树 → 断言种子在位 →
 * 驱动 `SessionLifecycle.delete` → 用例断言 → finally 双清理（workDir + session 存储树目录）。
 * 树目录经 shared 公式推导（globalSetup 钉扎的 tmp 数据目录内，不触真实数据目录）。
 */
async function withCascadeFixture(
  seedAttachmentDir: boolean,
  run: (ctx: { sid: string; filePath: string; attachmentDir: string; lifecycle: SessionLifecycle }) => Promise<void>,
): Promise<void> {
  const sid = uniqueSid()
  const workDir = mkdtempSync(join(tmpdir(), 'taiji-attachment-cascade-'))
  const filePath = join(workDir, `${sid}.jsonl`)
  writeFileSync(filePath, '{"type":"session"}\n')
  const attachmentDir = getAttachmentsDir(sid)
  if (seedAttachmentDir) {
    mkdirSync(attachmentDir, { recursive: true })
    writeFileSync(join(attachmentDir, 'paste-1.png'), 'png-bytes')
    writeFileSync(join(attachmentDir, 'paste-2.png'), 'png-bytes')
    expect(existsSync(attachmentDir)).toBe(true)
  }

  try {
    const lifecycle = makeLifecycle(sid, filePath, workDir)
    await run({ sid, filePath, attachmentDir, lifecycle })
  } finally {
    rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    // 整树软删的残留面（树删失败 / 未建树的形态）+ 附件目录自身一并清理
    rmSync(join(getSessionStoreDir(), sid), { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    rmSync(attachmentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
}

describe('SessionLifecycle.delete —— 附件目录随整树软删回收', () => {
  it('删会话 → `<root>/<sessionId>/` 整树消失（附件目录随树进废纸篓）', async () => {
    await withCascadeFixture(true, async ({ sid, attachmentDir, lifecycle }) => {
      await lifecycle.delete(sid)
      expect(existsSync(attachmentDir)).toBe(false)
      expect(existsSync(join(getSessionStoreDir(), sid))).toBe(false)
    })
  })

  it('重复删除幂等：树已不存在时 delete 不抛（存在性守卫，不空跑软删通道）', async () => {
    await withCascadeFixture(false, async ({ sid, attachmentDir, lifecycle }) => {
      await lifecycle.delete(sid) // 首次：树本就不存在（幂等 no-op）
      await lifecycle.delete(sid) // 再次：仍不抛
      expect(existsSync(attachmentDir)).toBe(false)
    })
  })
})
