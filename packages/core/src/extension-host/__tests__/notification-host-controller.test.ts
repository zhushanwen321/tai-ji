/**
 * NotificationHostController 单测 —— 7 类 bus 事件的最小消费 + sessionId 透传。
 *
 * 覆盖：
 * 1. extension-notify / plugin-notification → showToast(message, level, sessionId)
 *    （sessionId 透传是 notify 优化的接缝：壳据此组装 session 定位行与前台/后台过滤）
 * 2. plugin-crashed → showToast('插件 x 崩溃: …', 'error')（无 sessionId，undefined 透传）
 * 3. log 降级类（config-changed / decoration / status-change / error）不弹 toast
 * 4. subscribe 幂等（重复调用不重复注册 listener）+ dispose 取消
 *
 * 运行：cd packages/core && npx vitest run src/extension-host/__tests__/notification-host-controller.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { InternalEventBus } from '../internal-event-bus'
import { NotificationHostController } from '../notification-host-controller'

function makeController() {
  const bus = new InternalEventBus()
  const showToast = vi.fn()
  const log = vi.fn()
  const controller = new NotificationHostController({ bus, deps: { showToast, log } })
  return { bus, controller, showToast, log }
}

describe('NotificationHostController', () => {
  it('extension-notify → showToast 透传 message/level/sessionId', () => {
    const { bus, controller, showToast } = makeController()
    controller.subscribe()

    bus.emit({
      kind: 'extension-notify',
      sessionId: 'sid-1',
      notification: { pluginId: '', message: 'Goal blocked.', level: 'warning' },
    })

    expect(showToast).toHaveBeenCalledWith('Goal blocked.', 'warning', 'sid-1')
  })

  it('plugin-notification → 同形处理，sessionId 一并透传', () => {
    const { bus, controller, showToast } = makeController()
    controller.subscribe()

    bus.emit({
      kind: 'plugin-notification',
      sessionId: 'sid-2',
      notification: { pluginId: 'p', message: 'done', level: 'info' },
    })

    expect(showToast).toHaveBeenCalledWith('done', 'info', 'sid-2')
  })

  it('extension-notify 无 level → undefined 透传（壳按 info 兜底）', () => {
    const { bus, controller, showToast } = makeController()
    controller.subscribe()

    bus.emit({
      kind: 'extension-notify',
      sessionId: 'sid-3',
      notification: { pluginId: '', message: 'no level' },
    })

    expect(showToast).toHaveBeenCalledWith('no level', undefined, 'sid-3')
  })

  it('plugin-crashed → error toast（无 sessionId）', () => {
    const { bus, controller, showToast } = makeController()
    controller.subscribe()

    bus.emit({ kind: 'plugin-crashed', pluginId: 'x', error: 'boom' })

    // 无 session 语义：不传第三参（undefined 由壳兜底处理）
    expect(showToast).toHaveBeenCalledWith('插件 x 崩溃: boom', 'error')
  })

  it('log 降级类事件不弹 toast', () => {
    const { bus, controller, showToast, log } = makeController()
    controller.subscribe()

    bus.emit({ kind: 'plugin-config-changed', pluginId: 'p', config: {} })
    bus.emit({ kind: 'plugin-message-decoration', sessionId: 's', decoration: { messageId: 'm', decoration: {} } })
    bus.emit({ kind: 'plugin-status-change', pluginId: 'p', status: 'active' })
    bus.emit({ kind: 'error', source: 'bridge', message: 'bad frame' })

    expect(showToast).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledTimes(4)
  })

  it('subscribe 幂等：重复调用不重复注册（一次 emit 只一次 showToast）', () => {
    const { bus, controller, showToast } = makeController()
    controller.subscribe()
    controller.subscribe()

    bus.emit({
      kind: 'extension-notify',
      sessionId: 's',
      notification: { pluginId: '', message: 'once' },
    })

    expect(showToast).toHaveBeenCalledTimes(1)
  })

  it('dispose 后不再消费', () => {
    const { bus, controller, showToast } = makeController()
    const dispose = controller.subscribe()
    dispose()

    bus.emit({
      kind: 'extension-notify',
      sessionId: 's',
      notification: { pluginId: '', message: 'gone' },
    })

    expect(showToast).not.toHaveBeenCalled()
  })
})
