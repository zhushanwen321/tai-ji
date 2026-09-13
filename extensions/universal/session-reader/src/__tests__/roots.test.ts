import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtemp, mkdir, readdir, writeFile, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import {
  resolveSessionRoots,
  normalizeLiveSessionDir,
  type SessionRoot,
  type SessionRootSignals,
} from '../discovery/roots.js'
import { buildFamilyFromFs } from '../discovery/subagents.js'
import { REAL_AGENT_DIR, HAS_E6, HAS_REAL_AGENT_DIR, HAS_REAL_SUBAGENTS_DIR, REAL_DATA_TIMEOUT_MS } from './real-data.js'

// ============================================================
// A3（ext-simplify-04 U4）：listMainSessions/listSubagentSessions 薄包装已删除，
// subagents.ts 直调 resolveSessionRoots+filter。以下 describe 用同一等价式作入口，
// 保过滤语义覆盖（.finalized 排除 / workflow-state 跳过 / 递归 / 根选择 / 空目录容错）。
// ============================================================

/** 原 listMainSessions 等价式：agentDir 信号包下未去重 main 根的文件并集 */
async function mainSessionFiles(agentDir: string) {
  return (await resolveSessionRoots({ agentDir }))
    .filter((r) => r.source === 'main' && r.dedupedInto === undefined)
    .flatMap((r) => r.files)
}

/** 原 listSubagentSessions 等价式：agentDir 信号包下 [subagent] 根文件集 */
async function subagentSessionFiles(agentDir: string) {
  return (await resolveSessionRoots({ agentDir })).find((r) => r.kind === 'subagent')?.files ?? []
}

/** 写 .jsonl fixture（父目录不存在则自建），内容默认合法 session header */
async function writeJsonl(path: string, content = '{"type":"session","id":"x"}\n') {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

/** 真实形态的 cwd 编码目录名（encodeCwd：`--` 开头 `--` 结尾，实证见 real-data.ts） */
const SLUG = '--Users-foo--'

describe('main 根过滤（原 listMainSessions 等价式，A3 退役后保覆盖）', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'roots-test-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('扫描 sessions/<slug>/*.jsonl，排除 *.jsonl.finalized', async () => {
    const slug = '--Users-foo--'
    await mkdir(join(dir, 'sessions', slug), { recursive: true })
    await writeFile(join(dir, 'sessions', slug, 'a.jsonl'), '{"type":"session","id":"a"}\n')
    await writeFile(join(dir, 'sessions', slug, 'b.jsonl.finalized'), '{"type":"session","id":"b"}\n')

    const result = await mainSessionFiles(dir)
    expect(result).toHaveLength(1)
    expect(result[0].path.endsWith('a.jsonl')).toBe(true)
    expect(result[0].path.endsWith('.finalized')).toBe(false)
    expect(result[0].mtime).toBeTypeOf('number')
    expect(result[0].mtime).toBeGreaterThan(0)
    expect(result[0].size).toBeTypeOf('number')
    expect(result[0].size).toBeGreaterThan(0)
  })

  it('嵌套子目录正确递归（sessions/<slug>/deep/nested/d.jsonl）', async () => {
    await mkdir(join(dir, 'sessions', 'slug', 'deep', 'nested'), { recursive: true })
    await writeFile(join(dir, 'sessions', 'slug', 'deep', 'nested', 'd.jsonl'), '{}\n')
    // 同 slug 直接层也放一个，验证同一 slug 下平铺与嵌套并存
    await writeFile(join(dir, 'sessions', 'slug', 'top.jsonl'), '{}\n')

    const result = await mainSessionFiles(dir)
    const names = result.map((m) => m.path.split('/').pop()!)
    expect(names).toContain('d.jsonl')
    expect(names).toContain('top.jsonl')
    expect(result).toHaveLength(2)
  })

  it('跳过 workflow-state 子目录（wf-*.jsonl 非 session 文件）', async () => {
    const slug = '--Users-x--'
    await mkdir(join(dir, 'sessions', slug, 'workflow-state'), { recursive: true })
    await writeFile(join(dir, 'sessions', slug, 'real.jsonl'), '{"type":"session"}\n')
    await writeFile(
      join(dir, 'sessions', slug, 'workflow-state', 'wf-abc.jsonl'),
      '{"v":"wf-run-v1"}\n',
    )

    const result = await mainSessionFiles(dir)
    expect(result).toHaveLength(1)
    expect(result[0].path.endsWith('real.jsonl')).toBe(true)
    expect(result.every((m) => !m.path.includes('workflow-state'))).toBe(true)
  })

  it('空 agentDir（无 sessions 目录）返回 []，不抛错', async () => {
    await expect(mainSessionFiles(dir)).resolves.toEqual([])
  })

  it('不存在的 agentDir 返回 []，不抛错', async () => {
    await expect(mainSessionFiles(join(dir, 'no-such-dir'))).resolves.toEqual([])
  })

  it.skipIf(!HAS_E6)('真实数据：扫描 ~/.pi/agent，含 019e6c96，不含 .finalized 与 wf-', async () => {
    const result = await mainSessionFiles(REAL_AGENT_DIR)
    expect(result.length).toBeGreaterThan(0)
    // 含目标 session
    expect(result.some((m) => m.path.includes('019e6c96'))).toBe(true)
    // 排除 finalized
    expect(result.every((m) => !m.path.endsWith('.finalized'))).toBe(true)
    // 排除 workflow-state 目录
    expect(result.every((m) => !m.path.includes('workflow-state'))).toBe(true)
    // 排除 wf- 前缀文件名
    expect(result.every((m) => !m.path.split('/').pop()!.startsWith('wf-'))).toBe(true)
    // mtime/size 真实
    expect(result.every((m) => m.mtime > 0 && m.size > 0)).toBe(true)
  }, REAL_DATA_TIMEOUT_MS)
})

describe('subagent 根选择（原 listSubagentSessions 等价式，A3 退役后保覆盖）', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'roots-sub-test-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('扫描 subagents/<slug>/sessions/*.jsonl，排除 .finalized', async () => {
    const slug = '--Users-foo--'
    await mkdir(join(dir, 'subagents', slug, 'sessions'), { recursive: true })
    await writeFile(join(dir, 'subagents', slug, 'sessions', 'c.jsonl'), '{"type":"session"}\n')
    await writeFile(
      join(dir, 'subagents', slug, 'sessions', 'c.jsonl.finalized'),
      '{"type":"session"}\n',
    )

    const result = await subagentSessionFiles(dir)
    expect(result).toHaveLength(1)
    expect(result[0].path.endsWith('c.jsonl')).toBe(true)
    expect(result[0].path.endsWith('.finalized')).toBe(false)
  })

  it('records/ 子目录（.json manifest）不被误收', async () => {
    const slug = '--Users-foo--'
    await mkdir(join(dir, 'subagents', slug, 'records'), { recursive: true })
    await mkdir(join(dir, 'subagents', slug, 'sessions'), { recursive: true })
    await writeFile(join(dir, 'subagents', slug, 'records', 'manifest.json'), '{}\n')
    await writeFile(join(dir, 'subagents', slug, 'sessions', 'sub.jsonl'), '{"type":"session"}\n')

    const result = await subagentSessionFiles(dir)
    expect(result).toHaveLength(1)
    expect(result[0].path.endsWith('sub.jsonl')).toBe(true)
  })

  it('无 subagents 目录返回 []，不抛错', async () => {
    await expect(subagentSessionFiles(dir)).resolves.toEqual([])
  })

  it.skipIf(!HAS_REAL_SUBAGENTS_DIR)('真实数据：扫描 ~/.pi/agent/subagents 返回非空', async () => {
    const result = await subagentSessionFiles(REAL_AGENT_DIR)
    expect(result.length).toBeGreaterThan(0)
    expect(result.every((m) => !m.path.endsWith('.finalized'))).toBe(true)
  }, REAL_DATA_TIMEOUT_MS)
})

// ============================================================
// U1 resolveSessionRoots（design 2026-09-10 §6.1 / §7B 要点 2/3/4/6/7；B 收缩无 [env]）
// ============================================================

/** 三宿主信号包用例的行内校验上下文 */
interface HostCaseCtx {
  tmp: string
  agentDir: string
}

interface HostCase {
  name: string
  build: (tmp: string) => Promise<{ agentDir: string; signals: SessionRootSignals }>
  verify: (ctx: HostCaseCtx, roots: SessionRoot[]) => void
}

const HOST_CASES: HostCase[] = [
  {
    name: '纯 pi：live=encodeCwd 子目录，剥层后与 default 同路径去重，保留 live 标签',
    async build(tmp) {
      const agentDir = join(tmp, 'agent')
      await writeJsonl(join(agentDir, 'sessions', SLUG, 'a.jsonl'))
      return {
        agentDir,
        signals: { agentDir, liveSessionDir: join(agentDir, 'sessions', SLUG) },
      }
    },
    verify({ agentDir }, roots) {
      // kind 序 = 优先级序（live > default > legacy > subagent；B 收缩无 env）
      expect(roots.map((r) => r.kind)).toEqual(['live', 'default', 'legacy', 'subagent'])
      const live = roots.find((r) => r.kind === 'live')!
      // 剥层（§7B 要点 3）：父目录名为 sessions 的真实形态 → dirname
      expect(live.path).toBe(join(agentDir, 'sessions'))
      expect(live.exists).toBe(true)
      expect(live.fileCount).toBe(1)
      const def = roots.find((r) => r.kind === 'default')!
      expect(def.path).toBe(join(agentDir, 'sessions'))
      // realpath 去重（§7B 要点 4）：同路径只扫一次，保留最高优先级 kind
      expect(def.dedupedInto).toBe('live')
      expect(def.files).toHaveLength(0)
      expect(def.fileCount).toBeUndefined()
      // 该路径在全列表中只被一个根实扫（文件不重复计入）
      const scannedAtSamePath = roots.filter(
        (r) => r.path === join(agentDir, 'sessions') && r.dedupedInto === undefined,
      )
      expect(scannedAtSamePath).toHaveLength(1)
      expect(roots.reduce((n, r) => n + r.files.length, 0)).toBe(1)
    },
  },
  {
    name: 'xyz-agent：live=根本身（RPC 覆盖态），default 去重，legacy 残留与 subagent 独立列出',
    async build(tmp) {
      const dataDir = join(tmp, 'data')
      const agentDir = join(dataDir, 'agent')
      await writeJsonl(join(agentDir, 'sessions', SLUG, 'x.jsonl'))
      await writeJsonl(join(dataDir, 'sessions', 'old.jsonl')) // 旧旧布局迁移残留（§6.13 U1 行）
      await writeJsonl(join(agentDir, 'subagents', SLUG, 'sessions', 's.jsonl'))
      return { agentDir, signals: { agentDir, liveSessionDir: join(agentDir, 'sessions') } }
    },
    verify({ agentDir, tmp }, roots) {
      expect(roots.map((r) => r.kind)).toEqual(['live', 'default', 'legacy', 'subagent'])
      // live=根本身（basename 非 encodeCwd 形态）→ 取自身，与 default 同字面路径 → 去重
      const scanned = roots.filter((r) => r.dedupedInto === undefined)
      expect(scanned.map((r) => r.kind)).toEqual(['live', 'legacy', 'subagent'])
      const live = scanned[0]!
      expect(live.path).toBe(join(agentDir, 'sessions'))
      expect(live.fileCount).toBe(1) // 递归扫到 encodeCwd 子目录内的文件
      const def = roots.find((r) => r.kind === 'default')!
      expect(def.dedupedInto).toBe('live')
      // legacy（<dataDir>/sessions 残留）非空即纳入候选，独立成根
      const legacy = roots.find((r) => r.kind === 'legacy')!
      expect(legacy.path).toBe(join(tmp, 'data', 'sessions'))
      expect(legacy.exists).toBe(true)
      expect(legacy.fileCount).toBe(1)
      const sub = roots.find((r) => r.kind === 'subagent')!
      expect(sub.exists).toBe(true)
      expect(sub.fileCount).toBe(1)
      expect(sub.files[0]!.path.endsWith('s.jsonl')).toBe(true)
    },
  },
  {
    name: 'liveSessionDir 缺失降级：default/legacy/subagent 三根仍可用，无 live 根',
    async build(tmp) {
      const agentDir = join(tmp, 'agent')
      await writeJsonl(join(agentDir, 'sessions', SLUG, 'a.jsonl'))
      return { agentDir, signals: { agentDir } }
    },
    verify({ agentDir, tmp }, roots) {
      expect(roots.map((r) => r.kind)).toEqual(['default', 'legacy', 'subagent'])
      const def = roots.find((r) => r.kind === 'default')!
      expect(def.path).toBe(join(agentDir, 'sessions'))
      expect(def.exists).toBe(true)
      expect(def.fileCount).toBe(1)
      expect(roots.find((r) => r.kind === 'legacy')!.path).toBe(join(tmp, 'sessions'))
      // live 缺席 → 无去重发生
      expect(roots.every((r) => r.dedupedInto === undefined)).toBe(true)
    },
  },
]

describe('resolveSessionRoots', () => {
  it.each(HOST_CASES)('$name', async ({ build, verify }) => {
    const tmp = await mkdtemp(join(tmpdir(), 'roots-resolve-'))
    try {
      const { agentDir, signals } = await build(tmp)
      const roots = await resolveSessionRoots(signals)

      // ④ subagent 根恒在（常量推导，不来自任何信号，§6.1 信号 5）
      const sub = roots.find((r) => r.kind === 'subagent')
      expect(sub).toBeDefined()
      expect(sub!.source).toBe('subagent')
      expect(sub!.path).toBe(join(agentDir, 'subagents'))

      // ⑤ 已扫描根 fileCount/scanMs 恒填充且与 files 一致；被去重根不产生扫描统计
      for (const r of roots) {
        if (r.dedupedInto !== undefined) {
          expect(r.fileCount).toBeUndefined()
          expect(r.scanMs).toBeUndefined()
        } else {
          expect(typeof r.fileCount).toBe('number')
          expect(r.fileCount).toBe(r.files.length)
          expect(typeof r.scanMs).toBe('number')
          expect(r.scanMs!).toBeGreaterThanOrEqual(0)
        }
      }

      verify({ tmp, agentDir }, roots)
    } finally {
      await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('[live] 规范化第二形态：普通目录（basename 非 encodeCwd 形态）取自身，不剥层', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'roots-live-plain-'))
    try {
      const agentDir = join(tmp, 'agent')
      const liveDir = join(tmp, 'live-sessions')
      await writeJsonl(join(liveDir, 'b.jsonl'))

      const roots = await resolveSessionRoots({ agentDir, liveSessionDir: liveDir })
      const live = roots.find((r) => r.kind === 'live')!
      expect(live.path).toBe(liveDir)
      expect(live.exists).toBe(true)
      expect(live.fileCount).toBe(1)
      // default/legacy 独立列出，互不干扰
      expect(roots.find((r) => r.kind === 'default')!.path).toBe(join(agentDir, 'sessions'))
      expect(roots.every((r) => r.dedupedInto === undefined)).toBe(true)
    } finally {
      await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('空 agentDir 防御：不派生任何根（避免扫到进程 cwd 相对路径）', async () => {
    await expect(resolveSessionRoots({ agentDir: '' })).resolves.toEqual([])
  })

  it.skipIf(!HAS_REAL_AGENT_DIR)(
    '§11.2 真实路径集合回归：encodeCwd 判据在真实 sessions 子目录上自洽，剥层分支被真实数据覆盖',
    async () => {
      const sessionsDir = join(REAL_AGENT_DIR, 'sessions')
      const entries = await readdir(sessionsDir, { withFileTypes: true })
      const dirs = entries.filter((e) => e.isDirectory())
      expect(dirs.length).toBeGreaterThan(0)
      let encodeCwdCount = 0
      for (const d of dirs) {
        const asLive = join(sessionsDir, d.name)
        const matchesShape = d.name.startsWith('--') && d.name.endsWith('--')
        // 判据自洽：匹配形态 → 剥层到父目录；不匹配（如 permission-forwarding/）→ 取自身
        expect(normalizeLiveSessionDir(asLive)).toBe(matchesShape ? sessionsDir : asLive)
        if (matchesShape) encodeCwdCount++
      }
      // 真实集合以 encodeCwd 目录为主体——剥层分支确实被真实数据覆盖
      expect(encodeCwdCount).toBeGreaterThan(0)
    },
    30000,
  )
})

describe('buildFamilyFromFs not-found 文案（U1 并入：列实际扫描候选根）', () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'roots-notfound-'))
  })
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('错误信息含各候选根路径、kind 标签与文件数（default/legacy），保留 findSessions 指引', async () => {
    const agentDir = join(tmp, 'data', 'agent')
    await writeJsonl(
      join(agentDir, 'sessions', SLUG, 'known.jsonl'),
      '{"type":"session","id":"known-id"}\n',
    )

    const msg = await buildFamilyFromFs('missing-id', agentDir).then(
      () => {
        throw new Error('buildFamilyFromFs should reject for unknown sessionId')
      },
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    )
    expect(msg).toContain('not found')
    expect(msg).toContain(join(agentDir, 'sessions'))
    expect(msg).toContain('[default]')
    expect(msg).toContain('1 file(s)')
    expect(msg).toContain(join(tmp, 'data', 'sessions'))
    expect(msg).toContain('[legacy]')
    expect(msg).toContain('not exists')
    // 只列 main 候选根（collectMainSessions 实扫集合），不含 subagent 根
    expect(msg).not.toContain('[subagent]')
    expect(msg).toContain('findSessions')
  })
})

// ============================================================
// u8 追加：resolveSessionRoots options（doctor 统一数据源，design §6.3「同一数据源
// 两处渲染，不重复实现探测」——subagent 扫描模式经 options 由调用方驱动；原 u8 的
// 注入式缓存面已删除，ext-simplify-04 U3，每次调用实扫）
// ============================================================

describe('resolveSessionRoots options（u8：subagents 模式）', () => {
  /** 最小 fixture：default 根 1 文件 + subagent 根 1 文件（legacy 不存在） */
  async function buildMinimalFixture(): Promise<{ tmp: string; agentDir: string }> {
    const tmp = await mkdtemp(join(tmpdir(), 'roots-opts-'))
    const agentDir = join(tmp, 'agent')
    await mkdir(join(agentDir, 'sessions', SLUG), { recursive: true })
    await writeFile(join(agentDir, 'sessions', SLUG, 'a.jsonl'), '{"type":"session"}\n')
    await mkdir(join(agentDir, 'subagents', SLUG, 'sessions'), { recursive: true })
    await writeFile(join(agentDir, 'subagents', SLUG, 'sessions', 's.jsonl'), '{"type":"session"}\n')
    return { tmp, agentDir }
  }

  it("subagents:'stat'：subagent 根只 stat（无计数/耗时/files 空），main 根照常实扫", async () => {
    const { tmp, agentDir } = await buildMinimalFixture()
    try {
      const roots = await resolveSessionRoots({ agentDir }, { subagents: 'stat' })
      const sub = roots.find((r) => r.kind === 'subagent')!
      expect(sub.exists).toBe(true)
      expect(sub.fileCount).toBeUndefined()
      expect(sub.scanMs).toBeUndefined()
      expect(sub.files).toEqual([])
      expect(sub.dedupedInto).toBeUndefined()
      // main 根不受影响：照常实扫
      const def = roots.find((r) => r.kind === 'default')!
      expect(def.fileCount).toBe(1)
      expect(def.files).toHaveLength(1)
    } finally {
      await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it("options 缺省与 subagents:'scan'：subagent 根照旧全扫（现有调用方零破坏）", async () => {
    const { tmp, agentDir } = await buildMinimalFixture()
    try {
      for (const options of [undefined, { subagents: 'scan' as const }]) {
        const roots = await resolveSessionRoots({ agentDir }, options)
        const sub = roots.find((r) => r.kind === 'subagent')!
        expect(sub.fileCount).toBe(1)
        expect(sub.files).toHaveLength(1)
      }
    } finally {
      await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('重复调用每次实扫（无缓存）：两次结果独立完整，files 恒非空实扫值', async () => {
    // 原三个 cache 用例（set 回写 / 命中优先 / stat × cache）随缓存注入面删除
    // （ext-simplify-04 U3）；本用例钉死删除后契约——不存在任何缓存层
    const { tmp, agentDir } = await buildMinimalFixture()
    try {
      const first = await resolveSessionRoots({ agentDir })
      const second = await resolveSessionRoots({ agentDir })
      for (const roots of [first, second]) {
        const def = roots.find((r) => r.kind === 'default')!
        expect(def.fileCount).toBe(1)
        expect(def.files).toHaveLength(1)
        const sub = roots.find((r) => r.kind === 'subagent')!
        expect(sub.fileCount).toBe(1)
        expect(sub.files).toHaveLength(1)
      }
    } finally {
      await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
