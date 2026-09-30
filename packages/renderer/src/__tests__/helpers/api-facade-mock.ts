/**
 * '@/api' 门面 mock 共享工厂（fork-keymap / launch-config-shell-wiring /
 * use-chat-compacted-flush / use-compact-queue 等测试文件的 '@/api' 挂载前置段单源；
 * 范式同 composer-mount.ts——vi.mock 注册留在测试文件（mock 是文件作用域），
 * 工厂经顶层 import 转发本 helper 导出。
 *
 * 收敛两类逐字重复：
 * - project 域空载基座（load/save resolve 空项目）——Sidebar/Composer mount 链
 *   onMounted 消费 project.load，缺则 unhandled rejection 崩 mount
 * - chat 域方法 resolve 基线（send/steer/followUp/abort/compact 五方法）——文件专属
 *   方法（bash/abortBash/getHistory/editAndResend/...）由调用方展开后追加
 *
 * 断言需要引用具体 spy 的测试（flush 编排类）不经本工厂：chat 域成员须映射到
 * vi.hoisted 的 apiMock spy，保持文件内自建。
 *
 * vitest 按测试文件隔离模块图：每个测试文件经 vi.mock 工厂各自取一份新实例。
 */
import { vi } from 'vitest'

/** project 域 mock（空项目基座，load/save 均 resolve）。 */
export function apiProjectMock() {
  return {
    load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }),
    save: vi.fn().mockResolvedValue(undefined),
  }
}

/** chat 域方法 mock 基线（五方法 resolve 基线；追加面见文件头注释）。 */
export function chatApiMethodsMock() {
  const resolveFn = () => vi.fn(() => Promise.resolve())
  return {
    send: resolveFn(),
    steer: resolveFn(),
    followUp: resolveFn(),
    abort: resolveFn(),
    compact: resolveFn(),
  }
}
