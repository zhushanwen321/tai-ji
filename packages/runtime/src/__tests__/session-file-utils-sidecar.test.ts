/**
 * Sidecar 绑定测试（agent binding + model 扫描可见性）。
 *
 * Agent binding（u7-sidecar-persist 验收 A3 + A4）：
 * A3：规则 #6 守卫——session JSONL 不存在时 persistAgentBinding 不创建 sidecar。
 * A3b：缓存失效集成——persistAgentBinding 写入后 sessionMetaCache 失效，scanPiSessions 能立即读到 binding。
 * A4：readAgentBinding 降级路径——sidecar 不存在/JSON 损坏/spawnSource 非法 → undefined。
 *
 * RT-3#3 读侧显形（warn 分支回归守卫）：meta/handoff sidecar 存在但内容非法 JSON 时
 * warnSidecarReadFailureOnce 恰出声一次（ENOENT 不出声）且降级走 JSONL/尾读兜底——
 * 回归即退回「绑定损坏与从未绑定不可区分」的静默态。
 *
 * Model binding（缓存治理批 3 U8 后仅存扫描可见性面）：
 * M1：BINDING_FIELDS 矩阵守卫——modelId/thinkingLevel 四列值符合预期。
 * M2d：「JSONL append model entry → 扫描反向读可见」集成（持久层唯一写方 = pi，
 *     无 taiji 侧写点）。persist 侧用例（M2a-M2c / modelSidecarPath）随 W6 写点退役删除，
 *     反向读语义权威覆盖见 src/infra/pi/__tests__/session-model-reverse-read.test.ts。
 * M3：原 scanSessionMeta 提取 .model.json 容错——断言对象随 U7 读侧切换消失，整块删除。
 * M4：purge 清单含 .model.json。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  persistAgentBinding,
  readAgentBinding,
  agentSidecarPath,
  scanPiSessions,
  invalidateScanDirCache,
  readSessionEndMeta,
  extractSessionOutcome,
  extractHandedOff,
  _resetSessionMetaCacheForTest,
  _resetSidecarWarnDedupForTest,
} from '../infra/pi/session-file-utils.js'
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

// ── RT-3#3 读侧显形：sidecar 存在但内容非法 JSON → warn 一次 + 降级兜底 ──

describe('sidecar 损坏 warn 分支（RT-3#3 非 ENOENT 出声）', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  let dir: string

  beforeEach(() => {
    _resetSidecarWarnDedupForTest()
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    dir = makeTmpDir('rt3-warn-')
  })
  afterEach(() => {
    warnSpy.mockRestore()
    _resetSidecarWarnDedupForTest()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  function writeSessionWithMalformedSidecar(fp: string, sidecarPath: string): void {
    writeFileSync(fp, [
      JSON.stringify({ type: 'session', id: 's1', cwd: '/tmp', timestamp: '2026-01-01' }),
      JSON.stringify({ type: 'session_end', outcome: 'stopped', timestamp: '2026-01-02' }),
      JSON.stringify({ type: 'handoff_marker', handedOffTo: 'legacy-target', timestamp: '2026-01-03' }),
    ].join('\n') + '\n')
    writeFileSync(sidecarPath, 'not valid json {{{')
  }

  it('readSessionEndMeta：meta sidecar 非法 JSON → warn 一次（reason 含 sidecar 路径），返回 null', () => {
    const fp = join(dir, 's1.jsonl')
    const sidecarPath = fp + '.meta.json'
    writeSessionWithMalformedSidecar(fp, sidecarPath)

    expect(readSessionEndMeta(fp)).toBeNull()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const msg = String(warnSpy.mock.calls[0]?.[0])
    expect(msg).toContain('meta sidecar read/parse failed')
    expect(msg).toContain(sidecarPath)
  })

  it('extractSessionOutcome：meta sidecar 非法 JSON → warn 一次 + 走 JSONL 兜底取回终态', () => {
    const fp = join(dir, 's2.jsonl')
    const sidecarPath = fp + '.meta.json'
    writeSessionWithMalformedSidecar(fp, sidecarPath)

    expect(extractSessionOutcome(fp)).toBe('stopped')
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const msg = String(warnSpy.mock.calls[0]?.[0])
    expect(msg).toContain('meta sidecar read failed, falling back to JSONL')
    expect(msg).toContain(sidecarPath)
  })

  it('extractHandedOff：handoff sidecar 非法 JSON → warn 一次 + 走 JSONL 尾读兜底取回交接目标', () => {
    const fp = join(dir, 's3.jsonl')
    const sidecarPath = fp + '.handoff.json'
    writeSessionWithMalformedSidecar(fp, sidecarPath)

    expect(extractHandedOff(fp)).toBe('legacy-target')
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const msg = String(warnSpy.mock.calls[0]?.[0])
    expect(msg).toContain('handoff sidecar read failed, falling back to tail read')
    expect(msg).toContain(sidecarPath)
  })

  it('ENOENT（sidecar 从未写入）→ 保持安静不 warn（正常态不出声）', () => {
    const fp = join(dir, 's4.jsonl')
    writeFileSync(fp, JSON.stringify({ type: 'session', id: 's4', cwd: '/tmp', timestamp: '2026-01-01' }) + '\n')

    expect(extractSessionOutcome(fp)).toBeNull()
    expect(extractHandedOff(fp)).toBeUndefined()
    expect(readSessionEndMeta(fp)).toBeNull()
    expect(warnSpy).not.toHaveBeenCalled()
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

describe('M2d: [U7 反向读] JSONL append model entry 后 scanPiSessions 重扫可见', () => {
  it('外部 pi append 无显式失效，(mtimeMs,size) 变化致 meta 重扫', () => {
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

      // [U8a] 持久层唯一写方 = pi：模型信息经 JSONL append 落盘（真实 pi setModel 行为）。
      // pi 是外部进程不调 taiji 的显式失效——可见性 = 下次真实重扫（force 绕过 1s dir
      // TTL；(mtimeMs,size) 因 append 变化致 meta 缓存 miss 重扫，反向读命中新值）。
      // 原「persistModelBinding 后 force:false 立即可见」随写点退役消失（sidecar 写的
      // 双层失效对 model 字段不再有可观察消费方）。
      appendFileSync(fp, JSON.stringify({ type: 'model_change', provider: 'provider', modelId: 'model1' }) + '\n', 'utf8')
      appendFileSync(fp, JSON.stringify({ type: 'thinking_level_change', thinkingLevel: 'medium' }) + '\n', 'utf8')

      sessions = scanPiSessions({ force: true })
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

// [缓存治理 U7] 原 readModelBinding describe（M3a-M3d：sidecar 缺失/损坏/非法字段容错）
// 随读侧切 JSONL 反向读整块退役——断言对象（sidecar 内容驱动返回值）已不存在，等价语义
// （损坏行跳过 / 非法字段跳过 / 无模型信息 → undefined / sidecar 不再是读取来源）由
// src/infra/pi/__tests__/session-model-reverse-read.test.ts 权威覆盖。

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
