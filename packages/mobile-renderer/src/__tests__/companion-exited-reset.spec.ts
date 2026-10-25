// 移动壳 session.exited 分通道重置编排（remote-use U6 / D5 exited 分区清理段 + 「exited
// 清理与拦截解绑」段；v2 §6.5 后断言面 = 分区读口 + Sheet 槽位，v1 band/formCard DOM 退役）。
//
// 锁定三个行为范围：
//   分通道清理 —— exited 编排出口（companion-bridge）：dialog 通道 queue.resetFor + form
//                通道 Map 具名清理（两分区读口归空、form 槽联动收层）——M8 防御：死会话
//                残留请求不重弹、作答不发给新进程后石沉大海（V18 正面）
//   拦截解绑   —— 重置非销毁：重置后同 sid 新请求立即可入分区可呈现（V18 负面变体）——若
//                误用销毁语义（cleanup → deletedSids），恢复期新请求被 updateFor 首行
//                静默拦截，分区不进、Sheet 不开，本断言红
//   销毁语义排除 —— 编排未调 triggerSessionCleanups：注册表 canary 不被触发
//
// mock 策略：请求注入经 __testing.mobileExtensionBus.emit（生产订阅侧 = dialog/form 通道
// bus 订阅）；分区可观测性经 __testing.mobileDialogQueue（resetFor/hasRequest）与
// useMobileFormRequests 读口——queue 宿主 v2 起居 companion-bridge 模块级（呈现退役后
// 无组件私有句柄回传链）。
//
// 运行：cd packages/mobile-renderer && npx vitest run src/__tests__/companion-exited-reset.spec.ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { VueWrapper } from '@vue/test-utils'
import { registerSessionCleanup } from '@taiji/core/foundation/use-session-scoped-state'
import {
  __testing,
  resetCompanionChannelsForExitedSession,
  useMobileFormRequests,
} from '../shell/companion-bridge'
import { activeSessionId } from '../shell/app-runtime'

// 复用单实例读口（watch immediate reconcile 只注册一次；用例中途新建实例会在 emit 后
// 以空快照清分区——模块级分区单例的测试期副作用）
const formView = useMobileFormRequests(activeSessionId)
import { activeSheet } from '../shell/sheet-manager'
import {
  cleanupCompanionTestState,
  mountChatView,
  resetCompanionTestState,
  singleChoiceRequest,
} from './helpers/companion-bridge-test-env'

// vi.mock 注册留在本文件（hoist 语义）；工厂体单源在 helpers/companion-bridge-test-env
// （本 spec 不消费回传与对账产物，mock 零行为影响）
vi.mock('@taiji/core/transport/api/domains/extension', async () => {
  const { extensionDomainMocks } = await import('./helpers/companion-bridge-test-env')
  return extensionDomainMocks
})

const SID = 'sid-u6-exited'

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

/** 发一条 form 类 ui-request（C4 放行范围，form 帧；载荷单源 helpers singleChoiceRequest） */
function emitFormRequest(sessionId: string, requestId: string): void {
  __testing.mobileExtensionBus.emit({
    kind: 'ui-request',
    sessionId,
    request: {
      requestId,
      pluginId: '',
      kind: 'select',
      method: 'select',
      ...singleChoiceRequest(),
    },
  })
}

/** dialog 分区即时读口（queue 按 activeSessionId 分区；探活用，不建 watcher） */
function dialogHasPending(): boolean {
  return __testing.mobileDialogQueue.hasRequest()
}

describe('移动壳 exited 分通道重置编排（U6）', () => {
  let wrapper: VueWrapper | null = null

  beforeEach(async () => {
    await resetCompanionTestState()
  })

  afterEach(async () => {
    await cleanupCompanionTestState(wrapper)
    wrapper = null
  })

  it('exited 编排：dialog 与 form 两通道分区各被清理（form 槽联动收层、composer 恢复），未调 triggerSessionCleanups（canary 不触发）', async () => {
    wrapper = await mountChatView(SID)
    emitDialogRequest(SID, 'req-u6-dialog')
    emitFormRequest(SID, 'req-u6-form')
    const { nextTick } = await import('vue')
    await nextTick()
    // 前置：两通道请求均入分区（form 槽自动开 + composer 隐藏互斥）
    expect(dialogHasPending()).toBe(true)
    expect(wrapper.find('[data-testid="mobile-composer"]').exists()).toBe(false)

    // 销毁语义 canary：若编排误走 triggerSessionCleanups，注册表全部回调（含 canary）
    // 都会被触发——本断言把「未调销毁语义」从代码审查约定变成行为断言
    const canary = vi.fn()
    registerSessionCleanup(canary)

    resetCompanionChannelsForExitedSession(SID)
    await nextTick()

    // dialog 通道：queue 分区清空（resetFor 直调）
    expect(dialogHasPending()).toBe(false)
    // form 通道：分区清空 + form 槽联动收层（呈现面随数据源归空收口）、composer 恢复
    expect(formView.currentFormRequest.value).toBeUndefined()
    expect(activeSheet.value).toBeNull()
    expect(wrapper.find('[data-testid="mobile-composer"]').exists()).toBe(true)
    // 销毁语义未触发
    expect(canary).not.toHaveBeenCalled()
  })

  it('重置非销毁（V18 负面变体）：exited 重置后同 sid 新 dialog 请求立即可入分区（无 deletedSids 拦截）', async () => {
    wrapper = await mountChatView(SID)
    emitDialogRequest(SID, 'req-u6-old')
    const { nextTick } = await import('vue')
    await nextTick()
    expect(dialogHasPending()).toBe(true)

    // exited 重置（崩溃窗口：pi 死亡 → 旧请求清场）
    resetCompanionChannelsForExitedSession(SID)
    await nextTick()
    expect(dialogHasPending()).toBe(false)

    // 会话恢复后新请求（新 pi 进程、新 requestId）：若误用销毁语义（deletedSids 记入），
    // 入队被 updateFor 首行拦截 → 分区不进，本断言红；重置语义下立即可入（呈现面随
    // activeSheet 槽位复开归呈现编排，本断言锚分区层）
    emitDialogRequest(SID, 'req-u6-post-restore')
    await nextTick()
    expect(dialogHasPending()).toBe(true)
  })

  it('form 通道重置后新请求同样可达（清理直调不引入跨通道拦截）', async () => {
    wrapper = await mountChatView(SID)
    emitFormRequest(SID, 'req-u6-form-old')
    const { nextTick } = await import('vue')
    await nextTick()
    expect(formView.currentFormRequest.value).toBeDefined()

    resetCompanionChannelsForExitedSession(SID)
    await nextTick()
    expect(formView.currentFormRequest.value).toBeUndefined()

    emitFormRequest(SID, 'req-u6-form-new')
    await nextTick()
    expect(formView.currentFormRequest.value?.requestId).toBe('req-u6-form-new')
  })
})
