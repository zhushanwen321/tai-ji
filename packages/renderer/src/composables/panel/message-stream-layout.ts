/**
 * MessageStream 布局常量族（virta 布局 + ActivityStrip 行高 + dev 断言阈值）。
 *
 * [D6 死路径清理 2026-09-09] 原本与常量同住的 useMessageStreamNotices composable
 * （isCompacting / isDispatching / hasWorkingTurn / forkNoticeBaseTop 状态聚合）已随
 * fork notice absolute 定位死路径一并删除：forkNoticeTop 不被模板消费（ForkNotice 为
 * 文档流 block，定位由文档序保证），isCompacting/isDispatching 消费方仅剩该死路径。
 * chat store 的 isCompacting 活跃消费方（ActivityStrip / deriveStatus / composer）不受影响。
 *
 * 从 MessageStream.vue 拆出（vue_rules_checker.py 的 script setup ≤300 行规范拆分惯例，
 * [cw wave w3]）。[u07 2026-09-11] 原 useMessageStreamNotices.ts 改名为本文件：use* 命名
 * 是同名 composable 的遗留（该 composable 已随 D6 死路径清理删除，见上），现仅剩常量导出，
 * 按实际内容（布局常量族）命名。
 */

/**
 * compaction notice 占位高度（[compact-defer-composer-queue §2.2] 升级为通栏活动带）。
 * 强绑定 DOM：ActivityStrip compacting 行（`-mx-5 flex items-center justify-center gap-2
 * border-y border-hairline bg-[var(--accent-soft)] px-5 py-[14px]`，含 `size-3.5` spinner +
 * `text-[length:var(--text-sm)]` 主文案 + 可选「·」+ `text-[length:var(--text-xs)]` 副文案）。
 *   实际高度（getBoundingClientRect 含 border）= py-[14px](14px×2) + 内容行
 *   max(spinner, text-sm×1.5≈19.5px)≈20px + border-y(1px×2) ≈ 50px。
 *   [u6a] 行迁入 ActivityStrip（文档流 block，Virtualizer 之后）；§2.2 将 hairline 由两条
 *   `h-px` span 改为 border-y、system-notice/content-col 摘除（通栏带），高度语义同步变更。
 *   此常量供 ActivityStrip 行渲染消费 + dev 断言（useConstantHeightAssert）监测——
 *   border-y 计入与否以真机 dev 断言实测校准为准（理论值 50，±2px 内属亚像素/字号抖动）。
 *   改 padding/字号/icon 必须重测并同步此常量（dev 断言会提醒）。
 */
export const COMPACTING_NOTICE_HEIGHT = 50

/**
 * executing bash 瞬时行占位高度（W4 完整形态）。
 * 强绑定 DOM：ActivityStrip bash 行（与 compacting 行同结构：`system-notice flex items-center
 * gap-2 py-1`，`size-3` spinner + `text-[length:var(--text-xs)] leading-snug` 文本 + 两条
 * `h-px` 分隔线）→ 实际高度同 COMPACTING_NOTICE_HEIGHT ≈ 24px。
 * [u6a] 行 DOM 已迁入 ActivityStrip（文档流 block）——此常量供 dev 断言
 * （useConstantHeightAssert）监测高度漂移。改 padding/字号/icon 必须重测并同步（dev 断言会提醒）。
 */
export const EXECUTING_BASH_NOTICE_HEIGHT = 24

/**
 * 像素常量（design §4.1 附录 A）：itemSize 是 virta 的初始估算 hint（非强制，virta 自动从
 * 实测项重估）。与原手写虚拟滚动的 ESTIMATED_TURN_HEIGHT 一致，平滑迁移期减少首屏估算误差。
 * （[cw wave w3] 自 MessageStream.vue 随 ≤300 行拆分迁入——virta 布局常量族同源聚拢。）
 */
export const ESTIMATED_TURN_HEIGHT = 200

/**
 * load-more 按钮预留高度（B2 强绑 DOM：Button h-8 + py-2 ≈ 48px，取 44 为历史值，避免定位回归）。
 * [cw wave w3] 通过 <Virtualizer :startMargin> 喂入 virta（design §4.11）：virta getItemOffset 已含 startMargin。
 */
export const LOAD_MORE_RESERVED_HEIGHT = 44
