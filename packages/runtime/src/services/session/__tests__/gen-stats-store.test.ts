/**
 * gen-stats-store 单元测试（实施计划 u2-store / P2）。
 *
 * 覆盖（u2 验收②）：聚合加权平均对已知样本断言（与 pi-statusline 口径一致，且区分
 * 加权 vs 算术平均）、bogus 50/100 阈值边界语义、GC 删过期日键（本地时区）、
 * safeModelFileName 单射（`a b`/`a_b`、大小写、超长截断）、null 语义（无样本 null、
 * 0 只作真实测量值）、文件损坏读→空+不抛（自愈）。
 *
 * 数据目录红线（TEST-STRATEGY / fs-guard）：全部写删目标 = mkdtempSync(
 * join(tmpdir(), 'taiji-gen-stats-')) + TAIJI_AGENT_DATA_DIR env 注入，不触碰任何共享
 * 推导路径；store 路径从 getDataDir() 动态派生，本文件零硬编码数据目录。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/gen-stats-store.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  aggregateSpeed,
  aggregateCacheRatio,
  isBogusSpeedSample,
  isDisplayedZeroCacheRatio,
  hasReportedCacheFields,
  classifyCacheMiss,
  CACHE_TTL_MS,
  BOGUS_OUTPUT_THRESHOLD,
  BOGUS_DURATION_THRESHOLD_MS,
  SPEED_RETENTION_DAYS,
  safeModelFileName,
  localDayKey,
  pruneExpiredDays,
  readDayRecords,
  writeDayRecords,
  getGenStatsDir,
  getSpeedDir,
  getCacheRatioDir,
  speedFilePath,
  cacheRatioFilePath,
  type SpeedRecord,
  type CacheRatioRecord,
  type GenStatsDayRecords,
} from '../gen-stats-store.js'

// ── fixture：mkdtemp + TAIJI_AGENT_DATA_DIR 注入（测试文件独立 worker，env 改动文件级隔离）──

let dataDir: string
let prevDataDirEnv: string | undefined

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'taiji-gen-stats-'))
  prevDataDirEnv = process.env.TAIJI_AGENT_DATA_DIR
  process.env.TAIJI_AGENT_DATA_DIR = dataDir
})

afterEach(() => {
  if (prevDataDirEnv === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
  else process.env.TAIJI_AGENT_DATA_DIR = prevDataDirEnv
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/** 从 store 公开 API 取 speed 文件路径（保证测的是真实落盘位置） */
function speedPath(provider = 'prov', model = 'mdl'): string {
  return speedFilePath(provider, model)
}

/** 损坏注入用：裸写原始内容（模拟「文件已存在后被外部写坏」——先补父目录） */
function writeRawFile(p: string, content: string): void {
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content, 'utf-8')
}

describe('aggregateSpeed（D6 加权平均 Σtokens÷Σduration×1000）', () => {
  it('已知样本：加权平均 = 100/2s 与 300/3s → 400/5000ms×1000 = 80 t/s', () => {
    const records: SpeedRecord[] = [
      [100, 2000],
      [300, 3000],
    ]
    expect(aggregateSpeed(records)).toBe(80)
  })

  it('单样本即 current 口径（会话槽/模型末条均按单条加权平均 = 样本本身）', () => {
    expect(aggregateSpeed([[50, 1000]] as SpeedRecord[])).toBe(50)
  })

  it('加权而非算术平均：100 t/s×1s 与 1 t/s×10s → 10 t/s（算术平均会是 51）', () => {
    const records: SpeedRecord[] = [
      [100, 1000],
      [10, 10000],
    ]
    expect(aggregateSpeed(records)).toBe(10)
  })

  it('四舍五入取整（蓝本 Math.round 口径）', () => {
    expect(aggregateSpeed([[1, 3]] as SpeedRecord[])).toBe(333)
  })

  it('空数组 → null（无有效样本，D4 纪律禁止 0 充数）', () => {
    expect(aggregateSpeed([])).toBeNull()
  })

  it('ΣdurationMs=0 → null', () => {
    expect(aggregateSpeed([[10, 0], [20, 0]] as SpeedRecord[])).toBeNull()
  })
})

describe('aggregateCacheRatio（D6 加权 Σread÷ΣpromptTotal×100）', () => {
  it('已知样本：80%×100 与 90%×100 → 170/200 = 85%', () => {
    const records: CacheRatioRecord[] = [
      [80, 100],
      [90, 100],
    ]
    expect(aggregateCacheRatio(records)).toBe(85)
  })

  it('加权而非算术平均：大 promptTotal 样本权重更大（100/100 与 0/300 → 25%，算术是 50）', () => {
    const records: CacheRatioRecord[] = [
      [100, 100],
      [0, 300],
    ]
    expect(aggregateCacheRatio(records)).toBe(25)
  })

  it('空数组 → null', () => {
    expect(aggregateCacheRatio([])).toBeNull()
  })

  it('ΣpromptTotal=0 → null（非 cache 模型常态，显「—」非 0%）', () => {
    expect(aggregateCacheRatio([[0, 0]] as CacheRatioRecord[])).toBeNull()
  })

  it('全 miss = 真实 0 值（非 null——D4：0 只作真实测量值）', () => {
    expect(aggregateCacheRatio([[0, 50]] as CacheRatioRecord[])).toBe(0)
  })

  it('四舍五入取整', () => {
    expect(aggregateCacheRatio([[1, 3]] as CacheRatioRecord[])).toBe(33)
  })
})

describe('isBogusSpeedSample（D7 bogus guard，阈值照抄蓝本 50/100）', () => {
  it('阈值常量锁值（无证据不放宽——蓝本 index.ts:61-62）', () => {
    expect(BOGUS_OUTPUT_THRESHOLD).toBe(50)
    expect(BOGUS_DURATION_THRESHOLD_MS).toBe(100)
  })

  it('output>50 且 duration<100 → bogus（缓存回放型异常）', () => {
    expect(isBogusSpeedSample(51, 99)).toBe(true)
    expect(isBogusSpeedSample(1000, 50)).toBe(true)
  })

  it('边界严格不等：output=50 非 bogus（> 严格）', () => {
    expect(isBogusSpeedSample(50, 99)).toBe(false)
  })

  it('边界严格不等：duration=100ms 非 bogus（< 严格）', () => {
    expect(isBogusSpeedSample(51, 100)).toBe(false)
    expect(isBogusSpeedSample(50, 100)).toBe(false)
  })

  it('小样本短耗时合法（真实快速响应），大样本长耗时合法', () => {
    expect(isBogusSpeedSample(30, 50)).toBe(false)
    expect(isBogusSpeedSample(200, 1000)).toBe(false)
  })
})

describe('归因降噪纯函数（2026-09-19 D-A，缓存命中率归因分类 SSOT）', () => {
  it('isDisplayedZeroCacheRatio：与 UI 显示口径同源（四舍五入后为 0 才算「展示 0%」）', () => {
    expect(isDisplayedZeroCacheRatio(0, 1000)).toBe(true)
    expect(isDisplayedZeroCacheRatio(4, 1000)).toBe(true) // 0.4% → round 0（极小命中同样刺眼，一并归因）
    expect(isDisplayedZeroCacheRatio(5, 1000)).toBe(false) // 0.5% → round 1（UI 显示 1%）
    expect(isDisplayedZeroCacheRatio(999, 1000)).toBe(false)
  })

  it('isDisplayedZeroCacheRatio：promptTotal ≤ 0 → false（不是测量值，无归因对象）', () => {
    expect(isDisplayedZeroCacheRatio(0, 0)).toBe(false)
    expect(isDisplayedZeroCacheRatio(0, -5)).toBe(false)
  })

  it('hasReportedCacheFields：两字段全缺省 → 无计量；任一有值（含显式 0）→ 有计量', () => {
    expect(hasReportedCacheFields(null, null)).toBe(false)
    expect(hasReportedCacheFields(0, null)).toBe(true)
    expect(hasReportedCacheFields(null, 0)).toBe(true)
    expect(hasReportedCacheFields(120, 0)).toBe(true)
  })

  it('classifyCacheMiss：无前序请求 → cold-start（新会话首条，无 idleMs）', () => {
    expect(classifyCacheMiss({ hasPreviousRequest: false, idleMs: null, contextRewritten: true })).toEqual({
      reason: 'cold-start',
    })
  })

  it('classifyCacheMiss：compaction 标记优先于空闲超时（前缀重写是结构性成因）', () => {
    expect(
      classifyCacheMiss({ hasPreviousRequest: true, idleMs: CACHE_TTL_MS * 10, contextRewritten: true }),
    ).toEqual({ reason: 'context-rewrite' })
  })

  it('classifyCacheMiss：空闲严格大于 TTL → idle-expiry（携带实际空闲；恰好 TTL 不归因）', () => {
    expect(classifyCacheMiss({ hasPreviousRequest: true, idleMs: CACHE_TTL_MS + 1, contextRewritten: false })).toEqual(
      { reason: 'idle-expiry', idleMs: CACHE_TTL_MS + 1 },
    )
    expect(classifyCacheMiss({ hasPreviousRequest: true, idleMs: CACHE_TTL_MS, contextRewritten: false })).toBeUndefined()
    expect(classifyCacheMiss({ hasPreviousRequest: true, idleMs: CACHE_TTL_MS - 1, contextRewritten: false })).toBeUndefined()
  })

  it('classifyCacheMiss：无标记不超 TTL → undefined（未知成因的真实 miss 保留裸 0%，不降噪）', () => {
    expect(classifyCacheMiss({ hasPreviousRequest: true, idleMs: 7_000, contextRewritten: false })).toBeUndefined()
    expect(classifyCacheMiss({ hasPreviousRequest: true, idleMs: null, contextRewritten: false })).toBeUndefined()
  })

  it('CACHE_TTL_MS 锁值：5 分钟（对齐 pi cache-stats 参考值）', () => {
    expect(CACHE_TTL_MS).toBe(5 * 60 * 1000)
  })
})

describe('localDayKey（本地时区日 key，D3 有意偏离蓝本 UTC）', () => {
  it('按本地日期分量格式化', () => {
    expect(localDayKey(new Date(2026, 1, 9))).toBe('2026-02-09')
  })

  it('月/日补零', () => {
    expect(localDayKey(new Date(2026, 0, 5))).toBe('2026-01-05')
  })

  it('当地 0:30 仍属当日（UTC 口径实现会回退一天——本断言在 UTC+ 时区机器上使 toISOString 实现失败）', () => {
    expect(localDayKey(new Date(2026, 1, 9, 0, 30))).toBe('2026-02-09')
  })

  it('缺省参数取当前时刻', () => {
    const now = new Date()
    expect(localDayKey()).toBe(localDayKey(now))
  })
})

describe('safeModelFileName（safeBase 截断 64 + hash8，单射）', () => {
  it('同输入确定性输出（跨重启落盘一致的前提）', () => {
    expect(safeModelFileName('zai', 'glm-5.3')).toBe(safeModelFileName('zai', 'glm-5.3'))
  })

  it('`a b` 与 `a_b`：safeBase 同为替换结果，hash8 不同 → 文件名不碰撞', () => {
    const withSpace = safeModelFileName('p', 'a b')
    const withUnderscore = safeModelFileName('p', 'a_b')
    expect(withSpace).not.toBe(withUnderscore)
    // 替换生效：两者 safeBase 段相同（碰撞风险确实存在，由 hash 消解）
    expect(withSpace.replace(/-[0-9a-f]{8}$/, '')).toBe(withUnderscore.replace(/-[0-9a-f]{8}$/, ''))
  })

  it('大小写变体（macOS 大小写不敏感 FS）：文件名不同（hash hex 小写，hash 段亦无大小写碰撞）', () => {
    const mixed = safeModelFileName('p', 'Glm')
    const upper = safeModelFileName('p', 'GLM')
    expect(mixed).not.toBe(upper)
    expect(upper).toMatch(/-[0-9a-f]{8}$/)
  })

  it('超长 model id 截断 64 后 hash 不碰撞；文件名长度有界（64+1+8）', () => {
    const longA = safeModelFileName('p', 'x'.repeat(200) + 'AAA')
    const longB = safeModelFileName('p', 'x'.repeat(200) + 'BBB')
    expect(longA).not.toBe(longB)
    for (const name of [longA, longB]) {
      const base = name.replace(/-[0-9a-f]{8}$/, '')
      expect(base.length).toBeLessThanOrEqual(64)
      expect(name.length).toBeLessThanOrEqual(64 + 1 + 8)
    }
  })

  it('文件名不含路径/空白/冒号字符（provider 含 `openai/gpt` 类复合 id 也安全）', () => {
    const name = safeModelFileName('openai/gpt', 'o3: high speed mode')
    expect(name).not.toMatch(/[/\\:\s]/)
  })

  it('不同 provider 同 model 不碰撞（raw key 含 provider 段）', () => {
    expect(safeModelFileName('provA', 'mdl')).not.toBe(safeModelFileName('provB', 'mdl'))
  })
})

describe('pruneExpiredDays（GC 30d，本地时区）', () => {
  it('过期日键删除、近期与当日保留', () => {
    const recent = localDayKey(new Date(Date.now() - 29 * 86_400_000))
    const today = localDayKey()
    const records: GenStatsDayRecords = { '2000-01-01': [[1, 1]], [recent]: [[2, 2]], [today]: [[3, 3]] }
    const pruned = pruneExpiredDays(records)
    expect(Object.keys(pruned).sort()).toEqual([recent, today].sort())
  })

  it('恰好 cutoff 当天键保留（>= 边界）', () => {
    const now = new Date()
    const cutoffKey = localDayKey(new Date(now.getTime() - SPEED_RETENTION_DAYS * 86_400_000))
    const pruned = pruneExpiredDays({ [cutoffKey]: [[1, 1]] }, now)
    expect(pruned[cutoffKey]).toEqual([[1, 1]])
  })

  it('纯函数：不改入参', () => {
    const records: GenStatsDayRecords = { '2000-01-01': [[1, 1]] }
    pruneExpiredDays(records)
    expect(records['2000-01-01']).toEqual([[1, 1]])
  })
})

describe('readDayRecords / writeDayRecords（同步原子写 + 损坏自愈，D3/D8）', () => {
  it('写→读 round-trip 保真', () => {
    const p = speedPath()
    const records: GenStatsDayRecords = { [localDayKey()]: [[100, 2000], [300, 3000]] }
    writeDayRecords(p, records)
    expect(readDayRecords(p)).toEqual(records)
  })

  it('write 递归创建父目录；写后无 .tmp 残留（tmp+rename 原子写）', () => {
    const p = speedPath('deep', 'nested')
    expect(existsSync(p)).toBe(false)
    writeDayRecords(p, { [localDayKey()]: [[1, 1000]] })
    expect(existsSync(p)).toBe(true)
    expect(readdirSync(getSpeedDir()).filter((f) => f.includes('.tmp'))).toEqual([])
  })

  it('write 顺带清扫同目录 .tmp 孤儿（D6 #3：崩溃落在 write→rename 窗口的残留，含他模型文件名）', () => {
    // 预置两个孤儿：本文件同名的 tmp + 另一模型文件的 tmp（换模型后永不重写的那类）
    const p = speedPath('prov', 'mdl')
    mkdirSync(getSpeedDir(), { recursive: true })
    writeFileSync(`${p}.tmp`, 'orphan-half-written', 'utf8')
    writeFileSync(join(getSpeedDir(), `${safeModelFileName('prov', 'gone')}.json.tmp`), 'orphan-other-model', 'utf8')

    writeDayRecords(p, { [localDayKey()]: [[1, 1000]] })

    expect(readdirSync(getSpeedDir()).filter((f) => f.endsWith('.tmp'))).toEqual([])
    // 正常数据文件不受清扫误伤
    expect(existsSync(p)).toBe(true)
    expect(readDayRecords(p)).toEqual({ [localDayKey()]: [[1, 1000]] })
  })

  it('write 时顺带 GC：过期日键不落盘（D3「写入时顺带清理」）', () => {
    const p = speedPath()
    const records: GenStatsDayRecords = { '2000-01-01': [[1, 1]], [localDayKey()]: [[2, 2]] }
    writeDayRecords(p, records)
    const onDisk = readDayRecords(p)
    expect(onDisk['2000-01-01']).toBeUndefined()
    expect(Object.keys(onDisk)).toEqual([localDayKey()])
  })

  it('cache-ratio 路径独立落盘、与 speed 文件互不干扰', () => {
    const p = cacheRatioFilePath('prov', 'mdl')
    writeDayRecords(p, { [localDayKey()]: [[80, 100]] })
    expect(readDayRecords(p)).toEqual({ [localDayKey()]: [[80, 100]] })
    expect(existsSync(speedPath('prov', 'mdl'))).toBe(false)
  })

  it('读不存在文件 → 空（不抛、不创建文件）', () => {
    const p = speedPath('ghost', 'model')
    expect(readDayRecords(p)).toEqual({})
    expect(existsSync(p)).toBe(false)
  })

  it('文件损坏（JSON 截断）→ 空 + 不抛（§3.5 损坏自愈）', () => {
    const p = speedPath()
    writeRawFile(p, '{corrupted')
    expect(readDayRecords(p)).toEqual({})
  })

  it('顶层形状非法（数组 / 字符串）→ 空 + 不抛', () => {
    const p = speedPath()
    writeRawFile(p, '[1,2,3]')
    expect(readDayRecords(p)).toEqual({})
    writeRawFile(p, '"junk"')
    expect(readDayRecords(p)).toEqual({})
  })

  it('部分畸形自愈：畸形条目/键被丢弃，合法数据照常返回（不抛）', () => {
    const p = speedPath()
    const today = localDayKey()
    writeRawFile(p, JSON.stringify({ [today]: [[10, 1000], 'junk', [5]], 'not-a-day': [[1, 1]], [today + '-extra']: 'nope' }))
    expect(readDayRecords(p)).toEqual({ [today]: [[10, 1000]] })
  })

  it('损坏文件在下一次 write 后重建为合法 JSON（自愈闭环，§4 场景 5b 存储层语义）', () => {
    const p = speedPath()
    writeRawFile(p, '{corrupted')
    writeDayRecords(p, { [localDayKey()]: [[42, 1000]] })
    expect(readDayRecords(p)).toEqual({ [localDayKey()]: [[42, 1000]] })
    expect(() => JSON.parse(readFileSync(p, 'utf-8'))).not.toThrow()
  })
})

describe('路径派生（getDataDir 动态推导，零硬编码）', () => {
  it('gen-stats 根目录 = <TAIJI_AGENT_DATA_DIR>/gen-stats', () => {
    expect(getGenStatsDir()).toBe(join(dataDir, 'gen-stats'))
  })

  it('speed / cache-ratio 子目录', () => {
    expect(getSpeedDir()).toBe(join(dataDir, 'gen-stats', 'speed'))
    expect(getCacheRatioDir()).toBe(join(dataDir, 'gen-stats', 'cache-ratio'))
  })

  it('文件路径 = <子目录>/<safeModelFileName>.json', () => {
    expect(speedFilePath('a', 'b')).toBe(join(getSpeedDir(), `${safeModelFileName('a', 'b')}.json`))
    expect(cacheRatioFilePath('a', 'b')).toBe(join(getCacheRatioDir(), `${safeModelFileName('a', 'b')}.json`))
  })

  it('env 参数注入优先于 process.env（路径随注入隔离）', () => {
    const injected = mkdtempSync(join(tmpdir(), 'taiji-gen-stats-env-'))
    try {
      expect(getGenStatsDir({ TAIJI_AGENT_DATA_DIR: injected })).toBe(join(injected, 'gen-stats'))
      expect(getGenStatsDir()).toBe(join(dataDir, 'gen-stats'))
    } finally {
      rmSync(injected, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
