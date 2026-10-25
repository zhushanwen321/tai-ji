// ChatScreen v2 组件测试（remote-use-mobile-v2 §6.21/§6.14/§7.1 / 验收条款 2-4）。
//
// 锁定七组契约（三视角：DOM 断言为使用者面，接线断言为构建者面）：
//   ① 首屏冒烟：页头五件 + 消息流（观察者面）；模型 chip = liveState 权威值 + 思考档短词
//     （mobile.model.level 全路径 i18n，七值抽验段值 high 与段外值 xhigh——A8 缺陷锁定）
//   ② 回合计时（§6.21）：仅生成中显示（未订阅构造性不显示）+「已观察」措辞 + 秒级刷新 +
//     回合终态消失；步数 = 本回合工具完成计数
//   ③ 出错条（§6.14 / V-3 主路径）：尾 error 消息 + 非活跃 → 条显示；点重试 →
//     editAndResend(最后一条 user 消息) 命中 + 「重试本轮」通知插真实分区（§6.20）；
//     生成中条结构性不在场（isActive guard 的 UI 侧）
//   ④ 待回答条/待授权条（§6.5/§6.18 消费半）：条点击 openSheet（幂等）；Composer 互斥 =
//     仅 ask-user form（planReview 并存契约——mobile-form.spec 锁定，互斥面禁扩大）
//   ⑤ dead 态只读形态（§5.2「聊天历史只读、输入条隐藏」/ A11 契约缺口）：status=dead →
//     Composer 隐藏 + 只读提示条在场；非 dead 互斥面不扩大
//   ⑥ 草稿第三条边界（§7.1）：路由离开 chat → 目的域清当前会话草稿；connect 不清（跨断线保留）
//   ⑦ M-7/M-8 对账 DOM 断言：UserBubble 撤回钮常显 + 点击 revokeMessage 命中；运行中 bash
//     停止钮在场 + 点击 abortBash 命中（v1 MobileMessageStream:65-72 接线重写不丢失）
//
// mock 策略（对齐 composer.test 先例）：app-runtime 部分模块级 mock（chatStore 保留真实
// 分区——通知/消息播种断言消费真实 store；仅 isActive 派生输入可注入）；useChatInstance
// 四方法 mock；sessions-runtime/sheet-manager/route 全真实（草稿边界与 Sheet 槽位断言真状态）。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { resetChatModuleStateForTest } from '@taiji/core'
import type { Message } from '@taiji/shared'
import ChatScreen from '../ChatScreen.vue'
import { i18n } from '../../i18n'
import { chatStore, liveStateStore, sessionStore } from '../../shell/app-runtime'
import { draftOf, resetSessionsRuntimeForTesting, setDraft } from '../../shell/sessions-runtime'
import { activeSheet, resetSheetManagerForTesting } from '../../shell/sheet-manager'
import { resetRouteForTesting, shellRoute } from '../../shell/route'

const {
  editAndResendMock,
  revokeMessageMock,
  abortBashMock,
  chatIsActive,
} = vi.hoisted(() => ({
  editAndResendMock: vi.fn<(sid: string, userMessageId: string, segments: unknown[]) => Promise<boolean>>(),
  revokeMessageMock: vi.fn<(sid: string, targetId: string) => Promise<void>>(),
  abortBashMock: vi.fn<(sid: string) => Promise<void>>(),
  // 容器：mock 工厂内填充 Vue ref（响应式源——computed isActive 依赖追踪需要真 ref，
  // 普通对象属性读取不触发重算，终态翻转用例会恒真）
  chatIsActive: { current: null as { value: boolean } | null },
}))

vi.mock('../../shell/app-runtime', async (importOriginal) => {
  const { ref } = await import('vue')
  const actual = await importOriginal<typeof import('../../shell/app-runtime')>()
  const isActiveRef = ref(false)
  chatIsActive.current = isActiveRef
  return {
    ...actual,
    chatStore: {
      ...actual.chatStore,
      // 回合计时/出错条/stop 键的派生输入（§6.21 仅生成中显示的驱动源）；分区保留真实
      isActive: () => isActiveRef.value,
    },
    useChatInstance: {
      ...actual.useChatInstance,
      editAndResend: editAndResendMock,
      revokeMessage: revokeMessageMock,
      abortBash: abortBashMock,
    },
  }
})

const SID = 'sid-chat-screen'

function userMsg(id: string, text: string): Message {
  return { id, role: 'user', content: [{ type: 'text', text }], status: 'complete', timestamp: Date.now() }
}

function assistantError(id: string, errorText: string): Message {
  return { id, role: 'assistant', content: '', error: errorText, status: 'error', timestamp: Date.now() } as Message
}

/** 运行中 bash 消息（toRenderItems 判定：role=system + bashExecution 字段 → BashOutputBlock，
 *  streaming 态渲染取消钮——renderer BashOutputBlock.test 同形态） */
function runningBashMsg(id: string): Message {
  return {
    id,
    role: 'system',
    content: '',
    status: 'streaming',
    timestamp: Date.now(),
    bashExecution: {
      command: 'sleep 10',
      output: '',
      exitCode: null,
      cancelled: false,
      truncated: false,
      excludeFromContext: false,
      timestamp: Date.now(),
    },
  } as Message
}

function assistantWithTools(id: string, statuses: Array<'running' | 'completed'>): Message {
  return {
    id,
    role: 'assistant',
    content: '',
    status: 'streaming',
    timestamp: Date.now(),
    toolCalls: statuses.map((status, i) => ({
      id: `${id}-t${i}`,
      toolName: 'Read',
      input: {},
      status,
      ...{},
    })),
  } as Message
}

/** isActive 派生输入置位（工厂内 Vue ref——computed 依赖追踪的响应源） */
function setChatActive(active: boolean): void {
  if (chatIsActive.current === null) throw new Error('mock 工厂未初始化 chatIsActive')
  chatIsActive.current.value = active
}

async function mountScreen(props?: Partial<{ askPending: boolean; formPending: boolean; permissionPending: boolean }>): Promise<VueWrapper> {
  const wrapper = mount(ChatScreen, {
    props: {
      sessionId: SID,
      askPending: props?.askPending ?? false,
      formPending: props?.formPending ?? false,
      permissionPending: props?.permissionPending ?? false,
    },
    global: { plugins: [i18n] },
  })
  await flushPromises()
  return wrapper
}

function tOf(key: string, params?: Record<string, unknown>): string {
  return (i18n.global.t as (key: string, params?: Record<string, unknown>) => string)(key, params)
}

beforeEach(() => {
  resetChatModuleStateForTest()
  chatStore.disposeSession(SID)
  resetSessionsRuntimeForTesting()
  resetSheetManagerForTesting()
  resetRouteForTesting()
  editAndResendMock.mockReset()
  editAndResendMock.mockResolvedValue(true)
  revokeMessageMock.mockReset()
  revokeMessageMock.mockResolvedValue(undefined)
  abortBashMock.mockReset()
  abortBashMock.mockResolvedValue(undefined)
  setChatActive(false)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('首屏冒烟（观察者面）', () => {
  it('页头五件 + 消息流 + Composer 关键交互元素在场', async () => {
    const wrapper = await mountScreen()
    for (const testid of [
      'chat-header',
      'chat-back',
      'chat-title',
      'chat-model-chip',
      'chat-more',
      'mobile-message-stream',
      'mobile-composer',
    ]) {
      expect(wrapper.find(`[data-testid="${testid}"]`).exists(), testid).toBe(true)
    }
    wrapper.unmount()
  })

  it('标题 = 会话 label；模型 chip = liveState 权威值 + 思考档短词', async () => {
    chatStore.disposeSession(SID)
    const wrapper = await mountScreen()
    // 无 summary（sessionList 无该会话）→ 标题兜底「未命名会话」；liveState 缺失 → chip 显式未知占位
    expect(wrapper.get('[data-testid="chat-title"]').text()).toBe(tOf('mobile.chat.untitled'))
    expect(wrapper.get('[data-testid="chat-model-chip"]').text()).toBe(tOf('mobile.model.unknown'))
    wrapper.unmount()
  })

  it('模型 chip 思考档 = 短词（mobile.model.level 全路径 i18n，非原始档位值）——七值抽验段值 high 与段外值 xhigh', async () => {
    // liveState 权威值播种（真实 store 写入口；modelId 为 core 契约复合串形态）
    liveStateStore.applyLiveState(SID, { modelId: 'prov-mock/mock-x', thinkingLevel: 'high' })
    const wrapper = await mountScreen()
    const chip = wrapper.get('[data-testid="chat-model-chip"]')
    expect(chip.text()).toBe(`prov-mock/mock-x · ${tOf('mobile.model.level.high')}`)

    // 段外值（xhigh → 超高）：短词表覆盖七值，非段值同样显短词不显原始值
    liveStateStore.applyLiveState(SID, { modelId: 'prov-mock/mock-x', thinkingLevel: 'xhigh' })
    await nextTick()
    expect(wrapper.get('[data-testid="chat-model-chip"]').text()).toBe(
      `prov-mock/mock-x · ${tOf('mobile.model.level.xhigh')}`,
    )
    wrapper.unmount()
  })
})

describe('回合计时与步数（§6.21 / 验收条款 3）', () => {
  it('非生成中（未订阅/空闲同口径：isActive false）→ 计时不显示（「仅订阅态显示」的构造性落点）', async () => {
    const wrapper = await mountScreen()
    expect(wrapper.find('[data-testid="chat-observed-timer"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('生成中：挂载即显示「已观察 MM:SS」措辞（接入时已在跑 = 观察起点即接入时刻）+ fake 推进秒级刷新', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-26T00:00:00Z'))
    setChatActive(true)
    const wrapper = await mountScreen()

    const timer = wrapper.get('[data-testid="chat-observed-timer"]')
    expect(timer.text()).toBe(tOf('mobile.chat.observed', { duration: '00:00' }))

    vi.advanceTimersByTime(65_000)
    await nextTick()
    expect(wrapper.get('[data-testid="chat-observed-timer"]').text()).toBe(
      tOf('mobile.chat.observed', { duration: '01:05' }),
    )
    wrapper.unmount()
  })

  it('回合终态（isActive 翻 false）→ 计时消失', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-26T00:00:00Z'))
    setChatActive(true)
    const wrapper = await mountScreen()
    expect(wrapper.find('[data-testid="chat-observed-timer"]').exists()).toBe(true)

    setChatActive(false)
    await nextTick()
    await nextTick()
    expect(wrapper.find('[data-testid="chat-observed-timer"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('步数 = 本回合工具完成计数：running 不计、completed 计入（§6.21 步数口径）', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-26T00:00:00Z'))
    setChatActive(true)
    // 先挂载（观察锚点 = 空分区尾部 index 0）再播种回合消息（工具调用全在锚点之后）
    const wrapper = await mountScreen()
    chatStore.hydrate(SID, [assistantWithTools('t1', ['completed', 'completed', 'running'])])
    await nextTick()
    await nextTick()

    expect(wrapper.get('[data-testid="chat-step-count"]').text()).toBe(
      tOf('mobile.chat.steps', { count: 2 }),
    )
    wrapper.unmount()
  })
})

describe('出错条与重试（§6.14 / V-3 主路径 / 验收条款 4 通知半）', () => {
  it('尾消息 assistant error + 非活跃 → 失败条显示（错误文本可见）+ 重试钮在场', async () => {
    chatStore.hydrate(SID, [userMsg('u1', '帮我校验'), assistantError('e1', '引擎进程异常退出')])
    const wrapper = await mountScreen()

    const bar = wrapper.find('[data-testid="chat-turn-error-bar"]')
    expect(bar.exists()).toBe(true)
    expect(wrapper.get('[data-testid="chat-turn-error-text"]').text()).toBe('引擎进程异常退出')
    expect(wrapper.find('[data-testid="chat-turn-retry"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('点重试 → editAndResend(最后一条 user 消息 id, segments 原文) 命中 + 「重试本轮」通知插真实分区', async () => {
    chatStore.hydrate(SID, [userMsg('u1', '帮我校验'), assistantError('e1', '引擎进程异常退出')])
    const wrapper = await mountScreen()

    await wrapper.get('[data-testid="chat-turn-retry"]').trigger('click')
    await flushPromises()

    expect(editAndResendMock).toHaveBeenCalledTimes(1)
    expect(editAndResendMock).toHaveBeenCalledWith(SID, 'u1', [{ type: 'text', text: '帮我校验' }])
    // 通知半（§6.20）：真实分区尾部 system 行——appendSystemNotice 首个生产消费链路的第二个触发点
    const msgs = chatStore.getMessages(SID)
    const last = msgs[msgs.length - 1]
    expect(last?.role).toBe('system')
    expect(String(last?.content)).toBe(tOf('mobile.notices.turnRetried'))
    wrapper.unmount()
  })

  it('生成中（isActive）→ 出错条结构性不在场（editAndResend isActive guard 的 UI 侧——重试钮不可达）', async () => {
    setChatActive(true)
    chatStore.hydrate(SID, [userMsg('u1', '帮我校验'), assistantError('e1', '引擎进程异常退出')])
    const wrapper = await mountScreen()

    expect(wrapper.find('[data-testid="chat-turn-error-bar"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('待回答条 / 待授权条 / Composer 互斥（§6.5/§7.1）', () => {
  it('askPending → 待回答条在场；点击 → openSheet(form)（sheet-manager 单例槽位命中）', async () => {
    const wrapper = await mountScreen({ askPending: true })

    expect(wrapper.find('[data-testid="chat-ask-bar"]').exists()).toBe(true)
    await wrapper.get('[data-testid="chat-ask-bar"]').trigger('click')
    expect(activeSheet.value).toBe('form')
    wrapper.unmount()
  })

  it('Composer 互斥面 = 仅 ask-user form：formPending → Composer 隐藏；planReview 形态（askPending ∧ ¬formPending）→ 条与 Composer 并存（mobile-form.spec 锁定契约）', async () => {
    const formOnly = await mountScreen({ askPending: true, formPending: true })
    expect(formOnly.find('[data-testid="mobile-composer"]').exists()).toBe(false)
    formOnly.unmount()

    const planReviewShape = await mountScreen({ askPending: true, formPending: false })
    expect(planReviewShape.find('[data-testid="chat-ask-bar"]').exists()).toBe(true)
    expect(planReviewShape.find('[data-testid="mobile-composer"]').exists()).toBe(true)
    planReviewShape.unmount()
  })

  it('permissionPending → 待授权条在场；点击 → openSheet(permission)；Composer 不隐藏（权限条与输入并存）', async () => {
    const wrapper = await mountScreen({ permissionPending: true })

    expect(wrapper.find('[data-testid="chat-permission-bar"]').exists()).toBe(true)
    await wrapper.get('[data-testid="chat-permission-bar"]').trigger('click')
    expect(activeSheet.value).toBe('permission')
    expect(wrapper.find('[data-testid="mobile-composer"]').exists()).toBe(true)
    wrapper.unmount()
  })
})

describe('dead 态只读形态（§5.2「聊天历史只读、输入条隐藏」/ A11 契约缺口）', () => {
  it('会话派生 status = dead → Composer 隐藏（契约字面「输入条隐藏」）+ 只读提示条在场', async () => {
    sessionStore.applySnapshot({
      groups: [
        {
          cwd: '/tmp/dead-proj',
          sessions: [
            { id: SID, label: '已退出的会话', cwd: '/tmp/dead-proj', status: 'dead', lastActiveAt: Date.now() },
          ],
        },
      ],
    })
    const wrapper = await mountScreen()

    expect(wrapper.find('[data-testid="mobile-composer"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="chat-dead-readonly"]').text()).toBe(tOf('mobile.chat.deadReadOnly'))
    // dead 摘要在场（历史只读可见的同一数据源）：标题走 summary label 而非未知占位
    expect(wrapper.get('[data-testid="chat-title"]').text()).toBe('已退出的会话')
    wrapper.unmount()
  })

  it('非 dead（列表空 = 常规态）→ Composer 在场、只读提示条不在场（互斥面不扩大）', async () => {
    // 显式空快照覆盖：sessionStore 是模块级单例，前一用例播种的 dead 条目不随 beforeEach 清退
    sessionStore.applySnapshot({ groups: [] })
    const wrapper = await mountScreen()
    expect(wrapper.find('[data-testid="mobile-composer"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="chat-dead-readonly"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('草稿第三条边界（§7.1「返回列表即丢弃」）', () => {
  it('路由离开 chat → 目的域：当前会话草稿条目清空（popstate 单点覆盖返回钮/侧滑/系统返回键）', async () => {
    shellRoute.value = 'chat'
    setDraft(SID, '即将被丢弃的草稿')
    const wrapper = await mountScreen()
    expect(draftOf(SID)).toBe('即将被丢弃的草稿')

    shellRoute.value = 'sessions'
    await nextTick()
    expect(draftOf(SID)).toBe('')
    wrapper.unmount()
  })

  it('路由离开 chat → connect（验身失效）：草稿保留（§7.1 边界一「跨断线保留」不被误清）', async () => {
    shellRoute.value = 'chat'
    setDraft(SID, '断线也不丢的草稿')
    const wrapper = await mountScreen()

    shellRoute.value = 'connect'
    await nextTick()
    expect(draftOf(SID)).toBe('断线也不丢的草稿')
    wrapper.unmount()
  })
})

describe('M-7/M-8 对账 DOM 断言（验收条款 2：老能力重写不丢失）', () => {
  it('M-7：user 气泡撤回钮常显（msg-revoke-button）+ 点击 → useChatInstance.revokeMessage(sid, msgId) 命中', async () => {
    chatStore.hydrate(SID, [userMsg('u1', '可撤回的消息')])
    const wrapper = await mountScreen()

    const revokeBtn = wrapper.find('[data-testid="msg-revoke-button"]')
    expect(revokeBtn.exists()).toBe(true)
    await revokeBtn.trigger('click')
    await flushPromises()
    expect(revokeMessageMock).toHaveBeenCalledTimes(1)
    expect(revokeMessageMock).toHaveBeenCalledWith(SID, 'u1')
    wrapper.unmount()
  })

  it('M-8：运行中 bash 的停止钮在场（bash-cancel-btn）+ 点击 → useChatInstance.abortBash(sid) 命中', async () => {
    chatStore.hydrate(SID, [runningBashMsg('b1')])
    const wrapper = await mountScreen()
    await flushPromises()

    const cancelBtn = wrapper.find('[data-testid="bash-cancel-btn"]')
    expect(cancelBtn.exists(), '运行中 bash 停止钮应随 ChatView 全链渲染在场').toBe(true)
    await cancelBtn.trigger('click')
    await flushPromises()
    expect(abortBashMock).toHaveBeenCalledTimes(1)
    expect(abortBashMock).toHaveBeenCalledWith(SID)
    wrapper.unmount()
  })
})
