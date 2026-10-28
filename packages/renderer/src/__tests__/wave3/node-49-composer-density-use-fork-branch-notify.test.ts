// @vitest-environment node
import { COMPOSER_DEGRADATION_ORDER, COMPOSER_DENSITY_MAX_FIT_DEGRADATION, COMPOSER_FIT_LEVEL_LEFT_AGGREGATE, COMPOSER_FIT_LEVEL_METRICS_AGGREGATE, COMPOSER_FIT_LEVEL_MODEL_AGGREGATE, COMPOSER_FIT_LEVEL_NONE, normalizeComposerFitLevel, resolveComposerDensity, type ComposerDensityCapabilities, type ComposerDensityLayout } from '@/components/panel/composer-density';
import { resolveThinkingValue, resolveThinkingKey, highestAvailableLevel, isSameThinkingScheme, getDisplayLabel, THINKING_LEVELS } from '@/components/panel/thinking-levels';
import { bindForkNoticeEffect, pushForkNoticeAsk, resetForkNoticeFeed, useForkNoticeFeed } from '@/composables/effects/useForkNoticeEffect';
import { clearUnread, unreadByBranch } from '@/composables/features/fork-handoff/useForkBranchNotify';
import { __resetBtwLineMembershipForTest, noteBtwLinesPulled } from '@/composables/panel/btw-line-membership';
import { useSessionStore } from '@/stores/session';
import * as events from '@taiji/core/transport/api';
import type { ServerMessage, SessionGroup, SessionSummary } from '@taiji/shared';
import enPanel from '@taiji/ui/locale/en-US/panel';
import zhPanel from '@taiji/ui/locale/zh-CN/panel';
import { createPinia, setActivePinia, storeToRefs } from 'pinia';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { effectScope, nextTick } from 'vue';

// wave3 簇 [renderer/node] 2 文件
/**
 * 合并产物（round6 Wave3 机械合并，环境/簇信息见来源横幅）。
 * 重名顶层标识符已加 _mN 后缀；相对 import 已按产物位置改写。
 * 来源文件：
 * - __tests__/effects/use-fork-branch-notify.test.ts
 * - __tests__/panel/composer-density.test.ts
 */

// ======================================================================
// ← __tests__/effects/use-fork-branch-notify.test.ts
// ======================================================================

// W4b 收编：btw 线成员判别（ForkNotice suppress 读口）经 session.list {surface:'btw'}
// 拉取缓存供数——mock 掉 @/api 门面的 listSessions（spread actual 保其余域）。
const sessionListMock = vi.hoisted(() => ({ listSessions: vi.fn() }))
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  return { ...actual, session: { ...actual.session, listSessions: sessionListMock.listSessions } }
})

function session(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    id: 's-x',
    label: '分支',
    cwd: '/tmp/proj',
    status: 'active',
    lastActiveAt: Date.now(),
    ...overrides,
  }
}

function groupOf(...sessions: SessionSummary[]): SessionGroup[] {
  return [{ cwd: '/tmp/proj', sessions }]
}

/** 模拟 runtime 广播 session.forkNotice（fork 成功通知） */
function broadcastForkNotice(srcSessionId: string, newSessionId: string, branchName?: string): void {
  const msg: ServerMessage<'session.forkNotice'> = {
    type: 'session.forkNotice',
    payload: { srcSessionId, newSessionId, branchName },
  }
  events.dispatchGlobal(msg)
}

/** 推进 groups 广播（config.sessions 全量应用语义：整表替换） */
async function broadcastGroups(sessions: SessionSummary[]): Promise<void> {
  const { groups } = storeToRefs(useSessionStore())
  groups.value = groupOf(...sessions)
  await nextTick()
}

let scope: ReturnType<typeof effectScope> | undefined

beforeEach(() => {
  setActivePinia(createPinia())
  scope?.stop()
  resetForkNoticeFeed()
  // W4b 收编判别器：ForkNotice suppress 读口 = session.list {surface:'btw'} 拉取缓存成员
  // 判别（登记于 docs/constraints.json C-data-28 抑制类清单）——逐用例清零 + 按线预热。
  __resetBtwLineMembershipForTest()
  sessionListMock.listSessions.mockResolvedValue([])
  scope = effectScope()
  scope.run(() => {
    bindForkNoticeEffect()
  })
})

describe('fork 分支角标（V7：产生 → 读后清除 → 切会话保持）', () => {
  it('后台分支 active→done：未读角标产生 + 反馈行追加状态通知（RV2 全链）', async () => {
    const { notices } = useForkNoticeFeed()

    broadcastForkNotice('s-parent', 's-branch', 'fix-bug')
    await broadcastGroups([
      session({ id: 's-parent', status: 'active' }),
      session({ id: 's-branch', status: 'active', parentSession: 's-parent', label: 'fix-bug' }),
    ])
    // 运行中：无角标；fork 广播本身入 feed（RV1 forkedPrefix）
    expect(unreadByBranch.value.get('s-branch')).toBeUndefined()
    expect(notices('s-parent').some((n) => n.newSessionId === 's-branch')).toBe(true)

    await broadcastGroups([
      session({ id: 's-parent', status: 'active' }),
      session({ id: 's-branch', status: 'done', parentSession: 's-parent', label: 'fix-bug' }),
    ])
    // 角标产生
    expect(unreadByBranch.value.get('s-branch')).toBe(true)
    // 状态通知追加（RV2：kind=done）
    const doneNotice = notices('s-parent').find((n) => n.newSessionId === 's-branch' && n.kind === 'done')
    expect(doneNotice).toBeDefined()
  })

  it('用户查看分支 → clearUnread 清除；groups 再次广播（切会话重放）已读态不回灌', async () => {
    broadcastForkNotice('s-parent', 's-branch', 'fix-bug')
    const doneBranch = session({ id: 's-branch', status: 'done', parentSession: 's-parent', label: 'fix-bug' })
    await broadcastGroups([session({ id: 's-parent', status: 'active' }), doneBranch])
    expect(unreadByBranch.value.get('s-branch')).toBe(true)

    // 用户 select 跳转查看 → 清角标
    clearUnread('s-branch')
    expect(unreadByBranch.value.get('s-branch')).toBeUndefined()

    // 切会话语义：config.sessions 全量广播重放（同表或含无关 session），已读态不回灌
    await broadcastGroups([session({ id: 's-parent', status: 'active' }), doneBranch])
    await broadcastGroups([session({ id: 's-parent', status: 'active' })])
    expect(unreadByBranch.value.get('s-branch')).toBeUndefined()
  })

  it('非活跃分支的未读角标跨多次 groups 广播保留（ADR-0049：角标状态不随焦点切换丢失）', async () => {
    broadcastForkNotice('s-a', 's-branch-a', 'branch-a')
    broadcastForkNotice('s-b', 's-branch-b', 'branch-b')
    await broadcastGroups([
      session({ id: 's-a', status: 'active' }),
      session({ id: 's-branch-a', status: 'done', parentSession: 's-a', label: 'branch-a' }),
      session({ id: 's-b', status: 'active' }),
      session({ id: 's-branch-b', status: 'active', parentSession: 's-b', label: 'branch-b' }),
    ])
    expect(unreadByBranch.value.get('s-branch-a')).toBe(true)

    // 用户查看 branch-a 并清除；branch-b 仍在后台跑（无角标）
    clearUnread('s-branch-a')
    await broadcastGroups([
      session({ id: 's-a', status: 'active' }),
      session({ id: 's-branch-a', status: 'done', parentSession: 's-a', label: 'branch-a' }),
      session({ id: 's-b', status: 'active' }),
      session({ id: 's-branch-b', status: 'done', parentSession: 's-b', label: 'branch-b' }),
    ])
    // branch-a 已读态保持；branch-b 后台跑完产生新角标（与焦点在哪个 session 无关）
    expect(unreadByBranch.value.get('s-branch-a')).toBeUndefined()
    expect(unreadByBranch.value.get('s-branch-b')).toBe(true)
  })

  it('bind 卸载（App 卸载语义）→ 分支追踪/角标态清空', async () => {
    broadcastForkNotice('s-parent', 's-branch', 'fix-bug')
    await broadcastGroups([
      session({ id: 's-parent', status: 'active' }),
      session({ id: 's-branch', status: 'done', parentSession: 's-parent', label: 'fix-bug' }),
    ])
    expect(unreadByBranch.value.size).toBe(1)

    scope?.stop()
    await nextTick()
    expect(unreadByBranch.value.size).toBe(0)
  })
})

describe('ForkNotice suppress（btw 流）', () => {
  it('notice 推给 btw 线 → notices(线 id) 构造性空；主会话同型推送照常可见', () => {
    // W4b 收编判别器 = 拉取缓存成员判别：线 session id 经缓存预热（= 抽屉拉取产物喂入）
    noteBtwLinesPulled(['line-fn-1'])
    pushForkNoticeAsk('line-fn-1', 'new-branch-1', '旁路提问预览')
    pushForkNoticeAsk('main-fn-1', 'new-branch-2', '主分支预览')

    const feed = useForkNoticeFeed()
    expect(feed.notices('line-fn-1')).toHaveLength(0) // btw 流 suppress（D4）
    expect(feed.notices('main-fn-1')).toHaveLength(1) // 主会话行为不变（回归对照）

    // suppress 对交互幂等：dismiss/clear 对空表零动作不抛
    expect(() => feed.dismissNotice('line-fn-1', 1)).not.toThrow()
    expect(() => feed.clearSession('line-fn-1')).not.toThrow()
  })
})

// ======================================================================
// ← __tests__/panel/composer-density.test.ts
// ======================================================================

/** 穷举矩阵的维度：fit 0–3 × 能力组合 × 锚点保护开关 */
const ALL_LEVELS = [0, 1, 2, 3]
const CAP_VARIANTS: Array<[string, ComposerDensityCapabilities]> = [
  ['缺省（托盘有面 + 插件零贡献）', {}],
  ['托盘全无 + 插件零贡献', { hasTrayItems: false }],
  ['托盘全无 + 插件有贡献', { hasTrayItems: false, pluginToolbarContributionCount: 1 }],
  ['托盘有面 + 插件有贡献', { hasTrayItems: true, pluginToolbarContributionCount: 3 }],
  ['托盘全无 + toolbar 零贡献 + headerAction 有入口', { hasTrayItems: false, hasHeaderActionEntries: true }],
  ['托盘全无 + toolbar 零贡献 + headerAction 无入口（三源全空）', { hasTrayItems: false, hasHeaderActionEntries: false }],
  ['托盘有面 + headerAction 有入口', { hasTrayItems: true, hasHeaderActionEntries: true }],
  ['托盘有面 + toolbar 有贡献 + headerAction 有入口', { hasTrayItems: true, pluginToolbarContributionCount: 1, hasHeaderActionEntries: true }],
]
const PROTECT_VARIANTS = [false, true]

function allCombos(): Array<{ level: number; caps: ComposerDensityCapabilities; protect: boolean; out: ComposerDensityLayout }> {
  const rows = []
  for (const level of ALL_LEVELS) {
    for (const [, caps] of CAP_VARIANTS) {
      for (const protect of PROTECT_VARIANTS) {
        rows.push({ level, caps, protect, out: resolveComposerDensity(caps, level, protect) })
      }
    }
  }
  return rows
}

describe('常量与归一', () => {
  it('fit 顶格 = 3，级命名常量与退化序一一对应', () => {
    expect(COMPOSER_DENSITY_MAX_FIT_DEGRADATION).toBe(3)
    expect(COMPOSER_FIT_LEVEL_NONE).toBe(0)
    expect(COMPOSER_FIT_LEVEL_LEFT_AGGREGATE).toBe(COMPOSER_DEGRADATION_ORDER.LEFT_CLUSTER_AGGREGATE)
    expect(COMPOSER_FIT_LEVEL_METRICS_AGGREGATE).toBe(COMPOSER_DEGRADATION_ORDER.METRICS_AGGREGATE)
    expect(COMPOSER_FIT_LEVEL_MODEL_AGGREGATE).toBe(COMPOSER_DEGRADATION_ORDER.MODEL_THINKING_AGGREGATE)
  })

  it('normalize：NaN → 0；负 → 0；越界 → 顶格；小数 → 取整', () => {
    expect(normalizeComposerFitLevel(Number.NaN)).toBe(0)
    expect(normalizeComposerFitLevel(-5)).toBe(0)
    expect(normalizeComposerFitLevel(0.4)).toBe(0)
    expect(normalizeComposerFitLevel(1.6)).toBe(2)
    expect(normalizeComposerFitLevel(99)).toBe(3)
    expect(normalizeComposerFitLevel(Number.POSITIVE_INFINITY)).toBe(3)
  })
})

describe('三步累计映射（fit 级 → 形态）', () => {
  it('L0 全展开：三组均原形态，零退化序', () => {
    const layout = resolveComposerDensity({}, 0)
    expect(layout.slots.leftCluster).toBe('expanded')
    expect(layout.slots.metrics).toBe('expanded')
    expect(layout.slots.modelThinking).toBe('expanded')
    expect(layout.appliedOrders).toEqual([])
    expect(layout.anchorProtected).toBe(false)
    expect(layout.allowsWrap).toBe(false)
  })

  it('L1 只聚合指标；L2 再聚合左簇；L3 再聚合模型+思考（前缀累计）', () => {
    const l1 = resolveComposerDensity({}, COMPOSER_FIT_LEVEL_METRICS_AGGREGATE)
    expect(l1.slots).toMatchObject({
      leftCluster: 'expanded',
      metrics: 'aggregated',
      modelThinking: 'expanded',
    })
    expect(l1.appliedOrders).toEqual([COMPOSER_DEGRADATION_ORDER.METRICS_AGGREGATE])

    const l2 = resolveComposerDensity({}, COMPOSER_FIT_LEVEL_LEFT_AGGREGATE)
    expect(l2.slots).toMatchObject({
      leftCluster: 'aggregated',
      metrics: 'aggregated',
      modelThinking: 'expanded',
    })
    expect(l2.appliedOrders).toEqual([1, 2])

    const l3 = resolveComposerDensity({}, COMPOSER_FIT_LEVEL_MODEL_AGGREGATE)
    expect(l3.slots).toMatchObject({
      leftCluster: 'aggregated',
      metrics: 'aggregated',
      modelThinking: 'aggregated',
    })
    expect(l3.appliedOrders).toEqual([1, 2, 3])
  })

  it('缺省 fit 入参 = 0（全展开）', () => {
    expect(resolveComposerDensity().fitLevel).toBe(0)
    expect(resolveComposerDensity({}).slots.leftCluster).toBe('expanded')
  })
})

describe('能力标志（不留死入口）', () => {
  it('托盘全无 + 插件零贡献 → leftCluster absent（任何 fit 级都不渲染聚合按钮）', () => {
    for (const level of ALL_LEVELS) {
      const layout = resolveComposerDensity({ hasTrayItems: false }, level)
      expect(layout.slots.leftCluster).toBe('absent')
    }
  })

  it('托盘全无但插件有贡献 → 左簇仍可达（L0/L1 展开 / L2+ 聚合）', () => {
    const caps: ComposerDensityCapabilities = { hasTrayItems: false, pluginToolbarContributionCount: 1 }
    expect(resolveComposerDensity(caps, 0).slots.leftCluster).toBe('expanded')
    expect(resolveComposerDensity(caps, 1).slots.leftCluster).toBe('expanded')
    expect(resolveComposerDensity(caps, 2).slots.leftCluster).toBe('aggregated')
  })

  it('贡献数非正数一律视为零贡献；缺省 hasTrayItems = true', () => {
    expect(
      resolveComposerDensity({ hasTrayItems: false, pluginToolbarContributionCount: 0 }, 0).slots.leftCluster,
    ).toBe('absent')
    expect(
      resolveComposerDensity({ hasTrayItems: false, pluginToolbarContributionCount: -2 }, 0).slots.leftCluster,
    ).toBe('absent')
    expect(resolveComposerDensity({ pluginToolbarContributionCount: 1 }, 0).slots.leftCluster).toBe('expanded')
  })

  it('headerAction 有入口 = 左簇第三内容源：托盘空 + toolbar 零贡献仍可聚合（B3 聚合范围含定时任务）', () => {
    // 三源全空才 absent；headerAction 单独在场 → L0 展开 / L2 聚合（被聚合 clock 由聚合面板段承接）
    const caps: ComposerDensityCapabilities = { hasTrayItems: false, hasHeaderActionEntries: true }
    expect(resolveComposerDensity(caps, 0).slots.leftCluster).toBe('expanded')
    expect(resolveComposerDensity(caps, 2).slots.leftCluster).toBe('aggregated')
    // hasHeaderActionEntries 缺省 false：三源全空 → absent（与旧判据兼容）
    expect(resolveComposerDensity({ hasTrayItems: false }, 0).slots.leftCluster).toBe('absent')
    expect(resolveComposerDensity({ hasTrayItems: false, hasHeaderActionEntries: false }, 0).slots.leftCluster).toBe('absent')
  })
})

describe('锚点保护（L3 顶格仍放不下 → 中部让位，锚点与模型入口零裁剪）', () => {
  it('仅 L3 生效：左簇与指标 absent，模型聚合按钮恒在', () => {
    const layout = resolveComposerDensity({}, 3, true)
    expect(layout.anchorProtected).toBe(true)
    expect(layout.slots.leftCluster).toBe('absent')
    expect(layout.slots.metrics).toBe('absent')
    expect(layout.slots.modelThinking).toBe('aggregated')
    expect(layout.slots.add).toBe('expanded')
    expect(layout.slots.send).toBe('expanded')
  })

  it('低 fit 级下 anchorOverflow 入参被忽略（先走正常三级退化）', () => {
    for (const level of [0, 1, 2]) {
      const layout = resolveComposerDensity({}, level, true)
      expect(layout.anchorProtected).toBe(false)
      expect(layout.slots.metrics).not.toBe('absent')
      expect(layout.slots.leftCluster).not.toBe('absent')
    }
  })

  it('保护态下 appliedOrders 仍是 L3 前缀（保护是顶格之上的让位，不新增序号）', () => {
    const layout = resolveComposerDensity({}, 3, true)
    expect(layout.appliedOrders).toEqual([1, 2, 3])
    expect(layout.fitLevel).toBe(3)
  })
})

describe('穷举矩阵不变式（64 组合：4 级 × 8 能力 × 2 保护）', () => {
  it('序 0 恒不退化；模型形态只有两态且恒不缺席；输出域无双轴旧键', () => {
    for (const { out } of allCombos()) {
      // 锚点类型级保证
      expect(out.slots.add).toBe('expanded')
      expect(out.slots.send).toBe('expanded')
      expect(out.allowsWrap).toBe(false)
      // 模型名两态：完整展示 / 聚合按钮——**无截断态、永不缺席**（切模型恒可达）
      expect(['expanded', 'aggregated']).toContain(out.slots.modelThinking)
      // 指标缺席只可能来自锚点保护
      if (out.slots.metrics === 'absent') expect(out.anchorProtected).toBe(true)
      // 双轴旧语义构造性不存在
      expect('tier' in out).toBe(false)
      expect('overflowItems' in out).toBe(false)
      expect('overflowMenuVisible' in out).toBe(false)
      expect('fit' in out).toBe(false)
    }
  })

  it('appliedOrders 恒等于 fitLevel 前缀（单一真源，不漂移）', () => {
    for (const { level, out } of allCombos()) {
      expect(out.appliedOrders).toHaveLength(level)
      expect(out.appliedOrders).toEqual([1, 2, 3].slice(0, level))
      expect(out.fitLevel).toBe(level)
    }
  })
})

describe('纯函数契约', () => {
  it('同输入恒等（深比较）且不共享引用', () => {
    const a = resolveComposerDensity({ hasTrayItems: false }, 2, true)
    const b = resolveComposerDensity({ hasTrayItems: false }, 2, true)
    expect(a).toEqual(b)
    expect(a).not.toBe(b)
    expect(a.slots).not.toBe(b.slots)
    expect(a.appliedOrders).not.toBe(b.appliedOrders)
  })

  it('不修改入参（能力标志冻结后调用不抛）', () => {
    const caps = Object.freeze({ hasTrayItems: true, pluginToolbarContributionCount: 2 })
    expect(() => resolveComposerDensity(caps, 3, true)).not.toThrow()
    expect(caps).toEqual({ hasTrayItems: true, pluginToolbarContributionCount: 2 })
  })
})

// ══════════ 来源：thinking-levels.test.ts ══════════
{
  // 真实预设（从 useProviderEdit.ts THINKING_PRESETS 同步）：map + 对应 supportedLevels
  const ON_OFF_MAP = { off: 'off', high: 'high' }
  const HIGH_MAX_MAP = { off: 'off', high: 'high', max: 'xhigh' }
  const ON_OFF_SUPPORTED = ['off', 'high']
  const HIGH_MAX_SUPPORTED = ['off', 'high', 'max']
  // 默认五档（supportedLevels 未下发 / all-levels 预设的 pi 同源计算产物）
  const DEFAULT_FIVE = ['off', 'minimal', 'low', 'medium', 'high']

  describe('resolveThinkingValue（UI 档位 key → 发 runtime 的 value）', () => {
    it('high-max: max 档发 xhigh（展示是 max，传递 value 是 xhigh）', () => {
      expect(resolveThinkingValue('max', HIGH_MAX_MAP)).toBe('xhigh')
    })

    it('high-max: high 档发 high', () => {
      expect(resolveThinkingValue('high', HIGH_MAX_MAP)).toBe('high')
    })

    it('on-off: off 档发 off', () => {
      expect(resolveThinkingValue('off', ON_OFF_MAP)).toBe('off')
    })

    it('all-levels（map 空）→ 发 key 自身', () => {
      expect(resolveThinkingValue('medium', undefined)).toBe('medium')
    })
  })

  describe('resolveThinkingKey（runtime value → UI 档位 key）', () => {
    it('high-max: value xhigh → key max（反查）', () => {
      expect(resolveThinkingKey('xhigh', HIGH_MAX_MAP)).toBe('max')
    })

    it('high-max: value high → key high', () => {
      expect(resolveThinkingKey('high', HIGH_MAX_MAP)).toBe('high')
    })

    it('on-off: value off → key off', () => {
      expect(resolveThinkingKey('off', ON_OFF_MAP)).toBe('off')
    })

    it('all-levels（map 空）→ value 直接是 key', () => {
      expect(resolveThinkingKey('medium', undefined)).toBe('medium')
    })

    it('无法映射时 fallback 缺省 high（U6：动态最高档推导已删）；显式传 fallback 按传入档位集', () => {
      expect(resolveThinkingKey('unknown', HIGH_MAX_MAP)).toBe('high')
      // 调用方（Popover/sync）传 supportedLevels 推导的精确 fallback
      expect(resolveThinkingKey('unknown', HIGH_MAX_MAP, 'max')).toBe('max')
    })
  })

  describe('getDisplayLabel', () => {
    it('on-off 模式 high → 「开」', () => {
      expect(getDisplayLabel('high', ON_OFF_MAP)).toBe('开')
    })

    it('high-max 模式 high → 「高」（通用 label）', () => {
      expect(getDisplayLabel('high', HIGH_MAX_MAP)).toBe('高')
    })

    it('high-max 模式 max → 「最高」', () => {
      expect(getDisplayLabel('max', HIGH_MAX_MAP)).toBe('最高')
    })
  })

  describe('highestAvailableLevel（U6：入参是 supportedLevels 档位集）', () => {
    it('high-max 档位集 → max（强度最高的可用档）', () => {
      expect(highestAvailableLevel(HIGH_MAX_SUPPORTED)).toBe('max')
    })

    it('on-off 档位集 → high（强度最高的可用档）', () => {
      expect(highestAvailableLevel(ON_OFF_SUPPORTED)).toBe('high')
    })

    it('undefined → high（默认五档最高档）', () => {
      expect(highestAvailableLevel(undefined)).toBe('high')
    })

    it('返回值始终是合法 ThinkingLevel', () => {
      const validLevels = THINKING_LEVELS.map((o) => o.level)
      expect(validLevels).toContain(highestAvailableLevel(HIGH_MAX_SUPPORTED))
      expect(validLevels).toContain(highestAvailableLevel(ON_OFF_SUPPORTED))
      expect(validLevels).toContain(highestAvailableLevel(undefined))
    })
  })

  describe('isSameThinkingScheme（U6：入参是各自模型的 supportedLevels 档位集）', () => {
    it('on-off vs on-off → 同体系', () => {
      expect(isSameThinkingScheme(ON_OFF_SUPPORTED, ON_OFF_SUPPORTED)).toBe(true)
    })

    it('high-max vs high-max → 同体系', () => {
      expect(isSameThinkingScheme(HIGH_MAX_SUPPORTED, HIGH_MAX_SUPPORTED)).toBe(true)
    })

    it('on-off vs high-max → 跨体系（档位集不同：{off,high} ≠ {off,high,max}）', () => {
      expect(isSameThinkingScheme(ON_OFF_SUPPORTED, HIGH_MAX_SUPPORTED)).toBe(false)
    })

    it('high-max vs on-off → 跨体系（不对称也成立）', () => {
      expect(isSameThinkingScheme(HIGH_MAX_SUPPORTED, ON_OFF_SUPPORTED)).toBe(false)
    })

    it('未下发(undefined) vs 未下发 → 同体系（两者均归一默认五档）', () => {
      expect(isSameThinkingScheme(undefined, undefined)).toBe(true)
    })

    it('未下发(undefined) vs on-off → 跨体系（归一五档 ≠ {off,high}）', () => {
      expect(isSameThinkingScheme(undefined, ON_OFF_SUPPORTED)).toBe(false)
    })

    it('未下发(undefined) vs high-max → 跨体系', () => {
      expect(isSameThinkingScheme(undefined, HIGH_MAX_SUPPORTED)).toBe(false)
    })

    it('自定义档位集 {off,high,xhigh} vs on-off → 跨体系', () => {
      const custom = ['off', 'high', 'xhigh']
      expect(isSameThinkingScheme(custom, ON_OFF_SUPPORTED)).toBe(false)
    })

    it('同档位集乱序 → 同体系（归一后集合比较）', () => {
      expect(isSameThinkingScheme(['high', 'off', 'max'], HIGH_MAX_SUPPORTED)).toBe(true)
    })
  })
}

// ══════════ 来源：gen-stats-i18n.test.ts ══════════
{
  /** 运行时类型收窄（禁裸 as / 禁 any）：locale 段必须是可索引对象 */
  function asRecord(v: unknown): Record<string, unknown> {
    if (v == null || typeof v !== 'object') throw new Error('locale 段形状异常：期望对象')
    return v as Record<string, unknown>
  }

  /** 拍平嵌套对象为 '.' 路径集合 */
  function flattenKeys(obj: Record<string, unknown>, prefix = ''): Set<string> {
    const out = new Set<string>()
    for (const [k, v] of Object.entries(obj)) {
      const full = prefix ? `${prefix}.${k}` : k
      if (v != null && typeof v === 'object') {
        for (const sub of flattenKeys(asRecord(v), full)) out.add(sub)
      } else {
        out.add(full)
      }
    }
    return out
  }

  describe('genStats i18n zh/en 双侧对齐', () => {
    it('panel context 段 zh/en 拍平 key 集合完全一致（含 genStats* 全部 key）', () => {
      const zhKeys = flattenKeys(asRecord(asRecord(zhPanel).context))
      const enKeys = flattenKeys(asRecord(asRecord(enPanel).context))
      const missingInEn = [...zhKeys].filter((k) => !enKeys.has(k))
      const extraInEn = [...enKeys].filter((k) => !zhKeys.has(k))
      expect({ missingInEn, extraInEn }).toEqual({ missingInEn: [], extraInEn: [] })
    })

    it('genStats* key 逐 key 双侧存在且为字符串文案', () => {
      const zhCtx = asRecord(asRecord(zhPanel).context)
      const enCtx = asRecord(asRecord(enPanel).context)
      const genStatsKeys = Object.keys(zhCtx).filter((k) => k.startsWith('genStats'))
      // 防空转：本用例的意义在于 genStats 段确实存在（删光 key 时红）
      expect(genStatsKeys.length).toBeGreaterThan(0)
      for (const k of genStatsKeys) {
        expect(typeof zhCtx[k], `zh-CN panel.context.${k}`).toBe('string')
        expect(typeof enCtx[k], `en-US panel.context.${k}`).toBe('string')
      }
    })

    it('TTFT 卡 key 双侧齐（title/note；分布矩阵改造后行 label 走共用 genStatsWindow*/genStatsCol*）', () => {
      const zhCtx = asRecord(asRecord(zhPanel).context)
      const enCtx = asRecord(asRecord(enPanel).context)
      const TTFT_KEYS = ['genStatsTtftTitle', 'genStatsTtftNote'] as const
      for (const k of TTFT_KEYS) {
        expect(typeof zhCtx[k], `zh-CN panel.context.${k}`).toBe('string')
        expect(typeof enCtx[k], `en-US panel.context.${k}`).toBe('string')
      }
      // [HISTORICAL] 专属 p50 行 label（genStatsTtftDay/D7/D30）随分布矩阵退役——
      // 保留断言防「改回专属键」时静默重建双份语义文案
      for (const k of ['genStatsTtftDay', 'genStatsTtftD7', 'genStatsTtftD30'] as const) {
        expect(zhCtx[k], `zh-CN panel.context.${k} 应已退役`).toBeUndefined()
        expect(enCtx[k], `en-US panel.context.${k} 应已退役`).toBeUndefined()
      }
    })

    it('分布矩阵 key 双侧齐且非空（5 统计量列 + 3 窗口行 + P99 口径补句）', () => {
      const zhCtx = asRecord(asRecord(zhPanel).context)
      const enCtx = asRecord(asRecord(enPanel).context)
      const MATRIX_KEYS = [
        'genStatsColAvg',
        'genStatsColP50',
        'genStatsColP99',
        'genStatsColP99Note',
        'genStatsColMax',
        'genStatsColMin',
        'genStatsWindowDay',
        'genStatsWindowD7',
        'genStatsWindowD30',
      ] as const
      for (const k of MATRIX_KEYS) {
        expect(typeof zhCtx[k], `zh-CN panel.context.${k}`).toBe('string')
        expect(typeof enCtx[k], `en-US panel.context.${k}`).toBe('string')
        expect((zhCtx[k] as string).length, `zh-CN panel.context.${k} 空文案`).toBeGreaterThan(0)
        expect((enCtx[k] as string).length, `en-US panel.context.${k} 空文案`).toBeGreaterThan(0)
      }
      // 五列名互不相同（同文会让矩阵列头读不出区别）
      const zhLabels = ['genStatsColAvg', 'genStatsColP50', 'genStatsColP99', 'genStatsColMax', 'genStatsColMin']
        .map((k) => zhCtx[k])
      expect(new Set(zhLabels).size).toBe(5)
    })
  })
}
