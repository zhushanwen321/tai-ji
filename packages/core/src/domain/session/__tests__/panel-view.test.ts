/**
 * derivePanelView 全输入组合表测试（设计 D1 / 验收 V5）。
 *
 * 组合空间：sessionId×2 × hasMessages×2 × isSessionDead×2 × isSessionRespawning×2 ×
 * isTraceView×2 × hasAskUserRequest×2 × isFlowActive×2 = 128 组合，嵌套循环逐一断言。
 *
 * 期望值来自独立手推的字面量表（EXPECTED），与实现零共享逻辑——防止「用被测函数
 * 自身推期望」的同义反复。hasMessages 不影响 kind（见 panel-view.ts 模块头注释），
 * 不进期望 key，同一 key 在两个 hasMessages 值下各断言一次（恰 128 次）。
 *
 * 期望表推导依据（D1 规则，非实现）：
 * - sessionId 非空：dead（respawning 抑制）> trace > conversation；isFlowActive 不参与
 *   （landing 要求无 session）。
 *   dead=1,respawning=0 → dead（吞掉 trace/ask-user/flow，W6「dead 不应答」）；
 *   dead=1,respawning=1 → respawning 抑制 dead（crash-resilience T4：自动恢复窗口
 *   对话保持可用形态），后续按 dead=0 规则：trace=1 → trace（保留输入面，session-trace
 *   契约「composer 保留，不打断对话能力」，D5）；trace=0 → conversation；input 按
 *   hasAskUserRequest 互斥；
 *   dead=0 → respawning 无死可抑制（no-op），同上 trace/conversation 规则。
 * - sessionId 空：dead/respawning/trace 前置约束不成立、conversation 不可达、ask-user
 *   无处挂靠；isFlowActive=1 → landing，否则 empty{sessionId:null}。
 */
import { describe, it, expect } from 'vitest'
import { derivePanelView } from '../panel-view'
import type { PanelView } from '../panel-view'

/** 期望 key：`${sessionId ?? 'null'}|${dead}${respawning}${trace}${ask}${flow}`（1/0 编码） */
const EXPECTED: Record<string, PanelView> = {
  // ── sessionId='s1'，dead=1 respawning=0：dead 优先吞掉 trace / ask-user / flow（2^3 = 8 格）──
  's1|10000': { kind: 'dead', sessionId: 's1' },
  's1|10001': { kind: 'dead', sessionId: 's1' },
  's1|10010': { kind: 'dead', sessionId: 's1' },
  's1|10011': { kind: 'dead', sessionId: 's1' },
  's1|10100': { kind: 'dead', sessionId: 's1' },
  's1|10101': { kind: 'dead', sessionId: 's1' },
  's1|10110': { kind: 'dead', sessionId: 's1' },
  's1|10111': { kind: 'dead', sessionId: 's1' },
  // ── sessionId='s1'，dead=1 respawning=1：respawning 抑制 dead（T4），按 trace > conversation 规则（8 格）──
  's1|11000': { kind: 'conversation', sessionId: 's1', input: 'composer' },
  's1|11001': { kind: 'conversation', sessionId: 's1', input: 'composer' },
  's1|11010': { kind: 'conversation', sessionId: 's1', input: 'ask-user' },
  's1|11011': { kind: 'conversation', sessionId: 's1', input: 'ask-user' },
  's1|11100': { kind: 'trace', sessionId: 's1', input: 'composer' },
  's1|11101': { kind: 'trace', sessionId: 's1', input: 'composer' },
  's1|11110': { kind: 'trace', sessionId: 's1', input: 'ask-user' },
  's1|11111': { kind: 'trace', sessionId: 's1', input: 'ask-user' },
  // ── sessionId='s1'，dead=0 respawning=0：trace 次优先（吞掉 flow；input 按 hasAskUserRequest
  //    互斥，trace 保留输入面 = session-trace 契约「composer 保留，不打断对话能力」，2^2 = 4 格）──
  's1|00100': { kind: 'trace', sessionId: 's1', input: 'composer' },
  's1|00101': { kind: 'trace', sessionId: 's1', input: 'composer' },
  's1|00110': { kind: 'trace', sessionId: 's1', input: 'ask-user' },
  's1|00111': { kind: 'trace', sessionId: 's1', input: 'ask-user' },
  // ── conversation：sessionId 非空即成立，input 由 hasAskUserRequest 互斥决定（2^2 = 4 格）──
  's1|00000': { kind: 'conversation', sessionId: 's1', input: 'composer' },
  's1|00001': { kind: 'conversation', sessionId: 's1', input: 'composer' },
  's1|00010': { kind: 'conversation', sessionId: 's1', input: 'ask-user' },
  's1|00011': { kind: 'conversation', sessionId: 's1', input: 'ask-user' },
  // ── sessionId='s1'，dead=0 respawning=1：respawning 无死可抑制（no-op），结果同上 8 格 ──
  's1|01100': { kind: 'trace', sessionId: 's1', input: 'composer' },
  's1|01101': { kind: 'trace', sessionId: 's1', input: 'composer' },
  's1|01110': { kind: 'trace', sessionId: 's1', input: 'ask-user' },
  's1|01111': { kind: 'trace', sessionId: 's1', input: 'ask-user' },
  's1|01000': { kind: 'conversation', sessionId: 's1', input: 'composer' },
  's1|01001': { kind: 'conversation', sessionId: 's1', input: 'composer' },
  's1|01010': { kind: 'conversation', sessionId: 's1', input: 'ask-user' },
  's1|01011': { kind: 'conversation', sessionId: 's1', input: 'ask-user' },
  // ── sessionId=null：dead/respawning/trace/ask 前置约束不成立，仅 isFlowActive 分流（2^4 = 16 格）──
  'null|00000': { kind: 'empty', sessionId: null },
  'null|00001': { kind: 'landing' },
  'null|00010': { kind: 'empty', sessionId: null },
  'null|00011': { kind: 'landing' },
  'null|00100': { kind: 'empty', sessionId: null },
  'null|00101': { kind: 'landing' },
  'null|00110': { kind: 'empty', sessionId: null },
  'null|00111': { kind: 'landing' },
  'null|01000': { kind: 'empty', sessionId: null },
  'null|01001': { kind: 'landing' },
  'null|01010': { kind: 'empty', sessionId: null },
  'null|01011': { kind: 'landing' },
  'null|01100': { kind: 'empty', sessionId: null },
  'null|01101': { kind: 'landing' },
  'null|01110': { kind: 'empty', sessionId: null },
  'null|01111': { kind: 'landing' },
  'null|10000': { kind: 'empty', sessionId: null },
  'null|10001': { kind: 'landing' },
  'null|10010': { kind: 'empty', sessionId: null },
  'null|10011': { kind: 'landing' },
  'null|10100': { kind: 'empty', sessionId: null },
  'null|10101': { kind: 'landing' },
  'null|10110': { kind: 'empty', sessionId: null },
  'null|10111': { kind: 'landing' },
  'null|11000': { kind: 'empty', sessionId: null },
  'null|11001': { kind: 'landing' },
  'null|11010': { kind: 'empty', sessionId: null },
  'null|11011': { kind: 'landing' },
  'null|11100': { kind: 'empty', sessionId: null },
  'null|11101': { kind: 'landing' },
  'null|11110': { kind: 'empty', sessionId: null },
  'null|11111': { kind: 'landing' },
}

const SESSION_IDS: readonly (string | null)[] = ['s1', null]
const BOOLS: readonly boolean[] = [true, false]

describe('derivePanelView 全组合表（2^7 = 128）', () => {
  it('期望表恰 64 条目（6 个有效维度 2^6；hasMessages 不进 key，防表缺项/多项）', () => {
    expect(Object.keys(EXPECTED)).toHaveLength(64)
  })

  it('128 组合逐一断言（同 key 在两个 hasMessages 值下各断言一次）', () => {
    let count = 0
    for (const sessionId of SESSION_IDS) {
      for (const hasMessages of BOOLS) {
        for (const isSessionDead of BOOLS) {
          for (const isSessionRespawning of BOOLS) {
            for (const isTraceView of BOOLS) {
              for (const hasAskUserRequest of BOOLS) {
                for (const isFlowActive of BOOLS) {
                  const key = `${sessionId ?? 'null'}|${isSessionDead ? '1' : '0'}${isSessionRespawning ? '1' : '0'}${isTraceView ? '1' : '0'}${hasAskUserRequest ? '1' : '0'}${isFlowActive ? '1' : '0'}`
                  const expected = EXPECTED[key]
                  expect(expected, `期望表缺项: key=${key}`).toBeDefined()
                  const actual = derivePanelView({
                    sessionId,
                    hasMessages,
                    isSessionDead,
                    isSessionRespawning,
                    isTraceView,
                    hasAskUserRequest,
                    isFlowActive,
                  })
                  expect(
                    actual,
                    `组合 key=${key} hasMessages=${hasMessages} 派生不符`,
                  ).toEqual(expected)
                  count++
                }
              }
            }
          }
        }
      }
    }
    expect(count, '迭代数必须恰为 128（循环维度写错在此暴露）').toBe(128)
  })
})

describe('回归用例（V5 指定三项 + trace 输入面专项 + T4 respawning 抑制）', () => {
  it('① 有消息 + isFlowActive → conversation（landing 不可表达，§2.2 根因症状核心回归）', () => {
    // 为什么：现行判据 isLandingView = !sessionId || flow.state==='landing'——flow 单例卡
    // landing 时，有消息会话的 landing 判据仍成立，turn 结束瞬间（isSessionActive 翻 false）
    // composer 消失（用户报告症状）。终态规则下 landing 仅在 !sessionId 成立，此处刻意喂
    // isFlowActive=true 模拟残留，断言派生结果无视它（G2 结构免疫的机器守卫）。
    const view = derivePanelView({
      sessionId: 's1',
      hasMessages: true,
      isSessionDead: false,
      isSessionRespawning: false,
      isTraceView: false,
      hasAskUserRequest: false,
      isFlowActive: true,
    })
    expect(view).toEqual({ kind: 'conversation', sessionId: 's1', input: 'composer' })
  })

  it('② dead + hasAskUserRequest → dead（dead 优先级吞掉 ask-user）', () => {
    // 为什么：W6「dead 不应答」——ask-user 渲染 ⟺ (conversation || trace) && input==='ask-user'
    // （设计 D5），进程已死的会话即便 ask-user 请求仍 pending，也必须落 dead 占位视图
    // 而非渲染应答 overlay。若此处返回含 input 的 conversation，即优先级回归。
    const view = derivePanelView({
      sessionId: 's1',
      hasMessages: true,
      isSessionDead: true,
      isSessionRespawning: false,
      isTraceView: false,
      hasAskUserRequest: true,
      isFlowActive: false,
    })
    expect(view).toEqual({ kind: 'dead', sessionId: 's1' })
  })

  it('③ 无消息的绑定会话 → conversation，input 由 hasAskUserRequest 决定（吸收现行空对话态）', () => {
    // 为什么：现行「已绑空 session 走空对话态 + band composer 供直输」（Panel.vue
    // !isSessionActive && sessionId 兜底文案分支）与「turn 活跃 + 无消息 → 空白」边界组合
    // （§5 待验证检查点）都被 conversation 分支吸收：消息有无不改变 kind，只影响
    // conversation 内部子视图（MessageStream vs 空对话态）——渲染层 switch 的事。
    const composer = derivePanelView({
      sessionId: 's1',
      hasMessages: false,
      isSessionDead: false,
      isSessionRespawning: false,
      isTraceView: false,
      hasAskUserRequest: false,
      isFlowActive: false,
    })
    expect(composer).toEqual({ kind: 'conversation', sessionId: 's1', input: 'composer' })

    const askUser = derivePanelView({
      sessionId: 's1',
      hasMessages: false,
      isSessionDead: false,
      isSessionRespawning: false,
      isTraceView: false,
      hasAskUserRequest: true,
      isFlowActive: false,
    })
    expect(askUser).toEqual({ kind: 'conversation', sessionId: 's1', input: 'ask-user' })
  })

  it('④ trace + hasAskUserRequest → trace + input=ask-user（trace 保留输入面，D5/V4 专项）', () => {
    // 为什么：session-trace 契约「composer 保留在底部，不打断对话能力」——Trace 视图
    // 替换的是对话流位置而非输入面，ask-user 请求在 trace 态仍由 overlay 承接应答
    // （D5：ask-user 渲染 ⟺ (conversation || trace) && input==='ask-user'）。
    // 若此处把 ask-user 吞成 composer，即输入面恢复缺口回归（一致性审查 R-U1）。
    const view = derivePanelView({
      sessionId: 's1',
      hasMessages: true,
      isSessionDead: false,
      isSessionRespawning: false,
      isTraceView: true,
      hasAskUserRequest: true,
      isFlowActive: false,
    })
    expect(view).toEqual({ kind: 'trace', sessionId: 's1', input: 'ask-user' })
  })

  it('⑤ dead + respawning → conversation（T4：自动恢复窗口不进终态页，composer 保持）', () => {
    // 为什么：pi 意外退出后 runtime 5s 自动 respawn（crash-resilience D7），恢复窗口内
    // UI 进 dead 终态页会让 composer 卸载 + 恢复提示条永不呈现（Gate B 实测缺陷）。
    // respawning 输入抑制 dead → conversation 形态（对话流 + composer 保持，恢复窗口
    // 发消息经 runtime join 送达）。若此处返回 dead，即终态页提前接管回归。
    const view = derivePanelView({
      sessionId: 's1',
      hasMessages: true,
      isSessionDead: true,
      isSessionRespawning: true,
      isTraceView: false,
      hasAskUserRequest: false,
      isFlowActive: false,
    })
    expect(view).toEqual({ kind: 'conversation', sessionId: 's1', input: 'composer' })
  })
})
