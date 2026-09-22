/**
 * zcode 导入产物的 pi 读面不变量锚（PS-44 探针，2026-09-21 毒消息事故回归）。
 *
 * 事故链：zcode 取消轮导入后产物里出现「assistant、stopReason='stop'、无 usage」——
 * pi 0.84.4 读面对这种形态裸读崩溃：
 *   - dist/core/agent-session.js:2678 getSessionStats → addUsageToTotals(
 *     assistantMsg.usage) 读 .input（toolResult 分支 :2668 有存在性守卫，assistant 分支无）
 *   - dist/core/agent-session.js:2721 turn 前上下文扫描 → calculateContextTokens(
 *     assistant.usage) 读 .totalTokens（仅跳过 stopReason aborted/error）
 * AgentSession 无法无 LLM 构造，两处按行级实装复演为谓词（parseSessionEntries /
 * buildContextEntries 则是真实 dist 调用——pi 解析器本身不校验 usage，守卫责任在
 * 产物写侧，即 converter 的不变量门）。
 *
 * 实装加载：locatePiCodingAgentDist 动态 import dist JS（firstkept 测试同款机制）；
 * dist 不可达 = 语义权威缺失，硬失败而非 skipIf。
 *
 * 运行：cd packages/runtime && pnpm test -- pi-reader-invariant
 * 纯内存构造，零 fs 写（不触真实数据目录）。
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { buildZcodeSessionFile, type ZcodeMessageInput } from './converter.js'
import { locatePiCodingAgentDist } from '../../../infra/pi/__tests__/helpers/pi-semantics-probe.js'

const PI_DIST = locatePiCodingAgentDist()
if (!PI_DIST) {
  throw new Error(
    'node_modules/@earendil-works/pi-coding-agent/dist 不可达（cwd 上溯 6 级未命中）：' +
      '行为锚的语义权威缺失，不 skip、直接红。先 `pnpm install` 或核对 pi 版本。',
  )
}

/** d.ts 精确签名（dist/core/session-manager.d.ts）。 */
type ParseSessionEntries = (content: string) => Array<Record<string, unknown>>
type BuildContextEntries = (entries: Array<Record<string, unknown>>) => Array<Record<string, unknown>>

const { parseSessionEntries, buildContextEntries } = (await import(
  pathToFileURL(join(PI_DIST, 'core', 'session-manager.js')).href
)) as { parseSessionEntries: ParseSessionEntries; buildContextEntries: BuildContextEntries }

type ParsedEntry = { type?: string; message?: { role?: string; stopReason?: string; usage?: unknown } }

/** 谓词①（agent-session.js:2678 stats）：每条 assistant 的 usage 必须在场（读 .input）。 */
function statsScanViolations(entries: ParsedEntry[]): ParsedEntry[] {
  return entries.filter((e) => e.type === 'message' && e.message?.role === 'assistant' && e.message.usage === undefined)
}

/** 谓词②（agent-session.js:2721 turn 前扫描）：非 aborted/error 的 assistant usage 必须在场（读 .totalTokens）。 */
function contextScanViolations(entries: ParsedEntry[]): ParsedEntry[] {
  return entries.filter(
    (e) =>
      e.type === 'message' &&
      e.message?.role === 'assistant' &&
      e.message.stopReason !== 'aborted' &&
      e.message.stopReason !== 'error' &&
      e.message.usage === undefined,
  )
}

const HEADER = Object.freeze({
  id: '0198test-0000-0000-0000-00000000000b',
  timestamp: '2026-01-02T03:04:05.000Z',
  cwd: '/tmp/zc-conv-cwd',
})

/** 事故现场复刻（修复前产物形态）：取消轮映射成的伪 stop + 无 usage assistant。 */
const POISON_JSONL =
  JSON.stringify({ type: 'session', id: '0198test-0000-0000-0000-00000000000b', timestamp: HEADER.timestamp, cwd: HEADER.cwd }) + '\n' +
  JSON.stringify({
    type: 'message',
    id: '00000001',
    parentId: null,
    timestamp: HEADER.timestamp,
    message: {
      role: 'assistant',
      content: [{ type: 'thinking', thinking: '半截思考（model_request_cancelled 流出）' }],
      provider: 'account:p',
      model: 'GLM-5.3',
      stopReason: 'stop',
    },
  }) + '\n'

/** 修复后产物：同形态取消轮经 converter 落点（aborted + 零 usage）。 */
function convertedCancelledTurn(): string {
  const msgs: ZcodeMessageInput[] = [
    {
      id: 'm-cancelled',
      data: {
        role: 'assistant',
        time: { created: 2000, completed: 7000 },
        error: {
          name: 'AiSdkModelAdapterError',
          data: { message: 'Model request was cancelled.', code: 'model_request_cancelled', turnResult: 'cancelled' },
        },
      },
      parts: [
        { type: 'step-start' },
        { type: 'reasoning', text: '半截思考' },
      ],
    },
  ]
  return buildZcodeSessionFile(msgs, 'T', HEADER).content
}

describe('pi reader invariant (PS-44): assistant entries must carry usage for unguarded pi reads', () => {
  it('事故形态（伪 stop + 无 usage）被两谓词捕获——pi 解析器本身放行，守卫责任在写侧', () => {
    const entries = parseSessionEntries(POISON_JSONL) as ParsedEntry[]
    // pi 解析器不校验 usage（事故正是这样溜进来的）——真实 parse 必须成功
    expect(entries).toHaveLength(2)
    expect(statsScanViolations(entries)).toHaveLength(1)
    expect(contextScanViolations(entries)).toHaveLength(1)
  })

  it('修复后产物（取消轮 → aborted + 零 usage）双谓词零违例，buildContextEntries 真实跑通', () => {
    const entries = parseSessionEntries(convertedCancelledTurn()) as ParsedEntry[]
    const assistant = entries.find((e) => e.message?.role === 'assistant')
    expect(assistant?.message?.stopReason).toBe('aborted')
    expect(assistant?.message?.usage).toMatchObject({ totalTokens: 0 })
    expect(statsScanViolations(entries)).toHaveLength(0)
    expect(contextScanViolations(entries)).toHaveLength(0)
    // restore 链路的真实上下文构建（无 compaction 时恒安全，这里锚定「产物可被 pi 消费」）
    expect(() => buildContextEntries(entries)).not.toThrow()
  })

  it('健康产物（真实 usage + toolUse/stop）同样双谓词零违例', () => {
    const msgs: ZcodeMessageInput[] = [
      {
        id: 'm-ok',
        data: { role: 'assistant', time: { created: 2000, completed: 7000 } },
        parts: [
          { type: 'step-start' },
          { type: 'text', text: 'answer' },
          { type: 'step-finish', reason: 'stop', tokens: { input: 100, output: 20, total: 120 } },
        ],
      },
    ]
    const entries = parseSessionEntries(buildZcodeSessionFile(msgs, 'T', HEADER).content) as ParsedEntry[]
    expect(statsScanViolations(entries)).toHaveLength(0)
    expect(contextScanViolations(entries)).toHaveLength(0)
    expect(() => buildContextEntries(entries)).not.toThrow()
  })
})
