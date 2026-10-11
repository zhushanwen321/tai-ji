/**
 * 子代理引擎契约（U7 引擎可发现性 + GUI 引擎选择）。
 *
 * 契约两端：
 *   - 写侧：@zhushanwen/pi-subagent-workflow extension（pi 进程内，engine registry 权威）
 *     在 session_start 时把注册引擎列表同步到 <agentDir>/subagents/engines.json；
 *   - 读侧：taiji runtime（subagent.getEngineConfig / subagent.setDefaultEngine RPC）
 *     → renderer Settings「子代理」页引擎下拉（动态选项，不硬编码）。
 *
 * defaultEngine 的权威存储仍是 <agentDir>/subagents/config.json（extension 的
 * ModelConfigService 读同文件——GUI 写入经 runtime 读改写，单一文件双端共识）。
 */

/** 引擎列表状态文件名（相对 <agentDir>/subagents/，与 config.json 同目录）。 */
export const SUBAGENTS_ENGINES_FILENAME = 'engines.json' as const

/** 引擎列表状态文件形状（写侧 extension 权威；读侧运行时 guard，坏形状降级空列表）。 */
export interface SubagentEnginesFile {
  v: 1
  /** 已注册引擎 id 清单（注册序稳定；展示名即 id——'pi'/'zcode' 本身是品牌名）。 */
  engines: string[]
  /** 写入时间（ms epoch；诊断用，读侧不依赖）。 */
  updatedAt: number
}

/**
 * 引擎可选模型清单条目（engine-provider-unification D5；值形状镜像 =
 * zcode-subagent-cli preparer listZcodeModels 返回形态，与 @taiji/shared protocol
 * SubagentEngineModelInfo 字段一致——shared 侧是 wire 形状，本类型是契约面同名物）。
 */
export interface SubagentEngineModelInfo {
  /** 模型全 ref（zcode 形态 providerId/modelId）。 */
  id: string
  /** 展示名（如 `ProviderName · model`）；派生源 provider 无名时缺省。 */
  name?: string
}

/** getEngineConfig RPC 返回形状（engines.json + config.json defaultEngine 的合成视图）。 */
export interface SubagentEngineConfigView {
  /** 可选引擎 id（动态发现；engines.json 缺失/损坏时为 ['pi'] 兜底——pi 恒可用）。 */
  engines: string[]
  /** 当前 defaultEngine（config.json 值；缺省 'pi'）。 */
  defaultEngine: string
  /**
   * per-engine 可选模型清单（engine-provider-unification D5；目前仅 zcode 引擎有
   * 派生源——真实 provider_config.json ∪ taiji 同步副本，双源回落内建）。optional：
   * 旧 runtime / mock 不带时消费方按空表处理。
   */
  engineModels?: Record<string, SubagentEngineModelInfo[]>
  /**
   * per-engine 默认模型偏好（config.json engineDefaults 键，值 = 模型全 ref）。
   * optional：旧 runtime / mock 不带时消费方按「无偏好」处理。
   */
  engineDefaults?: Record<string, string>
}
