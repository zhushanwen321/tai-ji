/**
 * 删会话产物目录随整树回收单测（chat-html-support §6.7 D7 回收① / §8.2 S8⑥）。
 *
 * 锁定：`SessionLifecycle.delete`（scanned 分支）删除后，产物目录
 * `<root>/<sessionId>/artifacts/`（session 存储树域 2，shared `getSessionArtifactsDir`
 * 公式推导）随整树软删（trashSessionTree）不再存在于数据目录；重复删除幂等不抛。
 *
 * 形态对齐 `src/__tests__/session-file-utils-sidecar.test.ts` 的 delete 驱动 harness
 * （trash mock，真实驱动生命周期删链）。产物目录经 shared 公式推导落在 globalSetup
 * 固定的 tmp 数据目录内（仓规测试红线：禁触碰真实数据目录）。
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
    // 整树软删 port（D5）：mock 以 rmSync 模拟「目录移入废纸篓」的盘上终态——本测试锚定
    // 「删会话后产物目录不在盘上」；trash 落点语义（废纸篓可恢复）归 infra trash 通道自身覆盖。
    trashDirectory: vi.fn(async (dirPath: string) => {
      rmSync(dirPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }),
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
 * 级联删除用例骨架：建 tmp 会话文件 + （seedArtifactDir 时）产物目录树 → 断言种子在位 →
 * 驱动 `SessionLifecycle.delete` → 用例断言 → finally 双清理（workDir + 产物目录）。
 * 产物目录经 shared 公式推导（globalSetup 固定的 tmp 数据目录内，不触真实数据目录）。
 */
async function withCascadeFixture(
  seedArtifactDir: boolean,
  run: (ctx: { sid: string; filePath: string; artifactDir: string; lifecycle: SessionLifecycle }) => Promise<void>,
): Promise<void> {
  const sid = uniqueSid()
  const workDir = mkdtempSync(join(tmpdir(), 'taiji-artifact-cascade-'))
  const filePath = join(workDir, `${sid}.jsonl`)
  writeFileSync(filePath, '{"type":"session"}\n')
  const artifactDir = getSessionArtifactsDir(sid)
  if (seedArtifactDir) {
    mkdirSync(join(artifactDir, 'assets'), { recursive: true })
    writeFileSync(join(artifactDir, 'report.html'), '<html/>')
    writeFileSync(join(artifactDir, 'assets', 'app.js'), 'console.log(1)')
    expect(existsSync(artifactDir)).toBe(true)
  }

  try {
    const lifecycle = makeLifecycle(sid, filePath, workDir)
    await run({ sid, filePath, artifactDir, lifecycle })
  } finally {
    rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    rmSync(artifactDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
}

describe('SessionLifecycle.delete —— 产物目录随整树回收', () => {
  it('删会话 → 存储树内 `<root>/<sid>/artifacts/` 消失（随整树软删）', async () => {
    await withCascadeFixture(true, async ({ sid, artifactDir, lifecycle }) => {
      await lifecycle.delete(sid)
      expect(existsSync(artifactDir)).toBe(false)
    })
  })

  it('重复删除幂等：产物目录已不存在时 delete 不抛', async () => {
    await withCascadeFixture(false, async ({ sid, artifactDir, lifecycle }) => {
      await lifecycle.delete(sid) // 首次：目录本就不存在（幂等 no-op）
      await lifecycle.delete(sid) // 再次：仍不抛
      expect(existsSync(artifactDir)).toBe(false)
    })
  })
})
