/**
 * PS-04 / PS-06 / PS-07 / PS-08 探针：pi-coding-agent agent-session.js 行为契约（D6 探针层）。
 *
 * 登记条目（docs/pi-semantics.json）：
 * - PS-04「setThinkingLevel 同值不落账不发声（isChanging 判定）；effective ≠ previous 必发事件」
 *   ——D9 删 30s 轮询的依据（pi 不会静默改值）。
 * - PS-06「_pendingNextTurnMessages 唯一消费点 = _runAgentPrompt 注入段（注入即清空）」
 *   ——nextTurn 投递依赖用户发起下一轮。
 * - PS-07「_emitAgentSettled 先复位 _isAgentRunActive 再发事件」——settled 边沿内 isIdle 恒真。
 * - PS-08「sendCustomMessage 四分支；triggerTurn:true 走 _runAgentPrompt 起轮直达」。
 *
 * 断言方式（P-D1 代码形态断言）：静态直读 dist/core/agent-session.js 的方法窗口，
 * 关键代码片段正则/出现次数断言，失真即红。dist 不可达时 skip 不 fail；不进
 * REAL_PI_TESTS 分池。pi 升级后红 = 对应 PS 条目语义漂移，先复核锚点再更新 verifiedWith。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/pi-semantics-agent-session.test.ts
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

const SESSION_SRC = PI_DIST ? readFileSync(join(PI_DIST, 'core', 'agent-session.js'), 'utf-8') : ''

const count = (text: string, needle: string): number => text.split(needle).length - 1

describe.skipIf(!PI_DIST)(
  `PS-04 探针：setThinkingLevel 条件落账/发声（isChanging 门控${SKIP_REASON ? `｜skip：${SKIP_REASON}` : ''}）`,
  () => {
    it('isChanging = effective !== previousLevel；appendThinkingLevelChange 与 thinking_level_changed 均在 if (isChanging) 块内', () => {
      // pi 0.84.4：签名加第二参 options（ModelMutationOptions.persist）——会话内切档默认
      // 不再写全局默认（0.84.1 是 isChanging 时自动写）。xyz 单参调用（rpc-mode.js:391
      // session.setThinkingLevel(command.level)）不触发 settings 写入，与 model-service
      // 「per-session runtime state — no persistence needed」设计一致；全局默认由
      // pi-provider-store 独立通路读写。条件落账/发声（claim 本体）逐行未变。
      const win = methodWindow(SESSION_SRC, 'setThinkingLevel(level, options = {}) {')
      expect(win, 'PS-04 漂移：setThinkingLevel 方法消失/改签名——复核 PS-04 锚点 dist/core/agent-session.js').not.toBe('')
      const isChangingIdx = win.indexOf('const isChanging = effectiveLevel !== previousLevel')
      expect(
        isChangingIdx,
        'PS-04 漂移：isChanging 判定形态消失（同值是否仍跳过落账？）——复核 PS-04（D9 删轮询的依据）',
      ).toBeGreaterThanOrEqual(0)
      expect(
        win.includes('if (options.persist) {'),
        'PS-04 漂移：options.persist 门控消失（全局默认写入恢复无条件/自动触发？xyz 单参调用将重新污染全局默认）——复核 PS-04',
      ).toBe(true)
      const ifIdx = win.indexOf('if (isChanging) {')
      expect(ifIdx, 'PS-04 漂移：if (isChanging) 块消失——复核 PS-04').toBeGreaterThanOrEqual(0)
      const block = win.slice(ifIdx, ifIdx + 900)
      expect(
        block.includes('appendThinkingLevelChange') && block.includes('thinking_level_changed'),
        'PS-04 漂移：落账/发声移出 isChanging 块（同值也会发声？）或事件类型改名——复核 PS-04',
      ).toBe(true)
    })
  },
)

describe.skipIf(!PI_DIST)(
  `PS-06 探针：_pendingNextTurnMessages 唯一 drain 点（注入即清空${SKIP_REASON ? `｜skip：${SKIP_REASON}` : ''}）`,
  () => {
    it('全文恰好 1 个 push 点 + 1 个清空点 + 1 个注入消费点，且消费点与清空点相邻（_runAgentPrompt 注入段）', () => {
      expect(
        count(SESSION_SRC, 'this._pendingNextTurnMessages.push('),
        'PS-06 漂移：nextTurn 入队点数量 ≠ 1——入队面变化，复核 PS-06 锚点',
      ).toBe(1)
      expect(
        count(SESSION_SRC, 'this._pendingNextTurnMessages = []'),
        'PS-06 漂移：nextTurn 清空点数量 ≠ 1——出现了额外 drain（pi 自身开始消费？）或消费点消失，复核 PS-06',
      ).toBe(1)
      const injectIdx = SESSION_SRC.indexOf('for (const msg of this._pendingNextTurnMessages)')
      expect(
        injectIdx,
        'PS-06 漂移：注入消费形态消失——drain 改形，复核 PS-06',
      ).toBeGreaterThanOrEqual(0)
      const clearIdx = SESSION_SRC.indexOf('this._pendingNextTurnMessages = []')
      expect(
        clearIdx - injectIdx > 0 && clearIdx - injectIdx < 300,
        'PS-06 漂移：注入与清空不再相邻（消费-清空原子性破坏？）——复核 PS-06',
      ).toBe(true)
    })
  },
)

describe.skipIf(!PI_DIST)(
  `PS-07 探针：_emitAgentSettled 先复位 busy 标志再发事件（${SKIP_REASON ? `skip：${SKIP_REASON}` : ''}）`,
  () => {
    it('方法体首条语句 = _isAgentRunActive = false，先于 agent_settled 事件发射', () => {
      const win = methodWindow(SESSION_SRC, '_emitAgentSettled() {')
      expect(win, 'PS-07 漂移：_emitAgentSettled 方法消失——settled 边沿语义改形，复核 PS-07 锚点').not.toBe('')
      const resetIdx = win.indexOf('this._isAgentRunActive = false')
      const emitIdx = win.indexOf('type: "agent_settled"')
      expect(resetIdx, 'PS-07 漂移：settled 内 busy 复位语句消失——复核 PS-07').toBeGreaterThanOrEqual(0)
      expect(emitIdx, 'PS-07 漂移：agent_settled 事件类型改名——复核 PS-07').toBeGreaterThanOrEqual(0)
      expect(
        resetIdx < emitIdx,
        'PS-07 漂移：busy 复位晚于事件发射——边沿回调内 isIdle 不再恒真，settled 驱动的通知通道时序假设失效，复核 PS-07',
      ).toBe(true)
    })
  },
)

describe.skipIf(!PI_DIST)(
  `PS-08 探针：sendCustomMessage 四分支 + triggerTurn 直达（${SKIP_REASON ? `skip：${SKIP_REASON}` : ''}）`,
  () => {
    it('分支齐全：nextTurn 入队 / isStreaming 分流 / triggerTurn 直达 / isStreaming+triggerTurn:false 延迟落账 / 其余仅 append', () => {
      // pi 0.84.4：原 else 内联 append 抽成 _appendCustomMessage（push + appendCustomMessageEntry
      // 落账 + message_start/end 双发，逐行等价），并新增第五分支 defer：isStreaming &&
      // triggerTurn===false 时延迟到 turn 末尾落账（修 replay 顺序 bug：立即 append 会插进
      // tool call 与 result 之间）。xyz 全侧调用形态 = {triggerTurn:true}（D5 单通道）/
      // {deliverAs:"nextTurn"} / 非流式不传 options——defer 场景 xyz 不可达，claim 四条
      // xyz 消费路径行为不变。
      const win = methodWindow(SESSION_SRC, 'async sendCustomMessage(message, options) {')
      expect(win, 'PS-08 漂移：sendCustomMessage 方法消失/改签名——复核 PS-08 锚点').not.toBe('')
      expect(win.includes('options?.deliverAs === "nextTurn"'), 'PS-08 漂移：nextTurn 分支消失——复核 PS-08').toBe(true)
      expect(
        win.includes('this.isStreaming && options?.triggerTurn !== false'),
        'PS-08 漂移：isStreaming 分流分支（steer|followUp）条件消失——复核 PS-08',
      ).toBe(true)
      const triggerIdx = win.indexOf('else if (options?.triggerTurn)')
      expect(triggerIdx, 'PS-08 漂移：triggerTurn 分支消失——直达起轮路径改形，复核 PS-08').toBeGreaterThanOrEqual(0)
      expect(
        win.slice(triggerIdx, triggerIdx + 200).includes('await this._runAgentPrompt(appMessage)'),
        'PS-08 漂移：triggerTurn 不再走 _runAgentPrompt 直达——投递语义变化，复核 PS-08（事故 A 基线 session 唯一成功样本路径）',
      ).toBe(true)
      expect(
        win.includes('else if (this.isStreaming)'),
        'PS-08 漂移：defer 分支（isStreaming+triggerTurn:false 延迟落账，0.84.4 新增）消失——复核 PS-08',
      ).toBe(true)
      expect(
        win.includes('this._appendCustomMessage(appMessage)'),
        'PS-08 漂移：无 trigger 分支不再走 _appendCustomMessage append——复核 PS-08 与 PS-09',
      ).toBe(true)
      // 落账/双发下沉在 _appendCustomMessage（0.84.4 从 else 内联抽出）：持久化与双发形态不得再漂
      const appendWin = methodWindow(SESSION_SRC, '_appendCustomMessage(appMessage) {')
      expect(appendWin, 'PS-08 漂移：_appendCustomMessage 方法消失——复核 PS-08').not.toBe('')
      expect(
        appendWin.includes('appendCustomMessageEntry'),
        'PS-08 漂移：custom_message 持久化移出 _appendCustomMessage——复核 PS-08 与 PS-09',
      ).toBe(true)
      expect(
        appendWin.includes('"message_start"') && appendWin.includes('"message_end"'),
        'PS-08 漂移：custom 消息 message_start/end 双发形态变化——core 去双计（effects/registry.ts custom role 跳过）依赖该行为——复核 PS-08',
      ).toBe(true)
    })
  },
)
