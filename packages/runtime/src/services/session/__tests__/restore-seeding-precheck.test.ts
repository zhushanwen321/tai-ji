/**
 * D5⑤ restore 附着预检 + P-restore-skip 双分支测试（u4c-read-paths ⛔ 交付门，
 * crash-resilience §3.3 D5⑤ + §3.5 P-restore-skip）。
 *
 * 实施期裁决（P-restore-skip）：设计主形态「跳过 normalize 全流程」的失忆半边不安全——
 * pi 0.84.4 实装 _buildIndex（node_modules dist/core/session-manager.js:673-694）对所有
 * 非 session entry 无差别 `leafId = entry.id`，尾部 legacy session_end 未 strip 时
 * leafId=undefined → appendMessage `parentId: this.leafId` 断链 → 静默失忆。按设计降级
 * 路径改「逆序分块最小规范化」（尾扫 session_end + 首行 header cwd 修复 + 流式 strip）。
 *
 * 必测断言（impl-plan u4c 验收）：
 * - 分支一（失忆半边把关）：>阈值 + 尾部 session_end 变体，cwd 存活 → 最小规范化后
 *   session_end 消失，parentId 链连通断言器（pi _buildIndex + appendMessage 语义模拟，
 *   零模型）验证「附着后新增 entry 的 parentId 链回溯连通到文件尾旧 entry」；并以
 *   未 normalize 的原文件作反例（leafId=undefined 断链），证明断言器有效
 * - 分支二（cwd 半边把关）：cwd 死路径 → 首行 header cwd 被修复为 homedir，真 pi 实装
 *   assertSessionCwdExists（dist 行为 import）对修复后 header 不再抛 MissingSessionCwdError
 *   （switchSession 硬拒绝被附着前修复消解——显式失败链路保持未被吞，见 deviations）
 * - 预检 warn 日志：超阈值路径打 warn（含文件大小与原因）
 * - 正常大小路径行为逐字节不变：小文件产物 === 生产纯函数变换（stripSessionEndEntries +
 *   applyHeaderCwdFallback）；零变换需求时文件字节不变；不打预检 warn
 * - 流式变换等价性：中小文件上 streamNormalizeSessionFile（小 chunk 注入，覆盖
 *   跨块行拼接与 UTF-8 多字节块边界）产物 === 全量路径纯函数产物
 *
 * fixture：mkdtempSync 自建自删（fs-guard 白名单 tmpdir）。
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/restore-seeding-precheck.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { writeFileSync, readFileSync, mkdtempSync, rmSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { READ_PRECHECK_MAX_BYTES } from '@taiji/shared'
const { reverseReads } = vi.hoisted(() => ({ reverseReads: [] as { totalBytesRead: number }[] }))

// 包装逆序分块读工具（行为不变）+ 记录读取量：判定腿「不触全量」的机械断言锚点
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

import {
  normalizeInactiveSessionFileIfNeeded,
  streamNormalizeSessionFile,
  stripSessionEndEntries,
  applyHeaderCwdFallback,
} from '../restore-seeding.js'
import { PiSessionStore } from '../../../infra/pi/session-store.js'
import type { StreamingNormalizer } from '../restore-seeding.js'

// 流式归一化 IO 依赖：真 infra 实现（PiSessionStore 经 ISessionStore port 注入——与生产
// session-lifecycle 传 this.sessionStore 同通道；port 分层接线后 transformLine 是纯回调，
// IO 在 infra 实现内，测试对「注入实现」走真实代码路径）
const streamingImpl = new PiSessionStore()
const streaming: StreamingNormalizer = {
  normalizeSessionFileStreaming: (filePath, transformLine, chunkBytes) => streamingImpl.normalizeSessionFileStreaming(filePath, transformLine, chunkBytes),
}

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'restore-seeding-precheck-'))
  reverseReads.length = 0
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

function write(name: string, content: string): string {
  const filePath = join(tmpDir, name)
  writeFileSync(filePath, Buffer.from(content, 'utf-8'))
  return filePath
}

function headerLine(cwd = '/tmp/alive-worktree'): string {
  return JSON.stringify({ type: 'session', version: 2, id: 's-fix', timestamp: '2026-09-09T00:00:00.000Z', cwd })
}

function assistantLine(id: string, parentId: string | null, content = 'hello'): string {
  return JSON.stringify({ type: 'assistant', id, parentId, message: { role: 'assistant', content } })
}

function sessionEndLine(outcome = 'done'): string {
  return JSON.stringify({ type: 'session_end', outcome })
}

/** ~1MB 合法 assistant entry（padding：撑体积，带 id/parentId 保持链形态真实）。 */
function bigEntryLine(id: string, parentId: string): string {
  return JSON.stringify({ type: 'assistant', id, parentId, message: { role: 'assistant', content: 'x'.repeat(1024 * 1024) } })
}

/** 超阈值大文件：header + 33 条 1MB entry（parentId 链完整）+ 尾部正常 turn + 尾行。
 *  变体差异经 includeTailSessionEnd / deadCwd 开关组合（A11 构造声明的两个变体）。 */
function writeBigSessionFile(name: string, opts: { includeTailSessionEnd: boolean; deadCwd: boolean }): { filePath: string; oldTailId: string } {
  const lines = [headerLine(opts.deadCwd ? join(tmpdir(), 'deleted-worktree-taiji') : '/tmp/alive-worktree')]
  let prev = 's-fix'
  for (let i = 0; i < 33; i++) {
    const id = `big-${i}`
    lines.push(bigEntryLine(id, prev))
    prev = id
  }
  // 尾部正常 turn（文件尾旧 entry = 分支一断言的回溯终点）
  lines.push(assistantLine('tail-user', prev, 'question'))
  lines.push(assistantLine('tail-assistant', 'tail-user', 'answer'))
  if (opts.includeTailSessionEnd) lines.push(sessionEndLine('done'))
  const filePath = write(name, lines.join('\n') + '\n')
  expect(statSync(filePath).size).toBeGreaterThan(READ_PRECHECK_MAX_BYTES)
  return { filePath, oldTailId: 'tail-assistant' }
}

/**
 * pi _buildIndex + appendMessage 断链语义的测试模拟器（零模型）。
 *
 * 语义锚 = pi 0.84.4 dist/core/session-manager.js：_buildIndex（:673-694）对所有非
 * session entry 无差别 `byId.set(entry.id); leafId = entry.id`（entry 无 id 时
 * leafId=undefined）；appendMessage（:768+）产物 `parentId: this.leafId`。分支一主断言 =
 * 模拟附着后追加 entry（parentId=leafId），其 parentId 链（byId.get 逐级上溯）能连通到
 * 文件尾旧 entry——旧历史进入 LLM 上下文的机械等价条件。
 */
function simulateAppendAndTrace(jsonl: string, oldTailId: string): { leafId: unknown; connected: boolean } {
  const byId = new Map<unknown, { parentId?: string }>()
  let leafId: unknown = undefined // 无差别赋值：entry 无 id → leafId=undefined（断链根源）
  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const entry = JSON.parse(trimmed) as { type?: string; id?: string; parentId?: string }
    if (entry.type === 'session') continue
    byId.set(entry.id, entry)
    leafId = entry.id // 无差别（含 undefined）——与实装逐行对照
  }
  // appendMessage 语义：新增 entry 的 parentId = this.leafId
  let cur: unknown = leafId
  let hop = 0
  while (cur !== undefined && cur !== null && hop < 10_000) {
    if (cur === oldTailId) return { leafId, connected: true }
    cur = byId.get(cur)?.parentId
    hop++
  }
  return { leafId, connected: false }
}

describe('P-restore-skip 分支一（失忆半边）：尾 session_end 变体 + cwd 存活', () => {
  it('超阈值 + 尾部 session_end → 最小规范化剔除 session_end，parentId 链回溯连通到文件尾旧 entry', () => {
    const { filePath, oldTailId } = writeBigSessionFile('tail-end.jsonl', { includeTailSessionEnd: true, deadCwd: false })

    // 反例先行：未 normalize 的原文件按 pi 语义 = leafId undefined（session_end 无 id）→ 断链
    const before = readFileSync(filePath, 'utf-8')
    const beforeResult = simulateAppendAndTrace(before, oldTailId)
    expect(beforeResult.leafId).toBeUndefined()
    expect(beforeResult.connected).toBe(false)

    normalizeInactiveSessionFileIfNeeded(filePath, false, streaming)

    const after = readFileSync(filePath, 'utf-8')
    expect(after).not.toContain('"session_end"')
    // 其余内容完整保留（header + 33 padding + 尾 turn，仅 session_end 被剔除）
    expect(after).toContain(headerLine())
    expect(after).toContain(assistantLine('tail-assistant', 'tail-user', 'answer'))
    // 主断言（P-restore-skip 分支一·两步式机械形态）：附着后新增 entry（parentId=leafId）
    // 的 parentId 链回溯连通到文件尾旧 entry
    const afterResult = simulateAppendAndTrace(after, oldTailId)
    expect(afterResult.leafId).toBe(oldTailId)
    expect(afterResult.connected).toBe(true)
    // 判定腿不触全量：尾扫命中即止，读取量 ~首块量级
    expect(reverseReads).toHaveLength(1)
    expect(reverseReads[0].totalBytesRead).toBeLessThan(2 * 1024 * 1024)
    // 预检 warn（含大小与原因）
    expect(vi.mocked(console.warn).mock.calls.some((args) => String(args[0]).includes('read-precheck cap') && String(args[0]).includes('streaming minimal normalization'))).toBe(true)
  })

  it('超阈值 + 无 session_end + cwd 存活 → 零变换直附着（文件字节不变，无 tmp 残留）', () => {
    const { filePath } = writeBigSessionFile('clean-big.jsonl', { includeTailSessionEnd: false, deadCwd: false })
    const before = readFileSync(filePath, 'utf-8')

    normalizeInactiveSessionFileIfNeeded(filePath, false, streaming)

    expect(readFileSync(filePath, 'utf-8')).toBe(before)
    const residue = readdirSync(tmpDir).filter((n) => n.includes('.tmp-migrate-'))
    expect(residue).toEqual([])
  })
})

describe('P-restore-skip 分支二（cwd 半边）：cwd 死路径', () => {
  it('超阈值 + cwd 死路径 → 首行 header cwd 被修复为 homedir（真 pi assertSessionCwdExists 对修复后 header 不抛）', async () => {
    const { filePath } = writeBigSessionFile('dead-cwd.jsonl', { includeTailSessionEnd: false, deadCwd: true })
    const deadCwd = JSON.parse(readFileSync(filePath, 'utf-8').split('\n')[0] ?? '{}') as { cwd: string }
    expect(existsSync(deadCwd.cwd)).toBe(false)

    normalizeInactiveSessionFileIfNeeded(filePath, true, streaming)

    // header cwd 已修复（最小规范化的 cwd 半边安全——附着不再硬拒绝）
    const header = JSON.parse(readFileSync(filePath, 'utf-8').split('\n')[0] ?? '{}') as { cwd: string }
    expect(header.cwd).toBe(homedir())
    // 真 pi 实装行为断言（node_modules dist 行为加载）：修复后 header 的 cwd 存在 →
    // assertSessionCwdExists 不抛（pi switchSession 硬拒绝被附着前修复消解）
    const piCwd = await loadPiSessionCwd()
    if (!piCwd) {
      console.warn('[restore-seeding-precheck] pi dist 不可达，跳过 assertSessionCwdExists 行为断言')
      return
    }
    const assertSessionCwdExists = piCwd.assertSessionCwdExists as (m: unknown, cwd: string) => void
    const stubManager = { getSessionFile: () => filePath, getCwd: () => header.cwd }
    expect(() => assertSessionCwdExists(stubManager, homedir())).not.toThrow()
    // 反例：未修复的死 cwd → 同一实装抛 MissingSessionCwdError（断言器有效）
    const stubDead = { getSessionFile: () => filePath, getCwd: () => deadCwd.cwd }
    let threwName = ''
    try {
      assertSessionCwdExists(stubDead, homedir())
    } catch (e) {
      threwName = (e as Error).name
    }
    expect(threwName).toBe('MissingSessionCwdError')
  })

  it('小文件 + cwd 死路径 → 行为不变（首行 header cwd 同样修复为 homedir）', () => {
    const filePath = write('small-dead-cwd.jsonl', [headerLine(join(tmpdir(), 'gone-dir')), assistantLine('e1', null)].join('\n') + '\n')

    normalizeInactiveSessionFileIfNeeded(filePath, true, streaming)

    const header = JSON.parse(readFileSync(filePath, 'utf-8').split('\n')[0] ?? '{}') as { cwd: string }
    expect(header.cwd).toBe(homedir())
  })
})

describe('正常大小路径行为逐字节不变', () => {
  it('小文件含 session_end → 落盘产物 === 生产纯函数变换（stripSessionEndEntries）', () => {
    const lines = [headerLine(), assistantLine('e1', null), sessionEndLine('stopped'), assistantLine('e2', 'e1')]
    const filePath = write('small-strip.jsonl', lines.join('\n') + '\n')
    const raw = readFileSync(filePath, 'utf-8')

    normalizeInactiveSessionFileIfNeeded(filePath, false, streaming)

    expect(readFileSync(filePath, 'utf-8')).toBe(stripSessionEndEntries(raw))
  })

  it('小文件无 session_end 且 cwd 活 → 文件字节不变（零变换直附着）', () => {
    const filePath = write('small-clean.jsonl', [headerLine(), assistantLine('e1', null)].join('\n') + '\n')
    const before = readFileSync(filePath, 'utf-8')

    normalizeInactiveSessionFileIfNeeded(filePath, false, streaming)

    expect(readFileSync(filePath, 'utf-8')).toBe(before)
    expect(vi.mocked(console.warn).mock.calls.some((args) => String(args[0]).includes('read-precheck cap'))).toBe(false)
  })

  it('小文件 cwd 死 + session_end → 产物 === stripSessionEndEntries + applyHeaderCwdFallback 纯函数链', () => {
    const lines = [headerLine(join(tmpdir(), 'gone-dir-2')), assistantLine('e1', null), sessionEndLine('done')]
    const filePath = write('small-dead-strip.jsonl', lines.join('\n') + '\n')
    const raw = readFileSync(filePath, 'utf-8')

    normalizeInactiveSessionFileIfNeeded(filePath, true, streaming)

    expect(readFileSync(filePath, 'utf-8')).toBe(applyHeaderCwdFallback(stripSessionEndEntries(raw), homedir()))
  })
})

describe('流式变换与全量路径等价（跨块行拼接 + UTF-8 块边界）', () => {
  it('小 chunkBytes 注入下 streamWrite 产物 === 纯函数产物（含中文多字节跨块与 EOF 无尾换行）', () => {
    // 中文（3 字节/字）密集行 + 无尾换行：小 chunk（97 字节）必然切断多字节序列与行
    const lines = [
      headerLine(),
      assistantLine('e1', null, '这是一段中文内容用于制造多字节块边界'),
      sessionEndLine('done'),
      assistantLine('e2', 'e1', '另一段中文响应，含标点：、。！'),
    ]
    const src = write('stream-equiv-src.jsonl', lines.join('\n')) // 无尾 \n（EOF 终止行分支）
    const raw = readFileSync(src, 'utf-8')

    // streamNormalizeSessionFile 是原地 rename-over（附着路径无独立产物文件）——对源跑完读源即产物
    streamNormalizeSessionFile(src, false, streaming, 97)

    expect(readFileSync(src, 'utf-8')).toBe(stripSessionEndEntries(raw))
  })

  it('cwdFellBack 时流式产物首行 === 全量路径纯函数链产物首行', () => {
    const lines = [headerLine(join(tmpdir(), 'gone-dir-3')), assistantLine('e1', null, '中文内容中文内容中文内容'), sessionEndLine('done')]
    const src = write('stream-cwd-src.jsonl', lines.join('\n') + '\n')
    const raw = readFileSync(src, 'utf-8')

    streamNormalizeSessionFile(src, true, streaming, 53)

    expect(readFileSync(src, 'utf-8')).toBe(applyHeaderCwdFallback(stripSessionEndEntries(raw), homedir()))
  })
})

/** pi dist 定位（cwd/测试文件位置上溯，pi-semantics-agent-session 同款范式）+ CJS 行为加载。 */
async function loadPiSessionCwd(): Promise<{ assertSessionCwdExists: unknown } | null> {
  const { createRequire } = await import('node:module')
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'core', 'session-cwd.js')
    if (existsSync(candidate)) {
      const require = createRequire(import.meta.url)
      return require(candidate) as { assertSessionCwdExists: unknown }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}
