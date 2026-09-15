/**
 * ConfigService — runtime enabled 读写链路（W2）端到端单测。
 *
 * 用真实 PiConfigStore（指向临时目录的 models.json）验证：
 * U1 listProviders 返回 provider 级 api 字段（修复编辑回填丢失 api，P0-1）+ enabled
 * U2 setProvider 写入 enabled 并被 listProviders 读回（真实读写 models.json，非硬编码）
 * U3 setProvider 写入 model 级 enabled 并被 aggregateModels 过滤（在 model-service.test.ts 验证过滤逻辑，
 *    此处只验证 listProviders 读回 model 级 enabled 字段）
 *
 * setup 模式复用 pi-provider-store.test.ts：setModelsPath/setSettingsPath 指向临时目录 +
 * writeModels 落盘 + refreshModels 刷缓存。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import type { LlmRetryConfig } from '@xyz-agent/shared'
import { ConfigService } from '../src/services/config-service.js'
import { AuthStorage } from '../src/services/auth/auth-storage.js'
import { ProviderCredentialResolver } from '../src/services/auth/provider-credential-resolver.js'
import type { ILlmRetrySettings, LlmRetryConfigSnapshot } from '../src/services/ports/llm-retry-settings.js'
import { PiConfigStore } from '../src/infra/pi/pi-config-store.js'
import { XyzProviderStore } from '../src/services/provider-extras-store.js'
import {
  writeModels,
  refreshModels,
  setModelsPath,
  type PiModelsConfig,
} from '../src/infra/pi/pi-provider-store.js'
import { setSettingsPath } from '../src/infra/pi/pi-settings-store.js'

const mkdtempP = promisify(mkdtemp)
const rmP = promisify(rm)

let tmpDir: string
let configStore: PiConfigStore
let configService: ConfigService

/**
 * M2fg 恒注入形态：凭据判定经 resolver 批量 sync 版（D3 唯一通道）。
 * auth.json 腿指向临时目录（零凭据 miss），models.json 腿经真 configStore。
 */
function makeResolver(store: PiConfigStore): ProviderCredentialResolver {
  return new ProviderCredentialResolver({
    authService: { getCredential: async () => undefined },
    authStorage: new AuthStorage(join(tmpDir, 'agent', 'auth.json')),
    configStore: store,
  })
}

beforeEach(async () => {
  tmpDir = await mkdtempP(join(tmpdir(), 'config-service-test-'))
  mkdirSync(join(tmpDir, 'agent'), { recursive: true })
  // 指向临时目录，避免污染真实 ~/.xyz-agent/agent
  setModelsPath(join(tmpDir, 'agent', 'models.json'))
  setSettingsPath(join(tmpDir, 'agent', 'settings.json'))
  refreshModels()
  // ConfigService 接受 IConfigStore；用真实 PiConfigStore 走完整读写链路
  configStore = new PiConfigStore()
  configService = new ConfigService(tmpDir, configStore, undefined, undefined, undefined, makeResolver(configStore))
})

afterEach(async () => {
  await rmP(tmpDir, { recursive: true, force: true })
})

// ── U1: listProviders 返回 provider 级 api 字段 ────────────────────
// 修复编辑回填丢失 api：前端编辑 provider 时需用 api 字段回填 type 下拉，
// listProviders 不返回 api 会导致编辑后 type 丢失（P0-1）。
describe('ConfigService.listProviders · provider 级 api 字段（U1，修复 P0-1）', () => {
  it('返回 provider 的 api 字段（非 undefined）', () => {
    const models: PiModelsConfig = {
      providers: {
        p1: {
          api: 'anthropic-messages',
          apiKey: 'sk-x',
          enabled: true,
          models: [],
        },
      },
    }
    writeModels(models)
    refreshModels()

    const providers = configService.listProviders()
    expect(providers).toHaveLength(1)
    expect(providers[0]!.id).toBe('p1')
    // 关键断言：api 字段必须回填，否则前端编辑 provider 时 type 下拉丢失
    expect(providers[0]!.api).toBe('anthropic-messages')
  })

  it('enabled=true 的 provider 返回 enabled === true', () => {
    const models: PiModelsConfig = {
      providers: {
        p1: {
          apiKey: 'sk-x',
          enabled: true,
          models: [],
        },
      },
    }
    writeModels(models)
    refreshModels()

    const providers = configService.listProviders()
    expect(providers[0]!.enabled).toBe(true)
  })
})

// ── U2: provider 级 enabled 读写链路（enabledModels 白名单模型）────────
// wave3/wave4 演进：provider 级 enabled 从「models.json provider.enabled 字段」迁移到
// 「settings.json enabledModels 白名单」。setProvider 不再写 provider.enabled（wave3 C5/TC6：
// 前端 provider 启用切换改走 toggleProviderEnabled），listProviders 的 enabled 从
// deriveEnabled(id, enabledModels) 派生（DM3/F2，不读 models.json provider.enabled）。
//
// 故 U2 的读写链路 = toggleProviderEnabled 写 enabledModels 白名单 → listProviders 经
// deriveEnabled 读回。白名单空/undefined = 全可用（deriveEnabled 恒 true）；非空 = 白名单匹配才启用。
// 要测「禁用」语义，须先让白名单非空（模拟用户已显式收窄启用范围）——空白名单下 toggle(false) 幂等 no-op。
describe('ConfigService · provider 级 enabled 读写链路（U2，enabledModels 白名单模型）', () => {
  it('toggleProviderEnabled(p1, false) 后 listProviders 读回 enabled === false', () => {
    writeModels({
      providers: {
        p1: { apiKey: 'sk-x', models: [{ id: 'm1', name: 'M1' }] },
        p2: { apiKey: 'sk-y', models: [{ id: 'm2', name: 'M2' }] },
      },
    })
    refreshModels()
    // 建立非空白名单（模拟用户已显式启用部分 provider）。空白名单=全可用，toggle(false) 幂等 no-op。
    configStore.setEnabledModels(['p1/*', 'p2/*'])

    configService.toggleProviderEnabled('p1', false)

    const providers = configService.listProviders()
    // p1 被移出白名单 → deriveEnabled(p1) === false
    expect(providers.find(p => p.id === 'p1')?.enabled).toBe(false)
    // 副作用断言：禁用 p1 不误伤 p2（startsWith('p1/') 不匹配 'p2/*'，防 openai vs openai-compatible 前缀碰撞）
    expect(providers.find(p => p.id === 'p2')?.enabled).toBe(true)
  })

  it('toggleProviderEnabled(p1, true) 把已禁用的 p1 加回白名单后读回 enabled === true', () => {
    writeModels({
      providers: {
        p1: { apiKey: 'sk-x', models: [{ id: 'm1', name: 'M1' }] },
        p2: { apiKey: 'sk-y', models: [{ id: 'm2', name: 'M2' }] },
      },
    })
    refreshModels()
    // p1 不在白名单（已被禁用），p2 在 → 非空白名单下 deriveEnabled(p1) === false
    configStore.setEnabledModels(['p2/*'])
    expect(configService.listProviders().find(p => p.id === 'p1')?.enabled).toBe(false)

    // toggle(true) 在白名单非空时补加 p1/*（空白名单下 no-op，故前置条件必须非空）
    configService.toggleProviderEnabled('p1', true)

    expect(configService.listProviders().find(p => p.id === 'p1')?.enabled).toBe(true)
  })

  it('toggleProviderEnabled(p1, false) 后盘上 settings.json 持久化移除 p1 pattern（端到端非硬编码）', () => {
    writeModels({
      providers: {
        p1: { apiKey: 'sk-x', models: [{ id: 'm1', name: 'M1' }] },
        p2: { apiKey: 'sk-y', models: [{ id: 'm2', name: 'M2' }] },
      },
    })
    refreshModels()
    configStore.setEnabledModels(['p1/*', 'p2/*'])

    configService.toggleProviderEnabled('p1', false)

    // 直接读盘验证（绕过 service 缓存）：enabledModels 白名单落盘到 settings.json（非 models.json）
    const raw = readFileSync(
      join(tmpDir, 'agent', 'settings.json'),
      'utf-8',
    )
    const parsed = JSON.parse(raw) as { enabledModels?: string[] }
    // p1 的 pattern 被移除，仅剩 p2（startsWith('p1/') 统一匹配 provider 级与 model 级 pattern）
    expect(parsed.enabledModels).toEqual(['p2/*'])
    expect(parsed.enabledModels?.some(p => p.startsWith('p1/'))).toBe(false)
  })
})

// ── 向上兼容：存量 provider 无 enabled 字段时默认视为启用 ──────────
// config.enabled !== false 语义：undefined 和 true 都视为启用，
// 只有显式 false 才禁用（向上兼容存量无此字段的 provider）。
describe('ConfigService.listProviders · 向上兼容（无 enabled 字段默认 true）', () => {
  it('存量 provider 无 enabled 字段时 enabled === true（向上兼容）', () => {
    // 故意不写 enabled 字段（模拟存量 models.json）
    const models: PiModelsConfig = {
      providers: {
        legacy: {
          apiKey: 'sk-legacy',
          models: [{ id: 'm1' }],
        },
      },
    }
    writeModels(models)
    refreshModels()

    const providers = configService.listProviders()
    expect(providers[0]!.enabled).toBe(true)
  })
})

// ── U3 前置：listProviders 读回 model 级 enabled（aggregateModels 过滤在 model-service.test.ts 验证）──
describe('ConfigService.listProviders · model 级 enabled 透传', () => {
  it('model 级 enabled=false 透传到 listProviders 结果', () => {
    writeModels({
      providers: {
        p1: {
          apiKey: 'sk-x',
          models: [
            { id: 'm1', name: 'M1', enabled: false },
            { id: 'm2', name: 'M2', enabled: true },
          ],
        },
      },
    })
    refreshModels()

    const providers = configService.listProviders()
    const models = providers[0]!.models
    // model 级 enabled 透传，供 aggregateModels 过滤判断
    expect(models.find(m => m.id === 'm1')?.enabled).toBe(false)
    expect(models.find(m => m.id === 'm2')?.enabled).toBe(true)
  })
})

// ── U3b: setProvider 的 model 合并写路径必须保留传入的 enabled/api/baseUrl ──
// review 发现：setProvider 的 model 合并循环只写 name/contextWindow/input/thinkingLevelMap，
// 前端回传的 api/baseUrl/enabled 被丢弃。新模型（base={}）和编辑现有模型场景都会丢字段。
// 此 describe 走 setProvider 写路径（而非 writeModels 直写），断言字段真落盘。
// [G3 写侧切换] enabled 的落点改为 providers.json modelStates（models.json 不再写寄生字段）。
describe('ConfigService.setProvider · model 级字段写路径（U3b，修复 review must_fix #1）', () => {
  it('新模型经 setProvider 保存后 enabled 生效（G3：落 providers.json modelStates，models.json 不落 enabled）', async () => {
    // 先建空 provider
    writeModels({
      providers: {
        p1: {
          apiKey: 'sk-x',
          models: [],
        },
      },
    })
    refreshModels()

    // [G3] enabled 落 providers.json modelStates——注入 extrasStore（生产恒注入）；
    // 未注入时 enabled 丢弃 + warn（宁丢不写错位，provider-write-side-switch.test.ts 覆盖）
    const extrasStore = new XyzProviderStore(join(tmpDir, 'agent', 'config', 'providers.json'))
    const svc = new ConfigService(tmpDir, configStore, undefined, extrasStore, undefined, makeResolver(configStore))

    // setProvider 传入含 enabled 的 model（新模型，base={}）。modelStates 写入经
    // withFileLock 异步 RMW——必须 await 落盘后再断言
    await svc.setProvider('p1', {
      models: [
        { id: 'm1', enabled: false },
        { id: 'm2', enabled: true },
      ],
    })

    // 聚合层读 modelStates：enabled 语义保留（编辑保存不丢失）
    const providers = svc.listProviders()
    const models = providers[0]!.models
    expect(models.find(m => m.id === 'm1')?.enabled).toBe(false)
    expect(models.find(m => m.id === 'm2')?.enabled).toBe(true)

    // models.json 不再序列化 enabled（pi schema 外寄生字段禁复活）
    const raw = JSON.parse(readFileSync(join(tmpDir, 'agent', 'models.json'), 'utf-8'))
    const rawModels = raw.providers.p1.models as Array<Record<string, unknown>>
    expect(rawModels.find(m => m.id === 'm1')).not.toHaveProperty('enabled')
    expect(rawModels.find(m => m.id === 'm2')).not.toHaveProperty('enabled')
  })

  it('model 级 api/baseUrl 经 setProvider 保存后落盘（编辑场景）', () => {
    // 先建含 m1 的 provider（m1 无 api/baseUrl）
    writeModels({
      providers: {
        p1: {
          apiKey: 'sk-x',
          api: 'anthropic-messages',
          models: [{ id: 'm1', name: 'M1' }],
        },
      },
    })
    refreshModels()

    // 编辑 m1，补 model 级 api/baseUrl（覆盖 provider 默认）
    configService.setProvider('p1', {
      models: [
        { id: 'm1', name: 'M1', api: 'openai-completions', baseUrl: 'https://m1.example.com' },
      ],
    })

    const providers = configService.listProviders()
    const m1 = providers[0]!.models.find(m => m.id === 'm1')
    expect(m1?.api).toBe('openai-completions')
    expect(m1?.baseUrl).toBe('https://m1.example.com')
  })

  it('model 级 compat 经 setProvider 保存后落盘（修复隐性数据丢失 bug）', () => {
    // 先建含 m1 的 provider（m1 已有 compat——模拟用户手改 json 配好的）
    writeModels({
      providers: {
        p1: {
          apiKey: 'sk-x',
          api: 'openai-completions',
          models: [{
            id: 'm1',
            name: 'M1',
            compat: { supportsDeveloperRole: false, thinkingFormat: 'deepseek' },
          }],
        },
      },
    })
    refreshModels()

    // 前端编辑 provider（不改 m1 的 compat——localModels 经 ...m 展开回传）
    // bug 复现：setProvider 合并逻辑若不透传 compat，m1.compat 会被静默丢弃
    configService.setProvider('p1', {
      models: [
        { id: 'm1', name: 'M1', compat: { supportsDeveloperRole: false, thinkingFormat: 'deepseek' } },
      ],
    })

    const providers = configService.listProviders()
    const m1 = providers[0]!.models.find(m => m.id === 'm1')
    expect(m1?.compat).toEqual({ supportsDeveloperRole: false, thinkingFormat: 'deepseek' })
  })

  it('model 级 compat 显式覆盖：编辑后 compat 更新落盘', () => {
    writeModels({
      providers: {
        p1: {
          apiKey: 'sk-x',
          api: 'openai-completions',
          models: [{ id: 'm1', compat: { supportsDeveloperRole: true } }],
        },
      },
    })
    refreshModels()

    // 用户在 UI 把 supportsDeveloperRole 改成 false
    configService.setProvider('p1', {
      models: [
        { id: 'm1', compat: { supportsDeveloperRole: false } },
      ],
    })

    const m1 = configService.listProviders()[0]!.models.find(m => m.id === 'm1')
    expect(m1?.compat).toEqual({ supportsDeveloperRole: false })
  })

  it('setProvider 删除已存在的 compat（compat === undefined 触发删除）', () => {
    // 1. 先写一个带 compat 的 model（模拟用户已配好的 compat）
    writeModels({
      providers: {
        p1: {
          apiKey: 'sk-x',
          api: 'openai-completions',
          models: [{ id: 'm1', compat: { thinkingFormat: 'xml' } }],
        },
      },
    })
    refreshModels()

    // 2. setProvider 传 models 不含 compat 字段（compat 为 undefined）——模拟前端 clearAll 按钮
    //    buildMap() 全 passthrough 时 buildCompat 返回 undefined，前端整体提交 models 时
    //    该 model 无 compat 键，应触发 else if 删除分支。
    configService.setProvider('p1', {
      models: [{ id: 'm1' }],
    })

    // 3. 读回的 compat 应为 undefined（被 delete，而非保留盘上旧值）
    const m1 = configService.listProviders()[0]!.models.find(m => m.id === 'm1')
    expect(m1?.compat).toBeUndefined()
  })
})

// ── W1: loadAgents sourceType 必须随来源目录推断（不再恒 'pi'）──────
// 背景：config-service.loadAgents 旧版把每个 agent 硬编码 source/sourceType = 'pi'，
// 导致 Settings Agent 页按 Claude/Agents tab 过滤时永远空（即便文件来自 ~/.claude/agents）。
// W1 修复：agent-crud.listAgentFiles 扫描时按 discovered 目录 inferSourceType 填 sourceType，
// config-service.loadAgents 透传该字段。
// 这里 mock configStore.listAgentFiles 返回带不同 sourceType 的 entry，
// 验证 loadAgents 不再恒 pi，而是如实透传。
describe('ConfigService.loadAgents · sourceType 随来源推断（W1，修复 tab 过滤失效）', () => {
  /**
   * 构造一个最小 fake configStore：只实现 loadAgents 用到的方法。
   * listAgentFiles 按 mockFiles 返回（含 sourceType），其余方法返回安全空值。
   * 跳过真实 PiConfigStore 是为了隔离：本测只验证「f.sourceType → AgentInfo.sourceType 透传」，
   * 不关心目录扫描/去重逻辑（那部分在 agent-crud 层，由真实文件验证更合适）。
   */
  function makeFakeStore(
    mockFiles: Array<{ name: string; path: string; content: string; sourceType: string }>,
  ) {
    return {
      getPiAgentDir: () => '/fake/agent',
      getAgentDirs: () => [] as string[],
      listAgentFiles: () => mockFiles,
      // 以下方法 loadAgents 不会触达，给空实现满足 ConfigService 构造签名
      getDefaultModel: () => null,
      setDefaultModel: () => undefined,
      readModels: () => ({ providers: {} }),
      getProviderConfig: () => undefined,
      upsertProvider: () => ({}),
      removeProvider: () => ({ removed: false }),
      applyTypeTranslation: (t: string) => t,
      getSkillPaths: () => [] as string[],
      setSkillPaths: () => undefined,
      addSkillPath: () => undefined,
      removeSkillPath: () => undefined,
      migrateSettingsSkillsToDiscovery: () => undefined,
      setAgentDirs: () => undefined,
      writeAgentFile: () => undefined,
      deleteAgentFile: () => false,
      getConfigDir: () => '/fake/config',
    }
  }

  it('claude 目录来源的 agent sourceType === "claude"（非 pi）', () => {
    const store = makeFakeStore([
      {
        name: 'code-review',
        path: '/home/u/.claude/agents/code-review.md',
        content: '---\nname: Code Review\n---\nreview code',
        sourceType: 'claude',
      },
    ])
    const svc = new ConfigService('/fake/project', store as unknown as InstanceType<typeof PiConfigStore>)

    const agents = svc.loadAgents('/fake/project')
    expect(agents).toHaveLength(1)
    // 关键断言：sourceType 必须如实透传，不能恒 pi（否则 Claude tab 过滤失效）
    expect(agents[0]!.sourceType).toBe('claude')
    expect(agents[0]!.source).toBe('claude')
  })

  it('agents 目录来源的 agent sourceType === "agents"', () => {
    const store = makeFakeStore([
      {
        name: 'builder',
        path: '/home/u/.agents/agents/builder.md',
        content: '---\nname: Builder\n---\nbuild things',
        sourceType: 'agents',
      },
    ])
    const svc = new ConfigService('/fake/project', store as unknown as InstanceType<typeof PiConfigStore>)

    const agents = svc.loadAgents('/fake/project')
    expect(agents[0]!.sourceType).toBe('agents')
    expect(agents[0]!.source).toBe('agents')
  })

  it('混合来源各自透传（claude / agents / pi 共存）', () => {
    const store = makeFakeStore([
      {
        name: 'reviewer',
        path: '/h/.claude/agents/reviewer.md',
        content: '---\nname: Reviewer\n---',
        sourceType: 'claude',
      },
      {
        name: 'planner',
        path: '/h/.agents/agents/planner.md',
        content: '---\nname: Planner\n---',
        sourceType: 'agents',
      },
      {
        name: 'default',
        path: '/h/.xyz-agent/agent/agents/default.md',
        content: '---\nname: Default\n---',
        sourceType: 'pi',
      },
    ])
    const svc = new ConfigService('/fake/project', store as unknown as InstanceType<typeof PiConfigStore>)

    const agents = svc.loadAgents('/fake/project')
    const byId = new Map(agents.map(a => [a.id, a]))
    expect(byId.get('reviewer')?.sourceType).toBe('claude')
    expect(byId.get('planner')?.sourceType).toBe('agents')
    expect(byId.get('default')?.sourceType).toBe('pi')
  })

  it('sourceType 缺失时兜底为 pi（向后兼容旧 entry 无此字段）', () => {
    // 旧版 agent-crud 不填 sourceType（字段缺失 = undefined，非空串）；
    // config-service 用 ?? 'pi' 兜底，避免 undefined 污染前端。
    // 注意：?? 只兜底 null/undefined，不兜底空串——而 inferSourceType 运行时
    // 至少返回 'custom'，不会产出空串，故这里只测 undefined 这条兜底路径。
    const store = makeFakeStore([
      {
        name: 'legacy',
        path: '/h/somewhere/legacy.md',
        content: '---\nname: Legacy\n---',
        sourceType: '',
      },
    ])
    // 模拟「字段缺失」：删除 sourceType（等价于旧 entry 无此字段）
    delete (store.listAgentFiles()[0] as { sourceType?: string }).sourceType
    const svc = new ConfigService('/fake/project', store as unknown as InstanceType<typeof PiConfigStore>)

    const agents = svc.loadAgents('/fake/project')
    // undefined → 兜底 pi
    expect(agents[0]!.sourceType).toBe('pi')
    expect(agents[0]!.source).toBe('pi')
  })
})

// ── LLM retry 域委托（llm-retry-settings 设计 §3.4：单行委托注入 port）──────────

describe('ConfigService · resolver 显式守卫访问器（R2 S-1 修复契约机器锁定，R3 S-4 补测）', () => {
  it('两参构造 + 调 provider 三方法 → 带恢复指引的 Error（非静默成功 / 非深处 TypeError）', async () => {
    // 与上方 llmRetrySettings 未注入抛错用例同模式：少参构造 = 测试构造错误，报错指向恢复动作
    const svc = new ConfigService(tmpDir, configStore)
    const expected = '[config-service] providerCredentialResolver 未注入'
    expect(() => svc.listProviders()).toThrow(expected)
    expect(() => svc.toggleProviderEnabled('p1', true)).toThrow(expected)
    // removeProviderByKind 是 async 方法：同步段抛错 → 拒绝的 Promise，用 rejects 断言
    await expect(svc.removeProviderByKind('p1', 'custom')).rejects.toThrow(expected)
    // 恢复指引文案可操作：指向注入 resolver / 改用 provider 无关实例（错误 → 权威源 → 重试闭环）
    try {
      svc.listProviders()
      expect.unreachable('listProviders should have thrown')
    } catch (e) {
      expect((e as Error).message).toContain('注入 resolver')
      expect((e as Error).message).toContain('listProviders / toggleProviderEnabled / removeProviderByKind')
    }
  })
})

describe('ConfigService · LLM retry 域（llmRetrySettings port）', () => {
  it('未注入 port：getRetryConfig / setRetryConfig 抛错（可选注入防御，生产恒注入）', () => {
    // beforeEach 构造的 configService 只传 2 个参数（未注入 llmRetrySettings）
    expect(() => configService.getRetryConfig()).toThrow('[config-service] llmRetrySettings not available (getRetryConfig)')
    expect(() => configService.setRetryConfig({ enabled: true, maxRetries: 1, baseDelayMs: 1000 })).toThrow(
      '[config-service] llmRetrySettings not available (setRetryConfig)',
    )
  })

  it('注入 port：读写单行委托（参数与返回值透传，ConfigService 不做 retry 域业务）', () => {
    const snapshot: LlmRetryConfigSnapshot = {
      configured: false,
      config: { enabled: true, maxRetries: 3, baseDelayMs: 2000 },
    }
    const getRetryConfig = vi.fn(() => snapshot)
    const setRetryConfig = vi.fn((): { ok: boolean; error?: string } => ({ ok: true }))
    const svc = new ConfigService(tmpDir, configStore, undefined, undefined, {
      getRetryConfig,
      setRetryConfig,
    } as unknown as ILlmRetrySettings)

    expect(svc.getRetryConfig()).toBe(snapshot)
    expect(getRetryConfig).toHaveBeenCalledTimes(1)

    const arg: LlmRetryConfig = { enabled: true, maxRetries: 1, baseDelayMs: 1000 }
    expect(svc.setRetryConfig(arg)).toEqual({ ok: true })
    expect(setRetryConfig).toHaveBeenCalledWith(arg)
  })
})

// ── M2c：D3 链 5 接线（构造器注入 → listProviders 消费）────────────────────────
// 「装配点真的传了」的落点 = ConfigService 构造器（组合根 index.ts 以第 6 参传入）与
// listProviders 的透传。本组用真实 ConfigService 构造 + 真实 PiConfigStore，证明 resolver
// 经构造器到达 listProvidersImpl 并真实参与凭据判定（而非只测「listProvidersImpl 注入了就生效」）。
describe('M2c: ConfigService 构造器注入 providerCredentialResolver（D3 链 5 接线）', () => {
  /** 假 resolver：仅暴露接口三方法（批量方法返回值可控，用于证明其输出被消费）。 */
  function makeSetResolver(credentialIds: string[]) {
    const listCredentialBackedProviderIds = vi.fn(() => new Set(credentialIds))
    return {
      resolver: {
        hasProviderCredential: vi.fn(() => false),
        listCredentialBackedProviderIds,
        resolveProviderCredential: vi.fn(async () => undefined),
      },
      listCredentialBackedProviderIds,
    }
  }

  it('注入后 listProviders 经 resolver 批量 sync 版判定凭据（调用 + 输出被消费）', () => {
    // 该 provider 在 models.json 无 apiKey：status=connected 只能来自 resolver 的批量结果
    writeModels({ providers: { 'custom-no-key': { name: 'NoKey', models: [{ id: 'm1' }] } } })
    refreshModels()
    const { resolver, listCredentialBackedProviderIds } = makeSetResolver(['custom-no-key'])
    const svc = new ConfigService(tmpDir, configStore, undefined, undefined, undefined, resolver)

    const providers = svc.listProviders()

    expect(listCredentialBackedProviderIds).toHaveBeenCalledTimes(1)
    expect(providers.find(p => p.id === 'custom-no-key')?.status).toBe('connected')
    expect(providers.find(p => p.id === 'custom-no-key')?.apiKeySet).toBe(false)
  })

  it('对照：resolver 空集 → 同一份数据不判 connected（差异证明 resolver 输出被消费；M2fg 恒注入形态）', () => {
    writeModels({ providers: { 'custom-no-key': { name: 'NoKey', models: [{ id: 'm1' }] } } })
    refreshModels()
    const { resolver } = makeSetResolver([])
    const svc = new ConfigService(tmpDir, configStore, undefined, undefined, undefined, resolver)

    const providers = svc.listProviders()

    expect(providers.find(p => p.id === 'custom-no-key')?.status).toBe('not_configured')
  })
})
