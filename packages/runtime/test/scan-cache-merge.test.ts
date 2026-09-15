/**
 * W3 红灯测试：scanPiSessions 文件级 mtime+size 缓存 + 三读合一。
 *
 * 对应 FR-mtime-cache（AC-cache-1/2/3）+ FR-three-read-merge（AC-merge-1/2）。
 *
 * 策略：用真实临时文件（mkdtemp）+ mock node:fs 计数文件读取调用。
 * vi.mock 工厂内用 createRequire 拿真实的 openSync/readSync/closeSync（尾读路径），
 * readFileSync/statSync 用可控 mock（计数 + 返回真实文件内容）。
 *
 * 核心防的 bug：
 * - SR3：缓存必须模块级跨两阶段共享。若 per-call，scannedToSummary 阶段仍重复读。
 * - SR4：缓存键缺 size → 同 ms 并发写 mtimeMs 不变 → 返回旧内容。
 * - 三读合一：每文件应只读 1 次（miss）/ 0 次（hit），而非 3 次。
 *
 * [红灯说明] 当前 scanPiSessions 无缓存（每次冷读）。
 * AC-cache-1 断言"第二次读取调用不增加"——无缓存会 fail。
 *
 * 运行：cd packages/runtime && npx vitest run test/scan-cache-merge.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// 真实 fs 引用：用 createRequire 绕过 vi.mock（vi.mock 替换的是 ESM namespace 绑定，
// createRequire 拿的是 CJS 原始模块，不被 mock 拦截）
import { createRequire } from 'node:module'
const realFs = createRequire(import.meta.url)('fs') as typeof import('node:fs')

// 计数器（hoisted，vi.mock 工厂可引用）
const fsState = vi.hoisted(() => ({ readCount: 0, statCount: 0 }))

vi.mock('node:fs', async () => {
  const real = await import('node:fs')
  return {
    // 尾读路径透传真实实现（openSync/readSync/closeSync/fstatSync）
    openSync: real.openSync,
    readSync: real.readSync,
    closeSync: real.closeSync,
    fstatSync: real.fstatSync,
    // 计数 readFileSync/statSync（缓存命中时不被调）
    readFileSync: vi.fn((...args: Parameters<typeof real.readFileSync>) => {
      fsState.readCount++
      return real.readFileSync(...args)
    }),
    statSync: vi.fn((...args: Parameters<typeof real.statSync>) => {
      fsState.statCount++
      return real.statSync(...args)
    }),
    existsSync: real.existsSync,
    readdirSync: real.readdirSync,
    writeSync: real.writeSync,
  }
})

const pathsMock = vi.hoisted(() => ({ getSessionsDir: vi.fn(() => '/fake/sessions') }))
vi.mock('../src/infra/pi/pi-paths.js', () => ({
  getSessionsDir: pathsMock.getSessionsDir,
}))

// import 在 mock 之后（mock 提升，import 时已是 mock 版本）
import { scanPiSessions, invalidateScanDirCache, _resetSessionMetaCacheForTest } from '../src/infra/pi/session-file-utils.js'

describe('W3 scanPiSessions mtime+size 缓存', () => {
  let tmpSessionsDir: string

  beforeEach(() => {
    tmpSessionsDir = realFs.mkdtempSync(join(tmpdir(), 'scan-cache-'))
    fsState.readCount = 0
    fsState.statCount = 0
    _resetSessionMetaCacheForTest()
  })

  afterEach(() => {
    realFs.rmSync(tmpSessionsDir, { recursive: true, force: true })
  })

  /** 在 sessions 目录下造一个 session 文件（用真实 fs，绕过 mock 计数）*/
  function makeSessionFile(id: string, name: string | null, outcome: string | null, mtime: Date): string {
    const dir = join(tmpSessionsDir, 'encodedCwd')
    if (!realFs.existsSync(dir)) realFs.mkdirSync(dir)
    const filePath = join(dir, `${id}.jsonl`)
    const lines = [JSON.stringify({ type: 'session', id, cwd: '/proj', timestamp: '2025-01-01T00:00:00Z' })]
    if (name) lines.push(JSON.stringify({ type: 'session_info', name, timestamp: '2025-01-01T00:00:01Z' }))
    // B7: outcome 写 sidecar .meta.json（persistSessionEnd 的真实行为）；保留 JSONL 的 session_end 作 fallback 测试
    if (outcome) {
      lines.push(JSON.stringify({ type: 'session_end', outcome, timestamp: '2025-01-01T00:00:02Z' }))
      realFs.writeFileSync(filePath + '.meta.json', JSON.stringify({ outcome, timestamp: '2025-01-01T00:00:02Z' }), 'utf-8')
    }
    realFs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8')
    realFs.utimesSync(filePath, mtime, mtime)
    return filePath
  }

  /** 读计数：readFileSync + openSync（尾读入口）都是文件读取行为 */
  function getFileReads(): number {
    return fsState.readCount
  }

  it('AC-cache-1: 连续两次 scan 无变更 → 第二次 readFileSync 调用不增加（缓存命中）', () => {
    pathsMock.getSessionsDir.mockReturnValue(tmpSessionsDir)
    makeSessionFile('s1', '名字', 'done', new Date(1000))

    scanPiSessions()
    const readsAfterFirst = getFileReads()
    expect(readsAfterFirst).toBeGreaterThan(0)

    // W26（D9-1）适配：目录列举层 1s TTL——紧接重扫会命中目录快照，readFileSync 不增加
    // 是「目录层 + per-file 层」两层缓存的叠加结果。显式失效目录缓存（与 AC-cache-2/3
    // 同模式），隔离目录层后本用例只验证 per-file mtime+size 键（文件未变 → 命中，仍零读）。
    invalidateScanDirCache()
    scanPiSessions()
    const readsAfterSecond = getFileReads()
    // 核心：第二次文件未变（mtime+size 相同）→ 命中 per-file 缓存 → readFileSync 不增加
    // 注意：若实现用 openSync 尾读而非 readFileSync，readCount 可能不增——
    // 此用例聚焦 readFileSync 路径；openSync 路径在 AC-merge-1 覆盖
    expect(readsAfterSecond).toBe(readsAfterFirst)
  })

  it('AC-cache-2: mtime 不变但文件内容变（size 变）→ miss 重读', () => {
    pathsMock.getSessionsDir.mockReturnValue(tmpSessionsDir)
    const fixedMtime = new Date(5000)
    makeSessionFile('s1', '短', 'done', fixedMtime)

    scanPiSessions()
    const readsAfterFirst = getFileReads()

    // 覆盖写更长内容（size 变），mtime 保持不变
    const dir = join(tmpSessionsDir, 'encodedCwd')
    const filePath = join(dir, 's1.jsonl')
    const lines = [
      JSON.stringify({ type: 'session', id: 's1', cwd: '/proj', timestamp: '2025-01-01T00:00:00Z' }),
      JSON.stringify({ type: 'session_info', name: '这是一个更长的名字触发 size 变化', timestamp: '2025-01-01T00:00:01Z' }),
      JSON.stringify({ type: 'session_end', outcome: 'done', timestamp: '2025-01-01T00:00:02Z' }),
    ]
    realFs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8')
    realFs.utimesSync(filePath, fixedMtime, fixedMtime)

    // W26（D9-1）适配：目录列举层 1s TTL——文件变更后 1s 内重扫会命中目录快照。
    // 显式失效目录缓存（delete/rename/fork 的失效语义），隔离目录层后本用例只验证
    // per-file mtime+size 键（文件级缓存层行为不变）。
    invalidateScanDirCache()
    scanPiSessions()
    const readsAfterSecond = getFileReads()
    // 核心：mtime 不变但 size 变 → 必须 miss（键含 size）
    expect(readsAfterSecond).toBeGreaterThan(readsAfterFirst)

    const result = scanPiSessions()
    expect(result[0]?.name).toBe('这是一个更长的名字触发 size 变化')
  })

  it('AC-cache-3: 文件删除后下次 scan → 不返回 stale 结果', () => {
    pathsMock.getSessionsDir.mockReturnValue(tmpSessionsDir)
    makeSessionFile('s1', '名字', 'done', new Date(1000))

    let result = scanPiSessions()
    expect(result).toHaveLength(1)

    realFs.rmSync(join(tmpSessionsDir, 'encodedCwd', 's1.jsonl'), { force: true })

    // W26（D9-1）适配：文件删除不经显式失效时目录 TTL 快照 1s 内仍含已删条目——
    // 显式失效（session delete 路径的调用点语义）后立即重扫，per-file 层返回空。
    invalidateScanDirCache()
    result = scanPiSessions()
    expect(result).toHaveLength(0)
  })

  it('AC-merge-1: 3 文件冷缓存 → readFileSync 总数 ≤ 36（六读合一，vitest mock 计数 ×2）', () => {
    pathsMock.getSessionsDir.mockReturnValue(tmpSessionsDir)
    makeSessionFile('s1', 'n1', 'done', new Date(1000))
    makeSessionFile('s2', 'n2', 'error', new Date(2000))
    makeSessionFile('s3', 'n3', 'stopped', new Date(3000))

    fsState.readCount = 0
    scanPiSessions()
    // B7 sidecar 方案后每文件读取（真实读，mock 计数×2——vitest Proxy 转发双计）：
    // parseSessionHeader(1) + extractSessionName 尾读(0) + extractSessionOutcome sidecar(1)
    // + extractHandedOff 仅尾读(0) + readPresetBinding(1) = 3 真实读/文件（计数 6）。
    // D14 语义修正（2026-08-04）project sidecar 第五读：+ readProjectBinding(1) 真实读
    // → 4 真实读/文件（计数 8）。
    // agent-managed-session agent sidecar 第六读：+ readAgentBinding(1) 真实读
    // → 5 真实读/文件（计数 10）。基线（无 project/agent 读）3 文件计数 18 = 3 × 6。
    // composer-model（U1）model sidecar 第七读（2026-09-04 预算校准）：scanSessionMeta
    // 同批次新增 readModelBinding(1) 真实读/文件（.model.json sidecar 提取，设计
    // docs/design/composer-model-session-isolation.md D1 扫描器提取），归因核实：
    // git show 7c15bad36 对比 HEAD，本分支唯一读取增量为该第七读（+1 读/文件），
    // 实测计数 30 → 36 与 +3 文件 × 2 计数精确吻合 → 6 真实读/文件（计数 12）。
    // 关键约束：缓存命中时（AC-cache-1）readFileSync 不增加，该断言不变。
    expect(fsState.readCount).toBeLessThanOrEqual(36) // 3 文件 × 6 真实读 × 2 计数
  })
})
