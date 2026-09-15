/**
 * Sidecar 绑定测试（agent + model binding）。
 *
 * Agent binding（u7-sidecar-persist 验收 A3 + A4）：
 * A3：规则 #6 守卫——session JSONL 不存在时 persistAgentBinding 不创建 sidecar。
 * A3b：缓存失效集成——persistAgentBinding 写入后 sessionMetaCache 失效，scanPiSessions 能立即读到 binding。
 * A4：readAgentBinding 降级路径——sidecar 不存在/JSON 损坏/spawnSource 非法 → undefined。
 *
 * Model binding（model-sidecar 测试）：
 * M1：BINDING_FIELDS 矩阵守卫——modelId/thinkingLevel 四列值符合预期。
 * M2：persistModelBinding 原子写 + JSONL 缺失不创建守卫 + 写失败吞错 + cache invalidation。
 * M3：scanSessionMeta 提取 .model.json（含缺失/损坏 sidecar 容错）。
 * M4：purge 清单含 .model.json。
 */

import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  persistAgentBinding,
  readAgentBinding,
  agentSidecarPath,
  scanPiSessions,
  invalidateScanDirCache,
  _resetSessionMetaCacheForTest,
} from '../infra/pi/session-file-utils.js'
// model sidecar 家族自 session-file-utils 迁出（max-lines 行数合规），权威源在本模块。
import { modelSidecarPath, persistModelBinding, readModelBinding } from '../infra/pi/session-model-sidecar.js'
import { BINDING_FIELDS } from '../infra/pi/session-binding-fields.js'
import type { SessionLifecycle } from '../services/session/session-lifecycle.js'
import type { ILifecycleSessionOps, ISessionRegisterDeps } from '../services/session/session-internal.js'
import type { IConfigStore } from '../services/ports/config.js'
import type { ISessionStore } from '../services/ports/session.js'
import type { IProcessManager } from '../services/ports/pi-engine.js'
import type { WorkspaceService } from '../services/workspace/workspace-service.js'

function makeTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('persistAgentBinding', () => {
  it('A3: 规则 #6 守卫——session JSONL 不存在时不创建 sidecar', () => {
    const dir = makeTmpDir('u7-a3-')
    try {
      const nonExistentFile = join(dir, 'nonexistent.jsonl')
      // 确保文件确实不存在
      expect(existsSync(nonExistentFile)).toBe(false)

      // 记录 sidecar 目录下的文件数量（应为 0）
      const sidecarPath = agentSidecarPath(nonExistentFile)
      const sidecarDir = join(dir, 'sidecar-check')
      mkdirSync(sidecarDir, { recursive: true })
      const filesBefore = existsSync(sidecarPath) ? 1 : 0

      // 调用 persistAgentBinding，文件不存在应静默跳过
      persistAgentBinding(nonExistentFile, 'agent', 'parent-123')

      // 验证 sidecar 未被创建
      const filesAfter = existsSync(sidecarPath) ? 1 : 0
      expect(filesAfter).toBe(filesBefore)
      expect(existsSync(sidecarPath)).toBe(false)

      // 验证 sidecar 目录下没有新增文件（确保没有创建其他文件）
      const { readdirSync } = require('node:fs')
      const sidecarFiles = readdirSync(dir).filter((f: string) => f.includes('.agent.json'))
      expect(sidecarFiles.length).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('A1-positive: 文件存在时 sidecar 被正确创建且 readAgentBinding 回读一致（正向对照）', () => {
    const dir = makeTmpDir('u7-a1-pos-')
    try {
      const fp = join(dir, 'test.jsonl')
      writeFileSync(fp, '{"type":"session","id":"s1","cwd":"/tmp","timestamp":"2026-01-01"}\n')

      // 确保 sidecar 不存在
      const sidecarPath = agentSidecarPath(fp)
      expect(existsSync(sidecarPath)).toBe(false)

      // 调用 persistAgentBinding，文件存在应创建 sidecar
      persistAgentBinding(fp, 'agent', 'parent-123')

      // 验证 sidecar 被创建
      expect(existsSync(sidecarPath)).toBe(true)

      // 验证 sidecar 内容
      const { readFileSync } = require('node:fs')
      const data = JSON.parse(readFileSync(sidecarPath, 'utf-8'))
      expect(data.spawnSource).toBe('agent')
      expect(data.parentAgentSessionId).toBe('parent-123')
      expect(data.version).toBe(1)

      // readAgentBinding 回读验证
      const result = readAgentBinding(fp)
      expect(result).toBeDefined()
      expect(result!.spawnSource).toBe('agent')
      expect(result!.parentAgentSessionId).toBe('parent-123')
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})

describe('A3b: 缓存失效集成', () => {
  it('A2: scanSessionMeta 合并 agent binding——persistAgentBinding 写入后 sessionMetaCache 失效，scanPiSessions({ force: false }) 能立即读到 binding', () => {
    const dir = makeTmpDir('u7-a3b-')
    try {
      // 设置临时数据目录
      const origDataDir = process.env.TAIJI_AGENT_DATA_DIR
      process.env.TAIJI_AGENT_DATA_DIR = dir

      // 重置缓存
      _resetSessionMetaCacheForTest()
      invalidateScanDirCache()

      // 创建 session 文件
      const sessionsDir = join(dir, 'agent', 'sessions')
      mkdirSync(sessionsDir, { recursive: true })
      const fp = join(sessionsDir, 'test.jsonl')
      writeFileSync(fp, '{"type":"session","id":"s1","cwd":"/tmp","timestamp":"2026-01-01"}\n')

      // 先扫描一次，填充缓存
      let sessions = scanPiSessions({ force: true })
      expect(sessions.length).toBe(1)
      expect(sessions[0].spawnSource).toBeUndefined()

      // 写入 agent binding
      persistAgentBinding(fp, 'agent', 'parent-123')

      // 再次扫描（force:false 走正常缓存路径），应该能读到 binding（缓存已失效）
      sessions = scanPiSessions({ force: false })
      expect(sessions.length).toBe(1)
      expect(sessions[0].spawnSource).toBe('agent')
      expect(sessions[0].parentAgentSessionId).toBe('parent-123')

      // 恢复环境变量
      if (origDataDir !== undefined) {
        process.env.TAIJI_AGENT_DATA_DIR = origDataDir
      } else {
        delete process.env.TAIJI_AGENT_DATA_DIR
      }
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})

describe('readAgentBinding', () => {
  it('A4 case1: sidecar 不存在返回 undefined', () => {
    const dir = makeTmpDir('u7-a4-1-')
    try {
      const fp = join(dir, 'test.jsonl')
      writeFileSync(fp, '{"type":"session","id":"s1","cwd":"/tmp","timestamp":"2026-01-01"}\n')

      // 无 sidecar 文件
      const result = readAgentBinding(fp)
      expect(result).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('A4 case2: JSON 损坏返回 undefined', () => {
    const dir = makeTmpDir('u7-a4-2-')
    try {
      const fp = join(dir, 'test.jsonl')
      writeFileSync(fp, '{"type":"session","id":"s1","cwd":"/tmp","timestamp":"2026-01-01"}\n')

      // 写入损坏的 JSON
      const sidecarPath = agentSidecarPath(fp)
      writeFileSync(sidecarPath, 'not valid json {{{')

      const result = readAgentBinding(fp)
      expect(result).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('A4 case3: spawnSource 非法返回 undefined', () => {
    const dir = makeTmpDir('u7-a4-3-')
    try {
      const fp = join(dir, 'test.jsonl')
      writeFileSync(fp, '{"type":"session","id":"s1","cwd":"/tmp","timestamp":"2026-01-01"}\n')

      // 写入 spawnSource 非字符串的 sidecar
      const sidecarPath = agentSidecarPath(fp)
      writeFileSync(sidecarPath, JSON.stringify({ spawnSource: 123, parentAgentSessionId: 'parent-123', version: 1 }))

      const result = readAgentBinding(fp)
      expect(result).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('A4 case4: parentAgentSessionId 非法 → 仅该字段 undefined，spawnSource 保留（#15 语义）', () => {
    const dir = makeTmpDir('u7-a4-4-')
    try {
      const fp = join(dir, 'test.jsonl')
      writeFileSync(fp, '{"type":"session","id":"s1","cwd":"/tmp","timestamp":"2026-01-01"}\n')

      // 写入 parentAgentSessionId 非字符串的 sidecar
      const sidecarPath = agentSidecarPath(fp)
      writeFileSync(sidecarPath, JSON.stringify({ spawnSource: 'agent', parentAgentSessionId: null, version: 1 }))

      const result = readAgentBinding(fp)
      expect(result?.spawnSource).toBe('agent')
      expect(result?.parentAgentSessionId).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})

// ── Model binding sidecar 测试 ─────────────────────────────────

describe('M1: BINDING_FIELDS 矩阵守卫', () => {
  it('modelId 四列 = create:options / handoff:options / restore:none / fork:options', () => {
    expect(BINDING_FIELDS.modelId.entries.create).toBe('options')
    expect(BINDING_FIELDS.modelId.entries.handoff).toBe('options')
    expect(BINDING_FIELDS.modelId.entries.restore).toBe('none')
    expect(BINDING_FIELDS.modelId.entries.fork).toBe('options')
  })

  it('thinkingLevel 四列 = create:options / handoff:options / restore:none / fork:options', () => {
    expect(BINDING_FIELDS.thinkingLevel.entries.create).toBe('options')
    expect(BINDING_FIELDS.thinkingLevel.entries.handoff).toBe('options')
    expect(BINDING_FIELDS.thinkingLevel.entries.restore).toBe('none')
    expect(BINDING_FIELDS.thinkingLevel.entries.fork).toBe('options')
  })
})

describe('modelSidecarPath', () => {
  it('返回 filePath + .model.json', () => {
    expect(modelSidecarPath('/tmp/s.jsonl')).toBe('/tmp/s.jsonl.model.json')
  })
})

describe('persistModelBinding', () => {
  it('M2a: JSONL 不存在时不创建 sidecar（规则 #6 守卫）', () => {
    const dir = makeTmpDir('model-a3-')
    try {
      const nonExistentFile = join(dir, 'nonexistent.jsonl')
      expect(existsSync(nonExistentFile)).toBe(false)
      const sidecarPath = modelSidecarPath(nonExistentFile)
      persistModelBinding(nonExistentFile, 'provider/model1', 'high')
      expect(existsSync(sidecarPath)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('M2b: 文件存在时 sidecar 被正确创建且 readModelBinding 回读一致', () => {
    const dir = makeTmpDir('model-a1-')
    try {
      const fp = join(dir, 'test.jsonl')
      writeFileSync(fp, '{"type":"session","id":"s1","cwd":"/tmp","timestamp":"2026-01-01"}\n')
      const sidecarPath = modelSidecarPath(fp)
      expect(existsSync(sidecarPath)).toBe(false)

      persistModelBinding(fp, 'xiaomi/mimo-v2.5-pro', 'high')

      expect(existsSync(sidecarPath)).toBe(true)
      const { readFileSync } = require('node:fs')
      const data = JSON.parse(readFileSync(sidecarPath, 'utf-8'))
      expect(data.modelId).toBe('xiaomi/mimo-v2.5-pro')
      expect(data.thinkingLevel).toBe('high')
      expect(data.version).toBe(1)

      const result = readModelBinding(fp)
      expect(result).toBeDefined()
      expect(result!.modelId).toBe('xiaomi/mimo-v2.5-pro')
      expect(result!.thinkingLevel).toBe('high')
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('M2c: modelId 为空串时不写 sidecar', () => {
    const dir = makeTmpDir('model-empty-')
    try {
      const fp = join(dir, 'test.jsonl')
      writeFileSync(fp, '{"type":"session","id":"s1","cwd":"/tmp","timestamp":"2026-01-01"}\n')
      const sidecarPath = modelSidecarPath(fp)
      persistModelBinding(fp, '', 'high')
      expect(existsSync(sidecarPath)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('M2d: cache invalidation — persistModelBinding 后 scanPiSessions 能立即读到', () => {
    const dir = makeTmpDir('model-cache-')
    try {
      const origDataDir = process.env.TAIJI_AGENT_DATA_DIR
      process.env.TAIJI_AGENT_DATA_DIR = dir
      _resetSessionMetaCacheForTest()
      invalidateScanDirCache()

      const sessionsDir = join(dir, 'agent', 'sessions')
      mkdirSync(sessionsDir, { recursive: true })
      const fp = join(sessionsDir, 'test.jsonl')
      writeFileSync(fp, '{"type":"session","id":"s1","cwd":"/tmp","timestamp":"2026-01-01"}\n')

      let sessions = scanPiSessions({ force: true })
      expect(sessions.length).toBe(1)
      expect(sessions[0].modelId).toBeUndefined()

      persistModelBinding(fp, 'provider/model1', 'medium')

      sessions = scanPiSessions({ force: false })
      expect(sessions.length).toBe(1)
      expect(sessions[0].modelId).toBe('provider/model1')
      expect(sessions[0].thinkingLevel).toBe('medium')

      if (origDataDir !== undefined) {
        process.env.TAIJI_AGENT_DATA_DIR = origDataDir
      } else {
        delete process.env.TAIJI_AGENT_DATA_DIR
      }
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})

describe('readModelBinding', () => {
  it('M3a: sidecar 不存在返回 undefined', () => {
    const dir = makeTmpDir('model-r1-')
    try {
      const fp = join(dir, 'test.jsonl')
      writeFileSync(fp, '{"type":"session","id":"s1","cwd":"/tmp","timestamp":"2026-01-01"}\n')
      const result = readModelBinding(fp)
      expect(result).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('M3b: JSON 损坏返回 undefined', () => {
    const dir = makeTmpDir('model-r2-')
    try {
      const fp = join(dir, 'test.jsonl')
      writeFileSync(fp, '{"type":"session","id":"s1","cwd":"/tmp","timestamp":"2026-01-01"}\n')
      writeFileSync(modelSidecarPath(fp), 'not valid json {{{')
      const result = readModelBinding(fp)
      expect(result).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('M3c: modelId 非字符串返回 undefined', () => {
    const dir = makeTmpDir('model-r3-')
    try {
      const fp = join(dir, 'test.jsonl')
      writeFileSync(fp, '{"type":"session","id":"s1","cwd":"/tmp","timestamp":"2026-01-01"}\n')
      writeFileSync(modelSidecarPath(fp), JSON.stringify({ modelId: 123, thinkingLevel: 'high', version: 1 }))
      const result = readModelBinding(fp)
      expect(result).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('M3d: thinkingLevel 非字符串 → thinkingLevel 降级空串，modelId 保留', () => {
    const dir = makeTmpDir('model-r4-')
    try {
      const fp = join(dir, 'test.jsonl')
      writeFileSync(fp, '{"type":"session","id":"s1","cwd":"/tmp","timestamp":"2026-01-01"}\n')
      writeFileSync(modelSidecarPath(fp), JSON.stringify({ modelId: 'p/m', thinkingLevel: null, version: 1 }))
      const result = readModelBinding(fp)
      expect(result?.modelId).toBe('p/m')
      expect(result?.thinkingLevel).toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})

describe('M4: purge 清单含 .model.json', () => {
  it('delete（scanned 分支）驱动 purgeSessionSidecars，.model.json 与其他 sidecar 后缀一并清理', async () => {
    const dir = makeTmpDir('model-purge-')
    try {
      const fp = join(dir, 'test.jsonl')
      writeFileSync(fp, '{"type":"session","id":"s1","cwd":"/tmp","timestamp":"2026-01-01"}\n')
      const suffixes = ['.meta.json', '.preset.json', '.project.json', '.handoff.json', '.agent.json', '.model.json']
      for (const suffix of suffixes) {
        writeFileSync(fp + suffix, '{}')
        expect(existsSync(fp + suffix)).toBe(true)
      }

      // 真实驱动 SessionLifecycle.delete（scanned 分支 → purgeSessionSidecars）：
      // trash 用 mock（主文件留原地，只验 sidecar unlink），其余 store 方法 mock。
      const { SessionLifecycle: LC } = await import('../services/session/session-lifecycle.js') as {
        SessionLifecycle: typeof SessionLifecycle
      }
      const svc = {
        findScannedSession: vi.fn(() => ({
          id: 's1', filePath: fp, cwd: dir, timestamp: new Date().toISOString(),
          name: 'test', outcome: null, lastModified: Date.now(), size: 100,
        })),
      } as unknown as ILifecycleSessionOps
      const sessionStore = {
        trash: vi.fn(async () => {}),
        invalidateMetaCache: vi.fn(),
        invalidateScanCache: vi.fn(),
        refreshAll: vi.fn(),
      } as unknown as ISessionStore
      const lifecycle = new LC(
        svc, {} as unknown as IProcessManager, {} as unknown as IConfigStore,
        sessionStore, {} as unknown as WorkspaceService,
        { adapterFactory: vi.fn(), getMessageBus: vi.fn(() => null), broadcastGlobal: vi.fn(), notifySessionComplete: vi.fn() } as unknown as ISessionRegisterDeps,
      )
      await lifecycle.delete('s1')

      // trash 被 mock → 主文件仍在原地；全部 sidecar 必须被真实 unlink。
      // 若 purgeSessionSidecars 清单漏掉 .model.json，此处 existsSync 断言变红。
      expect(existsSync(fp)).toBe(true)
      for (const suffix of suffixes) {
        expect(existsSync(fp + suffix)).toBe(false)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
