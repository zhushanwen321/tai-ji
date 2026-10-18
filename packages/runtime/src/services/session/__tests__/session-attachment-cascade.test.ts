/**
 * 删会话级联删除粘贴图片附件目录单测。
 *
 * 锁定：`SessionLifecycle.delete`（scanned 分支 → `purgeSessionSidecars`）除既有
 * `cache/images` / `artifacts` 级联外，同落点、同一幂等形态（`rmSync(recursive, force)`）
 * 删除 `<dataDir>/attachments/<sessionId>`；重复删除幂等不抛。
 *
 * 形态对齐 `session-artifact-cascade.test.ts` 的 delete 驱动 harness（trash mock，
 * 真实驱动生命周期删链）。附件目录经 shared 公式推导落在 globalSetup 固定的 tmp
 * 数据目录内（仓规测试红线：禁触碰真实数据目录）。
 *
 * 运行：cd packages/runtime && vitest run src/services/session/__tests__/session-attachment-cascade.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getAttachmentsDir } from '@taiji/shared/paths'
import { SessionLifecycle } from '../session-lifecycle.js'
import type { ILifecycleSessionOps, ISessionRegisterDeps } from '../session-internal.js'
import type { IProcessManager } from '../../ports/pi-engine.js'
import type { IConfigStore } from '../../ports/config.js'
import type { ISessionStore } from '../../ports/session.js'
import type { WorkspaceService } from '../../workspace/workspace-service.js'

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
 * 级联删除用例骨架：建 tmp 会话文件 +（seedAttachmentDir 时）附件目录树 → 断言种子在位 →
 * 驱动 `SessionLifecycle.delete` → 用例断言 → finally 双清理（workDir + 附件目录）。
 * 附件目录经 shared 公式推导（globalSetup 固定的 tmp 数据目录内，不触真实数据目录）。
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
    rmSync(attachmentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
}

describe('SessionLifecycle.delete —— 附件目录级联删除', () => {
  it('删会话 → `<dataDir>/attachments/<sessionId>/` 消失（递归删子树）', async () => {
    await withCascadeFixture(true, async ({ sid, attachmentDir, lifecycle }) => {
      await lifecycle.delete(sid)
      expect(existsSync(attachmentDir)).toBe(false)
    })
  })

  it('重复删除幂等：附件目录已不存在时 delete 不抛（force 幂等形态）', async () => {
    await withCascadeFixture(false, async ({ sid, attachmentDir, lifecycle }) => {
      await lifecycle.delete(sid) // 首次：目录本就不存在（幂等 no-op）
      await lifecycle.delete(sid) // 再次：仍不抛
      expect(existsSync(attachmentDir)).toBe(false)
    })
  })
})
