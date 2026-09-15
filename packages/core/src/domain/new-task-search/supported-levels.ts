/**
 * supportedLevelsOf —— 'provider/modelId' → 该模型 supportedLevels 的唯一解析实现。
 *
 * 按 'provider/modelId' 复合串查 providers 能力表中 model 条目的 supportedLevels
 *（无条目 / provider 禁用 = undefined，resolve 侧归一默认五档）。消费方：
 * - submit 侧：launchConfig port 的 getSupportedLevels（core flow.ts
 *   buildFallbackLaunchInput + 壳侧 useNewTaskFlow.buildLaunchConfigPort）
 * - 显示侧：composer-shell 的 getSupportedLevels（ModelThinkingDeps 注入）
 *
 * 两侧即同一函数是「显示 ≡ 生效」的结构前提——曾各持一份实现，显示侧漏 enabled
 * 检查 → 禁用 provider 下显示档与生效档发散（launch-config.ts 自设原则：任何一侧
 * 单独兜底都是发散源）。
 *
 * 独立成模块而非挂进 flow.ts（编排器）：composer 系列测试 vi.mock 整个壳侧
 * useNewTaskFlow 模块（flow 编排 mock），显示侧从本模块 import 不被该 mock 波及。
 * renderer 的 composables/features/new-task/supported-levels.ts 是本函数的
 * re-export shim（消费方 import 路径不变）——原 core flow.ts 内逐字镜像与
 * renderer 副本已收编为本文件单源。
 */
import type { ProviderInfo } from '@taiji/shared'

export function supportedLevelsOf(
  modelId: string,
  providers: readonly ProviderInfo[],
): string[] | undefined {
  const slash = modelId.indexOf('/')
  if (slash <= 0) return undefined
  const provider = providers.find((p) => p.id === modelId.slice(0, slash))
  if (!provider || provider.enabled === false) return undefined
  return provider.models.find((m) => m.id === modelId.slice(slash + 1))?.supportedLevels
}
