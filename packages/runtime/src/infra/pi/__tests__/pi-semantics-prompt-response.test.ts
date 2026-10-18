/**
 * PS-81 探针：pi prompt response 唯一成功回执 + disposition 值域（D6 探针层，
 * relay-spawn-transport §3.4.2 M2 / PS-81）。
 *
 * 登记条目（docs/pi-semantics.json）：
 * - PS-81「prompt response 是唯一成功回执；disposition 值域 = handled / queued /
 *   started（三态都是已受理）」——消费方 = `packages/pi-subagent-cli/src/prompt-ack.ts`
 *   （零输出看门狗只等 prompt response；stdout 活性只取消计时器不结算）。
 *
 * 断言方式（P-D1 代码形态断言）：静态直读 pi-coding-agent dist/modes/rpc/rpc-mode.js 的
 * `case "prompt"` 分支窗口 + dist/core/agent-session.js 的 prompt() 方法窗口——锚点按符号
 * 名/片段定位（行号漂移免疫），success 唯一发送点、catch 守卫、disposition 字面量全集三
 * 面断言，失真即红。dist 不可达时 skip 不 fail；不进 REAL_PI_TESTS 分池。
 * pi 升级后红 = 回执面改形，先复核 PS-81 锚点与 prompt-ack.ts 头注，再跑探针族重验。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/pi-semantics-prompt-response.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { locatePiCodingAgentDist, methodWindow } from './helpers/pi-semantics-probe.js'

const PI_DIST = locatePiCodingAgentDist()
const SKIP_REASON = PI_DIST
  ? ''
  : 'node_modules/@earendil-works/pi-coding-agent/dist 不可达（cwd 上溯 6 级未命中）'
if (!PI_DIST) console.warn(`[pi-semantics] skip：${SKIP_REASON}`)

const RPC_MODE_SRC = PI_DIST ? readFileSync(join(PI_DIST, 'modes', 'rpc', 'rpc-mode.js'), 'utf-8') : ''
const SESSION_SRC = PI_DIST ? readFileSync(join(PI_DIST, 'core', 'agent-session.js'), 'utf-8') : ''

/** 提取 rpc-mode.js 里某 case 分支的窗口文本（到下一个 case 声明或文件尾）。 */
function caseWindow(rpcModeText: string, caseLabel: string): string {
  const start = rpcModeText.indexOf(`case "${caseLabel}":`)
  if (start === -1) return ''
  const rest = rpcModeText.slice(start)
  const next = /\n\s+case "/.exec(rest.slice(10))
  return next ? rest.slice(0, 10 + next.index) : rest
}

const count = (text: string, needle: string): number => text.split(needle).length - 1

describe.skipIf(!PI_DIST)(
  `PS-81 探针：prompt success 唯一发送点 = preflightResult 回调（静态断言${SKIP_REASON ? `｜skip：${SKIP_REASON}` : ''}）`,
  () => {
    it('success(id, "prompt", { disposition }) 恰一次且位于 preflightResult 回调内（先置 preflightSucceeded）', () => {
      const win = caseWindow(RPC_MODE_SRC, 'prompt')
      expect(win, 'PS-81 漂移：case "prompt" 分支消失——RPC 面改形，复核 PS-81 锚点').not.toBe('')

      // 唯一发送点：全文恰一次 success(id, "prompt"（受理面不存在第二条 success 通道）
      expect(
        count(win, 'success(id, "prompt"'),
        'PS-81 漂移：prompt success 不再唯一（出现第二条 success 通道？）——回执唯一性失效，复核 PS-81',
      ).toBe(1)

      // 归属：preflightResult 回调先声明，success 输出在其内（不是 catch / 主链路上的独立输出）
      const preflightIdx = win.indexOf('preflightResult: (disposition) => {')
      expect(
        preflightIdx,
        'PS-81 漂移：preflightResult 回调形态消失——success 发送点不再由 prompt 受理回调驱动，复核 PS-81',
      ).toBeGreaterThanOrEqual(0)
      const successIdx = win.indexOf('output(success(id, "prompt", { disposition }))')
      expect(
        successIdx,
        'PS-81 漂移：success 载荷不再携带 { disposition }——回执形状改形，复核 PS-81 与 prompt-ack extractDisposition',
      ).toBeGreaterThan(preflightIdx)
      expect(
        win.slice(preflightIdx, successIdx).includes('preflightSucceeded = true;'),
        'PS-81 漂移：preflightResult 回调不再先置 preflightSucceeded——catch 守卫将失去「已受理」记忆，复核 PS-81',
      ).toBe(true)
    })

    it('.catch 仅在 !preflightSucceeded 时 output error（受理后的异常不改写回执）', () => {
      const win = caseWindow(RPC_MODE_SRC, 'prompt')
      const catchIdx = win.indexOf('.catch((e) => {')
      expect(catchIdx, 'PS-81 漂移：prompt 链上的 .catch 分支消失——失败面改形，复核 PS-81').toBeGreaterThanOrEqual(0)
      const guardIdx = win.indexOf('if (!preflightSucceeded) {', catchIdx)
      expect(
        guardIdx,
        'PS-81 漂移：catch 不再以 !preflightSucceeded 守卫——已受理的 prompt 抛错会被改写成 error response，复核 PS-81',
      ).toBeGreaterThan(catchIdx)
      expect(
        win.indexOf('output(error(id, "prompt", e.message))', guardIdx),
        'PS-81 漂移：catch 的 error 输出形态变化（error(id, "prompt", …) 消失/移位），复核 PS-81',
      ).toBeGreaterThan(guardIdx)
    })
  },
)

describe.skipIf(!PI_DIST)(
  `PS-81 探针：prompt() disposition 值域 = handled / queued / started（静态断言${SKIP_REASON ? `｜skip：${SKIP_REASON}` : ''}）`,
  () => {
    it('prompt() 窗口内 preflightResult 调用点全集 = handled×2 / queued×1 / started×1', () => {
      const win = methodWindow(SESSION_SRC, 'async prompt(text, options) {')
      expect(win, 'PS-81 漂移：prompt() 方法消失/改签名——复核 PS-81 锚点 dist/core/agent-session.js').not.toBe('')

      const literals = [...win.matchAll(/preflightResult\?\.\("([a-z]+)"\)/g)].map((m) => m[1])
      expect(
        literals.sort(),
        'PS-81 漂移：disposition 值域变化（新增/删除/改名受理态）——prompt-ack 的 disposition 收窄与「三态皆受理」' +
          '语义需重新复核，改锚点后同步 prompt-ack.ts 头注与 docs/pi-semantics.json PS-81',
      ).toEqual(['handled', 'handled', 'queued', 'started'])
    })

    it('started 在 _runAgentPrompt 之前发出（受理 = 起轮前，非完成后回执）', () => {
      const win = methodWindow(SESSION_SRC, 'async prompt(text, options) {')
      const startedIdx = win.indexOf('preflightResult?.("started")')
      expect(
        startedIdx,
        'PS-81 漂移：started disposition 调用点消失——起轮受理回执形态改形，复核 PS-81',
      ).toBeGreaterThanOrEqual(0)
      const runIdx = win.indexOf('await this._runAgentPrompt(messages)')
      expect(
        runIdx,
        'PS-81 漂移：_runAgentPrompt 调用消失/改名——复核 PS-81 锚点',
      ).toBeGreaterThan(startedIdx)
    })
  },
)
