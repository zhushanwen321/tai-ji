/**
 * 行级 diff 摘要生成器（parentVersionDiffSummary 字段）。
 *
 * 设计定位：entry 内的摘要是对用户友好的「一眼看出改了什么」；Trace 视图 inspector 在渲染时
 * 会用相邻两条留痕 entry 的 fullText 重算完整 diff，这里只需轻量摘要，不追求 patch 级精确。
 */

/** 摘要采样行数上限（防巨型 prompt 差异把 entry 撑爆）。 */
const MAX_SAMPLE_LINES = 8;
/** 单行截断长度（字符）。 */
const MAX_SAMPLE_CHARS = 80;
/** LCS DP 面积上限：超过退化为 multiset 计数（O(n·m) → O(n+m)，防巨型 prompt 爆内存）。 */
const MAX_LCS_CELLS = 4_000_000;

/** 生成 oldText → newText 的行级 diff 摘要："+A -R lines" 头 + 最多 8 条采样行。 */
export function summarizePromptDiff(oldText: string, newText: string): string {
	const oldLines = oldText.split("\n");
	const newLines = newText.split("\n");
	const { removed, added } =
		oldLines.length * newLines.length <= MAX_LCS_CELLS
			? lcsLineDiff(oldLines, newLines)
			: multisetLineDiff(oldLines, newLines);

	const header = `+${added.length} -${removed.length} lines`;
	const samples: string[] = [];
	// 交替取样（added 优先）：注入类变化（只增不减）时全部展示新增行，混合变化时两类都可见
	let ai = 0;
	let ri = 0;
	while (samples.length < MAX_SAMPLE_LINES && (ai < added.length || ri < removed.length)) {
		if (ai < added.length) {
			samples.push(`+ ${truncate(added[ai])}`);
			ai++;
		}
		if (samples.length < MAX_SAMPLE_LINES && ri < removed.length) {
			samples.push(`- ${truncate(removed[ri])}`);
			ri++;
		}
	}
	return samples.length === 0 ? header : [header, ...samples].join("\n");
}

/** LCS 回溯行 diff：产出与文本顺序一致的 removed/added 序列（采样时更有可读性）。 */
function lcsLineDiff(a: readonly string[], b: readonly string[]): { removed: string[]; added: string[] } {
	const m = a.length;
	const n = b.length;
	const width = n + 1;
	const dp = new Uint32Array((m + 1) * width);
	for (let i = m - 1; i >= 0; i--) {
		for (let j = n - 1; j >= 0; j--) {
			dp[i * width + j] =
				a[i] === b[j]
					? dp[(i + 1) * width + j + 1] + 1
					: Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
		}
	}
	const removed: string[] = [];
	const added: string[] = [];
	let i = 0;
	let j = 0;
	while (i < m && j < n) {
		if (a[i] === b[j]) {
			i++;
			j++;
		} else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
			removed.push(a[i]);
			i++;
		} else {
			added.push(b[j]);
			j++;
		}
	}
	while (i < m) {
		removed.push(a[i]);
		i++;
	}
	while (j < n) {
		added.push(b[j]);
		j++;
	}
	return { removed, added };
}

/** multiset 行计数 diff（LCS 面积超限的降级路径）：行内容匹配抵消，剩余计入 added/removed。 */
function multisetLineDiff(a: readonly string[], b: readonly string[]): { removed: string[]; added: string[] } {
	const counts = new Map<string, number>();
	for (const line of a) {
		counts.set(line, (counts.get(line) ?? 0) + 1);
	}
	const added: string[] = [];
	for (const line of b) {
		const c = counts.get(line) ?? 0;
		if (c > 0) {
			counts.set(line, c - 1);
		} else {
			added.push(line);
		}
	}
	const removed: string[] = [];
	for (const [line, c] of counts) {
		for (let k = 0; k < c; k++) {
			removed.push(line);
		}
	}
	return { removed, added };
}

function truncate(line: string): string {
	return line.length > MAX_SAMPLE_CHARS ? line.slice(0, MAX_SAMPLE_CHARS - 1) + "…" : line;
}
