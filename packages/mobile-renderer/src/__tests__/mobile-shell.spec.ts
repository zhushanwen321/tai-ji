// AC5 结构断言测试套件（W2：mobile 四要素布局壳 + stub + 挂载点 + platform adapter）。
//
// 覆盖 TC-1~TC-5 + TC-7（TC-6 构建验收由 cw test gate 的 build 步骤单独跑）：
//   TC-1: mount(App) 断言四 zone 容器 testid 存在
//   TC-2: mount(App) 断言四 stub 组件 testid 存在（辅助锚点）
//   TC-3: mount-points.ts 挂载点注册（IF1，§6.3 mobile B+D 子集）
//   TC-4: createMobilePlatformAdapter 满足 core PlatformPort 契约（IF2）
//   TC-5: providePlatform/getPlatform 注入链路通（经 bootstrap）
//   TC-7: main.ts 保留 W1 AC1 依赖边（core + ui import 回归护栏）
//
// 从 vitest 导入（禁 node:test / tsx --test）。运行：npx vitest run。
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { getPlatform, __resetPlatformForTesting } from '@taiji/core'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import App from '../App.vue'
import {
  MOBILE_MOUNT_POINTS,
  registerMountPoint,
  getRegisteredMountPoints,
  __resetMountPointsForTesting,
} from '../shell/mount-points'
import { createMobilePlatformAdapter } from '../platform/mobile-platform-adapter'
import { bootstrap } from '../bootstrap'

// vitest 运行时 cwd 即包根（vitest.config.ts 所在目录）
const pkgRoot = process.cwd()

describe('TC-1: AC5 四 zone 容器 testid 存在', () => {
  it('mount(App) 渲染 zone-message-stream / zone-companion / zone-slash / bottom-tab-bar 四容器', () => {
    const wrapper = mount(App)
    expect(wrapper.find('[data-testid="zone-message-stream"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="zone-companion"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="zone-slash"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="bottom-tab-bar"]').exists()).toBe(true)
  })
})

describe('TC-2: AC5 四 stub 组件 testid 存在（辅助锚点）', () => {
  it('mount(App) 渲染 stub-message-stream / stub-slash / stub-companion / stub-bottom-tab-bar', () => {
    const wrapper = mount(App)
    expect(wrapper.find('[data-testid="stub-message-stream"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="stub-slash"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="stub-companion"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="stub-bottom-tab-bar"]').exists()).toBe(true)
  })
})

describe('TC-3: AC5 getRegisteredMountPoints 含 mobile B+D 子集三挂载点', () => {
  beforeEach(() => {
    __resetMountPointsForTesting()
  })

  it('MOBILE_MOUNT_POINTS 常量 = [message-stream, slash, companion]', () => {
    expect([...MOBILE_MOUNT_POINTS]).toEqual(['message-stream', 'slash', 'companion'])
  })

  it('注册三挂载点后 getRegisteredMountPoints 含三项', () => {
    registerMountPoint('message-stream', {})
    registerMountPoint('slash', {})
    registerMountPoint('companion', {})
    const points = getRegisteredMountPoints()
    expect(points.size).toBe(3)
    expect(points.has('message-stream')).toBe(true)
    expect(points.has('slash')).toBe(true)
    expect(points.has('companion')).toBe(true)
  })

  it('registerMountPoint 幂等：同名重复注册覆盖，集合 size 不变', () => {
    registerMountPoint('message-stream', {})
    registerMountPoint('message-stream', {})
    expect(getRegisteredMountPoints().size).toBe(1)
  })
})

describe('TC-4: AC5 createMobilePlatformAdapter 满足 core PlatformPort 契约', () => {
  it('kind === "mobile" 且两端口字段存在（storage/webSocket；ipc 已从契约删除）', () => {
    const adapter = createMobilePlatformAdapter()
    expect(adapter.kind).toBe('mobile')
    expect(adapter.storage).toBeDefined()
    expect(adapter.webSocket).toBeDefined()
    expect('ipc' in adapter).toBe(false)
  })

  it('storage.get 不存在 key 返回 null（非抛错）', async () => {
    const adapter = createMobilePlatformAdapter()
    expect(await adapter.storage.get('missing-key')).toBeNull()
  })

  it('storage.set + get 读写通', async () => {
    const adapter = createMobilePlatformAdapter()
    await adapter.storage.set('k', 'v')
    expect(await adapter.storage.get('k')).toBe('v')
  })

  it('webSocket.create(url) 返回对象含 send/close 函数 + readyState 数字', () => {
    const adapter = createMobilePlatformAdapter()
    const ws = adapter.webSocket.create('ws://localhost/test')
    expect(typeof ws.readyState).toBe('number')
    expect(typeof ws.send).toBe('function')
    expect(typeof ws.close).toBe('function')
  })
})

describe('TC-5: AC5 providePlatform/getPlatform 注入链路通（经 bootstrap）', () => {
  beforeEach(() => {
    __resetPlatformForTesting()
    __resetMountPointsForTesting()
    // bootstrap 挂载 #app，happy-dom 需显式提供该节点
    const app = document.createElement('div')
    app.id = 'app'
    document.body.appendChild(app)
  })

  afterEach(() => {
    __resetPlatformForTesting()
    __resetMountPointsForTesting()
    document.getElementById('app')?.remove()
  })

  it('bootstrap 前 getPlatform() 抛错（platform 未注入）', () => {
    expect(() => getPlatform()).toThrow(/platform port not injected/)
  })

  it('bootstrap() 后 getPlatform().kind === "mobile"（adapter 经 providePlatform 注入 core）', async () => {
    await bootstrap()
    expect(getPlatform().kind).toBe('mobile')
  })

  it('bootstrap() 后 getRegisteredMountPoints 含 mobile 三挂载点', async () => {
    await bootstrap()
    const points = getRegisteredMountPoints()
    expect(points.size).toBe(3)
    expect(points.has('message-stream')).toBe(true)
    expect(points.has('slash')).toBe(true)
    expect(points.has('companion')).toBe(true)
  })
})

describe('TC-7: AC1 回归 main.ts 保留 core + ui import（W1 依赖边）', () => {
  const mainSrc = readFileSync(resolve(pkgRoot, 'src/main.ts'), 'utf-8')

  it('main.ts import 自 @taiji/core', () => {
    expect(mainSrc).toMatch(/from '@taiji\/core'/)
  })

  it('main.ts import 自 @taiji/ui', () => {
    expect(mainSrc).toMatch(/from '@taiji\/ui'/)
  })
})
