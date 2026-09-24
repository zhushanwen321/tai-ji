/**
 * plan-state-extractor 单测（plan 模式重设计 D1④）。
 *
 * 锁定 scanPlanStateEntries 派生语义（runtime 与 extension 双端契约的 runtime 侧锚）：
 * - fixture 必含旧四字段 entry 与新七字段 entry 两种 schema（D4 向后兼容契约——
 *   验收条款明文）；
 * - 多 entry 取最后一条（单例状态，extension reconstructPlanState 逆序取首同构）；
 * - reset entry（isActive=false + skills/reviewState 清空 + docs 保留）派生保留 docs；
 * - 冷路径 extractPlanStateFromSessionFile（ENOENT 缺省 View / 真实临时 JSONL 派生一致）。
 * - oversize 降级（稀疏文件 > READ_PRECHECK_MAX_BYTES：warn 留痕 + 缺省 View）与错误契约
 *   （EISDIR / ENAMETOOLONG 原样上抛，statSync 预检失败 fall-through 不吞错）。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/plan-state-extractor.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, openSync, closeSync, ftruncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { READ_PRECHECK_MAX_BYTES } from '@taiji/shared'
import { INACTIVE_PLAN_STATE_VIEW, extractPlanStateFromSessionFile, scanPlanStateEntries } from '../plan-state-extractor.js'

/** plan-state entry fixture（照 session-records.test.ts entry helper 形态；data 无 v 字段——D4 否决版本轴）。 */
function planStateEntry(data: Record<string, unknown>, entryId: string): Record<string, unknown> {
  return {
    type: 'custom',
    customType: 'plan-state',
    id: entryId,
    parentId: null,
    timestamp: '2026-09-18T00:00:00Z',
    data,
  }
}

/** 旧四字段 schema（schema v1 现状，extension state.ts persistPlanState 现行产物）。 */
function legacyData(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    isActive: true,
    planFilePath: '/tmp/taiji-plan/auth/plan.md',
    requirement: '重构 auth 模块',
    templateName: 'tech-design',
    ...extra,
  }
}

/** 新七字段 schema（D1/D4 扩展：三 optional 平铺字段）。 */
function extendedData(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...legacyData(),
    skills: ['tech-design', 'dev-flow'],
    docs: [
      { fileName: 'design.md', absPath: '/tmp/taiji-plan/auth/design.md', sourceSkill: 'tech-design', version: 2 },
      { fileName: 'impl-plan.md', absPath: '/tmp/taiji-plan/auth/impl-plan.md', sourceSkill: 'dev-flow', version: 1 },
    ],
    reviewState: 'awaiting',
    ...extra,
  }
}

let tmpDirs: string[] = []
function makeTmpJsonl(lines: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'plan-state-extractor-'))
  tmpDirs.push(dir)
  const filePath = join(dir, 'session.jsonl')
  writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n'), 'utf-8')
  return filePath
}

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  tmpDirs = []
})

describe('scanPlanStateEntries：派生', () => {
  it('旧四字段 entry：四必填派生正确，新字段区不设键（optional 缺省不占位）', () => {
    const view = scanPlanStateEntries([planStateEntry(legacyData(), 'e1')])
    expect(view).not.toBeNull()
    expect(view!.isActive).toBe(true)
    expect(view!.planFilePath).toBe('/tmp/taiji-plan/auth/plan.md')
    expect(view!.requirement).toBe('重构 auth 模块')
    expect(view!.templateName).toBe('tech-design')
    expect('skills' in view!).toBe(false)
    expect('docs' in view!).toBe(false)
    expect('reviewState' in view!).toBe(false)
  })

  it('新七字段 entry：三 optional 字段透传（skills/docs/reviewState 全量）', () => {
    const view = scanPlanStateEntries([planStateEntry(extendedData(), 'e1')])!
    expect(view.skills).toEqual(['tech-design', 'dev-flow'])
    expect(view.reviewState).toBe('awaiting')
    expect(view.docs).toEqual([
      { fileName: 'design.md', absPath: '/tmp/taiji-plan/auth/design.md', sourceSkill: 'tech-design', version: 2 },
      { fileName: 'impl-plan.md', absPath: '/tmp/taiji-plan/auth/impl-plan.md', sourceSkill: 'dev-flow', version: 1 },
    ])
  })

  it('多 entry 取最后一条（单例状态，后者覆盖）', () => {
    const view = scanPlanStateEntries([
      planStateEntry(legacyData(), 'e1'),
      planStateEntry(extendedData({ reviewState: 'revising' }), 'e2'),
      planStateEntry(extendedData({ reviewState: 'awaiting' }), 'e3'),
    ])!
    expect(view.reviewState).toBe('awaiting')
  })

  it('reset entry：isActive=false + skills/reviewState 清空 + docs 保留（终态矩阵派生）', () => {
    const resetData = {
      isActive: false,
      planFilePath: '/tmp/taiji-plan/auth/plan.md',
      requirement: '',
      templateName: '',
      docs: [{ fileName: 'design.md', absPath: '/x/design.md', sourceSkill: 'tech-design', version: 3 }],
    }
    const view = scanPlanStateEntries([
      planStateEntry(extendedData(), 'e1'),
      planStateEntry(resetData, 'e2'),
    ])!
    expect(view.isActive).toBe(false)
    expect('skills' in view).toBe(false)
    expect('reviewState' in view).toBe(false)
    expect(view.docs).toEqual(resetData.docs)
  })

  it('空串归一 null：View 域「无」单一表达（entry 域历史空串形态不外泄）', () => {
    const view = scanPlanStateEntries([planStateEntry(legacyData({ planFilePath: '', requirement: '', templateName: '' }), 'e1')])!
    expect(view.planFilePath).toBeNull()
    expect(view.requirement).toBeNull()
    expect(view.templateName).toBeNull()
  })

  it('坏 entry 跳过继续向前：坏 data 不终止扫描，派生最后一条合法 entry', () => {
    const view = scanPlanStateEntries([
      planStateEntry(legacyData(), 'e1'),
      planStateEntry(extendedData({ reviewState: 'revising' }), 'e2'),
      { type: 'custom', customType: 'plan-state', id: 'e3', data: 'corrupted' },
      { type: 'message', id: 'e4' },
    ])!
    expect(view.reviewState).toBe('revising')
  })

  it('字段级守卫：非法 reviewState / 非 string[] skills / docs 坏元素过滤（防御式消费）', () => {
    const view = scanPlanStateEntries([planStateEntry(extendedData({
      reviewState: 'approved',
      skills: ['ok', 42],
      docs: [
        { fileName: 'good.md', absPath: '/x/good.md', sourceSkill: 's', version: 1 },
        { fileName: 42, absPath: '/x/bad.md', sourceSkill: 's', version: '1' },
      ],
    }), 'e1')])!
    expect('reviewState' in view).toBe(false)
    expect('skills' in view).toBe(false)
    expect(view.docs).toEqual([{ fileName: 'good.md', absPath: '/x/good.md', sourceSkill: 's', version: 1 }])
  })

  it("reviewStateSource 透传：'resubmit' 挂键；旧 'explain' 存量值归无值（explain 交互已删，与 extension 读侧白名单对齐）", () => {
    const legacyExplain = scanPlanStateEntries([planStateEntry(extendedData({ reviewStateSource: 'explain' }), 'e1')])!
    expect(legacyExplain.reviewState).toBe('awaiting')
    expect('reviewStateSource' in legacyExplain).toBe(false)
    const resubmit = scanPlanStateEntries([planStateEntry(extendedData({ reviewStateSource: 'resubmit' }), 'e2')])!
    expect(resubmit.reviewStateSource).toBe('resubmit')
  })

  it('reviewStateSource 值域守卫：非法值不设键（漏守卫 = 垃圾值进 View，同 reviewState 防御式消费）', () => {
    const view = scanPlanStateEntries([planStateEntry(extendedData({ reviewStateSource: 'bogus' }), 'e1')])!
    expect('reviewStateSource' in view).toBe(false)
  })

  it('旧 entry（升级前落盘）无 reviewStateSource 键：透传后 View 无该键（缺省不占位——renderer 据此渲染通用降级文案）', () => {
    // extendedData() 不含 reviewStateSource = reviewStateSource 引入前的完整写入面
    const view = scanPlanStateEntries([planStateEntry(extendedData(), 'e1')])!
    expect(view.reviewState).toBe('awaiting')
    expect('reviewStateSource' in view).toBe(false)
  })

  it('无 plan-state entry 返回 null（publish 侧跳过 / 冷路径归一缺省 View）', () => {
    expect(scanPlanStateEntries([{ type: 'message', id: 'e1' }, { type: 'custom', customType: 'other', data: {} }])).toBeNull()
  })
})

describe('extractPlanStateFromSessionFile：冷路径', () => {
  it('ENOENT（session 文件延迟写入）→ 未激活缺省 View', () => {
    expect(extractPlanStateFromSessionFile(join(tmpdir(), 'plan-state-extractor-nonexistent.jsonl')))
      .toEqual(INACTIVE_PLAN_STATE_VIEW)
  })

  it('真实临时 JSONL：与 scanPlanStateEntries 派生一致（冷热同一份派生代码）', () => {
    const filePath = makeTmpJsonl([
      { type: 'message', id: 'm1' },
      planStateEntry(legacyData(), 'e1'),
      planStateEntry(extendedData({ reviewState: 'revising' }), 'e2'),
    ])
    const view = extractPlanStateFromSessionFile(filePath)
    expect(view.isActive).toBe(true)
    expect(view.reviewState).toBe('revising')
    expect(view.skills).toEqual(['tech-design', 'dev-flow'])
  })

  it('空 JSONL（无任何 plan entry）→ 未激活缺省 View', () => {
    const filePath = makeTmpJsonl([{ type: 'message', id: 'm1' }])
    expect(extractPlanStateFromSessionFile(filePath)).toEqual(INACTIVE_PLAN_STATE_VIEW)
  })

  // [MF-12] G3 峰值治理冷路径降级契约：oversize 不全文扫描、不 throw、不部分提取——
  // 回归为 throw 会把 getPlanState RPC 打成 error envelope，回归为漏 warn 则静默吞失败。
  it('oversize（> READ_PRECHECK_MAX_BYTES）：warn 留痕 + 降级未激活缺省 View（不全文扫描）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plan-state-extractor-oversize-'))
    tmpDirs.push(dir)
    const filePath = join(dir, 'session.jsonl')
    // 稀疏文件（ftruncate 只拉长度不写数据块，APFS/ext4 秒级）——绕开 32MB 物理写入
    const fd = openSync(filePath, 'w')
    try {
      ftruncateSync(fd, READ_PRECHECK_MAX_BYTES + 1)
    } finally {
      closeSync(fd)
    }
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(extractPlanStateFromSessionFile(filePath)).toEqual({
        isActive: false,
        planFilePath: null,
        requirement: null,
        templateName: null,
      })
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(String(warnSpy.mock.calls[0]![0])).toContain('oversize')
    } finally {
      warnSpy.mockRestore()
    }
  })

  // 错误契约：非 ENOENT 读错误原样上抛（RPC 报错），不降级缺省 View（会把「读失败」
  // 与「从未进过 plan」混淆）。
  it('路径为目录：statSync 预检通过（目录项非 oversize），EISDIR 经 readFileSync 原样上抛', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plan-state-extractor-dir-'))
    tmpDirs.push(dir)
    expect(() => extractPlanStateFromSessionFile(dir)).toThrowError(/EISDIR/)
  })

  it('statSync 预检失败 fall-through：文件名超 NAME_MAX（ENAMETOOLONG）双抛，仍经 readFileSync 原样上抛', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plan-state-extractor-statfail-'))
    tmpDirs.push(dir)
    // > NAME_MAX 255：statSync 与 readFileSync 均拒——预检 catch（fileSize = -1）
    // fall-through 到读路径后错误契约不变（非 ENOENT 不吞）
    const longPath = join(dir, 'x'.repeat(300))
    expect(() => extractPlanStateFromSessionFile(longPath)).toThrowError(/ENAMETOOLONG/)
  })
})

// ════════════════════════════════════════════════════════════════════
// 活跃路径裁剪（message-revoke U6d）：G2 二分的未来状态随树腿——plan 状态 =
// 当前状态，被撤子树的 plan-state entry 不进派生态
// ════════════════════════════════════════════════════════════════════

/** 树节点 fixture（带 id/parentId 链——真实 pi entry 形态；RPC getEntries 排除 header）。 */
function treeEntry(id: string, parentId: string | null, extra: Record<string, unknown>): Record<string, unknown> {
  return { id, parentId, timestamp: '2026-09-24T00:00:00Z', ...extra }
}

/** 链上 plan-state entry（plan-state-extractor 写侧经 pi appendCustomEntry 进树，parentId=当时叶子）。 */
function chainedPlanEntry(id: string, parentId: string, requirement: string): Record<string, unknown> {
  return treeEntry(id, parentId, {
    type: 'custom',
    customType: 'plan-state',
    data: { ...legacyData(), requirement },
  })
}

/** 真实撤回形态的分支文件 entries（header 由文件用例单独加）：q → p1（活跃）→ [m → p2] / [lbl 锚]。 */
function branchedTreeEntries(): Array<Record<string, unknown>> {
  return [
    treeEntry('q', null, { type: 'message', message: { role: 'user', content: '问题' } }),
    chainedPlanEntry('p1', 'q', '活跃路径上的 plan'),
    treeEntry('m', 'p1', { type: 'message', message: { role: 'user', content: '发错的消息' } }),
    chainedPlanEntry('p2', 'm', '被撤子树的 plan'),
    treeEntry('lbl', 'p1', { type: 'label', label: 'taiji:revoked', targetId: 'm' }),
  ]
}

describe('scanPlanStateEntries：leafId 活跃路径裁剪', () => {
  it('传 leafId（全量重建调用点）：被撤子树的 plan-state entry 不进派生，取活跃路径内最后一条', () => {
    const view = scanPlanStateEntries(branchedTreeEntries(), 'lbl')!
    expect(view.requirement).toBe('活跃路径上的 plan')
  })

  it('leafId 缺省 = 现行为回归：全文件逆序取首（物理最后一条命中——增量合并路径不裁剪的契约面）', () => {
    const view = scanPlanStateEntries(branchedTreeEntries())!
    expect(view.requirement).toBe('被撤子树的 plan')
  })

  it('leafId 不在 id 集合 → 纯函数 fail-safe 原样返回（物理最后一条命中）+ warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const view = scanPlanStateEntries(branchedTreeEntries(), 'ghost-leaf')!
      expect(view.requirement).toBe('被撤子树的 plan')
      expect(warnSpy).toHaveBeenCalledTimes(1)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('活跃路径无任何 plan-state entry（撤回带走唯一 plan entry）→ null（publish 侧收敛由水位承接）', () => {
    const entries = [
      treeEntry('q', null, { type: 'message', message: { role: 'user', content: 'hi' } }),
      chainedPlanEntry('p2', 'q', '被撤子树的 plan'),
      treeEntry('lbl', 'q', { type: 'label', label: 'taiji:revoked', targetId: 'p2' }),
    ]
    expect(scanPlanStateEntries(entries, 'lbl')).toBeNull()
  })
})

describe('extractPlanStateFromSessionFile：文件腿活跃路径裁剪（冷启动）', () => {
  /** 真实 pi 文件首行 header（有 id 无 parentId——pi getEntries() 排除、文件直读包含）。 */
  function sessionHeaderLine(): Record<string, unknown> {
    return { type: 'session', version: 1, id: 'sid-branched', timestamp: '2026-09-24T00:00:00Z', cwd: '/tmp' }
  }

  it('有分支真实文件形态（header + 撤回分支 + label 锚落文件尾）→ 派生不含被撤子树 entry', () => {
    const filePath = makeTmpJsonl([sessionHeaderLine(), ...branchedTreeEntries()])
    const view = extractPlanStateFromSessionFile(filePath)
    expect(view.isActive).toBe(true)
    expect(view.requirement).toBe('活跃路径上的 plan')
  })

  it('撤回带走唯一 plan entry → 「未激活」缺省 View（活跃路径空收敛的冷腿形态）', () => {
    const filePath = makeTmpJsonl([
      sessionHeaderLine(),
      treeEntry('q', null, { type: 'message', message: { role: 'user', content: 'hi' } }),
      chainedPlanEntry('p2', 'q', '被撤子树的 plan'),
      treeEntry('lbl', 'q', { type: 'label', label: 'taiji:revoked', targetId: 'p2' }),
    ])
    expect(extractPlanStateFromSessionFile(filePath)).toEqual(INACTIVE_PLAN_STATE_VIEW)
  })

  it('无分支真实文件形态（header + 链式 entries）→ 现行为：最后一条 plan entry 生效（回归）', () => {
    const filePath = makeTmpJsonl([
      sessionHeaderLine(),
      treeEntry('q', null, { type: 'message', message: { role: 'user', content: 'hi' } }),
      chainedPlanEntry('p1', 'q', '第一条 plan'),
      chainedPlanEntry('p3', 'p1', '第二条 plan'),
    ])
    const view = extractPlanStateFromSessionFile(filePath)
    expect(view.requirement).toBe('第二条 plan')
  })
})
