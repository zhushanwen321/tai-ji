/**
 * getAffectedSessionIds 的 this 绑定锁定（skill-reload B4 真机事故回归）。
 *
 * 事故：skill-registry 曾以「解绑提取」消费 sessionService.getSessionCwd
 * （const fn = svc.getSessionCwd 后裸调用），真实 SessionService 是 class 原型方法，
 * 裸调用 this=undefined → watcher debounce 定时器内 TypeError → uncaughtException
 * 整机崩（supervisor 重启 → 全部 session 执行树被 destroyAll 带走）。
 * 单测未拦住的原因：彼时 stub 全部用箭头函数属性形态（不受解绑影响）。
 * 本文件以 class 原型方法形态的 stub 锁定：通知 payload 与 D8-a 归因日志共用的
 * affected 计算口径必须经宿主对象调用。
 */
import { describe, expect, test } from 'vitest'

import { SkillRegistry } from '../services/skill-registry.js'

/** 真实 SessionService 同构：方法在 prototype 上（非箭头函数实例属性）——解绑即炸的形态。 */
class ClassMethodSessionService {
  private readonly cwds = new Map<string, string | undefined>([
    ['s-proj', '/proj'],
    ['s-other', '/elsewhere'],
  ])
  getActiveSessionIds(): string[] {
    return [...this.cwds.keys()]
  }
  getSessionCwd(sessionId: string): string | undefined {
    return this.cwds.get(sessionId)
  }
}

function makeRegistry(sessionService: unknown): {
  registry: SkillRegistry
  seen: Array<{ scope: string; cwd?: string; affectedSessionIds: string[] }>
} {
  const seen: Array<{ scope: string; cwd?: string; affectedSessionIds: string[] }> = []
  const registry = new SkillRegistry({
    configStore: { getPiAgentDir: () => '/tmp/agent', getSkillPathScopes: () => ({ projectPaths: [], globalPaths: [] }) },
    configDir: '/tmp',
    sessionService: sessionService as never,
  })
  registry.onChange((e) => seen.push(e))
  return { registry, seen }
}

describe('SkillRegistry.getAffectedSessionIds（this 绑定锁定）', () => {
  test('class 原型方法形态的 sessionService：project 变更按 cwd 过滤且不炸（解绑提取回归面）', async () => {
    const { registry, seen } = makeRegistry(new ClassMethodSessionService())

    await registry.notifyProjectChange('/proj')

    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ scope: 'project', cwd: '/proj', affectedSessionIds: ['s-proj'] })
  })

  test('getSessionCwd 未注入时降级为全部活跃 session（契约不变）', async () => {
    const { registry, seen } = makeRegistry({ getActiveSessionIds: () => ['s-proj', 's-other'] })

    await registry.notifyProjectChange('/proj')

    expect(seen).toHaveLength(1)
    expect(seen[0].affectedSessionIds).toEqual(['s-proj', 's-other'])
  })

  test('global 变更 = 全部活跃 session', async () => {
    const { registry, seen } = makeRegistry(new ClassMethodSessionService())

    await registry.notifyGlobalChange()

    expect(seen).toHaveLength(1)
    expect(seen[0].affectedSessionIds).toEqual(['s-proj', 's-other'])
  })

  test('未订阅 handler 时通知不炸（空 handlers）', async () => {
    const registry = new SkillRegistry({
      configStore: { getPiAgentDir: () => '/tmp/agent', getSkillPathScopes: () => ({ projectPaths: [], globalPaths: [] }) },
      configDir: '/tmp',
      sessionService: new ClassMethodSessionService() as never,
    })

    await expect(registry.notifyProjectChange('/proj')).resolves.toBeUndefined()
  })
})
