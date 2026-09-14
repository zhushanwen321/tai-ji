/**
 * handleBridgeIntercept 纯映射矩阵单测（git `7a3797d0b` 版 plugin-intercept-injection
 * §3.3-D3/D4，文档已退役于 `fadd8b8b4`，
 * 实施单元 u-i3-bridge-mapping，§5 单元表 I3 行）。
 *
 * 职责边界：本函数为纯映射层——注入形状守卫（非数组整体丢弃/非 string 条目丢弃）
 * 已在管线层逐插件执行（设计 §3.3-D2，HookPipeline.execute），此处输入恒为管线产出的
 * 合法 string[]，测试不喂畸形输入（那是 hook-pipeline 测试的领地）。
 *
 * 映射矩阵（任务验收 4 格 + ERR2 既有行为）：
 * 1. 空注入（未定义字段）→ {injectedMessages:[]}，等价不注入（D5 行「空数组/全部被过滤」）
 * 2. 多条注入 → 每条 string 包一层 {content}，顺序保持（管线累积 priority 执行序）
 * 3. blocked × 无注入 → {blocked:true, reason, injectedMessages:[]}
 * 4. blocked × 有注入 → 注入透传累积（pi 侧「blocked 只 log、注入照常评估」，D2 block
 *    交互定案；plugin-bridge blocked 只 log 分支实装）
 *
 * 运行：cd packages/runtime && npx vitest run src/services/plugin-service/__tests__/bridge-interop-intercept.test.ts
 */
import { describe, it, expect } from 'vitest'
import { handleBridgeIntercept, PI_HOOK_EVENT_MAP } from '../bridge-interop.js'
import type { HookContext, HookResult } from '../plugin-types.js'

const SESSION_ID = 'session-u-i3'

/** 构造恒返回固定 HookResult 的 executeHooks stub（纯映射层无需真实管线）。 */
function stubExecuteHooks(result: HookResult) {
  return async (_hookType: string, _context: HookContext): Promise<HookResult> => result
}

describe('handleBridgeIntercept 注入映射矩阵（设计 §3.3-D3 纯映射）', () => {
  it('空注入：管线未产出 injectedMessages → 空数组回包，无 blocked 键', async () => {
    const res = await handleBridgeIntercept(
      'before_agent_start',
      {},
      SESSION_ID,
      stubExecuteHooks({ blocked: false }),
    )

    expect(res).toEqual({ injectedMessages: [] })
    expect('blocked' in res).toBe(false)
  })

  it('多条注入：每条 string 包一层 {content}，顺序保持管线累积序', async () => {
    const res = await handleBridgeIntercept(
      'before_agent_start',
      {},
      SESSION_ID,
      stubExecuteHooks({ blocked: false, injectedMessages: ['first-token-a', 'second-token-b'] }),
    )

    expect(res).toEqual({
      injectedMessages: [{ content: 'first-token-a' }, { content: 'second-token-b' }],
    })
  })

  it('blocked × 无注入：blocked/reason 正常回包，注入为空数组', async () => {
    const res = await handleBridgeIntercept(
      'before_agent_start',
      {},
      SESSION_ID,
      stubExecuteHooks({ blocked: true, blockedBy: 'plugin-b', reason: 'denied by policy' }),
    )

    expect(res).toEqual({ blocked: true, reason: 'denied by policy', injectedMessages: [] })
  })

  it('blocked × 有注入：管线累积注入透传（blocked 只 log、注入照常评估，D2 block 交互定案）', async () => {
    const res = await handleBridgeIntercept(
      'before_agent_start',
      {},
      SESSION_ID,
      stubExecuteHooks({
        blocked: true,
        blockedBy: 'plugin-b',
        reason: 'denied with a note',
        injectedMessages: ['回复首行包含 TOKEN_B'],
      }),
    )

    expect(res).toEqual({
      blocked: true,
      reason: 'denied with a note',
      injectedMessages: [{ content: '回复首行包含 TOKEN_B' }],
    })
  })

  it('reason 缺失：回落 Blocked by <blockedBy> 兜底（既有行为不回归）', async () => {
    const res = await handleBridgeIntercept(
      'before_agent_start',
      {},
      SESSION_ID,
      stubExecuteHooks({ blocked: true, blockedBy: 'plugin-x' }),
    )

    expect(res.blocked).toBe(true)
    expect(res.reason).toBe('Blocked by plugin-x')
  })
})

describe('handleBridgeIntercept ERR2 协议兼容（G4 通道零回归）', () => {
  it('无映射事件名：不翻译不拦截，恒空注入回包', async () => {
    const res = await handleBridgeIntercept(
      'plugin:statusSetUpdate',
      {},
      SESSION_ID,
      stubExecuteHooks({ blocked: false, injectedMessages: ['should-never-reach-hook'] }),
    )

    expect(res).toEqual({ injectedMessages: [] })
  })

  it('PI_HOOK_EVENT_MAP 中 before_agent_start 仍为 intercept 链路（映射表不因生产端接入漂移）', () => {
    expect(PI_HOOK_EVENT_MAP['before_agent_start']).toEqual({
      hookType: 'onBeforeAgentStart',
      kind: 'intercept',
    })
  })
})
