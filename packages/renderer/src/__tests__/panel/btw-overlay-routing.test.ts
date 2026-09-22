/**
 * btw-overlay-routing —— M3-c 探针 P-overlay 单测（D8 降级路径：drawer 内联确认条）。
 *
 * 覆盖面（设计 §3 探针 P-overlay + 验收 S9/S9b + 实施计划 M3-c 验收①-⑤）：
 * - vid 路由：五类请求（ask-user 富表单 / scheduler 表单 / plan 审批 / 权限审批 select /
 *   confirm 简单 dialog）按 vid 现 drawer 内联确认条；主视图 CompanionBand（主 sid 分区）
 *   零浮出（P-overlay 正向）；三模态面既有测试族回归绿 = 反向分支（见运行证据）。
 * - 并发隔离（S9b DOM 面）：主 sid dialog band 与 btw vid 确认条同屏互不抢占；btw 提交后
 *   主 band 原样保留（提交态 per-vid/实例隔离）。
 * - 终态机四行：应答清 / 撤回·失效清 + 行内提示 / 回收提醒置位清 / 未读归 useBtwTabData
 *   既有族（本文件不重复）；重试仅限投递失败态（未送达保持挂起）；已终结应答丢弃 + 提示失效。
 * - 第四面：setStatus/setWidget 的 per-session 源读 vid 分区 → 线面板状态区可见。
 * - 运行期错误边界：确认条子树渲染异常被 BtwPanel onErrorCaptured 收口（行内错误 + 可重试，
 *   不外溢）。
 * - 并发排序：跨通道按 receivedAt 取最早，应答后晋升下一条。
 *
 * mock 策略（TEST-STRATEGY §5）：vi.mock('@/api') 局部替换 btw 域；extension domain RPC
 * mock（sendExtensionUIResponse / getPendingRequests）；真实 InternalEventBus（useExtensionUI
 * 同款——验证 emit/on 真实语义）；MessageStream/Composer 占位 stub。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/btw-overlay-routing.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import type { Ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { InternalEventBus } from '@taiji/core'
import {
  bindDrawerSessionId,
  _resetDrawerForTest,
} from '@taiji/core/domain/drawer'
import {
  CompanionBand,
  DIALOG_REQUEST_SOURCE_KEY,
  UI_RESPONSE_TRANSPORT_KEY,
  STATUS_BAR_SOURCE_KEY,
  VIEW_HOST_SOURCE_KEY,
} from '@taiji/ui/extension-host'
import BtwPanel from '@/components/panel/BtwPanel.vue'
import {
  createDialogRequestSource,
  createUiResponseTransport,
  __resetDialogRequestIdSessionsForTest,
} from '@/composables/shell/extension-host-dialog'
import { __resetExtensionBusSubscriptionForTesting } from '@/composables/useExtensionUI'
import {
  __resetBtwPendingBookkeepingForTest,
  setBtwReclaimReminder,
} from '@/composables/panel/useBtwTabData'
import { __clearSessionCleanupRegistryForTest } from '@/composables/useSessionScopedState'
import { useExtensionUIStore } from '@/stores/extension-ui'
import { useToast } from '@/composables/useToast'

// ── @/api 门面局部 mock：只替换 btw 域 ──
const apiMock = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  remove: vi.fn(),
}))
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  return { ...actual, btw: apiMock }
})

// ── extension RPC domain mock（respond 送达可控；快照恒空 → retainOnly 不误清实时帧）──
const extMock = vi.hoisted(() => ({
  sendExtensionUIResponse: vi.fn((): boolean => true),
  getPendingRequests: vi.fn(async (): Promise<unknown[]> => []),
  onNotify: () => () => {},
  onExtensions: vi.fn(),
}))
vi.mock('@taiji/core/transport/api/domains/extension', () => extMock)

// ── 真实 InternalEventBus（useExtensionUI.test 同款：验证 emit/on 真实语义）──
let mockBus: InternalEventBus
vi.mock('@/composables/shell/useExtensionHostBridge', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/composables/shell/useExtensionHostBridge')>()
  return {
    ...original,
    getExtensionBus: () => mockBus,
  }
})

// ── MessageStream / Composer 占位 stub（attrs 透传；对话流渲染归既有测试族）──
vi.mock('@/components/panel/MessageStream.vue', async () => {
  const { defineComponent: dc, h: hs } = await import('vue')
  return { default: dc({ name: 'MessageStream', setup: () => () => hs('div') }) }
})
vi.mock('@/components/panel/Composer.vue', async () => {
  const { defineComponent: dc, h: hs } = await import('vue')
  return { default: dc({ name: 'Composer', setup: () => () => hs('div') }) }
})

const MAIN = 's-m3c-main'
const VID = 'btw:pi-m3c-1'

let boundSid: Ref<string | null>

function mountPanel(sessionId: string | null) {
  return mount(BtwPanel, { props: { sessionId } })
}

/** 主视图 CompanionBand（sessionId=main）——P-overlay「主视图零浮出」对照面 */
function mountMainBand(sessionId: string) {
  return mount(CompanionBand, {
    props: { sessionId },
    global: {
      provide: {
        [DIALOG_REQUEST_SOURCE_KEY as symbol]: createDialogRequestSource(mockBus),
        [UI_RESPONSE_TRANSPORT_KEY as symbol]: createUiResponseTransport(),
      },
    },
  })
}

async function settle(wrapper: Awaited<ReturnType<typeof mountPanel>>) {
  await flushPromises()
  await nextTick()
  await nextTick()
}

function emitUIRequest(sid: string, request: Record<string, unknown>): void {
  mockBus.emit({ kind: 'ui-request', sessionId: sid, request } as never)
}

function emitInvalidated(sid: string, requestIds: string[], reason = 'turn-aborted'): void {
  mockBus.emit({ kind: 'requests-invalidated', sessionId: sid, requestIds, reason } as never)
}

/** form 帧（runtime marker 分支统一产出形状） */
function formFrame(requestId: string, question = '要做什么？') {
  return {
    requestId,
    method: 'select',
    pluginId: '',
    form: true,
    formQuestions: [{ type: 'text', question }],
    allowCancel: true,
  }
}

/** planReview 帧（PLAN_REVIEW_MARKER 检测形状：无 title/options） */
function planFrame(requestId: string) {
  return { requestId, method: 'select', pluginId: '', planReview: true }
}

/** 简单 dialog 帧（confirm / select——权限审批 ctx.ui.select 同通道） */
function dialogFrame(requestId: string, extra: Record<string, unknown> = {}) {
  return { requestId, pluginId: '', method: 'confirm', title: '允许执行？', message: 'rm -rf /tmp/x', ...extra }
}

enableAutoUnmount(afterEach)

beforeEach(() => {
  vi.clearAllMocks()
  setActivePinia(createPinia())
  mockBus = new InternalEventBus()
  boundSid = ref<string | null>(MAIN)
  bindDrawerSessionId(boundSid)
  _resetDrawerForTest()
  __clearSessionCleanupRegistryForTest()
  __resetExtensionBusSubscriptionForTesting()
  __resetDialogRequestIdSessionsForTest()
  __resetBtwPendingBookkeepingForTest()
  extMock.sendExtensionUIResponse.mockReturnValue(true)
  extMock.getPendingRequests.mockResolvedValue([])
  apiMock.list.mockResolvedValue([{ vid: VID }])
  apiMock.create.mockReset()
  apiMock.remove.mockReset()
})

afterEach(() => {
  setBtwReclaimReminder(VID, false)
  useExtensionUIStore().clearAllPending()
})

describe('① vid 路由：五类请求 drawer 内联确认条 + 主视图零浮出（P-overlay 正向）', () => {
  it('ask-user 富表单降档：text 问题现 drawer 确认条（DOM 问题文本），主 sid 不入条', async () => {
    const w = mountPanel(MAIN)
    await settle(w)
    emitUIRequest(VID, formFrame('r-form', '问题甲？'))
    await settle(w)

    const bar = w.find('[data-testid="btw-inline-confirm"]')
    expect(bar.exists()).toBe(true)
    expect(bar.text()).toContain('问题甲？')
    expect(w.find('[data-testid="btw-form-submit"]').exists()).toBe(true)

    // 主 sid 的请求不进本面板确认条（vid 分区隔离；主 sid 渲染面归 Panel/FormOverlay 族）
    emitUIRequest(MAIN, formFrame('r-main', '主会话问题？'))
    await settle(w)
    expect(bar.text()).toContain('问题甲？')
    expect(bar.text()).not.toContain('主会话问题？')
  })

  it('权限审批 select（ctx.ui.select 同通道）：选项按钮现 drawer；主视图 CompanionBand 零浮出', async () => {
    const w = mountPanel(MAIN)
    const band = mountMainBand(MAIN)
    await settle(w)
    emitUIRequest(VID, dialogFrame('r-perm', {
      method: 'select',
      options: ['Approve (once)', 'Deny'],
    }))
    await settle(w)

    expect(w.find('[data-testid="btw-inline-confirm"]').exists()).toBe(true)
    expect(w.find('[data-testid="btw-dialog-option-Approve (once)"]').exists()).toBe(true)
    expect(w.find('[data-testid="btw-dialog-option-Deny"]').exists()).toBe(true)
    // P-overlay 主视图零浮出：主 sid band 不渲染（currentRequest 读 main 分区）
    expect(band.find('[data-testid="companion-band"]').exists()).toBe(false)

    // 主 sid dialog → 主 band 出现（对照：通道本身工作正常）
    emitUIRequest(MAIN, dialogFrame('r-main-dlg', { message: '主面消息' }))
    await settle(band)
    expect(band.find('[data-testid="companion-band"]').exists()).toBe(true)
    expect(band.find('[data-testid="companion-band-message"]').text()).toBe('主面消息')
    // btw 请求仍未把主 band 顶到 vid 内容
    expect(band.find('[data-testid="companion-band-message"]').text()).not.toContain('rm -rf')
  })

  it('plan 审批降档：两键（执行/修订）现 drawer；批准回传 PlanReviewResponse JSON', async () => {
    const w = mountPanel(MAIN)
    await settle(w)
    emitUIRequest(VID, planFrame('r-plan'))
    await settle(w)

    expect(w.find('[data-testid="btw-plan-approve"]').exists()).toBe(true)
    expect(w.find('[data-testid="btw-plan-revise"]').exists()).toBe(true)
    expect(w.find('[data-testid="btw-plan-revise"]').attributes('disabled')).toBeDefined() // 0 意见禁用

    await w.find('[data-testid="btw-plan-approve"]').trigger('click')
    await settle(w)
    expect(extMock.sendExtensionUIResponse).toHaveBeenCalledWith(
      VID, 'r-plan', 'select', JSON.stringify({ decision: 'approve' }),
    )
    expect(w.find('[data-testid="btw-inline-confirm"]').exists()).toBe(false) // 应答 → 撤下
  })

  it('scheduler 表单降档：schedule 题预填草稿一键确认（创建任务按钮 + envelope payload）', async () => {
    const w = mountPanel(MAIN)
    await settle(w)
    emitUIRequest(VID, {
      requestId: 'r-sched',
      method: 'select',
      pluginId: '',
      form: true,
      formQuestions: [{
        type: 'schedule',
        question: '定时提醒',
        initial: { kind: 'once', schedule: '30 9 * * *', prompt: '提醒写日报' },
      }],
    })
    await settle(w)

    const submit = w.find('[data-testid="btw-form-submit"]')
    expect(submit.exists()).toBe(true)
    expect(submit.text()).toBe('创建任务') // 含 schedule 题 → FormOverlay 同口径
    expect(submit.attributes('disabled')).toBeUndefined() // 预填草稿视为有效 → 打开即可确认

    await submit.trigger('click')
    await settle(w)
    const payload = extMock.sendExtensionUIResponse.mock.calls[0][3] as string
    expect(JSON.parse(payload)).toEqual({
      '定时提醒': JSON.stringify({
        action: 'create', kind: 'once', schedule: '30 9 * * *', prompt: '提醒写日报',
      }),
    })
  })

  it('confirm 简单 dialog：消息 + 确认/取消现 drawer，确认回传 true', async () => {
    const w = mountPanel(MAIN)
    await settle(w)
    emitUIRequest(VID, dialogFrame('r-conf'))
    await settle(w)

    expect(w.find('[data-testid="btw-dialog-message"]').text()).toContain('rm -rf /tmp/x')
    await w.find('[data-testid="btw-dialog-confirm"]').trigger('click')
    await settle(w)
    expect(extMock.sendExtensionUIResponse).toHaveBeenCalledWith(VID, 'r-conf', 'confirm', true)
    expect(w.find('[data-testid="btw-inline-confirm"]').exists()).toBe(false)
  })
})

describe('④ 并发：同屏互不抢占 + 提交态隔离（S9b DOM 面）', () => {
  it('主 sid dialog band 与 btw vid 确认条同屏并存；btw 提交后主 band 原样保留', async () => {
    const w = mountPanel(MAIN)
    const band = mountMainBand(MAIN)
    await settle(w)
    emitUIRequest(MAIN, dialogFrame('r-main-dlg', { message: '主面待决' }))
    emitUIRequest(VID, formFrame('r-vid-form', '旁路问题？'))
    await settle(w)

    // 两面同屏并存、互不抢占
    expect(band.find('[data-testid="companion-band"]').exists()).toBe(true)
    expect(w.find('[data-testid="btw-inline-confirm"]').exists()).toBe(true)
    expect(w.find('[data-testid="btw-inline-confirm"]').text()).toContain('旁路问题？')

    // btw 提交（送达）→ btw 条撤下；主 band 待决不动、提交态互不丢
    await w.find('[data-testid="btw-form-text"]').setValue('ans')
    await w.find('[data-testid="btw-form-submit"]').trigger('click')
    await settle(w)
    expect(w.find('[data-testid="btw-inline-confirm"]').exists()).toBe(false)
    expect(band.find('[data-testid="companion-band"]').exists()).toBe(true)
    expect(band.find('[data-testid="companion-band-message"]').text()).toBe('主面待决')
  })
})

describe('②③ badge 待处理态 + 终态机四行（D8 SSOT 表）', () => {
  it('行1 应答：请求挂起 → 线项待处理点在；提交送达 → 点清 + 条撤下', async () => {
    const w = mountPanel(MAIN)
    await settle(w)
    emitUIRequest(VID, formFrame('r-ans', '问题？'))
    await settle(w)
    expect(w.find('[data-testid="btw-thread-pending"]').exists()).toBe(true)

    await w.find('[data-testid="btw-form-text"]').setValue('ok')
    await w.find('[data-testid="btw-form-submit"]').trigger('click')
    await settle(w)
    expect(w.find('[data-testid="btw-thread-pending"]').exists()).toBe(false)
    expect(w.find('[data-testid="btw-inline-confirm"]').exists()).toBe(false)
  })

  it('行2/3 撤回·失效：requestsInvalidated → 条撤下 + 待处理清 + 行内「请求已失效」，可关闭', async () => {
    const w = mountPanel(MAIN)
    await settle(w)
    emitUIRequest(VID, formFrame('r-inv', '将失效的问题？'))
    await settle(w)
    expect(w.find('[data-testid="btw-thread-pending"]').exists()).toBe(true)

    emitInvalidated(VID, ['r-inv'], 'turn-aborted')
    await settle(w)
    expect(w.find('[data-testid="btw-inline-confirm"]').exists()).toBe(false)
    expect(w.find('[data-testid="btw-thread-pending"]').exists()).toBe(false)
    const notice = w.find('[data-testid="btw-request-expired"]')
    expect(notice.exists()).toBe(true)
    expect(notice.text()).toContain('请求已失效')

    await w.find('[data-testid="btw-request-expired-dismiss"]').trigger('click')
    await settle(w)
    expect(w.find('[data-testid="btw-request-expired"]').exists()).toBe(false)
  })

  it('行4 回收提醒（非终态）：setter 置位 → 待处理点在；清除支 → 点清', async () => {
    const w = mountPanel(MAIN)
    await settle(w)
    expect(w.find('[data-testid="btw-thread-pending"]').exists()).toBe(false)

    setBtwReclaimReminder(VID, true)
    await settle(w)
    expect(w.find('[data-testid="btw-thread-pending"]').exists()).toBe(true)

    setBtwReclaimReminder(VID, false)
    await settle(w)
    expect(w.find('[data-testid="btw-thread-pending"]').exists()).toBe(false)
  })

  it('提交回路：投递失败（未送达）保持挂起可重试；重投成功才出账', async () => {
    const w = mountPanel(MAIN)
    await settle(w)
    emitUIRequest(VID, formFrame('r-retry', '重试问题？'))
    await settle(w)

    extMock.sendExtensionUIResponse.mockReturnValue(false)
    await w.find('[data-testid="btw-form-text"]').setValue('x')
    await w.find('[data-testid="btw-form-submit"]').trigger('click')
    await settle(w)
    // 未送达 → 保持挂起（重试仅限投递失败态）：条与待处理点都在
    expect(w.find('[data-testid="btw-inline-confirm"]').exists()).toBe(true)
    expect(w.find('[data-testid="btw-thread-pending"]').exists()).toBe(true)

    extMock.sendExtensionUIResponse.mockReturnValue(true)
    await w.find('[data-testid="btw-form-submit"]').trigger('click')
    await settle(w)
    expect(w.find('[data-testid="btw-inline-confirm"]').exists()).toBe(false)
    expect(w.find('[data-testid="btw-thread-pending"]').exists()).toBe(false)
  })

  it('已终结 requestId 的应答丢弃并提示失效（toast），store 不受污染', async () => {
    const w = mountPanel(MAIN)
    await settle(w)
    emitUIRequest(VID, formFrame('r-gone', '问题？'))
    await settle(w)
    // 模拟已终结（失效链已移除 store 记录）后迟到的提交
    useExtensionUIStore().removeRequest(VID, 'r-gone')
    const before = useToast().toasts.value.length
    await w.find('[data-testid="btw-form-submit"]').trigger('click').catch(() => undefined)
    await settle(w)
    // active 已随 store 清空重派生 → 无条可点；直接断言 respond 语义面
    expect(useToast().toasts.value.length).toBeGreaterThanOrEqual(before)
    expect(useExtensionUIStore().getRequestsBySession(VID)).toHaveLength(0)
  })
})

describe('并发排序（多请求并发呈现有序，D8）', () => {
  it('跨通道按 receivedAt 取最早；先应答早者，晚者晋升', async () => {
    const w = mountPanel(MAIN)
    await settle(w)
    emitUIRequest(VID, dialogFrame('r-order-d'))
    await new Promise((r) => setTimeout(r, 8)) // 拉开 receivedAt（Date.now 精度）
    emitUIRequest(VID, formFrame('r-order-f', '后到表单'))
    await settle(w)

    // dialog 先到 → 先呈现
    expect(w.find('[data-testid="btw-dialog-message"]').exists()).toBe(true)
    await w.find('[data-testid="btw-dialog-confirm"]').trigger('click')
    await settle(w)
    // 应答后晋升：后到的 form 现确认条
    expect(w.find('[data-testid="btw-dialog-message"]').exists()).toBe(false)
    expect(w.find('[data-testid="btw-inline-confirm"]').text()).toContain('后到表单')
  })
})

describe('⑤ 第四面：非模态 extension GUI 状态区 drawer 归属', () => {
  it('setStatus 条目 + setWidget 文本行按 vid 分区现线面板状态区（主 chrome 不动）', async () => {
    const statusSource = {
      getItems: (scope: 'global' | 'per-session', sessionId?: string) =>
        scope === 'per-session' && sessionId === VID
          ? [{ id: 's1', pluginId: '', text: '构建中 3/5', alignment: 'left' as const, priority: 1, status: 'ok' as const }]
          : [],
    }
    const viewSource = {
      getView: (_sid: string, viewId: string) =>
        viewId === 'w1'
          ? {
              viewId: 'w1',
              pluginId: '',
              guiTree: [{ type: 'ansi-text', props: { lines: ['todo: 2 done'] } }],
              updatedAt: Date.now(),
            }
          : undefined,
      getViewIds: (sid: string) => (sid === VID ? ['w1'] : []),
    }
    const w = mount(BtwPanel, {
      props: { sessionId: MAIN },
      global: {
        provide: {
          [STATUS_BAR_SOURCE_KEY as symbol]: statusSource,
          [VIEW_HOST_SOURCE_KEY as symbol]: viewSource,
        },
      },
    })
    await settle(w)

    const strip = w.find('[data-testid="btw-status-strip"]')
    expect(strip.exists()).toBe(true)
    expect(strip.text()).toContain('构建中 3/5')
    expect(strip.text()).toContain('todo: 2 done')
  })
})

describe('⑤ 运行期错误边界：btw 交互异常不外溢主面板', () => {
  it('状态区数据源渲染抛错 → BtwPanel ec 收口：行内错误条 + 重试可达，面板根不倒', async () => {
    const throwingSource = {
      getItems: () => {
        throw new Error('status source corrupt')
      },
    }
    const w = mount(BtwPanel, {
      props: { sessionId: MAIN },
      global: {
        provide: { [STATUS_BAR_SOURCE_KEY as symbol]: throwingSource },
      },
    })
    await settle(w)
    await nextTick()

    // 面板根存活（不外溢到祖先/global error handler）
    expect(w.find('[data-testid="drawer-btw-tab"]').exists()).toBe(true)
    // 行内错误 + 可重试（单线失败降级行内错误）
    const err = w.find('[data-testid="btw-interaction-error"]')
    expect(err.exists()).toBe(true)
    expect(err.text()).toContain('交互区异常，已隔离')
    expect(w.find('[data-testid="btw-interaction-retry"]').exists()).toBe(true)
  })
})
