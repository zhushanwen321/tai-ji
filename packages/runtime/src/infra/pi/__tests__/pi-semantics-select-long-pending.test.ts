/**
 * PS-59 探针：RPC select 请求无 timeout 时永不超时（长挂语义）——notify-once watch 桥前提守卫。
 *
 * 登记条目（docs/pi-semantics.json PS-59）：createDialogPromise 仅在 opts?.timeout 真值时设
 * setTimeout，timeout 缺省 promise 恒 pending 直到 extension_ui_response 到达
 * （pendingExtensionRequests.get(response.id).resolve）或 abort signal；select 定义
 * timeout: opts?.timeout 直传无默认值。与 PS-45 互补（PS-45 登记应答路径只 resolve 不回灌，
 * 本条登记请求路径超时语义）。
 *
 * 承重（ADR-0087）：extension 以 {action:'watch'} 长挂 select 不传 timeout fire-and-forget，
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
import { extractFunctionBody, stripToCode } from './helpers/pi-dist-fn-extract.js'
import { locatePiDist } from './helpers/pi-semantics-probe.js'

const RPC_DIST = locatePiDist('pi-coding-agent', 'config.js')
const SKIP_REASON = RPC_DIST
  ? ''
  : 'node_modules/@earendil-works/pi-coding-agent/dist 不可达（cwd 上溯 6 级未命中）'
if (!RPC_DIST) console.warn(`[pi-semantics] skip：${SKIP_REASON}`)

describe.skipIf(!RPC_DIST)(
  `PS-59 探针：select 无 timeout 恒长挂（${SKIP_REASON ? `skip：${SKIP_REASON}` : ''}）`,
  () => {
    const rpcModeRaw = readFileSync(join(RPC_DIST as string, 'modes', 'rpc', 'rpc-mode.js'), 'utf-8')
    const rpcMode = stripToCode(rpcModeRaw)
    const dialogFn = extractFunctionBody(rpcMode, 'function createDialogPromise(')

    it('装置：createDialogPromise 函数体提取成功（0 = 形态漂移，禁静默放行）', () => {
      expect(
        dialogFn,
        'PS-59 装置漂移：rpc-mode.js 未提取到 createDialogPromise 函数体——函数改名/改形，' +
          '恢复动作：复核 rpc-mode.js dialog 助手形态后更新本探针定位器',
      ).not.toBeNull()
    })

    it('语义①：体内 setTimeout 仅出现在 opts?.timeout 门内（timeout 缺省恒不设超时）', () => {
      const fn = dialogFn as string
      const setTimeoutCount = fn.split('setTimeout(').length - 1
      expect(
        setTimeoutCount,
        'PS-59 漂移：createDialogPromise 体内 setTimeout 出现次数 ≠ 1——超时机制改形（多处定时器/' +
          '移出条件门），「无 timeout 恒长挂」须重审。恢复动作：复核体内超时逻辑后更新本探针',
      ).toBe(1)
      const gateIdx = fn.indexOf('if (opts?.timeout)')
      const timerIdx = fn.indexOf('setTimeout(')
      expect(
        gateIdx !== -1 && timerIdx > gateIdx,
        'PS-59 漂移：setTimeout 不再位于 if (opts?.timeout) 条件门内（缺省值/无条件超时），' +
          'watch 长挂 select 会被 pi 侧定时打断——ADR-0087 晚 respond 语义须重审。' +
          '恢复动作：复核门结构后更新本探针与 PS-59',
      ).toBe(true)
    })

    it('语义②：select 定义直传 opts?.timeout，无注入默认超时值', () => {
      const selectDef = rpcModeRaw
        .split('\n')
        .find((l) => l.includes('method: "select"'))
      expect(
        selectDef,
        'PS-59 装置漂移：rpc-mode.js 未找到 select 方法定义行（method: "select"）——' +
          'dialog 方法表改形，复核后更新本探针定位器',
      ).toBeDefined()
      expect(
        selectDef?.includes('timeout: opts?.timeout'),
        'PS-59 漂移：select 定义的 timeout 不再直传 opts?.timeout（注入了默认超时/忽略调用方值），' +
          'watch 长挂前提失锚。恢复动作：复核 select 定义行后更新本探针',
      ).toBe(true)
    })

    it('语义③：promise 完成入口 = 应答到达路径（pendingExtensionRequests 按 id resolve）', () => {
      expect(
        rpcMode.includes('pendingExtensionRequests.get(response.id)'),
        'PS-59 漂移：extension_ui_response 应答路径的 pendingExtensionRequests.get(response.id) ' +
          '形态消失——长挂 promise 的完成机制改形，晚 respond 兑现语义须重审（应答路径效应面由 ' +
          'PS-45 探针详断，本条只锚完成入口存在性）。恢复动作：复核应答分派段后更新本探针',
      ).toBe(true)
    })
  },
)
