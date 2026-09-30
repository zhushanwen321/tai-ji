/**
 * PS-64 / PS-65 / PS-66 探针：pi 收回原语族与 streamingBehavior 非流式语义
 * （delivery-ownership-kernel 投递所有权内核收回机制的 pi 侧承重断言，原挂不入库
 * 设计文档 F8/F9/F12 节号，PS 登记补录后进 pi bump 门禁）。
 *
 * 登记条目（docs/pi-semantics.json）：
 * - PS-64「pi 队列条目无身份、无条目级收回原语：唯一条目移除点 = message_start(user)
 *   全文 indexOf 文本匹配出队；clearQueue() 队列级全清」——对账器「全收 → 标记识别 →
 *   重投/收养」三分处置的机制前提。
 * - PS-65「pi RPC 投递原语族恒五条且全部队列级（prompt/steer/follow_up/abort/
 *   clear_queue），无条目级寻址」——session-delivery-registry Reconciler 的存在理由。
 * - PS-66「非流式时 pi 忽略 streamingBehavior（全部消费点在流式前提下调制）」——
 *   direct lane 恒带 toStreamingBehavior(intent) 提交的行为正确性旁证。
 *
 * 断言方式：静态直读 node_modules 实装 dist（pi-coding-agent core/agent-session.js +
 * modes/rpc/rpc-mode.js）的锚串、计数与窗口内相对序，漂移即红。dist 不可达时 skip
 * 不 fail；不进 REAL_PI_TESTS 分池。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/pi-semantics-reclaim-primitives.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { locatePiCodingAgentDist, methodWindow } from './helpers/pi-semantics-probe.js'

const PI_DIST = locatePiCodingAgentDist()
const SKIP_REASON = PI_DIST
  ? ''
  : 'node_modules/@earendil-works/pi-coding-agent/dist 不可达（cwd 上溯 6 级未命中）'
if (SKIP_REASON) console.warn(`[pi-semantics] skip：${SKIP_REASON}`)

const SESSION_SRC = PI_DIST ? readFileSync(join(PI_DIST, 'core', 'agent-session.js'), 'utf-8') : ''
const RPC_SRC = PI_DIST ? readFileSync(join(PI_DIST, 'modes', 'rpc', 'rpc-mode.js'), 'utf-8') : ''

const count = (text: string, needle: string): number => text.split(needle).length - 1

describe.skipIf(!PI_DIST)(
  `PS-64 探针：pi 队列条目无身份、无条目级收回原语${SKIP_REASON ? `｜skip：${SKIP_REASON}` : ''}`,
  () => {
    it('出队判定 = message_start(user) 时全文 indexOf 文本匹配（无 id 参与）', () => {
      const win = methodWindow(SESSION_SRC, '_handleAgentEvent = async (event) => {')
      expect(win, 'PS-64 漂移：_handleAgentEvent 消失/改名——复核 PS-64 锚 dist/core/agent-session.js:360').not.toBe('')

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
        count(SESSION_SRC, '_steeringMessages.splice'),
        'PS-64 漂移：_steeringMessages.splice 运营点数量变化（预期 1）——出现第二条目级移除点（可能是条目级收回原语），复审 PS-64',
      ).toBe(1)
      expect(
        count(SESSION_SRC, '_followUpMessages.splice'),
        'PS-64 漂移：_followUpMessages.splice 运营点数量变化（预期 1）——同上，复审 PS-64',
      ).toBe(1)
    })

    it('clearQueue() 是唯一批量收回原语且队列级全清（返回拷贝 + 置空 + agent.clearAllQueues）', () => {
      const win = methodWindow(SESSION_SRC, 'clearQueue() {')
      expect(win, 'PS-64 漂移：clearQueue() 方法消失/改名——复核 PS-64 锚 dist/core/agent-session.js:1195').not.toBe('')

      expect(
        win.includes('const steering = [...this._steeringMessages];'),
        'PS-64 漂移：clearQueue 不再返回队列拷贝——rpc-client.clearQueue 的 PiQueueSnapshot 回读语义失锚，复审 PS-64',
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
        count(SESSION_SRC, 'clearQueue() {'),
        'PS-64 漂移：clearQueue 方法定义数量变化（预期 1）——复核 PS-64',
      ).toBe(1)
    })
  },
)

describe.skipIf(!PI_DIST)(
  `PS-65 探针：RPC 投递原语族恒五条且全部队列级${SKIP_REASON ? `｜skip：${SKIP_REASON}` : ''}`,
  () => {
    it('投递原语族五 case 各恰一处，无条目级寻址/按 id 撤回命令', () => {
      for (const cmd of ['case "prompt"', 'case "steer"', 'case "follow_up"', 'case "abort"', 'case "clear_queue"']) {
        expect(
          count(RPC_SRC, cmd),
          `PS-65 漂移：投递原语 ${cmd} 数量变化（预期 1）——RPC 投递原语族构成变化，复审 PS-65`,
        ).toBe(1)
      }
      expect(
        RPC_SRC.includes('case "remove') || RPC_SRC.includes('reclaim'),
        'PS-65 漂移：RPC 命令面出现 remove/reclaim 类形态（疑似条目级收回原语）——pi 收回粒度上界不再队列级，对账器「全收+标记识别+三分处置」可被窄接口替代，复审 PS-64/PS-65',
      ).toBe(false)
    })

    it('clear_queue 的实装 = session.clearQueue() 队列级全清（无条目参数）', () => {
      const caseIdx = RPC_SRC.indexOf('case "clear_queue": {')
      expect(caseIdx, 'PS-65 漂移：clear_queue case 消失——pi 失去唯一批量收回原语，复审 PS-65').toBeGreaterThanOrEqual(0)
      const win = RPC_SRC.slice(caseIdx, RPC_SRC.indexOf('};', caseIdx))
      expect(
        win.includes('session.clearQueue()'),
        'PS-65 漂移：clear_queue 不再透传 session.clearQueue()（实装改形）——收回原语协议面变化，rpc-client.clearQueue 契约失锚，复审 PS-65',
      ).toBe(true)
      expect(
        count(RPC_SRC, 'session.clearQueue()'),
        'PS-65 漂移：session.clearQueue() 调用点数量变化（预期 1）——复核 PS-65',
      ).toBe(1)
    })
  },
)

describe.skipIf(!PI_DIST)(
  `PS-66 探针：非流式时 pi 忽略 streamingBehavior 参数${SKIP_REASON ? `｜skip：${SKIP_REASON}` : ''}`,
  () => {
    it('prompt() 对 streamingBehavior 的消费全部在流式前提下，非流式路径零读取', () => {
      const win = methodWindow(SESSION_SRC, 'async prompt(text, options) {')
      expect(win, 'PS-66 漂移：prompt() 方法消失/改名——复核 PS-66 锚 dist/core/agent-session.js:821').not.toBe('')

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
      expect(flushIdx, 'PS-66 漂移：非流式路径落点（flush pending）改形——窗口相对序失锚，复核 PS-66 锚 :874').toBeGreaterThanOrEqual(0)
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
      const win = methodWindow(SESSION_SRC, 'async sendUserMessage(content, options) {')
      expect(win, 'PS-66 漂移：sendUserMessage 消失/改名——复核 PS-66 锚 dist/core/agent-session.js:1161').not.toBe('')
      expect(
        win.includes('streamingBehavior: options?.deliverAs,'),
        'PS-66 漂移：deliverAs 不再直透 streamingBehavior（改名/加变换？）——extension 通道投递语义变化，复审 PS-66',
      ).toBe(true)
      expect(
        win.includes('await this.prompt('),
        'PS-66 漂移：sendUserMessage 不再经 prompt()（另起投递通路？）——非流式忽略语义的覆盖面变化，复审 PS-66',
      ).toBe(true)
    })
  },
)
