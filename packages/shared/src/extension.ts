import mandatoryExtensions from './mandatory-extensions.json'

// ── Extension 领域 DTO（runtime ↔ renderer 之间流转的扩展相关 payload）──
// 迁移自 protocol.ts 第 3 块：ExtensionInfo / UI 交互 / 安装流 / 状态推送。
// protocol.ts 仅保留 type→payload 映射（SSOT），领域形状归此处便于读者一查到底。
// 注：widget/status/notify 的 payload 形状定义在 protocol.ts 的 ServerMessageMapBase（SSOT），
// 此处不再重复定义（此前有三个死 Payload interface 零消费，已删除）。

export const EXTENSION_EVENTS = {
  WIDGET: 'extension:widget',
  WIDGET_GUI: 'extension:widgetGui',
  STATUS: 'extension:status',
  NOTIFY: 'extension:notify',
} as const

// ── Extension UI 交互 / 安装流 payload ────────────────────────────

/**
 * pi 扩展交互式 dialog 方法（产生 extension.ui_request WS 帧，需要前端回复 extension.ui_response）。
 * 与 event-adapter.ts INTERACTIVE_UI_METHODS + ExtensionUIDialog 渲染分支保持同步。
 *
 * notify 不在此列——它是 fire-and-forget（pi 不等回复），走独立 extension.notify WS 帧 + toast 渲染。
 * setStatus/setWidget/set_editor_text/bridge:* 也不在此列——它们走独立分支，不产 ui_request 帧。
 */
export type ExtensionInteractMethod = 'confirm' | 'select' | 'input' | 'editor'

export interface ExtensionInfo {
  name: string
  /** 展示用名称（UI 渲染）。有 package.json 时 = name；无 package.json 的 discovery 入口智能推导
   * （index.ts → 父目录名，单文件 → basename 去后缀）。disabled key / allowlist 匹配仍用 name。 */
  displayName: string
  /** Filesystem directory basename (may differ from npm package name for scoped packages) */
  dirName: string
  version: string
  description: string
  path: string
  enabled: boolean
  source: 'built-in' | 'user-installed' | 'discovery'
  /** Extension 暴露的工具名列表（MCP tools / pi extension tools）。可选：runtime 扫描到时填，
   *  前端 ExtensionPage 据此渲染工具清单。可选而非必填——避免强制 runtime 生产侧同步改造。 */
  tools?: string[]
  /** 是否启用自动升级（仅 user-installed 扩展有效）。前端读写此字段控制 auto-upgrade 开关。 */
  autoUpgrade?: boolean
  /** @deprecated 废弃，被 layer 取代，保留向后兼容（渐进迁移）。
   *  原语义：是否为强制安装扩展（不可卸载/禁用，boot 时自动安装）。从 mandatory-extensions.json SSOT 派生。
   *  新语义下，infrastructure 不可禁不可卸、feature 可禁不可卸，二者均为 mandatory=true。 */
  mandatory?: boolean
  /** builtin 内部子级：infrastructure=不可禁的基础包 / feature=可禁的功能包。
   *  从 mandatory-extensions.json SSOT 派生。tier 字段存在（非 undefined）即表示 builtin。
   *  @deprecated 旧字段名，新代码用 layer+tier 组合（layer 区分 builtin/user，tier 区分 builtin 子级）。 */
  tier?: ExtensionTier
  /** 扩展分层。system 不进 scan 所以不需要出现在 DTO（走独立加载路径）。
   *  - builtin：打包内置，不可卸载（infrastructure 子级不可禁，feature 子级可禁）
   *  - user：用户安装，可禁可卸 */
  layer?: 'builtin' | 'user'
}

// ── Extension install flow payload interfaces ──────────────────

export interface ExtensionDiscoveredPayload {
  tempDir: string
  candidates: ExtensionInfo[]
}

// 注：ExtensionInstallErrorPayload 已删除（D10/P0-B）——install 失败现在走统一 error envelope，
// hint 进 details.hint。见 protocol.ts「错误契约」文档注释。

// ── Recommended extensions（SSOT: recommended-extensions.json）─────────

/**
 * 推荐扩展条目。数据源 recommended-extensions.json（runtime 读取，前端经 WS 拉取）。
 * 不含 version —— 版本动态从 npm registry 拉，JSON 只存稳定的 name + 描述。
 *
 * 注意：原推荐机制已停用——此前此处的推荐条目（连同后续新增包）已转入 mandatory-extensions.json
 * 作为强制安装扩展（boot 时 ensureMandatoryExtensions 自动安装、不可卸载/不可禁用），
 * recommended-extensions.json 现为空数组。具体 mandatory 列表以 mandatory-extensions.json 为 SSOT，
 * 不在此硬编码条目数（避免 SSOT 变动后计数过期）。推荐机制保留给未来「非强制的可选扩展」使用，
 * 当前 ExtensionPage 的推荐区在 recommended 为空时不渲染。
 */
export interface RecommendedExtension {
  name: string
  description: string
}

// ── Mandatory extensions（SSOT: mandatory-extensions.json）─────────

/** mandatory-extensions.json 的条目形状（SSOT 数据的类型约束） */
export interface MandatoryExtension {
  name: string
  description: string
  tier: 'infrastructure' | 'feature'
}

/**
 * mandatory 扩展的两级分类。
 * - infrastructure：纯能力提供者，绝对强加载，不可被任何方式排除（disabled/preset denylist/allowlist 未列入都无效）
 * - feature：提供用户可感知功能，强安装+强启用，但 preset extensionMode 可覆盖
 * tier 字段不存在（undefined）表示非 mandatory 扩展
 */
export type ExtensionTier = 'infrastructure' | 'feature'

/**
 * 判断包名是否为强制安装 extension（从 mandatory-extensions.json SSOT 派生）。
 * mandatory extension：runtime boot 时自动安装+升级，不可卸载/禁用。
 * 向后兼容：infrastructure 和 feature 都返回 true。
 */
export function isMandatoryExtension(name: string): boolean {
  return mandatoryExtensions.some(e => e.name === name)
}

/**
 * 判断包名是否为 infrastructure 基础包（绝对强加载，不可被任何方式排除）。
 * infrastructure 包是纯能力提供者，不提供用户可感知功能，只为其他扩展提供基础能力。
 */
export function isInfrastructureExtension(name: string): boolean {
  return mandatoryExtensions.some(e => e.name === name && e.tier === 'infrastructure')
}

/**
 * 判断包名是否为 feature 功能包（强安装+强启用，但 preset extensionMode 可覆盖）。
 * feature 包提供用户可感知功能。
 */
export function isFeatureMandatoryExtension(name: string): boolean {
  return mandatoryExtensions.some(e => e.name === name && e.tier === 'feature')
}

// ── builtin 语义别名（新分层语义，渐进迁移；底层 SSOT 仍为 mandatory-extensions.json）─────────

/**
 * 判断包名是否为 builtin extension（打包内置，不可卸载）。
 * 涵盖 infrastructure + feature 两级。
 *
 * 新分层语义：原 mandatory 机制（boot 时 npm install + 不可禁）改为 builtin 机制
 * （打包内置 + infrastructure 不可禁 + feature 可禁）。底层 SSOT 不变，此函数为新语义别名。
 */
export function isBuiltinExtension(name: string): boolean {
  return isMandatoryExtension(name)
}

/**
 * 判断包名是否为 builtin infrastructure 包（被依赖的基础包，不可禁不可卸）。
 */
export function isInfrastructureBuiltin(name: string): boolean {
  return isInfrastructureExtension(name)
}
