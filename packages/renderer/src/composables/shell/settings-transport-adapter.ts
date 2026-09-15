/**
 * SettingsTransport adapter —— core settings 域 → transport 接入面（IF1）的 renderer 壳实现（W4）。
 *
 * core 域内只依赖 SettingsTransport 接口（transport.ts），不感知 WS/transport 实现。
 * 本 adapter 在 bootstrapSettingsCore provideSettingsTransport 时构造，逐方法转发
 * @/api 门面的 config/model/extension 三元导出——经门面即继承 VITE_MOCK 三元切换
 * （mock 模式 settings 域走 mock，与全应用其它域一致；过度设计审计修复 u17，裁决 3）。
 *
 * 签名对齐 core SettingsTransport 接口；mock 兼容硬约束（@/api 的 on* 订阅 / listProviders 等
 * 已就位，model.listModels 由 mock 域提供）。
 */
import type { SettingsTransport, DiscoverModelsRequest, DiscoverModelsResponse } from '@taiji/core/domain/settings'
import type { ExtensionInfo, ProviderId } from '@taiji/shared'
import { config, model, extension } from '@/api'

/**
 * 构造 SettingsTransport 实现：逐方法转发 @/api 门面三元（VITE_MOCK 感知）。
 * 订阅函数（on*）返回取消函数；请求函数签名与 @/api 对齐。
 */
export function createSettingsTransport(): SettingsTransport {
  return {
    // ── 请求 ──
    listProviders: () => config.listProviders(),
    listModels: () => model.listModels(),
    setProvider: (id, data) => config.setProvider(id as ProviderId, data),
    setScopedModels: (models) => config.setScopedModels(models),
    discoverModels: async (req: DiscoverModelsRequest): Promise<DiscoverModelsResponse> => {
      // core DiscoverModelsRequest 与 @/api config.discoverModels 字段已对齐（baseUrl 协议必填），
      // 此处只补协议缺省语义（mode 缺省 discover）后原样透传。
      // 模式感知 guard：discover 模式 baseUrl 缺失时短路返失败，不做 silent cast；
      // test 模式端点回落链（模型级 → provider 级 → catalog 网关）归 runtime，不校验 baseUrl。
      const mode = req.mode ?? 'discover'
      if (mode !== 'test' && !req.baseUrl) {
        return { success: false, error: 'baseUrl is required for model discovery' }
      }
      return config.discoverModels({ ...req, mode })
    },
    setSkillDirs: (dirs) => config.setSkillDirs(dirs),
    setAgentDirs: (dirs) => config.setAgentDirs(dirs),
    setExtensionDirs: (dirs) => config.setExtensionDirs(dirs),

    // ── 订阅（返回取消函数）──
    onProviders: (h) => config.onProviders(h),
    onModels: (h) => model.onModels(h),
    onSkills: (h) => config.onSkills(h),
    onAgents: (h) => config.onAgents(h),
    // mock 域 onExtensions 暂留宽类型 GlobalHandler<unknown>（mock/index.ts W08 登记），
    // real 域强类型 (e: ExtensionInfo[]) => void；包装层在 union 两侧均合法（参数更宽的
    // handler 对 real 亦兼容），cast 依据：mock fixture 与 real 广播同为 ExtensionInfo 形状。
    onExtensions: (h) => extension.onExtensions((data) => h(data as ExtensionInfo[])),
    onSkillDirs: (h) => config.onSkillDirs(h),
    onAgentDirs: (h) => config.onAgentDirs(h),
    onExtensionDirs: (h) => config.onExtensionDirs(h),
    onDefaults: (h) => config.onDefaults(h),
    onSystemPrompt: (h) => config.onSystemPrompt(h),
    onTerminalConfig: (h) => config.onTerminalConfig(h),
  }
}

