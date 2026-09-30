// src/index.ts
//
// @zhushanwen/pi-session-path —— pi session 活跃路径裁剪共享库（不是 Pi extension，
// 零依赖纯函数，无 pi SDK peerDep——供任意 @zhushanwen/pi-* 包消费）。
//
// 收敛背景：todo/plan/goal/scheduler 四包曾各持一份同构 filterActivePath（extension
// 不能 import runtime 包，四包间却可互享），靠注释纪律保持同步——回退取值口径已实际
// 分叉（plan/todo 取数组尾条目 vs goal/scheduler 取最后一条带 string id 的条目，无
// id 尾条目上行为可分叉）。语义同构 = 假差异，收敛为单一实现；读者普查登记见
// docs/architecture/session-readers-census.md（§3 各包行 + §4.1 防御语义异源登记）。
// runtime 侧（entry-tree-builder 重建链 / readEntries 投影的 filterEntriesToActivePath）
// 与 plugin 侧不经本包、保持独立——跨面异源是有意设计，非漏接。

/**
 * entry 的树结构字段视图（duck-typed 收窄，无断言）。含 type?: unknown 只为通过
 * weak-type 检查（全 optional 目标须与源共享属性名——各消费包的最小 entry 形状
 * SessionEntryLike/SchedulerEntryLike 只声明 type）；真实 pi SessionEntry 恒有
 * id/parentId（SessionEntryBase），缺失时按线性文件语义处理（见 filterActivePath）。
 */
interface TreeEntryFields { // oe-exempt:20261001:framework:duck-typed 树字段收窄视图（weak-type 检查要求的独立 interface 形态）——共享实现内部结构，非待变体抽象
	type?: unknown;
	id?: unknown;
	parentId?: unknown;
}

/**
 * 活跃路径回溯所需的最小 session 视图。getLeafId 可选：消费包的最小视图（单测
 * fixture / SessionPort 委托）不携带时按文件尾回退；pi ReadonlySessionManager 恒
 * 携带（结构兼容，多余成员不受限）。
 */
export interface ActivePathSessionView<TEntry extends TreeEntryFields> { // oe-exempt:20261001:framework:消费包 session 视图的 ports 契约——goal ActivePathSessionView / pi ReadonlySessionManager / SchedulerBackendCtx.sessionManager 以结构兼容形状传入，类型契约先行、单实现常态
	getEntries(): TEntry[];
	getLeafId?(): string | null;
}

/**
 * 活跃路径裁剪：从 leafId 沿 parentId 回溯得活跃路径 id 集合，按文件序过滤 entries。
 * 撤回（navigateTree 树回退）后被撤子树的 entry 不再进入状态重建输入——被撤内容
 * 不得经压缩摘要 / 面板 / 逐轮注入回到模型上下文。
 *
 * 防御语义（pi buildSessionPath 同构）：leafId 缺失/失效时回退文件尾——取**最后一条
 * 带 string id 的 entry**（正常文件尾即它；回溯需要 id 锚点，无 id 的尾条目当不了
 * 叶子，按线性文件语义保留在输出中）。此为四包收编时统一的回退取值口径：真实 pi
 * SessionEntry 恒有 id，两口径仅在无 id 的 duck-typed fixture 上可分叉，生产行为
 * 逐字节不变。
 *
 * 边界形态：
 * - 无任何树信息（legacy 线性 fixture，全文件无 string id）→ 不过滤，保持裁剪前行为；
 * - 无 id 的 entry → 保留（线性文件语义，不因缺字段丢行）；
 * - 环状 parentId → activeIds 已含即终止，不挂死。
 */
export function filterActivePath<TEntry extends TreeEntryFields>(
	view: ActivePathSessionView<TEntry>,
): TEntry[] {
	const entries = view.getEntries();
	if (entries.length === 0) return entries;

	const byId = new Map<string, { id: string; parentId: string | null }>();
	for (const entry of entries) {
		const tree: TreeEntryFields = entry;
		if (typeof tree.id === "string") {
			byId.set(tree.id, {
				id: tree.id,
				parentId: typeof tree.parentId === "string" ? tree.parentId : null,
			});
		}
	}
	// 无任何树信息（legacy 线性 fixture）→ 不过滤，保持裁剪前行为
	if (byId.size === 0) return entries;

	const leafId = view.getLeafId?.();
	let current =
		(leafId ? byId.get(leafId) : undefined) ?? lastOfMapValues(byId);
	const activeIds = new Set<string>();
	while (current && !activeIds.has(current.id)) {
		activeIds.add(current.id);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	return entries.filter((entry) => {
		const tree: TreeEntryFields = entry;
		return typeof tree.id !== "string" || activeIds.has(tree.id);
	});
}

function lastOfMapValues(
	map: Map<string, { id: string; parentId: string | null }>,
): { id: string; parentId: string | null } | undefined {
	let last: { id: string; parentId: string | null } | undefined;
	for (const value of map.values()) last = value;
	return last;
}
