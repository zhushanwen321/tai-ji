/**
 * Extension Filter Pipeline — 唯一权威过滤实现
 *
 * 纯函数。所有消费者 import 这里的函数，禁止其他地方写 inline disabled/builtin/preset 过滤。
 *
 * 两阶段管道：
 *   1. resolveExtensions：resolver 发现结果 → disabled 过滤 + tier 推导（一次读盘）
 *   2. applyPresetMode：preset extensionMode 二次筛选
 *
 * 关键设计：读盘只发生一次（resolveExtensions 内），结果 ResolvedExtension 携带 name/tier/loadable/presetOverridable，
 * 下游不再重复读盘。
 */
import type { DiscoveredExtension, ExtensionSource } from './ports/installer.js'
import { isMandatoryExtension, isInfrastructureExtension, type ExtensionTier } from '@taiji/shared'
import { readFileSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'

/** disabled source 集合（形如 'npm:@zhushanwen/pi-goal'） */
export type DisabledSet = ReadonlySet<string>

export interface PkgMeta {
  name?: string
  version?: string
  description?: string
  pi?: { tools?: string[] }
}

/** 从扩展目录读 package.json。失败返回空对象。 */
export function readPkgMeta(dir: string): PkgMeta {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as PkgMeta
  } catch {
    return {}
  }
}

/** 过滤管道流转的统一载体：读盘一次推导出的全部判定信息。 */
export interface ResolvedExtension {
  /** 扩展目录绝对路径 */
  path: string
  /** 包名（package.json name，或目录 basename fallback） */
  name: string
  /** 扩展来源（透传自 DiscoveredExtension.source），用于 disabled key 命名空间隔离 */
  source: ExtensionSource
  /** builtin 分级；undefined = 非 builtin。infrastructure=不可禁的基础包，feature=可禁的功能包 */
  tier: ExtensionTier | undefined
  /** 是否应加载（infrastructure 强制 true；feature/user 看 disabled） */
  loadable: boolean
  /** 是否可被 preset 覆盖（false = infrastructure 绝对强加载；true = 其余） */
  presetOverridable: boolean
}

/**
 * 从单个扩展目录推导判定信息。一次读盘。
 *
 * source 决定：
 *   - disabled key 命名空间（discovery 源用 'discovery:' 前缀，其余源用 'npm:' 前缀，
 *     隔离避免跨源串扰——同名 discovery 扩展与 packages[] 安装的扩展互不影响）
 *   - mandatory 判定（对除 discovery 外的所有源生效——mandatory 是 boot 自动安装机制：
 *     packages[] 安装的 mandatory 包走 'settings' 源、打包内置走 'npm' 源，都当 mandatory；
 *     discovery 目录里的扩展即使 name 命中 mandatory SSOT 也不当 mandatory，避免误判）
 *
 * S8 修复：对 package.json 畸形 name（非 string）用 typeof 守卫，fallback 到 basename。
 */
export function resolveExtension(dir: string, source: ExtensionSource, disabled: DisabledSet): ResolvedExtension {
  const meta = readPkgMeta(dir)
  // S8：package.json name 字段类型未知（JSON.parse 可能返回 number/object），用 typeof 守卫
  let name = typeof meta.name === 'string' ? meta.name : basename(dir)
  // P7：discovery 源 path 可能是入口文件（index.ts/index.js/单文件，复刻 pi 的
  // collectAutoExtensionEntries 返回入口路径），其 package.json 在 dirname(dir) 处。
  // 向上定位拿真实包名，使 discovery 目录扩展与 settings npm 版同名时能跨源去重
  //（identity 统一为 package.json.name；否则所有 index.ts 入口都叫 'index.ts'，去重失效）。
  // 单文件扩展（无 package.json）保持 basename fallback（'foo.ts'），不影响现有语义。
  if (source === 'discovery' && typeof meta.name !== 'string') {
    const dirMeta = readPkgMeta(dirname(dir))
    if (typeof dirMeta.name === 'string') {
      name = dirMeta.name
    }
  }
  // #4：builtin（原 mandatory）判定排除 discovery 源（discovery 目录扩展即使 name 命中 builtin SSOT 也不当 builtin）。
  // packages[] 安装的 builtin 包（source='settings'）与打包内置（source='npm'）仍当 builtin。
  const isMandatory = source !== 'discovery' && isMandatoryExtension(name)
  const tier = !isMandatory ? undefined : isInfrastructureExtension(name) ? 'infrastructure' : 'feature'
  // #2：disabled key 按 source 命名空间隔离（discovery 扩展用 'discovery:' 前缀，避免与 npm 扩展串扰）
  const disabledKey = source === 'discovery' ? `discovery:${name}` : `npm:${name}`
  // infrastructure builtin 强加载（被依赖的基础包，不可禁）；feature builtin 和 user 看 disabled
  const isInfraBuiltin = isMandatory && isInfrastructureExtension(name)
  const loadable = isInfraBuiltin ? true : !disabled.has(disabledKey)
  // presetOverridable：只有 builtin 的 infrastructure 包不可覆盖（discovery 源扩展即使 name
  // 命中 infrastructure 也可覆盖——它不当 builtin）
  const presetOverridable = !(isMandatory && isInfrastructureExtension(name))
  return { path: dir, name, source, tier, loadable, presetOverridable }
}

/**
 * 批量推导——resolver 发现结果 → disabled 过滤 + tier 推导，每个 dir 只读一次 package.json。
 * source 透传自 DiscoveredExtension.source。
 */
export function resolveExtensions(
  discovered: readonly DiscoveredExtension[],
  disabled: DisabledSet,
): ResolvedExtension[] {
  return discovered.map(d => resolveExtension(d.path, d.source, disabled))
}

/**
 * 加载层同名去重（P7 冲突防护）。
 *
 * 根因：ExtensionResolver.deduplicate 的去重 key 不一致——discovery 源内部用
 * canonicalizePath（路径 key，兼容无 package.json 的单文件/index.ts 入口），其余源用
 * package.json.name（包名 key）。跨源同包名时 key 永不相等 → 去重失效 → discovery 目录
 *（如 ~/.pi/agent/extensions）里的同名扩展与 settings.json packages[] 的 npm 版同时进入
 * --extension 注入列表 → pi 报 Tool "xxx" conflicts → exit 1 → session 无法激活。
 *
 * 规则（受管源优先）：
 *   1. 同名扩展只保留一份。非 discovery 源（settings/user/third-party/bundled/npm——
 *      taiji UI 可安装/禁用/升级的受管版本）优先于 discovery 源（pi CLI 生态目录的
 *      顺带加载）。受管版被 disabled 时仍占位（discovery 版不顶上），保证 UI 禁用语义生效。
 *   2. 多个 discovery 目录同名 → 保留第一个（数组顺序稳定，按 discoveryDirs 配置顺序）。
 *
 * scanExtensions 全局视图不去重（列表仍显示两条，用户可分别管理），仅加载链路去重。
 */
export function dedupeLoadedExtensions(resolved: readonly ResolvedExtension[]): ResolvedExtension[] {
  const kept = new Map<string, ResolvedExtension>()
  for (const r of resolved) {
    const existing = kept.get(r.name)
    if (!existing) {
      kept.set(r.name, r)
      continue
    }
    const existingIsDiscovery = existing.source === 'discovery'
    const incomingIsDiscovery = r.source === 'discovery'
    if (existingIsDiscovery && !incomingIsDiscovery) {
      // 受管版后来居上：替换 discovery 版。Map.set 已存在 key 不改变插入位置，
      // --extension 顺序稳定（discovery 版原位置即受管版位置）。
      kept.set(r.name, r)
      logDuplicateSkipped(r.name, existing, r)
    } else if (!existingIsDiscovery && incomingIsDiscovery) {
      // 受管版已在：跳过 discovery 版
      logDuplicateSkipped(r.name, r, existing)
    } else {
      // 同为 discovery（多个勾选目录同名）：保留第一个
      logDuplicateSkipped(r.name, r, existing)
    }
  }
  return [...kept.values()]
}

function logDuplicateSkipped(name: string, skipped: ResolvedExtension, kept: ResolvedExtension): void {
  console.warn(
    `[extension-filter] duplicate extension "${name}" skipped (source: ${skipped.source}, path: ${skipped.path}); ` +
    `keeping ${kept.source} version at ${kept.path}. ` +
    `Remove "${name}" from discovery.json extension dirs or uninstall the npm package to resolve the conflict.`,
  )
}

/** preset extensionMode 枚举（与 pi-preset.ts 的 ExtensionMode 对齐） */
export type ExtensionMode = 'all' | 'allowlist' | 'denylist' | 'none'

/**
 * preset mode 二次筛选。
 * 作用于 resolveExtensions 的结果之上。
 *
 * 语义：
 *   - none：只保留不可覆盖的（infrastructure）
 *   - allowlist：infrastructure 强制保留 + 其余 name 须在 allowlist 内
 *   - denylist：infrastructure 强制保留（不在 denylist 生效范围）+ 其余 name 不在 denylist 内
 *   - all：全保留
 *
 * infrastructure 在任何模式下都存活（绝对强加载，本次重构的核心保证）。
 */
export function applyPresetMode(
  resolved: readonly ResolvedExtension[],
  mode: ExtensionMode,
  allowlist: readonly string[],
  denylist: readonly string[],
): ResolvedExtension[] {
  switch (mode) {
    case 'none':
      return resolved.filter(r => !r.presetOverridable)
    case 'allowlist':
      return resolved.filter(r => !r.presetOverridable || allowlist.includes(r.name))
    case 'denylist':
      return resolved.filter(r => !r.presetOverridable || !denylist.includes(r.name))
    case 'all':
      return [...resolved]
    default: {
      // exhaustive check：未来新增 ExtensionMode 值时编译期报错（mode 不再被收窄为 never）。
      // 当 mode 是已穷尽联合时，default 不可达，mode 被收窄为 never；新增值后赋值报错强制补分支。
      const _exhaustive: never = mode
      return _exhaustive
    }
  }
}
