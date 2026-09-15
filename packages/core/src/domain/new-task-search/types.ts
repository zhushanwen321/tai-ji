/**
 * new-task-search 域共享类型（core 版）—— 搜索模块共享的 DTO/值对象。
 *
 * 来源：packages/renderer/src/lib/search-types.ts（strangler 逐域绞杀 §11.2 下沉）。
 * renderer 旧文件保留，待消费方迁移完成后删除。
 *
 * 领域类型 SSOT 归位：SearchType / SearchItem 定义在此（D-028 架构修复）。
 * 历史遗留：v1 搜索全在 mock 目录，类型埋在 api/mock/search-data.ts，生产代码反向依赖 mock；
 * v2 编排重写时迁出，mock 反向 import 此处（方向：mock → 领域类型）。
 *
 * 与 renderer 旧文件的差异（core 包约束）：
 *  - SideDrawerTab 本域自声明（不 import renderer useSideDrawer，core 禁止反向依赖 renderer）。
 *    注：renderer 侧真实类型是 6 值联合（'terminal'|'browser'|'git'|'doc'|'detail'|'tasks'），
 *    本域只需 drawerTab 用到的子集；消费方迁移时做显式适配（drawerTab 实际仅 'detail' 被使用）。
 *  - SessionCommand 自 ./command-store 导入（同域依赖）。
 *  - 其余 import 走 @taiji/shared（包级）。
 *
 * 复用的外部类型（import 复用，不重定义）：
 *  - FileNode：@taiji/shared
 *  - SessionSummary / SessionGroup：@taiji/shared
 *  - SessionCommand：./command-store
 */

/** SideDrawer tab（本域子集，core 不依赖 renderer 的 6 值联合）。 */
export type SideDrawerTab = 'tasks' | 'sideDrawer' | 'detail'

/** 搜索项类型（四类：命令/文件/符号/会话） */
export type SearchType = 'command' | 'file' | 'symbol' | 'session'

/** 搜索结果项（编排层 allSettled 聚合后的统一 DTO，mock + real 源都映射到此） */
export interface SearchItem {
  type: SearchType
  title: string
  sub: string
  /** slash 命令 icon key（star/terminal/wrench，与 CommandPopover SLASH_ICON_COMPONENTS 同源）。
   *  仅 slash 命令项携带（从 SessionCommand.icon 透传），应用命令/文件/符号/会话项无此字段。
   *  供 chip 注入时透传给 insertSlashChip(name, icon)，保证搜索注入的 chip 与 CommandPopover 选中的 chip 图标一致。 */
  icon?: string
  /** 命令细分类型（仅 type='command' 项携带）。
   *  'app' = 应用内置命令（走 commandStore.appCommands action 执行）；
   *  'slash' = pi 扩展命令（走 pendingSlash 注入 composer chip）。
   *  存在动机：pi get_commands 返回的命令名不带 / 前缀（如 'goal'/'skill:code-review'），
   *  无法靠 title.startsWith('/') 区分两类，故在 DTO 映射时显式标记，useSearchJump 据此精确分发。 */
  commandKind?: 'app' | 'slash'
  /**
   * skill 命令项标记（仅 type='command' 且 commandKind='slash' 时可能为 true）。
   * 判据与 CommandPopover 的 buildPanelSlashCandidates 同源：SessionCommand.kind === 'skill'
   * （applyCommands 把 pi 的 source 归一化进 kind）。用途：搜索选中项经 pendingSlash 通道
   * 注入 composer 时，消费侧（useCommandPopoverTrigger）按本字段分流——true 走 skill 通路
   * （裸名 + location + 多 chip 共存，与 D3 的 onCmdSelect skill 项分流同款落点），
   * false/缺省维持 insertSlashChip 命令通路（单命令替换语义）。
   */
  isSkill?: boolean
  /**
   * skill 命令的 SKILL.md 绝对路径（仅 isSkill 为真时携带，取自 SessionCommand.sourceInfo.path）。
   * 与 CommandPopover 的 slash 候选 location 同源，供 chip dataset 携带 + runtime 反解析。
   */
  location?: string
}

/** 应用内置命令（#2，含 action 行为故非纯值对象） */
export interface AppCommand {
  id: string
  name: string
  shortcut?: string
  action: () => void
}

/**
 * recents 持久化项（#3 值对象）。
 * key 规则（AC-3.5）：type 冒号 title（title 稳定标识，sub 路径/branch 可变不入 key）。
 */
export interface RecentEntry {
  type: SearchType
  key: string
  timestamp: number // 计数器兜底 Math.max(stored)+1（AC-3.6），非裸 Date.now()
  title: string
  sub: string
}

/**
 * Section 类型分类（W1 i18n-frontend-p2）：
 * - recent：空查询态的最近项分组（跨类型，AH-S3 恒显）
 * - suggested：空查询态的建议命令分组
 * - command / file / symbol / session：非空查询态按命中类型分组（symbol 始终占位 D-001）
 * - shortcut：预留（当前未使用，列入便于 SearchModal kind-based 判定穷举）
 *
 * 字段语义：kind 是非本地化稳定标识（机器读），label 是本地化展示文案（人读），
 * 两者解耦后可避免 en-US 下 's.label === \'最近\'' 之类的硬编码字面量比较（AH-S3 回归点）。
 */
export type SectionKind = 'recent' | 'suggested' | 'command' | 'file' | 'symbol' | 'session' | 'shortcut'

/** 分组（domain/composable 输出整形，GAP-E1） */
export interface Section {
  /**
   * 分组类型（非本地化稳定标识；与 label 解耦，UI 判定用 kind 而非 label，
   * 防止 locale 切换导致 AH-S3 recents 恒显回归）。
   */
  kind: SectionKind
  label: string
  items: SearchItem[]
}

/** useSearch.query 的上下文（调用方注入） */
export interface SearchCtx {
  activeSessionId: string | null // null 时 file 源 + slash 源返空（AC-4.8）
}

/** useSearchJump.confirm 的上下文 */
export interface JumpCtx {
  activeSessionId: string | null // file 跳转需 cwd（AC-6.9 直调 fileApi.read）
}

/**
 * useSearchJump.confirm 的返回（AC-6.7 异常恢复：失败时浮层保持打开）。
 *
 * drawerTab：成功跳转后需打开的 SideDrawer tab（可选）。当前仅 file 跳转返 'detail'（文件
 * 预览需 DetailPane 挂载，由调用方 SearchModal 接线 useSideDrawer.open）。命令/会话跳转无
 * 此需求（命令触发自身 action，会话切换载入 panel），故缺省。编排层 useSearchJump 不依赖
 * useSideDrawer（架构约束：composable 层只返 JumpResult，不直接调 UI 状态）。
 */
export type JumpResult =
  | { ok: true; drawerTab?: SideDrawerTab }
  | { ok: false; error: string }

/** localStorage key（MR-3.2 骨架约束，对齐 taiji: 冒号约定） */
export const RECENTS_STORAGE_KEY = 'taiji:search-recents'

/** WS 源超时阈值（#17，对齐 runtime 量级） */
export const WS_SOURCE_TIMEOUT_MS = 10_000

/** recents 每类上限（D-007） */
export const RECENTS_PER_TYPE = 5
