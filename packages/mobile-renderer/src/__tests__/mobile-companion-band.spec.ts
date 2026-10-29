// 移动壳 dialog 通道呈现装配（remote-use-mobile-v2 §6.5 三通道 Sheet 化；v1 CompanionBand
// 呈现退役后的承接面锁定）。
//
// 锁定三个行为范围（v1 D3 三行为的 v2 形态映射）：
//   装配   —— v1 zone-companion 容器随呈现退役摘除（本文件负断言锁定：band 呈现面不再
//            在渲染树；dialog 数据源/回传通路零变化，queue 宿主迁 companion-bridge）
//   呈现   —— 请求到达即当前路由态直接可见可作答（S3 语义保留：dialog 请求自动开 form
//            槽 Sheet，App 根级 Sheet 挂载段路由态无关——列表页停留期间到达不丢失）
//   无请求 —— 无请求时 Sheet 不渲染（v1 band 自隐藏的 Sheet 形态；无活跃 session 安全渲染）
//
// v1 minimize/restore 能力随 band 呈现退役（§6.5：Sheet 单槽 + 拖拽关闭取代收起/展开；
// spec §4.3 浮层互斥下单槽语义无最小化态）——无对应用例，M-5 对账登记于 runlog。
//
// mock 策略：请求注入经 __testing.mobileExtensionBus.emit（生产订阅侧 = dialog 通道
// bus 订阅，mobile-form.spec.ts 同款先例）；不点作答按钮（会走真实回传 RPC，非本文件
// 断言范围）。呈现查询 = Sheet portal teleport 到 body（sheet.test.ts 同款）。
//
// 运行：cd packages/mobile-renderer && npx vitest run src/__tests__/mobile-companion-band.spec.ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import App from '../App.vue'
import { i18n } from '../i18n'
import { sessionStore } from '../shell/app-runtime'
import { __testing } from '../shell/companion-bridge'
import { hasConnectedOnce, shellConnectionState } from '../shell/connection-view'
import { activeSheet } from '../shell/sheet-manager'

function mountApp() {
  return mount(App, { global: { plugins: [i18n] }, attachTo: document.body })
}

function bodyEl(testid: string): HTMLElement | null {
  return document.body.querySelector(`[data-testid="${testid}"]`)
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

describe('移动壳 dialog 通道 Sheet 化呈现（§6.5）', () => {
  let wrapper: ReturnType<typeof mountApp> | null = null

  beforeEach(async () => {
    const { resetCompanionTestState } = await import('./helpers/companion-bridge-test-env')
    await resetCompanionTestState()
  })

  afterEach(async () => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
    const { cleanupCompanionTestState } = await import('./helpers/companion-bridge-test-env')
    await cleanupCompanionTestState(null)
  })

  it('装配断言：v1 band 呈现面退役（zone-companion/companion-band 不在渲染树），列表域正常渲染', async () => {
    hasConnectedOnce.value = true
    shellConnectionState.value = 'connected'
    sessionStore.setActiveId('sid-d3')
    wrapper = mountApp()
    await nextTick()
    // 默认路由 = sessions；呈现退役后 band 容器不再存在（负断言锁退役，M-5 对账锚）
    expect(wrapper.find('[data-testid="zone-companion"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="companion-band"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="screen-sessions"]').exists()).toBe(true)
  })

  it('呈现：列表域停留期间到达的 dialog 请求自动开 form 槽 Sheet 直接可见可作答（不切路由）', async () => {
    hasConnectedOnce.value = true
    shellConnectionState.value = 'connected'
    sessionStore.setActiveId('sid-d3')
    wrapper = mountApp()
    await nextTick()
    expect(wrapper.find('[data-testid="screen-sessions"]').exists()).toBe(true)

    emitDialogRequest('sid-d3', 'req-d3-visible')
    await nextTick()
    await flushPromises()
    // Sheet 呈现（portal 到 body）：标题 + message + confirm 双钮在场
    expect(bodyEl('form-sheet-dialog')).not.toBeNull()
    expect(bodyEl('form-sheet-dialog-message')?.textContent).toBe('该操作将应用变更')
    expect(bodyEl('form-sheet-dialog-ok')).not.toBeNull()
    expect(bodyEl('form-sheet-dialog-cancel')).not.toBeNull()
  })

  it('无请求态：Sheet 不渲染（无活跃 session 安全渲染，P5 的 Sheet 形态）', async () => {
    wrapper = mountApp()
    await nextTick()
    // connecting 态（未连接）：无请求无槽位，浮层不渲染
    expect(bodyEl('sheet-content')).toBeNull()
    expect(activeSheet.value).toBeNull()
  })
})
