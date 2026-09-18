/**
 * 缓存治理批 3 U7：extractLatestModelFromJsonl 反向读提取测试（sidecar model 家族退役第一步）。
 *
 * 必测断言（impl-plan U7 验收）：
 * - 尾读 32KB 窗口命中 model_change（零全量读、零分块）
 * - 尾读 miss 落全量倒序命中 assistant entry（≤阈值路径，不触发分块）
 * - thinking_level_change 提取；无 thinking entry → pi 默认 'off'
 * - 混合分支文件取物理尾第一条（多 model 信息 entry 交错）
 * - 损坏行跳过继续扫
 * - 全程无模型信息 → undefined（含空文件 / 文件不存在 / sidecar 存在但 JSONL 无信息——
 *   最后一条锚定 U7 语义切换：.model.json 不再是读取来源）
 * - >32MB 大文件分块路径（forEachReversedLineChunk 命中即止）+ 窗口外未命中 → undefined
 *
 * 运行机制断言锚点：包装 utils/history-reverse-read.js 记录分块调用（find-last-entry
 * 测试同款）；mock node:fs 的 readFileSync 计数（透传真实现）区分「尾读命中 / 全量
 * fallback / 分块」三条路径。
 *
 * fixture：mkdtempSync 自建自删（fs-guard 白名单 tmpdir）。
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/session-model-reverse-read.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { READ_PRECHECK_MAX_BYTES } from '@taiji/shared'

// 真实 fs 引用（vi.mock 替换的是 ESM namespace，createRequire 拿 CJS 原始模块）
const realFs = createRequire(import.meta.url)('fs') as typeof import('node:fs')

const { reverseReads } = vi.hoisted(() => ({ reverseReads: [] as { totalBytesRead: number }[] }))
const { readFileSyncCalls } = vi.hoisted(() => ({ readFileSyncCalls: [] as string[] }))

// 包装真实现 + 记录：分块扫的读取量（「命中即止」断言锚点）
vi.mock('../../../utils/history-reverse-read.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/history-reverse-read.js')>()
  return {
    ...actual,
    forEachReversedLineChunk: (
      filePath: string,
      options: Parameters<typeof actual.forEachReversedLineChunk>[1],
      visit: Parameters<typeof actual.forEachReversedLineChunk>[2],
    ) => {
      const summary = actual.forEachReversedLineChunk(filePath, options, visit)
      reverseReads.push({ totalBytesRead: summary.totalBytesRead })
      return summary
    },
  }
})

// readFileSync 计数（透传真实现）：区分尾读命中（0 次）与全量 fallback（1 次）
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: vi.fn((...args: Parameters<typeof actual.readFileSync>) => {
      readFileSyncCalls.push(String(args[0]))
      return actual.readFileSync(...args)
    }),
  }
})

import { extractLatestModelFromJsonl } from '../session-file-utils.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'model-reverse-read-'))
  reverseReads.length = 0
  readFileSyncCalls.length = 0
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

// ── fixture helpers ─────────────────────────────────────────────

function headerLine(): string {
  return JSON.stringify({ type: 'session', id: 's-fix', cwd: '/proj', timestamp: '2026-09-17T00:00:00.000Z' })
}

function modelChangeLine(provider: string, modelId: string): string {
  // pi 实锚：provider/modelId 是 model_change entry 顶级平铺字段（dist/core/session-manager.js:148-160）
  return JSON.stringify({ type: 'model_change', provider, modelId, timestamp: '2026-09-17T00:00:01.000Z' })
}

function assistantLine(provider: string, model: string, content = 'ok'): string {
  // pi 实锚：assistant message entry = type:'message' + message.role:'assistant'，模型取 message.provider + message.model
  return JSON.stringify({ type: 'message', message: { role: 'assistant', provider, model, content, timestamp: '2026-09-17T00:00:02.000Z' } })
}

function thinkingChangeLine(level: string): string {
  return JSON.stringify({ type: 'thinking_level_change', thinkingLevel: level, timestamp: '2026-09-17T00:00:03.000Z' })
}

/** 非模型 entry 的 padding 行（user message——携带 role 但不携带 provider/model）。 */
function paddingLine(id: number, contentBytes: number): string {
  return JSON.stringify({ type: 'message', message: { role: 'user', content: 'x'.repeat(contentBytes) }, id: `pad-${id}` })
}

function write(name: string, lines: string[]): string {
  const filePath = join(tmpDir, name)
  writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8')
  return filePath
}

describe('U7 尾读 32KB 窗口双维度命中（零全量读 / 零分块）', () => {
  it('>32KB 文件，model_change + thinking_level_change 都在尾窗内 → 双命中提前止', () => {
    const filePath = write('tail-hit.jsonl', [
      headerLine(),
      paddingLine(0, 40 * 1024), // 撑过尾窗：以下 entry 距文件尾 <32KB
      modelChangeLine('prov-a', 'model-a'),
      thinkingChangeLine('high'),
    ])
    expect(statSync(filePath).size).toBeGreaterThan(32 * 1024)

    expect(extractLatestModelFromJsonl(filePath)).toEqual({ modelId: 'prov-a/model-a', thinkingLevel: 'high' })
    expect(readFileSyncCalls).toHaveLength(0) // 双维度集齐，全量 fallback 未触发
    expect(reverseReads).toHaveLength(0) // 分块路径未触发
  })

  it('尾窗内 assistant entry + thinking entry 命中 → modelId 取 message.provider + message.model', () => {
    const filePath = write('tail-assistant.jsonl', [
      headerLine(),
      paddingLine(0, 40 * 1024),
      assistantLine('prov-b', 'model-b'),
      thinkingChangeLine('low'),
    ])

    expect(extractLatestModelFromJsonl(filePath)).toEqual({ modelId: 'prov-b/model-b', thinkingLevel: 'low' })
    expect(readFileSyncCalls).toHaveLength(0)
    expect(reverseReads).toHaveLength(0)
  })
})

describe('U7 单维度尾读命中：另一维度需兜底确认（pi 双变量独立跟踪的语义代价）', () => {
  it('model 在尾窗、全文件无 thinking entry → 全量兜底确认无后返回 pi 默认 off', () => {
    // 正确性要求：thinking 与 model 是 pi 侧独立跟踪的两个变量（getSessionContextSettings
    // 各自正序取最后一条），model 命中即止会漏掉更早区域的 thinking_level_change → 显示
    // 撒谎；「确认无 thinking」必须扫到头。多数存量 session（从未 setThinkingLevel）走本
    // 路径，成本 = 与 extractSessionName/Outcome 的全量 fallback 同构（≤阈值 readFileSync
    // 一次），P-反向读探针按真实分布实测裁决。
    const filePath = write('tail-hit-no-thinking.jsonl', [
      headerLine(),
      paddingLine(0, 40 * 1024),
      modelChangeLine('prov-a2', 'model-a2'),
    ])

    expect(extractLatestModelFromJsonl(filePath)).toEqual({ modelId: 'prov-a2/model-a2', thinkingLevel: 'off' })
    expect(readFileSyncCalls).toHaveLength(1) // 全量兜底恰一次（找 thinking）
    expect(reverseReads).toHaveLength(0)
  })
})

describe('U7 尾读 miss → ≤阈值全量倒序兜底（不触发分块）', () => {
  it('>32KB 且 ≤32MB 文件，assistant entry 在头部（尾窗外）→ 全量倒序命中', () => {
    const filePath = write('head-assistant.jsonl', [
      headerLine(),
      assistantLine('prov-head', 'model-head'),
      paddingLine(0, 40 * 1024), // 把 assistant 推出尾窗
    ])
    expect(statSync(filePath).size).toBeGreaterThan(32 * 1024)

    expect(extractLatestModelFromJsonl(filePath)).toEqual({ modelId: 'prov-head/model-head', thinkingLevel: 'off' })
    expect(readFileSyncCalls).toHaveLength(1) // 全量 fallback 恰一次
    expect(reverseReads).toHaveLength(0)
  })

  it('thinking_level_change 在头部（尾窗外）+ model_change 在尾窗 → 全量兜底补齐 thinking', () => {
    const filePath = write('thinking-head.jsonl', [
      headerLine(),
      thinkingChangeLine('high'),
      paddingLine(0, 40 * 1024),
      modelChangeLine('prov-c', 'model-c'),
    ])

    expect(extractLatestModelFromJsonl(filePath)).toEqual({ modelId: 'prov-c/model-c', thinkingLevel: 'high' })
    expect(readFileSyncCalls).toHaveLength(1)
    expect(reverseReads).toHaveLength(0)
  })
})

describe('U7 thinking_level_change 提取语义', () => {
  it('thinking 无任何 entry → pi 默认 off（会话恢复后 pi 的实际生效值）', () => {
    const filePath = write('no-thinking.jsonl', [headerLine(), modelChangeLine('prov-d', 'model-d')])

    expect(extractLatestModelFromJsonl(filePath)).toEqual({ modelId: 'prov-d/model-d', thinkingLevel: 'off' })
  })

  it('只有 thinking_level_change、无 model 信息 → undefined（modelId 必填缺省，不返回半值）', () => {
    const filePath = write('thinking-only.jsonl', [headerLine(), thinkingChangeLine('high')])

    expect(extractLatestModelFromJsonl(filePath)).toBeUndefined()
  })
})

describe('U7 混合分支文件：取物理尾第一条（pi「最近生效」等价语义）', () => {
  it('多条 model_change / assistant 交错 → modelId 与 thinkingLevel 各取物理最靠尾的一条', () => {
    const filePath = write('mixed-branch.jsonl', [
      headerLine(),
      modelChangeLine('prov-old', 'model-old'),
      assistantLine('prov-mid', 'model-mid'),
      thinkingChangeLine('low'),
      modelChangeLine('prov-new', 'model-new'), // 物理尾方向第一条 model 信息
      thinkingChangeLine('high'), // 物理尾方向第一条 thinking 信息
    ])

    expect(extractLatestModelFromJsonl(filePath)).toEqual({ modelId: 'prov-new/model-new', thinkingLevel: 'high' })
  })

  it('最新 assistant 在 model_change 之后 → assistant 胜出（后写覆盖前写）', () => {
    const filePath = write('assistant-last.jsonl', [
      headerLine(),
      modelChangeLine('prov-explicit', 'model-explicit'),
      assistantLine('prov-runtime', 'model-runtime'),
    ])

    expect(extractLatestModelFromJsonl(filePath)).toEqual({ modelId: 'prov-runtime/model-runtime', thinkingLevel: 'off' })
  })
})

describe('U7 损坏行与边界', () => {
  it('损坏行跳过继续扫 → 命中其后（更靠文件头）的 model 信息', () => {
    const filePath = write('corrupt-line.jsonl', [
      headerLine(),
      '{broken json without closing brace',
      modelChangeLine('prov-fix', 'model-fix'),
    ])

    expect(extractLatestModelFromJsonl(filePath)).toEqual({ modelId: 'prov-fix/model-fix', thinkingLevel: 'off' })
  })

  it('字段非法的 entry（空串 modelId）不视为命中 → 继续向前扫到合法 entry', () => {
    const filePath = write('invalid-fields.jsonl', [
      headerLine(),
      JSON.stringify({ type: 'model_change', provider: 'prov-x', modelId: '' }), // 非法：空 modelId
      modelChangeLine('prov-y', 'model-y'),
    ])

    expect(extractLatestModelFromJsonl(filePath)).toEqual({ modelId: 'prov-y/model-y', thinkingLevel: 'off' })
  })

  it('全程无模型信息（header + user message + session_end）→ undefined', () => {
    const filePath = write('no-model.jsonl', [
      headerLine(),
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'hello' } }),
      JSON.stringify({ type: 'session_end', outcome: 'done' }),
    ])

    expect(extractLatestModelFromJsonl(filePath)).toBeUndefined()
  })

  it('空文件 → undefined；文件不存在 → undefined（INVAR-tail-7 不抛）', () => {
    const emptyPath = write('empty.jsonl', [])
    expect(extractLatestModelFromJsonl(emptyPath)).toBeUndefined()
    expect(extractLatestModelFromJsonl(join(tmpDir, 'nope.jsonl'))).toBeUndefined()
  })
})

describe('U7 语义切换锚定：sidecar 不再是读取来源（U8 后 readModelBinding 已并合入本函数）', () => {
  it('.model.json sidecar 存在且内容有效，但 JSONL 无模型信息 → undefined（旧实现会返回 sidecar 值）', () => {
    const filePath = write('sidecar-ignored.jsonl', [headerLine(), paddingLine(0, 1024)])
    writeFileSync(filePath + '.model.json', JSON.stringify({ modelId: 'stale/stale', thinkingLevel: 'high', version: 1 }), 'utf-8')

    // U7 前旧实现（读 sidecar）返回 stale/stale；U7 后反向读 JSONL → undefined
    expect(extractLatestModelFromJsonl(filePath)).toBeUndefined()
  })

  it('scanSessionMeta 第七读直调本函数（U8 起 sidecar 模块退役，读取入口唯一）', () => {
    const filePath = write('entry-equal.jsonl', [headerLine(), modelChangeLine('prov-e', 'model-e'), thinkingChangeLine('medium')])

    // U8 前本用例断言 readModelBinding ≡ extractLatestModelFromJsonl；U8 后 readModelBinding
    // 随模块删除，第七读（scanSessionMeta）就是对本函数的同模块直调——断言值不变
    expect(extractLatestModelFromJsonl(filePath)).toEqual({ modelId: 'prov-e/model-e', thinkingLevel: 'medium' })
  })
})

describe('U7 >32MB 大文件：forEachReversedLineChunk 分块路径', () => {
  function bigPaddingLines(count: number): string[] {
    const lines: string[] = []
    for (let i = 0; i < count; i++) lines.push(paddingLine(i, 1024 * 1024))
    return lines
  }

  it('34MB 文件，model + thinking 都在第一块内（距尾 >32KB）→ 分块逆序双命中即止，读取量 ≪ 文件大小', () => {
    // 布局：header + 34 条 1MB padding（撑过 32MB 阈值）+ model_change + thinking + 100KB
    // tail-pad——目标 entry 距文件尾 >32KB（尾读 miss），但都在首块（1MB）内
    const lines = [headerLine(), ...bigPaddingLines(34), modelChangeLine('prov-big', 'model-big'), thinkingChangeLine('high')]
    lines.push(paddingLine(90, 100 * 1024))
    const filePath = write('big-tail-hit.jsonl', lines)

    const size = statSync(filePath).size
    expect(size).toBeGreaterThan(READ_PRECHECK_MAX_BYTES)

    expect(extractLatestModelFromJsonl(filePath)).toEqual({ modelId: 'prov-big/model-big', thinkingLevel: 'high' })
    expect(readFileSyncCalls).toHaveLength(0) // 超阈值禁全量读
    expect(reverseReads).toHaveLength(1) // 恰一次分块扫
    expect(reverseReads[0].totalBytesRead).toBeLessThan(2 * 1024 * 1024) // 双命中即止：首块（1MB）量级
    expect(reverseReads[0].totalBytesRead).toBeLessThan(size / 10)
  })

  it('34MB 文件，model 在第一块、全文件无 thinking entry → 扫满逆序窗口截停，仍返回正确值（off）', () => {
    // 单维度命中的大文件形态：「确认无 thinking」必须扫到头，读取量被 READ_PRECHECK_MAX_BYTES
    // 硬帽截停（与错误规格表「超 32MB 且阈值内未找到」同一截停语义），值不受影响
    const lines = [headerLine(), ...bigPaddingLines(34), modelChangeLine('prov-big2', 'model-big2')]
    lines.push(paddingLine(90, 100 * 1024))
    const filePath = write('big-no-thinking.jsonl', lines)
    const size = statSync(filePath).size
    expect(size).toBeGreaterThan(READ_PRECHECK_MAX_BYTES)

    expect(extractLatestModelFromJsonl(filePath)).toEqual({ modelId: 'prov-big2/model-big2', thinkingLevel: 'off' })
    expect(reverseReads).toHaveLength(1)
    expect(reverseReads[0].totalBytesRead).toBeLessThanOrEqual(READ_PRECHECK_MAX_BYTES) // 硬帽截停
  })

  it('34MB 文件，模型信息只在头部（32MB 逆序窗口之外）→ undefined，读取量被阈值截停', () => {
    // 错误规格表第 2 行：超大文件头部才有模型信息，接受 undefined 占位（观察哨③ append-only
    // 保证新 append 只会更靠近尾部，下次 mtime 变化重扫收敛）
    const lines = [headerLine(), modelChangeLine('prov-head', 'model-head'), ...bigPaddingLines(34)]
    const filePath = write('big-head-only.jsonl', lines)
    const size = statSync(filePath).size
    expect(size).toBeGreaterThan(READ_PRECHECK_MAX_BYTES)

    expect(extractLatestModelFromJsonl(filePath)).toBeUndefined()
    expect(reverseReads).toHaveLength(1)
    expect(reverseReads[0].totalBytesRead).toBeLessThanOrEqual(READ_PRECHECK_MAX_BYTES) // 硬帽截停
  })
})
