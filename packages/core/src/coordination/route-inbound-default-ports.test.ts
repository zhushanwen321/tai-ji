/**
 * configureRouteInbound 缺省真实模块直连（D3）——round5-g 合并复筛从
 * subscription-state.test.ts 产物剔出独立保留。
 *
 * 剔出原因：本节测「缺省不传 ports 时 pending 分流走真实 transport/api 模块级单例」，
 * 与合并产物内 use-connection-seq-gap 节所需的 transport/api/pending 文件级 mock
 * 结构性不相容（文件级 mock 无法按节分流，mock 生效则本节必红）。
 *
 * 运行：cd packages/core && TAIJI_SKIP_REAL_PI=1 npx vitest run src/coordination/route-inbound-default-ports.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { ServerMessage } from '@taiji/shared'
import { configureRouteInbound } from './route-inbound'
import { resetSubscriptionStates } from './subscription-state'
import * as realPending from '../transport/api/pending'

describe('configureRouteInbound — 缺省真实模块直连（D3）', () => {
  beforeEach(() => {
    resetSubscriptionStates()
  })

  it('不传 ports：pending 分流用真实 transport/api/pending（register 的 reply 被 resolve）', async () => {
    // 生产路径：configureRouteInbound() 缺省 defaultPorts（直连 core transport/api 模块级
    // 单例）——真实 pending 注册表收到 reply id 后经 resolveEnvelope 结算 Promise
    const dispatcher = configureRouteInbound()
    const replyPromise = realPending.register('default-ports-reply-1', 60_000)
    dispatcher({
      type: 'session.getCommands',
      id: 'default-ports-reply-1',
      payload: { commands: [] },
    } as unknown as ServerMessage)
    await expect(replyPromise).resolves.toEqual({ commands: [] })
    // 清理模块级 pendingMap（真实单例状态，防泄漏到其他用例）
    realPending.rejectAll(new Error('test cleanup'))
  })
})
