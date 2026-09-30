/**
 * provider-edit 系测试床共享脚手架：makeProvider 工厂 / i18n stub / effectScope 生命周期。
 *
 * 使用方：provider-edit-{form,reconcile}.test.ts 与 use-provider-edit.test.ts（长版 fixture，
 * 含 headers / authHeader）。provider-edit-{models,discover}.test.ts 用的是短版 fixture
 * （无 headers / authHeader），语义不同，保留各自本地实现不并入。
 */
import { vi } from 'vitest'
import { effectScope } from 'vue'
import type { ProviderInfo, ProviderId } from '@taiji/shared'

/** provider fixture 工厂（长版）：custom provider 全字段形态，覆写合并。 */
export function makeProvider(overrides: Partial<ProviderInfo> = {}): ProviderInfo {
  return {
    id: 'p1' as ProviderId,
    name: 'P1',
    api: 'anthropic-messages',
    baseUrl: 'https://api.example.com',
    apiKeySet: true,
    status: 'connected',
    headers: { 'X-Test': 'v1' },
    authHeader: false,
    models: [
      { id: 'm1', name: 'M1', contextWindow: 200_000, enabled: true },
    ],
    enabled: true,
    ...overrides,
  }
}

/** i18n stub：返回 key 本身（校验调用参数而非翻译）。 */
export function createTStub() {
  return vi.fn((key: string) => key)
}

export type TStub = ReturnType<typeof createTStub>

/** 每用例复位 tStub：清调用记录 + 恢复「返回 key」实现（用例内可覆写实现）。 */
export function resetTStub(t: TStub): void {
  t.mockClear()
  t.mockImplementation((key: string) => key)
}

/**
 * effectScope 生命周期追踪：runInScope 内挂载的响应式副作用随 stopScope 统一回收
 * （测试 afterEach 调 stopScope；同一用例再次 runInScope 覆盖前一个 scope——每用例
 * 一次装配的既有语义保持不变）。
 */
export function createEffectScopeTracker() {
  let scope: ReturnType<typeof effectScope> | null = null
  return {
    // effectScope.run 类型签名 T | undefined——活动 scope 内同步返回值恒非空
    runInScope<T>(fn: () => T): T {
      scope = effectScope()
      return scope.run(fn)!
    },
    stopScope(): void {
      scope?.stop()
      scope = null
    },
  }
}

export type EffectScopeTracker = ReturnType<typeof createEffectScopeTracker>
