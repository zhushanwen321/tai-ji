// 移动壳 CompanionBand 根级常驻装配（remote-use D3 / U7）。
//
// 锁定三个行为面：
//   装配   —— zone-companion 在 App 根级渲染树（非页签条件分支）：列表页签下容器在场
//   呈现   —— 请求到达即当前页签直接可见可作答（S3：页签条件分支内挂载随组件卸载退订，
//            停留列表页签期间到达的 dialog 请求曾静默丢失）
//   假按钮 —— minimize/restore 经 OVERLAY_LIFECYCLE provide 获得真实状态机（inject 缺失时
//            按钮在场但点击 no-op = 假行为；provide 后 transition→getState 闭环生效）
//
// mock 策略：请求注入经 __testing.mobileExtensionBus.emit（生产订阅面 = dialog 通道
// bus 订阅，mobile-form.spec.ts 同款先例）；不点 confirm/select 作答按钮（会走真实
// sendExtensionUIResponse WS 回传，非本单元断言面）；minimize/restore 纯组件内状态迁移
// 不触回传。CompanionBand 每次 mount 新建 queue（useSessionScopedState 每调用独立分区），
// mount/unmount 天然隔离；模块级 requestIdSessions 反查表 beforeEach 防御性重置。
//
// 运行：cd packages/mobile-renderer && npx vitest run src/__tests__/mobile-companion-band.spec.ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import App from '../App.vue'
import { i18n } from '../i18n'
import { sessionStore } from '../shell/app-runtime'
import { __testing } from '../shell/companion-bridge'
import { hasConnectedOnce, shellConnectionState } from '../shell/connection-view'

function mountApp() {
  return mount(App, { global: { plugins: [i18n] } })
}

/** 发一条 bridge 归一后的 dialog 类 ui-request（confirm 形态；method 带 method 键同 bridge 产物形状） */
function emitDialogRequest(sessionId: string, requestId: string): void {
  __testing.mobileExtensionBus.emit({
    kind: 'ui-request',
    sessionId,
    request: {
      requestId,
      pluginId: 'tasks',
      kind: 'confirm',
      method: 'confirm',
      title: '确认执行？',
      message: '该操作将应用变更',
    },
  })
}

describe('移动壳 CompanionBand 根级常驻（D3）', () => {
  let wrapper: ReturnType<typeof mountApp> | null = null

  beforeEach(() => {
    // 反查表 requestIdSessions 为模块级（companion-bridge 未导出其 reset 出口）：
    // 用例间以唯一 requestId 隔离（残留条目不参与任何断言）
    shellConnectionState.value = 'connecting'
    hasConnectedOnce.value = false
    sessionStore.setActiveId(null)
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    shellConnectionState.value = 'connecting'
    hasConnectedOnce.value = false
    sessionStore.setActiveId(null)
  })

  it('装配断言：列表页签（非聊天分支）下 zone-companion 容器在场（根级常驻，不随页签分支卸载）', () => {
    hasConnectedOnce.value = true
    shellConnectionState.value = 'connected'
    sessionStore.setActiveId('sid-d3')
    wrapper = mountApp()
    // 默认页签 = sessions；根级常驻后容器在场（改动前仅聊天页签分支挂载，此处为红）
    expect(wrapper.find('[data-testid="zone-companion"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mobile-session-list"]').exists()).toBe(true)
  })

  it('呈现：列表页签停留期间到达的 dialog 请求直接可见可作答（不切页签）', async () => {
    hasConnectedOnce.value = true
    shellConnectionState.value = 'connected'
    sessionStore.setActiveId('sid-d3')
    wrapper = mountApp()
    emitDialogRequest('sid-d3', 'req-d3-visible')
    await nextTick()
    expect(wrapper.find('[data-testid="companion-band"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="companion-band-title"]').text()).toBe('确认执行？')
    // 可作答：confirm/取消按钮在场
    expect(wrapper.find('[data-testid="companion-confirm-ok"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="companion-confirm-cancel"]').exists()).toBe(true)
  })

  it('假按钮处置：minimize 点击真实收起（restore 出现、body 隐藏），restore 点击真实展开', async () => {
    hasConnectedOnce.value = true
    shellConnectionState.value = 'connected'
    sessionStore.setActiveId('sid-d3')
    wrapper = mountApp()
    emitDialogRequest('sid-d3', 'req-d3-min')
    await nextTick()

    // 改动前（OVERLAY_LIFECYCLE 缺失）：按钮在场但点击 no-op，本断言为红
    await wrapper.get('[data-testid="companion-minimize"]').trigger('click')
    expect(wrapper.find('[data-testid="companion-minimize"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="companion-restore"]').exists()).toBe(true)
    // 收起态 body 隐藏（仅 header + restore 按钮在场）
    expect(wrapper.find('[data-testid="companion-band-message"]').exists()).toBe(false)

    await wrapper.get('[data-testid="companion-restore"]').trigger('click')
    expect(wrapper.find('[data-testid="companion-restore"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="companion-minimize"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="companion-band-message"]').exists()).toBe(true)
  })

  it('连接前/无请求态：容器常驻但 band 自隐藏（无活跃 session 安全渲染，P5）', () => {
    wrapper = mountApp()
    // connecting 态（未连接）：容器在根级渲染树，band 无请求自隐藏
    expect(wrapper.find('[data-testid="zone-companion"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="companion-band"]').exists()).toBe(false)
  })
})
