/**
 * analyzeBashStructure — bash 命令结构分析（层 1 AST 安全门）。
 *
 * 忠实移植自 Codex `codex-rs/shell-command/src/bash.rs` 的
 * `try_parse_word_only_commands_sequence` + `parse_plain_command_from_node`。
 *
 * 判定规则（与 Codex 一致）：
 *  - ALLOWED_KINDS（11 个 named node）：program/list/pipeline/command/command_name/
 *    word/string/string_content/raw_string/number/concatenation
 *  - ALLOWED_PUNCT_TOKENS（6 个 anonymous token）：'&&' '||' ';' '|' '"' "'"
 *  - root.hasError → 解析失败
 *  - 任何非白名单 named node → 危险（command_substitution/file_redirect/subshell 等）
 *  - 任何非白名单 anonymous token（且非空白）→ 危险（括号/反引号/重定向符等）
 *  - command 节点的 named children 必须全部能被 parsePlainCommand 提取（5 分支），
 *    任一分支返回 null → 该 command 跳过（但 dangerousStructures 已收集，clean 已置 false）
 *
 * 降级策略（fail-closed）：wasm 加载失败 / parse 异常 / root.hasError / 超长 →
 *  返回 { clean:false, commands:[], dangerousStructures:[...], parseError:true }，永不 throw。
 */

import type { Node, Tree } from "web-tree-sitter";
import { toErrorMessage } from "@zhushanwen/pi-ext-guards";
import { getLogger } from "@zhushanwen/pi-extension-logger";

import type { BashAnalysis } from "../types.js";
import { getBashParser } from "./loader.js";

const logger = getLogger("pi-permission/ast");

/** 超过此长度的输入直接拒（防止 wasm 解析巨型 payload DoS）。 */
const MAX_COMMAND_LENGTH = 65536;

/** 带引号 token 的最小长度（首尾引号各占 1 字符）；满足才能安全剥引号。 */
const MIN_QUOTED_TOKEN_LENGTH = 2;

/**
 * Codex ALLOWED_KINDS（11 个 named node）。
 * 遇到不在此集合的 named node 即判定为危险结构。
 */
const ALLOWED_KINDS = new Set([
	"program",
	"list",
	"pipeline",
	"command",
	"command_name",
	"word",
	"string",
	"string_content",
	"raw_string",
	"number",
	"concatenation",
]);

/**
 * Codex ALLOWED_PUNCT_TOKENS（6 个 anonymous operator/quote token）。
 * 遇到不在此集合且含 &;| 的 operator token，或任何非空白 anonymous token，即判定为危险。
 */
const ALLOWED_PUNCT_TOKENS = new Set(["&&", "||", ";", "|", '"', "'"]);

/** 检查 anonymous token 是否含 & ; | 中任一字符（与 Rust `kind.chars().any(...)` 等价）。 */
function hasControlOperatorChar(kind: string): boolean {
	return kind.includes("&") || kind.includes(";") || kind.includes("|");
}

/**
 * 解析双引号字符串（对应 Rust parse_double_quoted_string）。
 *
 * 规则：string 的 named children 必须全部是 string_content；
 * 若含 ${VAR}/$VAR/$(...) 会变成 simple_expansion/command_substitution（非 string_content），
 * 返回 null。通过后，返回去掉首尾双引号的文本。
 */
function parseDoubleQuotedString(node: Node): string | null {
	if (node.type !== "string") {
		return null;
	}
	for (const child of node.namedChildren) {
		if (child.type !== "string_content") {
			return null;
		}
	}
	const raw = node.text;
	// 去掉首尾的 `"`（raw 形如 `"hello world"`）
	if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= MIN_QUOTED_TOKEN_LENGTH) {
		return raw.slice(1, -1);
	}
	// 异常 grammar（理论上不会到这）—— 原样返回
	return raw;
}

/**
 * 解析单引号字符串（对应 Rust parse_raw_string）。
 * 去掉首尾的 `'`。
 */
function parseRawString(node: Node): string | null {
	if (node.type !== "raw_string") {
		return null;
	}
	const raw = node.text;
	if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= MIN_QUOTED_TOKEN_LENGTH) {
		return raw.slice(1, -1);
	}
	return raw;
}

/**
 * command_name 分支：其第一个 named child 必须是 word，取文本；否则 null。
 */
function parseCommandName(child: Node): string | null {
	const wordNode = child.namedChild(0);
	if (!wordNode || wordNode.type !== "word") {
		return null;
	}
	return wordNode.text;
}

/**
 * concatenation 分支（如 -g"*.py" 或 '/usr'"/"'local'/bin）：
 * 递归拼接各 part（word/number/string/raw_string），空拼接结果 → null。
 */
function parseConcatenation(child: Node): string | null {
	let concatenated = "";
	for (const part of child.namedChildren) {
		switch (part.type) {
			case "word":
			case "number":
				concatenated += part.text;
				break;
			case "string": {
				const parsed = parseDoubleQuotedString(part);
				if (parsed === null) return null;
				concatenated += parsed;
				break;
			}
			case "raw_string": {
				const parsed = parseRawString(part);
				if (parsed === null) return null;
				concatenated += parsed;
				break;
			}
			default:
				return null;
		}
	}
	if (concatenated.length === 0) {
		return null;
	}
	return concatenated;
}

/**
 * 解析 command 的单个 named child 为一个 argv token（分发表）。
 *
 * 5 分支：
 *  1. command_name → parseCommandName（第一个 named child 必须是 word）
 *  2. word | number → 直接取文本
 *  3. string → parseDoubleQuotedString（含 expansion 则 null）
 *  4. raw_string → parseRawString
 *  5. concatenation → parseConcatenation
 *
 * 未知 named child（不应发生 —— DFS 阶段已拒，但保险起见 fail-closed）→ null。
 * 失败 → 调用方让整个 command 返回 null（该 command 被跳过，但 clean 已在 DFS 阶段被置 false）。
 */
function parseChildToken(child: Node): string | null {
	switch (child.type) {
		case "command_name":
			return parseCommandName(child);
		case "word":
		case "number":
			return child.text;
		case "string":
			return parseDoubleQuotedString(child);
		case "raw_string":
			return parseRawString(child);
		case "concatenation":
			return parseConcatenation(child);
		default:
			return null;
	}
}

/**
 * 从一个 command 节点提取 argv（对应 Rust parse_plain_command_from_node）。
 *
 * 主函数编排：类型守卫 → 逐 named child 分发（parseChildToken）→ 组装 words。
 * 任一 child 解析失败 → 返回 null。
 */
function parsePlainCommand(cmd: Node): string[] | null {
	if (cmd.type !== "command") {
		return null;
	}

	const words: string[] = [];
	for (const child of cmd.namedChildren) {
		const token = parseChildToken(child);
		if (token === null) {
			return null;
		}
		words.push(token);
	}
	return words;
}

/**
 * 分析 bash 命令字符串的结构（层 1 AST 安全门）。
 *
 * 主函数编排：空/超长/初始化快速路径 → parse → collectStructures（DFS）→
 * parsePlainCommand 提取 argv → 组装 BashAnalysis。DFS + argv 提取已拆为独立
 * helper（collectStructures / extractCommands），主函数 ≤80 行。
 *
 * @param command 原始命令字符串
 * @returns BashAnalysis —— 永不 throw，失败时 fail-closed 返回 parseError:true
 */
export async function analyzeBashStructure(command: string): Promise<BashAnalysis> {
	// 空字符串 / 纯空白 → 干净且无命令
	if (command.trim().length === 0) {
		return { clean: true, commands: [], dangerousStructures: [], parseError: false };
	}

	// 超长 → fail-closed
	if (command.length > MAX_COMMAND_LENGTH) {
		return failClosed("INPUT_TOO_LONG");
	}

	const parser = await getBashParser();
	if (parser === null) {
		return failClosed("INIT_FAILED");
	}

	let tree: Tree | null = null;
	try {
		tree = parser.parse(command);
		if (!tree) return failClosed("PARSE_NULL");

		const root = tree.rootNode;
		if (root.hasError) return failClosed("ERROR");

		// DFS 遍历收集危险结构 + command 节点（拆为 helper，主函数保持精简）
		const { dangerousStructures, commandNodes } = collectStructures(root);
		const commands = extractCommands(commandNodes);

		return {
			clean: dangerousStructures.length === 0,
			commands,
			dangerousStructures,
			parseError: false,
		};
	} catch (err) {
		// 任何意外异常 → fail-closed
		const msg = toErrorMessage(err);
		logger.warn("analyzeBashStructure exception", { error: msg });
		return failClosed(msg || "EXCEPTION");
	} finally {
		// G1 critical: Tree 是 wasm 堆对象，不受 V8 GC 管，必须显式 delete 释放。
		tree?.delete();
	}
}

/** 构造 fail-closed BashAnalysis（clean=false, parseError=true, 单条 reason）。 */
function failClosed(reason: string): BashAnalysis {
	return {
		clean: false,
		commands: [],
		dangerousStructures: [reason],
		parseError: true,
	};
}

/** DFS 遍历收集结果：危险结构节点类型 + command 节点。 */
interface StructureCollection {
	dangerousStructures: string[];
	commandNodes: Node[];
}

/**
 * DFS 遍历 AST（stack-based，与 Rust 一致用 node.children() 不是 namedChildren）。
 *
 * 收集：
 *  - 非白名单 named node → dangerousStructures（command_substitution/subshell 等）
 *  - 非白名单 anonymous token（含 &;| 或非空白）→ dangerousStructures
 *  - command 节点 → commandNodes（后续 parsePlainCommand 提取 argv）
 *
 * @param root AST 根节点
 * @returns 危险结构 + command 节点（commandNodes 已按 start_byte 排序恢复源码顺序）
 */
function collectStructures(root: Node): StructureCollection {
	const stack: Node[] = [root];
	const dangerousStructures: string[] = [];
	const commandNodes: Node[] = [];

	while (stack.length > 0) {
		const node = stack.pop()!;
		const kind = node.type;

		if (node.isNamed) {
			if (!ALLOWED_KINDS.has(kind)) {
				// 非白名单 named node → 危险结构
				dangerousStructures.push(kind);
			}
			if (kind === "command") {
				commandNodes.push(node);
			}
		} else {
			// anonymous token —— 与 Rust 两条判定对应：
			// 1. 含 &;| 但不在白名单 → 危险
			// 2. 不在白名单且非空白 → 危险（括号/反引号/重定向符等）
			const isAllowedOrWhitespace =
				ALLOWED_PUNCT_TOKENS.has(kind) || kind.trim().length === 0;
			if (hasControlOperatorChar(kind) && !ALLOWED_PUNCT_TOKENS.has(kind)) {
				dangerousStructures.push(kind);
			} else if (!isAllowedOrWhitespace) {
				dangerousStructures.push(kind);
			}
		}

		// node.children 在 web-tree-sitter 是 getter（返回 Array<SyntaxNode>）
		for (const child of node.children) {
			stack.push(child);
		}
	}

	// stack 是 LIFO，按 start_byte 排序恢复源码顺序（与 Rust 一致）
	commandNodes.sort((a, b) => a.startIndex - b.startIndex);
	return { dangerousStructures, commandNodes };
}

/**
 * 从 command 节点列表提取 argv（用 parsePlainCommand）。
 *
 * parsePlainCommand 返回 null 的 command 跳过（clean 已由 dangerousStructures 决定）。
 *
 * @param commandNodes 已按源码顺序排序的 command 节点
 * @returns argv 数组（每个元素是一条 command 的 argv）
 */
function extractCommands(commandNodes: Node[]): string[][] {
	const commands: string[][] = [];
	for (const node of commandNodes) {
		const words = parsePlainCommand(node);
		if (words !== null) {
			commands.push(words);
		}
	}
	return commands;
}
