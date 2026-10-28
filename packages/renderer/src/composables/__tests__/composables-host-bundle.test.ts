/**
 * composables 根域合并产物（round 6 renderer 测试压缩）：六文件同产物，环境统一默认
 * （happy-dom；useBackgroundWork / useInboundFrameGuard / useMemoryPressure 三文件原为
 * node 环境注释，纯 pinia/watch/effectScope 逻辑无 DOM 依赖亦无 node 特有 API，迁移实证
 * 兼容；useSessionMarkers 需 localStorage + window 事件，决定统一环境取 happy-dom）。
 *
 * 并入来源（基名）：
 *  - taiji-themes-swatch-sync（主题 swatch ↔ style.css 对拍，6 例）
 *  - useBackgroundWork（后台工作谓词 + derivedStatus 回归，18 例，原 node）
 *  - useInboundFrameGuard（入站丢帧检查 renderer 消费编排，8 例，原 node）
 *  - useMemoryPressure（内存压力通知消费，8 例，原 node）
 *  - useRollingRestartStatus（滚动重启四态 + #27 轻态，11 例）
 *  - useSessionMarkers（会话标记 localStorage 持久化，20 例）
 *
 * mock 注册与互斥核查：
 *  - useInboundFrameGuard partial mock '@taiji/core'（spread actual 仅覆写三个成员）
 *    + mock '@/lib/ipc'（砍成员：仅 reportRendererLog）——本产物全部节与间接 store 链
 *    （subagent/workflow/chat/panel store、useBackgroundWork、useSessionDerivations、
 *    useMemoryPressure、useSessionMarkers、useSessionScopedState）经 grep 核实零消费
 *    '@/lib/ipc'，砍成员工厂无截断面。
 *  - useRollingRestartStatus mock '@taiji/core/transport/api'（spread 仅覆写 command）
 *    + ws-client（spread 仅覆写 getState）——useMemoryPressure 消费的真 dispatchGlobal、
 *    useBackgroundWork 链不触 command/getState，真成员保留不受截断。
 *  - useSessionMarkers 顶层 beforeEach（localStorage 清空 + cleanup 注册表重置）已下沉进
 *    describe——避免作用于本产物其余节。
 *
 * 运行：cd packages/renderer && TAIJI_SKIP_REAL_PI=1 npx vitest run src/composables/__tests__/composables-host-bundle.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { computed, effect, nextTick, effectScope } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { SUBAGENT_RECORD_CUSTOM_TYPE } from '@taiji/shared'
import type {
  InboundFrameDroppedInfo,
  ReattachDeferredPayload,
  RollingRestartCountdownPayload,
  RollingRestartDeferredPayload,
  RollingRestartForcedPayload,
  RollingRestartStatusPayload,
  ServerMessage,
  SubagentRecord,
  WatchdogMemoryPressurePayload,
  WorkflowRunRecord,
} from '@taiji/shared'
import { dispatchGlobal } from '@taiji/core/transport/api'
import { getLruMaxSessions } from '@taiji/core'
// R3-1④：跨包消费 runtime extractor 真实派生视图产物构造 fixture（见 useBackgroundWork 节注释）
import { scanSubagentEntries } from '../../../../runtime/src/services/session/subagent-extractor.js'
import { useBackgroundWork } from '../features/chat/useBackgroundWork'
import { useSubagentStore } from '@/stores/subagent'
import { useWorkflowStore } from '@/stores/workflow'
import { useChatStore } from '@/stores/chat'
import { ROOT_PANEL_ID, usePanelStore } from '@/stores/panel'
import { triggerSessionCleanups, __clearSessionCleanupRegistryForTest } from '@/composables/useSessionScopedState'
import {
  installInboundFrameGuard,
  uninstallInboundFrameGuard,
  isInboundSessionTripped,
  _resetInboundFrameGuardForTest,
} from '../useInboundFrameGuard'
import {
  useMemoryPressure,
  LRU_RELIEF_MAX_SESSIONS,
  _setMemoryReliefActionForTest,
  _resetMemoryPressureForTest,
} from '../useMemoryPressure'
import {
  RECOVERED_AUTO_CLEAR_MS,
  useRollingRestartStatus,
  _resetRollingRestartStatusForTest,
} from '../useRollingRestartStatus'
import {
  markUnread,
  clearUnread,
  isUnread,
  toggleMarkedDone,
  isMarkedDone,
  clearAll,
  __registerCleanupForTest as __registerMarkersCleanupForTest,
  __resetCacheForTest as __resetMarkersCacheForTest,
} from '../useSessionMarkers'
import { TAIJI_THEMES } from '../useTaijiThemes.js'

// ── useInboundFrameGuard 节的 mock（@taiji/core spread + @/lib/ipc）──

const coreMock = vi.hoisted(() => ({
  onInboundFrameDropped: vi.fn(),
  retryInboundDroppedSession: vi.fn(),
  subscribeSession: vi.fn(),
}))
const reportMock = vi.hoisted(() => vi.fn())

vi.mock('@taiji/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@taiji/core')>()),
  onInboundFrameDropped: coreMock.onInboundFrameDropped,
  retryInboundDroppedSession: coreMock.retryInboundDroppedSession,
  subscribeSession: coreMock.subscribeSession,
}))

vi.mock('@/lib/ipc', () => ({ reportRendererLog: reportMock }))

// ── useRollingRestartStatus 节的 mock（transport/api spread + ws-client spread）──

// 连接态替身：真 Vue ref 经 mock 工厂内创建并挂到 hoisted holder（工厂惰性执行先于测试体；
// 必须是真 ref——composable 的 watch getter 读 .value 需要响应式依赖才会在重连时触发）
const conn = vi.hoisted(() => ({ stateRef: null as null | { value: string } }))

vi.mock('@taiji/core/transport/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/transport/api')>()
  return { ...actual, command: vi.fn() }
})

vi.mock('@taiji/core/transport/ws-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/transport/ws-client')>()
  const { ref } = await import('vue')
  conn.stateRef = ref('connected')
  return { ...actual, getState: () => conn.stateRef! }
})

// mock 工厂就位后取 command 替身（类型层是真实签名，运行时是 vi.fn）
const commandMock = vi.mocked(await import('@taiji/core/transport/api').then((m) => m.command))

// ─────────────────────────────────────────────────────────────────────────────
// 来源节：taiji-themes-swatch-sync（顶层读 style.css 保持原时序；产物与原文件同目录，
// '../../style.css' 相对路径不变）
// ─────────────────────────────────────────────────────────────────────────────

const styleCss = readFileSync(
  resolve(import.meta.dirname, '../../style.css'),
  'utf-8',
).replace(/\/\*[\s\S]*?\*\//g, '')

function parseBlockVars(selector: string): Record<string, string> {
  const idx = styleCss.indexOf(selector)
  expect(idx, `style.css 未找到选择器块：${selector}`).toBeGreaterThanOrEqual(0)
  const open = styleCss.indexOf('{', idx)
  const close = styleCss.indexOf('}', open)
  const vars: Record<string, string> = {}
  for (const m of styleCss.slice(open + 1, close).matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g)) {
    vars[m[1]] = m[2].trim()
  }
  return vars
}

/** swatch 顺序 = [accent, fg, surface, bg]，与 demo chip 四色条同序 */
const SWATCH_TOKENS = ['--accent', '--neutral-fg', '--surface', '--bg'] as const

/** 各主题的 style.css 级联链（与 contrast-tokens.test.ts 同口径）；键 = theme:preset
 *  （皓白/玄青的 preset 都是空串，单靠 preset 区分不出亮色默认） */
const THEME_CHAIN: Record<string, string[]> = {
  'dark:': [':root'],
  'dark:dailan': [':root', ':root[data-theme-preset="dailan"]'],
  'dark:nuanmo': [':root', ':root[data-theme-preset="nuanmo"]'],
  'light:': [':root', '[data-theme="light"]'],
  'light:qingmo': [':root', '[data-theme="light"]', '[data-theme="light"][data-theme-preset="qingmo"]'],
  'light:zhuyin': [':root', '[data-theme="light"]', '[data-theme="light"][data-theme-preset="zhuyin"]'],
}

describe('主题行 swatch 快照 ↔ style.css 对拍（改 token 必同批同步 useTaijiThemes）', () => {
  for (const theme of TAIJI_THEMES) {
    it(`${theme.shortName}：swatch 四色与 style.css 现值一致`, () => {
      const merged: Record<string, string> = {}
      const chain = THEME_CHAIN[`${theme.theme}:${theme.preset}`]
      expect(chain, `主题 ${theme.shortName} 缺级联链登记`).toBeDefined()
      for (const selector of chain) Object.assign(merged, parseBlockVars(selector))
      expect(theme.swatch, `${theme.shortName} swatch 应为四色 [accent, fg, surface, bg]`).toHaveLength(4)
      theme.swatch.forEach((hex, i) => {
        const tokenName = SWATCH_TOKENS[i]
        const tokenValue = merged[tokenName]?.toLowerCase()
        expect(tokenValue, `token ${tokenName} 应为 hex 字面值`).toMatch(/^#[0-9a-fA-F]{6}$/)
        expect(
          hex.toLowerCase(),
          `${theme.shortName} swatch[${i}]（${tokenName}）与 style.css 漂移：swatch ${hex} vs token ${tokenValue}`,
        ).toBe(tokenValue)
      })
    })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 来源节：useBackgroundWork（原 node 环境文件）
// ─────────────────────────────────────────────────────────────────────────────

/** 构造最小合法 SubagentRecord（仅必填字段）。 */
function makeSubagent(overrides: Partial<SubagentRecord>): SubagentRecord {
  return {
    subagentId: 'sub-1',
    sessionFile: null,
    agent: 'general-purpose',
    slug: 'worker',
    task: 'do something',
    status: 'running',
    ...overrides,
  }
}

/** 构造最小合法 WorkflowRunRecord（仅必填字段）。 */
function makeWorkflow(overrides: Partial<WorkflowRunRecord>): WorkflowRunRecord {
  return {
    runId: 'wf-1',
    scriptName: 'review',
    status: 'running',
    startedAt: '2026-07-01T00:00:00.000Z',
    agentCalls: [],
    stateFilePath: '/tmp/state.json',
    ...overrides,
  }
}

/**
 * 测试种数据：applyRecords 已从 workflow store 导出清单摘除（生产零直写场景），测试经
 * 分区 ref 直写——不可变替换整 Map（与 partition.apply 等价）触发 shallowRef 响应性。
 */
function seedRecords(
  store: ReturnType<typeof useWorkflowStore>,
  sid: string,
  records: WorkflowRunRecord[],
): void {
  store.recordsBySession = new Map(store.recordsBySession).set(sid, records)
}

describe('useBackgroundWork', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('TC1: subagent running → true', () => {
    const sub = useSubagentStore()
    sub.applyRecords('s1', [makeSubagent({ status: 'running' })])
    const { hasBackgroundWork } = useBackgroundWork()
    expect(hasBackgroundWork('s1')).toBe(true)
  })

  // [review findings-confirmation #8] TC1b：running-resumable（轮终回写 running + result）
  // 不是后台真在跑——v4 轮终迁移故意回写 running（可冷路径 resume），result 有值即轮终信号。
  // 不排除会致 derivedStatus 恒 working → 末位 turn 永久「工作中」。
  it('[U6] TC1b: subagent 轮终形态（idle + result + completed）→ false', () => {
    const sub = useSubagentStore()
    // [U6] renderer 实收轮终形态（U4 翻边 + runtime 归一后）——status 子句直接排除
    sub.applyRecords('s1', [makeSubagent({ status: 'idle', result: '本轮产出', stopReason: 'completed' })])
    const { hasBackgroundWork } = useBackgroundWork()
    expect(hasBackgroundWork('s1')).toBe(false)
  })

  // TC1c：混跑场景——一个轮终 resumable + 一个真在跑（首轮无 result）→ 仍算 working
  it('TC1c: 轮终 resumable + 首轮真在跑混合 → true（任一真在跑即 working）', () => {
    const sub = useSubagentStore()
    sub.applyRecords('s1', [
      makeSubagent({ subagentId: 'sub-idle', status: 'running', result: 'done text' }),
      makeSubagent({ subagentId: 'sub-live', status: 'running' }),
    ])
    const { hasBackgroundWork } = useBackgroundWork()
    expect(hasBackgroundWork('s1')).toBe(true)
  })

  it('TC2: workflow running → true', () => {
    const wf = useWorkflowStore()
    seedRecords(wf, 's1', [makeWorkflow({ status: 'running' })])
    const { hasBackgroundWork } = useBackgroundWork()
    expect(hasBackgroundWork('s1')).toBe(true)
  })

  it('TC3: workflow running → true（运行中的 run 算未完成）', () => {
    const wf = useWorkflowStore()
    seedRecords(wf, 's1', [makeWorkflow({ status: 'running' })])
    const { hasBackgroundWork } = useBackgroundWork()
    expect(hasBackgroundWork('s1')).toBe(true)
  })

  it('TC4: 全 done（subagent done + workflow done）→ false', () => {
    const sub = useSubagentStore()
    const wf = useWorkflowStore()
    sub.applyRecords('s1', [makeSubagent({ status: 'done' })])
    seedRecords(wf, 's1', [makeWorkflow({ status: 'done' })])
    const { hasBackgroundWork } = useBackgroundWork()
    expect(hasBackgroundWork('s1')).toBe(false)
  })

  it('TC5: subagent 其它终态（failed/cancelled/crashed）+ workflow done → false', () => {
    const sub = useSubagentStore()
    const wf = useWorkflowStore()
    sub.applyRecords('s1', [makeSubagent({ status: 'failed' })])
    seedRecords(wf, 's1', [makeWorkflow({ status: 'done' })])
    const { hasBackgroundWork } = useBackgroundWork()
    expect(hasBackgroundWork('s1')).toBe(false)
  })

  it('TC5b: 无任何 records（未访问 session）→ false', () => {
    const { hasBackgroundWork } = useBackgroundWork()
    expect(hasBackgroundWork('never-seen')).toBe(false)
  })

  it('TC5c: 混合 —— subagent done 但 workflow running → true（聚合 OR 语义）', () => {
    const sub = useSubagentStore()
    const wf = useWorkflowStore()
    sub.applyRecords('s1', [makeSubagent({ status: 'done' })])
    seedRecords(wf, 's1', [makeWorkflow({ status: 'running' })])
    const { hasBackgroundWork } = useBackgroundWork()
    expect(hasBackgroundWork('s1')).toBe(true)
  })

  // H2 W1（record-unification D1③）：workflow 脚本派发的 subagent（origin='workflow'）
  // 不算本 session 的后台工作——其生命周期由 workflow run 承载，混入会让主 session
  // 在 workflow 运行期间被误判 working（列表恒亮「工作中」）。
  it('W1: 仅 workflow origin 的 subagent running → false（不被 workflow 派发 record 绑架）', () => {
    const sub = useSubagentStore()
    sub.applyRecords('s1', [
      makeSubagent({ subagentId: 'sub-wf-1', status: 'running', origin: 'workflow' }),
      makeSubagent({ subagentId: 'sub-wf-2', status: 'running', origin: 'workflow' }),
    ])
    const { hasBackgroundWork } = useBackgroundWork()
    expect(hasBackgroundWork('s1')).toBe(false)
  })

  it('W1: workflow origin + 手动 tool running 混合 → true（tool record 判定不受影响）', () => {
    const sub = useSubagentStore()
    sub.applyRecords('s1', [
      makeSubagent({ subagentId: 'sub-wf-1', status: 'running', origin: 'workflow' }),
      makeSubagent({ subagentId: 'sub-tool-1', status: 'running' }),
    ])
    const { hasBackgroundWork } = useBackgroundWork()
    expect(hasBackgroundWork('s1')).toBe(true)
  })

  it('W1: origin 缺省（存量 record，undefined = tool 语义）仍参与判定（零迁移保障）', () => {
    const sub = useSubagentStore()
    sub.applyRecords('s1', [makeSubagent({ subagentId: 'sub-legacy', status: 'running' })])
    const { hasBackgroundWork } = useBackgroundWork()
    expect(hasBackgroundWork('s1')).toBe(true)
  })
})

// R3-1④（H2 阶段 3 一致性审查修复）：fixture 源 = runtime extractor 真实派生视图。
// 上方 W1 用例手工拼 origin 只验证谓词本身；runtime 派生视图白名单断链时它们照样绿。
// 本组用例经 scanSubagentEntries 从自描述 entry 派生——白名单删 origin → 派生视图断言
// undefined → hasBackgroundWork 判定断言同步转红（红锚联动）。
describe('useBackgroundWork × runtime extractor 真实派生视图产物（R3-1④）', () => {
  /** 自描述 subagent-record entry 构造（pi JSONL 持久化形态 = runtime extractor 输入）。 */
  /** 登记 §3.3：条目范围 = v2 族（注册条定身份、终态条定终局）。 */
  function recordEntry(
    id: string,
    extra: { origin?: string; result?: string; status?: 'running' | 'idle' } = {},
  ): Array<Record<string, unknown>> {
    const wrap = (data: Record<string, unknown>, entryId: string): Record<string, unknown> => ({
      type: 'custom', customType: SUBAGENT_RECORD_CUSTOM_TYPE, id: entryId, parentId: null, data,
    })
    const registeredData: Record<string, unknown> = {
      v: 2, kind: 'registered', id, agent: 'worker', task: 't', slug: 's',
      rootSessionId: 's-proj', depth: 0, startedAt: 1000,
    }
    // origin 缺省 = 存量 record 语义（派生视图侧归一 undefined）——fixture 不代填默认值
    if (extra.origin !== undefined) registeredData.origin = extra.origin
    const registered = wrap(registeredData, `${id}-r`)
    if (extra.status === 'idle') {
      return [registered, wrap({
        v: 2, kind: 'settled', id, status: 'idle', stopReason: 'completed', endedAt: 2000,
        turns: 1, totalTokens: 1, model: undefined, thinkingLevel: undefined,
        ...(extra.result !== undefined ? { result: extra.result } : {}),
      }, `${id}-s`)]
    }
    return [registered]
  }

  it('派生视图透传 + 判定：extractor 产出的 workflow record 不绑架 hasBackgroundWork（派生视图白名单删 origin 即红）', () => {
    const records = scanSubagentEntries([
      ...recordEntry('sub-proj-wf', { origin: 'workflow' }),
      ...recordEntry('sub-proj-wf-idle', { origin: 'workflow', result: '轮终产出' }),
    ])
    // fixture 源证明：origin 由 runtime 派生视图产出，非手工拼装
    expect(records.find((r) => r.subagentId === 'sub-proj-wf')?.origin).toBe('workflow')

    const sub = useSubagentStore()
    sub.applyRecords('s-proj', records)
    const { hasBackgroundWork } = useBackgroundWork()
    expect(hasBackgroundWork('s-proj')).toBe(false)
  })

  it('零迁移：extractor 缺省派生视图（存量 record，origin undefined）仍判定为后台工作', () => {
    const records = scanSubagentEntries([...recordEntry('sub-proj-legacy')])
    expect(records[0]?.origin).toBeUndefined()

    const sub = useSubagentStore()
    sub.applyRecords('s-proj-legacy', records)
    const { hasBackgroundWork } = useBackgroundWork()
    expect(hasBackgroundWork('s-proj-legacy')).toBe(true)
  })
})

/**
 * TC9：deriveStatus working 态回归（集成）。
 * 验证 useSessionDerivations 重构后（内联判定 → useBackgroundWork）derivedStatus 行为不变：
 * subagent running → working；全部回落 done 后 → done。
 *
 * 用真实 subagent store + applyRecords 注入数据；invalidateStatusCache 清模块级缓存，
 * 避免 computed 持有上个 pinia 实例的旧 store 闭包（对齐 derive-status-ask-user.test.ts 模式）。
 */
describe('TC9: useSessionDerivations.derivedStatus working 态回归（useBackgroundWork 接入）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('subagent running → derivedStatus = working；subagent done 后回落 done', async () => {
    const { useSessionDerivations, invalidateStatusCache } = await import(
      '@/composables/features/chat/useSessionDerivations'
    )
    invalidateStatusCache()

    const { derivedStatus } = useSessionDerivations()
    const sub = useSubagentStore()
    const sessionId = 's-tc9'

    // 初始：未 hydrate + 非活跃 + 无 background → done
    expect(derivedStatus(sessionId).value).toBe('done')

    // 注入 subagent running → working（hasBackgroundWork=true）
    sub.applyRecords(sessionId, [makeSubagent({ subagentId: 'sub-tc9', status: 'running' })])
    expect(derivedStatus(sessionId).value).toBe('working')

    // subagent 全 done → 回落 done（响应式：computed 重算）
    sub.applyRecords(sessionId, [makeSubagent({ subagentId: 'sub-tc9', status: 'done' })])
    expect(derivedStatus(sessionId).value).toBe('done')
  })

  // [review findings-confirmation #8] TC9b：subagent 轮终（record 有 result 仍 running，
  // v4 running-resumable 设计）→ derivedStatus 不再 working（回 done）→ sessionActive
  // false → isWorkingTurn false。这是「完成注入后末位 turn 永久工作中」的核心回归：
  // live 期行为对齐重开后（record=closed → done）。
  it('[U6] subagent 轮终（idle + result + completed）→ derivedStatus = done（非 working）；真在跑（无 result）→ working', async () => {
    const { useSessionDerivations, invalidateStatusCache } = await import(
      '@/composables/features/chat/useSessionDerivations'
    )
    invalidateStatusCache()

    const { derivedStatus } = useSessionDerivations()
    const sub = useSubagentStore()
    const sessionId = 's-tc9c'

    // 真在跑（首轮，无轮终信号）→ working
    sub.applyRecords(sessionId, [makeSubagent({ subagentId: 'sub-tc9c', status: 'running' })])
    expect(derivedStatus(sessionId).value).toBe('working')

    // 轮终（[U6] 实收形态 idle + result + completed）→ 不算 working，回落 done
    sub.applyRecords(sessionId, [makeSubagent({ subagentId: 'sub-tc9c', status: 'idle', result: '本轮产出', stopReason: 'completed' })])
    expect(derivedStatus(sessionId).value).toBe('done')
  })

  // [H2 W1] 仅 workflow origin 的 subagent running → derivedStatus 不进 working
  //（用户可见行为：session 列表不亮「工作中」——workflow 派发 record 由 run 视图承载）。
  it('W1: 仅 workflow origin subagent running → derivedStatus = done（非 working）', async () => {
    const { useSessionDerivations, invalidateStatusCache } = await import(
      '@/composables/features/chat/useSessionDerivations'
    )
    invalidateStatusCache()

    const { derivedStatus } = useSessionDerivations()
    const sub = useSubagentStore()
    const sessionId = 's-wf-only'

    sub.applyRecords(sessionId, [
      makeSubagent({ subagentId: 'sub-wf-only', status: 'running', origin: 'workflow' }),
    ])
    expect(derivedStatus(sessionId).value).toBe('done')
  })

  it('workflow running → derivedStatus = working（运行中算 background work）', async () => {
    const { useSessionDerivations, invalidateStatusCache } = await import(
      '@/composables/features/chat/useSessionDerivations'
    )
    invalidateStatusCache()

    const { derivedStatus } = useSessionDerivations()
    const wf = useWorkflowStore()
    const sessionId = 's-tc9b'

    // workflow running → working（hasBackgroundWork=true）
    seedRecords(wf, sessionId, [makeWorkflow({ runId: 'wf-tc9b', status: 'running' })])
    expect(derivedStatus(sessionId).value).toBe('working')

    // workflow done → 回落 done
    seedRecords(wf, sessionId, [makeWorkflow({ runId: 'wf-tc9b', status: 'done' })])
    expect(derivedStatus(sessionId).value).toBe('done')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 来源节：useInboundFrameGuard（原 node 环境文件）
// ─────────────────────────────────────────────────────────────────────────────

/** 捕获 core 侧注册的丢帧回调（install 时绑定，卸载后置 null）。 */
let dropCallback: ((info: InboundFrameDroppedInfo) => void) | null = null

function makeDrop(overrides: Partial<InboundFrameDroppedInfo> = {}): InboundFrameDroppedInfo {
  return {
    sessionId: 's1',
    frameSize: 42_000_001,
    kind: 'text',
    valveTripped: false,
    sessionDropCount: 1,
    ...overrides,
  }
}

describe('useInboundFrameGuard 入站检查 renderer 消费编排（D8 / A6）', () => {
  let panel: ReturnType<typeof usePanelStore>

  /** 模拟 core 侧处理完一帧后的回调通知（valveTripped 由 core 判定）。 */
  function fireDrop(overrides: Partial<InboundFrameDroppedInfo> = {}): void {
    expect(dropCallback, 'installInboundFrameGuard 应先绑定 onInboundFrameDropped').toBeTypeOf('function')
    dropCallback?.(makeDrop(overrides))
  }

  beforeEach(() => {
    _resetInboundFrameGuardForTest()
    dropCallback = null
    coreMock.onInboundFrameDropped.mockReset()
    coreMock.retryInboundDroppedSession.mockReset().mockReturnValue(false)
    coreMock.subscribeSession.mockReset().mockResolvedValue(undefined)
    reportMock.mockReset()
    coreMock.onInboundFrameDropped.mockImplementation((cb: (info: InboundFrameDroppedInfo) => void) => {
      dropCallback = cb
      return () => {
        if (dropCallback === cb) dropCallback = null
      }
    })
    setActivePinia(createPinia())
    panel = usePanelStore()
  })

  afterEach(() => {
    _resetInboundFrameGuardForTest()
  })

  it('每次丢帧都上报（含无法归因形态）——A6 登记清单 ×4 计数的 renderer 侧源头', () => {
    installInboundFrameGuard()

    // 4 次丢弃：1-3 为同 session 连续（第 3 次 trip），第 4 次继续上报
    for (let i = 1; i <= 4; i++) {
      fireDrop({ sessionDropCount: i, valveTripped: i === 3 })
    }
    // 无法归因（binary 帧 / 头部无锚）：仍然上报（sessionId 字段省略，不落 null）
    fireDrop({ sessionId: null, kind: 'binary', frameSize: 9_000_000, sessionDropCount: 0 })

    expect(reportMock).toHaveBeenCalledTimes(5)
    expect(reportMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        source: 'inbound-frame-dropped',
        sessionId: 's1',
        message: expect.stringContaining('42000001 code units'),
      }),
    )
    const unattributed = reportMock.mock.calls[4][0] as { sessionId?: string; message: string }
    expect(unattributed.sessionId).toBeUndefined()
    expect(unattributed.message).toContain('9000000 bytes')
  })

  it('valveTripped 才置静态提示态，且单 session 作用域（其余 session 不连坐）', () => {
    installInboundFrameGuard()

    fireDrop({ sessionDropCount: 1, valveTripped: false })
    expect(isInboundSessionTripped('s1')).toBe(false) // 未到阈值：无提示

    fireDrop({ sessionId: 's1', sessionDropCount: 3, valveTripped: true })
    expect(isInboundSessionTripped('s1')).toBe(true)
    expect(isInboundSessionTripped('s2')).toBe(false) // 不连坐

    // 无法归因的 trip（sessionId=null，真实形态不会发生）不产生任何 session 提示态
    fireDrop({ sessionId: null, sessionDropCount: 0, valveTripped: true })
    expect(isInboundSessionTripped('s1')).toBe(true)
  })

  it('切走再切回 tripped session → 解除暂停 + 重试订阅恰好一次，提示态清除', async () => {
    installInboundFrameGuard()
    coreMock.retryInboundDroppedSession.mockReturnValue(true)
    panel.loadSession(ROOT_PANEL_ID, 's1') // 用户正停在 s1
    await nextTick()

    fireDrop({ sessionDropCount: 3, valveTripped: true }) // s1 触发终止阀（切焦点才触发恢复）
    expect(isInboundSessionTripped('s1')).toBe(true)
    expect(coreMock.retryInboundDroppedSession).not.toHaveBeenCalled()

    panel.loadSession(ROOT_PANEL_ID, 's2') // 切走（非 tripped：零动作）
    await nextTick()
    expect(coreMock.retryInboundDroppedSession).not.toHaveBeenCalled()
    expect(coreMock.subscribeSession).not.toHaveBeenCalled()

    panel.loadSession(ROOT_PANEL_ID, 's1') // 切回（恢复触发器命中）
    await nextTick()
    expect(coreMock.retryInboundDroppedSession).toHaveBeenCalledTimes(1)
    expect(coreMock.retryInboundDroppedSession).toHaveBeenCalledWith('s1')
    expect(coreMock.subscribeSession).toHaveBeenCalledTimes(1) // 重试订阅一次
    expect(coreMock.subscribeSession).toHaveBeenCalledWith('s1')
    expect(isInboundSessionTripped('s1')).toBe(false) // 提示态随恢复动作清除

    // 原地不动（cur === prev）不重复触发
    panel.loadSession(ROOT_PANEL_ID, 's1')
    await nextTick()
    expect(coreMock.subscribeSession).toHaveBeenCalledTimes(1)
  })

  it('trip 后首次进入该 session 亦触发一次（从宽语义）', async () => {
    installInboundFrameGuard()
    coreMock.retryInboundDroppedSession.mockReturnValue(true)
    fireDrop({ sessionDropCount: 3, valveTripped: true })

    panel.loadSession(ROOT_PANEL_ID, 's1') // null → s1 = 切入动作
    await nextTick()
    expect(coreMock.retryInboundDroppedSession).toHaveBeenCalledWith('s1')
    expect(coreMock.subscribeSession).toHaveBeenCalledWith('s1')
    expect(isInboundSessionTripped('s1')).toBe(false)
  })

  it('retry 返回 false（core 侧非 tripped 残留防御）→ 不重试订阅、提示态保留，下次用户动作可再试', async () => {
    installInboundFrameGuard()
    panel.loadSession(ROOT_PANEL_ID, 's1')
    await nextTick()
    fireDrop({ sessionDropCount: 3, valveTripped: true })

    coreMock.retryInboundDroppedSession.mockReturnValue(false) // 例：core 阀门已因其他路径归零
    panel.loadSession(ROOT_PANEL_ID, 's2')
    await nextTick()
    panel.loadSession(ROOT_PANEL_ID, 's1')
    await nextTick()

    expect(coreMock.retryInboundDroppedSession).toHaveBeenCalledWith('s1')
    expect(coreMock.subscribeSession).not.toHaveBeenCalled() // 未解除：不发重试订阅
    expect(isInboundSessionTripped('s1')).toBe(true) // 提示态保留

    // 恢复动作未被这次失败烧掉：下一次切换重试成功即清除
    coreMock.retryInboundDroppedSession.mockReturnValue(true)
    panel.loadSession(ROOT_PANEL_ID, 's2')
    await nextTick()
    panel.loadSession(ROOT_PANEL_ID, 's1')
    await nextTick()
    expect(coreMock.subscribeSession).toHaveBeenCalledTimes(1)
    expect(isInboundSessionTripped('s1')).toBe(false)
  })

  it('[RD-1#7] session 销毁（triggerSessionCleanups）→ tripped 派生视图按 sid 回收，不连坐其他 session', () => {
    installInboundFrameGuard()
    fireDrop({ sessionId: 's1', sessionDropCount: 3, valveTripped: true })
    fireDrop({ sessionId: 's2', sessionDropCount: 3, valveTripped: true })
    expect(isInboundSessionTripped('s1')).toBe(true)
    expect(isInboundSessionTripped('s2')).toBe(true)

    // useSidebar.deleteSession 编排：session 销毁 → triggerSessionCleanups(sid)
    triggerSessionCleanups('s1')

    // 已删 session 的静态提示态回收（未注册 cleanup 时该集合只增不清）
    expect(isInboundSessionTripped('s1')).toBe(false)
    expect(isInboundSessionTripped('s2')).toBe(true) // 不连坐
  })

  it('[RD-1#7] uninstall → 派生视图集整体清空 + 反注册 session cleanup（teardown 配对）', () => {
    installInboundFrameGuard()
    fireDrop({ sessionId: 's1', sessionDropCount: 3, valveTripped: true })
    expect(isInboundSessionTripped('s1')).toBe(true)

    uninstallInboundFrameGuard()
    // 残留 tripped 态会在重新 install 后表现为「未丢帧却显示静态提示」的假阳性
    expect(isInboundSessionTripped('s1')).toBe(false)

    // 重新 install 后链路仍可用（幂等标志 + cleanup 注册均复位）
    installInboundFrameGuard()
    fireDrop({ sessionId: 's1', sessionDropCount: 3, valveTripped: true })
    expect(isInboundSessionTripped('s1')).toBe(true)
    triggerSessionCleanups('s1')
    expect(isInboundSessionTripped('s1')).toBe(false)
  })

  it('install 幂等；uninstall 解绑 core 监听与 focus watch（teardown 配对）', async () => {
    installInboundFrameGuard()
    installInboundFrameGuard()
    expect(coreMock.onInboundFrameDropped).toHaveBeenCalledTimes(1) // 幂等：只注册一次

    uninstallInboundFrameGuard()
    expect(dropCallback).toBeNull() // core 侧监听已解绑
    panel.loadSession(ROOT_PANEL_ID, 's1')
    await nextTick()
    expect(coreMock.retryInboundDroppedSession).not.toHaveBeenCalled() // watch 已停
    // 重新安装仍可用（幂等标志复位）
    installInboundFrameGuard()
    expect(coreMock.onInboundFrameDropped).toHaveBeenCalledTimes(2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 来源节：useMemoryPressure（原 node 环境文件）
// ─────────────────────────────────────────────────────────────────────────────

/** 构造 watchdog:memoryPressure 帧（payload 契约 = WatchdogMemoryPressurePayload）。 */
function pressureMsg(
  level: 'warn' | 'critical',
  overrides: Partial<WatchdogMemoryPressurePayload> = {},
): ServerMessage<'watchdog:memoryPressure'> {
  return {
    type: 'watchdog:memoryPressure',
    payload: {
      level,
      heapUsed: 700_000_000,
      heapSizeLimit: 1_000_000_000,
      usedPercent: 70,
      warnPercent: 70,
      criticalPercent: 85,
      ...overrides,
    },
  }
}

describe('useMemoryPressure（A5 通知消费断言）', () => {
  beforeEach(() => {
    _resetMemoryPressureForTest()
    setActivePinia(createPinia())
  })

  afterEach(() => {
    // 复位 spy 注入 + 状态 + 强制退订（refCount/订阅表清零，测试间隔离）
    _resetMemoryPressureForTest()
  })

  it('warn 通知到达 → level 更新 + 收紧动作被调用（level/payload 透传）', () => {
    const action = vi.fn()
    _setMemoryReliefActionForTest(action)
    const scope = effectScope()
    const state = scope.run(() => useMemoryPressure())
    expect(state?.level.value).toBe('normal')
    dispatchGlobal(pressureMsg('warn'))
    expect(state?.level.value).toBe('warn')
    expect(state?.lastPayload.value?.heapUsed).toBe(700_000_000)
    expect(action).toHaveBeenCalledTimes(1)
    expect(action).toHaveBeenCalledWith('warn', expect.objectContaining({ level: 'warn', usedPercent: 70 }))
    scope.stop()
  })

  it('critical 通知 → level=critical + 动作收到 critical 档', () => {
    const action = vi.fn()
    _setMemoryReliefActionForTest(action)
    const scope = effectScope()
    const state = scope.run(() => useMemoryPressure())
    dispatchGlobal(pressureMsg('critical', { usedPercent: 92, heapUsed: 920_000_000 }))
    expect(state?.level.value).toBe('critical')
    expect(action).toHaveBeenCalledWith('critical', expect.objectContaining({ usedPercent: 92 }))
    scope.stop()
  })

  it('防重复注册（refCount）：两个消费者实例只开一条物理订阅——单次 dispatch 动作只执行一次', () => {
    const action = vi.fn()
    _setMemoryReliefActionForTest(action)
    const scopeA = effectScope()
    scopeA.run(() => useMemoryPressure())
    const scopeB = effectScope()
    scopeB.run(() => useMemoryPressure())
    dispatchGlobal(pressureMsg('warn'))
    expect(action).toHaveBeenCalledTimes(1) // 非 2：多实例共享单条物理订阅
    scopeA.stop()
    scopeB.stop()
  })

  it('卸载退订：最后一个消费者 scope stop 后 dispatch 不再触发动作', () => {
    const action = vi.fn()
    _setMemoryReliefActionForTest(action)
    const scope = effectScope()
    scope.run(() => useMemoryPressure())
    dispatchGlobal(pressureMsg('warn'))
    expect(action).toHaveBeenCalledTimes(1)
    scope.stop() // refCount 归零 → 物理退订
    dispatchGlobal(pressureMsg('warn'))
    expect(action).toHaveBeenCalledTimes(1) // 退订后不再消费
  })

  it('部分卸载：两消费者仅其一卸载时订阅保持（refCount 递减不归零）', () => {
    const action = vi.fn()
    _setMemoryReliefActionForTest(action)
    const scopeA = effectScope()
    scopeA.run(() => useMemoryPressure())
    const scopeB = effectScope()
    scopeB.run(() => useMemoryPressure())
    scopeA.stop()
    dispatchGlobal(pressureMsg('warn'))
    expect(action).toHaveBeenCalledTimes(1) // scopeB 仍在，消费继续
    scopeB.stop()
    dispatchGlobal(pressureMsg('warn'))
    expect(action).toHaveBeenCalledTimes(1)
  })

  it('默认收紧动作（#28②）：压窗到 LRU_RELIEF_MAX_SESSIONS(4) + evictIfNeeded 驱逐一轮', () => {
    const store = useChatStore()
    const evictSpy = vi.spyOn(store, 'evictIfNeeded')
    const scope = effectScope()
    scope.run(() => useMemoryPressure())
    dispatchGlobal(pressureMsg('warn'))
    expect(evictSpy).toHaveBeenCalledTimes(1)
    // 压窗生效：core lru 生效上限从默认 8 收到 4（#28② 的「真收紧」语义）
    expect(getLruMaxSessions()).toBe(LRU_RELIEF_MAX_SESSIONS)
    scope.stop()
  })

  it('恢复语义（D4 未指明，登记裁决）：压窗不自动恢复默认（协议 normal 不广播，无消退信号）', () => {
    const scope = effectScope()
    scope.run(() => useMemoryPressure())
    dispatchGlobal(pressureMsg('warn'))
    expect(getLruMaxSessions()).toBe(LRU_RELIEF_MAX_SESSIONS)
    // 不存在「消退」帧；后续任意帧（仍为压力态）不回弹默认
    dispatchGlobal(pressureMsg('warn'))
    expect(getLruMaxSessions()).toBe(LRU_RELIEF_MAX_SESSIONS)
    scope.stop()
  })

  it('收紧动作抛错不逃逸：状态仍更新、订阅链不破坏（best-effort 降级）', () => {
    _setMemoryReliefActionForTest(() => {
      throw new Error('relief action boom')
    })
    const scope = effectScope()
    const state = scope.run(() => useMemoryPressure())
    expect(() => dispatchGlobal(pressureMsg('warn'))).not.toThrow()
    expect(state?.level.value).toBe('warn') // 动作失败不影响状态更新
    // 订阅链存活：下一帧仍消费
    _setMemoryReliefActionForTest(vi.fn())
    dispatchGlobal(pressureMsg('warn'))
    expect(state?.level.value).toBe('warn')
    scope.stop()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 来源节：useRollingRestartStatus
// ─────────────────────────────────────────────────────────────────────────────

/** 构造 rollingRestart 域广播帧。 */
function rollingMsg<T extends ServerMessage['type']>(type: T, payload: unknown): ServerMessage<T> {
  return { type, payload } as ServerMessage<T>
}

const deferredPayload: RollingRestartDeferredPayload = {
  reason: 'inflight',
  inflight: { inFlight: 2 },
  deferDeadlineAt: 1_700_000_100_000,
}
const countdownPayload: RollingRestartCountdownPayload = { executesAt: 1_700_000_060_000, inflight: { inFlight: 0 } }
const forcedPayload: RollingRestartForcedPayload = { reason: 'hard-threshold', inflight: { inFlight: 1 } }
const reattachPayload = (active: boolean): ReattachDeferredPayload => ({ active, reason: 'high-memory', pollMs: 30_000 })

function statusPayload(state: RollingRestartStatusPayload['state']): RollingRestartStatusPayload {
  return { state, inflight: { inFlight: state === 'idle' ? null : 0 } }
}

describe('useRollingRestartStatus（u7d 四态 + #27 轻态）', () => {
  beforeEach(() => {
    _resetRollingRestartStatusForTest()
    conn.stateRef!.value = 'connected'
    commandMock.mockReset()
    commandMock.mockResolvedValue(statusPayload('idle'))
  })

  afterEach(() => {
    _resetRollingRestartStatusForTest()
    vi.useRealTimers()
  })

  it('挂载即拉取：初始订阅发一次 rollingRestart.status（刷新后恢复语义）', async () => {
    commandMock.mockResolvedValue(statusPayload('deferred'))
    const scope = effectScope()
    scope.run(() => useRollingRestartStatus())
    await flushPromises()
    expect(commandMock).toHaveBeenCalledTimes(1)
    expect(commandMock).toHaveBeenCalledWith('rollingRestart.status', {}, expect.any(Number))
    scope.stop()
  })

  it('事件加速显示：deferred 广播 → deferred 相位（reason/inflight/deadline 透传）', async () => {
    const scope = effectScope()
    const state = scope.run(() => useRollingRestartStatus())
    await flushPromises()
    dispatchGlobal(rollingMsg('rollingRestart:deferred', deferredPayload))
    expect(state?.phase.value).toEqual({
      kind: 'deferred', reason: 'inflight', inflight: 2, deferDeadlineAt: 1_700_000_100_000,
    })
    scope.stop()
  })

  it('事件加速显示：countdown 广播 → countdown 相位（executesAt 透传）；forced → 红牌 rolling', async () => {
    const scope = effectScope()
    const state = scope.run(() => useRollingRestartStatus())
    await flushPromises()
    dispatchGlobal(rollingMsg('rollingRestart:countdown', countdownPayload))
    expect(state?.phase.value).toEqual({ kind: 'countdown', executesAt: 1_700_000_060_000, inflight: 0 })
    dispatchGlobal(rollingMsg('rollingRestart:forced', forcedPayload))
    expect(state?.phase.value).toEqual({ kind: 'rolling', reason: 'hard-threshold', inflight: 1 })
    scope.stop()
  })

  it('#27：reattach:deferred active=true → 轻态；active=false 清自身态；不触碰滚动重启态', async () => {
    const scope = effectScope()
    const state = scope.run(() => useRollingRestartStatus())
    await flushPromises()
    dispatchGlobal(rollingMsg('reattach:deferred', reattachPayload(true)))
    expect(state?.phase.value).toEqual({ kind: 'reattach-deferred', pollMs: 30_000 })
    dispatchGlobal(rollingMsg('reattach:deferred', reattachPayload(false)))
    expect(state?.phase.value).toEqual({ kind: 'idle' })
    // 滚动重启态不被缓解帧触碰
    dispatchGlobal(rollingMsg('rollingRestart:deferred', deferredPayload))
    dispatchGlobal(rollingMsg('reattach:deferred', reattachPayload(false)))
    expect(state?.phase.value?.kind).toBe('deferred')
    scope.stop()
  })

  it('#27：缓解帧到达时若处于滚动重启活跃/recovered 态则保持原态不落井下石', async () => {
    const scope = effectScope()
    const state = scope.run(() => useRollingRestartStatus())
    await flushPromises()
    dispatchGlobal(rollingMsg('rollingRestart:forced', forcedPayload))
    dispatchGlobal(rollingMsg('reattach:deferred', reattachPayload(false)))
    expect(state?.phase.value?.kind).toBe('rolling')
    scope.stop()
  })

  it('A2 断连重连拉取：拉到 deferred → 横幅恢复（持续态经 RPC 重建）', async () => {
    commandMock.mockResolvedValue(statusPayload('idle'))
    const scope = effectScope()
    const state = scope.run(() => useRollingRestartStatus())
    await flushPromises()
    expect(state?.phase.value.kind).toBe('idle')

    conn.stateRef!.value = 'disconnected'
    await flushPromises()
    commandMock.mockResolvedValue(statusPayload('deferred'))
    conn.stateRef!.value = 'connected' // 断连 → 重连转变触发拉取
    await flushPromises()
    expect(commandMock).toHaveBeenCalledTimes(2)
    expect(state?.phase.value).toEqual({
      kind: 'deferred', reason: 'inflight', inflight: 0, deferDeadlineAt: 0,
    })
    scope.stop()
  })

  it('A2 终态分叉·转绿：出现过活跃态 → 重连拉到 idle 转绿 30s 自动清除', async () => {
    vi.useFakeTimers()
    const scope = effectScope()
    const state = scope.run(() => useRollingRestartStatus())
    await flushPromises()
    dispatchGlobal(rollingMsg('rollingRestart:deferred', deferredPayload))
    expect(state?.phase.value.kind).toBe('deferred')

    commandMock.mockResolvedValue(statusPayload('idle'))
    conn.stateRef!.value = 'restarting'
    await flushPromises()
    conn.stateRef!.value = 'connected'
    await flushPromises()
    expect(state?.phase.value.kind).toBe('recovered')

    await vi.advanceTimersByTimeAsync(RECOVERED_AUTO_CLEAR_MS)
    expect(state?.phase.value.kind).toBe('idle')
    scope.stop()
  })

  it('A2 终态分叉·不重现：全新窗口（无活跃态历史）重连拉到 idle → 恒 idle', async () => {
    const scope = effectScope()
    const state = scope.run(() => useRollingRestartStatus())
    await flushPromises()
    expect(state?.phase.value.kind).toBe('idle')
    conn.stateRef!.value = 'disconnected'
    await flushPromises()
    conn.stateRef!.value = 'connected'
    await flushPromises()
    expect(commandMock).toHaveBeenCalledTimes(2)
    expect(state?.phase.value.kind).toBe('idle') // 无历史不转绿、不重现
    scope.stop()
  })

  it('refCount：两消费者共享单条物理订阅（初始拉取只发一次 RPC）', async () => {
    const scopeA = effectScope()
    scopeA.run(() => useRollingRestartStatus())
    const scopeB = effectScope()
    scopeB.run(() => useRollingRestartStatus())
    await flushPromises()
    expect(commandMock).toHaveBeenCalledTimes(1)
    scopeA.stop()
    scopeB.stop()
    // 全部卸载后重挂 → 重新订阅 + 重新拉取
    commandMock.mockResolvedValue(statusPayload('deferred'))
    const scopeC = effectScope()
    scopeC.run(() => useRollingRestartStatus())
    await flushPromises()
    expect(commandMock).toHaveBeenCalledTimes(2)
    scopeC.stop()
  })

  it('拉取失败（transport 不可用 reject）→ 状态保持 idle、不向上抛', async () => {
    commandMock.mockRejectedValue(new Error('transport unavailable'))
    const scope = effectScope()
    const state = scope.run(() => useRollingRestartStatus())
    await expect(flushPromises()).resolves.not.toThrow()
    expect(state?.phase.value.kind).toBe('idle')
    scope.stop()
  })

  it('dismiss：手动关闭 → idle（recovered 定时器一并清理，不再复发）', async () => {
    vi.useFakeTimers()
    const scope = effectScope()
    const state = scope.run(() => useRollingRestartStatus())
    await flushPromises()
    dispatchGlobal(rollingMsg('rollingRestart:deferred', deferredPayload))
    state?.dismiss()
    expect(state?.phase.value.kind).toBe('idle')
    await vi.advanceTimersByTimeAsync(RECOVERED_AUTO_CLEAR_MS)
    expect(state?.phase.value.kind).toBe('idle')
    scope.stop()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 来源节：useSessionMarkers（顶层 beforeEach 已下沉进 describe）
// ─────────────────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'taiji:session-markers'

describe('useSessionMarkers', () => {
  beforeEach(() => {
    localStorage.clear()
    __resetMarkersCacheForTest()
    __clearSessionCleanupRegistryForTest()
    __registerMarkersCleanupForTest()
  })

  it('markUnread + isUnread', () => {
    expect(isUnread('s1')).toBe(false)
    markUnread('s1')
    expect(isUnread('s1')).toBe(true)
  })

  it('clearUnread', () => {
    markUnread('s1')
    clearUnread('s1')
    expect(isUnread('s1')).toBe(false)
  })

  it('toggleMarkedDone 双向切换', () => {
    expect(isMarkedDone('s1')).toBe(false)
    toggleMarkedDone('s1')
    expect(isMarkedDone('s1')).toBe(true)
    toggleMarkedDone('s1')
    expect(isMarkedDone('s1')).toBe(false)
  })

  it('标记完成时自动清除 unread', () => {
    markUnread('s1')
    expect(isUnread('s1')).toBe(true)
    toggleMarkedDone('s1')
    expect(isMarkedDone('s1')).toBe(true)
    expect(isUnread('s1')).toBe(false)
  })

  it('数据写入 localStorage，可读回', () => {
    markUnread('s1')
    toggleMarkedDone('s2')
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    expect(stored.s1?.unread).toBe(true)
    expect(stored.s2?.markedDone).toBe(true)
  })

  it('triggerSessionCleanups 清除该 sid 条目', () => {
    markUnread('s1')
    toggleMarkedDone('s1')
    triggerSessionCleanups('s1')
    expect(isUnread('s1')).toBe(false)
    expect(isMarkedDone('s1')).toBe(false)
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    expect(stored.s1).toBeUndefined()
  })

  it('clearAll 直接清除', () => {
    markUnread('s1')
    toggleMarkedDone('s1')
    clearAll('s1')
    expect(isUnread('s1')).toBe(false)
    expect(isMarkedDone('s1')).toBe(false)
  })

  it('两个标记都清空后移除整个条目（不残留空对象）', () => {
    markUnread('s1')
    clearUnread('s1')
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    expect(stored.s1).toBeUndefined()
  })

  it('storage 事件触发后内存缓存更新', () => {
    expect(isUnread('s1')).toBe(false)
    const newData = JSON.stringify({ s1: { unread: true } })
    window.dispatchEvent(new StorageEvent('storage', {
      key: STORAGE_KEY,
      newValue: newData,
    }))
    expect(isUnread('s1')).toBe(true)
  })

  it('[回归] isUnread/isMarkedDone 在 computed 中使用时响应式更新（cache.value 变化触发重算）', () => {
    // 这是 SessionItem.vue 的真实用法：const unread = computed(() => isUnread(sid))
    // 修复前 isUnread 读 ensureCache() 局部变量，不访问 cache.value，computed 不重算 → badge 不更新
    const unread = computed(() => isUnread('s1'))
    const done = computed(() => isMarkedDone('s1'))

    expect(unread.value).toBe(false)
    expect(done.value).toBe(false)

    let unreadChanges = 0
    let doneChanges = 0
    effect(() => { void unread.value; unreadChanges++ })
    effect(() => { void done.value; doneChanges++ })
    const unreadBase = unreadChanges
    const doneBase = doneChanges

    markUnread('s1')
    expect(unread.value).toBe(true)
    expect(unreadChanges).toBeGreaterThan(unreadBase) // computed 重算

    toggleMarkedDone('s1')
    expect(done.value).toBe(true)
    expect(doneChanges).toBeGreaterThan(doneBase) // computed 重算
  })

  it('[回归] localStorage 存在空对象 {} 时 ensureCache 仅 hydrate 一次，不重复 parse', () => {
    localStorage.setItem(STORAGE_KEY, '{}')
    isUnread('s1')  // 首次 hydrate，得到空 Map
    isMarkedDone('s1')  // 不应再次 hydrate
    // 验证返回值正确（空 Map 意味着都是默认值）
    expect(isUnread('s1')).toBe(false)
    expect(isMarkedDone('s1')).toBe(false)
    // 后续 markUnread 后 hydrated 仍为 true，不再读 localStorage（写入走内存 cache，与 ensureCache 无关）
    markUnread('s1')
    expect(isUnread('s1')).toBe(true)
  })

  it('[Q1-1] 连续写操作不再 readAll：hydrate 后写路径零 getItem（走内存 cache）', () => {
    markUnread('s1')  // 首次写触发 ensureCache hydrate（1 次 getItem）
    const getItemSpy = vi.spyOn(localStorage, 'getItem')
    const setItemSpy = vi.spyOn(localStorage, 'setItem')
    // 正向对照：先做一次已知 getItem 调用确认 spy 拦截生效，再清零计数——否则下方
    // 「零 getItem」断言无法区分「写路径不读盘」与「spy 根本没挂上」
    void localStorage.getItem(STORAGE_KEY)
    expect(getItemSpy).toHaveBeenCalledTimes(1)
    getItemSpy.mockClear()

    markUnread('s2')
    markUnread('s3')
    clearUnread('s2')
    toggleMarkedDone('s3')
    toggleMarkedDone('s3')
    clearAll('s1')

    // 写路径完全走内存 cache：零 readAll（getItem 不被调用）
    expect(getItemSpy).not.toHaveBeenCalled()
    // 保留立即写盘语义：每次实际变更一次 setItem（clearUnread 移除 s2 / clearAll 移除 s1 均为实际变更）
    expect(setItemSpy).toHaveBeenCalledTimes(6)
    // 语义等价：最终状态正确
    expect(isUnread('s1')).toBe(false)
    expect(isUnread('s2')).toBe(false)
    expect(isMarkedDone('s3')).toBe(false)
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')).toEqual({})
    // spy 期间确有写盘动作（证明 setItem spy 本身生效，上面计数非空转）
    expect(setItemSpy.mock.calls.length).toBeGreaterThan(0)
  })

  it('[Q1-1] 无条目时 clearUnread/clearAll 不写盘（保持 no-op 语义）', () => {
    markUnread('s1')  // hydrate
    const setItemSpy = vi.spyOn(localStorage, 'setItem')
    clearUnread('nonexistent')
    clearAll('nonexistent')
    expect(setItemSpy).not.toHaveBeenCalled()
    expect(isUnread('s1')).toBe(true)  // 原数据不受影响
  })

  it('[Q1-1] 写路径基于内存 cache 突变：不读盘也能看到先前写入的标记', () => {
    markUnread('s1')
    // 不经过任何读操作，直接再写同 sid —— 旧标记（unread）不应被内存路径丢失
    toggleMarkedDone('s1')
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    // 标记完成时自动清除 unread，且 markedDone=true 保留条目
    expect(stored.s1).toEqual({ unread: false, markedDone: true })
  })

  // ── 损坏保护（RD-1#2 / 审计 M4 族：损坏数据读回空骨架 → 全量覆写）──

  it('[RD-1#2] localStorage 值损坏时 mutateMarker 拒绝写盘：原始（可人工恢复）数据不被空表覆写', () => {
    const corruptRaw = '{"s1":{"unread":true},"s2":{"markedDone":true},BROKEN'
    localStorage.setItem(STORAGE_KEY, corruptRaw)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    markUnread('s3') // ensureCache hydrate → 解析失败 → corrupt → 拒绝写
    expect(localStorage.getItem(STORAGE_KEY)).toBe(corruptRaw) // 原值原样保留
    expect(warnSpy).toHaveBeenCalled()
    // warn 含 key 与恢复动作指引（可行动错误消息）
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(warned).toContain(STORAGE_KEY)
    expect(warned).toContain('恢复动作')

    // 读侧降级但不写：多次标记操作后原值仍不被覆写
    toggleMarkedDone('s3')
    clearAll('s1')
    expect(localStorage.getItem(STORAGE_KEY)).toBe(corruptRaw)
    warnSpy.mockRestore()
  })

  it('[RD-1#2] 损坏 warn 去重：连续多次操作只提示一次，不刷屏', () => {
    localStorage.setItem(STORAGE_KEY, 'NOT-JSON{')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    markUnread('s1')
    markUnread('s2')
    toggleMarkedDone('s3')
    expect(warnSpy).toHaveBeenCalledTimes(2) // 损坏发生 1 次 + 拒绝写 1 次
    warnSpy.mockRestore()
  })

  it('[RD-1#2] storage 事件推送损坏 newValue：内存缓存保留旧值不被清空，后续写被拒', () => {
    markUnread('s1') // 正常 hydrate + 写入
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, newValue: 'BROKEN{' }))
    expect(isUnread('s1')).toBe(true) // 旧缓存保留，不被清空

    markUnread('s2') // corrupt 态 → 拒绝写
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')).toEqual({ s1: { unread: true } })
    warnSpy.mockRestore()
  })

  it('[RD-1#2] 损坏后另一窗口写入合法值（storage 事件）→ 解除保护，写入恢复', () => {
    localStorage.setItem(STORAGE_KEY, 'BROKEN{')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    markUnread('s1') // corrupt → 拒绝
    expect(localStorage.getItem(STORAGE_KEY)).toBe('BROKEN{')

    // 另一窗口修复了该值
    const fixed = JSON.stringify({ s1: { unread: true } })
    localStorage.setItem(STORAGE_KEY, fixed)
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, newValue: fixed }))

    markUnread('s2') // 保护解除 → 正常写
    expect(isUnread('s1')).toBe(true)
    expect(isUnread('s2')).toBe(true)
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')).toEqual({
      s1: { unread: true },
      s2: { unread: true },
    })
    warnSpy.mockRestore()
  })

  // ── 形状检查（合法 JSON 但结构漂移不进 cache）──

  it('[形状检查] 顶层非对象 JSON（数组等形状漂移）与解析失败同走 corrupt 通道', () => {
    const arrayRaw = '[{"s1":{"unread":true}}]'
    localStorage.setItem(STORAGE_KEY, arrayRaw)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    markUnread('s2') // hydrate → 顶层形状检查失败 → corrupt → 拒写
    expect(warnSpy).toHaveBeenCalled()
    expect(localStorage.getItem(STORAGE_KEY)).toBe(arrayRaw) // 原值保留不覆写
    expect(isUnread('s1')).toBe(false) // 错误形状未进 cache

    // 与解析失败同一恢复路径：合法值经 storage 事件写入后解除保护
    const fixed = JSON.stringify({ s1: { unread: true } })
    localStorage.setItem(STORAGE_KEY, fixed)
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, newValue: fixed }))
    markUnread('s2')
    expect(isUnread('s2')).toBe(true)
    warnSpy.mockRestore()
  })

  it('[形状检查] 条目形状漂移被丢弃并 warn-once，合法条目与合法字段照常加载', () => {
    const raw = JSON.stringify({
      s1: { unread: true }, // 合法
      s2: 'junk', // 非对象 → 丢弃
      s3: { unread: 'yes' }, // 字段漂移且无合法字段 → 丢弃
      s4: { unread: 'yes', markedDone: true }, // 部分漂移 → 剔除漂移字段，保留 markedDone
    })
    localStorage.setItem(STORAGE_KEY, raw)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(isUnread('s1')).toBe(true)
    expect(isUnread('s2')).toBe(false)
    expect(isUnread('s3')).toBe(false)
    expect(isMarkedDone('s3')).toBe(false)
    expect(isUnread('s4')).toBe(false)
    expect(isMarkedDone('s4')).toBe(true)
    expect(warnSpy).toHaveBeenCalledTimes(1) // 丢弃只提示一次，不刷屏

    // 丢弃不置 corrupt：写盘正常，坏条目随下次写盘被清理
    markUnread('s5')
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')).toEqual({
      s1: { unread: true },
      s4: { markedDone: true },
      s5: { unread: true },
    })

    // warn 去重跨读取生效：再次读入含坏条目的值不重复提示
    localStorage.setItem(STORAGE_KEY, raw)
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, newValue: raw }))
    expect(warnSpy).toHaveBeenCalledTimes(1)
    warnSpy.mockRestore()
  })
})
