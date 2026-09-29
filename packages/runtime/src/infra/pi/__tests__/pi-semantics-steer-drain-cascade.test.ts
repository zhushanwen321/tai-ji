/**
 * PS-58 探针：steer 投递在 pi busy 窗口不拒绝、随 run 循环级联排空——notify-once 兑现链前提守卫。
 *
 * 登记条目（docs/pi-semantics.json PS-58）：prompt() 在 isStreaming 且 streamingBehavior='steer'
 * 时走 _queueSteer 入队（不 throw——第二拒绝分支仅覆盖未传 streamingBehavior，PS-23），
 * agent.steer 原样入 steeringQueue；runAgentLoop 在 run 起始、preparation（compaction 等长操作）
 * 后补查、每轮结束后三处 poll getSteeringMessages（= steeringQueue.drain()），drain 到的
 * pending 消息在下一轮 assistant 响应前注入（emit message_start/message_end + push
 * currentContext/newMessages）。
 *
 * 承重（ADR-0087）：delivery 内核 steer 投递命中 busy 窗口时消息不悬空——只要 pi run 尚存续
 * 必被当前 run 消费并产出轮次，agent_settled 仍会到达，injected→settled 兑现链不因入队延迟
 * 断裂。反面（run 收尾后入队的 steer 无 drain 点、at-most-once）由 PS-05 登记、session-delivery
 * 账本通道规避，两条互补。
 *
 * 断言方式：静态直读 node_modules 实装 dist（pi 语义断言权威源，见 AGENTS.md）。
 * dist 不可达时 skip 不 fail；凭证无关、不进 REAL_PI_TESTS 分池。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/pi-semantics-steer-drain-cascade.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { locatePiDist, methodWindow } from './helpers/pi-semantics-probe.js'

const CODE_DIST = locatePiDist('pi-coding-agent', 'config.js')
const AGENT_CORE_DIST = locatePiDist('pi-agent-core', 'agent.js')
const SKIP_REASON =
  CODE_DIST && AGENT_CORE_DIST
    ? ''
    : `node_modules 实装 dist 不可达（coding-agent: ${!CODE_DIST}，agent-core: ${!AGENT_CORE_DIST}）`
if (SKIP_REASON) console.warn(`[pi-semantics] skip：${SKIP_REASON}`)

const count = (text: string, needle: string): number => text.split(needle).length - 1

describe.skipIf(!CODE_DIST || !AGENT_CORE_DIST)(
  `PS-58 探针：steer busy 入队 + run 循环逐轮排空（${SKIP_REASON ? `skip：${SKIP_REASON}` : ''}）`,
  () => {
    const agentSession = readFileSync(join(CODE_DIST as string, 'core', 'agent-session.js'), 'utf-8')
    const agentLoop = readFileSync(join(AGENT_CORE_DIST as string, 'agent-loop.js'), 'utf-8')

    it('装置：dist 源文件可读且非空', () => {
      expect(agentSession.length, 'agent-session.js 读取为空——dist 布局变化，更新本探针路径').toBeGreaterThan(0)
      expect(agentLoop.length, 'agent-loop.js 读取为空——dist 布局变化，更新本探针路径').toBeGreaterThan(0)
    })

    it('语义①：prompt() isStreaming 分支内 steer 路径走 _queueSteer 入队（busy 不拒绝）', () => {
      const promptWin = methodWindow(agentSession, 'async prompt(text, options) {')
      expect(
        promptWin,
        'PS-58 装置漂移：prompt(text, options) 方法窗口提取为空——方法签名改名/改形，复核后更新 methodWindow 参数',
      ).not.toBe('')
      const isStreamingIdx = promptWin.indexOf('if (this.isStreaming)')
      const steerIdx = promptWin.indexOf('await this._queueSteer(')
      expect(
        isStreamingIdx !== -1 && steerIdx !== -1 && isStreamingIdx < steerIdx,
        'PS-58 漂移：prompt() 的 isStreaming 分支内不再有 _queueSteer 入队调用——busy + steer 语义变化' +
          '（改为拒绝/改走 followUp/异步丢弃），delivery 内核 steer 投递的 busy 兜底失效，injected→settled ' +
          '兑现链须重审。恢复动作：复核 agent-session.js prompt() 分支后更新本探针与 PS-58',
      ).toBe(true)
    })

    it('语义②：_queueSteer 体原样 agent.steer 入队（无 transform 旁路）', () => {
      const queueSteerWin = methodWindow(agentSession, 'async _queueSteer(text, images) {')
      expect(
        queueSteerWin.includes('this.agent.steer('),
        'PS-58 漂移：_queueSteer 不再直接 this.agent.steer( 入队——入队链出现改写/分流，' +
          'steer 消息的原文存活与排空时机须重审。恢复动作：复核 _queueSteer 体后更新本探针',
      ).toBe(true)
    })

    it('语义③：runAgentLoop 恰 3 处 getSteeringMessages poll（run 起始 / preparation 后 / 每轮尾）', () => {
      expect(
        count(agentLoop, 'config.getSteeringMessages'),
        'PS-58 漂移：agent-loop.js 的 getSteeringMessages poll 点数量 ≠ 3——run 循环的排空调度变化，' +
          '「run 存续期间逐轮排空」前提须重审（新增 poll 点 = 排空更及时无害；减少 = busy 窗口 steer ' +
          '悬挂风险上升）。恢复动作：复核 agent-loop.js poll 结构后更新本探针与 PS-58',
      ).toBe(3)
    })

    it('语义④：drain 到的 pending 消息在下一轮响应前注入当前 run（emit + push 上下文）', () => {
      expect(
        agentLoop.includes('currentContext.messages.push(message)') &&
          agentLoop.includes('emit({ type: "message_start", message })'),
        'PS-58 漂移：agent-loop.js 的 pending 消息注入块（message_start emit + currentContext push）消失——' +
          'drain 到的 steer 消息不再进入当前 run 处理，「级联消费 → agent_settled 仍会到达」结论失锚。' +
          '恢复动作：复核注入块形态后更新本探针',
      ).toBe(true)
    })
  },
)
