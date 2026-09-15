/**
 * EventAdapter.detach 转调 onDetach 契约单测（session-dead 定向复审缺陷 2 回流）。
 *
 * 锁定：detach() 是全部销毁路径的收口（forceQuit/exit/delete/restore 清场均经
 * adapter.detach），必须转调 onDetach（组合根传 interpreter.dispose——清 interpreter
 * 在途 settling 延迟 timer + 置 disposed 短路标志）。此前该转调无直接断言。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/event-adapter-detach.test.ts
 */
import { describe, it, expect, vi } from 'vitest'

import { EventAdapter } from '../event-adapter.js'

describe('EventAdapter.detach 转调 onDetach（销毁收口契约）', () => {
  it('attach 后 detach：unsub 与 onDetach 各被调 1 次', () => {
    const onDetach = vi.fn()
    const adapter = new EventAdapter('sid-1', vi.fn(), undefined, onDetach)
    const unsub = vi.fn()
    adapter.attach({ onEvent: () => unsub })
    adapter.detach()
    expect(unsub).toHaveBeenCalledTimes(1)
    expect(onDetach).toHaveBeenCalledTimes(1)
  })

  it('未 attach 直接 detach：onDetach 仍被转调 1 次（收口不依赖 attach 前置）', () => {
    const onDetach = vi.fn()
    const adapter = new EventAdapter('sid-1', vi.fn(), undefined, onDetach)
    adapter.detach()
    expect(onDetach).toHaveBeenCalledTimes(1)
  })
})
