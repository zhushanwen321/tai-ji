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

/** getEngineConfig RPC 返回形状（engines.json + config.json defaultEngine 的合成视图）。 */
export interface SubagentEngineConfigView {
  /** 可选引擎 id（动态发现；engines.json 缺失/损坏时为 ['pi'] 兜底——pi 恒可用）。 */
  engines: string[]
  /** 当前 defaultEngine（config.json 值；缺省 'pi'）。 */
  defaultEngine: string
}
