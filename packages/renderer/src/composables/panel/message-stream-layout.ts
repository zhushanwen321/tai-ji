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
 * compaction notice 占位高度（compacting 行降级回归横线分隔行后的新值）。
 * 强绑定 DOM：ActivityStrip compacting 行（四行共用同一结构，[2026-09-16 系统通知渲染升级 U5]）——
 * `system-notice content-col flex min-w-0 items-center gap-2 py-1.5`，内含
 * `h-px flex-1` 渐变横线 ×2（`bg-[image:linear-gradient(...)]`，色标 `var(--border-strong)` 18%/82%）+
 * `size-[13px]` stroke 2.2 spinner + `text-[length:var(--text-sm)] font-[550]` 主文案 +
 * `rounded-[4px] border border-border-strong px-1.5 leading-[1.8]` 待发 chip
 * （`font-mono text-[length:var(--text-3xs)]`，`panel.message.compactingQueueChip`）。
 *   计算值（检查点 1：jsdom 无真实布局，dev 断言实测校准位）= py-1.5(6px×2) + 内容行
 *   max(chip 10×1.8+2border=20px, 主文案 text-sm×1.5≈19.5px, spinner 13px) = 20px ≈ 32px。
 *   chip 缺失时实测 ≈31.5px（主文案行高主导），在断言 ±1px 容差内——常量不随 chip 有无分叉。
 *   [u6a] 行迁入 ActivityStrip（文档流 block，Virtualizer 之后）；[U5] 原通栏活动带形态
 *   （-mx-5 + accent-soft 底 + border-y + py-[14px] ≈ 50px）随 D4 降级作废，降级后回归
 *   DESIGN.md §6.1 通知族二分的横线分隔行族。
 *   此常量供 ActivityStrip 行渲染消费 + dev 断言（useConstantHeightAssert）监测——
 *   改 padding/字号/icon 必须重测并同步此常量（dev 断言会提醒）。
 */
export const COMPACTING_NOTICE_HEIGHT = 32

/**
 * executing bash 瞬时行占位高度（D3 增强规格后与 compacting 行同款新值）。
 * 强绑定 DOM：ActivityStrip bash 行（与 compacting 行共用同一行结构：`system-notice content-col
 * flex min-w-0 items-center gap-2 py-1.5` + 两条 `h-px flex-1` 渐变横线 + `size-[13px]` spinner +
 * `text-[length:var(--text-sm)] font-[550]` 主文案 + `font-mono text-[length:var(--text-xs)]` 命令，
 * 无 chip 分支）→ 计算值 = py-1.5(12px) + 主文案 text-sm×1.5(≈19.5px) ≈ 31.5 → 32px
 * （检查点 1 dev 断言实测校准位，±1px 容差）。
 * [U5] D3 规格升级三项（py-1→py-1.5 / text-xs→text-sm / icon 12→13px）同时改变行高：原值 24
 * 作废，`useConstantHeightAssert` 对 bash 行有断言绑定，与 COMPACTING 同批重测回写。
 * 改 padding/字号/icon 必须重测并同步（dev 断言会提醒）。
 */
export const EXECUTING_BASH_NOTICE_HEIGHT = 32

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
