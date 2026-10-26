/**
 * session-file-utils 合并测试（cluster：sidecar 绑定写点 / TTL 缓存一致性 / 残留清扫 /
 * session 终态 sidecar / 归一化回滚）。
 *
 * 来源（分节注释见内）：
 * - binding-cache-coherence（写点 × 目录级 TTL 缓存一致性）
 * - session-file-utils-model-sidecar-residue（退役 .model.json 残留清扫 U9）
 * - session-file-utils-tmp-migrate（W3 残留清理四态 + 端到端）
 * - session-scan-degraded（scanPiSessions 降级显形 RT-3#2）
 * - session-end-entry（persistSessionEnd + extractSessionOutcome round-trip W4/W5）
 * - session-file-utils-migrate-cleanup（rename 失败回滚 suggestion 6）
 *
 * 未并入：preset-sidecar-io（文件级 vi.mock('node:fs') 工厂只透传部分 fs 导出，与其余
 * 各节真实 fs 调用结构性不相容）、scan-external（主被测对象 session-file-external-scan）。
 *
 * 运行：cd packages/runtime && npx vitest run test/session-file-utils.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
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
  cleanupTmpMigrateResidue,
  extractSessionOutcome,
  normalizeSessionFileInPlace,
  cleanupMigrateResidues,
  type SessionOutcome,
} from '../src/infra/pi/session-file-utils.js'

// ════════════════ 来源: binding-cache-coherence.test.ts ════════════════

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

// ════════════════ 来源: session-file-utils-model-sidecar-residue.test.ts ════════════════

/** 写一个最小文件（内容非本测试关注面），返回绝对路径。 */
function writeSidecarResidueFile(dir: string, name: string, content = '{}\n'): string {
  const filePath = join(dir, name)
  writeFileSync(filePath, content, 'utf-8')
  return filePath
}

describe('cleanupTmpMigrateResidue U9 家族（退役 .model.json sidecar 残留清扫）', () => {
  let dataDir: string
  let sessionsDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'u9-sidecar-residue-'))
    sessionsDir = join(dataDir, 'agent', 'sessions')
    mkdirSync(sessionsDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('残留 .model.json 删除（根目录 + cwd 子目录两层），JSONL 主文件不受影响', () => {
    const subDir = join(sessionsDir, '--Users-x-proj--')
    const rootJsonl = writeSidecarResidueFile(sessionsDir, 'sess-root.jsonl', '{"type":"session","id":"sess-root"}\n')
    const rootSidecar = writeSidecarResidueFile(sessionsDir, 'sess-root.jsonl.model.json', '{"modelId":"a/b"}')
    mkdirSync(subDir, { recursive: true })
    const subJsonl = writeSidecarResidueFile(subDir, 'sess-sub.jsonl', '{"type":"session","id":"sess-sub"}\n')
    const subSidecar = writeSidecarResidueFile(subDir, 'sess-sub.jsonl.model.json', '{"modelId":"c/d"}')

    // 启动挂点的调用形态：默认 maxAgeMs（U9 家族不受该参数约束）
    const removed = cleanupTmpMigrateResidue(sessionsDir)

    expect(removed).toBe(2)
    expect(existsSync(rootSidecar)).toBe(false)
    expect(existsSync(subSidecar)).toBe(false)
    expect(existsSync(rootJsonl)).toBe(true)
    expect(existsSync(subJsonl)).toBe(true)
  })

  it('年龄无关全删：刚写入的 sidecar 残留也删（对比：新鲜 tmp 标记残留仍按龄保留）', () => {
    const freshSidecar = writeSidecarResidueFile(sessionsDir, 'sess-1.jsonl.model.json', '{"modelId":"a/b"}')
    const freshTmp = writeSidecarResidueFile(sessionsDir, 'sess-1.jsonl.tmp-import-999.jsonl')

    const removed = cleanupTmpMigrateResidue(sessionsDir)

    expect(removed).toBe(1)
    expect(existsSync(freshSidecar)).toBe(false)
    expect(existsSync(freshTmp)).toBe(true)
  })

  it('目录无残留时零操作不抛（无 sidecar / 目录不存在均返回 0）', () => {
    writeSidecarResidueFile(sessionsDir, 'sess-1.jsonl', '{"type":"session","id":"sess-1"}\n')

    expect(cleanupTmpMigrateResidue(sessionsDir)).toBe(0)
    expect(cleanupTmpMigrateResidue(join(dataDir, 'no-such-dir'))).toBe(0)
    expect(existsSync(sessionsDir)).toBe(true)
  })

  it('只删 *.jsonl.model.json 形态：现存 sidecar 与其他命名不误删', () => {
    const metaSidecar = writeSidecarResidueFile(sessionsDir, 'sess-1.jsonl.meta.json')
    const handoffSidecar = writeSidecarResidueFile(sessionsDir, 'sess-1.jsonl.handoff.json')
    const bareModel = writeSidecarResidueFile(sessionsDir, 'notes.model.json')
    const bakSuffix = writeSidecarResidueFile(sessionsDir, 'sess-1.jsonl.model.json.bak')
    const residue = writeSidecarResidueFile(sessionsDir, 'sess-2.jsonl.model.json', '{"modelId":"x/y"}')

    const removed = cleanupTmpMigrateResidue(sessionsDir)

    expect(removed).toBe(1)
    expect(existsSync(residue)).toBe(false)
    expect(existsSync(metaSidecar)).toBe(true)
    expect(existsSync(handoffSidecar)).toBe(true)
    expect(existsSync(bareModel)).toBe(true)
    expect(existsSync(bakSuffix)).toBe(true)
  })

  it('幂等：清扫后二次执行返回 0 不抛', () => {
    writeSidecarResidueFile(sessionsDir, 'sess-1.jsonl.model.json', '{"modelId":"a/b"}')
    expect(cleanupTmpMigrateResidue(sessionsDir)).toBe(1)

    expect(cleanupTmpMigrateResidue(sessionsDir)).toBe(0)
  })
})

// ════════════════ 来源: session-file-utils-tmp-migrate.test.ts ════════════════

/** 写一个合法 session JSONL（首行 session header），返回文件绝对路径。 */
function writeTmpMigrateSessionFile(dir: string, name: string, id: string, cwd: string): string {
  const filePath = join(dir, name)
  writeFileSync(
    filePath,
    JSON.stringify({ type: 'session', id, cwd, timestamp: '2026-08-19T00:00:00Z' }) + '\n',
    'utf-8',
  )
  return filePath
}

/** 把文件 mtime 回拨到 ageMs 之前（构造过期残留；atime 同步设置，utimesSync 必填）。 */
function ageFile(filePath: string, ageMs: number): void {
  const t = new Date(Date.now() - ageMs)
  utimesSync(filePath, t, t)
}

describe('cleanupTmpMigrateResidue（W3 残留清理）', () => {
  let dataDir: string
  let sessionsDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'w3-tmp-migrate-'))
    process.env.TAIJI_AGENT_DATA_DIR = dataDir
    invalidateScanDirCache()
    sessionsDir = join(dataDir, 'agent', 'sessions')
  })

  afterEach(() => {
    delete process.env.TAIJI_AGENT_DATA_DIR
    invalidateScanDirCache()
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('过期残留删除（根目录 + cwd 分组子目录两层都清）', () => {
    const subDir = join(sessionsDir, 'proj-a')
    mkdirSync(subDir, { recursive: true })
    const residueRoot = writeTmpMigrateSessionFile(sessionsDir, 'sess-1.jsonl.tmp-migrate-1700000000000.jsonl', 'x', '/w')
    const residueSub = writeTmpMigrateSessionFile(subDir, 'sess-2.jsonl.tmp-migrate-1700000000001.jsonl', 'x', '/w')
    ageFile(residueRoot, 2 * 3_600_000)
    ageFile(residueSub, 2 * 3_600_000)

    const removed = cleanupTmpMigrateResidue(sessionsDir, 3_600_000)

    expect(removed).toBe(2)
    expect(existsSync(residueRoot)).toBe(false)
    expect(existsSync(residueSub)).toBe(false)
  })

  it('新鲜残留保留（mtime 晚于 now-maxAgeMs 不删，防并发误删进行中的归一化临时文件）', () => {
    mkdirSync(sessionsDir, { recursive: true })
    const fresh = writeTmpMigrateSessionFile(sessionsDir, 'sess-1.jsonl.tmp-migrate-9999999999999.jsonl', 'x', '/w')

    const removed = cleanupTmpMigrateResidue(sessionsDir, 3_600_000)

    expect(removed).toBe(0)
    expect(existsSync(fresh)).toBe(true)
  })

  it('目录不存在 no-op 安全（返回 0，不上抛）', () => {
    expect(cleanupTmpMigrateResidue(join(dataDir, 'no-such-dir'), 3_600_000)).toBe(0)
  })

  it('非匹配文件零触碰（正常 session / sidecar / 非 tmp-migrate 命名的 jsonl 均保留）', () => {
    mkdirSync(sessionsDir, { recursive: true })
    const normal = writeTmpMigrateSessionFile(sessionsDir, 'sess-1.jsonl', 'sess-1', '/w')
    const sidecar = join(sessionsDir, 'sess-1.jsonl.meta.json')
    writeFileSync(sidecar, '{}', 'utf-8')
    const otherJsonl = writeTmpMigrateSessionFile(sessionsDir, 'notes.jsonl', 'x', '/w')
    ageFile(normal, 2 * 3_600_000)
    ageFile(sidecar, 2 * 3_600_000)
    ageFile(otherJsonl, 2 * 3_600_000)

    const removed = cleanupTmpMigrateResidue(sessionsDir, 3_600_000)

    expect(removed).toBe(0)
    expect(existsSync(normal)).toBe(true)
    expect(existsSync(sidecar)).toBe(true)
    expect(existsSync(otherJsonl)).toBe(true)
  })

  it('端到端：同 id 正式文件 + 残留共存 → scanPiSessions 只收录正式文件；清理后目录只剩正式文件', () => {
    const subDir = join(sessionsDir, 'proj-a')
    mkdirSync(subDir, { recursive: true })
    const official = writeTmpMigrateSessionFile(subDir, 'sess-1.jsonl', 'sess-1', '/work/a')
    // 残留与正式文件同 id（内容是合法 session——正是 isScannableSessionFile 按名排除的动机）
    const residue = writeTmpMigrateSessionFile(subDir, 'sess-1.jsonl.tmp-migrate-1700000000000.jsonl', 'sess-1', '/work/a')
    ageFile(residue, 2 * 3_600_000)

    // 全链路：scanPiSessions（目录 TTL 缓存 + 文件名过滤 + header 解析）不收录残留
    const scanned = scanPiSessions()
    expect(scanned).toHaveLength(1)
    expect(scanned[0].id).toBe('sess-1')
    expect(scanned[0].filePath).toBe(official)

    // 清理后：目录只剩正式文件（残留被删、正式文件未动）
    const removed = cleanupTmpMigrateResidue(sessionsDir, 3_600_000)
    expect(removed).toBe(1)
    expect(existsSync(residue)).toBe(false)
    expect(existsSync(official)).toBe(true)
    // 清理后再扫仍一致（清理未破坏扫描视图）
    invalidateScanDirCache()
    expect(scanPiSessions()).toHaveLength(1)
  })
})

// ════════════════ 来源: session-scan-degraded.test.ts ════════════════

describe('scanPiSessions · 降级计数 + 轮末汇总（RT-3#2）', () => {
  let dir: string
  let warnSpy: MockInstance<typeof console.warn>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'scan-degraded-rt3-2-'))
    process.env.TAIJI_AGENT_DATA_DIR = dir
    _resetSessionMetaCacheForTest()
    invalidateScanDirCache()
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
    delete process.env.TAIJI_AGENT_DATA_DIR
    _resetSessionMetaCacheForTest()
    invalidateScanDirCache()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  /** sessions 目录（getSessionsDir = <dataDir>/agent/sessions）。 */
  function sessionsDir(): string {
    return join(dir, 'agent', 'sessions')
  }

  function writeSession(name: string, id: string): string {
    const p = join(sessionsDir(), name)
    writeFileSync(p, `{"type":"session","version":3,"id":"${id}","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}\n`, 'utf-8')
    return p
  }

  it('非 session 首行的 .jsonl → 不收录 + 汇总 warn 含 noHeader 计数与样例路径', () => {
    mkdirSync(sessionsDir(), { recursive: true })
    const bad = join(sessionsDir(), 'not-a-session.jsonl')
    writeFileSync(bad, '{"type":"label","label":"x"}\n', 'utf-8')

    const results = scanPiSessions({ force: true })

    expect(results).toHaveLength(0)
    const summary = warnSpy.mock.calls.map(c => String(c[0])).find(m => m.includes('scanPiSessions degraded'))
    expect(summary).toBeDefined()
    expect(summary).toContain('noHeader=1')
    expect(summary).toContain(bad)
  })

  it('坏 header（type=session 缺 cwd）→ badHeader 计入汇总；正常会话仍收录', () => {
    mkdirSync(sessionsDir(), { recursive: true })
    writeSession('good.jsonl', 'good-id')
    const badHeader = join(sessionsDir(), 'bad-header.jsonl')
    writeFileSync(badHeader, '{"type":"session","version":3,"id":"x","timestamp":"2026-01-01T00:00:00.000Z"}\n', 'utf-8')

    const results = scanPiSessions({ force: true })

    expect(results.map(r => r.id)).toEqual(['good-id'])
    const summary = warnSpy.mock.calls.map(c => String(c[0])).find(m => m.includes('scanPiSessions degraded'))
    expect(summary).toBeDefined()
    expect(summary).toContain('badHeader=1')
    expect(summary).toContain(badHeader)
  })

  it('cwd 子目录不可读（EACCES）→ dirFail 计入汇总', () => {
    mkdirSync(sessionsDir(), { recursive: true })
    writeSession('root-level.jsonl', 'root-id')
    const sub = join(sessionsDir(), 'group-a')
    mkdirSync(sub, { recursive: true })
    writeFileSync(join(sub, 'inner.jsonl'), '{"type":"session","version":3,"id":"inner-id","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}\n', 'utf-8')
    chmodSync(sub, 0o000)

    try {
      const results = scanPiSessions({ force: true })
      // 子目录整体未收录（只有根层正常条目）
      expect(results.map(r => r.id)).toEqual(['root-id'])
      const summary = warnSpy.mock.calls.map(c => String(c[0])).find(m => m.includes('scanPiSessions degraded'))
      expect(summary).toBeDefined()
      expect(summary).toContain('dirFail=1')
      expect(summary).toContain(sub)
    } finally {
      chmodSync(sub, 0o755)
    }
  })

  it('零降级 → 无汇总 warn（正常态安静）', () => {
    mkdirSync(sessionsDir(), { recursive: true })
    writeSession('only.jsonl', 'only-id')
    const results = scanPiSessions({ force: true })
    expect(results).toHaveLength(1)
    expect(warnSpy).not.toHaveBeenCalled()
  })
})

// ════════════════ 来源: session-end-entry.test.ts ════════════════

describe('W4: persistSessionEnd + extractSessionOutcome round-trip（AC-3）', () => {
  let dir: string
  let filePath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cw-session-end-'))
    filePath = join(dir, 'test.jsonl')
    // 模拟 pi 已 flush 的 session 文件（首行 session header）
    writeFileSync(filePath, JSON.stringify({ type: 'session', id: 's1', cwd: '/x', timestamp: '2026-01-01T00:00:00.000Z' }) + '\n')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('persistSessionEnd(done) 后 extractSessionOutcome 返回 done', () => {
    persistSessionEnd(filePath, 'done')
    expect(extractSessionOutcome(filePath)).toBe('done')
  })

  it('persistSessionEnd(error) 后 extractSessionOutcome 返回 error', () => {
    persistSessionEnd(filePath, 'error', 'Connection failed')
    expect(extractSessionOutcome(filePath)).toBe('error')
  })

  it('persistSessionEnd(stopped) 后 extractSessionOutcome 返回 stopped', () => {
    persistSessionEnd(filePath, 'stopped')
    expect(extractSessionOutcome(filePath)).toBe('stopped')
  })

  it('写入的 sidecar .meta.json 含 outcome + timestamp（B7 sidecar 方案）', () => {
    persistSessionEnd(filePath, 'done')
    // B7: persistSessionEnd 写 sidecar .meta.json（不再往 JSONL append session_end）
    const metaPath = filePath + '.meta.json'
    expect(existsSync(metaPath)).toBe(true)
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8'))
    expect(meta.outcome).toBe('done')
    expect(meta.timestamp).toBeTruthy()
  })

  it('无 session_end 的文件 → extractSessionOutcome 返回 null（AC-4 回退）', () => {
    expect(extractSessionOutcome(filePath)).toBeNull()
  })

  it('sidecar 不覆盖 JSONL 原有内容（B7: 写 .meta.json，JSONL 不变）', () => {
    // 先写几条消息
    writeFileSync(filePath, JSON.stringify({ type: 'session', id: 's1', cwd: '/x', timestamp: '2026-01-01T00:00:00.000Z' }) + '\n'
      + JSON.stringify({ type: 'message', id: 'm1', message: { role: 'user', content: 'hi' }, timestamp: '2026-01-01T00:00:01.000Z' }) + '\n')
    persistSessionEnd(filePath, 'done')
    // JSONL 内容不变（2 行），session_end 写进 sidecar
    const content = readFileSync(filePath, 'utf-8')
    const lines = content.trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]).type).toBe('session')
    expect(JSON.parse(lines[1]).type).toBe('message')
    // sidecar 存在且含 outcome
    const meta = JSON.parse(readFileSync(filePath + '.meta.json', 'utf-8'))
    expect(meta.outcome).toBe('done')
  })
})

describe('W4: persistSessionEnd existsSync guard（AC-7 规则 #6）', () => {
  it('文件不存在时不创建文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-no-file-'))
    const nonExist = join(dir, 'never-existed.jsonl')
    try {
      expect(existsSync(nonExist)).toBe(false)
      persistSessionEnd(nonExist, 'done')
      // 关键断言：文件仍未被创建（不违反规则 #6 pi _persist openSync(wx) 竞态）
      expect(existsSync(nonExist)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('文件不存在时不抛异常', () => {
    const nonExist = join(mkdtempSync(join(tmpdir(), 'cw-no-throw-')), 'no.jsonl')
    expect(() => persistSessionEnd(nonExist, 'done')).not.toThrow()
  })

  it('空路径直接 return 不抛', () => {
    expect(() => persistSessionEnd('', 'done')).not.toThrow()
  })
})

describe('W4: SessionOutcome 类型完整性', () => {
  it('三种 outcome 值可被 extractSessionOutcome 正确区分', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-types-'))
    try {
      const outcomes: SessionOutcome[] = ['done', 'error', 'stopped']
      for (const o of outcomes) {
        const fp = join(dir, `${o}.jsonl`)
        writeFileSync(fp, JSON.stringify({ type: 'session', id: 's', cwd: '/x', timestamp: '2026-01-01T00:00:00.000Z' }) + '\n')
        persistSessionEnd(fp, o)
        expect(extractSessionOutcome(fp)).toBe(o)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})

// ════════════════ 来源: session-file-utils-migrate-cleanup.test.ts ════════════════

function tmpMigrateNames(dir: string): string[] {
  return readdirSync(dir).filter(n => n.includes('.tmp-migrate-'))
}

describe('normalizeSessionFileInPlace rename 失败回滚（suggestion 6）', () => {
  it('rename 目标是已存在的非空目录 → 抛错且不留 .tmp-migrate- 残留，原目标未动', () => {
    const dir = mkdtempSync(join(tmpdir(), 's6-rollback-'))
    try {
      // 目标路径做成已存在的非空目录 → renameSync(file → dir) 真实抛错
      const target = join(dir, '2026-08-19T00-00-00-000Z_sess-x.jsonl')
      mkdirSync(target)
      writeFileSync(join(target, 'occupant.txt'), 'x')

      expect(() => normalizeSessionFileInPlace(target, 'line\n')).toThrow()
      // 回滚：刚写的临时文件已删，目录零 .tmp-migrate- 残留
      expect(tmpMigrateNames(dir)).toEqual([])
      // 原目标（目录）未被触碰
      expect(existsSync(join(target, 'occupant.txt'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('rename 成功路径行为不变：临时文件被消费，产物落原路径', () => {
    const dir = mkdtempSync(join(tmpdir(), 's6-ok-'))
    try {
      const target = join(dir, '2026-08-19T00-00-00-000Z_sess-y.jsonl')
      writeFileSync(target, 'old\n')
      normalizeSessionFileInPlace(target, 'new-content\n')
      expect(readFileSync(target, 'utf-8')).toBe('new-content\n')
      expect(tmpMigrateNames(dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})

describe('cleanupMigrateResidues（suggestion 6）', () => {
  it('只删同 basename 前缀 + .jsonl 后缀的残留，不碰其他文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 's6-sweep-'))
    try {
      const base = '2026-08-19T00-00-00-000Z_sess-a.jsonl'
      const main = join(dir, base)
      writeFileSync(main, 'main\n')
      // 命中：同 basename 前缀残留 ×2
      writeFileSync(join(dir, `${base}.tmp-migrate-111.jsonl`), 'r1\n')
      writeFileSync(join(dir, `${base}.tmp-migrate-222.jsonl`), 'r2\n')
      // 不命中：其他 session 的残留 / 前缀匹配但非 .jsonl 后缀 / 无关文件
      const other = '2026-08-19T00-00-00-000Z_sess-b.jsonl.tmp-migrate-333.jsonl'
      writeFileSync(join(dir, other), 'other-session-residue\n')
      writeFileSync(join(dir, `${base}.tmp-migrate-444.txt`), 'wrong-suffix\n')
      writeFileSync(join(dir, 'unrelated.jsonl'), 'keep\n')

      cleanupMigrateResidues(main)

      const names = readdirSync(dir)
      expect(names).toContain(base)
      expect(names).toContain(other)
      expect(names).toContain(`${base}.tmp-migrate-444.txt`)
      expect(names).toContain('unrelated.jsonl')
      expect(names).not.toContain(`${base}.tmp-migrate-111.jsonl`)
      expect(names).not.toContain(`${base}.tmp-migrate-222.jsonl`)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('无残留时 no-op；目录不存在时不抛', () => {
    const dir = mkdtempSync(join(tmpdir(), 's6-noop-'))
    try {
      const main = join(dir, 'x.jsonl')
      writeFileSync(main, 'm\n')
      expect(() => cleanupMigrateResidues(main)).not.toThrow()
      expect(readdirSync(dir)).toEqual(['x.jsonl'])
      expect(() => cleanupMigrateResidues(join(dir, 'no-such-dir', 'x.jsonl'))).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
