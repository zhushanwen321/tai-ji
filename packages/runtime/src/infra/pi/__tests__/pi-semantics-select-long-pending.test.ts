/**
 * PS-55 探针：RPC select 请求无 timeout 时永不超时（长挂语义）——notify-once watch 桥前提守卫。
 *
 * 登记条目（docs/pi-semantics.json PS-55）：createDialogPromise 仅在 opts?.timeout 真值时设
 * setTimeout，timeout 缺省 promise 恒 pending 直到 extension_ui_response 到达
 * （pendingExtensionRequests.get(response.id).resolve）或 abort signal；select 定义
 * timeout: opts?.timeout 直传无默认值。与 PS-45 互补（PS-45 登记应答路径只 resolve 不回灌，
 * 本条登记请求路径超时语义）。
 *
 * 承重（ADR-0074）：extension 以 {action:'watch'} 长挂 select 不传 timeout fire-and-forget，
 * runtime 晚 respond（settle/death/abort/TTL 腿）依赖 promise 不被 pi 侧超时打断；pi 若引入
 * 默认超时，晚达 respond 将落在已 resolve 的缺省值上、通知静默丢失。
 *
 * 断言方式：静态直读 node_modules 实装 dist（pi 语义断言权威源，见 AGENTS.md）。
 * dist 不可达时 skip 不 fail；凭证无关、不进 REAL_PI_TESTS 分池。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/pi-semantics-select-long-pending.test.ts
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

/** 去注释并剥离字符串字面量内容（占位为空串），后续花括号配对基于净化文本。 */
function stripToCode(src: string): string {
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
      i++
      while (i < n) {
        if (src[i] === '\\') {
          i += 2
          continue
        }
        i++
        if (src[i - 1] === c) break
      }
      out += ' '
      continue
    }
    out += c
    i++
  }
  return out
}

/** 从 start（指向 '{'）做花括号配对，返回块文本与闭合后下标；字符串已剥离故无字面量干扰。 */
function matchBrace(src: string, start: number): { text: string; end: number } | null {
  let depth = 0
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return { text: src.slice(start, i + 1), end: i + 1 }
    }
  }
  return null
}

/** 定位 createDialogPromise 函数体（净化文本上提取）。 */
function extractDialogFn(code: string): string | null {
  const head = code.indexOf('function createDialogPromise(')
  if (head === -1) return null
  const brace = code.indexOf('{', head)
  if (brace === -1) return null
  return matchBrace(code, brace)?.text ?? null
}

describe.skipIf(!RPC_DIST)(
  `PS-55 探针：select 无 timeout 恒长挂（${SKIP_REASON ? `skip：${SKIP_REASON}` : ''}）`,
  () => {
    const rpcModeRaw = readFileSync(join(RPC_DIST as string, 'modes', 'rpc', 'rpc-mode.js'), 'utf-8')
    const rpcMode = stripToCode(rpcModeRaw)
    const dialogFn = extractDialogFn(rpcMode)

    it('装置：createDialogPromise 函数体提取成功（0 = 形态漂移，禁静默放行）', () => {
      expect(
        dialogFn,
        'PS-55 装置漂移：rpc-mode.js 未提取到 createDialogPromise 函数体——函数改名/改形，' +
          '恢复动作：复核 rpc-mode.js dialog 助手形态后更新本探针定位器',
      ).not.toBeNull()
    })

    it('语义①：体内 setTimeout 仅出现在 opts?.timeout 门内（timeout 缺省恒不设超时）', () => {
      const fn = dialogFn as string
      const setTimeoutCount = fn.split('setTimeout(').length - 1
      expect(
        setTimeoutCount,
        'PS-55 漂移：createDialogPromise 体内 setTimeout 出现次数 ≠ 1——超时机制改形（多处定时器/' +
          '移出条件门），「无 timeout 恒长挂」须重审。恢复动作：复核体内超时逻辑后更新本探针',
      ).toBe(1)
      const gateIdx = fn.indexOf('if (opts?.timeout)')
      const timerIdx = fn.indexOf('setTimeout(')
      expect(
        gateIdx !== -1 && timerIdx > gateIdx,
        'PS-55 漂移：setTimeout 不再位于 if (opts?.timeout) 条件门内（缺省值/无条件超时），' +
          'watch 长挂 select 会被 pi 侧定时打断——ADR-0074 晚 respond 语义须重审。' +
          '恢复动作：复核门结构后更新本探针与 PS-55',
      ).toBe(true)
    })

    it('语义②：select 定义直传 opts?.timeout，无注入默认超时值', () => {
      const selectDef = rpcModeRaw
        .split('\n')
        .find((l) => l.includes('method: "select"'))
      expect(
        selectDef,
        'PS-55 装置漂移：rpc-mode.js 未找到 select 方法定义行（method: "select"）——' +
          'dialog 方法表改形，复核后更新本探针定位器',
      ).toBeDefined()
      expect(
        selectDef?.includes('timeout: opts?.timeout'),
        'PS-55 漂移：select 定义的 timeout 不再直传 opts?.timeout（注入了默认超时/忽略调用方值），' +
          'watch 长挂前提失锚。恢复动作：复核 select 定义行后更新本探针',
      ).toBe(true)
    })

    it('语义③：promise 完成入口 = 应答到达路径（pendingExtensionRequests 按 id resolve）', () => {
      expect(
        rpcMode.includes('pendingExtensionRequests.get(response.id)'),
        'PS-55 漂移：extension_ui_response 应答路径的 pendingExtensionRequests.get(response.id) ' +
          '形态消失——长挂 promise 的完成机制改形，晚 respond 兑现语义须重审（应答路径效应面由 ' +
          'PS-45 探针详断，本条只锚完成入口存在性）。恢复动作：复核应答分派段后更新本探针',
      ).toBe(true)
    })
  },
)
