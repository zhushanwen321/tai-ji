/**
 * PS-42 探针：pi 扩展 UI 应答（extension_ui_response）只 resolve 扩展 Promise——不回灌对话、不开 turn
 * （D6 探针层；form-submit-busy-convergence 前提 1 / ADR-0072 分型的机器防线）。
 *
 * 登记条目（docs/pi-semantics.json PS-42）：taiji 表单/对话应答回传 pi 只用于 resolve 扩展持有的
 * Promise，从不回灌对话、不开 turn——expectTurn 分型通路与 ADR-0072 桥接语义都锚在该前提上；
 * pi 升级若在此路径引入对话写入/轮次启动，前提失锚且无显式信号，故以本探针拦为红灯。
 *
 * 断言形态（设计 §5 待验证检查点：断言语义，不绑源码结构——pi 重构后形态变而语义不变不得误报）：
 * - 定位不绑行号/处理函数名：按 wire 协议串 "extension_ui_response"（与 taiji rpc-client.ts 发送的
 *   type 串同源的共享契约）找分派位；块内逻辑抽成模块内函数时经调用展开跟进（标识符改名两侧同步不受影响）；
 * - 断言对象是「应答路径可达效应集」（分派块 ∪ 展开的被调函数体 ∪ 全部 {resolve: (…) => …} 应答回调体）
 *   上的语义缺席：无对话回灌（prompt/sendMessage/steer/append* 等）、无开 turn（agent 轮次启动）、
 *   无命令分派（handleCommand）、无 message/turn 事件串、无 output() 下发；
 * - 控制流只锁语义「应答路径在命令分派前终止」（块尾 return/throw/continue/break，或紧邻 else 分支），
 *   不锁具体代码形状。
 * 红灯解读：红 = 应答可达面新增对话效应（真漂移，按报错复核前提 1）/ 定位与提取形态演化（语义未变则更新
 * 本探针的定位器/提取正则）——一律 fail-loud 复核，不静默通过。
 *
 * 断言方式：静态直读 pi-coding-agent dist/modes/rpc/rpc-mode.js（pi 语义断言权威源 = node_modules
 * 实装版，见 AGENTS.md）。dist 不可达时 skip 不 fail；凭证无关、不进 REAL_PI_TESTS 分池。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/pi-semantics-select-no-turn.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { locatePiDist } from './helpers/pi-semantics-probe.js'

const RPC_DIST = locatePiDist('pi-coding-agent', 'config.js')
const SKIP_REASON = RPC_DIST
  ? ''
  : 'node_modules/@earendil-works/pi-coding-agent/dist 不可达（cwd 上溯 6 级未命中）'
if (!RPC_DIST) console.warn(`[pi-semantics] skip：${SKIP_REASON}`)

/** 回灌对话 / 开 turn 效应词表——应答路径可达效应集上必须全部缺席（语义缺席断言）。 */
const FORBIDDEN_EFFECTS: Array<{ pattern: RegExp; what: string }> = [
  {
    pattern:
      /\b(?:prompt|sendMessage|sendUserMessage|steer|followUp|appendMessage|appendEntry|appendCustomEntry|appendCompaction)\s*\(/,
    what: '对话写入/续轮 API（回灌）',
  },
  {
    pattern: /\b(?:runAgentPrompt|triggerTurn|streamAssistantResponse|startAgentLoop|runAgentLoopContinue)\s*\(/,
    what: 'agent 轮次启动（开 turn）',
  },
  { pattern: /\bhandleCommand\s*\(/, what: '命令分派 handleCommand（应答路径不得进入）' },
  {
    pattern: /["'`](?:message_start|message_end|turn_start|turn_end|agent_start|agent_end|entry_appended)["'`]/,
    what: 'message/turn 事件串构造',
  },
  { pattern: /\boutput\s*\(/, what: 'stdout 帧输出 output()' },
]

/** 去注释（保留字符串字面量内容），后续全部分析基于去注释文本——注释里提及的效应词不构成命中。 */
function stripComments(src: string): string {
  const n = src.length
  let out = ''
  let i = 0
  while (i < n) {
    const c = src[i]
    const d = i + 1 < n ? src[i + 1] : ''
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && d === '*') {
      i += 2
      while (i < n && !(src[i] === '*' && i + 1 < n && src[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c
      out += c
      i++
      while (i < n) {
        if (src[i] === '\\') {
          out += src[i] + (i + 1 < n ? src[i + 1] : '')
          i += 2
          continue
        }
        out += src[i]
        const closed = src[i] === q
        i++
        if (closed) break
      }
      continue
    }
    out += c
    i++
  }
  return out
}

/** 跳过从 start 开始的字符串字面量，返回闭引号后下标。 */
function skipString(src: string, start: number): number {
  const q = src[start]
  let i = start + 1
  while (i < src.length) {
    if (src[i] === '\\') {
      i += 2
      continue
    }
    if (src[i] === q) return i + 1
    i++
  }
  return i
}

/** 从 start（指向 '{'）做括号配对，返回块文本（含首尾花括号）与闭合后下标。 */
function matchBrace(src: string, start: number): { text: string; end: number } | null {
  let depth = 0
  let i = start
  const n = src.length
  while (i < n) {
    const c = src[i]
    if (c === "'" || c === '"' || c === '`') {
      i = skipString(src, i)
      continue
    }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return { text: src.slice(start, i + 1), end: i + 1 }
    }
    i++
  }
  return null
}

/**
 * 从 from 起定位块开括号并配对提取。开括号前遇到 ';' 或 '}' = 该匹配位于谓词/表达式上下文
 * （如抽成 `return t.type === "…"` 的辅助判定函数），非分派块——返回 null 交上层换候选或按漂移报错，
 * 绝不误提后续无关函数体。
 */
function extractBlock(src: string, from: number): { text: string; end: number } | null {
  let i = from
  const n = src.length
  while (i < n) {
    const c = src[i]
    if (c === "'" || c === '"' || c === '`') {
      i = skipString(src, i)
      continue
    }
    if (c === ';' || c === '}') return null
    if (c === '{') return matchBrace(src, i)
    i++
  }
  return null
}

/** 定位 extension_ui_response 应答分派：if 比较位（块提取）或 case 位（窗口提取）。 */
function locateDispatch(
  src: string,
): { body: string; end: number; form: 'if' | 'case' } | null {
  const eqRe = /(?:"extension_ui_response"\s*===)|(?:===\s*"extension_ui_response")/g
  for (const m of src.matchAll(eqRe)) {
    const got = extractBlock(src, (m.index ?? 0) + m[0].length)
    if (got) return { body: got.text, end: got.end, form: 'if' }
  }
  const caseHit = /case\s+"extension_ui_response"\s*:/.exec(src)
  if (caseHit) {
    const bodyStart = caseHit.index + caseHit[0].length
    const rest = src.slice(bodyStart)
    const stop = /\n\s*(?:case\s|default\s*:)/.exec(rest)
    const body = stop ? rest.slice(0, stop.index) : rest.slice(0, 2000)
    return { body, end: bodyStart + body.length, form: 'case' }
  }
  return null
}

/** 提取全部应答回调体：{ resolve: (r) => {…} } 箭头形态 + { resolve(r) {…} } 方法简写形态。 */
function extractResolveBodies(src: string): string[] {
  const bodies: string[] = []
  const patterns = [
    /resolve\s*:\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=>\s*\{/g,
    /\bresolve\s*\([^)]*\)\s*\{/g,
  ]
  for (const re of patterns) {
    for (const m of src.matchAll(re)) {
      const braceIdx = (m.index ?? 0) + m[0].length - 1
      if (src[braceIdx] !== '{') continue
      const got = matchBrace(src, braceIdx)
      if (got) bodies.push(got.text)
    }
  }
  return bodies
}

/** 索引模块内（含嵌套）具名函数/箭头定义：name → 函数体，供调用展开用。 */
function indexLocalDefs(src: string): Map<string, string> {
  const defs = new Map<string, string>()
  const patterns: RegExp[] = [
    /(?:^|\n)[^\S\n]*(?:async[^\S\n]+)?function[^\S\n]+([A-Za-z_$][\w$]*)[^\S\n]*\([^)]*\)[^\S\n]*\{/g,
    /(?:^|\n)[^\S\n]*(?:const|let)[^\S\n]+([A-Za-z_$][\w$]*)[^\S\n]*=[^\S\n]*(?:async[^\S\n]+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)[^\S\n]*(?::[^=\n]+)?=>[^\S\n]*\{/g,
    /(?:^|\n)[^\S\n]*(?:const|let)[^\S\n]+([A-Za-z_$][\w$]*)[^\S\n]*=[^\S\n]*(?:async[^\S\n]+)?function\b[\w$]*[^\S\n]*\([^)]*\)[^\S\n]*\{/g,
  ]
  for (const re of patterns) {
    for (const m of src.matchAll(re)) {
      const name = m[1]
      if (defs.has(name)) continue
      const braceIdx = (m.index ?? 0) + m[0].length - 1
      if (src[braceIdx] !== '{') continue
      const got = matchBrace(src, braceIdx)
      if (got) defs.set(name, got.text)
    }
  }
  return defs
}

/** 裸调用名（排除属性调用 .foo(）——只展开命中的模块内定义，标识符改名时调用与定义同步改，不受影响。 */
const CALL_RE = /(^|[^\w$.])([A-Za-z_$][\w$]*)[^\S\n]*\(/g

/** 从种子文本出发 fixpoint 展开模块内被调函数体（≤6 轮，used 集防环）。 */
function expandScope(seed: string[], defs: Map<string, string>): string[] {
  const scope = [...seed]
  const used = new Set<string>()
  for (let round = 0; round < 6; round++) {
    let grew = false
    for (const text of [...scope]) {
      for (const m of text.matchAll(CALL_RE)) {
        const body = defs.get(m[2])
        if (body !== undefined && !used.has(m[2])) {
          used.add(m[2])
          scope.push(body)
          grew = true
        }
      }
    }
    if (!grew) break
  }
  return scope
}

/** 控制流语义：文本（if 形态为剥壳后的块内语句 / case 形态为 case 体）以终止语句收尾。 */
function endsWithExit(text: string): boolean {
  return /(?:^|[;}\n])[^\S\n]*(?:return|throw|continue|break)\b[^;]*;[^\S\n]*$/.test(text.trim())
}

interface Analysis {
  found: boolean
  scope: string[]
  joined: string
  exitOk: boolean
  callbacks: string[]
  violations: string[]
}

function analyze(srcRaw: string): Analysis {
  const src = stripComments(srcRaw)
  const dispatch = locateDispatch(src)
  if (!dispatch) {
    return { found: false, scope: [], joined: '', exitOk: false, callbacks: [], violations: [] }
  }
  const callbacks = extractResolveBodies(src)
  const defs = indexLocalDefs(src)
  const scope = expandScope([dispatch.body, ...callbacks], defs)
  const joined = scope.join('\n')
  const inner = dispatch.form === 'if' ? dispatch.body.slice(1, -1) : dispatch.body
  const elseAfter =
    dispatch.form === 'if' && /^\s*else\b/.test(src.slice(dispatch.end).slice(0, 64))
  const exitOk = endsWithExit(inner) || elseAfter
  const violations: string[] = []
  for (const { pattern, what } of FORBIDDEN_EFFECTS) {
    for (const text of scope) {
      const hit = pattern.exec(text)
      if (hit) violations.push(`${what} ←「${hit[0]}」`)
    }
  }
  return { found: true, scope, joined, exitOk, callbacks, violations }
}

const FOUND_HINT = '分派块未定位——先按「定位装置」用例的恢复动作处理'

describe.skipIf(!RPC_DIST)(
  `PS-42 探针：extension_ui_response 只 resolve 不回灌/不开 turn（应答可达效应集缺席断言${SKIP_REASON ? `｜skip：${SKIP_REASON}` : ''}）`,
  () => {
    const rpcMode = readFileSync(join(RPC_DIST as string, 'modes', 'rpc', 'rpc-mode.js'), 'utf-8')
    const analysis = analyze(rpcMode)

    it('定位装置：extension_ui_response 应答分派块提取成功（比较位或 case 位）', () => {
      expect(
        analysis.found,
        'PS-42 漂移：rpc-mode.js 未能定位 extension_ui_response 分派块——协议串改名 / 抽成谓词函数 / 移入常量比较等形态演化。' +
          '恢复动作：先核对 taiji packages/runtime/src/infra/pi/rpc-client.ts 发送的 type 串与实装是否仍一致' +
          '（不一致 = wire 契约漂移，runtime 同步改并重审本条 claim）；语义未变则按新形态更新本探针定位器',
      ).toBe(true)
    })

    it('语义①：应答路径可达面对扩展持有 Promise 执行 resolve（唯一入口效应）', () => {
      expect(analysis.found, FOUND_HINT).toBe(true)
      expect(
        /\.resolve\s*\(/.test(analysis.joined),
        'PS-42 漂移：应答路径可达效应集内无 .resolve( 调用——resolve 被移出可达面（超出调用展开深度/改走别的完成机制）' +
          '或应答机制改形。恢复动作：复核 rpc-mode.js 应答段与本探针 expandScope 展开装置',
      ).toBe(true)
    })

    it('语义②：应答路径在命令分派前终止（块尾 return/throw/continue/break 或紧邻 else）', () => {
      expect(analysis.found, FOUND_HINT).toBe(true)
      expect(
        analysis.exitOk,
        'PS-42 漂移：应答分派块既无终止语句也不邻接 else——应答路径可能落入后续命令分派/消息路径（真漂移），' +
          '或控制形态出现第三种演化（形态演化）。恢复动作：复核 rpc-mode.js 应答段语义，确认语义后更新本探针',
      ).toBe(true)
    })

    it('语义③：可达效应集零回灌/开 turn（对话写入·轮次启动·命令分派·事件串·output 全缺席）', () => {
      expect(analysis.found, FOUND_HINT).toBe(true)
      expect(
        analysis.violations,
        `PS-42 漂移：应答路径可达面出现对话效应——pi select 应答不再「只 resolve」，前提 1 失效，` +
          `ADR-0072 分型与 expectTurn 全链须重审。命中：${analysis.violations.join('；')}`,
      ).toEqual([])
    })

    it('装置：resolve 应答回调体提取非空（0 = 提取形态漂移，禁静默放行）', () => {
      expect(
        analysis.callbacks.length,
        'rpc-mode.js 内未提取到任何 resolve 应答回调体——提取器与实装形态失配（回调改形），' +
          '语义③ 的回调体此刻空转。恢复动作：复核并更新 extractResolveBodies 的两个提取正则',
      ).toBeGreaterThanOrEqual(1)
    })
  },
)
