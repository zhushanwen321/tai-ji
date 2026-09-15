/**
 * Provider catalog 判据工具 + 「快照 ⊕ overlay」合并视图单真相（D4）。
 *
 * 基于 builtin-providers.json 副本（编译期 import）判断 providerId
 * 是否属于 pi 内置 catalog。副本只作判据 + UI 展示，非运行时定义权威。
 *
 * D4（设计 pi-evolution-consistency-and-project-switcher）：「有效模型」此前有两个
 * 独立定义——展示视图 listProviders 内联合并（快照 ⊕ overlay），校验视图
 * pi-provider-store 只查快照索引，两处必然漂移（失败模式 A 的根因）。现合并逻辑
 * 收拢到本模块 getMergedCatalogModels 单点，展示与校验都从它取合并视图。
 */
import builtinData from '../generated/builtin-providers.json'
import type { BuiltinProviderTemplate } from '@taiji/shared'
import {
  getCatalogOverlayState,
  type OverlayModel,
  type CatalogOverlayState,
} from './provider-catalog-refresh.js'

/**
 * 快照/合并视图的模型元素类型（= BuiltinModelSummary，shared 未从 index 导出该名，
 * 沿用 provider-config-helper 的 `BuiltinProviderTemplate['models'][number]` 惯用法取同形）。
 */
type CatalogModel = BuiltinProviderTemplate['models'][number]

/**
 * 判断 providerId 是否为 pi 内置 catalog provider。
 * fail-safe：builtinData 格式异常时返回 false + console.warn，不抛错。
 */
export function isCatalogProvider(providerId: string): boolean {
  const providers = builtinData?.providers
  if (!Array.isArray(providers)) {
    console.warn('[provider-catalog] builtin-providers.json malformed (providers is not an array)')
    return false
  }
  return providers.some((p: { id: string }) => p.id === providerId)
}

/**
 * 按 enabledModels 白名单派生 provider 启用状态（DM3 / wave2）。
 *
 * pi 语义：enabledModels 为空/undefined → 全可用（不限制）；非空 → 白名单匹配。
 * 匹配规则：pattern 等于 `<id>/*`（provider 通配）或以 `<id>/` 开头（model 级 pattern
 * 视为该 provider 已启用）。`startsWith('<id>/')` 带斜杠，避免 `openai` vs
 * `openai-compatible` 的前缀碰撞（openai/ 匹配 openai 但不匹配 openai-compatible/）。
 *
 * wave2 listProviders（config-service）+ findValidDefaultModel（pi-provider-store）、
 * wave3 toggleProviderEnabled、wave5 迁移共用此判据，故放本共享模块（CL2）。
 */
export function deriveEnabled(providerId: string, enabledModels: string[] | undefined): boolean {
  if (enabledModels == null || enabledModels.length === 0) return true
  return enabledModels.some(p => p === `${providerId}/*` || p.startsWith(`${providerId}/`))
}

// ── 「快照 ⊕ overlay」合并视图单真相（D4）────────────────────────

/** 快照模型索引（providerId → 快照 models）。JSON import 即内存常驻，构建零 IO。 */
const snapshotModelsById = new Map<string, CatalogModel[]>(
  ((builtinData.providers ?? []) as Array<{ id: string; models: CatalogModel[] }>).map(
    p => [p.id, p.models] as [string, CatalogModel[]],
  ),
)

/**
 * 远程目录 overlay 条目 → 快照模型同形（合并进快照集合前的归一）。
 * pi.dev 条目字段与内置 catalog 同构，缺省字段按展示/校验层安全默认填充。
 * （原 provider-config-helper 内联 overlayToBuiltinShape 搬迁——合并单点拥有归一职责，
 * 消费方不再各自拼接。）
 *
 * D7：`api`/`baseUrl` **不再用空串捏造缺省**——pi 的 OverlayModel 这两字段本就是 optional，
 * 空串是归一化捏造（会被合并视图/派生的消费方当成真实值，也可能经某条写路径进 models.json）。
 * 缺省 = 不置键，消费方按 pi 语义回落（BuiltinModelSummary.api/baseUrl 已 optional）。
 */
function overlayToCatalogModel(m: OverlayModel): CatalogModel {
  return {
    id: m.id,
    name: m.name ?? m.id,
    ...(m.api !== undefined ? { api: m.api } : {}),
    ...(m.baseUrl !== undefined ? { baseUrl: m.baseUrl } : {}),
    reasoning: m.reasoning ?? false,
    input: m.input ?? ['text'],
    cost: (m.cost ?? null) as CatalogModel['cost'],
    compat: (m.compat ?? null) as CatalogModel['compat'],
    contextWindow: m.contextWindow ?? 0,
    maxTokens: m.maxTokens ?? null,
    thinkingLevelMap: (m.thinkingLevelMap ?? null) as CatalogModel['thinkingLevelMap'],
  }
}

/** 合并视图 = 模型集 + 该 provider 的 overlay 三态（校验层据三态裁决 auto-fix / pass-through）。 */
export type MergedCatalogView = {
  /** 快照打底、仅 fresh 态 overlay 并入（同 id 覆盖 / 新 id 追加，对齐 pi mergeModels）的有效模型集 */
  models: CatalogModel[]
  /** overlay 三态（D5）：expired → models 已退化为纯快照；never-seen → 校验层须 pass-through */
  overlayState: CatalogOverlayState
}

/**
 * 取 provider X 的「快照 ⊕ overlay」合并视图（D4 单点，listProviders 与
 * pi-provider-store 的默认模型有效性判定都从它取，不再各自拼接）。
 *
 * 返回 undefined = provider 不在快照内（非 catalog provider；D6 维持快照闸门，
 * 快照外 provider 不构成合并视图）。纯同步只读，overlay 读侧自带 mtime 缓存 +
 * fail-safe（文件缺失/损坏按 never-seen 处理），session create 热路径安全。
 */
export function getMergedCatalogModels(providerId: string): MergedCatalogView | undefined {
  const snapshot = snapshotModelsById.get(providerId)
  if (!snapshot) return undefined
  const overlayState = getCatalogOverlayState(providerId)
  const merged = new Map<string, CatalogModel>(snapshot.map(m => [m.id, m]))
  // 仅 fresh 态并入 overlay；expired（staleness 过滤 / 404/501 lastModified:0）与
  // never-seen 时 models == 纯快照——态 2 的「按快照裁定」由此构造性成立
  if (overlayState.state === 'fresh') {
    for (const m of overlayState.models) {
      merged.set(m.id, overlayToCatalogModel(m))
    }
  }
  return { models: [...merged.values()], overlayState }
}
