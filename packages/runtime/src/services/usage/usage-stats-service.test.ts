/**
 * UsageStatsService 单元测试
 *
 * 运行：cd packages/runtime && npx vitest run src/services/usage/usage-stats-service.test.ts
 *
 * 覆盖验收：
 * - assistant 主桶（含 responseModel 与 model 大小写不同场景）
 * - toolResult-with-usage
 * - compaction entry（顶层 usage）
 * - branch_summary 无 usage 不产出 NaN 行
 * - ③ compaction model 归属：details.model 权威优先，非 string/空串回退 'compaction'
 * - ④ rename-session custom entry：正常落账 / usage 存在性守卫 / model 回退 / timestamp 行级失败 / cost 缺失诚实降级
 * - 首行 session_info 的 cwd 容错
 * - .tmp-migrate-*.jsonl 与 .meta.json 排除
 * - 空目录空结果
 * - 解析坏行 skippedLines 计数
 * - 双键失效（同 mtime 改 size 触发重扫；追加内容后消息数增加）
 * - 双键 size 分量确定性验证（mock stat：mtime 相同仅 size 变 → 重扫；均不变 → 走缓存）
 * - timestamp 缺失/非法行不抛错、计入 skippedLines
 * - 多文件 skippedLines 分片求和不污染
 * - 目录不可读返回空结果
 * - 删除文件后分片被丢弃
 * - 两层扫描（方案 B 布局：encodeCwd 子目录文件被统计 / 根层子目录混合 / 孙目录不下钻 / 子目录内排除规则）
 * - 真实数据冒烟测试（可跳过条件：目录不存在）
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, writeFile, rm, mkdir, readdir, stat, appendFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UsageStatsService } from './usage-stats-service.js'
import { encodeCwd, getSessionsDir } from '../../infra/pi/pi-paths.js'

// ── stat mock 基建（M6：双键 size 分量确定性场景）───────────
// macOS/Linux 上 appendFile 必然同时更新 mtime，「mtime 不变仅 size 变」无法用真实文件系统构造，
// 故用 vi.hoisted + importActual 透传式 mock：override 非空时按测试脚本返回固定 (mtimeMs,size)，否则透传真实 stat。
const statMock = vi.hoisted(() => ({
  /** 非空时接管 stat：入参为路径与真实 stat，返回覆写后的 Stats-like 对象。 */
  override: null as null | ((path: string, realStat: (p: string) => Promise<Awaited<ReturnType<typeof import('node:fs/promises').stat>>>) => Promise<Awaited<ReturnType<typeof import('node:fs/promises').stat>>>) ,
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const realStat = actual.stat.bind(actual)
  return {
    ...actual,
    stat: (p: string) => (statMock.override ? statMock.override(p, realStat) : realStat(p)),
  }
})

/** 克隆 Stats 并覆写部分字段（保原型链，isFile() 等方法可用）。 */
function withOverrides(s: Awaited<ReturnType<typeof import('node:fs/promises').stat>>, patch: { mtimeMs?: number; size?: number }) {
  return Object.assign(Object.create(Object.getPrototypeOf(s)), s, patch)
}

// ── fixture 构造工具 ─────────────────────────────────────────

/** 构造 session header entry（type=session，首行或非首行）。 */
function sessionEntry(cwd: string, id = 'test-session-1'): string {
  return JSON.stringify({
    type: 'session',
    id,
    timestamp: '2026-08-25T02:11:15.710Z',
    cwd,
  })
}

/** 构造 assistant message entry with usage。 */
function assistantEntry(opts: {
  provider?: string
  model?: string
  responseModel?: string
  usage?: Record<string, unknown> | null
  timestamp?: string
} = {}): string {
  const {
    provider = 'kimi-coding',
    model = 'k3-256k',
    responseModel,
    usage = { input: 1000, output: 200, cacheRead: 50, cacheWrite: 10, totalTokens: 1260, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.005 } },
    timestamp = '2026-08-25T10:00:00.000Z',
  } = opts

  const message: Record<string, unknown> = {
    provider,
    model,
    role: 'assistant',
    content: 'test response',
  }
  // usage: null = 显式无 usage，undefined = 用默认值
  if (usage !== null) {
    message.usage = usage
  }
  if (responseModel !== undefined) {
    message.responseModel = responseModel
  }

  return JSON.stringify({
    type: 'message',
    timestamp,
    message,
  })
}

/** 构造 toolResult message entry with usage。 */
function toolResultEntry(usage?: Record<string, unknown>): string {
  const msg: Record<string, unknown> = {
    role: 'toolResult',
    content: 'tool output',
  }
  if (usage) msg.usage = usage
  return JSON.stringify({
    type: 'message',
    timestamp: '2026-08-25T10:01:00.000Z',
    message: msg,
  })
}

/** 构造 compaction entry（usage 在顶层；details 可选——U3 smart-context 落盘形态）。 */
function compactionEntry(usage?: Record<string, unknown>, details?: Record<string, unknown>): string {
  const entry: Record<string, unknown> = {
    type: 'compaction',
    id: 'comp-1',
    timestamp: '2026-08-25T10:02:00.000Z',
    summary: 'Compacted earlier context.',
  }
  if (usage) entry.usage = usage
  if (details) entry.details = details
  return JSON.stringify(entry)
}

/** 构造 rename-session custom entry（pi appendCustomEntry 落盘形态，docs/pi-semantics.json PS-29）。 */
function renameSessionEntry(opts: {
  data?: Record<string, unknown> | null
  timestamp?: string
  customType?: string
} = {}): string {
  const { data = null, timestamp = '2026-08-25T10:04:00.000Z', customType = 'rename-session' } = opts
  const entry: Record<string, unknown> = {
    type: 'custom',
    customType,
    id: 'custom-1',
    parentId: 'entry-0',
    timestamp,
  }
  if (data !== null) entry.data = data
  return JSON.stringify(entry)
}

/** 构造 branch_summary entry（无 usage，设计文档 §2.1 事实 1 已验证）。 */
function branchSummaryEntry(): string {
  return JSON.stringify({
    type: 'branch_summary',
    id: 'bs-1',
    timestamp: '2026-08-25T10:03:00.000Z',
    summary: 'Branch summary.',
  })
}

/** 构造 user message entry（不带 usage，应被跳过）。 */
function userEntry(): string {
  return JSON.stringify({
    type: 'message',
    timestamp: '2026-08-25T09:59:00.000Z',
    message: { role: 'user', content: 'test input' },
  })
}

/** 构造 model_change entry（应被跳过）。 */
function modelChangeEntry(): string {
  return JSON.stringify({
    type: 'model_change',
    timestamp: '2026-08-25T09:58:00.000Z',
    model: 'k3-256k',
  })
}

/** 标准 usage 对象。 */
const SAMPLE_USAGE = {
  input: 1000,
  output: 200,
  cacheRead: 50,
  cacheWrite: 10,
  totalTokens: 1260,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.005 },
}

const ZERO_COST_USAGE = {
  input: 500,
  output: 100,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 600,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

/** rename-session 落账样例 usage。 */
const RENAME_USAGE = {
  input: 800,
  output: 40,
  cacheRead: 20,
  cacheWrite: 0,
  totalTokens: 860,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.002 },
}

/** rename-session 无 cost 的 usage（P-usage-shape 降级：token 正常、费用视角 $0）。 */
const RENAME_USAGE_NO_COST = {
  input: 700,
  output: 30,
  cacheRead: 10,
  cacheWrite: 0,
  totalTokens: 740,
}

// ── 测试 ─────────────────────────────────────────────────────

describe('UsageStatsService', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'usage-stats-test-'))
  })

  afterEach(async () => {
    statMock.override = null
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  // ── 基础功能 ─────────────────────────────────────────────

  it('空目录返回空结果', async () => {
    const svc = new UsageStatsService(tmpDir)
    const result = await svc.getStats()

    expect(result.rows).toEqual([])
    expect(result.sessionCount).toBe(0)
    expect(result.skippedLines).toBe(0)
    expect(result.scannedAt).toBeGreaterThan(0)
  })

  it('assistant 主桶正常计入', async () => {
    const content = [
      sessionEntry('/Users/dev/project-a'),
      assistantEntry({ provider: 'kimi-coding', model: 'k3-256k' }),
    ].join('\n')
    await writeFile(join(tmpDir, 'test-1.jsonl'), content)

    const svc = new UsageStatsService(tmpDir)
    const result = await svc.getStats()

    expect(result.rows).toHaveLength(1)
    expect(result.sessionCount).toBe(1)
    const row = result.rows[0]
    expect(row.provider).toBe('kimi-coding')
    expect(row.model).toBe('k3-256k')
    expect(row.input).toBe(1000)
    expect(row.output).toBe(200)
    expect(row.cacheRead).toBe(50)
    expect(row.cacheWrite).toBe(10)
    expect(row.costUSD).toBe(0.005)
    expect(row.messages).toBe(1)
    expect(row.project).toBe('project-a')
    // date 应为本地时区 YYYY-MM-DD
    expect(row.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('responseModel 优先于 model（D10）', async () => {
    const content = [
      sessionEntry('/Users/dev/test-proj'),
      assistantEntry({ model: 'glm-5.3', responseModel: 'GLM-5.3' }),
    ].join('\n')
    await writeFile(join(tmpDir, 'test-2.jsonl'), content)

    const svc = new UsageStatsService(tmpDir)
    const result = await svc.getStats()

    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].model).toBe('GLM-5.3')
  })

  it('无 responseModel 时回退到 model', async () => {
    const content = [
      sessionEntry('/Users/dev/test-proj'),
      assistantEntry({ model: 'k3-256k' }), // 无 responseModel
    ].join('\n')
    await writeFile(join(tmpDir, 'test-3.jsonl'), content)

    const svc = new UsageStatsService(tmpDir)
    const result = await svc.getStats()

    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].model).toBe('k3-256k')
  })

  // ── compaction 虚拟桶 ───────────────────────────────────

  it('toolResult-with-usage 计入 compaction 虚拟桶', async () => {
    const content = [
      sessionEntry('/Users/dev/compaction-test'),
      toolResultEntry(SAMPLE_USAGE),
    ].join('\n')
    await writeFile(join(tmpDir, 'test-4.jsonl'), content)

    const svc = new UsageStatsService(tmpDir)
    const result = await svc.getStats()

    expect(result.rows).toHaveLength(1)
    const row = result.rows[0]
    expect(row.provider).toBe('compaction')
    expect(row.model).toBe('compaction')
    expect(row.input).toBe(1000)
    expect(row.messages).toBe(1)
  })

  it('compaction entry（顶层 usage）计入 compaction 虚拟桶', async () => {
    const usage = {
      input: 5000,
      output: 300,
      cacheRead: 100,
      cacheWrite: 0,
      totalTokens: 5400,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    }
    const content = [
      sessionEntry('/Users/dev/compaction-entry-test'),
      compactionEntry(usage),
    ].join('\n')
    await writeFile(join(tmpDir, 'test-5.jsonl'), content)

    const svc = new UsageStatsService(tmpDir)
    const result = await svc.getStats()

    expect(result.rows).toHaveLength(1)
    const row = result.rows[0]
    expect(row.provider).toBe('compaction')
    expect(row.model).toBe('compaction')
    expect(row.input).toBe(5000)
    expect(row.output).toBe(300)
    expect(row.messages).toBe(1)
  })

  it('branch_summary 无 usage 不产出 NaN 行', async () => {
    const content = [
      sessionEntry('/Users/dev/bs-test'),
      branchSummaryEntry(),
      assistantEntry(), // 至少有一个 assistant 保证有行
    ].join('\n')
    await writeFile(join(tmpDir, 'test-6.jsonl'), content)

    const svc = new UsageStatsService(tmpDir)
    const result = await svc.getStats()

    // branch_summary 无 usage → 不产出行，只有 assistant 那条
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].provider).toBe('kimi-coding')
    // 确认无 NaN
    for (const row of result.rows) {
      expect(row.input).not.toBeNaN()
      expect(row.output).not.toBeNaN()
      expect(row.costUSD).not.toBeNaN()
    }
  })

  // ── 首行 session_info cwd 容错 ──────────────────────────

  it('首行为 session_info 时，继续读找到 session entry 提取 cwd', async () => {
    // 旧文件格式：首行为 session_info，第二行为 session
    const content = [
      JSON.stringify({ type: 'session_info', name: 'test session', timestamp: '2026-08-20T00:00:00.000Z' }),
      sessionEntry('/Users/dev/legacy-project'),
      assistantEntry(),
    ].join('\n')
    await writeFile(join(tmpDir, 'legacy-1.jsonl'), content)

    const svc = new UsageStatsService(tmpDir)
    const result = await svc.getStats()

    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].project).toBe('legacy-project')
  })

  it('无 session entry 时 project 为 (unknown)', async () => {
    const content = [
      modelChangeEntry(),
      assistantEntry(),
    ].join('\n')
    await writeFile(join(tmpDir, 'no-session-1.jsonl'), content)

    const svc = new UsageStatsService(tmpDir)
    const result = await svc.getStats()

    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].project).toBe('(unknown)')
  })

  // ── 文件排除规则 ─────────────────────────────────────────

  it('排除 .tmp-migrate-*.jsonl 文件', async () => {
    const content = [sessionEntry('/Users/dev/migrate-test'), assistantEntry()].join('\n')
    // 正常文件
    await writeFile(join(tmpDir, 'normal.jsonl'), content)
    // 残留文件（内容合法但应被排除）
    await writeFile(join(tmpDir, 'normal.jsonl.tmp-migrate-1234567.jsonl'), content)

    const svc = new UsageStatsService(tmpDir)
    const result = await svc.getStats()

    // 只计入正常文件的行
    expect(result.rows).toHaveLength(1)
    expect(result.sessionCount).toBe(1)
  })

  it('排除 .jsonl.meta.json sidecar 文件', async () => {
    const content = [sessionEntry('/Users/dev/meta-test'), assistantEntry()].join('\n')
    await writeFile(join(tmpDir, 'test-meta.jsonl'), content)
    // sidecar 文件（应被排除，不以 .jsonl 结尾）
    await writeFile(join(tmpDir, 'test-meta.jsonl.meta.json'), JSON.stringify({ type: 'session_end', outcome: 'done' }))

    const svc = new UsageStatsService(tmpDir)
    const result = await svc.getStats()

    expect(result.rows).toHaveLength(1)
    expect(result.sessionCount).toBe(1)
  })

  // ── 解析失败行 skippedLines ──────────────────────────────

  it('JSON 解析失败的行计入 skippedLines', async () => {
    const content = [
      sessionEntry('/Users/dev/skip-test'),
      'this is not valid json',
      assistantEntry(),
      '{ broken json again',
      assistantEntry(),
    ].join('\n')
    await writeFile(join(tmpDir, 'skip-test.jsonl'), content)

    const svc = new UsageStatsService(tmpDir)
    const result = await svc.getStats()

    expect(result.skippedLines).toBe(2)
    expect(result.rows).toHaveLength(2)
  })

  // ── 多文件聚合 ───────────────────────────────────────────

  it('多个文件正确聚合', async () => {
    const content1 = [
      sessionEntry('/Users/dev/project-a'),
      assistantEntry({ provider: 'kimi-coding', model: 'k3-256k' }),
    ].join('\n')
    const content2 = [
      sessionEntry('/Users/dev/project-b'),
      assistantEntry({ provider: 'zai', model: 'GLM-5.2', usage: { input: 2000, output: 400, cacheRead: 0, cacheWrite: 0, totalTokens: 2400, cost: { total: 0.01 } } }),
    ].join('\n')
    await writeFile(join(tmpDir, 'file-1.jsonl'), content1)
    await writeFile(join(tmpDir, 'file-2.jsonl'), content2)

    const svc = new UsageStatsService(tmpDir)
    const result = await svc.getStats()

    expect(result.rows).toHaveLength(2)
    expect(result.sessionCount).toBe(2)
    // 按 provider 区分
    const providers = result.rows.map(r => r.provider).sort()
    expect(providers).toEqual(['kimi-coding', 'zai'])
  })

  // ── 双键缓存失效 ────────────────────────────────────────

  it('双键失效：同 mtime 改 size 触发重扫', async () => {
    const content1 = [
      sessionEntry('/Users/dev/dual-key-test'),
      assistantEntry(),
    ].join('\n')
    await writeFile(join(tmpDir, 'dual-key.jsonl'), content1)

    const svc = new UsageStatsService(tmpDir)
    const result1 = await svc.getStats()
    expect(result1.rows).toHaveLength(1)

    // 追加内容（mtime 可能不变但 size 变）
    // 注意：追加内容后需要改变 size 才能触发重扫
    await appendFile(join(tmpDir, 'dual-key.jsonl'), '\n' + assistantEntry())

    const result2 = await svc.getStats()
    // 追加后应有 2 条行
    expect(result2.rows).toHaveLength(2)
  })

  it('追加内容后消息数增加', async () => {
    const content1 = [
      sessionEntry('/Users/dev/append-test'),
      assistantEntry(),
    ].join('\n')
    await writeFile(join(tmpDir, 'append-test.jsonl'), content1)

    const svc = new UsageStatsService(tmpDir)
    const result1 = await svc.getStats()
    expect(result1.rows).toHaveLength(1)

    // 追加新 assistant 消息
    await appendFile(join(tmpDir, 'append-test.jsonl'), '\n' + assistantEntry({ timestamp: '2026-08-25T11:00:00.000Z' }))

    const result2 = await svc.getStats()
    expect(result2.rows).toHaveLength(2)
  })

  // ── 双键 size 分量确定性验证（M6）──────────────────────

  it('双键确定性：mtime 相同仅 size 变触发重扫；mtime+size 均不变走缓存', async () => {
    // 反向验证推演：若实现删掉 size 比对只看 mtime，本用例 stage2 时 mtime 相同命中缓存 →
    // result2.rows 仍为 1 → 断言失败（用例变红），即 size 分量被本用例守卫。
    const line2 = assistantEntry({ timestamp: '2026-08-25T11:00:00.000Z' })
    const content1 = [sessionEntry('/Users/dev/dk-det'), assistantEntry()].join('\n')
    const s1 = Buffer.byteLength(content1, 'utf8')
    const fp = join(tmpDir, 'dk-det.jsonl')
    await writeFile(fp, content1)

    // 全程接管 stat：首扫与缓存命中阶段返回 (FIXED_MTIME, S1)；重扫判定阶段返回 (FIXED_MTIME, S2)
    const FIXED_MTIME = 1724582400000
    let reportedSize = s1
    let overrideOn = true
    statMock.override = (p, realStat) => {
      if (!overrideOn || p !== fp) return realStat(p)
      return realStat(p).then((s) => withOverrides(s, { mtimeMs: FIXED_MTIME, size: reportedSize }))
    }

    const svc = new UsageStatsService(tmpDir)
    const r1 = await svc.getStats()
    expect(r1.rows).toHaveLength(1)

    // append 真实文件（内容变），同时把上报 size 抬到 S2、mtime 保持 FIXED → 仅 size 变
    await appendFile(fp, '\n' + line2)
    reportedSize = s1 + 1 + Buffer.byteLength(line2, 'utf8')
    const r2 = await svc.getStats()
    expect(r2.rows).toHaveLength(2) // size 变 → 重扫生效

    // mtime+size 均不变 → 走缓存（行集引用不变可证未重读）
    const r3 = await svc.getStats()
    expect(r3.rows).toHaveLength(2)
    expect(r3.rows[0]).toBe(r2.rows[0]) // 同一对象实例 = 来自缓存分片，未重扫
  })

  // ── timestamp 行级失败语义（M5）─────────────────────────

  it('timestamp 缺失/空的 entry 不抛错且计入 skippedLines', async () => {
    const missingTs = JSON.stringify({ type: 'message', message: { role: 'assistant', content: 'x', usage: SAMPLE_USAGE } })
    const emptyTs = JSON.stringify({ type: 'message', timestamp: '', message: { role: 'assistant', content: 'x', usage: SAMPLE_USAGE } })
    const content = [
      sessionEntry('/Users/dev/ts-test'),
      missingTs,
      emptyTs,
      assistantEntry(), // 合法对照行
    ].join('\n')
    await writeFile(join(tmpDir, 'ts-missing.jsonl'), content)

    const svc = new UsageStatsService(tmpDir)
    const result = await svc.getStats()

    expect(result.rows).toHaveLength(1) // 仅合法对照行入桶
    expect(result.skippedLines).toBe(2)
  })

  it('timestamp 非法字符串的 entry 不抛错且计入 skippedLines', async () => {
    const badTs = JSON.stringify({ type: 'message', timestamp: 'not-a-date', message: { role: 'assistant', content: 'x', usage: SAMPLE_USAGE } })
    const content = [sessionEntry('/Users/dev/ts-bad'), badTs, assistantEntry()].join('\n')
    await writeFile(join(tmpDir, 'ts-bad.jsonl'), content)

    const svc = new UsageStatsService(tmpDir)
    const result = await svc.getStats()

    expect(result.rows).toHaveLength(1)
    expect(result.skippedLines).toBe(1)
  })

  // ── 测试盲区补强（G）──────────────────────────────────

  it('多文件 skippedLines 分片求和不污染（A 缓存 + B 重扫）', async () => {
    const fileA = join(tmpDir, 'sum-a.jsonl')
    const fileB = join(tmpDir, 'sum-b.jsonl')
    // A：1 坏行；先单独扫描让 A 进分片缓存
    await writeFile(fileA, [sessionEntry('/Users/dev/sum'), 'not-json{{{', assistantEntry()].join('\n'))
    const svc = new UsageStatsService(tmpDir)
    const r1 = await svc.getStats()
    expect(r1.skippedLines).toBe(1)

    // B：2 坏行；追加后第二次扫描 A 走缓存 + B 重扫
    await writeFile(fileB, [sessionEntry('/Users/dev/sum'), 'bad{{{', 'also-bad}}}'].join('\n'))
    const r2 = await svc.getStats()
    expect(r2.sessionCount).toBe(2)
    expect(r2.skippedLines).toBe(3) // 1(A 缓存分片) + 2(B 新扫)，非旧值污染
  })

  it('目录不可读（不存在）返回空结果而非抛错', async () => {
    const svc = new UsageStatsService(join(tmpDir, 'no-such-dir'))
    const result = await svc.getStats()

    expect(result.rows).toEqual([])
    expect(result.sessionCount).toBe(0)
    expect(result.skippedLines).toBe(0)
  })

  // ── 删除文件后分片被丢弃 ────────────────────────────────

  it('删除文件后分片被丢弃', async () => {
    const content = [
      sessionEntry('/Users/dev/delete-test'),
      assistantEntry(),
    ].join('\n')
    const filePath = join(tmpDir, 'delete-test.jsonl')
    await writeFile(filePath, content)

    const svc = new UsageStatsService(tmpDir)
    const result1 = await svc.getStats()
    expect(result1.rows).toHaveLength(1)

    // 删除文件
    await unlink(filePath)

    const result2 = await svc.getStats()
    expect(result2.rows).toHaveLength(0)
    expect(result2.sessionCount).toBe(0)
  })

  // ── usage 字段缺失守卫 ───────────────────────────────────

  it('assistant 无 usage 不计入', async () => {
    const content = [
      sessionEntry('/Users/dev/no-usage-test'),
      userEntry(),
      assistantEntry({ usage: null }), // 显式无 usage
    ].join('\n')
    await writeFile(join(tmpDir, 'no-usage.jsonl'), content)

    const svc = new UsageStatsService(tmpDir)
    const result = await svc.getStats()

    // 只有 user 和无 usage 的 assistant → 无行
    expect(result.rows).toHaveLength(0)
  })

  it('compaction 无 usage 不计入', async () => {
    const content = [
      sessionEntry('/Users/dev/compaction-no-usage'),
      compactionEntry(), // 无 usage
      assistantEntry(),
    ].join('\n')
    await writeFile(join(tmpDir, 'compaction-no-usage.jsonl'), content)

    const svc = new UsageStatsService(tmpDir)
    const result = await svc.getStats()

    // compaction 无 usage → 只有 assistant 那条
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].provider).toBe('kimi-coding')
  })

  it('toolResult 无 usage 不计入', async () => {
    const content = [
      sessionEntry('/Users/dev/toolresult-no-usage'),
      toolResultEntry(), // 无 usage
      assistantEntry(),
    ].join('\n')
    await writeFile(join(tmpDir, 'toolresult-no-usage.jsonl'), content)

    const svc = new UsageStatsService(tmpDir)
    const result = await svc.getStats()

    // toolResult 无 usage → 只有 assistant 那条
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].provider).toBe('kimi-coding')
  })

  // ── cost.total 缺失守卫 ─────────────────────────────────

  it('cost.total 缺失时 costUSD 按 0', async () => {
    const usageNoCost = {
      input: 100,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 150,
      // 无 cost 字段
    }
    const content = [
      sessionEntry('/Users/dev/no-cost-test'),
      assistantEntry({ usage: usageNoCost }),
    ].join('\n')
    await writeFile(join(tmpDir, 'no-cost.jsonl'), content)

    const svc = new UsageStatsService(tmpDir)
    const result = await svc.getStats()

    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].costUSD).toBe(0)
  })

  // ── ③ compaction model 归属（details.model 权威优先，usage-page-fixes §3.3 ④）──

  it('③ compaction entry details.model 权威归属（U3 落盘形态 provider/id）', async () => {
    const content = [
      sessionEntry('/Users/dev/attrib-test'),
      compactionEntry(SAMPLE_USAGE, {
        engine: 'smart-context',
        mode: 'cross-model',
        model: 'zai-coding-cn/glm-5.3-flash',
      }),
    ].join('\n')
    await writeFile(join(tmpDir, 'attrib-1.jsonl'), content)

    const svc = new UsageStatsService(tmpDir)
    const result = await svc.getStats()

    expect(result.rows).toHaveLength(1)
    const row = result.rows[0]
    expect(row.provider).toBe('compaction')
    expect(row.model).toBe('zai-coding-cn/glm-5.3-flash')
    expect(row.input).toBe(1000)
    expect(row.messages).toBe(1)
  })

  it('③ branch_summary 同享 details.model 归属', async () => {
    const entry = JSON.stringify({
      type: 'branch_summary',
      id: 'bs-det-1',
      timestamp: '2026-08-25T10:03:00.000Z',
      summary: 'Branch summary.',
      usage: SAMPLE_USAGE,
      details: { model: 'kimi-coding/k3' },
    })
    const content = [sessionEntry('/Users/dev/attrib-bs'), entry].join('\n')
    await writeFile(join(tmpDir, 'attrib-2.jsonl'), content)

    const svc = new UsageStatsService(tmpDir)
    const result = await svc.getStats()

    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].provider).toBe('compaction')
    expect(result.rows[0].model).toBe('kimi-coding/k3')
  })

  it('③ details.model 非 string/空串/details 缺失回退 compaction（守卫降级不猜测）', async () => {
    const content = [
      sessionEntry('/Users/dev/attrib-fb'),
      compactionEntry(SAMPLE_USAGE, { model: '' }), // 空串
      compactionEntry(SAMPLE_USAGE, { model: 42 }), // 非 string
      compactionEntry(SAMPLE_USAGE), // 无 details
    ].join('\n')
    await writeFile(join(tmpDir, 'attrib-3.jsonl'), content)

    const svc = new UsageStatsService(tmpDir)
    const result = await svc.getStats()

    expect(result.rows).toHaveLength(3)
    for (const row of result.rows) {
      expect(row.provider).toBe('compaction')
      expect(row.model).toBe('compaction')
    }
  })

  // ── ④ rename-session custom entry（xyz 自有口径，PS-29 落盘形态）────────

  it('④ rename-session custom entry 正常落账（G3）', async () => {
    const content = [
      sessionEntry('/Users/dev/rename-ledger'),
      renameSessionEntry({ data: { model: 'xiaomi-token-plan-cn/mimo-v2.5', usage: RENAME_USAGE } }),
    ].join('\n')
    await writeFile(join(tmpDir, 'rename-1.jsonl'), content)

    const svc = new UsageStatsService(tmpDir)
    const result = await svc.getStats()

    expect(result.rows).toHaveLength(1)
    const row = result.rows[0]
    expect(row.provider).toBe('rename-session')
    expect(row.model).toBe('xiaomi-token-plan-cn/mimo-v2.5')
    expect(row.input).toBe(800)
    expect(row.output).toBe(40)
    expect(row.cacheRead).toBe(20)
    expect(row.costUSD).toBe(0.002)
    expect(row.messages).toBe(1)
    expect(row.project).toBe('rename-ledger')
    expect(row.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('④ usage 有值但 cost 缺失：token 正常、costUSD=$0（诚实降级）', async () => {
    const content = [
      sessionEntry('/Users/dev/rename-nocost'),
      renameSessionEntry({ data: { model: 'xiaomi-token-plan-cn/mimo-v2.5', usage: RENAME_USAGE_NO_COST } }),
    ].join('\n')
    await writeFile(join(tmpDir, 'rename-2.jsonl'), content)

    const svc = new UsageStatsService(tmpDir)
    const result = await svc.getStats()

    expect(result.rows).toHaveLength(1)
    const row = result.rows[0]
    expect(row.provider).toBe('rename-session')
    expect(row.input).toBe(700)
    expect(row.output).toBe(30)
    expect(row.cacheRead).toBe(10)
    expect(row.costUSD).toBe(0)
    expect(row.messages).toBe(1)
  })

  it('④ data.usage 非「非 null 对象」（缺失/null/string/number）与 customType 不符均不计 row', async () => {
    const content = [
      sessionEntry('/Users/dev/rename-guard'),
      renameSessionEntry({ data: { model: 'm', usage: null } }), // null
      renameSessionEntry({ data: { model: 'm' } }), // usage 缺失
      renameSessionEntry({ data: { model: 'm', usage: 'oops' } }), // string
      renameSessionEntry({ data: { model: 'm', usage: 3 } }), // number
      renameSessionEntry({ data: { model: 'm', usage: RENAME_USAGE }, customType: 'other-ext' }), // customType 不符
      assistantEntry(), // 对照行
    ].join('\n')
    await writeFile(join(tmpDir, 'rename-3.jsonl'), content)

    const svc = new UsageStatsService(tmpDir)
    const result = await svc.getStats()

    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].provider).toBe('kimi-coding')
    // 存在性守卫不命中 ≠ 行级失败，不计 skippedLines
    expect(result.skippedLines).toBe(0)
  })

  it('④ data.model 缺失/非 string/空串回退 rename-session（守卫与 ③ 对称）', async () => {
    const content = [
      sessionEntry('/Users/dev/rename-modelfb'),
      renameSessionEntry({ data: { usage: RENAME_USAGE } }), // model 缺失
      renameSessionEntry({ data: { model: '', usage: RENAME_USAGE } }), // 空串
      renameSessionEntry({ data: { model: 42, usage: RENAME_USAGE } }), // 非 string
    ].join('\n')
    await writeFile(join(tmpDir, 'rename-4.jsonl'), content)

    const svc = new UsageStatsService(tmpDir)
    const result = await svc.getStats()

    expect(result.rows).toHaveLength(3)
    for (const row of result.rows) {
      expect(row.provider).toBe('rename-session')
      expect(row.model).toBe('rename-session')
      expect(row.input).toBe(800)
    }
  })

  it('④ timestamp 非法 → skippedLines++（行级失败既有语义）', async () => {
    const content = [
      sessionEntry('/Users/dev/rename-ts'),
      renameSessionEntry({ data: { model: 'm', usage: RENAME_USAGE }, timestamp: 'not-a-date' }),
      renameSessionEntry({ data: { model: 'm', usage: RENAME_USAGE } }), // 合法对照
    ].join('\n')
    await writeFile(join(tmpDir, 'rename-5.jsonl'), content)

    const svc = new UsageStatsService(tmpDir)
    const result = await svc.getStats()

    expect(result.rows).toHaveLength(1)
    expect(result.skippedLines).toBe(1)
  })

  // ── cwd 无 basename 场景 ─────────────────────────────────

  it('cwd 为空字符串时 project 为 (unknown)', async () => {
    const content = [
      JSON.stringify({ type: 'session', id: 'empty-cwd', timestamp: '2026-08-25T00:00:00.000Z', cwd: '' }),
      assistantEntry(),
    ].join('\n')
    await writeFile(join(tmpDir, 'empty-cwd.jsonl'), content)

    const svc = new UsageStatsService(tmpDir)
    const result = await svc.getStats()

    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].project).toBe('(unknown)')
  })

  // ── 两层扫描（方案 B 布局：pi 按 cwd 分 encodeCwd 子目录）──

  it('两层扫描：encodeCwd 子目录内的 .jsonl 被统计（方案 B 布局核心回归）', async () => {
    const subDir = join(tmpDir, encodeCwd('/Users/dev/project-sub'))
    await mkdir(subDir, { recursive: true })
    const content = [
      sessionEntry('/Users/dev/project-sub'),
      assistantEntry(),
    ].join('\n')
    await writeFile(join(subDir, 'sub-1.jsonl'), content)

    const svc = new UsageStatsService(tmpDir)
    const result = await svc.getStats()

    // 单层 readdir 会漏掉子目录文件 → 统计归零；两层扫描后子目录文件计入
    expect(result.rows).toHaveLength(1)
    expect(result.sessionCount).toBe(1)
    expect(result.rows[0].project).toBe('project-sub')
  })

  it('两层扫描：根层与子目录文件混合统计', async () => {
    await writeFile(join(tmpDir, 'root.jsonl'), [
      sessionEntry('/Users/dev/root-proj'),
      assistantEntry(),
    ].join('\n'))
    const subDir = join(tmpDir, encodeCwd('/Users/dev/sub-proj'))
    await mkdir(subDir, { recursive: true })
    await writeFile(join(subDir, 'sub.jsonl'), [
      sessionEntry('/Users/dev/sub-proj'),
      assistantEntry(),
    ].join('\n'))

    const svc = new UsageStatsService(tmpDir)
    const result = await svc.getStats()

    expect(result.rows).toHaveLength(2)
    expect(result.sessionCount).toBe(2)
    const projects = result.rows.map((r) => r.project).sort()
    expect(projects).toEqual(['root-proj', 'sub-proj'])
  })

  it('两层扫描：只下钻一层，孙目录不扫（pi 只写一层 encodeCwd）', async () => {
    const subDir = join(tmpDir, encodeCwd('/Users/dev/level-1'))
    const grandDir = join(subDir, 'nested-deeper')
    await mkdir(grandDir, { recursive: true })
    await writeFile(join(grandDir, 'grand.jsonl'), [
      sessionEntry('/Users/dev/grand'),
      assistantEntry(),
    ].join('\n'))

    const svc = new UsageStatsService(tmpDir)
    const result = await svc.getStats()

    expect(result.rows).toHaveLength(0)
    expect(result.sessionCount).toBe(0)
  })

  it('两层扫描：子目录内的排除规则依然生效（.tmp-migrate- 残留 / sidecar）', async () => {
    const subDir = join(tmpDir, encodeCwd('/Users/dev/mig-sub'))
    await mkdir(subDir, { recursive: true })
    const content = [
      sessionEntry('/Users/dev/mig-sub'),
      assistantEntry(),
    ].join('\n')
    // 正常文件（子目录内）
    await writeFile(join(subDir, 'normal.jsonl'), content)
    // 残留文件（子目录内，应被排除）
    await writeFile(join(subDir, 'normal.jsonl.tmp-migrate-99.jsonl'), content)
    // sidecar（子目录内，不以 .jsonl 结尾，天然排除）
    await writeFile(join(subDir, 'normal.jsonl.meta.json'), JSON.stringify({ type: 'session_end' }))

    const svc = new UsageStatsService(tmpDir)
    const result = await svc.getStats()

    expect(result.rows).toHaveLength(1)
    expect(result.sessionCount).toBe(1)
  })

  // [2026-09 测试舰队审查 r2-27] 「真实数据冒烟测试」用例已删：目录不存在/rows 为空
  // 双静默 return 使其永不红（探针非回归测试），且引用真实数据目录并占 60s 超时预算；
  // 合规性断言已由上方各解析/聚合/缓存用例以受控 fixture 覆盖。

})
