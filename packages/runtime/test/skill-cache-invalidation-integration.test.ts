/**
 * 契约 4 端到端集成测试：config.skillCacheInvalidated 广播链路（reviewer-D WARNING-1）。
 *
 * 背景：契约 4 此前被切成三段分别测，**中间真实 broker 广播从未被串联执行**：
 *   - skill-registry.test.ts TC4b：止于 registry 层（验 rebuildGlobal → onChange({scope:'global'})，不触达 broker）
 *   - settings-message-handler.test.ts TC5：mock 掉 registry，handler → ctx.broadcastSkillCacheInvalidated('project')
 *     （onChange 路径未走，只是 handler 直调 ctx）
 *   - command-popover-landing.test.ts TC5（renderer 侧）：人造 dispatchGlobal 验 DOM，非真实 broker 广播
 *
 * 本文件补的 gap：真实 SkillRegistry + 真实 ServerMessageBroker，手动复刻 index.ts:326-331 的组合根连线
 * （registry.onChange → broker.broadcastSkillCacheInvalidated），驱动 rebuildGlobal / notifyProjectChange，
 * 断言 broker.broadcast 收到 { type:'config.skillCacheInvalidated', payload:{ scope, cwd } } 消息。
 *
 * 这是「registry 层 onChange 测了、renderer 层 dispatchGlobal 测了、但中间 broker 广播没串」的典型
 * 「测试绿但集成断」gap——本测试把三段连成一条线，确保 payload 字段（scope/cwd）从 registry 一路透传到 WS 消息体。
 *
 * 不验真实 WS 发送（broker.broadcast 内部遍历 pool.clients 调 ws.send 是 message-broker.test.ts 的 U9 职责），
 * 这里只 spy broker.broadcast 验消息构造正确。
 */
import { describe, it, expect, vi } from 'vitest'
import type { ServerMessage } from '@taiji/shared'
import type { ClientPool, BrokerServices } from '../src/transport/message-broker.js'

/** 构造真实 ServerMessageBroker，返回 broker + 捕获 broadcast 消息的 spy。 */
async function makeRealBroker() {
  const { ServerMessageBroker } = await import('../src/transport/message-broker.js')
  // 空连接池：broadcast 仍会序列化 msg 并遍历 clients（空集 → 无 ws.send），构造路径完整执行。
  // 我们 spy broadcast 入口验消息，不依赖真实 ws。
  const pool: ClientPool = { clients: new Set() }
  const services = {
    sessionService: { listPersistedSessions: () => [] },
    configService: {
      listProviders: () => [],
      getDefaultModel: () => null,
      loadSkills: () => [],
      loadAgents: () => [],
      getSkillDirs: () => [],
      getAgentDirs: () => [],
      getExtensionDirs: () => [],
    },
    modelService: { aggregateModels: () => [] },
    pluginService: undefined,
    extensionService: undefined,
    projectRoot: '/proj',
    appInfo: { appVersion: '0.0.0', piVersion: '0.0.0' },
  } as unknown as BrokerServices
  const broker = new ServerMessageBroker(pool, services)
  const broadcastSpy = vi.spyOn(broker, 'broadcast')
  return { broker, broadcastSpy }
}

/**
 * 从 broadcastSpy 调用记录里捞出所有 config.skillCacheInvalidated 消息。
 * （broker 其他广播 helper 不在本测试链路触发，这里防御性过滤 type。）
 */
function skillCacheInvalidatedCalls(spy: ReturnType<typeof vi.spyOn>): ServerMessage[] {
  return spy.mock.calls
    .map(([msg]: [ServerMessage]) => msg)
    .filter((msg: ServerMessage) => msg.type === 'config.skillCacheInvalidated')
}

describe('skill cache invalidation 端到端广播（契约 4 集成）', () => {
  it('rebuildGlobal → onChange → broker 广播 config.skillCacheInvalidated scope=global', async () => {
    const { SkillRegistry } = await import('../src/services/skill-registry.js')
    const { broker, broadcastSpy } = await makeRealBroker()

    const reg = new SkillRegistry({
      configStore: { getSkillPaths: () => [], getPiAgentDir: () => '/pi', getSkillPathScopes: () => ({ projectPaths: [], globalPaths: [] }) } as never,
      configDir: '/cfg',
      // 真实 sessionService：返回活跃 session（notifyGlobalChange 会读它填 affectedSessionIds）
      sessionService: { getActiveSessionIds: () => ['s1'] } as never,
      _scanFn: vi.fn().mockResolvedValue([]),
    } as never)

    try {
      // 复刻 index.ts:326-331 的组合根连线：registry.onChange → broker.broadcastSkillCacheInvalidated
      // 这条线是契约 4 的真实集成点——此前三段单测各自 mock，从未串联执行过。
      reg.onChange((event) => {
        broker.broadcastSkillCacheInvalidated(event.scope, event.cwd)
      })

      // 触发 rebuildGlobal：内部 scanFn 重扫 → notifyGlobalChange → 上面注册的 onChange handler
      // → broker.broadcastSkillCacheInvalidated('global') → broker.broadcast(msg)
      await reg.rebuildGlobal()

      const calls = skillCacheInvalidatedCalls(broadcastSpy)
      // 核心断言：真实 broker.broadcast 被以正确的 config.skillCacheInvalidated 消息调用
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({
        type: 'config.skillCacheInvalidated',
        payload: { scope: 'global' },
      })
      // scope=global 时 cwd 缺省（不应误带 cwd 字段污染前端路由判断）
      expect((calls[0].payload as { cwd?: string }).cwd).toBeUndefined()
      // id 是 broker.nextPushId 生成的 push_<n>（验消息体结构完整，非裸 payload）
      expect(typeof calls[0].id).toBe('string')
      expect(calls[0].id).toMatch(/^push_\d+$/)
    } finally {
      reg.dispose()
    }
  })

  it('notifyProjectChange(cwd) → onChange → broker 广播 scope=project + cwd', async () => {
    const { SkillRegistry } = await import('../src/services/skill-registry.js')
    const { broker, broadcastSpy } = await makeRealBroker()

    const cwd = '/proj'
    const reg = new SkillRegistry({
      configStore: { getSkillPaths: () => [], getPiAgentDir: () => '/pi', getSkillPathScopes: () => ({ projectPaths: [], globalPaths: [] }) } as never,
      configDir: '/cfg',
      sessionService: {
        getActiveSessionIds: () => ['s1', 's2'],
        // s1 绑定 cwd，s2 绑定别的（验 affectedSessionIds 按 cwd 过滤，但广播 payload 只关心 scope/cwd）
        getSessionCwd: (sid: string) => (sid === 's1' ? cwd : '/other'),
      } as never,
      _scanFn: vi.fn().mockResolvedValue([]),
    } as never)

    try {
      // 同样复刻 index.ts:326-331 连线
      reg.onChange((event) => {
        broker.broadcastSkillCacheInvalidated(event.scope, event.cwd)
      })

      // 触发 notifyProjectChange：project scope + cwd 透传到 broker 广播
      await reg.notifyProjectChange(cwd)

      const calls = skillCacheInvalidatedCalls(broadcastSpy)
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({
        type: 'config.skillCacheInvalidated',
        payload: { scope: 'project', cwd },
      })
      expect(calls[0].id).toMatch(/^push_\d+$/)
    } finally {
      reg.dispose()
    }
  })

  it('rebuildGlobal + notifyProjectChange 连续触发 → broker 广播两条消息（global 后 project），payload 互不串扰', async () => {
    // 防御性：连续广播下 broker 内部 pushId 自增 + payload 字段不交叉污染
    const { SkillRegistry } = await import('../src/services/skill-registry.js')
    const { broker, broadcastSpy } = await makeRealBroker()

    const cwd = '/proj-2'
    const reg = new SkillRegistry({
      configStore: { getSkillPaths: () => [], getPiAgentDir: () => '/pi', getSkillPathScopes: () => ({ projectPaths: [], globalPaths: [] }) } as never,
      configDir: '/cfg',
      sessionService: {
        getActiveSessionIds: () => ['s1'],
        getSessionCwd: (sid: string) => (sid === 's1' ? cwd : undefined),
      } as never,
      _scanFn: vi.fn().mockResolvedValue([]),
    } as never)

    try {
      reg.onChange((event) => {
        broker.broadcastSkillCacheInvalidated(event.scope, event.cwd)
      })

      await reg.rebuildGlobal()
      await reg.notifyProjectChange(cwd)

      const calls = skillCacheInvalidatedCalls(broadcastSpy)
      expect(calls).toHaveLength(2)
      // 第一条 global（rebuildGlobal 触发），第二条 project（notifyProjectChange 触发）
      expect(calls[0]).toMatchObject({ type: 'config.skillCacheInvalidated', payload: { scope: 'global' } })
      expect(calls[1]).toMatchObject({ type: 'config.skillCacheInvalidated', payload: { scope: 'project', cwd } })
      // 两条 id 各自独立自增（非复用同一 id）
      expect(calls[0].id).not.toBe(calls[1].id)
    } finally {
      reg.dispose()
    }
  })
})
