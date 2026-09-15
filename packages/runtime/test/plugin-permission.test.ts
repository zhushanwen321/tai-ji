/**
 * PermissionChecker + PermissionStorage 测试（D1 通道身份语义）
 *
 * 验证插件权限管理的核心逻辑：
 * - trusted 通道身份（worker 级）check() 始终 true
 * - sandbox 通道身份按 identity.pluginId 查 granted（完整 RPC 方法名口径）
 * - grant() 任意口径（SDK 常量 / manifest 短形 / legacy / 完整方法名）归一化入集
 * - revoke() / 未知插件 / sandbox 身份缺 pluginId → fail-closed
 * - load() 文件不存在时初始化空 map；旧声明形数据 load 时归一化迁移
 * - save() + load() 往返（完整方法名幂等透传）
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PluginPermissionChecker } from '../src/services/plugin-service/plugin-permission.js'
import { PermissionStorage } from '../src/services/plugin-service/plugin-permission-storage.js'
import type { RpcIdentity } from '../src/services/plugin-service/plugin-rpc-server.js'
import type { PluginRegistry } from '../src/services/plugin-service/plugin-registry.js'
import type { PluginDescriptor } from '../src/services/plugin-service/plugin-types.js'

let tmpDir: string

/** trusted 通道身份（Worker 级，多插件共享，无唯一归属） */
const TRUSTED: RpcIdentity = { trustLevel: 'trusted' }
/** sandbox 通道身份（processId = sandbox-<pluginId> 一对一） */
function sandbox(pluginId: string): RpcIdentity {
  return { trustLevel: 'sandbox', pluginId }
}

function makeDescriptor(overrides: Partial<PluginDescriptor> = {}): PluginDescriptor {
  return {
    pluginId: 'test-plugin',
    version: '1.0.0',
    displayName: 'Test',
    description: '',
    main: 'index.js',
    activationEvents: [],
    trustLevel: 'sandbox',
    status: 'UNLOADED',
    contributes: {},
    permissions: [],
    engines: { 'taiji': '*' },
    pluginPath: '/tmp/test',
    source: 'external',
    extensionDependencies: [],
    ...overrides,
  }
}

function createMockRegistry(descriptors: PluginDescriptor[]): PluginRegistry {
  const map = new Map(descriptors.map(d => [d.pluginId, d]))
  return {
    getDescriptor: (id: string) => map.get(id),
  } as unknown as PluginRegistry
}

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'plugin-permission-test-'))
})

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

describe('PermissionChecker（通道身份鉴权）', () => {
  describe('trusted 通道', () => {
    it('trusted 身份 check() 全放行（worker 级语义，消息体自报 id 不参与）', () => {
      const registry = createMockRegistry([
        makeDescriptor({ pluginId: 'statusline', trustLevel: 'trusted', source: 'built-in' }),
      ])
      const checker = new PluginPermissionChecker(registry, new PermissionStorage(tmpDir))

      // 未 grant 任何权限，trusted 通道身份仍全放行
      expect(checker.check(TRUSTED, 'plugin.tools.register')).toBe(true)
      expect(checker.check(TRUSTED, 'plugin.hooks.register')).toBe(true)
      expect(checker.check(TRUSTED, 'any.method')).toBe(true)
    })
  })

  describe('sandbox 通道', () => {
    it('未授权方法 check() 拒绝', () => {
      const registry = createMockRegistry([
        makeDescriptor({ pluginId: 'sandbox-1', trustLevel: 'sandbox' }),
      ])
      const checker = new PluginPermissionChecker(registry, new PermissionStorage(tmpDir))

      expect(checker.check(sandbox('sandbox-1'), 'plugin.tools.register')).toBe(false)
    })

    it('sandbox 身份缺 pluginId → fail-closed 拒绝（通道注册异常）', () => {
      const registry = createMockRegistry([])
      const checker = new PluginPermissionChecker(registry, new PermissionStorage(tmpDir))

      expect(checker.check({ trustLevel: 'sandbox' }, 'plugin.notify')).toBe(false)
    })

    it('grant() 完整方法名后 check() 命中（granted 集与 check 同口径）', () => {
      const registry = createMockRegistry([
        makeDescriptor({ pluginId: 'sandbox-2', trustLevel: 'sandbox' }),
      ])
      const checker = new PluginPermissionChecker(registry, new PermissionStorage(tmpDir))

      checker.grant('sandbox-2', ['plugin.tools.register', 'plugin.hooks.register'])
      expect(checker.check(sandbox('sandbox-2'), 'plugin.tools.register')).toBe(true)
      expect(checker.check(sandbox('sandbox-2'), 'plugin.hooks.register')).toBe(true)
    })

    it('grant() 任意口径归一化：SDK 常量 / 短形 / legacy / 完整名同集生效', () => {
      const registry = createMockRegistry([
        makeDescriptor({ pluginId: 'norm', trustLevel: 'sandbox' }),
      ])
      const checker = new PluginPermissionChecker(registry, new PermissionStorage(tmpDir))

      checker.grant('norm', [
        'storage.access',          // SDK 常量（8 个 storage 方法全集）
        'hooks.register',          // manifest 短形（连带 unregister）
        'workspace:file:search',   // demo legacy 形
        'plugin.sessions.sendMessage', // 已是完整方法名（幂等透传）
      ])

      // storage.access → 8 个 storage 方法
      for (const m of [
        'plugin.storage.global.get', 'plugin.storage.global.set',
        'plugin.storage.global.delete', 'plugin.storage.global.keys',
        'plugin.storage.workspace.get', 'plugin.storage.workspace.set',
        'plugin.storage.workspace.delete', 'plugin.storage.workspace.keys',
      ]) {
        expect(checker.check(sandbox('norm'), m)).toBe(true)
      }
      // hooks.register → register + unregister 成对授予
      expect(checker.check(sandbox('norm'), 'plugin.hooks.register')).toBe(true)
      expect(checker.check(sandbox('norm'), 'plugin.hooks.unregister')).toBe(true)
      // legacy 形 → workspace.findFiles
      expect(checker.check(sandbox('norm'), 'plugin.workspace.findFiles')).toBe(true)
      // 完整方法名透传
      expect(checker.check(sandbox('norm'), 'plugin.sessions.sendMessage')).toBe(true)
      // 未授权方法仍拒
      expect(checker.check(sandbox('norm'), 'plugin.agent.setModel')).toBe(false)
    })

    it('check() 语义按 identity.pluginId 分区：他人授权不串门', () => {
      const registry = createMockRegistry([
        makeDescriptor({ pluginId: 'a', trustLevel: 'sandbox' }),
        makeDescriptor({ pluginId: 'b', trustLevel: 'sandbox' }),
      ])
      const checker = new PluginPermissionChecker(registry, new PermissionStorage(tmpDir))

      checker.grant('a', ['plugin.notify'])
      // a 的通道身份可调；b 的通道身份不可调（即使 b 伪冒 params.pluginId='a'，
      // 鉴权也不看消息体——check 只收通道身份）
      expect(checker.check(sandbox('a'), 'plugin.notify')).toBe(true)
      expect(checker.check(sandbox('b'), 'plugin.notify')).toBe(false)
    })

    it('未授权插件（granted 无条目）check() 拒绝', () => {
      const registry = createMockRegistry([])
      const checker = new PluginPermissionChecker(registry, new PermissionStorage(tmpDir))

      expect(checker.check(sandbox('nonexistent'), 'plugin.tools.register')).toBe(false)
    })

    it('grant() 追加不覆盖已有权限', () => {
      const registry = createMockRegistry([
        makeDescriptor({ pluginId: 'sandbox-5', trustLevel: 'sandbox' }),
      ])
      const checker = new PluginPermissionChecker(registry, new PermissionStorage(tmpDir))

      checker.grant('sandbox-5', ['plugin.tools.register'])
      checker.grant('sandbox-5', ['plugin.hooks.register'])

      expect(checker.check(sandbox('sandbox-5'), 'plugin.tools.register')).toBe(true)
      expect(checker.check(sandbox('sandbox-5'), 'plugin.hooks.register')).toBe(true)
    })

    it('revoke() 后 check() 拒绝；未知 pluginId revoke() no-op', () => {
      const registry = createMockRegistry([
        makeDescriptor({ pluginId: 'sandbox-4', trustLevel: 'sandbox' }),
      ])
      const checker = new PluginPermissionChecker(registry, new PermissionStorage(tmpDir))

      checker.grant('sandbox-4', ['plugin.tools.register'])
      expect(checker.check(sandbox('sandbox-4'), 'plugin.tools.register')).toBe(true)

      checker.revoke('sandbox-4')
      expect(checker.check(sandbox('sandbox-4'), 'plugin.tools.register')).toBe(false)
      expect(() => checker.revoke('nonexistent')).not.toThrow()
    })
  })

  describe('getUnapproved（声明侧归一化对齐）', () => {
    it('trusted / built-in 插件不需审批', () => {
      const registry = createMockRegistry([
        makeDescriptor({ pluginId: 'builtin-x', trustLevel: 'trusted', source: 'built-in' }),
      ])
      const checker = new PluginPermissionChecker(registry, new PermissionStorage(tmpDir))
      expect(checker.getUnapproved('builtin-x', ['plugin.notify'])).toEqual([])
    })

    it('声明的权限词映射方法全部已 grant → 空列表；部分未 grant → 原词返回', () => {
      const registry = createMockRegistry([
        makeDescriptor({ pluginId: 'g', trustLevel: 'sandbox', source: 'external' }),
      ])
      const checker = new PluginPermissionChecker(registry, new PermissionStorage(tmpDir))

      checker.grant('g', ['plugin.notify'])
      // notify 常量映射 [plugin.notify, plugin.ui.notify]，只 grant 了 plugin.notify
      // → 未全部覆盖，仍视为未批准
      expect(checker.getUnapproved('g', ['notify'])).toEqual(['notify'])
      checker.grant('g', ['plugin.ui.notify'])
      expect(checker.getUnapproved('g', ['notify'])).toEqual([])
    })

    it('未知权限词（归一化为空）不进入未批准列表——无从审批，执法点在 RPC 层', () => {
      const registry = createMockRegistry([
        makeDescriptor({ pluginId: 'u', trustLevel: 'sandbox', source: 'external' }),
      ])
      const checker = new PluginPermissionChecker(registry, new PermissionStorage(tmpDir))
      expect(checker.getUnapproved('u', ['totally.unknown.permission'])).toEqual([])
    })
  })
})

describe('PermissionStorage', () => {
  it('load() initializes empty map when file does not exist', async () => {
    const storage = new PermissionStorage(join(tmpDir, 'nonexistent-dir'))
    const map = await storage.load()

    expect(map instanceof Map).toBeTruthy()
    expect(map.size).toBe(0)
  })

  it('save() + load() round-trip: 完整方法名幂等透传', async () => {
    const dir = join(tmpDir, 'perm-storage')
    await mkdir(dir, { recursive: true })
    const storage = new PermissionStorage(dir)

    const data = new Map<string, string[]>()
    data.set('plugin-a', ['plugin.tools.register', 'plugin.hooks.register'])
    data.set('plugin-b', ['plugin.sessions.sendMessage'])

    await storage.save(data)

    const loaded = await storage.load()
    expect(loaded.size).toBe(2)
    expect(loaded.get('plugin-a')).toEqual(['plugin.tools.register', 'plugin.hooks.register'])
    expect(loaded.get('plugin-b')).toEqual(['plugin.sessions.sendMessage'])
  })

  it('save() overwrites previous data', async () => {
    const dir = join(tmpDir, 'perm-storage-2')
    await mkdir(dir, { recursive: true })
    const storage = new PermissionStorage(dir)

    const data1 = new Map<string, string[]>()
    data1.set('plugin-a', ['plugin.tools.register'])
    await storage.save(data1)

    const data2 = new Map<string, string[]>()
    data2.set('plugin-b', ['plugin.hooks.register'])
    await storage.save(data2)

    const loaded = await storage.load()
    expect(loaded.size).toBe(1)
    expect(loaded.get('plugin-b')).toEqual(['plugin.hooks.register'])
    expect(loaded.get('plugin-a')).toBe(undefined)
  })

  it('load() 旧声明形数据归一化迁移（SDK 常量 / 短形 → 完整方法名，去重保序）', async () => {
    const dir = join(tmpDir, 'perm-storage-migrate')
    await mkdir(dir, { recursive: true })
    // 手写历史格式的 permissions.json（声明形口径 + 重复词）
    await writeFile(
      join(dir, 'permissions.json'),
      JSON.stringify({
        legacy: ['storage.access', 'storage.set', 'storage.access', 'hooks.register'],
        modern: ['plugin.notify'],
      }),
      'utf-8',
    )

    const storage = new PermissionStorage(dir)
    const loaded = await storage.load()

    // storage.access 全集 ∪ storage.set 短形（global+workspace.set）去重合并
    expect(new Set(loaded.get('legacy'))).toEqual(new Set([
      'plugin.storage.global.get', 'plugin.storage.global.set',
      'plugin.storage.global.delete', 'plugin.storage.global.keys',
      'plugin.storage.workspace.get', 'plugin.storage.workspace.set',
      'plugin.storage.workspace.delete', 'plugin.storage.workspace.keys',
      'plugin.hooks.register', 'plugin.hooks.unregister',
    ]))
    // 已是完整方法名的数据不变形
    expect(loaded.get('modern')).toEqual(['plugin.notify'])
  })

  it('load() handles corrupted JSON gracefully', async () => {
    const dir = join(tmpDir, 'perm-storage-3')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'permissions.json'), 'not valid json{{{', 'utf-8')

    const storage = new PermissionStorage(dir)
    const map = await storage.load()
    expect(map instanceof Map).toBeTruthy()
    expect(map.size).toBe(0)
  })
})
