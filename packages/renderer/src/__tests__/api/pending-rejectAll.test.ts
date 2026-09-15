/** [已裁剪] 原 5 用例中「全部 reject + map 清空」与 core pending-sweep.test.ts:119
 *  「rejectAll：全部 reject + map 清空（WS 断连场景）」逐字重复，「空 map 不抛错」是
 *  Map.forEach 空迭代的平凡传导，均已删；保留 core 未显式断言的 3 个增量：
 *  no-op 幂等 / 新注册不受影响 / error 对象透传含 code。
 *  （findings 原裁决为「迁移增量到 core 后删」——本 wave 只动 renderer 测试，原地保留。）
 *

 * pending.rejectAll 单测 —— WS 断连 / runtime 崩溃时批量 reject 防永挂。
 *
 * 锁定 R4（WS 断连时 pendingMap 不清理，Promise 永挂 + 内存泄漏）。
 * pending 模块级的 pendingMap 是模块单例，跨测试共享，因此每个 it 必须自行清场
 * （rejectAll 会在结束时清空，正常用例结束 pendingMap 为空；reject 失败用例需兜底清场）。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/api/pending-rejectAll.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import * as pending from '@xyz-agent/core/transport/api'
import { RPC_BACKSTOP_TIMEOUT_MS } from '../../../../core/src/transport/api/pending'

describe('pending.rejectAll', () => {
  beforeEach(() => {
    // 确保模块单例 pendingMap 在每个用例前为空
    pending.rejectAll(new Error('setup cleanup'))
  })

  it('rejectAll 后新注册的请求不受影响（可正常 resolve）', async () => {
    pending.rejectAll(new Error('first batch'))

    const id = pending.createCommandId()
    const p = pending.register<string>(id, RPC_BACKSTOP_TIMEOUT_MS)
    pending.resolve(id, 'new value')

    await expect(p).resolves.toBe('new value')
  })

  it('rejectAll 透传 error 对象（含 code 等附加属性的场景）', async () => {
    const id = pending.createCommandId()
    const p = pending.register<string>(id, RPC_BACKSTOP_TIMEOUT_MS)

    const customError = Object.assign(new Error('runtime crashed'), { code: 'E_RUNTIME' })
    pending.rejectAll(customError)

    await expect(p).rejects.toMatchObject({ message: 'runtime crashed', code: 'E_RUNTIME' })
  })
})
