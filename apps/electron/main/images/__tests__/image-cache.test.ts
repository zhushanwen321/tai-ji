/**
 * toolResult 图片缓存生命周期测试（D6-⑨ / u7-memory-governance，main 侧）。
 *
 * 运行池：guarded（vitest.config projects——真实文件 IO，挂全套 fs-guard；夹具全部
 * mkdtempSync(tmpdir) 自建自删，TAIJI_AGENT_DATA_DIR 由 globalSetup 指向 tmp）。
 *
 * 覆盖（设计 A9③ 验收链）：
 * - 幂等写：同内容 hash 命中跳过写（cached），文件内容 = base64 解码原值
 * - 新→旧有序落盘、超帽即停（设计 v8 显式声明）：注入小帽，按新→旧传参，第 1 张落盘、
 *   后续全部 quota-full 且盘上无文件；帽满语义 = 最新图优先可见、更旧图占位
 * - 单 session size 帽：已占目录（预置文件）+ 新图超剩余额度 → 停
 * - cached 先于判帽（U4）：满帽 session 重开重放已落盘图全部命中 → 零占位；批内混合
 *   时已命中图不受未命中图超帽影响
 * - 孤儿扫描：mtime 超 30 天 + sessions 目录无对应 session 文件 → 判死删目录；
 *   活 session 目录（有文件）与新鲜孤儿目录保留；判据按文件名末段 `_` 后 uuid 段比对
 *   （U2，文件名形态 = 生产同构 `<ISO时间戳>_<uuid>.jsonl`，实测取样固化见 FIXTURE 常量）
 * - 缺省 sessionsDir 推导 = `<dataDir>/agent/sessions`（U1，方案 B 新布局：不传
 *   sessionsDir 时走真实层级，pi/sessions 旧布局诱饵不得误活——见「缺省 sessionsDir
 *   推导」describe 的负向诱饵用例）
 * - 全局软上限：超帽只清孤儿判死目录（活 session 目录豁免），mtime 老→新
 * - session 删除级联：目录删除幂等 + 端到端（U3：`<ts>_<uuid>.jsonl` 文件名 → 派生
 *   uuid → cache 目录消失）
 * - 路径穿越防护：非法 sessionId 向上抛（IPC 壳层兜底降级，不落盘）
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { getImageCacheDir, getSessionStoreDir } from '@taiji/shared/paths'
import {
  deleteSessionImageCache,
  enforceImageCacheGlobalCap,
  scanOrphanImageCaches,
  sessionImageCacheBytes,
  sessionIdFromSessionFilePath,
  writeImagesNewestFirst,
  IMAGE_CACHE_SESSION_MAX_BYTES,
  IMAGE_CACHE_GLOBAL_SOFT_CAP_BYTES,
} from '../image-cache.js'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 生产同构 session 文件名 fixture（实测锚点：本机数据目录 sessions 层级只读取样，
 * 文件名 = `<ISO时间戳>_<uuid>.jsonl`，uuid 段 === 首行 header id；sidecar = `<同前缀>.
 * jsonl.<suffix>`）。全部 fixture 用同一形态（测试同构性根治：禁止回退 `<sid>.jsonl`
 * 旧臆造形态——该形态与生产恒不符，曾致孤儿判据/级联派生双盲）。
 */
const ALIVE_TS = '2026-09-02T14-40-39-107Z'
const ALIVE_UUID = '01a06290-9ac3-7d46-90f6-39a86248025e'
/** 活 session 主文件（孤儿扫描/级联端到端用）。 */
const ALIVE_FILE = `${ALIVE_TS}_${ALIVE_UUID}.jsonl`
/** 活 session sidecar（判据对 sidecar 同样放行）。 */
const ALIVE_SIDECAR = `${ALIVE_FILE}.model.json`
/** 软上限用例的活 session（独立 dataDir）。 */
const CAP_TS = '2026-09-02T15-39-51-519Z'
const CAP_UUID = '835c6577-e5c3-4553-97ed-dec338f2c68a'
const CAP_FILE = `${CAP_TS}_${CAP_UUID}.jsonl`
/** 缺省推导用例的无关 session（真实层级 sessions 目录非空）与孤儿目标。 */
const OTHER_TS = '2026-09-03T14-14-29-608Z'
const OTHER_UUID = '01a0679f-03e7-715c-a291-a7378a6460e0'
const OTHER_FILE = `${OTHER_TS}_${OTHER_UUID}.jsonl`
const ORPHAN_TS = '2026-09-03T15-00-00-000Z'
const ORPHAN_UUID = '01a0679f-03e7-715c-a291-a7378a6460e1'
const ORPHAN_FILE = `${ORPHAN_TS}_${ORPHAN_UUID}.jsonl`
/** 生产两层布局的 encodeCwd 层（pi 按 cwd 自动分子目录，shared paths.ts 目录树注释）。 */
const ENCODED_CWD = '--Users-demo-project'

let root: string
let sessionsDir: string
/** 软上限用例的独立 dataDir（与前序用例的 cache 目录隔离——软上限扫描全域 cache/images）。 */
let capRoot: string
let capSessionsDir: string

/** utimesSync 参数单位是秒：ageDays 天前的时间戳。 */
function epochSecondsAgo(ageDays: number): number {
  return (Date.now() - ageDays * DAY_MS) / 1000
}

function img(data: string): { data: string; mimeType: string } {
  return { data, mimeType: 'image/png' }
}

/** 生成 N 字节的伪 base64 图（'A' 是合法 base64 字符；4 字符 ≈ 3 字节解码）。 */
function fakeBase64(bytes: number): string {
  return 'A'.repeat(Math.ceil(bytes / 3) * 4)
}

/** 生成 N 字节、内容随 seed 唯一的伪 base64 图（同 bytes 不同 seed → 不同 hash）。 */
function uniqueBase64(bytes: number, seed: number): string {
  const total = Math.ceil(bytes / 3) * 4
  return (`img${seed}` + 'A'.repeat(total)).slice(0, total)
}

/** session 存储树内本域 cache 分区目录（生产同构推导：`<dataDir>/ext-sessions/<sid>/image-cache`）。 */
function cacheDirOf(sid: string): string {
  return getImageCacheDir(sid, root)
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'taiji-image-cache-test-'))
  sessionsDir = join(root, 'sessions')
  mkdirSync(sessionsDir, { recursive: true })
  capRoot = mkdtempSync(join(tmpdir(), 'taiji-image-cache-cap-'))
  capSessionsDir = join(capRoot, 'sessions')
  mkdirSync(capSessionsDir, { recursive: true })
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  rmSync(capRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

describe('写入与幂等', () => {
  it('新图 written：文件内容 = base64 解码原值，路径在 <cache>/<sessionId>/ 下', () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const r = writeImagesNewestFirst('s-write', [img(pngBytes.toString('base64'))], { dataDir: root, sessionsDir })
    expect(r.quotaFull).toBe(false)
    expect(r.results).toHaveLength(1)
    const first = r.results[0]!
    expect(first.status).toBe('written')
    expect(first.path!.startsWith(cacheDirOf('s-write'))).toBe(true)
    expect(existsSync(first.path!)).toBe(true)
    expect(readFileSyncBytes(first.path!)).toEqual(pngBytes)
    expect(sessionImageCacheBytes('s-write', { dataDir: root, sessionsDir })).toBe(pngBytes.length)
  })

  it('同内容再次写入：hash 命中 cached 同路径（幂等，不重复落盘）', () => {
    const data = Buffer.from([1, 2, 3]).toString('base64')
    const r1 = writeImagesNewestFirst('s-idem', [img(data)], { dataDir: root, sessionsDir })
    const r2 = writeImagesNewestFirst('s-idem', [img(data)], { dataDir: root, sessionsDir })
    expect(r1.results[0]!.status).toBe('written')
    expect(r2.results[0]!.status).toBe('cached')
    expect(r2.results[0]!.path).toBe(r1.results[0]!.path)
    expect(readdirSync(cacheDirOf('s-idem'))).toHaveLength(1)
  })

  it('invalid 图（data 空）降级 invalid，不阻断批内其他图', () => {
    const r = writeImagesNewestFirst('s-invalid', [img(''), img('QQ==')], { dataDir: root, sessionsDir })
    expect(r.results[0]!.status).toBe('invalid')
    expect(r.results[1]!.status).toBe('written')
    expect(r.quotaFull).toBe(false)
  })
})

describe('新→旧有序落盘、超帽即停（注入小帽）', () => {
  const cap = 1000 // 1000 字节测试帽
  const imgBytes = 600 // 每图 ~600 字节

  it('第 1 张（最新）落盘后剩余额度不足 → 后续（更旧）全部 quota-full，盘上无文件', () => {
    // 三张内容唯一（uniqueBase64）——同内容会 hash 命中 cached（幂等语义），不属本用例
    // 的「未命中图超帽」场景
    const r = writeImagesNewestFirst(
      's-order',
      [img(uniqueBase64(imgBytes, 1)), img(uniqueBase64(imgBytes, 2)), img(uniqueBase64(imgBytes, 3))],
      { dataDir: root, sessionsDir },
      cap,
    )
    expect(r.results.map((x) => x.status)).toEqual(['written', 'quota-full', 'quota-full'])
    expect(r.quotaFull).toBe(true)
    // 盘上只有最新 1 张
    expect(readdirSync(cacheDirOf('s-order'))).toHaveLength(1)
  })

  it('已占目录计入帽：预置文件吃掉额度后新图停写', () => {
    const sid = 's-preseed'
    const dir = getImageCacheDir(sid, root)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'existing.png'), Buffer.alloc(900))
    const r = writeImagesNewestFirst(sid, [img(fakeBase64(imgBytes))], { dataDir: root, sessionsDir }, cap)
    expect(r.results[0]!.status).toBe('quota-full')
  })

  it('默认 64MB 帽常量（设计值）与全局软上限常量（设计值）', () => {
    expect(IMAGE_CACHE_SESSION_MAX_BYTES).toBe(64 * 1024 * 1024)
    expect(IMAGE_CACHE_GLOBAL_SOFT_CAP_BYTES).toBe(512 * 1024 * 1024)
  })
})

describe('孤儿扫描（启动清扫通道②）', () => {
  it('mtime 超 30 天 + sessions 无对应文件 → 判死删目录；活 session / 新鲜孤儿保留', () => {
    // 活 session：生产同构两层嵌套 `sessions/<encodeCwd>/<ts>_<uuid>.jsonl` 主文件 + sidecar；
    // cache 目录做旧 40 天——「保留」断言必须真正走过孤儿判据路径（新鲜 mtime 防线不构成证明）
    const aliveDir = join(sessionsDir, ENCODED_CWD)
    mkdirSync(aliveDir, { recursive: true })
    writeFileSync(join(aliveDir, ALIVE_FILE), '{}\n')
    writeFileSync(join(aliveDir, ALIVE_SIDECAR), '{}\n')
    mkdirSync(cacheDirOf(ALIVE_UUID), { recursive: true })
    writeFileSync(join(cacheDirOf(ALIVE_UUID), 'a.png'), 'x')
    utimesSync(cacheDirOf(ALIVE_UUID), epochSecondsAgo(40), epochSecondsAgo(40))
    // 死 session：sessions 无对应文件 + 目录 mtime 40 天前
    mkdirSync(cacheDirOf('dead-old'), { recursive: true })
    writeFileSync(join(cacheDirOf('dead-old'), 'b.png'), 'x')
    utimesSync(cacheDirOf('dead-old'), epochSecondsAgo(40), epochSecondsAgo(40))
    // 新鲜孤儿：无 session 文件但 mtime 新 → 保留
    mkdirSync(cacheDirOf('dead-fresh'), { recursive: true })
    writeFileSync(join(cacheDirOf('dead-fresh'), 'c.png'), 'x')

    const result = scanOrphanImageCaches({ dataDir: root, sessionsDir })
    expect(result.removed).toContain('dead-old')
    expect(result.removed).not.toContain(ALIVE_UUID)
    expect(result.removed).not.toContain('dead-fresh')
    expect(existsSync(cacheDirOf('dead-old'))).toBe(false)
    expect(existsSync(cacheDirOf(ALIVE_UUID))).toBe(true)
    expect(existsSync(cacheDirOf('dead-fresh'))).toBe(true)
  })

  it('判据按文件名末段 `_` 后 uuid 段比对（U2）：目录名为 <ts>_<uuid> 旧错误派生形态时仍判死', () => {
    // sessions 有 ALIVE_FILE；cache 目录名若是整段 <ts>_<uuid>（旧「剥 .jsonl 全名」派生
    // 形态），按 uuid 段比对不命中 → 判死删。证明判据不是文件名前缀 startsWith。
    mkdirSync(join(sessionsDir, ENCODED_CWD), { recursive: true })
    writeFileSync(join(sessionsDir, ENCODED_CWD, ALIVE_FILE), '{}\n')
    const legacyDerivedName = `${ALIVE_TS}_${ALIVE_UUID}`
    mkdirSync(cacheDirOf(legacyDerivedName), { recursive: true })
    writeFileSync(join(cacheDirOf(legacyDerivedName), 'b.png'), 'x')
    utimesSync(cacheDirOf(legacyDerivedName), epochSecondsAgo(40), epochSecondsAgo(40))

    const result = scanOrphanImageCaches({ dataDir: root, sessionsDir })
    expect(result.removed).toContain(legacyDerivedName)
    expect(existsSync(cacheDirOf(legacyDerivedName))).toBe(false)
  })

  it('解析失配保守匹配：真 sid 含 `_` 时按「首个 `_` 后全串」命中即保护', () => {
    // cache 目录名 `abc_def-uuid`（含 `_`）：末段解析得 `def-uuid` 不等；失配通道按
    // 「首个 `_` 后全串」= `abc_def-uuid` 相等 → 保守保护不清
    const underscoreSid = 'abc_def-0199-2'
    mkdirSync(join(sessionsDir, ENCODED_CWD), { recursive: true })
    writeFileSync(join(sessionsDir, ENCODED_CWD, `${OTHER_TS}_${underscoreSid}.jsonl`), '{}\n')
    mkdirSync(cacheDirOf(underscoreSid), { recursive: true })
    writeFileSync(join(cacheDirOf(underscoreSid), 'd.png'), 'x')
    utimesSync(cacheDirOf(underscoreSid), epochSecondsAgo(40), epochSecondsAgo(40))

    const result = scanOrphanImageCaches({ dataDir: root, sessionsDir })
    expect(result.removed).not.toContain(underscoreSid)
    expect(existsSync(cacheDirOf(underscoreSid))).toBe(true)
  })

  it('sessions 目录整体不存在 → 孤儿判据放行不了（判据不可用时不误删）', () => {
    mkdirSync(cacheDirOf('no-sessions-dir'), { recursive: true })
    const missing = join(root, 'sessions-missing')
    const result = scanOrphanImageCaches({ dataDir: root, sessionsDir: missing })
    expect(result.removed).not.toContain('no-sessions-dir')
  })

  it('sessions 条目探测失败（非 ENOENT，如 EACCES）→ 保守放行不判死（与 readdir 失败同口径）', () => {
    // sessions 目录保持可读（顶层 readdir 成功）但去 x 位 → 条目 statSync EACCES：
    // 条目状态未知不得当「无保护证据」判死删缓存，必须按「可能存在会话文件」保守放行
    mkdirSync(cacheDirOf('stat-eacces-protected'), { recursive: true })
    writeFileSync(join(cacheDirOf('stat-eacces-protected'), 'f.png'), 'x')
    utimesSync(cacheDirOf('stat-eacces-protected'), epochSecondsAgo(40), epochSecondsAgo(40))
    chmodSync(sessionsDir, 0o444)
    try {
      const result = scanOrphanImageCaches({ dataDir: root, sessionsDir })
      expect(result.removed).not.toContain('stat-eacces-protected')
      expect(existsSync(cacheDirOf('stat-eacces-protected'))).toBe(true)
    } finally {
      chmodSync(sessionsDir, 0o755)
    }
  })

  it('存储树内非 sessionId 形态的一级目录一律跳过（D7 树内遍历规约）：不扫描不清理', () => {
    // 防未来手放的非会话目录（含 encodeCwd 形态——新树一级分区键恒为纯 sid）被孤儿判据
    // 误清：目录名不过 isPiSessionId（含空格 / 冒号）→ 结构性跳过。夹具 mtime 放 60 天前
    // ——若被扫描必过龄判死，「60 天后仍原样保留」即跳过的直接证明（同 describe 前序
    // 用例的既有分区在场，removed 断言只锚定本用例夹具不被清）
    const storeDir = getSessionStoreDir(root)
    // 夹具全部为「形态非法」（isPiSessionId 必拒）；形态合法但非真实会话的目录不在本
    // 规约保护范围——按孤儿判据判死是既有语义（与现状一致）
    const junkDirs = ['not a sid', 'btw:abc', '--Users-demo-project--', '.DS_Store']
    for (const junk of junkDirs) {
      const dir = join(storeDir, junk, 'image-cache')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'junk.png'), 'x')
      utimesSync(dir, epochSecondsAgo(60), epochSecondsAgo(60))
    }
    const result = scanOrphanImageCaches({ dataDir: root, sessionsDir })
    for (const junk of junkDirs) {
      expect(result.removed).not.toContain(junk)
      expect(existsSync(join(storeDir, junk, 'image-cache', 'junk.png'))).toBe(true)
    }
  })
})

describe('缺省 sessionsDir 推导 = <dataDir>/agent/sessions（U1，方案 B 新布局）', () => {
  it('不传 sessionsDir：走 <dataDir>/agent/sessions 真实层级；pi/sessions 旧布局诱饵不得误活', () => {
    const dd = mkdtempSync(join(tmpdir(), 'taiji-image-cache-dd-'))
    try {
      // 真实层级（方案 B：agent 直下，生产两层嵌套）：含一个无关 session 文件（目录可列举、孤儿目标 id 不在其中）
      const realSessions = join(dd, 'agent', 'sessions')
      mkdirSync(join(realSessions, ENCODED_CWD), { recursive: true })
      writeFileSync(join(realSessions, ENCODED_CWD, OTHER_FILE), '{}\n')
      // 旧布局诱饵（U1 锁向，dev-0.9.17 布局改版后反转）：孤儿目标的同构文件名放在
      // pi/sessions——推导若错查旧层会误判活而不删，removed 断言即红
      const baitDir = join(dd, 'pi', 'sessions')
      mkdirSync(baitDir, { recursive: true })
      writeFileSync(join(baitDir, ORPHAN_FILE), '{}\n')
      // 孤儿目标（session 存储树内本域分区）：真实 sessions 无对应文件 + cache 目录 mtime 40 天
      const orphanCacheDir = join(dd, 'ext-sessions', ORPHAN_UUID, 'image-cache')
      mkdirSync(orphanCacheDir, { recursive: true })
      writeFileSync(join(orphanCacheDir, 'x.png'), 'x')
      utimesSync(orphanCacheDir, epochSecondsAgo(40), epochSecondsAgo(40))

      // 只注入 dataDir，不传 sessionsDir —— 缺省推导路径被测
      const result = scanOrphanImageCaches({ dataDir: dd })
      expect(result.removed).toContain(ORPHAN_UUID)
      expect(existsSync(orphanCacheDir)).toBe(false)
    } finally {
      rmSync(dd, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})

describe('全局软上限 512MB（只清孤儿判死目录，mtime 老→新）', () => {
  function capCacheDirOf(sid: string): string {
    return getImageCacheDir(sid, capRoot)
  }

  it('超帽：孤儿老目录先清、孤儿新目录次之、活 session 目录豁免；回落帽下即停', () => {
    // 独立 dataDir（capRoot）隔离：三个 session 各 600B——orphan-old（40 天）、
    // orphan-mid（10 天）、活 session（40 天，生产同构文件名 fixture）
    mkdirSync(join(capSessionsDir, ENCODED_CWD), { recursive: true })
    writeFileSync(join(capSessionsDir, ENCODED_CWD, CAP_FILE), '{}\n')
    for (const [sid, ageDays] of [['orphan-old', 40], ['orphan-mid', 10], [CAP_UUID, 40]] as const) {
      mkdirSync(capCacheDirOf(sid), { recursive: true })
      writeFileSync(join(capCacheDirOf(sid), 'img.png'), 'x'.repeat(600))
      utimesSync(capCacheDirOf(sid), epochSecondsAgo(ageDays), epochSecondsAgo(ageDays))
    }
    // 帽 1.5KB：总 ~1.8KB 超帽；清 orphan-old（600B）后 ~1.2KB 回落 → orphan-mid 保留
    const result = enforceImageCacheGlobalCap({ dataDir: capRoot, sessionsDir: capSessionsDir }, 1500)
    expect(result.overCap).toBe(true)
    expect(result.removed).toEqual(['orphan-old'])
    expect(existsSync(capCacheDirOf('orphan-old'))).toBe(false)
    expect(existsSync(capCacheDirOf('orphan-mid'))).toBe(true)
    expect(existsSync(capCacheDirOf(CAP_UUID))).toBe(true) // 活 session 豁免（即便 mtime 最老）
  })

  it('未超帽：零清理', () => {
    const result = enforceImageCacheGlobalCap({ dataDir: capRoot, sessionsDir: capSessionsDir }, 500 * 1024 * 1024)
    expect(result.overCap).toBe(false)
    expect(result.removed).toEqual([])
  })
})

describe('session 删除级联（通道①）', () => {
  it('删目录；不存在时幂等 no-op', () => {
    mkdirSync(cacheDirOf('s-cascade'), { recursive: true })
    writeFileSync(join(cacheDirOf('s-cascade'), 'd.png'), 'x')
    deleteSessionImageCache('s-cascade', { dataDir: root, sessionsDir })
    expect(existsSync(cacheDirOf('s-cascade'))).toBe(false)
    expect(() => deleteSessionImageCache('s-cascade', { dataDir: root, sessionsDir })).not.toThrow()
  })

  it('端到端（U3）：构造 <ts>_<uuid>.jsonl 文件名 → 派生 uuid → 删除后 cache 目录消失', () => {
    // runtime 删除链同构编排：session 文件（生产同构名）→ sessionIdFromSessionFilePath
    // 派生 → deleteSessionImageCache 命中 renderer 写入的 cache 目录（目录名 = 纯 uuid）
    const filePath = join(sessionsDir, ENCODED_CWD, ALIVE_FILE)
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, '{}\n')
    const derived = sessionIdFromSessionFilePath(filePath)
    expect(derived).toBe(ALIVE_UUID) // 纯 uuid 段（= header id），非 <ts>_<uuid> 全名
    mkdirSync(cacheDirOf(derived), { recursive: true })
    writeFileSync(join(cacheDirOf(derived), 'e.png'), 'x')
    deleteSessionImageCache(derived, { dataDir: root, sessionsDir })
    expect(existsSync(cacheDirOf(derived))).toBe(false)
  })

  it('派生形态表（U3）：sidecar 后缀 / .tmp-migrate 双 .jsonl / 无 `_` 回退全名', () => {
    expect(sessionIdFromSessionFilePath(join('/x/y', ALIVE_SIDECAR))).toBe(ALIVE_UUID)
    expect(sessionIdFromSessionFilePath(join('/x/y', `${ALIVE_FILE}.tmp-migrate-1.jsonl`))).toBe(ALIVE_UUID)
    expect(sessionIdFromSessionFilePath('/x/y/u-abc.jsonl')).toBe('u-abc')
    expect(sessionIdFromSessionFilePath('/x/y/u-abc.jsonl.model.json')).toBe('u-abc')
  })

  it('非法 sessionId（路径穿越载荷）向上抛——IPC 壳层兜底降级', () => {
    expect(() => deleteSessionImageCache('../evil', { dataDir: root, sessionsDir })).toThrow(/path traversal/)
  })
})

describe('cached 先于判帽（U4：满帽重开零占位）', () => {
  const cap = 1000

  it('满帽 session 重开重放：已落盘图全部 hash 命中 cached → 零 quota-full', () => {
    const sid = 's-refull'
    const dataA = Buffer.from([7, 7, 7]).toString('base64')
    const r1 = writeImagesNewestFirst(sid, [img(dataA)], { dataDir: root, sessionsDir }, cap)
    expect(r1.results[0]!.status).toBe('written')
    // 人为顶满目录：预置 filler 把 used 顶到 cap（小帽等价生产 64MB 满帽）
    const dir = getImageCacheDir(sid, root)
    writeFileSync(join(dir, 'filler.png'), Buffer.alloc(cap - 3))
    // 重开重放：同内容再次交写 → cached（帽满不拦截幂等命中）
    const r2 = writeImagesNewestFirst(sid, [img(dataA)], { dataDir: root, sessionsDir }, cap)
    expect(r2.quotaFull).toBe(false)
    expect(r2.results[0]!.status).toBe('cached')
    expect(r2.results[0]!.path).toBe(r1.results[0]!.path)
  })

  it('满帽批内混合：已命中图 cached 不受影响，未命中图超帽 → 该图起占位', () => {
    const sid = 's-remix'
    const dataA = Buffer.from([8, 8, 8]).toString('base64')
    const r1 = writeImagesNewestFirst(sid, [img(dataA)], { dataDir: root, sessionsDir }, cap)
    expect(r1.results[0]!.status).toBe('written')
    const dir = getImageCacheDir(sid, root)
    writeFileSync(join(dir, 'filler.png'), Buffer.alloc(cap - 3)) // used = cap
    // 批内：图 A（已落盘命中）+ 图 B（600B 未命中，超剩余额度 0）
    const dataB = fakeBase64(600)
    const r2 = writeImagesNewestFirst(sid, [img(dataA), img(dataB)], { dataDir: root, sessionsDir }, cap)
    expect(r2.results.map((x) => x.status)).toEqual(['cached', 'quota-full'])
    expect(r2.quotaFull).toBe(true)
    expect(existsSync(r2.results[0]!.path!)).toBe(true)
    expect(r2.results[1]!.path).toBeUndefined()
    // cached 未虚增记账：随后再写新图仍按 used = cap 判帽（quota-full 而非误放行）
    const r3 = writeImagesNewestFirst(sid, [img(fakeBase64(600))], { dataDir: root, sessionsDir }, cap)
    expect(r3.results[0]!.status).toBe('quota-full')
  })
})

/** helper：读文件字节（readFileSync 未入 guard 破坏名单，读操作放行）。 */
import { readFileSync } from 'node:fs'
function readFileSyncBytes(p: string): Buffer {
  return readFileSync(p)
}

// 路径推导一致性：本域分区落 session 存储树（`<dataDir>/ext-sessions/<sid>/image-cache`）
describe('路径推导一致性', () => {
  it('session 目录 = <dataDir>/ext-sessions/<sessionId>/image-cache（存储树域 3 分区）', () => {
    expect(getImageCacheDir('x', root)).toBe(join(getSessionStoreDir(root), 'x', 'image-cache'))
  })
})
