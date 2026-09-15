/**
 * PS-05 探针：pi-agent-core steeringQueue 仅 2 个 drain 点（D6 探针层）。
 *
 * 登记条目（docs/pi-semantics.json）：「steeringQueue 全文仅 2 个 drain 点（run 轮询的
 * getSteeringMessages / 手动 continue()），run 收尾后无残留补触发——依赖 steer 的投递是
 * at-most-once，无任何兜底重放」。这是事故 A F2（通知十余次仅送达 1 次）的根因面。
 *
 * 断言方式（P-D1 代码形态断言）：静态直读 pi-agent-core dist/agent.js，对
 * steeringQueue.drain() 做出现次数 + 两种调用形态断言，失真即红（新增 drain 点 =
 * 投递语义变化，须重新评估 session-delivery 账本通道的必要性）。dist 不可达时 skip
 * 不 fail；不进 REAL_PI_TESTS 分池。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/pi-semantics-steering-drain.test.ts
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { locatePiDist } from './helpers/pi-semantics-probe.js'

const CORE_DIST = locatePiDist('pi-agent-core', 'agent.js')
const SKIP_REASON = CORE_DIST
  ? ''
  : 'node_modules/@earendil-works/pi-agent-core/dist 不可达（cwd 上溯 6 级未命中）'
if (!CORE_DIST) console.warn(`[pi-semantics] skip：${SKIP_REASON}`)

const AGENT_SRC = CORE_DIST ? readFileSync(join(CORE_DIST, 'agent.js'), 'utf-8') : ''
const count = (text: string, needle: string): number => text.split(needle).length - 1

describe.skipIf(!CORE_DIST)(
  `PS-05 探针：steeringQueue drain 点数量与形态（${SKIP_REASON ? `skip：${SKIP_REASON}` : ''}）`,
  () => {
    it('全文恰好 2 个 steeringQueue.drain() 调用点', () => {
      expect(
        count(AGENT_SRC, 'steeringQueue.drain()'),
        'PS-05 漂移：steeringQueue drain 点数量 ≠ 2——pi 新增/删除了消费点，steer 投递的 at-most-once ' +
          '假设须重评（事故 A F2），复核 docs/pi-semantics.json PS-05 锚点与 session-delivery 账本通道',
      ).toBe(2)
    })

    it('两个 drain 点形态：continue() 路径（queuedSteering 接收）+ run 轮询（getSteeringMessages return）', () => {
      expect(
        AGENT_SRC.includes('const queuedSteering = this.steeringQueue.drain();'),
        'PS-05 漂移：continue() 路径 drain 形态消失——手动续跑的 steering 消费改形，复核 PS-05',
      ).toBe(true)
      expect(
        AGENT_SRC.includes('return this.steeringQueue.drain();'),
        'PS-05 漂移：run 轮询 drain 形态消失——turn 边界消费改形，复核 PS-05',
      ).toBe(true)
    })

    it('steer 入队与清空面存在（enqueue / clear，与 drain 区分的守卫锚）', () => {
      expect(AGENT_SRC.includes('steeringQueue.enqueue(') || AGENT_SRC.includes('steeringQueue.enqueue(message'), 'PS-05 漂移：enqueue 形态消失——复核 PS-05').toBe(true)
      expect(AGENT_SRC.includes('steeringQueue.clear()'), 'PS-05 漂移：clear 形态消失——复核 PS-05').toBe(true)
    })
  },
)
