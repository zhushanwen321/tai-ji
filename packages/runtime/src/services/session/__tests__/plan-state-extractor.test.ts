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
