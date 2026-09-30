/**
 * PS-56 探针：pi agent-loop 工具 execute 返回值的错误标记约定——W4 throw 范式前提守卫。
 *
 * 登记条目（docs/pi-semantics.json PS-56）：agent-loop executePreparedToolCall 正常路径
 * return { result, isError: false }（硬编码 false——execute 返回值携带的 isError 字段被
 * 丢弃，不参与判定），仅 execute throw 时 catch 分支置 isError:true 并以
 * createErrorToolResult(error.message) 作为 result。
 *
 * 承重（W4 throw 范式）：pi extension 工具错误路径必须 throw 才能对 agent 呈现
 * isError:true——session-manager 6 工具（callSessionManager 失败四态 + channel {error}
 * respond）、ask-user/scheduler/session-reader 同款；扩展若改在返回值上携带 isError
 * 字段，agent-loop 丢弃之，错误退化为「错误标成功」。
 *
 * 断言方式：静态直读 node_modules 实装 dist（pi 语义断言权威源，见 AGENTS.md）。
 * dist 不可达时 skip 不 fail；凭证无关、不进 REAL_PI_TESTS 分池。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/pi-semantics-tool-error-flag.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractFunctionBody, stripToCode } from './helpers/pi-dist-fn-extract.js'
import { locatePiDist } from './helpers/pi-semantics-probe.js'

const AGENT_CORE_DIST = locatePiDist('pi-agent-core', 'agent.js')
const SKIP_REASON = AGENT_CORE_DIST
  ? ''
  : 'node_modules/@earendil-works/pi-agent-core/dist 不可达（cwd 上溯 6 级未命中）'
if (!AGENT_CORE_DIST) console.warn(`[pi-semantics] skip：${SKIP_REASON}`)

describe.skipIf(!AGENT_CORE_DIST)(
  `PS-56 探针：execute 返回值 isError 被丢弃、仅 throw 置 true（${SKIP_REASON ? `skip：${SKIP_REASON}` : ''}）`,
  () => {
    const agentLoopRaw = readFileSync(join(AGENT_CORE_DIST as string, 'agent-loop.js'), 'utf-8')
    const agentLoop = stripToCode(agentLoopRaw)
    const execFn = extractFunctionBody(agentLoop, 'async function executePreparedToolCall(')

    it('装置：executePreparedToolCall 函数体提取成功（0 = 形态漂移，禁静默放行）', () => {
      expect(
        execFn,
        'PS-56 装置漂移：agent-loop.js 未提取到 executePreparedToolCall 函数体——函数改名/改形，' +
          '恢复动作：复核 agent-loop.js 工具执行段形态后更新本探针定位器',
      ).not.toBeNull()
    })

    it('语义①：正常 return 硬编码 isError:false（返回值携带的 isError 字段被丢弃）', () => {
      const fn = execFn as string
      const okReturns = fn.split('isError: false').length - 1
      expect(
        okReturns,
        'PS-56 漂移：正常 return 的 isError: false 字面量出现次数 ≠ 1——返回值错误标记改形' +
          '（读取 execute 返回值携带的 isError / 改由调用方判定），扩展在返回值上携带 isError 的' +
          '「错误标成功」退化须重审。恢复动作：复核正常路径 return 形态后更新本探针与 PS-56',
      ).toBe(1)
    })

    it('语义②：catch 分支置 isError:true（错误标记唯一来源 = execute throw）', () => {
      const fn = execFn as string
      const catchIdx = fn.indexOf('catch (error)')
      const errFlagIdx = fn.indexOf('isError: true')
      expect(
        catchIdx !== -1 && errFlagIdx > catchIdx,
        'PS-56 漂移：isError: true 不再位于 catch 分支内（错误标记来源改形——返回值字段/' +
          '外部状态判定），W4 throw 范式（错误路径必须 throw）前提失锚。' +
          '恢复动作：复核 catch 分支后更新本探针与 PS-56',
      ).toBe(true)
    })

    it('语义③：catch 的 result 经 createErrorToolResult 包装（throw 的 message 进 tool result）', () => {
      const fn = execFn as string
      const wrapped = fn.includes('createErrorToolResult(')
      expect(
        wrapped,
        'PS-56 漂移：catch 分支不再经 createErrorToolResult 包装错误 result——' +
          'throw 的错误信息呈现形态改形，agent 可见错误文本语义须重审。' +
          '恢复动作：复核 catch result 构造后更新本探针与 PS-56',
      ).toBe(true)
    })
  },
)
