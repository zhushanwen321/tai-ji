/**
 * 旧工具名精确规则一次性迁移（tool-declaration-slimming D3 / U-B1）。
 *
 * 背景：subagent-workflow 扩展的 `subagent`/`workflow` 工具已拆分为
 * subagent_start/subagent_manage/subagent_message 与 workflow_run/workflow_control，
 * 旧名不保留别名（探针 PB-fork）。用户权限规则按工具名匹配（`Rule.tool`）并持久化
 * 落盘（config.ts saveConfig），旧名精确规则随改名失配——deny 静默退化成 ask/AI 分类。
 * 批量工具 `subagents` → `subagent_batch` 改名（2026-10-23）同机制入表。
 *
 * 迁移语义（D3 两条契约）：
 *  ① 展开落位与保序——精确匹配旧名的用户规则**原地替换**为其新名展开（展开顺序
 *     subagent → start/manage/message、workflow → run/control），与未迁移规则的相对
 *     次序保持不变。matcher 是 last-match-wins 按数组顺序遍历（rules/matcher.ts
 *     lastMatchWins），「收集展开规则追加到数组尾部」式实装会静默翻转混合规则集
 *     （精确规则与 wildcard 规则共存）的 deny/allow 胜负且无报错。
 *  ② 新 id——展开出的每条分配新 id（复用 rule-templates.ts 的 makeNextIdCounter，
 *     从既有 user-N 最大值 +1 递增），禁止克隆原对象共享 id：Rule.id 语义为唯一 id
 *     （types.ts），rule-editor 按 id 键控删除（rule-editor.ts delete op），同 id 多条
 *     会导致删除错乱。
 *
 * 范围与幂等：
 *  - 只迁移**精确等于**旧名的 tool 字段（`rule.tool === "subagent"` / `"workflow"`）；
 *    wildcard（`'*'`）与其他含通配形态的规则一律不动（D3：wildcard 规则不动）。
 *  - 幂等：新名不在旧名集合中，已迁移的配置再次加载零变化。
 *  - 只在内存展开（loadAndWatchConfig 读时迁移），不回写落盘——加载路径保持纯读；
 *    用户下次经 rule-editor 保存时自然持久化新名形态。
 *
 * 跨包契约登记：本表展开目标名与 subagent-workflow 的工具注册名互为跨包隐式契约
 * （两包无 import 依赖，漂移零报错）——SW 工具再拆分/改名须同步本表（旧名进 key、
 * 新名进展开目标），失配后果 = 旧名 deny 规则静默退化成 ask/AI 分类。登记条目见
 * docs/extensions/extension-conventions.md「跨包隐式契约：permission 旧名展开表
 * ↔ subagent-workflow 工具注册名」。
 */

import type { Rule } from "../types.js";
import { makeNextIdCounter } from "../rule-templates.js";

/** 精确旧名 → 拆分新名展开表（顺序承重：D3 契约①的展开次序）。 */
const LEGACY_TOOL_NAME_EXPANSION: Readonly<Record<string, readonly string[]>> = {
	subagent: ["subagent_start", "subagent_manage", "subagent_message"],
	workflow: ["workflow_run", "workflow_control"],
	subagents: ["subagent_batch"],
};

/**
 * 对规则数组做旧名精确规则迁移（纯函数，幂等，保序）。
 *
 * - 非迁移规则原样保留（同对象引用），相对次序不变；
 * - 命中旧名的规则原地展开为 N 条新名规则（pattern/action/source/description 保留，
 *   tool 换新名、id 全新递增分配）；
 * - 无旧名规则时返回原数组引用（零拷贝快速路径）。
 */
export function migrateLegacyToolRules(rules: Rule[]): Rule[] {
	const hasLegacy = rules.some((rule) => LEGACY_TOOL_NAME_EXPANSION[rule.tool] !== undefined);
	if (!hasLegacy) return rules;

	// 新 id 分配基准 = 迁移前全部既有规则（含将被展开的旧名规则本身）——
	// makeNextIdCounter 从 user-N 最大值 +1 递增，展开条目不与任何既有 id 冲突。
	const nextId = makeNextIdCounter(rules);
	const result: Rule[] = [];
	for (const rule of rules) {
		const expansion = LEGACY_TOOL_NAME_EXPANSION[rule.tool];
		if (expansion === undefined) {
			result.push(rule);
			continue;
		}
		for (const tool of expansion) {
			result.push({ ...rule, id: nextId(), tool });
		}
	}
	return result;
}
