/**
 * 会话产物目录保留期扫描单测（chat-html-support §6.7 D7 回收② / §11 检查点 7）。
 *
 * 夹具全部落在 `mkdtempSync(tmpdir())` 自建自删（仓规测试红线：禁触碰真实数据目录），
 * 根目录经 `ArtifactRetentionRoots` 注入——三棵树夹具**用真实嵌套层级**：
 *   主树     `<sessionsRoot>/<encodeCwd>/<ISO>_<sid>.jsonl`（两层）
 *   subagent `<subagentsRoot>/<encodeCwd>/sessions/<ISO>_<sid>.jsonl`（三层）
 *   btw      `<btwRoot>/<encodeCwd>/<mainSid>/<ISO>_<sid>.jsonl`（三层）
 * **禁平铺**——平铺夹具会让判据实现错误假绿（单层 readdir 也能命中）。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/artifact-retention.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  DEFAULT_ARTIFACTS_KEEP_DAYS,
  cleanExpiredArtifactDirs,
  readArtifactKeepDays,
  sessionFileIdFromName,
  sessionFileNameMatchesDir,
  type ArtifactRetentionRoots,
} from '../artifact-retention.js'

const MS_PER_DAY = 24 * 60 * 60 * 1000
/** pi 会话文件名前缀（真实形态实测锚点，见 sessionFileIdFromName 头注）。 */
const ISO = '2026-09-02T14-40-39-107Z'
const ENCODE_CWD = '--Users-x-proj--'
const UUID = '01a10148-1ac9-732c-8e08-782374d56b3d'
const OTHER_UUID = '01a0cb17-dceb-7453-8eac-d553ed3a266a'

let base: string
let roots: ArtifactRetentionRoots
let now: number

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'taiji-artifact-retention-'))
  roots = {
    artifactsRoot: join(base, 'artifacts'),
    sessionsRoot: join(base, 'sessions'),
    subagentsRoot: join(base, 'subagents'),
    btwRoot: join(base, 'btw'),
  }
  now = Date.now()
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/** 建产物目录 + 一个文件，文件 mtime 回调注入（默认 30 天前 = 超龄）。 */
function writeArtifactDir(sid: string, opts: { fileMtimeMs?: number; noFile?: boolean } = {}): string {
  const dir = join(roots.artifactsRoot as string, sid)
  mkdirSync(dir, { recursive: true })
  if (!opts.noFile) {
    const file = join(dir, 'report.html')
    writeFileSync(file, '<html><body>x</body></html>')
    const t = (opts.fileMtimeMs ?? now - 30 * MS_PER_DAY) / 1000
    utimesSync(file, t, t)
  }
  return dir
}

/** 写会话文件（mkdir 全路径）。 */
function writeSessionFile(filePath: string): string {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, '{"type":"session"}\n')
  return filePath
}

/**
 * 三棵树活会话保护用例骨架：建产物目录 + 在 `sessionFilePath` 落会话文件 → 跑清理 →
 * 断言产物目录 `sid` 超龄仍被保留（`removed` 不含、目录仍在）。
 */
function expectProtectedBy(sessionFilePath: string, sid: string): void {
  writeArtifactDir(sid)
  writeSessionFile(sessionFilePath)
  const r = cleanExpiredArtifactDirs(roots, 7, now)
  expect(r.removed).toEqual([])
  expect(existsSync(join(roots.artifactsRoot as string, sid))).toBe(true)
}

/**
 * 「不超龄/未命中判据 → 保留」用例骨架：跑清理 → 断言 `removed` 不含任何目录、
 * `dir` 仍在磁盘。
 */
function expectKept(dir: string): void {
  const r = cleanExpiredArtifactDirs(roots, 7, now)
  expect(r.removed).toEqual([])
  expect(existsSync(dir)).toBe(true)
}

describe('sessionFileIdFromName / sessionFileNameMatchesDir（与 image-cache.ts 同型解析）', () => {
  it('主文件 `<ISO>_<uuid>.jsonl` 与 sidecar 均解析出同一 uuid', () => {
    expect(sessionFileIdFromName(`${ISO}_${UUID}.jsonl`)).toBe(UUID)
    expect(sessionFileIdFromName(`${ISO}_${UUID}.jsonl.meta.json`)).toBe(UUID)
    expect(sessionFileIdFromName(`${ISO}_${UUID}.jsonl.alive`)).toBe(UUID)
  })

  it('无 `_` 的未知形态回退剥后缀全名', () => {
    expect(sessionFileIdFromName('unknownfile')).toBe('unknownfile')
    expect(sessionFileIdFromName('unknownfile.jsonl')).toBe('unknownfile')
  })

  it('解析失配保守匹配：含 `_` 的 sid 经「首个 `_` 后全串」通道命中', () => {
    // lastIndexOf 解析 → '01'（末段），与目录名 'sess_AB_01' 不等
    expect(sessionFileIdFromName(`${ISO}_sess_AB_01.jsonl`)).toBe('01')
    // 保守通道命中 → 视为会话文件可能存在
    expect(sessionFileNameMatchesDir(`${ISO}_sess_AB_01.jsonl`, 'sess_AB_01')).toBe(true)
    // 无关目录名不得误保护
    expect(sessionFileNameMatchesDir(`${ISO}_${UUID}.jsonl`, 'sess_AB_01')).toBe(false)
  })
})

describe('cleanExpiredArtifactDirs —— 三棵树活会话保护（真实嵌套夹具）', () => {
  it('主树存在同名会话文件（两层）→ 超龄也不清', () => {
    expectProtectedBy(join(roots.sessionsRoot as string, ENCODE_CWD, `${ISO}_${UUID}.jsonl`), UUID)
  })

  it('subagent 树存在同名会话文件（三层）→ 超龄也不清', () => {
    expectProtectedBy(join(roots.subagentsRoot as string, ENCODE_CWD, 'sessions', `${ISO}_${UUID}.jsonl`), UUID)
  })

  it('btw 树存在同名会话文件（三层）→ 超龄也不清', () => {
    // btw 布局 = `<btwRoot>/<encodeCwd>/<mainSid>/<线会话文件>`；产物目录按**线 sid** 键控
    expectProtectedBy(join(roots.btwRoot as string, ENCODE_CWD, UUID, `${ISO}_${OTHER_UUID}.jsonl`), OTHER_UUID)
  })

  it('平铺形态（主树单层）不构成保护——证明判据须按真实嵌套层级实现', () => {
    writeArtifactDir(UUID)
    // 错误深度：会话文件直接放 sessions 根下（生产不发生）→ 不命中保护 → 超龄即清
    writeSessionFile(join(roots.sessionsRoot as string, `${ISO}_${UUID}.jsonl`))
    const r = cleanExpiredArtifactDirs(roots, 7, now)
    expect(r.removed).toEqual([UUID])
  })
})

describe('cleanExpiredArtifactDirs —— 超龄与新鲜度判定', () => {
  it('会话文件不存在 + 超龄 → 清（递归删整个目录）', () => {
    const dir = writeArtifactDir(UUID)
    mkdirSync(join(dir, 'assets'), { recursive: true })
    const asset = join(dir, 'assets', 'app.js')
    writeFileSync(asset, 'console.log(1)')
    const old = (now - 30 * MS_PER_DAY) / 1000
    utimesSync(asset, old, old)
    const r = cleanExpiredArtifactDirs(roots, 7, now)
    expect(r.scanned).toBe(1)
    expect(r.removed).toEqual([UUID])
    expect(existsSync(dir)).toBe(false)
  })

  it('刚写入目录（文件 mtime 新）→ 不清', () => {
    const dir = writeArtifactDir(UUID, { fileMtimeMs: now - 1000 })
    expectKept(dir)
  })

  it('原地改写反例：文件 mtime 新、目录条目 mtime 旧 → 按子树最新文件 mtime 判不超龄', () => {
    const dir = writeArtifactDir(UUID, { fileMtimeMs: now - 1000 })
    // 目录条目 mtime 置为 30 天前（原地改写不更新父目录 mtime 的真实形态）
    const old = (now - 30 * MS_PER_DAY) / 1000
    utimesSync(dir, old, old)
    expectKept(dir)
  })

  it('延迟写入窗口反例：目录刚建、会话文件尚未落盘但未超龄 → 不清', () => {
    const dir = writeArtifactDir(UUID, { noFile: true })
    expectKept(dir)
  })

  it('空目录 + 超龄 + 无会话文件 → 清（回落目录 mtime 计龄）', () => {
    const dir = writeArtifactDir(UUID, { noFile: true })
    const old = (now - 30 * MS_PER_DAY) / 1000
    utimesSync(dir, old, old)
    const r = cleanExpiredArtifactDirs(roots, 7, now)
    expect(r.removed).toEqual([UUID])
    expect(existsSync(dir)).toBe(false)
  })

  it('产物根不存在 → 静默跳过（scanned 0）', () => {
    const r = cleanExpiredArtifactDirs({ ...roots, artifactsRoot: join(base, 'nope') }, 7, now)
    expect(r).toEqual({ scanned: 0, removed: [] })
  })
})

describe('cleanExpiredArtifactDirs —— 目录名合法性与保守取向', () => {
  it('含 `:` 的虚拟 id 形态目录名不入判据（超龄 + 无会话文件也不清）', () => {
    const dir = writeArtifactDir(`btw:${UUID}`)
    const r = cleanExpiredArtifactDirs(roots, 7, now)
    expect(r.scanned).toBe(1)
    expect(r.removed).toEqual([])
    expect(existsSync(dir)).toBe(true)
  })

  it('解析失配保守用例：目录名与解析值不等（含 `_` 的 sid）→ 不清', () => {
    const sid = 'sess_AB_01'
    // 该 sid 的会话文件：末段解析 = '01' ≠ dirName，但真 sid 通道命中 → 保护
    expectProtectedBy(join(roots.sessionsRoot as string, ENCODE_CWD, `${ISO}_${sid}.jsonl`), sid)
  })

  it('sidecar 形态会话文件（.jsonl.meta.json）同样构成保护', () => {
    expectProtectedBy(join(roots.sessionsRoot as string, ENCODE_CWD, `${ISO}_${UUID}.jsonl.meta.json`), UUID)
  })
})

describe('readArtifactKeepDays（env 覆盖 || 默认，与 readLogKeepDays 同语义）', () => {
  it('未设 env → 默认 7', () => {
    expect(readArtifactKeepDays({})).toBe(DEFAULT_ARTIFACTS_KEEP_DAYS)
  })
  it('env 覆盖生效', () => {
    expect(readArtifactKeepDays({ TAIJI_ARTIFACTS_KEEP_DAYS: '3' })).toBe(3)
  })
  it('非法值回落默认', () => {
    expect(readArtifactKeepDays({ TAIJI_ARTIFACTS_KEEP_DAYS: 'abc' })).toBe(DEFAULT_ARTIFACTS_KEEP_DAYS)
    expect(readArtifactKeepDays({ TAIJI_ARTIFACTS_KEEP_DAYS: '' })).toBe(DEFAULT_ARTIFACTS_KEEP_DAYS)
  })
})
