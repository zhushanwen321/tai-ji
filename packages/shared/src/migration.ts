/**
 * 迁移功能（从其他 agent 迁移配置）共享类型。
 *
 * W1（cw-2026-07-26-migration-other-agents）：定义 config.detectSources 检测结果的 DTO。
 * 后续 wave（W2/W3）会在 SourceDetectResult 上扩展 provider 维度的字段。
 *
 * 设计约束（安全）：
 * - 检测阶段只统计文件数量，不读取文件内容（不提取任何 API key、不解析配置正文）。
 * - skillCount 递归统计 SKILL.md；agentCount 仅统计顶层 *.md（agent 文件位于根目录）。
 */

/** 可作为 skill 迁移源的 agent（4 源）。 */
export type ProviderSource = 'pi' | 'zcode' | 'codex' | 'claude'

/** 可作为 agent 迁移源的 agent（W1 仅支持 Claude Code）。 */
export type AgentSource = 'claude'

/**
 * 单个迁移源的检测结果。
 *
 * - skill 候选可含全部 4 源（pi/zcode/codex/claude）。
 * - agent 候选仅 'claude'（其余源无标准 agent 目录）。
 */
export interface SourceDetectResult {
  /** 源类型。skill 候选可含全部 4 源；agent 候选仅 'claude'。 */
  source: ProviderSource | AgentSource
  /** 源配置目录是否存在（源 agent 是否安装）。目录不存在时为 false。 */
  installed: boolean
  /** 检测的目录绝对路径（skill 目录）。 */
  dir: string
  /** skill 数量（递归 SKILL.md 文件计数）。installed=false 时省略。 */
  skillCount?: number
  /** agent 数量（顶层 *.md 文件计数，仅 claude 有）。installed=false 时省略。 */
  agentCount?: number
  /** provider 数量（W1 不实现，留 undefined）。W2/W3 填充。 */
  providerCount?: number
}

// ══ W2（cw-2026-07-26-migration-other-agents）—— Provider 导入预览/结果 DTO ══
//
// 安全红线（与 W1 一致）：这些 DTO 全部脱敏，**绝不**包含 apiKey 明文。
// 解析阶段提取的 apiKey 明文只活在 runtime 进程内存（preview-cache），不出 runtime；
// 前端只能看到 apiKeyExtracted 布尔（提示用户「key 已提取」），拿不到 key 值。
//
// 数据流（DM1 安全红线）：
//   Step1 previewImportProviders(source)
//     runtime 读源配置(Mock) → ParsedProvider[](含 apiKey 明文)
//     → 存 PreviewCache(importId + 5min TTL)
//     → 返回脱敏 ProviderImportPreview(只 apiKeyExtracted:boolean，无 key 值)
//   Step2 applyImportProviders(importId, selectedIds)
//     → 从缓存取完整配置 → 剥离 _ 前缀元数据 → 逐个 upsertProvider
//     → apply 后立即删缓存 → 返回 ProviderImportResult

/**
 * Provider 导入预览的单个条目（脱敏，不含 apiKey 值）。
 *
 * - id/name：源里的 provider 标识（导入后作为 taiji models.json 的 provider id）。
 * - protocol：pi api 终值（anthropic-messages / openai-completions / ...），前端展示用。
 * - modelCount：解析出的 model 数量。
 * - apiKeyExtracted：**computed 布尔**，credentialType ∈ plaintext/env/command 时 true（已拿到可用凭据，
 *   落盘 models.json 后开箱可用或运行时读环境变量），missing/oauth/env-bundle 时 false（需手填、Phase 2
 *   支持，或有凭据但 Phase 1 不支持落盘）。
 *   保留布尔字段兼容现有消费方「是否需提示用户补 key」的判断；credentialType 是更细粒度的真相源。
 * - credentialType：凭据形态六态（import-credential-types wave 4 新增，解析器按 auth.json 条目识别）：
 *     - plaintext：明文 API key 已提取（apiKey 字段有值，开箱可用）。
 *     - env：key 是 $VAR / ${VAR} 占位，apiKey 保留原占位串，envVarName 记录变量名（导入后需确保该环境变量已设）。
 *     - env-bundle：api_key 凭据带 env 包（key 内嵌在 env 包里，不依赖 process.env），有凭据但 Phase 1 不支持
 *       落盘（models.json apiKey 是纯字符串无 env 字段），apiKey 不写，warnings 含 Phase 2 提示（wave 4 修复）。
 *     - command：key 是 !command 前缀（pi 运行时执行 shell 命令取值），apiKey 保留原串，warnings 含命令注入提示。
 *     - oauth：type==='oauth'，Phase 1 不支持，apiKey 不取 token，warnings 含 Phase 2 提示。
 *     - missing：无任何 key 线索，apiKey 不写（undefined），warnings 含原因。
 * - envVarName：credentialType==='env' 时的环境变量名（已去 $ / ${} 前缀），其他态为 undefined。
 * - conflict：与现有 models.json provider id 的冲突。'duplicate-id' = 已存在同名 provider。
 * - warnings：解析期警告（如「env_key 未设置」「!command 命令注入」「OAuth Phase 2」），前端逐条展示。
 */
export interface ProviderPreviewItem {
  id: string
  name: string
  /** pi api 终值（anthropic-messages / openai-completions / ...）。 */
  protocol: string
  modelCount: number
  /** computed 布尔：credentialType ∈ plaintext/env/command 时 true，missing/oauth/env-bundle 时 false。 */
  apiKeyExtracted: boolean
  /** 凭据形态六态（import-credential-types wave 4 新增，真相源）。 */
  credentialType: 'plaintext' | 'env' | 'env-bundle' | 'missing' | 'oauth' | 'command'
  /** credentialType==='env' 时的环境变量名（已去前缀），其他态为 undefined。 */
  envVarName?: string
  conflict: 'none' | 'duplicate-id'
  warnings: string[]
}

/**
 * preview 组 2 的单个孤儿凭据条目（脱敏，sa3 F1 · 内置 Provider 模板衔接）。
 *
 * 孤儿凭据 = auth.json 里存在、但 models.json 未定义的 providerId（内置 provider 如
 * openai/anthropic/deepseek 的凭据——pi 的 provider 定义来自内置 catalog，models.json
 * 天然没有它们）。pi-parser 扫描 auth.json 时收集，provider-importer 匹配内置模板后
 * 进入 preview 组 2。
 *
 * 安全红线（B.5，与组 1 一致）：**不含 apiKey 值**，只含 credentialType/envVarName/占位信息。
 * apiKey 明文只活在 runtime 内存（preview-cache），apply 时据 providerId 取模板补全定义。
 */
export interface ProviderPreviewOrphanItem {
  /** auth.json 的 providerId（如 'openai'），apply 时作为 taiji models.json 的 provider id。 */
  providerId: string
  /** 内置模板 name（匹配到时）。未匹配的孤儿凭据不进组 2（进 preview.warnings，跳过）。 */
  name?: string
  /** 凭据形态六态（与 ProviderPreviewItem.credentialType 同枚举，真相源）。 */
  credentialType: 'plaintext' | 'env' | 'env-bundle' | 'missing' | 'oauth' | 'command'
  /** credentialType==='env' 时的环境变量名（已去前缀），其他态为 undefined。 */
  envVarName?: string
  /** 是否匹配到内置模板。组 2 恒 true（未匹配项进 preview.warnings），字段保留供前端展示分支。 */
  builtinTemplateMatched: boolean
  /** 内置模板的 modelCount（展开区展示「补全 N 个模型」）。 */
  modelCount: number
  /** 内置模板的 model id 列表（展开区展示，非敏感）。 */
  modelNames?: string[]
  /** computed 布尔：credentialType ∈ plaintext/env/command 时 true，missing/oauth/env-bundle 时 false。 */
  apiKeyExtracted: boolean
  /** 解析期警告（如「OAuth Phase 2」「!command 命令注入」），preview 逐条展示。 */
  warnings: string[]
}

/**
 * Step1 preview 的返回（脱敏）。
 *
 * 前端据此渲染导入预览列表（含冲突标记 + 警告），用户勾选后发 Step2 applyImportProviders。
 * importId 在外层（reply envelope / WS payload）传递，不在此结构内。
 */
export interface ProviderImportPreview {
  source: ProviderSource
  providers: ProviderPreviewItem[]
  /**
   * 组 2：auth.json 中的额外凭据（孤儿凭据，匹配到内置模板的）。
   * auth.json 不含模型信息，导入时用内置模板补全定义（只写 name/api/baseUrl/apiKey，不写 models）。
   * 匹配不到内置模板的孤儿凭据不进此数组（进 warnings 提示跳过）。
   */
  orphanCredentials?: ProviderPreviewOrphanItem[]
  /**
   * 源配置解析期致命错误（如文件格式损坏）。即使 providers 部分解析成功，此字段也可能存在。
   * 前端据此显示警告横幅（不阻断已解析 providers 的导入）。
   */
  parseError?: string
  /**
   * 顶层警告（如「N 个 provider 因协议不支持被丢弃」+「N 个孤儿凭据无法匹配内置模板跳过」），
   * 与 per-provider warnings 区分。前端在预览顶部展示。
   */
  warnings?: string[]
}

/**
 * 单个 provider 的导入结果条目。
 *
 * - status 'imported'：成功 upsert 到 models.json。
 * - status 'skipped'：因冲突（duplicate-id）跳过，未写入。
 * - status 'failed'：upsertProvider 抛异常，reason 含错误信息。
 * - quotaAutoEnabled：本次导入已自动开启 coding-plan 额度显示（导入即默认同意，
 *   写 extras 成功才置位；前端据此 toast 提示）。缺省 = 未开启（不命中条件或写失败）。
 */
export interface ProviderImportedItem {
  id: string
  name: string
  status: 'imported' | 'skipped' | 'failed'
  reason?: string
  quotaAutoEnabled?: boolean
  /**
   * 该 provider 导入过程中产生的**用户可见告警**（U6②：写侧丢弃的非法模型项等）。
   *
   * 与 preview 侧 per-provider `warnings` 同族语义：`status: 'imported'` 但有告警时，
   * UI 应展示「已导入，但 N 个模型项因 id 非法被跳过」——静默丢弃违反 P0「故障要响亮」。
   * 可选字段，向后兼容（旧消费方无此字段行为不变）。
   */
  warnings?: string[]
}

/**
 * Step2 apply 的返回。
 *
 * - imported：每个选中 provider 的结果条目（含 imported/skipped/failed 三态）。
 * - failedCount：status='failed' 的条目数（便于前端 toast 统计）。
 */
export interface ProviderImportResult {
  source: ProviderSource
  imported: ProviderImportedItem[]
  failedCount: number
}
