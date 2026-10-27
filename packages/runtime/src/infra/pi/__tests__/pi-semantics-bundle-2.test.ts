import { extractFunctionBody, stripComments, stripToCode } from './helpers/pi-dist-fn-extract.js';
import { locatePiCodingAgentDist, locatePiDist, methodWindow, methodWindowUntil } from './helpers/pi-semantics-probe.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← src/infra/pi/__tests__/pi-semantics-prompt-response.test.ts
// ======================================================================

const PI_DIST = locatePiCodingAgentDist()

const SKIP_REASON = PI_DIST
  ? ''
  : 'node_modules/@earendil-works/pi-coding-agent/dist 不可达（cwd 上溯 6 级未命中）'


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

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('pi-semantics-prompt-response', () => {
if (!PI_DIST) console.warn(`[pi-semantics] skip：${SKIP_REASON}`)
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
});

// ======================================================================
// ← src/infra/pi/__tests__/pi-semantics-reclaim-primitives.test.ts
// ======================================================================

const PI_DIST_m2 = locatePiCodingAgentDist()

const SKIP_REASON_m2 = PI_DIST_m2
  ? ''
  : 'node_modules/@earendil-works/pi-coding-agent/dist 不可达（cwd 上溯 6 级未命中）'


const SESSION_SRC_m2 = PI_DIST_m2 ? readFileSync(join(PI_DIST_m2, 'core', 'agent-session.js'), 'utf-8') : ''

const RPC_SRC = PI_DIST_m2 ? readFileSync(join(PI_DIST_m2, 'modes', 'rpc', 'rpc-mode.js'), 'utf-8') : ''


const count_m2 = (text: string, needle: string): number => text.split(needle).length - 1

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('pi-semantics-reclaim-primitives', () => {
if (SKIP_REASON_m2) console.warn(`[pi-semantics] skip：${SKIP_REASON}`)
describe.skipIf(!PI_DIST_m2)(
  `PS-64 探针：pi 队列条目无身份、无条目级收回原语${SKIP_REASON ? `｜skip：${SKIP_REASON_m2}` : ''}`,
  () => {
    it('出队判定 = message_start(user) 时全文 indexOf 文本匹配（无 id 参与）', () => {
      const win = methodWindow(SESSION_SRC_m2, '_handleAgentEvent = async (event) => {')
      expect(win, 'PS-64 漂移：_handleAgentEvent 消失/改名——复核 PS-64 锚 dist/core/agent-session.js:190').not.toBe('')

      expect(
        win.includes('event.type === "message_start" && event.message.role === "user"'),
        'PS-64 漂移：出队判定的 message_start(user) 门控改形——出队时机/通道变化，复审 PS-64',
      ).toBe(true)
      const steerIdx = win.indexOf('this._steeringMessages.indexOf(messageText)')
      const followIdx = win.indexOf('this._followUpMessages.indexOf(messageText)')
      expect(
        steerIdx,
        'PS-64 漂移：steering 队列不再按全文 indexOf 文本匹配出队（引入 id 寻址？）——「队列条目无身份」前提变化，对账器「全收→标记识别」机制可换窄接口，复审 PS-64',
      ).toBeGreaterThanOrEqual(0)
      expect(
        followIdx,
        'PS-64 漂移：followUp 队列不再按全文 indexOf 文本匹配出队——同上，复审 PS-64',
      ).toBeGreaterThanOrEqual(0)
      expect(steerIdx < followIdx, 'PS-64 漂移：两队列出队块相对序变化——复核 PS-64').toBe(true)
    })

    it('队列数组的条目级移除点全文件恰各一处（均在文本匹配出队块内），无按 id 撤单条方法', () => {
      expect(
        count_m2(SESSION_SRC_m2, '_steeringMessages.splice'),
        'PS-64 漂移：_steeringMessages.splice 运营点数量变化（预期 1）——出现第二条目级移除点（可能是条目级收回原语），复审 PS-64',
      ).toBe(1)
      expect(
        count_m2(SESSION_SRC_m2, '_followUpMessages.splice'),
        'PS-64 漂移：_followUpMessages.splice 运营点数量变化（预期 1）——同上，复审 PS-64',
      ).toBe(1)
    })

    it('clearQueue() 是唯一批量收回原语且队列级全清（返回拷贝 + 置空 + agent.clearAllQueues）', () => {
      const win = methodWindow(SESSION_SRC_m2, 'clearQueue() {')
      expect(win, 'PS-64 漂移：clearQueue() 方法消失/改名——复核 PS-64 锚 dist/core/agent-session.js:1846').not.toBe('')

      expect(
        win.includes('const steering = [...this._steeringMessages];'),
        'PS-64 漂移：clearQueue 不再返回队列拷贝——rpc-client.clearQueue 的 PiQueueSnapshot 回读语义定位失败，复审 PS-64',
      ).toBe(true)
      expect(
        win.includes('this._steeringMessages = [];') && win.includes('this._followUpMessages = [];'),
        'PS-64 漂移：clearQueue 不再整体置空两队列（改为选择性移除？）——「队列级全清」语义变化，对账器全收假设失效，复审 PS-64',
      ).toBe(true)
      expect(
        win.includes('this.agent.clearAllQueues();'),
        'PS-64 漂移：clearQueue 不再同步清空 agent 层队列——队列级全清不彻底，复审 PS-64',
      ).toBe(true)
      expect(
        count_m2(SESSION_SRC_m2, 'clearQueue() {'),
        'PS-64 漂移：clearQueue 方法定义数量变化（预期 1）——复核 PS-64',
      ).toBe(1)
    })
  },
)
describe.skipIf(!PI_DIST_m2)(
  `PS-65 探针：RPC 投递原语族恒五条且全部队列级${SKIP_REASON ? `｜skip：${SKIP_REASON_m2}` : ''}`,
  () => {
    it('投递原语族五 case 各恰一处，无条目级寻址/按 id 撤回命令', () => {
      for (const cmd of ['case "prompt"', 'case "steer"', 'case "follow_up"', 'case "abort"', 'case "clear_queue"']) {
        expect(
          count_m2(RPC_SRC, cmd),
          `PS-65 漂移：投递原语 ${cmd} 数量变化（预期 1）——RPC 投递原语族构成变化，复审 PS-65`,
        ).toBe(1)
      }
      expect(
        RPC_SRC.includes('case "remove') || RPC_SRC.includes('reclaim'),
        'PS-65 漂移：RPC 命令范围出现 remove/reclaim 类形态（疑似条目级收回原语）——pi 收回粒度上界不再队列级，对账器「全收+标记识别+三分处置」可被窄接口替代，复审 PS-64/PS-65',
      ).toBe(false)
    })

    it('clear_queue 的实装 = session.clearQueue() 队列级全清（无条目参数）', () => {
      const caseIdx = RPC_SRC.indexOf('case "clear_queue": {')
      expect(caseIdx, 'PS-65 漂移：clear_queue case 消失——pi 失去唯一批量收回原语，复审 PS-65').toBeGreaterThanOrEqual(0)
      const win = RPC_SRC.slice(caseIdx, RPC_SRC.indexOf('};', caseIdx))
      expect(
        win.includes('session.clearQueue()'),
        'PS-65 漂移：clear_queue 不再透传 session.clearQueue()（实装改形）——收回原语协议范围变化，rpc-client.clearQueue 契约定位失败，复审 PS-65',
      ).toBe(true)
      expect(
        count_m2(RPC_SRC, 'session.clearQueue()'),
        'PS-65 漂移：session.clearQueue() 调用点数量变化（预期 1）——复核 PS-65',
      ).toBe(1)
    })
  },
)
describe.skipIf(!PI_DIST_m2)(
  `PS-66 探针：非流式时 pi 忽略 streamingBehavior 参数${SKIP_REASON ? `｜skip：${SKIP_REASON_m2}` : ''}`,
  () => {
    it('prompt() 对 streamingBehavior 的消费全部在流式前提下，非流式路径零读取', () => {
      const win = methodWindow(SESSION_SRC_m2, 'async prompt(text, options) {')
      expect(win, 'PS-66 漂移：prompt() 方法消失/改名——复核 PS-66 锚 dist/core/agent-session.js:1481').not.toBe('')

      expect(
        win.includes('this.isStreaming ? options?.streamingBehavior : undefined'),
        'PS-66 漂移：input hook 的 streamingBehavior 传参不再按 isStreaming 三元调制（非流式可能传入真值）——复审 PS-66',
      ).toBe(true)

      const streamingBlockIdx = win.indexOf('if (this.isStreaming) {')
      expect(
        streamingBlockIdx,
        'PS-66 漂移：prompt() 的 isStreaming 分流块消失——throw/steer/followUp 通道整体改形，复审 PS-66',
      ).toBeGreaterThanOrEqual(0)
      expect(
        win.includes('if (!options?.streamingBehavior) {'),
        'PS-66 漂移：流式缺参 throw 分支改形（PS-23 同锚）——复审 PS-66',
      ).toBe(true)
      expect(
        win.includes('options.streamingBehavior === "followUp"'),
        'PS-66 漂移：followUp/steer 分流判定改形——复审 PS-66',
      ).toBe(true)

      // 非流式路径起点（flush pending）之后不再出现 streamingBehavior 读取
      const flushIdx = win.indexOf('this._flushPendingBashMessages()')
      expect(flushIdx, 'PS-66 漂移：非流式路径落点（flush pending）改形——窗口相对序定位失败，复核 PS-66 锚 :874').toBeGreaterThanOrEqual(0)
      expect(
        win.lastIndexOf('streamingBehavior'),
        'PS-66 漂移：窗口内 streamingBehavior 消费点消失——流式通道改形，复审 PS-66',
      ).toBeGreaterThan(0)
      expect(
        win.lastIndexOf('streamingBehavior') < flushIdx,
        'PS-66 漂移：非流式路径开始读取 streamingBehavior（预排队/直接消费？）——direct lane 恒带该参数提交将改变行为，session-delivery-registry lane 判定前提失效，复审 PS-66',
      ).toBe(true)
    })

    it('sendUserMessage 直透 deliverAs → streamingBehavior（extension 通道同语义）', () => {
      const win = methodWindow(SESSION_SRC_m2, 'async sendUserMessage(content, options) {')
      expect(win, 'PS-66 漂移：sendUserMessage 消失/改名——复核 PS-66 锚 dist/core/agent-session.js:1812').not.toBe('')
      expect(
        win.includes('streamingBehavior: options?.deliverAs,'),
        'PS-66 漂移：deliverAs 不再直透 streamingBehavior（改名/加变换？）——extension 通道投递语义变化，复审 PS-66',
      ).toBe(true)
      expect(
        win.includes('await this.prompt('),
        'PS-66 漂移：sendUserMessage 不再经 prompt()（另起投递通路？）——非流式忽略语义的覆盖范围变化，复审 PS-66',
      ).toBe(true)
    })
  },
)
});

// ======================================================================
// ← src/infra/pi/__tests__/pi-semantics-rpc-surface.test.ts
// ======================================================================

const CODING_AGENT_DIST = locatePiDist('pi-coding-agent', 'config.js')

const PI_AI_DIST = locatePiDist('pi-ai', 'models.js')

const SKIP_REASON_m2_d1 = CODING_AGENT_DIST
  ? ''
  : 'node_modules/@earendil-works/pi-coding-agent/dist 不可达（cwd 上溯 6 级未命中）'


/** 提取 rpc-mode.js 里某 case 分支的窗口文本（到下一个 case 声明或文件尾）。 */
function caseWindow_m2(rpcModeText: string, caseLabel: string): string {
  const start = rpcModeText.indexOf(`case "${caseLabel}":`)
  if (start === -1) return ''
  const rest = rpcModeText.slice(start)
  const next = /\n\s+case "/.exec(rest.slice(10))
  return next ? rest.slice(0, 10 + next.index) : rest
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('pi-semantics-rpc-surface', () => {
if (!CODING_AGENT_DIST) console.warn(`[pi-semantics] skip：${SKIP_REASON}`)
describe.skipIf(!CODING_AGENT_DIST)(
  `PS-03 探针：set_thinking_level 响应无 data（静态断言响应构造${SKIP_REASON ? `｜skip：${SKIP_REASON}` : ''}）`,
  () => {
    const rpcMode = readFileSync(join(CODING_AGENT_DIST as string, 'modes', 'rpc', 'rpc-mode.js'), 'utf-8')

    it('case 分支存在且调用 session.setThinkingLevel(command.level)', () => {
      const win = caseWindow(rpcMode, 'set_thinking_level')
      expect(win, 'PS-03 漂移：set_thinking_level case 分支消失——RPC 面改形，复核 PS-03 锚点').not.toBe('')
      expect(
        win.includes('session.setThinkingLevel(command.level)'),
        'PS-03 漂移：set_thinking_level 不再透传 command.level 给 session——复核 PS-03',
      ).toBe(true)
    })

    it('响应构造 = success(id, "set_thinking_level") 无第三参（无 data）', () => {
      const win = caseWindow(rpcMode, 'set_thinking_level')
      expect(
        /return success\(id,\s*"set_thinking_level"\);/.test(win),
        'PS-03 漂移：set_thinking_level 响应不再是无 data 形态（上游补了生效值？）——若 pi 已回传生效值，' +
          'runtime 的 set→get_state 补读链可简化，先复核 PS-03 锚点再动 session-service.ts',
      ).toBe(true)
      expect(
        !/success\(id,\s*"set_thinking_level",/.test(win),
        'PS-03 漂移：set_thinking_level 响应出现了 data 参数——语义侧变化，复核 PS-03 与 runtime 回执链',
      ).toBe(true)
    })
  },
)
describe.skipIf(!CODING_AGENT_DIST)(
  `PS-10 探针：get_available_models 全属性 / get_state 无 models 清单（静态断言${SKIP_REASON ? `｜skip：${SKIP_REASON}` : ''}）`,
  () => {
    const rpcMode = readFileSync(join(CODING_AGENT_DIST as string, 'modes', 'rpc', 'rpc-mode.js'), 'utf-8')

    it('get_available_models 返回 { models }（getAvailableSnapshot 全量）', () => {
      const win = caseWindow(rpcMode, 'get_available_models')
      expect(
        win.includes('getAvailableSnapshot()') && /return success\(id,\s*"get_available_models",\s*\{ models \}\);/.test(win),
        'PS-10 漂移：get_available_models 不再返回 { models } 全量快照——U5 对账入口改形，复核 PS-10 锚点',
      ).toBe(true)
    })

    it('get_state 快照不含 models 清单（model 字段仅当前模型）', () => {
      const win = caseWindow_m2(rpcMode, 'get_state')
      expect(win, 'PS-10 漂移：get_state case 分支消失——复核 PS-10 锚点').not.toBe('')
      expect(
        !/\bmodels\b/.test(win),
        'PS-10 漂移：get_state 快照出现了 models 集合——状态侧与清单侧合并？复核 PS-10 与标量状态拉取链',
      ).toBe(true)
    })
  },
)
describe.skipIf(!PI_AI_DIST)(
  `PS-10 探针：pi-ai Model 类型声明含 reasoning/thinkingLevelMap（静态断言${!PI_AI_DIST ? '｜skip：node_modules/@earendil-works/pi-ai/dist 不可达' : ''}）`,
  () => {
    it('types.d.ts 的 Model 接口声明 reasoning: boolean 与 thinkingLevelMap?: ThinkingLevelMap', () => {
      const types = readFileSync(join(PI_AI_DIST as string, 'types.d.ts'), 'utf-8')
      expect(
        /reasoning:\s*boolean;/.test(types),
        'PS-10 漂移：pi-ai Model 不再声明 reasoning: boolean——能力字段改形，复核 PS-10 锚点 dist/types.d.ts',
      ).toBe(true)
      expect(
        /thinkingLevelMap\?:\s*ThinkingLevelMap;/.test(types),
        'PS-10 漂移：pi-ai Model 不再声明 thinkingLevelMap——档位映射字段改形，复核 PS-10',
      ).toBe(true)
    })
  },
)
});

// ======================================================================
// ← src/infra/pi/__tests__/pi-semantics-select-long-pending.test.ts
// ======================================================================

const RPC_DIST = locatePiDist('pi-coding-agent', 'config.js')

const SKIP_REASON_m2_d2 = RPC_DIST
  ? ''
  : 'node_modules/@earendil-works/pi-coding-agent/dist 不可达（cwd 上溯 6 级未命中）'

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('pi-semantics-select-long-pending', () => {
if (!RPC_DIST) console.warn(`[pi-semantics] skip：${SKIP_REASON}`)
describe.skipIf(!RPC_DIST)(
  `PS-59 探针：select 无 timeout 恒长挂（${SKIP_REASON ? `skip：${SKIP_REASON_m2_d2}` : ''}）`,
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
          'watch 长挂前提定位失败。恢复动作：复核 select 定义行后更新本探针',
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
});

// ======================================================================
// ← src/infra/pi/__tests__/pi-semantics-select-no-turn.test.ts
// ======================================================================

const RPC_DIST_m2 = locatePiDist('pi-coding-agent', 'config.js')

const SKIP_REASON_m2_d3 = RPC_DIST_m2
  ? ''
  : 'node_modules/@earendil-works/pi-coding-agent/dist 不可达（cwd 上溯 6 级未命中）'


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


/** 前进一个代码字符：src[i] 是字符串字面量开引号则跳过整个字面量，否则走 1 字符。 */
function advancePastStrings(src: string, i: number): number {
  const c = src[i]
  return c === "'" || c === '"' || c === '`' ? skipString(src, i) : i + 1
}


/** 从 start（指向 '{'）做括号配对，返回块文本（含首尾花括号）与封口后下标。 */
function matchBrace(src: string, start: number): { text: string; end: number } | null {
  let depth = 0
  let i = start
  const n = src.length
  while (i < n) {
    const c = src[i]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return { text: src.slice(start, i + 1), end: i + 1 }
    }
    i = advancePastStrings(src, i)
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
    if (c === ';' || c === '}') return null
    if (c === '{') return matchBrace(src, i)
    i = advancePastStrings(src, i)
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


interface Analysis {  // oe-exempt:20261027:test:
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

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('pi-semantics-select-no-turn', () => {
if (!RPC_DIST) console.warn(`[pi-semantics] skip：${SKIP_REASON_m2}`)
describe.skipIf(!RPC_DIST)(
  `PS-45 探针：extension_ui_response 只 resolve 不回灌/不开 turn（应答可达效应集缺席断言${SKIP_REASON_m2 ? `｜skip：${SKIP_REASON}` : ''}）`,
  () => {
    const rpcMode = readFileSync(join(RPC_DIST as string, 'modes', 'rpc', 'rpc-mode.js'), 'utf-8')
    const analysis = analyze(rpcMode)

    it('定位装置：extension_ui_response 应答分派块提取成功（比较位或 case 位）', () => {
      expect(
        analysis.found,
        'PS-45 漂移：rpc-mode.js 未能定位 extension_ui_response 分派块——协议串改名 / 抽成谓词函数 / 移入常量比较等形态演化。' +
          '恢复动作：先核对 taiji packages/runtime/src/infra/pi/rpc-client.ts 发送的 type 串与实装是否仍一致' +
          '（不一致 = wire 契约漂移，runtime 同步改并重审本条 claim）；语义未变则按新形态更新本探针定位器',
      ).toBe(true)
    })

    it('语义①：应答路径可达面对扩展持有 Promise 执行 resolve（唯一入口效应）', () => {
      expect(analysis.found, FOUND_HINT).toBe(true)
      expect(
        /\.resolve\s*\(/.test(analysis.joined),
        'PS-45 漂移：应答路径可达效应集内无 .resolve( 调用——resolve 被移出可达面（超出调用展开深度/改走别的完成机制）' +
          '或应答机制改形。恢复动作：复核 rpc-mode.js 应答段与本探针 expandScope 展开装置',
      ).toBe(true)
    })

    it('语义②：应答路径在命令分派前终止（块尾 return/throw/continue/break 或紧邻 else）', () => {
      expect(analysis.found, FOUND_HINT).toBe(true)
      expect(
        analysis.exitOk,
        'PS-45 漂移：应答分派块既无终止语句也不邻接 else——应答路径可能落入后续命令分派/消息路径（真漂移），' +
          '或控制形态出现第三种演化（形态演化）。恢复动作：复核 rpc-mode.js 应答段语义，确认语义后更新本探针',
      ).toBe(true)
    })

    it('语义③：可达效应集零回灌/开 turn（对话写入·轮次启动·命令分派·事件串·output 全缺席）', () => {
      expect(analysis.found, FOUND_HINT).toBe(true)
      expect(
        analysis.violations,
        `PS-45 漂移：应答路径可达面出现对话效应——pi select 应答不再「只 resolve」，前提 1 失效，` +
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
});

// ======================================================================
// ← src/infra/pi/__tests__/pi-semantics-session-entries.test.ts
// ======================================================================

const PI_DIST_m2_m2 = locatePiCodingAgentDist()

const SKIP_REASON_m2_m5 = PI_DIST_m2_m2
  ? ''
  : 'node_modules/@earendil-works/pi-coding-agent/dist 不可达（cwd 上溯 6 级未命中）'


/** 行为级断言用：动态 import session-manager.js（纯映射函数 + SessionManager 类，依赖 fs/crypto/pi-ai 均可解析）。 */
type SessionManagerModule = {
  sessionEntryToContextMessages?: (entry: Record<string, unknown>) => unknown[]
  SessionManager?: { prototype: object }
}

const sessionManager: SessionManagerModule | null = await (async () => {
  if (!PI_DIST_m2_m2) return null
  try {
    return (await import(pathToFileURL(join(PI_DIST_m2_m2, 'core', 'session-manager.js')).href)) as SessionManagerModule
  } catch {
    return null
  }
})()


/** 提取函数窗口（到下一个 export function / 函数声明 / 文件尾）。 */
function functionWindow(text: string, header: string): string {
  const start = text.indexOf(header)
  if (start === -1) return ''
  const rest = text.slice(start + header.length)
  const next = /\n(?:export )?function /.exec(rest)
  return next ? rest.slice(0, next.index) : rest.slice(0, 3000)
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('pi-semantics-session-entries', () => {
if (!PI_DIST_m2_m2) console.warn(`[pi-semantics] skip：${SKIP_REASON}`)
describe.skipIf(!PI_DIST_m2_m2)(
  `PS-09 探针：sessionEntryToContextMessages 派生视图白名单（代码形态断言${SKIP_REASON ? `｜skip：${SKIP_REASON_m2_m5}` : ''}）`,
  () => {
    const src = readFileSync(join(PI_DIST_m2_m2 as string, 'core', 'session-manager.js'), 'utf-8')

    it('白名单分支：message / custom_message / branch_summary / compaction，兜底 return []', () => {
      const win = functionWindow(src, 'export function sessionEntryToContextMessages(entry)')
      expect(win, 'PS-09 漂移：sessionEntryToContextMessages 函数消失/改名——entry→上下文映射改形，复核 PS-09 锚点').not.toBe('')
      for (const t of ['message', 'custom_message', 'branch_summary', 'compaction']) {
        expect(
          win.includes(`entry.type === "${t}"`),
          `PS-09 漂移：白名单分支 "${t}" 消失——派生视图变化，复核 PS-09（live ≡ reload 等价性依据）`,
        ).toBe(true)
      }
      expect(win.includes('return []'), 'PS-09 漂移：兜底 return [] 消失——未知类型将进上下文？复核 PS-09').toBe(true)
    })

    it('无 plain custom 分支（type=custom 不被特判）', () => {
      const win = functionWindow(src, 'export function sessionEntryToContextMessages(entry)')
      expect(
        !/entry\.type === "custom"(?!_message)/.test(win),
        'PS-09 漂移：出现了 plain custom 特判分支——custom entry 开始进上下文，复核 PS-09 与 event-adapter 的 entry 映射',
      ).toBe(true)
    })
  },
)
describe.skipIf(!sessionManager?.sessionEntryToContextMessages)(
  'PS-09 探针：sessionEntryToContextMessages 行为断言（动态 import dist/core/session-manager.js）',
  () => {
    const fn = sessionManager!.sessionEntryToContextMessages!

    it('plain appendEntry 的 type=custom → []（不进 LLM 上下文）', () => {
      expect(fn({ type: 'custom', data: { foo: 1 }, timestamp: 1 })).toEqual([])
    })

    it('type=custom_message → 恰一条 role=custom 消息（customType 透传）', () => {
      const got = fn({ type: 'custom_message', customType: 'probe-type', content: [], display: 'hidden', timestamp: 1 })
      expect(got).toHaveLength(1)
      expect(got[0]).toMatchObject({ role: 'custom', customType: 'probe-type' })
    })
  },
)
describe.skipIf(!PI_DIST_m2_m2)(
  `PS-29 探针：appendCustomEntry 落盘形态静态断言（代码形态${SKIP_REASON ? `｜skip：${SKIP_REASON_m2_m5}` : ''}）`,
  () => {
    const sessionManagerSrc = readFileSync(join(PI_DIST_m2_m2 as string, 'core', 'session-manager.js'), 'utf-8')
    const agentSessionSrc = readFileSync(join(PI_DIST_m2_m2 as string, 'core', 'agent-session.js'), 'utf-8')

    it('appendCustomEntry：entry 字面量固定六字段（customType/data 逐字引用，含 timestamp）', () => {
      const win = methodWindowUntil(sessionManagerSrc, 'appendCustomEntry(customType, data) {', 'appendSessionInfo(')
      expect(
        win,
        'PS-29 漂移：appendCustomEntry 方法消失/改名——custom entry 落盘入口改形，复核 PS-29 锚点',
      ).not.toBe('')
      expect(
        win,
        'PS-29 漂移：entry 字面量不再固定 {type:"custom", customType, data, id, parentId, timestamp}——scanner ④ 分类静默失效，复核 session-manager.js appendCustomEntry 与 PS-29',
      ).toMatch(
        /\{\s*type: "custom",\s*customType,\s*data,\s*id: generateId\(this\.byId\),\s*parentId: this\.leafId,\s*timestamp: new Date\(\)\.toISOString\(\),/,
      )
      expect(
        win.includes('this._appendEntry(entry);'),
        'PS-29 漂移：appendCustomEntry 不再经 _appendEntry 落盘——落盘管线改形，复核 PS-29',
      ).toBe(true)
    })

    it('agent-session：core 绑定 appendEntry(customType, data) 直呼 appendCustomEntry（同参数序零变换）', () => {
      const win = methodWindowUntil(agentSessionSrc, 'appendEntry: (customType, data) => {', 'setSessionName:')
      expect(
        win,
        'PS-29 漂移：core 绑定 appendEntry 消失/改名——extension 落盘入口改形，复核 PS-29 锚点',
      ).not.toBe('')
      expect(
        win.includes('this.sessionManager.appendCustomEntry(customType, data)'),
        'PS-29 漂移：appendEntry 不再直呼 appendCustomEntry(customType, data)（参数序/中间变换改形）——custom entry 形态漂移，复核 agent-session.js _bindExtensionCore',
      ).toBe(true)
    })
  },
)
describe.skipIf(!sessionManager?.SessionManager)(
  'PS-29 探针：appendCustomEntry 行为断言（动态 import 实装 dist，原型桩零 fs 写）',
  () => {
    /** 原型桩宿主形状（只暴露 appendCustomEntry 依赖的成员；_appendEntry 被覆写为捕获器）。 */
    type AppendCustomEntryHost = {
      byId: Set<string>
      leafId: string
      _appendEntry: (entry: Record<string, unknown>) => void
      appendCustomEntry: (customType: string, data: unknown) => string
    }

    const Cls = sessionManager!.SessionManager!

    function makeHost(): { host: AppendCustomEntryHost; captured: Array<Record<string, unknown>> } {
      const host = Object.create(Cls.prototype) as AppendCustomEntryHost
      host.byId = new Set()
      host.leafId = 'leaf-0'
      const captured: Array<Record<string, unknown>> = []
      // 覆写落盘钩子：捕获 entry 即返回，不触 fileEntries/_persist（零 fs 写）
      host._appendEntry = (entry) => {
        captured.push(entry)
      }
      return { host, captured }
    }

    it('rename-session custom entry 落盘形态：六字段齐全、data 同引用、timestamp 为可解析 ISO 串', () => {
      const { host, captured } = makeHost()
      const data = { model: 'xiaomi-token-plan-cn/mimo-v2.6-flash', usage: { input: 10, output: 5 } }
      host.appendCustomEntry('rename-session', data)

      expect(captured).toHaveLength(1)
      const entry = captured[0]
      expect(entry.type).toBe('custom')
      expect(entry.customType).toBe('rename-session')
      // 同一引用 = 逐字透传（克隆/重建对象会 here 红）
      expect(entry.data).toBe(data)
      expect((entry.data as Record<string, unknown>).model).toBe('xiaomi-token-plan-cn/mimo-v2.6-flash')
      expect((entry.data as Record<string, unknown>).usage).toEqual({ input: 10, output: 5 })
      expect(typeof entry.id).toBe('string')
      expect((entry.id as string).length).toBeGreaterThan(0)
      expect(entry.parentId).toBe('leaf-0')
      expect(typeof entry.timestamp).toBe('string')
      // timestamp 可被 Date 解析（scanner ④ toLocalDate 依赖此性质）
      expect(Number.isNaN(new Date(entry.timestamp as string).getTime())).toBe(false)
    })
  },
)
});

// ======================================================================
// ← src/infra/pi/__tests__/pi-semantics-session-replay.test.ts
// ======================================================================

const PI_DIST_m2_m2_d1 = locatePiCodingAgentDist()

const SKIP_REASON_m2_m5_d1 = PI_DIST_m2_m2_d1
  ? ''
  : 'node_modules/@earendil-works/pi-coding-agent/dist 不可达（cwd 上溯 6 级未命中）'


const SM_SRC = PI_DIST_m2_m2_d1 ? readFileSync(join(PI_DIST_m2_m2_d1, 'core', 'session-manager.js'), 'utf-8') : ''

const SESSION_SRC_m2_m2 = PI_DIST_m2_m2_d1 ? readFileSync(join(PI_DIST_m2_m2_d1, 'core', 'agent-session.js'), 'utf-8') : ''


/** 模块级函数窗口：header 起到下一个列 0 闭括（`\n}`）止；找不到下界截 3000 字符兜底。 */
function moduleFnWindow(text: string, header: string): string {
  const start = text.indexOf(header)
  if (start === -1) return ''
  const end = text.indexOf('\n}', start + header.length)
  return end === -1 ? text.slice(start, start + 3000) : text.slice(start, end)
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('pi-semantics-session-replay', () => {
if (!PI_DIST_m2_m2_d1) console.warn(`[pi-semantics] skip：${SKIP_REASON}`)
describe.skipIf(!PI_DIST_m2_m2_d1)(
  `PS-60 探针：树重放规则——加载后 leafId = 文件尾非 header entry（${SKIP_REASON ? `skip：${SKIP_REASON_m2_m5_d1}` : ''}）`,
  () => {
    it('_buildIndex：文件序循环遍历 this.fileEntries，跳过 session header 后逐条赋 leafId（终值 = 最后一条非 header entry）', () => {
      const win = methodWindow(SM_SRC, '_buildIndex() {')
      expect(win, 'PS-60 漂移：_buildIndex 方法消失/改名——重放建索引改形，复核 PS-60').not.toBe('')
      const loopIdx = win.indexOf('for (const entry of this.fileEntries)')
      expect(
        loopIdx,
        'PS-60 漂移：_buildIndex 不再按文件序遍历 fileEntries——重放准则变化（按持久化指针？），复核 PS-60（撤回复活风险）',
      ).toBeGreaterThanOrEqual(0)
      const headerSkipIdx = win.indexOf('if (entry.type === "session")')
      expect(
        headerSkipIdx,
        'PS-60 漂移：header 跳过判定消失——header 会被当作叶子/树节点，复核 PS-60',
      ).toBeGreaterThan(loopIdx)
      const assignIdx = win.indexOf('this.leafId = entry.id')
      expect(
        assignIdx,
        'PS-60 漂移：循环内 leafId 赋值形态消失——叶子不再是「文件序最后一条」，复核 PS-60',
      ).toBeGreaterThan(headerSkipIdx)
    })

    it('_setSessionFile（resume/branching 加载路径）：loadEntriesFromFile 装载文件后经共享 _loadEntries 调 _buildIndex', () => {
      const win = methodWindow(SM_SRC, '_setSessionFile(sessionFile, preloadedFileEntries) {')
      expect(win, 'PS-60 漂移：_setSessionFile 方法消失/改签名——加载路径改形，复核 PS-60').not.toBe('')
      const loadIdx = win.indexOf('loadEntriesFromFile(this.sessionFile)')
      expect(
        loadIdx,
        'PS-60 漂移：加载路径不再经 loadEntriesFromFile 读全文件——复核 PS-60（文件路径裁剪喂数前提）',
      ).toBeGreaterThanOrEqual(0)
      // pi 1.0.0 起「装载 + 建索引」抽成共享 _loadEntries（构造器 preloaded 分支与本路径共用），
      // _buildIndex 移入其中尾部——链式两跳断言：_setSessionFile → _loadEntries → _buildIndex
      const loadEntriesIdx = win.indexOf('this._loadEntries(entries)')
      expect(
        loadEntriesIdx,
        'PS-60 漂移：加载路径不再经共享 _loadEntries 装载——装载链改形，复核 PS-60',
      ).toBeGreaterThan(loadIdx)
      const loadWin = methodWindow(SM_SRC, '_loadEntries(entries, options) {')
      expect(
        loadWin.includes('this._buildIndex()'),
        'PS-60 漂移：_loadEntries 末尾不再调 _buildIndex——重放不发生或换了准则，复核 PS-60',
      ).toBe(true)
    })

    it('buildSessionPath：从叶子沿 parentId 回溯到根；leaf 缺失兜底 = entries 末条', () => {
      const win = moduleFnWindow(SM_SRC, 'function buildSessionPath(entries, leafId, byId)')
      expect(win, 'PS-60 漂移：buildSessionPath 函数消失/改签名——活跃路径构造改形，复核 PS-60').not.toBe('')
      expect(
        win.includes('leaf ??= entries[entries.length - 1]'),
        'PS-60 漂移：leaf 缺失兜底不再是数组末条——兜底语义变化，复核 PS-60',
      ).toBe(true)
      expect(
        win.includes('current.parentId ? index.get(current.parentId) : undefined'),
        'PS-60 漂移：parentId 回溯形态消失——路径构造不再沿父链，复核 PS-60',
      ).toBe(true)
    })
  },
)
describe.skipIf(!PI_DIST_m2_m2_d1)(
  `PS-60 探针：撤回持久化链——追加恒推进叶子 + navigateTree 两步形态（${SKIP_REASON ? `skip：${SKIP_REASON_m2_m5_d1}` : ''}）`,
  () => {
    it('_appendEntry：追加即置 leafId = entry.id（运行时不变量：叶子恒 = 文件尾）', () => {
      const win = methodWindow(SM_SRC, '_appendEntry(entry) {')
      expect(win, 'PS-60 漂移：_appendEntry 方法消失/改名——复核 PS-60').not.toBe('')
      expect(
        win.includes('this.fileEntries.push(entry)'),
        'PS-60 漂移：追加不再 push 进 fileEntries（文件尾）——复核 PS-60',
      ).toBe(true)
      expect(
        win.includes('this.leafId = entry.id'),
        'PS-60 漂移：追加不再推进 leafId——叶子≠文件尾，taiji 文件路径裁剪取尾将错叶，复核 PS-60',
      ).toBe(true)
    })

    it('appendLabelChange：LabelEntry 以 parentId = 当前 leaf 落文件尾（撤回锚落尾的前提）', () => {
      const win = methodWindow(SM_SRC, 'appendLabelChange(targetId, label) {')
      expect(win, 'PS-60 漂移：appendLabelChange 方法消失/改签名——复核 PS-60').not.toBe('')
      expect(
        win.includes('parentId: this.leafId'),
        'PS-60 漂移：LabelEntry 不再挂当前 leaf 下——撤回锚不再落活跃路径尾部，重启后回退可能复活，复核 PS-60（ADR-0076）',
      ).toBe(true)
    })

    it('branch：仅移内存指针（this.leafId = branchFromId），窗口内不重写文件', () => {
      const win = methodWindow(SM_SRC, 'branch(branchFromId) {')
      expect(win, 'PS-60 漂移：branch 方法消失/改签名——树内回退形态变化，复核 PS-60').not.toBe('')
      expect(
        win.includes('this.leafId = branchFromId'),
        'PS-60 漂移：branch 不再移动 leafId 指针——回退机制改形，复核 PS-60（ADR-0076）',
      ).toBe(true)
      expect(
        win.includes('_rewriteFile'),
        'PS-60 漂移：branch 开始重写文件——append-only 前提被破坏（被撤内容物理删除？），复核 PS-60 与 ADR-0076 审计保留前提',
      ).toBe(false)
    })

    it('navigateTree（agent-session.js）：无摘要时 branch(newLeafId) 移指针 + label && !summaryText 时 appendLabelChange 落锚', () => {
      const win = methodWindow(SESSION_SRC_m2_m2, 'async navigateTree(targetId, options = {}) {')
      expect(win, 'PS-60 漂移：navigateTree 方法消失/改签名——ADR-0076 撤回机制整体重审（降级路径 P1）').not.toBe('')
      expect(
        win.includes('this.sessionManager.branch(newLeafId)'),
        'PS-60 漂移：navigateTree 不再经 branch 移指针——回退实现改形，复核 PS-60 与 ADR-0076',
      ).toBe(true)
      const guardIdx = win.indexOf('if (label && !summaryText)')
      expect(
        guardIdx,
        'PS-60 漂移：label 落锚的检查形态（label && !summaryText）消失——复核 PS-60',
      ).toBeGreaterThanOrEqual(0)
      expect(
        win.indexOf('this.sessionManager.appendLabelChange(targetId, label)'),
        'PS-60 漂移：navigateTree 不再 appendLabelChange 落锚（或换锚形态）——撤回锚落文件尾前提失效，复核 PS-60（ADR-0076）',
      ).toBeGreaterThan(guardIdx)
    })

    it('sessionEntryToContextMessages：label 类型不在映射分支内（落文件尾的撤回锚不进 LLM 上下文）', () => {
      const win = moduleFnWindow(SM_SRC, 'export function sessionEntryToContextMessages(entry)')
      expect(win, 'PS-60 漂移：sessionEntryToContextMessages 函数消失/改签名——复核 PS-60').not.toBe('')
      for (const t of ['message', 'custom_message', 'branch_summary', 'compaction']) {
        expect(
          win.includes(`entry.type === "${t}"`),
          `PS-60 漂移：映射分支 ${t} 消失——entry 映射词表变化，复核 PS-60`,
        ).toBe(true)
      }
      expect(
        win.includes('entry.type === "label"'),
        'PS-60 漂移：label 类型开始映射为 LLM 消息——撤回锚将进入模型上下文，复核 PS-60 与 ADR-0076',
      ).toBe(false)
      expect(
        win.includes('return [];'),
        'PS-60 漂移：非派生视图类型的 return [] 兜底消失——映射词表改形，复核 PS-60',
      ).toBe(true)
    })
  },
)
});

// ======================================================================
// ← src/infra/pi/__tests__/pi-semantics-signal-exit-codes.test.ts
// ======================================================================

const CODING_AGENT_DIST_m2 = locatePiDist('pi-coding-agent', 'modes/rpc/rpc-mode.js')

const SKIP_REASON_m2_d4 = CODING_AGENT_DIST_m2
  ? ''
  : 'node_modules/@earendil-works/pi-coding-agent/dist 不可达（cwd 上溯 6 级未命中）'

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('pi-semantics-signal-exit-codes', () => {
if (!CODING_AGENT_DIST_m2) console.warn(`[pi-semantics] skip：${SKIP_REASON}`)
describe.skipIf(!CODING_AGENT_DIST_m2)(
  `PS-80 探针：信号→退出码映射（静态断言 shutdown 锚${SKIP_REASON ? `｜skip：${SKIP_REASON_m2_d4}` : ''}）`,
  () => {
    const rpcMode = readFileSync(join(CODING_AGENT_DIST_m2 as string, 'modes', 'rpc', 'rpc-mode.js'), 'utf-8')

    it('信号处理器按 SIGHUP=129 / 其余=143 调 shutdown（exit 143 = 外部 SIGTERM 的归因依据）', () => {
      expect(rpcMode).toContain('shutdown(signal === "SIGHUP" ? 129 : 143, signal)')
    })
  },
)
});
