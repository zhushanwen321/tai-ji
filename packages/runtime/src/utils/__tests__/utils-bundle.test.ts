import { atomicWrite, atomicWriteAsync } from '../fs-utils.js';
import { forEachReversedLineChunk } from '../history-reverse-read.js';
import { cleanupAgedBackupResidue } from '../json-store.js';
import { parseRuntimeArgs } from '../runtime-args.js';
import { spawnDataDirContractViolation } from '../runtime-env.js';
import { _resetWarnOnceForTest, warnOnce } from '../warn-once.js';
import { BASE_PORT, MAX_PORT } from '@taiji/shared';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← src/utils/__tests__/fs-utils.test.ts
// ======================================================================

function makeTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('fs-utils', () => {
describe('atomicWrite（RT-3#9）', () => {
  it('rename 失败（目标父目录不存在）→ 上抛且不留 tmp', () => {
    const dir = makeTmpDir('fs-utils-rename-')
    try {
      const target = join(dir, 'no-such-dir', 'f.json')
      expect(() => atomicWrite(target, 'data')).toThrow()
      // 目标目录本身未被创建，tmp 也不会落在其中；确认目录树里零残留
      expect(readdirSync(dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('rename 失败（目标是已存在目录）→ 上抛且同目录 tmp 被清理', () => {
    const dir = makeTmpDir('fs-utils-renamedir-')
    try {
      const target = join(dir, 'occupied')
      mkdirSync(target) // rename 一个目录名 → ENOTDIR/EISDIR 失败
      expect(() => atomicWrite(target, 'data')).toThrow()
      // tmp 写在 target 旁（同目录），失败后必须被清理
      expect(readdirSync(dir).filter(n => n.startsWith('occupied.tmp_'))).toEqual([])
      expect(existsSync(target)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('默认 tmp 名含 pid+序号：连续写成功且失败路径零残留（并发 tmp 名不互踩的行为范围）', () => {
    const dir = makeTmpDir('fs-utils-uniquename-')
    try {
      const target = join(dir, 'f.json')
      // 正向：同文件连续两次写（pid+序号使两次 tmp 名不同，rename 均成功）
      atomicWrite(target, 'v1')
      atomicWrite(target, 'v2')
      expect(readFileSync(target, 'utf-8')).toBe('v2')

      // 失败路径连续两次：tmp 各自清理，零残留
      const target2 = join(dir, 'occupied2')
      mkdirSync(target2)
      expect(() => atomicWrite(target2, 'x')).toThrow()
      expect(() => atomicWrite(target2, 'x')).toThrow()
      expect(readdirSync(dir).filter(n => n.includes('.tmp_'))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('显式 uniqueSuffix 仍生效（.tmp_<suffix> 形态）', () => {
    const dir = makeTmpDir('fs-utils-suffix-')
    try {
      const target = join(dir, 'f.json')
      const occupied = join(dir, 'occupied3')
      mkdirSync(occupied)
      expect(() => atomicWrite(occupied, 'x', 'custom-1')).toThrow()
      // 失败即清理——显式后缀的 tmp 同样不留
      expect(readdirSync(dir).filter(n => n.startsWith('occupied3.tmp_custom-1'))).toEqual([])
      atomicWrite(target, 'ok', 'custom-2')
      expect(existsSync(target)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
describe('atomicWriteAsync（RT-3#9 同族）', () => {
  it('rename 失败 → 上抛且 tmp 清理', async () => {
    const dir = makeTmpDir('fs-utils-async-')
    try {
      const target = join(dir, 'occupied4')
      mkdirSync(target)
      await expect(atomicWriteAsync(target, 'data')).rejects.toThrow()
      expect(readdirSync(dir).filter(n => n.startsWith('occupied4.tmp_'))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('正常路径写入成功', async () => {
    const dir = makeTmpDir('fs-utils-async-ok-')
    try {
      const target = join(dir, 'f.json')
      await atomicWriteAsync(target, '{"a":1}')
      expect(existsSync(target)).toBe(true)
      expect(readdirSync(dir)).toEqual(['f.json'])
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
});

// ======================================================================
// ← src/utils/__tests__/history-reverse-read.test.ts
// ======================================================================

let tmpDir: string


function write(name: string, content: string): string {
  const filePath = join(tmpDir, name)
  writeFileSync(filePath, content, 'utf-8')
  return filePath
}


/** 收集全部交付行的便捷封装（visit 按尾→头顺序调用，拼回文件正序需反转块序）。 */
function readAll(filePath: string, options: Parameters<typeof forEachReversedLineChunk>[1] = { chunkBytes: 64, maxTotalBytes: 1 << 20 }) {
  const chunks: string[][] = []
  const summary = forEachReversedLineChunk(filePath, options, (chunk) => {
    chunks.push(chunk.lines)
  })
  // 块内行正序；块间从尾向头推进 → 文件正序 = 块序反转后 flat
  const lines = chunks.slice().reverse().flat()
  return { lines, chunks, summary }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('history-reverse-read', () => {
// 每用例独立临时目录（fs-guard：tmpdir 白名单自建自删）
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'history-reverse-read-'))
})
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe('行边界对齐（断言⑦：JSONL 行不切断）', () => {
  it('块边界切断长行：拼接后交付的行与原文件行逐字一致（长行跨块）', () => {
    // 行长 300 字节 > chunkBytes 64：每块必然切断行
    const lines = Array.from({ length: 12 }, (_, i) => `L${i}-` + 'x'.repeat(300 - 4 + i))
    const filePath = write('long-lines.jsonl', lines.join('\n') + '\n')

    const { lines: delivered, summary } = readAll(filePath)

    expect(delivered).toEqual(lines)
    expect(summary.sawStart).toBe(true)
    expect(summary.stopped).toBe(false)
    expect(summary.fullyScanned).toBe(true)
  })

  it('块首切多字节序列（reviewer 探针复现）：offset 落『中』的 3 字节序列内 → 交付行无 U+FFFD、逐字一致', () => {
    // 精确字节布局：x*10(0-9) + 中(10-12, 3B) + y*10(13-22) + \n(23)，size=24
    // - chunkBytes=12 → 首块 offset=12 = 『中』第 3 字节（continuation）
    // - chunkBytes=13 → 首块 offset=11 = 『中』第 2 字节（continuation）
    // 两者均为构造性切中（非碰运气），修复前交付行首出现 U+FFFD
    const line = 'x'.repeat(10) + '中' + 'y'.repeat(10)
    const filePath = write('mb-single.jsonl', line + '\n')

    for (const chunkBytes of [12, 13]) {
      const { lines: delivered, summary } = readAll(filePath, { chunkBytes, maxTotalBytes: 1 << 20 })
      expect(delivered).toEqual([line])
      expect(delivered[0]).not.toContain('\ufffd')
      expect(summary.fullyScanned).toBe(true)
    }
  })

  it('多字节边界组合：中/emoji 混合长行 + chunkBytes 全相位扫描（4..40）逐字一致', () => {
    // 1/2/3/4 字节 UTF-8 字符混合（ASCII/é/中/😀），行长 > chunkBytes 上界 → 必然多块；
    // chunkBytes 4..40 全相位扫描：任意字节相位下块首切序列都被覆盖（含 2/3/4 字节序列）
    const lines = [
      'a',
      `中文${'é'.repeat(30)}${'😀'.repeat(20)}日本語テスト` + 'y'.repeat(120),
      'b',
      `${'😀'.repeat(40)}tail-emoji-heavy`,
      'tail-no-newline-末行无换行',
    ]
    const filePath = write('mb-mixed.jsonl', lines.join('\n')) // 无尾换行

    for (let chunkBytes = 4; chunkBytes <= 40; chunkBytes++) {
      const { lines: delivered, summary } = readAll(filePath, { chunkBytes, maxTotalBytes: 1 << 20 })
      expect(delivered, `chunkBytes=${chunkBytes}`).toEqual(lines)
      for (const l of delivered) expect(l, `chunkBytes=${chunkBytes}`).not.toContain('\ufffd')
      expect(summary.fullyScanned, `chunkBytes=${chunkBytes}`).toBe(true)
    }
  })

  it('跨块多行：多字节行与 ASCII 行交错，行归属不串（多 chunkBytes 扫描）', () => {
    const lines = [
      '中文行-1',
      'ascii-line-2',
      `emoji😀行-3-${'中'.repeat(50)}`,
      'x'.repeat(100),
      `${'😀'.repeat(10)}-尾行`,
    ]
    const filePath = write('mb-multiline.jsonl', lines.join('\n') + '\n')

    for (const chunkBytes of [4, 7, 12, 13, 16, 32]) {
      const { lines: delivered, summary } = readAll(filePath, { chunkBytes, maxTotalBytes: 1 << 20 })
      expect(delivered, `chunkBytes=${chunkBytes}`).toEqual(lines)
      for (const l of delivered) expect(l, `chunkBytes=${chunkBytes}`).not.toContain('\ufffd')
      expect(summary.fullyScanned, `chunkBytes=${chunkBytes}`).toBe(true)
    }
  })

  it('多字节 + 短行交错：短行/长行组合 + 尾行无换行（EOF 终止行完整交付）', () => {
    const lines = ['甲', '乙'.repeat(100), '丙', '丁'.repeat(99), 'tail-no-newline-尾']
    const filePath = write('mb-eof.jsonl', lines.join('\n')) // 无尾换行

    const { lines: delivered, summary } = readAll(filePath, { chunkBytes: 50, maxTotalBytes: 1 << 20 })

    expect(delivered).toEqual(lines)
    expect(summary.fullyScanned).toBe(true)
  })

  it('块恰与行边界对齐（文件以 \\n 结尾且块长整除）：无空残段误交付', () => {
    const lines = ['r1', 'r2', 'r3', 'r4']
    const filePath = write('aligned.jsonl', lines.join('\n') + '\n')

    // 每行 2 字节 + \n = 3 字节，chunkBytes=9 恰好整除
    const { lines: delivered } = readAll(filePath, { chunkBytes: 9, maxTotalBytes: 1 << 20 })

    expect(delivered).toEqual(lines)
  })
})
describe('迭代过程语义', () => {
  it('块内行正序 + 块间从尾向头推进 + totalBytesRead 累计', () => {
    const lines = ['a', 'b', 'c', 'd', 'e', 'f']
    const filePath = write('order.jsonl', lines.join('\n') + '\n')

    const { lines: delivered, summary } = readAll(filePath, { chunkBytes: 4, maxTotalBytes: 1 << 20 })

    // 多块迭代拼回后与原行序一致（块分布是实现细节，不锚定）
    expect(delivered).toEqual(lines)
    expect(summary.totalBytesRead).toBe(lines.join('\n').length + 1)
    expect(summary.fullyScanned).toBe(true)
  })

  it('visit 返回 false 提前停止：stopped=true、fullyScanned=false，当前块剩余更早行不交付', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line-${i}`)
    const filePath = write('stop.jsonl', lines.join('\n') + '\n')

    const delivered: string[] = []
    const summary = forEachReversedLineChunk(filePath, { chunkBytes: 8, maxTotalBytes: 1 << 20 }, ({ lines: chunkLines }) => {
      for (let i = chunkLines.length - 1; i >= 0; i--) {
        delivered.push(chunkLines[i])
        if (delivered.length >= 3) return false
      }
    })

    expect(summary.stopped).toBe(true)
    expect(summary.sawStart).toBe(false)
    expect(summary.fullyScanned).toBe(false)
    expect(delivered).toEqual(['line-9', 'line-8', 'line-7'])
  })

  it('总读取量上限截停：totalBytesRead = 上限、sawStart=false、不抛错', () => {
    const lines = Array.from({ length: 40 }, (_, i) => 'p'.repeat(100) + `-${i}`)
    const filePath = write('cap.jsonl', lines.join('\n') + '\n')
    const fullSize = lines.join('\n').length + 1

    const { lines: delivered, summary } = readAll(filePath, { chunkBytes: 128, maxTotalBytes: 300 })

    expect(summary.totalBytesRead).toBe(300)
    expect(summary.sawStart).toBe(false)
    expect(summary.stopped).toBe(false)
    expect(summary.fullyScanned).toBe(false)
    // 只交付了部分行（尾部），且总读取量被硬帽约束
    expect(delivered.length).toBeLessThan(lines.length)
    expect(fullSize).toBeGreaterThan(300)
  })
})
describe('边界输入', () => {
  it('空文件：sawStart/fullyScanned=true，不调用 visit', () => {
    const filePath = write('empty.jsonl', '')
    const visited: unknown[] = []
    const summary = forEachReversedLineChunk(filePath, { chunkBytes: 64, maxTotalBytes: 1024 }, (c) => {
      visited.push(c)
    })
    expect(visited).toHaveLength(0)
    expect(summary.fullyScanned).toBe(true)
  })

  it('文件不存在：openFailed=true 不抛错（INVAR-tail-4 同语义）', () => {
    const summary = forEachReversedLineChunk(join(tmpDir, 'nope.jsonl'), { chunkBytes: 64, maxTotalBytes: 1024 }, () => {})
    expect(summary.openFailed).toBe(true)
    expect(summary.totalBytesRead).toBe(0)
  })

  it('单块大于文件：一块读完（offset=0 无残行丢弃）', () => {
    const lines = ['one', 'two']
    const filePath = write('small.jsonl', lines.join('\n'))
    const { lines: delivered, summary } = readAll(filePath, { chunkBytes: 1 << 20, maxTotalBytes: 4 << 20 })
    expect(delivered).toEqual(lines)
    expect(summary.fullyScanned).toBe(true)
  })
})
});

// ======================================================================
// ← src/utils/__tests__/json-store-backup-retention.test.ts
// ======================================================================

let dir: string

let warnSpy: MockInstance<typeof console.warn>

let errorSpy: MockInstance<typeof console.error>


/** quarantineCorruptFile 同款压缩 ISO 时间戳（去冒号/点号）。 */
function compactIso(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString().replace(/[:.]/g, '')
}


const DAY = 24 * 60 * 60 * 1000

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('json-store-backup-retention', () => {
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'backup-retention-rt3-'))
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  warnSpy.mockRestore()
  errorSpy.mockRestore()
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
describe('cleanupAgedBackupResidue · 凭据副本分流（RT-3 附带项）', () => {
  it('普通副本超 7 天回收 + warn 记总数；凭据副本超 7 天但在 30 天内保留', () => {
    const regular = join(dir, `settings.json.corrupt-${compactIso(8 * DAY)}`)
    writeFileSync(regular, '{}', 'utf-8')
    const credKept = join(dir, `models.json.corrupt-${compactIso(10 * DAY)}`)
    writeFileSync(credKept, JSON.stringify({ providers: { x: { apiKey: 'sk-plain' } } }), 'utf-8')

    const removed = cleanupAgedBackupResidue([dir])

    expect(removed).toBe(1)
    expect(existsSync(regular)).toBe(false)
    expect(existsSync(credKept)).toBe(true)
    // 普通副本删除：一条 warn 记总数
    const warnMsg = warnSpy.mock.calls.map(c => String(c[0])).find(m => m.includes('aged backup copy'))
    expect(warnMsg).toBeDefined()
    expect(warnMsg).toContain('removed 1 aged backup copy')
    // 凭据副本保留期内：无 error
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('含 apiKey 的 models.json 副本超 30 天回收前升 error（含路径与不可恢复提示）', () => {
    const credExpired = join(dir, `models.json.corrupt-${compactIso(40 * DAY)}`)
    writeFileSync(credExpired, JSON.stringify({ providers: { x: { apiKey: 'sk-plain' } } }), 'utf-8')

    const removed = cleanupAgedBackupResidue([dir])

    expect(removed).toBe(1)
    expect(existsSync(credExpired)).toBe(false)
    const errMsg = errorSpy.mock.calls.map(c => String(c[0])).find(m => m.includes('credential-bearing backup'))
    expect(errMsg).toBeDefined()
    expect(errMsg).toContain(credExpired)
    expect(errMsg).toContain('不可恢复')
    // 凭据副本不计入普通 warn 总数（removed=1 但 regularRemoved=0 → 无 warn）
    expect(warnSpy.mock.calls.filter(c => String(c[0]).includes('aged backup copy'))).toHaveLength(0)
  })

  it('不含 apiKey 的 models.json 副本按普通 7 天窗口处置（嗅探不误伤）', () => {
    const noKey = join(dir, `models.json.corrupt-${compactIso(8 * DAY)}`)
    writeFileSync(noKey, JSON.stringify({ providers: { x: { name: 'x' } } }), 'utf-8')

    const removed = cleanupAgedBackupResidue([dir])

    expect(removed).toBe(1)
    expect(existsSync(noKey)).toBe(false)
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('7 天内的普通副本保留（取证窗口）', () => {
    const fresh = join(dir, `settings.json.corrupt-${compactIso(2 * DAY)}`)
    writeFileSync(fresh, '{}', 'utf-8')

    const removed = cleanupAgedBackupResidue([dir])

    expect(removed).toBe(0)
    expect(existsSync(fresh)).toBe(true)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  // ── RT-5#7：provider-extras-migration 的 `.bak-migrate-` 备份纳入回收家族 ──
  // 后缀形态 = `${path}.bak-migrate-<compactIso>`（与 conflict/corrupt 同构，判龄走文件名 ts）。
  // 含明文 apiKey 的旧 models.json 副本此前不在 AGED_BACKUP_SUFFIX_RE 内 → 永久驻留。

  it('RT-5#7：无凭据 .bak-migrate- 副本超 7 天按普通窗口回收', () => {
    const migrateBackup = join(dir, `models.json.bak-migrate-${compactIso(8 * DAY)}`)
    writeFileSync(migrateBackup, JSON.stringify({ providers: { x: { name: 'x' } } }), 'utf-8')

    const removed = cleanupAgedBackupResidue([dir])

    expect(removed).toBe(1)
    expect(existsSync(migrateBackup)).toBe(false)
  })

  it('RT-5#7：含 apiKey 的 .bak-migrate- 副本走 30 天凭据窗口（7-30 天保留，超 30 天回收 + error）', () => {
    const kept = join(dir, `models.json.bak-migrate-${compactIso(10 * DAY)}`)
    writeFileSync(kept, JSON.stringify({ providers: { x: { apiKey: 'sk-plain' } } }), 'utf-8')

    expect(cleanupAgedBackupResidue([dir])).toBe(0)
    expect(existsSync(kept)).toBe(true)

    const expired = join(dir, `models.json.bak-migrate-${compactIso(40 * DAY)}`)
    writeFileSync(expired, JSON.stringify({ providers: { x: { apiKey: 'sk-plain' } } }), 'utf-8')

    expect(cleanupAgedBackupResidue([dir])).toBe(1)
    expect(existsSync(expired)).toBe(false)
    const errMsg = errorSpy.mock.calls.map(c => String(c[0])).find(m => m.includes('credential-bearing backup'))
    expect(errMsg).toBeDefined()
    expect(errMsg).toContain(expired)
  })
})
});

// ======================================================================
// ← src/utils/__tests__/runtime-args.test.ts
// ======================================================================

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('runtime-args', () => {
describe('parseRuntimeArgs（组合根 argv 解析）', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('空 argv → 缺省：port = BASE_PORT（env 无偏移），其余字段缺省，remoteAccess=false', () => {
    expect(parseRuntimeArgs([])).toEqual({
      port: BASE_PORT,
      projectRoot: undefined,
      builtinPluginsDir: undefined,
      remoteAccess: false,
      mobileDist: undefined,
    })
  })

  it('空格形态：--port / --project-root / --builtin-plugins-dir / --mobile-dist / --remote-access', () => {
    const args = parseRuntimeArgs([
      '--port', '4000',
      '--project-root', '/tmp/proj',
      '--builtin-plugins-dir', '/tmp/plugins',
      '--remote-access',
      '--mobile-dist', '/tmp/mobile',
    ])
    expect(args).toEqual({
      port: 4000,
      projectRoot: '/tmp/proj',
      builtinPluginsDir: '/tmp/plugins',
      remoteAccess: true,
      mobileDist: '/tmp/mobile',
    })
  })

  it('等号形态：各 --flag=value 解析与空格形态等价', () => {
    const args = parseRuntimeArgs([
      '--port=4001',
      '--project-root=/tmp/proj',
      '--builtin-plugins-dir=/tmp/plugins',
      '--mobile-dist=/tmp/mobile',
      '--remote-access',
    ])
    expect(args).toEqual({
      port: 4001,
      projectRoot: '/tmp/proj',
      builtinPluginsDir: '/tmp/plugins',
      remoteAccess: true,
      mobileDist: '/tmp/mobile',
    })
  })

  it('路径含 = 按首个 = 切分不截断（code-harden P2 修复点）：--mobile-dist=', () => {
    expect(parseRuntimeArgs(['--mobile-dist=/tmp/a=b/dist']).mobileDist).toBe('/tmp/a=b/dist')
  })

  it('路径含 = 同款：--project-root= / --builtin-plugins-dir=', () => {
    expect(parseRuntimeArgs(['--project-root=/tmp/x=y']).projectRoot).toBe('/tmp/x=y')
    expect(parseRuntimeArgs(['--builtin-plugins-dir=/tmp/p=q']).builtinPluginsDir).toBe('/tmp/p=q')
  })

  it.each(['abc', '', '   '])('非法 --port 值（"%s"）→ throw，消息含原值（组合根包装 exit(1)）', (bad) => {
    expect(() => parseRuntimeArgs(['--port', bad])).toThrow(`invalid --port value: ${bad}`)
    expect(() => parseRuntimeArgs([`--port=${bad}`])).toThrow(`invalid --port value: ${bad}`)
  })

  it('末位悬空 flag（--port 无后续值）→ warn 缺值 + 按缺省处理（code-harden P2：不再静默）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(parseRuntimeArgs(['--port']).port).toBe(BASE_PORT)
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('--port 缺值')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('未知 flag（--remote-acces 拼错）→ warn 核对拼写指引 + 解析结果不受影响（不 throw，忽略语义保持）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const args = parseRuntimeArgs(['--remote-acces', '--port', '4003'])
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('--remote-acces')
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('remote-access')
      expect(args.remoteAccess).toBe(false)
      expect(args.port).toBe(4003)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('TAIJI_AGENT_PORT_OFFSET env 正偏移 port', () => {
    vi.stubEnv('TAIJI_AGENT_PORT_OFFSET', '100')
    expect(parseRuntimeArgs([]).port).toBe(BASE_PORT + 100)
  })

  it('TAIJI_AGENT_PORT_OFFSET 负值钳到 0、超上界钳到 MAX_PORT - BASE_PORT', () => {
    vi.stubEnv('TAIJI_AGENT_PORT_OFFSET', '-5')
    expect(parseRuntimeArgs([]).port).toBe(BASE_PORT)
    vi.stubEnv('TAIJI_AGENT_PORT_OFFSET', String(MAX_PORT))
    expect(parseRuntimeArgs([]).port).toBe(MAX_PORT)
  })

  it('--remote-access 不出现 → remoteAccess=false（argv 判据，无 env 通道）', () => {
    expect(parseRuntimeArgs(['--port', '4002']).remoteAccess).toBe(false)
  })
})
});

// ======================================================================
// ← src/utils/__tests__/runtime-env.test.ts
// ======================================================================

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('runtime-env', () => {
describe('spawnDataDirContractViolation（spawn 数据目录契约校验）', () => {
  it('打包态 + 缺 DATA_DIR → 违规（含 cause 与 recovery 行，错误可操作）', () => {
    const violation = spawnDataDirContractViolation({ TAIJI_AGENT_PACKAGED: '1' })
    expect(violation).not.toBeNull()
    const text = violation!.join('\n')
    expect(text).toContain('TAIJI_AGENT_PACKAGED=1')
    expect(text).toContain('resolvePackagedDataDir')
    expect(text).toContain('process-control.ts')
  })

  it('打包态 + 空 DATA_DIR → 同样违规（空串非有效注入）', () => {
    expect(spawnDataDirContractViolation({ TAIJI_AGENT_PACKAGED: '1', TAIJI_AGENT_DATA_DIR: '' })).not.toBeNull()
  })

  it('打包态 + 显式 DATA_DIR → 合规（正常 prod 形态）', () => {
    expect(
      spawnDataDirContractViolation({ TAIJI_AGENT_PACKAGED: '1', TAIJI_AGENT_DATA_DIR: '/home/u/.taiji' }),
    ).toBeNull()
  })

  it('非打包态（裸跑/验证脚本，无 PACKAGED 标志）→ 合规：走缺省落 dev 树不适用本契约', () => {
    expect(spawnDataDirContractViolation({})).toBeNull()
  })

  it('PACKAGED 非 "1" 值（0/true）→ 非打包态，合规', () => {
    expect(spawnDataDirContractViolation({ TAIJI_AGENT_PACKAGED: '0' })).toBeNull()
    expect(spawnDataDirContractViolation({ TAIJI_AGENT_PACKAGED: 'true' })).toBeNull()
  })
})
});

// ======================================================================
// ← src/utils/__tests__/warn-once.test.ts
// ======================================================================

let warnSpy_m2: MockInstance<typeof console.warn>

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('warn-once', () => {
beforeEach(() => {
  warnSpy_m2 = vi.spyOn(console, 'warn').mockImplementation(() => {})
  warnSpy_m2.mockClear() // 重复 spyOn 返回同一 spy，清累计调用
  _resetWarnOnceForTest()
})
describe('warnOnce（RT-5#6）', () => {
  it('同 key 只出声一次，不同 key 各出声一次', () => {
    warnOnce('/a/segments.json', 'msg-a')
    warnOnce('/a/segments.json', 'msg-a')
    warnOnce('/b/state.jsonl', 'msg-b')
    expect(warnSpy_m2).toHaveBeenCalledTimes(2)
    expect(String(warnSpy_m2.mock.calls[0]![0])).toBe('msg-a')
    expect(String(warnSpy_m2.mock.calls[1]![0])).toBe('msg-b')
  })

  it('detail 参数透传（原始错误消息随行）', () => {
    warnOnce('/a/state.jsonl', 'read failed', 'EACCES: permission denied')
    expect(warnSpy_m2.mock.calls[0]![1]).toBe('EACCES: permission denied')
  })

  it('reset 后同 key 可再次出声（测试隔离通道有效性）', () => {
    warnOnce('/a/segments.json', 'msg')
    _resetWarnOnceForTest()
    warnOnce('/a/segments.json', 'msg')
    expect(warnSpy_m2).toHaveBeenCalledTimes(2)
  })
})
});
