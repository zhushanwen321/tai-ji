import { describe, expect, it } from 'vitest'
import {
  ARCHIVE_ERROR_CODES,
  ARCHIVE_LEDGER_STATUSES,
  parseArchiveLedger,
} from '../archive'

/** archived 态合法簿记 fixture（D3 schema JSON 块全字段）。 */
const archivedFixture = {
  sessionId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
  name: '修复 send-queue e2e 超时',
  originalFile: '2026-10-19T08-30-00_a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d.jsonl',
  cwd: '/Users/x/proj',
  archivedAt: '2026-10-20T03:14:15.926Z',
  rawBytes: 12369530,
  compressedBytes: 2630000,
  codec: 'zstd-3',
  status: 'archived',
  sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  summary: {
    turns: [
      { user: '帮我看看这个超时', agent: '根因是事件预算 120s 不够。' },
      { user: '', agent: null }, // 纯图片 user 空串 + 工具调用结束 turn 的 agent null（D4/D11 边界）
    ],
  },
}

/** staging 态合法簿记 fixture（D5 步骤 4 骨架：无压缩产物字段 + summary:null）。 */
const stagingFixture = {
  sessionId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
  name: 'v0.10 renderer 重构',
  originalFile: '2026-10-18T10-00-00_a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d.jsonl',
  cwd: '/Users/x/proj',
  archivedAt: '2026-10-20T03:14:15.926Z',
  rawBytes: 12369530,
  status: 'staging',
  summary: null,
}

describe('parseArchiveLedger 解析合法', () => {
  it('staging 骨架全字段解析成功，两态字段完备：无压缩产物字段、summary 为 null', () => {
    const result = parseArchiveLedger(stagingFixture)
    expect(result).toEqual({ ok: true, ledger: stagingFixture })
    if (result.ok) {
      expect(result.ledger.status).toBe('staging')
      expect(result.ledger.summary).toBeNull()
      // 类型 narrowing：staging 分支上压缩产物字段不存在（编译期由判别 union 保证）
      expect('codec' in result.ledger).toBe(false)
      expect('compressedBytes' in result.ledger).toBe(false)
      expect('sha256' in result.ledger).toBe(false)
    }
  })

  it('archived 终态全字段解析成功，两态字段完备：压缩产物三字段 + summary 对象齐备', () => {
    const result = parseArchiveLedger(archivedFixture)
    expect(result).toEqual({ ok: true, ledger: archivedFixture })
    if (result.ok && result.ledger.status === 'archived') {
      expect(result.ledger.codec).toBe('zstd-3')
      expect(result.ledger.compressedBytes).toBe(2630000)
      expect(result.ledger.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(result.ledger.summary.turns).toHaveLength(2)
    }
  })

  it('staging 态 name 空串合法（名称提取失败形态，D3）', () => {
    const result = parseArchiveLedger({ ...stagingFixture, name: '' })
    expect(result.ok).toBe(true)
  })

  it('未知顶层字段忽略（向前兼容：新版本簿记对旧版本消费方不致命）', () => {
    const result = parseArchiveLedger({ ...archivedFixture, futureField: { any: 'thing' } })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect('futureField' in result.ledger).toBe(false)
    }
  })

  it('summary.turns 为空数组合法（无对话轮次的边界）', () => {
    const result = parseArchiveLedger({
      ...archivedFixture,
      summary: { turns: [] },
    })
    expect(result.ok).toBe(true)
  })

  it('turn 条目未知字段忽略，已知字段严格校验', () => {
    const result = parseArchiveLedger({
      ...archivedFixture,
      summary: { turns: [{ user: 'u', agent: 'a', extra: 1 }] },
    })
    expect(result.ok).toBe(true)
  })
})

describe('parseArchiveLedger 拒绝非法（结构层）', () => {
  it.each([
    ['null', null],
    ['数组', [stagingFixture]],
    ['字符串', '{"status":"staging"}'],
    ['数字', 42],
    ['undefined', undefined],
  ])('非 JSON 对象拒绝：%s', (_label, raw) => {
    const result = parseArchiveLedger(raw)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('必须为 JSON 对象')
    }
  })

  it.each([
    ['restoring（该态由 .restoring 后缀承载，D9）', 'restoring'],
    ['大写', 'ARCHIVED'],
    ['undefined', undefined],
    ['数字', 1],
  ])('status 词表外拒绝：%s', (_label, status) => {
    const result = parseArchiveLedger({ ...stagingFixture, status })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('status')
    }
  })

  it.each([
    ['sessionId 空串', { sessionId: '' }],
    ['sessionId 非 string', { sessionId: 123 }],
    ['originalFile 空串', { originalFile: '' }],
    ['originalFile 含 /', { originalFile: 'sub/dir/file.jsonl' }],
    ['originalFile 含 \\', { originalFile: 'sub\\file.jsonl' }],
    ['cwd 空串', { cwd: '' }],
    ['archivedAt 非 ISO（无 T 的日期）', { archivedAt: '2026-10-19' }],
    ['archivedAt 非 ISO（自然语言）', { archivedAt: 'March 1, 2026' }],
    ['archivedAt 数字', { archivedAt: 1760000000000 }],
    ['rawBytes 负数', { rawBytes: -1 }],
    ['rawBytes 小数', { rawBytes: 1.5 }],
    ['rawBytes 字符串', { rawBytes: '123' }],
    ['name 非 string', { name: 42 }],
  ])('公共字段非法拒绝：%s', (_label, patch) => {
    const result = parseArchiveLedger({ ...stagingFixture, ...patch })
    expect(result.ok).toBe(false)
  })
})

describe('parseArchiveLedger 两态字段完备性（staging ↔ archived 互斥完备）', () => {
  it.each(['codec', 'compressedBytes', 'sha256'] as const)(
    'staging 态携带压缩产物字段 %s 拒绝（骨架不含，D5 步骤 4）',
    (field) => {
      const raw = { ...stagingFixture, [field]: archivedFixture[field] }
      const result = parseArchiveLedger(raw)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain(field)
      }
    },
  )

  it.each(['codec', 'compressedBytes', 'sha256'] as const)(
    'archived 态缺压缩产物字段 %s 拒绝',
    (field) => {
      const { [field]: _removed, ...rest } = archivedFixture
      const result = parseArchiveLedger(rest)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain(field)
      }
    },
  )

  it('staging 态 summary 缺失拒绝（骨架写入口径 = 显式 null）', () => {
    const { summary: _omit, ...rest } = stagingFixture
    const result = parseArchiveLedger(rest)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('summary')
    }
  })

  it('staging 态 summary 非 null 拒绝', () => {
    const result = parseArchiveLedger({ ...stagingFixture, summary: { turns: [] } })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('summary')
    }
  })

  it('archived 态 summary 缺失拒绝', () => {
    const { summary: _omit, ...rest } = archivedFixture
    const result = parseArchiveLedger(rest)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('summary')
    }
  })

  it('archived 态 summary 为 null 拒绝（那是 staging 形态）', () => {
    const result = parseArchiveLedger({ ...archivedFixture, summary: null })
    expect(result.ok).toBe(false)
  })

  it.each([
    ['turns 非数组', { turns: 'nope' }],
    ['turns 缺失', {}],
    ['条目非对象', { turns: ['x'] }],
    ['条目缺 user', { turns: [{ agent: 'a' }] }],
    ['条目 user 非 string', { turns: [{ user: 1, agent: 'a' }] }],
    ['条目缺 agent（undefined 不等于显式 null）', { turns: [{ user: 'u' }] }],
    ['条目 agent 非 string|null', { turns: [{ user: 'u', agent: 3 }] }],
  ])('archived 态 summary 形态非法拒绝：%s', (_label, summary) => {
    const result = parseArchiveLedger({ ...archivedFixture, summary })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('summary.turns')
    }
  })

  it.each([
    ['大写 hex', 'E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855'],
    ['63 位', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b85'],
    ['非 hex 字符', 'z3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['空串', ''],
  ])('archived 态 sha256 形态非法拒绝：%s', (_label, sha256) => {
    const result = parseArchiveLedger({ ...archivedFixture, sha256 })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('sha256')
    }
  })

  it('archived 态 codec 空串拒绝', () => {
    const result = parseArchiveLedger({ ...archivedFixture, codec: '' })
    expect(result.ok).toBe(false)
  })

  it('archived 态 compressedBytes 非法拒绝', () => {
    const result = parseArchiveLedger({ ...archivedFixture, compressedBytes: -5 })
    expect(result.ok).toBe(false)
  })
})

describe('归档域词表锚定集', () => {
  it('ARCHIVE_LEDGER_STATUSES = staging|archived 两值（restoring 不在词表）', () => {
    expect([...ARCHIVE_LEDGER_STATUSES]).toEqual(['staging', 'archived'])
  })

  it('ARCHIVE_ERROR_CODES = 设计 D5/§5.2 六值闭集（防意外扩值漂移）', () => {
    expect([...ARCHIVE_ERROR_CODES]).toEqual([
      'archive_generating',
      'archive_already_archived',
      'archive_restore_conflict',
      'archive_corrupted',
      'archive_not_found',
      'archive_io_error',
    ])
  })
})
