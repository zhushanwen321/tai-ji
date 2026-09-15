/**
 * 有界化纯文本原语 — loop-gate / workflow-hook 的共享叶节点（零依赖、无副作用）。
 *
 * 破环（结构度量门禁）：原先 loop-gate → workflow-hook（extractToolErrorText）与
 * workflow-hook → loop-gate（STEER_ERROR_MAX_CHARS / truncateText）构成模块环；
 * 双方互引的纯函数/常量统一收敛到本模块，依赖图恢复单向：
 *   loop-gate → text-primitives ← workflow-hook
 *
 * 导出复用勿复制（审查项#1）：新调用方一律 import 本模块，禁止拷贝实现。
 */

/**
 * 闸门签名侧截断上限：① normalizeErrorSignature fallback 分支（提取不到字段 token 的
 * 非校验类错误文本降级为裸前缀做等值比较，消费方 loop-gate）；② LoopGate.lastErrorText
 * （terminal 日志引用，不进模型上下文，消费方 loop-gate）。与 steer 回灌错误块上限
 * （STEER_ERROR_MAX_CHARS）语义独立（F5 拆分：签名只做比较原料、可随实现演化；steer
 * 是模型可见文本预算），两上限不共享数值演化。
 */
export const SIGNATURE_MAX_CHARS = 500;

/**
 * steer 回灌错误块截断上限（workflow-hook 消费；审查项#1：pi-ai validation.js 的
 * 实参回显无截断，大 payload 失败时单份 steer ≈11K chars）。截断保留首部 = 错误类型
 * + 靠前字段名；完整 schema 形状由 reminder 内 schemaJson 全文另行完整携带，不依赖
 * 错误块。
 */
export const STEER_ERROR_MAX_CHARS = 500;

/**
 * 截断到 max 字符（超出追加 "..."）——有界化原语，勿复制（审查项#1：导出复用）。
 * max 必显式传入：签名侧传 SIGNATURE_MAX_CHARS（loop-gate 内部），steer 侧传
 * STEER_ERROR_MAX_CHARS（workflow-hook）——不设默认值，防止新调用方静默绑错语义。
 */
export function truncateText(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}...`;
}

/**
 * 从 tool 执行结果里提取错误文本。
 *
 * Pi 框架在参数层校验失败（immediate 路径）与 execute 抛错时，均构造
 * `{ content: [{ type: "text", text }] }` 塞进 result.content[0].text
 * （agent-loop.js createErrorToolResult；SDK 事件结构里没有独立 errorMessage 字段，
 * 错误文本只能从 result.content 里取）。loop-gate（D3）复用本函数提取签名原料，
 * workflow-hook 取 steer 回灌文本。
 * 这里防御性取多种结构，取不到就返回 undefined（调用方降级为通用提示）。
 */
export function extractToolErrorText(result: unknown): string | undefined {
	// 常见结构：{ content: [{ type: "text", text: "..." }] }
	if (typeof result === "object" && result !== null) {
		const content = (result as Record<string, unknown>).content;
		if (Array.isArray(content)) {
			for (const item of content) {
				if (typeof item === "object" && item !== null) {
					const text = (item as Record<string, unknown>).text;
					if (typeof text === "string" && text.length > 0) return text;
				}
			}
		}
		// 兜底：某些 tool 直接塞 { error: "..." }
		const err = (result as Record<string, unknown>).error;
		if (typeof err === "string" && err.length > 0) return err;
	}
	return undefined;
}
