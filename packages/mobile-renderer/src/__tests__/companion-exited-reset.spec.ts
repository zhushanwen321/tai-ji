// 移动壳 session.exited 分通道重置编排（remote-use U6 / D5 exited 分区清理段 + 「exited
// 清理与拦截解绑」段）。
//
// 锁定三个行为面：
//   分通道清理 —— exited 编排出口（companion-bridge）：dialog 通道 queue.resetFor（band
//                消失）+ form 通道 Map 具名清理（form 卡消失、composer 恢复）——M8 防御：
//                死会话残留请求不重弹、作答不发给新进程后石沉大海（V18 正面）
//   拦截解绑   —— 重置非销毁：重置后同 sid 新 dialog 请求立即可见（V18 负面变体）——若
//                误用销毁语义（cleanup → deletedSids），恢复期新请求被 updateFor 首行
//                静默拦截，band 不再出现，本断言红
//   销毁语义排除 —— 编排未调 triggerSessionCleanups：注册表 canary 不被触发
//
// mock 策略：请求注入经 __testing.mobileExtensionBus.emit（mobile-companion-band.spec /
// mobile-form.spec 同款先例——生产订阅面 = dialog/form 通道 bus 订阅）；挂载真实 App
// （provide 链 + CompanionBand 句柄登记走生产通路，exit 出口的 dialog 侧可观测性由此成立）。
// form 通道分区与 queue 句柄为模块级单例，beforeEach/afterEach 经 __testing 重置。
//
// 运行：cd packages/mobile-renderer && npx vitest run src/__tests__/companion-exited-reset.spec.ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import App from '../App.vue'
import { i18n } from '../i18n'
import { registerSessionCleanup } from '@taiji/core/foundation/use-session-scoped-state'
import { sessionStore } from '../shell/app-runtime'
import {
  __testing,
  resetCompanionChannelsForExitedSession,
} from '../shell/companion-bridge'
import { hasConnectedOnce, shellConnectionState } from '../shell/connection-view'

// chat 视图挂载触发 connected 边沿的 form 快照对账（getPendingRequests RPC）——测试环境
// WS 未连接恒 reject 产生 console 噪音，mock 为空快照（mobile-form.spec 同款先例；
// 本 spec 不消费回传与对账产物，mock 零行为影响）
vi.mock('@taiji/core/transport/api/domains/extension', () => ({
  sendExtensionUIResponse: vi.fn((): boolean => true),
  getPendingRequests: vi.fn(async () => []),
}))

const SID = 'sid-u6-exited'

function mountApp(): VueWrapper {
  return mount(App, { global: { plugins: [i18n] } })
}

/** 进入聊天视图（connected + hasConnectedOnce + 激活 session + 切 chat tab；mobile-form.spec 同款） */
async function mountChatView(sessionId: string): Promise<VueWrapper> {
  hasConnectedOnce.value = true
  shellConnectionState.value = 'connected'
  sessionStore.setActiveId(sessionId)
  const wrapper = mountApp()
  await wrapper.get('[data-testid="mobile-tab-chat"]').trigger('click')
  return wrapper
}

/** 发一条 bridge 归一后的 dialog 类 ui-request（confirm 形态；mobile-companion-band.spec 同款） */
function emitDialogRequest(sessionId: string, requestId: string): void {
  __testing.mobileExtensionBus.emit({
    kind: 'ui-request',
    sessionId,
    request: {
      requestId,
      pluginId: 'tasks',
      kind: 'confirm',
      method: 'confirm',
      title: `确认执行？(${requestId})`,
      message: '该操作将应用变更',
    },
  })
}

/** 发一条 form 类 ui-request（C4 放行面，form 帧；mobile-form.spec 同款） */
function emitFormRequest(sessionId: string, requestId: string): void {
  __testing.mobileExtensionBus.emit({
    kind: 'ui-request',
    sessionId,
    request: {
      requestId,
      pluginId: '',
      kind: 'select',
      method: 'select',
      form: true,
      formQuestions: [
        { type: 'choice', header: 'db', question: '用哪个数据库？', options: [{ label: 'pg' }, { label: 'mysql' }] },
      ],
    },
  })
}

describe('移动壳 exited 分通道重置编排（U6）', () => {
  let wrapper: VueWrapper | null = null

  beforeEach(() => {
    __testing.resetFormRequestsForTest()
    __testing.resetErrorBarForTest()
    __testing.resetDialogQueueHandleForTest()
    shellConnectionState.value = 'connecting'
    hasConnectedOnce.value = false
    sessionStore.setActiveId(null)
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    __testing.resetFormRequestsForTest()
    __testing.resetErrorBarForTest()
    __testing.resetDialogQueueHandleForTest()
    shellConnectionState.value = 'connecting'
    hasConnectedOnce.value = false
    sessionStore.setActiveId(null)
  })

  it('exited 编排：dialog band 与 form 卡两通道各被清理（composer 恢复），未调 triggerSessionCleanups（canary 不触发）', async () => {
    wrapper = await mountChatView(SID)
    emitDialogRequest(SID, 'req-u6-dialog')
    emitFormRequest(SID, 'req-u6-form')
    await nextTick()
    // 前置：两通道请求均在场（dialog band + form 卡）
    expect(wrapper.find('[data-testid="companion-band"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mobile-form-section"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mobile-composer"]').exists()).toBe(false)

    // 销毁语义 canary：若编排误走 triggerSessionCleanups，注册表全部回调（含 canary）
    // 都会被触发——本断言把「未调销毁语义」从代码审查约定变成行为断言
    const canary = vi.fn()
    registerSessionCleanup(canary)

    resetCompanionChannelsForExitedSession(SID)
    await nextTick()

    // dialog 通道：band 消失（queue.resetFor 清空分区，句柄登记通路生效）
    expect(wrapper.find('[data-testid="companion-band"]').exists()).toBe(false)
    // form 通道：form 卡消失、composer 恢复（Map 具名清理直调）
    expect(wrapper.find('[data-testid="mobile-form-section"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="mobile-composer"]').exists()).toBe(true)
    // 销毁语义未触发
    expect(canary).not.toHaveBeenCalled()
  })

  it('重置非销毁（V18 负面变体）：exited 重置后同 sid 新 dialog 请求立即可见可作答（无 deletedSids 拦截）', async () => {
    wrapper = await mountChatView(SID)
    emitDialogRequest(SID, 'req-u6-old')
    await nextTick()
    expect(wrapper.find('[data-testid="companion-band-title"]').text()).toBe('确认执行？(req-u6-old)')

    // exited 重置（崩溃窗口：pi 死亡 → 旧请求清场）
    resetCompanionChannelsForExitedSession(SID)
    await nextTick()
    expect(wrapper.find('[data-testid="companion-band"]').exists()).toBe(false)

    // 会话恢复后新请求（新 pi 进程、新 requestId）：若误用销毁语义（deletedSids 记入），
    // 入队被 updateFor 首行拦截 → band 不出现，本断言红；重置语义下立即可见
    emitDialogRequest(SID, 'req-u6-post-restore')
    await nextTick()
    expect(wrapper.find('[data-testid="companion-band"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="companion-band-title"]').text()).toBe('确认执行？(req-u6-post-restore)')
    // 可作答（确认按钮在场）
    expect(wrapper.find('[data-testid="companion-confirm-ok"]').exists()).toBe(true)
  })

  it('form 通道重置后新请求同样可达（清理直调不引入跨通道拦截）', async () => {
    wrapper = await mountChatView(SID)
    emitFormRequest(SID, 'req-u6-form-old')
    await nextTick()
    expect(wrapper.find('[data-testid="mobile-form-section"]').exists()).toBe(true)

    resetCompanionChannelsForExitedSession(SID)
    await nextTick()
    expect(wrapper.find('[data-testid="mobile-form-section"]').exists()).toBe(false)

    emitFormRequest(SID, 'req-u6-form-new')
    await nextTick()
    expect(wrapper.find('[data-testid="mobile-form-section"]').exists()).toBe(true)
  })
})
