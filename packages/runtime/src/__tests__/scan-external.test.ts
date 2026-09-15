/**
 * scanExternalSessions 外部目录扫描原语测试（import-session D3 / U1）。
 *
 * 锁定行为：
 * - 正常 .jsonl（首行合法 session header）被扫出，id/cwd/name 字段取自文件内容
 * - header 缺 id / 缺 cwd / id 空串的 .jsonl 不收录（D1 字段清单：缺 id 会让
 *   matchesQuery 短 ID 匹配 TypeError 令搜索整体崩溃，候选侧前置拒收）
 * - `.tmp-migrate-` / `.tmp-import-` 标记文件被 isScannableSessionFile 过滤
 *   （D1/r2-S1：候选侧与清扫侧同规则，扫描器从机制上看不到任何非 final 名文件）
 * - 一层子目录内文件被扫出；两层深目录静默跳过（D3/S8 深度假设）
 * - 独立 TTL 缓存：默认读命中快照、force 绕过强制重扫（与太极根 scanDirCache 互不污染）
 * - items 按 lastModified 降序（与 scanPiSessions 一致）
 * - cleanupTmpMigrateResidue 家族扩展：`.tmp-import-` 残留与 `.tmp-migrate-` 同规则清扫
 *
 * 断言锚定外部夹具事实：期望值只来自手写 JSONL 内容，不从实现内部状态断言。
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanExternalSessions, parseHeaderFromFirstLine } from '../infra/pi/session-file-external-scan.js'
import { cleanupTmpMigrateResidue } from '../infra/pi/session-file-utils.js'

let rootDir: string

/** 手写合法 session JSONL：首行 header（type/id/cwd/timestamp）+ session_info name 行。 */
function writeSessionJsonl(filePath: string, id: string, cwd: string, name: string): void {
  const lines = [
    JSON.stringify({ type: 'session', id, cwd, timestamp: '2026-01-01T00:00:00.000Z', version: 1 }),
    JSON.stringify({ type: 'session_info', name }),
    '',
  ]
  writeFileSync(filePath, lines.join('\n'))
}

beforeAll(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'scan-external-'))
})

afterAll(() => {
  rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

describe('scanExternalSessions', () => {
  it('扫出顶层正常文件，meta 字段取自文件内容', async () => {
    writeSessionJsonl(join(rootDir, 'alpha.jsonl'), 'id-alpha-111', '/tmp/proj-alpha', 'Alpha')
    const { items, rootDir: echoed } = await scanExternalSessions(rootDir, { force: true })
    expect(echoed).toBe(rootDir)
    const alpha = items.find((m) => m.id === 'id-alpha-111')
    expect(alpha).toBeDefined()
    expect(alpha!.cwd).toBe('/tmp/proj-alpha')
    expect(alpha!.name).toBe('Alpha')
    expect(alpha!.filePath).toBe(join(rootDir, 'alpha.jsonl'))
  })

  it('.tmp-migrate- / .tmp-import- 标记文件不出现在结果中（正常文件不受波及）', async () => {
    writeSessionJsonl(join(rootDir, 'a.jsonl.tmp-migrate-123.jsonl'), 'id-tmp-mig', '/tmp/x', 'TmpMig')
    writeSessionJsonl(join(rootDir, 'b.jsonl.tmp-import-456.jsonl'), 'id-tmp-imp', '/tmp/x', 'TmpImp')
    const { items } = await scanExternalSessions(rootDir, { force: true })
    expect(items.some((m) => m.id === 'id-tmp-mig')).toBe(false)
    expect(items.some((m) => m.id === 'id-tmp-imp')).toBe(false)
    expect(items.some((m) => m.id === 'id-alpha-111')).toBe(true)
  })

  it('首行非 session header 的 .jsonl 不收录（按内容识别，非仅文件名）', async () => {
    writeFileSync(join(rootDir, 'notes.jsonl'), 'not a session header line\n')
    const { items } = await scanExternalSessions(rootDir, { force: true })
    expect(items.some((m) => m.filePath.endsWith('notes.jsonl'))).toBe(false)
  })

  it('header 缺 id / 缺 cwd / id 空串的 .jsonl 不收录（D1 字段清单，正常文件不受波及）', async () => {
    // 缺 id：修复前会被宽松收录为 id===undefined，令 import-service.matchesQuery 的
    // sessionId.slice(0, 6) TypeError（任意搜索词下 listCandidates 整体崩溃）
    writeFileSync(join(rootDir, 'no-id.jsonl'), [
      JSON.stringify({ type: 'session', version: 1, cwd: '/tmp/no-id', timestamp: '2026-01-01T00:00:00.000Z' }),
      '',
    ].join('\n'))
    // 缺 cwd：同清单拒绝（encodeCwd(undefined) 会 TypeError，导入侧本来也拒）
    writeFileSync(join(rootDir, 'no-cwd.jsonl'), [
      JSON.stringify({ type: 'session', version: 1, id: 'no-cwd-id-0001', timestamp: '2026-01-01T00:00:00.000Z' }),
      '',
    ].join('\n'))
    // id 空串：非空字符串校验
    writeFileSync(join(rootDir, 'empty-id.jsonl'), [
      JSON.stringify({ type: 'session', version: 1, id: '', cwd: '/tmp/empty-id', timestamp: '2026-01-01T00:00:00.000Z' }),
      '',
    ].join('\n'))
    const { items } = await scanExternalSessions(rootDir, { force: true })
    expect(items.some((m) => m.filePath.endsWith('no-id.jsonl'))).toBe(false)
    expect(items.some((m) => m.filePath.endsWith('no-cwd.jsonl'))).toBe(false)
    expect(items.some((m) => m.filePath.endsWith('empty-id.jsonl'))).toBe(false)
    expect(items.some((m) => m.id === 'id-alpha-111')).toBe(true)
  })

  it('一层子目录内文件被扫出，两层深目录静默跳过', async () => {
    const sub = join(rootDir, 'proj-sub')
    mkdirSync(sub, { recursive: true })
    writeSessionJsonl(join(sub, 'sub.jsonl'), 'id-sub-333', '/tmp/proj-sub', 'Sub')
    const deep = join(rootDir, 'proj-sub', 'nested')
    mkdirSync(deep, { recursive: true })
    writeSessionJsonl(join(deep, 'deep.jsonl'), 'id-deep-444', '/tmp/deep', 'Deep')
    const { items } = await scanExternalSessions(rootDir, { force: true })
    expect(items.some((m) => m.id === 'id-sub-333')).toBe(true)
    expect(items.some((m) => m.id === 'id-deep-444')).toBe(false)
  })

  it('items 按 lastModified 降序排列', async () => {
    const f1 = join(rootDir, 'older.jsonl')
    writeSessionJsonl(f1, 'id-older-555', '/tmp/sort', 'Older')
    const f2 = join(rootDir, 'newer.jsonl')
    writeSessionJsonl(f2, 'id-newer-666', '/tmp/sort', 'Newer')
    const oldTime = new Date(Date.now() - 60_000)
    utimesSync(f1, oldTime, oldTime)
    const { items } = await scanExternalSessions(rootDir, { force: true })
    const idxOlder = items.findIndex((m) => m.id === 'id-older-555')
    const idxNewer = items.findIndex((m) => m.id === 'id-newer-666')
    expect(idxOlder).toBeGreaterThan(-1)
    expect(idxNewer).toBeGreaterThan(-1)
    expect(idxNewer).toBeLessThan(idxOlder)
  })

  it('独立 TTL 缓存：默认读命中快照，force 绕过强制重扫', async () => {
    // 独立目录：排除本文件其他用例写入对缓存断言的干扰
    const cacheDir = mkdtempSync(join(tmpdir(), 'scan-external-cache-'))
    try {
      writeSessionJsonl(join(cacheDir, 'cache-a.jsonl'), 'id-cache-a', '/tmp/c', 'CacheA')
      const first = await scanExternalSessions(cacheDir) // miss → 重扫并写缓存
      expect(first.items.some((m) => m.id === 'id-cache-a')).toBe(true)
      writeSessionJsonl(join(cacheDir, 'cache-b.jsonl'), 'id-cache-b', '/tmp/c', 'CacheB')
      const second = await scanExternalSessions(cacheDir) // 1s TTL 窗口内 → 命中 pre-write 快照
      expect(second.items.some((m) => m.id === 'id-cache-b')).toBe(false)
      const forced = await scanExternalSessions(cacheDir, { force: true })
      expect(forced.items.some((m) => m.id === 'id-cache-b')).toBe(true)
    } finally {
      rmSync(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('根目录不存在 → items 为空，不抛错', async () => {
    const { items, rootDir: echoed } = await scanExternalSessions(join(rootDir, 'no-such-dir'))
    expect(items).toEqual([])
    expect(echoed).toBe(join(rootDir, 'no-such-dir'))
  })

  it('205 文件分批让出：批间 setImmediate >= ceil(205/100)-1 次，且分批不丢文件（D3/MF-3）', async () => {
    // 独立目录：205 个文件只服务本用例的计数断言，不污染共享 rootDir 的其他用例
    const batchDir = mkdtempSync(join(tmpdir(), 'scan-external-batch-'))
    // spy 默认透传原实现（行为零改变，promise 照常 resolve），只计数批间让出。
    // 不用 fake timers：vi.useFakeTimers 会接管 setImmediate 需手动推进 tick，且与
    // fs/promises 的真实线程池 I/O（readdir/stat 回调）交互会引入推进顺序耦合。
    const spy = vi.spyOn(globalThis, 'setImmediate')
    try {
      const TOTAL = 205
      const expectedIds = new Set<string>()
      for (let i = 0; i < TOTAL; i++) {
        const id = `id-batch-${String(i).padStart(3, '0')}`
        expectedIds.add(id)
        writeSessionJsonl(join(batchDir, `batch-${String(i).padStart(3, '0')}.jsonl`), id, '/tmp/batch', `Batch${i}`)
      }
      const { items } = await scanExternalSessions(batchDir, { force: true })
      // 分批不丢文件：205 个全部扫出（批切分对结果集无影响）
      expect(items).toHaveLength(TOTAL)
      const scannedIds = new Set(items.map((m) => m.id))
      for (const id of expectedIds) {
        expect(scannedIds.has(id)).toBe(true)
      }
      // 批间让出下界：205 文件 / 批 100 → 3 批 → 至少 2 次批间 setImmediate 让出
      //（实现每次让出恰 1 次调用；用下界断言容许 fs/promises 等无关路径的偶发调用）
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(Math.ceil(TOTAL / 100) - 1)
    } finally {
      spy.mockRestore()
      rmSync(batchDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})

describe('scanExternalSessions name 三级定位（D3 二次修订轻量提取）', () => {
  /** 头块/尾块预算与实现一致（64KB）；用例构造以此为边界前提。 */
  const NAME_BLOCK = 64 * 1024

  it('尾块命中：同文件多条 session_info 取最后一条（rename append 尾部覆盖创建期命名）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scan-external-name-tail-'))
    try {
      // 小文件：尾块（64KB）覆盖全文件，无残行丢弃
      writeFileSync(join(dir, 'tail.jsonl'), [
        JSON.stringify({ type: 'session', id: 'id-name-tail', cwd: '/tmp/nt', timestamp: '2026-01-01T00:00:00.000Z' }),
        JSON.stringify({ type: 'session_info', name: 'OldName' }),
        JSON.stringify({ type: 'message', m: 'x' }),
        JSON.stringify({ type: 'session_info', name: 'NewName' }),
        '',
      ].join('\n'))
      const { items } = await scanExternalSessions(dir, { force: true })
      expect(items.find((m) => m.id === 'id-name-tail')?.name).toBe('NewName')
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('尾块未命中 → 头块第一个 session_info（创建期写入 + 长对话把 session_info 留在头部）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scan-external-name-head-'))
    try {
      const head = [
        JSON.stringify({ type: 'session', id: 'id-name-head', cwd: '/tmp/nh', timestamp: '2026-01-01T00:00:00.000Z' }),
        JSON.stringify({ type: 'session_info', name: 'HeadName' }),
      ].map((l) => l + '\n').join('')
      // > 128KB 的 message 行：尾块（最后 64KB）只含 message，session_info 只在头块
      const msgLine = JSON.stringify({ type: 'message', text: 'x'.repeat(200) }) + '\n'
      const count = Math.ceil(((NAME_BLOCK * 2 + 8 * 1024) - head.length) / msgLine.length)
      writeFileSync(join(dir, 'head.jsonl'), head + msgLine.repeat(count))
      const { items } = await scanExternalSessions(dir, { force: true })
      const meta = items.find((m) => m.id === 'id-name-head')
      expect(meta).toBeDefined()
      expect(meta!.name).toBe('HeadName')
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('两块均未命中 → name=null 且条目仍收录（header 合法即收录，UI 回退目录名显示）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scan-external-name-null-'))
    try {
      const head = JSON.stringify({ type: 'session', id: 'id-name-null', cwd: '/tmp/nn', timestamp: '2026-01-01T00:00:00.000Z' }) + '\n'
      const msgLine = JSON.stringify({ type: 'message', text: 'x'.repeat(200) }) + '\n'
      const count = Math.ceil(((NAME_BLOCK * 2 + 8 * 1024) - head.length) / msgLine.length)
      writeFileSync(join(dir, 'null.jsonl'), head + msgLine.repeat(count))
      const { items } = await scanExternalSessions(dir, { force: true })
      const meta = items.find((m) => m.id === 'id-name-null')
      expect(meta).toBeDefined()
      expect(meta!.name).toBe(null)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('跨 64KB 头块边界的残行不参与 name 定位（半个 JSON 行 skip，对齐 readTailEntries 残行语义）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scan-external-name-cut-'))
    try {
      // 整行 = 合法 session_info + 80 空格 + 另一个 JSON 值：整行 JSON.parse 失败（一行两个值），
      // 但被 64KB 边界切断后的前缀（首对象 + 若干空格）trim 后可独立 parse——若头块不丢弃
      // 末残行，会错误命中 name='CutOk'；正确行为是丢弃残行 → 头块无完整 session_info → null
      const header = JSON.stringify({ type: 'session', id: 'id-name-cut', cwd: '/tmp/nc', timestamp: '2026-01-01T00:00:00.000Z' }) + '\n'
      const straddle =
        JSON.stringify({ type: 'session_info', name: 'CutOk' }) + ' '.repeat(80) +
        JSON.stringify({ type: 'message', m: 'second-value-makes-full-line-invalid' })
      // 让 straddle 行起于 64KB-50：首对象（38B）落在边界前，切点落在其后的空格区
      const lineStart = NAME_BLOCK - 50
      const padLine = 'p'.repeat(63) + '\n'
      let pad = ''
      while (header.length + pad.length + padLine.length <= lineStart) pad += padLine
      const remain = lineStart - header.length - pad.length
      if (remain > 0) pad += 'p'.repeat(remain - 1) + '\n'
      // 末尾 message 行（非合法 JSON）确保文件收尾，也验证畸形行被跳过
      writeFileSync(join(dir, 'cut.jsonl'), header + pad + straddle + '\n' + 'm'.repeat(100) + '\n')
      const { items } = await scanExternalSessions(dir, { force: true })
      const meta = items.find((m) => m.id === 'id-name-cut')
      expect(meta).toBeDefined()
      expect(meta!.name).toBe(null)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})

describe('readFirstLine 跨块多字节解码（r1-S2）', () => {
  /** header 读块大小与实现一致（4KB）；构造首 CJK 字节跨 4096 边界的首行。 */
  const CHUNK = 4096

  it('多字节 CJK 字符跨 4KB 块边界：cwd 解码无 U+FFFD 损坏', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scan-external-cjk-'))
    try {
      const prefix = '{"type":"session","version":1,"id":"id-cjk-cross","cwd":"'
      const tail = '","timestamp":"2026-01-01T00:00:00.000Z"}'
      const cjk = '极长的中文路径目录名用于跨越块边界测试'
      // pad 到首 CJK 字节恰在 4095（3 字节字符占 4095-4097，跨 4096 边界）
      const padLen = CHUNK - 1 - prefix.length
      const firstLine = prefix + 'a'.repeat(padLen) + cjk + tail
      writeFileSync(join(dir, 'cjk.jsonl'), firstLine + '\n')
      const { items } = await scanExternalSessions(dir, { force: true })
      const meta = items.find((m) => m.id === 'id-cjk-cross')
      expect(meta).toBeDefined()
      const expectedCwd = 'a'.repeat(padLen) + cjk
      expect(meta!.cwd).toBe(expectedCwd)
      expect(meta!.cwd.includes('\uFFFD')).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})

describe('parseHeaderFromFirstLine 直测（r1-S15）', () => {
  it('合法首行：id/cwd/timestamp 全取', () => {
    expect(parseHeaderFromFirstLine('{"type":"session","id":"a1","cwd":"/x","timestamp":"2026-01-01T00:00:00.000Z"}'))
      .toEqual({ id: 'a1', cwd: '/x', timestamp: '2026-01-01T00:00:00.000Z' })
  })

  it('畸形首行返回 null：非 JSON / 非 object / type 非 session / id 空串 / cwd 空串', () => {
    expect(parseHeaderFromFirstLine('not json at all')).toBeNull()
    expect(parseHeaderFromFirstLine('42')).toBeNull()
    expect(parseHeaderFromFirstLine('null')).toBeNull()
    expect(parseHeaderFromFirstLine('{"type":"message","id":"a","cwd":"/x"}')).toBeNull()
    expect(parseHeaderFromFirstLine('{"type":"session","id":"","cwd":"/x"}')).toBeNull()
    expect(parseHeaderFromFirstLine('{"type":"session","id":"a","cwd":""}')).toBeNull()
  })

  it('timestamp 非字符串缺省读出为空串（零消费对齐保留字段）', () => {
    expect(parseHeaderFromFirstLine('{"type":"session","id":"a","cwd":"/x"}'))
      .toEqual({ id: 'a', cwd: '/x', timestamp: '' })
  })
})

describe('cleanupTmpMigrateResidue（.tmp-import- 家族扩展）', () => {
  it('.tmp-import- 残留与 .tmp-migrate- 同规则清扫：过期删、新鲜留、正常文件不碰', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scan-external-cleanup-'))
    try {
      const staleImport = join(dir, 'x.jsonl.tmp-import-111.jsonl')
      const staleMigrate = join(dir, 'y.jsonl.tmp-migrate-222.jsonl')
      const freshImport = join(dir, 'z.jsonl.tmp-import-333.jsonl')
      const normal = join(dir, 'keep.jsonl')
      writeFileSync(staleImport, 'x')
      writeFileSync(staleMigrate, 'y')
      writeFileSync(freshImport, 'z')
      writeFileSync(normal, 'n')
      // stale 残留拨老 2h（> 默认 1h maxAge）；fresh 保持刚写入的 mtime
      const oldTime = new Date(Date.now() - 7_200_000)
      utimesSync(staleImport, oldTime, oldTime)
      utimesSync(staleMigrate, oldTime, oldTime)

      const removed = cleanupTmpMigrateResidue(dir)
      expect(removed).toBe(2)
      expect(existsSync(staleImport)).toBe(false)
      expect(existsSync(staleMigrate)).toBe(false)
      expect(existsSync(freshImport)).toBe(true)
      expect(existsSync(normal)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('一层子目录内的两前缀残留同样被清扫，返回合计删除数', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scan-external-cleanup-sub-'))
    try {
      const sub = join(dir, 'proj-x')
      mkdirSync(sub, { recursive: true })
      const staleSub = join(sub, 's.jsonl.tmp-import-444.jsonl')
      writeFileSync(staleSub, 's')
      const oldTime = new Date(Date.now() - 7_200_000)
      utimesSync(staleSub, oldTime, oldTime)
      const removed = cleanupTmpMigrateResidue(dir)
      expect(removed).toBe(1)
      expect(existsSync(staleSub)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
