/**
 * sidecar 绑定写点 × 目录级 TTL 缓存一致性守卫测试（binding-cache-coherence）。
 *
 * 锁定行为（sidecar-binding-sync 设计文档 §3.3 决策 2 / 决策 3 第②类）：全部 sidecar
 * 写点（persistBindingSidecar 骨架 + persistSessionEnd / persistHandoffSidecar 自维护
 * 点 + persistProjectBinding 空 projectId 删除分支）默认失效两层缓存，保证「写后立即可见」。
 *
 * 为什么走无参 scanPiSessions()（TTL 快照路径）：列表广播实际消费的是它——写点不失效
 * 时广播在 1s TTL 窗口内命中 pre-write 快照返回 stale 数据（§2.2 缺陷 B 用户可见现象：
 * 刚归入项目的 session 又弹回默认项目 / 移出项目后 1s 内弹回 P 视图）。force 路径永远
 * 可见，测不出该缺陷，故除填缓存外一律无参扫描。
 *
 * 断言锚定外部夹具事实：期望值只来自手写 JSONL / sidecar 内容，不从实现内部状态
 * （注册表 / 内存 Map）断言——自指断言在变异下恒真（设计文档 A5 论证）。
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  persistProjectBinding,
  persistPresetBinding,
  persistAgentBinding,
  persistHandoffSidecar,
  persistSessionEnd,
  scanPiSessions,
  invalidateScanDirCache,
  projectSidecarPath,
  _resetSessionMetaCacheForTest,
} from '../infra/pi/session-file-utils.js'

/** 合法 JSONL 首行（type=session header），格式与现有 sidecar 测试夹具一致。 */
function sessionHeaderLine(id: string): string {
  return `{"type":"session","id":"${id}","cwd":"/tmp","timestamp":"2026-01-01"}\n`
}

/**
 * 创建隔离的数据目录夹具：TAIJI_AGENT_DATA_DIR 指向独立 tmpdir（getSessionsDir()
 * 经 <data>/agent/sessions 解析），模块级两层缓存清零。返回 createSessionFile 工厂与
 * cleanup（env 恢复 + 缓存清零 + rmSync，放 try/finally 保证断言失败也能清理）。
 */
function setupFixture(prefix: string): {
  createSessionFile: (sessionId: string) => string
  cleanup: () => void
} {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const origDataDir = process.env.TAIJI_AGENT_DATA_DIR
  process.env.TAIJI_AGENT_DATA_DIR = dir
  const sessionsDir = join(dir, 'agent', 'sessions')

  return {
    // mkdir 放工厂内：不需要建文件的用例（暂无）也不会留空目录歧义
    createSessionFile(sessionId: string): string {
      mkdirSync(sessionsDir, { recursive: true })
      const fp = join(sessionsDir, `${sessionId}.jsonl`)
      writeFileSync(fp, sessionHeaderLine(sessionId))
      return fp
    },
    cleanup(): void {
      _resetSessionMetaCacheForTest()
      invalidateScanDirCache()
      if (origDataDir === undefined) {
        delete process.env.TAIJI_AGENT_DATA_DIR
      } else {
        process.env.TAIJI_AGENT_DATA_DIR = origDataDir
      }
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    },
  }
}

// ── 写方向立即可见（A2 类：缺陷 B 写方向，5 写点逐一锁定）──────────────────

describe('persistProjectBinding（.project.json）', () => {
  it('A2: 归入项目后无参 TTL 扫描立即读到新 projectId', () => {
    const f = setupFixture('bcc-proj-')
    try {
      const fp = f.createSessionFile('sess-project')

      // 冷缓存 force 扫描填满两层缓存，确立基线：无 sidecar → projectId undefined
      let sessions = scanPiSessions({ force: true })
      expect(sessions).toHaveLength(1)
      expect(sessions[0].projectId).toBeUndefined()

      persistProjectBinding(fp, 'proj-X')

      // 无参扫描（TTL 快照路径，绝不传 force）：写点失效缓存后新值必须立即可见
      sessions = scanPiSessions()
      expect(sessions).toHaveLength(1)
      expect(sessions[0].projectId).toBe('proj-X')
    } finally {
      f.cleanup()
    }
  })
})

describe('persistPresetBinding（.preset.json）', () => {
  it('A2: 绑定 launch preset 后无参 TTL 扫描立即读到新 presetId', () => {
    const f = setupFixture('bcc-preset-')
    try {
      const fp = f.createSessionFile('sess-preset')

      let sessions = scanPiSessions({ force: true })
      expect(sessions).toHaveLength(1)
      expect(sessions[0].launchPresetId).toBeUndefined()

      persistPresetBinding(fp, 'preset-X')

      sessions = scanPiSessions()
      expect(sessions).toHaveLength(1)
      expect(sessions[0].launchPresetId).toBe('preset-X')
    } finally {
      f.cleanup()
    }
  })
})

describe('persistAgentBinding（.agent.json）', () => {
  it('A2/A4: 记录 agent 来源后无参 TTL 扫描立即读到 spawnSource 与父 session', () => {
    const f = setupFixture('bcc-agent-')
    try {
      const fp = f.createSessionFile('sess-agent')

      let sessions = scanPiSessions({ force: true })
      expect(sessions).toHaveLength(1)
      expect(sessions[0].spawnSource).toBeUndefined()
      expect(sessions[0].parentAgentSessionId).toBeUndefined()

      persistAgentBinding(fp, 'agent', 'parent-x')

      sessions = scanPiSessions()
      expect(sessions).toHaveLength(1)
      expect(sessions[0].spawnSource).toBe('agent')
      expect(sessions[0].parentAgentSessionId).toBe('parent-x')
    } finally {
      f.cleanup()
    }
  })
})

describe('persistHandoffSidecar（.handoff.json）', () => {
  it('A2/A4: handoff 交接后无参 TTL 扫描立即读到 handedOffTo', () => {
    const f = setupFixture('bcc-handoff-')
    try {
      const fp = f.createSessionFile('sess-src')

      let sessions = scanPiSessions({ force: true })
      expect(sessions).toHaveLength(1)
      expect(sessions[0].handedOffTo).toBeUndefined()

      persistHandoffSidecar(fp, 'next-sess')

      sessions = scanPiSessions()
      expect(sessions).toHaveLength(1)
      expect(sessions[0].handedOffTo).toBe('next-sess')
    } finally {
      f.cleanup()
    }
  })
})

describe('persistSessionEnd（.meta.json）', () => {
  it('A2: 会话终态落盘后无参 TTL 扫描立即读到 outcome=error', () => {
    const f = setupFixture('bcc-meta-')
    try {
      const fp = f.createSessionFile('sess-end')

      let sessions = scanPiSessions({ force: true })
      expect(sessions).toHaveLength(1)
      expect(sessions[0].outcome).toBeNull()

      persistSessionEnd(fp, 'error', 'reason-x')

      sessions = scanPiSessions()
      expect(sessions).toHaveLength(1)
      expect(sessions[0].outcome).toBe('error')
    } finally {
      f.cleanup()
    }
  })
})

// ── 删方向立即可见（A9：移出项目，缺陷 B 镜像实例）─────────────────────────

describe('persistProjectBinding 空 projectId 删除分支', () => {
  it('A9: 移出项目（清空归属）后无参 TTL 扫描立即回到 undefined，无 1s 弹回窗口', () => {
    const f = setupFixture('bcc-unbind-')
    try {
      const fp = f.createSessionFile('sess-out')

      // 先绑 P：persistProjectBinding 自身失效缓存，随后的无参扫描从磁盘读到 proj-P 并填充两层缓存
      persistProjectBinding(fp, 'proj-P')
      let sessions = scanPiSessions()
      expect(sessions).toHaveLength(1)
      expect(sessions[0].projectId).toBe('proj-P')

      // 移出项目：unlink sidecar + 失效两层缓存
      persistProjectBinding(fp, '')

      // 若删除分支漏失效目录缓存，此处命中 pre-delete 快照 → proj-P 弹回（缺陷 B 镜像现象）
      sessions = scanPiSessions()
      expect(sessions).toHaveLength(1)
      expect(sessions[0].projectId).toBeUndefined()
    } finally {
      f.cleanup()
    }
  })
})

// ── 负面对照（防恒真：证明本文件走的是真实 TTL 快照路径而非透传直读）──────────

describe('裸写 sidecar 不失效缓存的负面对照', () => {
  it('绕过 helper 的 writeFileSync 直写在 TTL 窗口内不可见，双清缓存后才可见', () => {
    const f = setupFixture('bcc-bare-')
    try {
      const fp = f.createSessionFile('sess-bare')

      // 填满两层缓存（此时无 sidecar）
      let sessions = scanPiSessions({ force: true })
      expect(sessions[0].projectId).toBeUndefined()

      // 绕过 helper 直接裸写 sidecar：不触发任何失效
      writeFileSync(projectSidecarPath(fp), JSON.stringify({ projectId: 'proj-bare', version: 1 }))

      // 立即无参扫描：目录层 TTL 快照命中 pre-write 视图 → stale（≠ 透传直读，裸写若立即可见则本断言恒真化失效）
      sessions = scanPiSessions()
      expect(sessions).toHaveLength(1)
      expect(sessions[0].projectId).toBeUndefined()

      // 仅清目录层再扫：依然 stale——文件层 sessionMetaCache 键只含 JSONL (mtimeMs,size)，
      // sidecar 变更不变 JSONL stat（W2-2 教训声明的机制），单清目录层穿透不了它
      invalidateScanDirCache()
      sessions = scanPiSessions()
      expect(sessions).toHaveLength(1)
      expect(sessions[0].projectId).toBeUndefined()

      // 双清（文件层 + 目录层）后再扫：TTL 首窗为空 → 从磁盘重建，裸写值此刻才可见
      _resetSessionMetaCacheForTest()
      invalidateScanDirCache()
      sessions = scanPiSessions()
      expect(sessions).toHaveLength(1)
      expect(sessions[0].projectId).toBe('proj-bare')
    } finally {
      f.cleanup()
    }
  })
})

// ── 冷启动对照（TTL 首窗为空时正常建立缓存）───────────────────────────────

describe('冷启动对照', () => {
  it('新夹具首次无参扫描即发现 session 及预写 sidecar 的绑定字段', () => {
    const f = setupFixture('bcc-cold-')
    try {
      const fp = f.createSessionFile('sess-cold')
      // 预写 project sidecar（不经 helper，无缓存交互诉求——首窗为空，首扫必然读盘）
      writeFileSync(projectSidecarPath(fp), JSON.stringify({ projectId: 'proj-cold', version: 1 }))

      // 无任何预热（不 force、不预填）：目录层缓存为空 → 正常走磁盘扫描建立缓存
      const sessions = scanPiSessions()
      expect(sessions).toHaveLength(1)
      expect(sessions[0].id).toBe('sess-cold')
      expect(sessions[0].filePath).toBe(fp)
      expect(sessions[0].projectId).toBe('proj-cold')

      // 窗口内的第二次无参扫描同样稳定可见（快照复用语义）
      expect(scanPiSessions()).toHaveLength(1)
    } finally {
      f.cleanup()
    }
  })
})
