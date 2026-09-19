/**
 * 权限词汇 ↔ RPC 方法名映射 SSOT 完整性测试（AC-I6）
 *
 * 防漂移三件套：
 *  1. SDK PermissionConstants 全量常量经 normalizePermissionInput 归一非空
 *     （SDK 新增常量而映射表未收录时，此用例红）
 *  2. PLUGIN_RPC_METHODS 与真实 PluginRpcServer 注册表集合相等（双向）：
 *     任何口径归一化产出的方法名都真实存在（无孤儿）；真实注册的新方法
 *     未收录进 SSOT 表也会红
 *  3. 三口径（SDK 常量 / manifest 短形 / demo legacy 形）归一化行为正确
 *
 * 真实注册表构造：PluginService 真实实例 + internals cast 调私有 registerRpcMethods
 * （approval-wake 同模式），rpcServer.listMethods() 取全量——不手工拼注册表，
 * 生产注册链路变更（新增/删除 RPC 方法）即时反映。
 *
 * 运行命令: cd packages/runtime && npx vitest run test/plugin-permission-map.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  PLUGIN_RPC_METHODS,
  normalizePermissionInput,
} from '@taiji/shared/plugin-permission-map'
// plugin-sdk 的 types.ts 刻意零依赖（纯类型 + Object.freeze 常量），跨包相对
// import 直连源文件——测试直接绑定 SDK 常量真身，不引入 runtime 对 sdk 的包依赖
import { PermissionConstants } from '../../plugin-sdk/src/types.js'

import { PluginService } from '../src/services/plugin-service/plugin-service.js'
import type { PluginRpcServer } from '../src/services/plugin-service/plugin-rpc-server.js'
import type { PluginRegistry } from '../src/services/plugin-service/plugin-registry.js'
import type { IMessageBroker } from '../src/interfaces.js'

/** PluginService 测试视图：私有协作者注入缝（approval-wake / uninstall-shutdown 同模式） */
interface ServiceInternals {
  rpcServer: PluginRpcServer
  registerRpcMethods: () => void
}

/**
 * SSOT 已登记、RPC handler 尚未实装的方法豁免表（u2d 批次建立）。[u5b 已清空]：
 * activate 订阅族（session-api 六点扩表）与 ui 命令式三点位（ui-api showModal/
 * hideModal/updateHeaderAction）handler 均已落地，5 方法全部转正——豁免表保留空集
 * 形态供后续批次复用（登记即债务，落地即清账）。
 */
const PENDING_U5B_METHODS: ReadonlySet<string> = new Set<string>([])

describe('plugin-permission-map SSOT（AC-I6）', () => {
  let tmpDir: string
  /** 真实 PluginRpcServer 注册表全量（registerAllRpcMethods 产物） */
  let registeredMethods: Set<string>

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'plugin-perm-map-'))
    const registryMock = {
      getDescriptor: () => undefined,
      getAllDescriptors: () => [],
    }
    const broker: IMessageBroker = { send: () => {}, broadcast: () => {}, sendError: () => {} }
    const service = new PluginService(registryMock as unknown as PluginRegistry, broker, {
      configDir: tmpDir,
    })
    const internals = service as unknown as ServiceInternals
    internals.registerRpcMethods()
    registeredMethods = new Set(internals.rpcServer.listMethods())
  })

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('AC-I6: SDK PermissionConstants 全量常量归一非空（新常量未收录映射表时红）', () => {
    const values = Object.values(PermissionConstants)
    // 前置：常量表非空（防御 SDK 常量表被清空导致用例空转假绿）
    expect(values.length).toBeGreaterThan(0)
    for (const v of values) {
      const methods = normalizePermissionInput(v)
      expect(methods.length, `constant '${v}' must normalize to non-empty method set`).toBeGreaterThan(0)
      for (const m of methods) {
        expect(typeof m).toBe('string')
      }
    }
  })

  it('AC-I6: PLUGIN_RPC_METHODS 与真实 rpcServer 注册表集合相等（双向防漂移）', () => {
    // SSOT 表 ⊆ 真实注册表：表里的方法都真实存在（无幽灵方法）。
    // PENDING_U5B_METHODS 例外反向锁定：登记在案但 handler 随 U5 落地——
    // 若已实装（should be false 变红）说明 U5 已交付，须从豁免表移除并更新 size 锚点。
    for (const m of PLUGIN_RPC_METHODS) {
      if (PENDING_U5B_METHODS.has(m)) {
        expect(registeredMethods.has(m), `pending method '${m}' is now registered on PluginRpcServer — remove it from PENDING_U5B_METHODS and bump the size anchor`).toBe(false)
        continue
      }
      expect(registeredMethods.has(m), `SSOT method '${m}' not registered on real PluginRpcServer`).toBe(true)
    }
    // 真实注册表 ⊆ SSOT 表：新增 RPC 方法未收录进 SSOT 表时红（孤儿方法，
    // 任何权限词汇都映射不到它 → sandbox 插件永远无法获得授权）
    const ssot = new Set<string>(PLUGIN_RPC_METHODS)
    const orphans = [...registeredMethods].filter(m => !ssot.has(m))
    expect(orphans, `methods registered but missing from PLUGIN_RPC_METHODS: ${orphans.join(', ')}`).toEqual([])
    // 数量级回归锚点：47（agent5 commands3 config3 hooks2 notify1 sessionData4
    // sessions8 storage8 tools2 ui6 views2 workspace3）+ AP-4 读面 9（readEntries/
    // getCommands/register+unregisterEntryInvalidation 4 + activate 族 2 + ui 三点位 3，
    // [u5b] 后五者 handler 已落地转正）= 56。registeredMethods.size 同步锚点：56/56。
    expect(PLUGIN_RPC_METHODS.length).toBe(56)
    expect(registeredMethods.size).toBe(56)
  })

  it('AC-I6: 全部口径归一化产物无孤儿（每个产出方法名都在真实注册表）', () => {
    // 三口径全集：SDK 常量 + manifest 常用短形 + demo legacy 形 + 完整方法名样本
    const inputs = [
      ...Object.values(PermissionConstants),
      'storage.get', 'storage.set', 'storage.delete', 'storage.keys',
      'workspace:file:search',
      'plugin.hooks.register', 'plugin.storage.global.set',
    ]
    for (const input of inputs) {
      const methods = normalizePermissionInput(input)
      expect(methods.length, `input '${input}' must map to non-empty set`).toBeGreaterThan(0)
      for (const m of methods) {
        // 豁免表（PENDING_U5B_METHODS）当前为空：全部登记方法均已实装
        expect(registeredMethods.has(m) || PENDING_U5B_METHODS.has(m), `mapped method '${m}' (from '${input}') not on real PluginRpcServer`).toBe(true)
      }
    }
  })

  it('AC-I6: 短形 / SDK 常量 / legacy 形归一化正确（能力 → 方法集映射语义）', () => {
    // SDK 常量 → 能力全集
    expect(normalizePermissionInput('storage.access')).toEqual([
      'plugin.storage.global.get', 'plugin.storage.global.set',
      'plugin.storage.global.delete', 'plugin.storage.global.keys',
      'plugin.storage.workspace.get', 'plugin.storage.workspace.set',
      'plugin.storage.workspace.delete', 'plugin.storage.workspace.keys',
    ])
    expect(normalizePermissionInput('sessions.readState')).toEqual([
      'plugin.sessions.list', 'plugin.sessions.get', 'plugin.sessions.getActive',
      'plugin.sessions.registerCreate', 'plugin.sessions.registerDestroy',
      'plugin.sessions.unregisterCreate', 'plugin.sessions.unregisterDestroy',
      // AP-4 读面（U2）：数据读 + entry 失效订阅族 + 激活订阅族（[u5b] handler 均已实装）
      'plugin.sessions.readEntries', 'plugin.sessions.getCommands',
      'plugin.sessions.registerEntryInvalidation', 'plugin.sessions.unregisterEntryInvalidation',
      'plugin.sessions.registerActivate', 'plugin.sessions.unregisterActivate',
    ])
    // 注册类能力连带 unregister（成对授予避免「能注册不能注销」）
    expect(normalizePermissionInput('tools.register')).toEqual(['plugin.tools.register', 'plugin.tools.unregister'])
    expect(normalizePermissionInput('hooks.register')).toEqual(['plugin.hooks.register', 'plugin.hooks.unregister'])
    expect(normalizePermissionInput('notify')).toEqual(['plugin.notify', 'plugin.ui.notify'])
    expect(normalizePermissionInput('sessions.sendMessage')).toEqual(['plugin.sessions.sendMessage'])

    // manifest 短形 → global + workspace 双 scope
    expect(normalizePermissionInput('storage.set')).toEqual(['plugin.storage.global.set', 'plugin.storage.workspace.set'])

    // legacy 形（demo 插件 workspace:file:search）
    expect(normalizePermissionInput('workspace:file:search')).toEqual(['plugin.workspace.findFiles'])

    // 完整方法名幂等透传（二次归一不变形）
    expect(normalizePermissionInput('plugin.config.get')).toEqual(['plugin.config.get'])
    // 未收录进 alias 表的去前缀形经 plugin. 前缀补全命中
    expect(normalizePermissionInput('sessions.list')).toEqual(['plugin.sessions.list'])
  })

  it('AC-I6: 未知词 / 空白 / 非字符串归一为空数组（fail-closed）', () => {
    expect(normalizePermissionInput('totally.unknown')).toEqual([])
    expect(normalizePermissionInput('workspace:file:write')).toEqual([])
    expect(normalizePermissionInput('')).toEqual([])
    expect(normalizePermissionInput('   ')).toEqual([])
    // @ts-expect-error 运行时防御：非字符串输入（磁盘旧数据可能是任意 JSON 值）
    expect(normalizePermissionInput(undefined)).toEqual([])
    // @ts-expect-error 运行时防御
    expect(normalizePermissionInput(42)).toEqual([])
  })
})
