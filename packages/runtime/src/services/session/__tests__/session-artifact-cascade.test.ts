/**
 * 删会话级联删除产物目录单测（chat-html-support §6.7 D7 回收① / §8.2 S8⑥）。
 *
 * 锁定：`SessionLifecycle.delete`（scanned 分支 → `purgeSessionSidecars`）除既有
 * `cache/images` 级联外，同落点、同一幂等形态（`rmSync(recursive, force)`）删除
 * `<dataDir>/artifacts/<sessionId>`；重复删除幂等不抛。
 *
 * 形态对齐 `src/__tests__/session-file-utils-sidecar.test.ts` 的 delete 驱动 harness
 * （trash mock，真实驱动生命周期删链）。产物目录经 shared 公式推导落在 globalSetup
 * 钉扎的 tmp 数据目录内（仓规测试红线：禁触碰真实数据目录）。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/session-artifact-cascade.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSessionArtifactsDir } from '@taiji/shared/paths'
import { SessionLifecycle } from '../session-lifecycle.js'
import type { ILifecycleSessionOps, ISessionRegisterDeps } from '../session-internal.js'
import type { IProcessManager } from '../../ports/pi-engine.js'
import type { IConfigStore } from '../../ports/config.js'
import type { ISessionStore } from '../../ports/session.js'
import type { WorkspaceService } from '../../workspace/workspace-service.js'

/** 唯一 sessionId（文件名形态 `<sid>.jsonl`，解析值 = 全名 → 产物目录名可预期）。 */
function uniqueSid(): string {
  return 'artifactcascade' + Math.random().toString(36).slice(2, 10)
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

describe('SessionLifecycle.delete —— 产物目录级联删除（D7 回收①）', () => {
  it('删会话 → `<dataDir>/artifacts/<sessionId>/` 消失（递归删子树）', async () => {
    const sid = uniqueSid()
    const workDir = mkdtempSync(join(tmpdir(), 'taiji-artifact-cascade-'))
    const filePath = join(workDir, `${sid}.jsonl`)
    writeFileSync(filePath, '{"type":"session"}\n')
    const artifactDir = getSessionArtifactsDir(sid)
    mkdirSync(join(artifactDir, 'assets'), { recursive: true })
    writeFileSync(join(artifactDir, 'report.html'), '<html/>')
    writeFileSync(join(artifactDir, 'assets', 'app.js'), 'console.log(1)')
    expect(existsSync(artifactDir)).toBe(true)

    try {
      const lifecycle = makeLifecycle(sid, filePath, workDir)
      await lifecycle.delete(sid)
      expect(existsSync(artifactDir)).toBe(false)
    } finally {
      rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      rmSync(artifactDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('重复删除幂等：产物目录已不存在时 delete 不抛（force 幂等形态）', async () => {
    const sid = uniqueSid()
    const workDir = mkdtempSync(join(tmpdir(), 'taiji-artifact-cascade-'))
    const filePath = join(workDir, `${sid}.jsonl`)
    writeFileSync(filePath, '{"type":"session"}\n')
    const artifactDir = getSessionArtifactsDir(sid)

    try {
      const lifecycle = makeLifecycle(sid, filePath, workDir)
      await lifecycle.delete(sid) // 首次：目录本就不存在（幂等 no-op）
      await lifecycle.delete(sid) // 再次：仍不抛
      expect(existsSync(artifactDir)).toBe(false)
    } finally {
      rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      rmSync(artifactDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
