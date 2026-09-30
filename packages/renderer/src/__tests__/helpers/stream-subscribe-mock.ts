/**
 * chat.streamSubscribe「捕获回调 + 退订清理」mock 工厂（session-renamed-sync /
 * chat-occupancy-phase 两测试文件的原地脚手架单源；范式同 api-facade-mock.ts）：
 * useChat.ensureStreamSubscription 注册订阅时把回调捕获进 holder，退订时清空，
 * 测试手动触发 holder.current 注入帧序列。
 *
 * holder（vi.hoisted 提升的共享状态，回调消息类型按文件泛型化）留在测试文件：
 * vi.hoisted 工厂被 hoist 到 import 之前执行，引用 import 绑定会 TDZ；本工厂只在
 * '@/api' mock 工厂（惰性执行，彼时顶层 import 已求值）内调用——故 helper 经顶层
 * import 转发，且其 import 必须排在任何先触发 '@/api' 工厂执行的 import 之前。
 *
 * 工厂内创建的 spy 在测试体不可直接引用，清除入口经 mock 后的 '@/api' 取
 * （vi.mocked(chatApi.streamSubscribe).mockClear()，同 settings quota 域范式）。
 *
 * vitest 按测试文件隔离模块图：两个消费文件各取一份独立 holder 与 mock 实例。
 */
import { vi } from 'vitest'

/** streamSubscribe mock（捕获注入回调；退订即清 holder）——holder 消息类型按消费文件泛型化。 */
export function makeStreamSubscribeMock<M>(holder: { current: M | null }): (sid: string, cb: M) => () => void {
  return vi.fn((_sid: string, cb: M) => {
    holder.current = cb
    return () => {
      holder.current = null
    }
  })
}
