/**
 * MessageStream 布局常量族（virta 布局 + load-more 预留高度 + dev 断言阈值）。
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
