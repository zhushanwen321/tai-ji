/**
 * W8: Rule templates + preset commands + applyOps.
 *
 * G4：pattern 用 wildcard（`npm *`），不用正则（`\bnpm\b`）。
 * W3 matcher 对 user 规则走 `wildcardToRegExp(pattern)`，末尾 ` *` 匹配无参 + 有参。
 *
 * G8：build 不生成 id（由 commitFill 赋 sessionIdCounter()）。
 * G13：sessionIdCounter 立即赋值，不用 `__new__` 占位。
 * applyOps 无 nextId 参数，add 分支直接用 op.rule.id。
 */

import type { PermissionAction, Rule, RuleSource } from "./types.js";

// ──────────────────────── PRESET_COMMANDS（53 命令 + Other） ────────────────────────

export interface PresetCommand {
	cmd: string;
	label: string;
	category: string;
}

/** 包管理器 6 + 容器云 5 + VCS 3 + 构建任务 6 + 网络下载 8 + 文件系统 9 + 运行时 2 + 文本处理 6 + 系统信息 8 = 53 */
export const PRESET_COMMANDS: readonly PresetCommand[] = [
	// 包管理器
	{ cmd: "npm", label: "npm (Node package manager)", category: "Package Managers" },
	{ cmd: "yarn", label: "yarn (Node package manager)", category: "Package Managers" },
	{ cmd: "pnpm", label: "pnpm (Node package manager)", category: "Package Managers" },
	{ cmd: "pip", label: "pip (Python package installer)", category: "Package Managers" },
	{ cmd: "brew", label: "brew (macOS package manager)", category: "Package Managers" },
	{ cmd: "apt", label: "apt (Debian/Ubuntu package manager)", category: "Package Managers" },
	// 容器云
	{ cmd: "docker", label: "docker (container runtime)", category: "Containers & Cloud" },
	{ cmd: "kubectl", label: "kubectl (Kubernetes CLI)", category: "Containers & Cloud" },
	{ cmd: "terraform", label: "terraform (infrastructure as code)", category: "Containers & Cloud" },
	{ cmd: "aws", label: "aws (AWS CLI)", category: "Containers & Cloud" },
	{ cmd: "gcloud", label: "gcloud (Google Cloud CLI)", category: "Containers & Cloud" },
	// VCS
	{ cmd: "git", label: "git (version control)", category: "Version Control" },
	{ cmd: "gh", label: "gh (GitHub CLI)", category: "Version Control" },
	{ cmd: "hg", label: "hg (Mercurial)", category: "Version Control" },
	// 构建任务
	{ cmd: "make", label: "make (build tool)", category: "Build & Tasks" },
	{ cmd: "cargo", label: "cargo (Rust build tool)", category: "Build & Tasks" },
	{ cmd: "go", label: "go (Go toolchain)", category: "Build & Tasks" },
	{ cmd: "mvn", label: "mvn (Maven)", category: "Build & Tasks" },
	{ cmd: "gradle", label: "gradle (Gradle build)", category: "Build & Tasks" },
	{ cmd: "cmake", label: "cmake (C/C++ build)", category: "Build & Tasks" },
	// 网络下载
	{ cmd: "curl", label: "curl (HTTP client)", category: "Network & Download" },
	{ cmd: "wget", label: "wget (downloader)", category: "Network & Download" },
	{ cmd: "ssh", label: "ssh (remote shell)", category: "Network & Download" },
	{ cmd: "scp", label: "scp (secure copy)", category: "Network & Download" },
	{ cmd: "rsync", label: "rsync (file sync)", category: "Network & Download" },
	{ cmd: "ping", label: "ping (network probe)", category: "Network & Download" },
	{ cmd: "dig", label: "dig (DNS lookup)", category: "Network & Download" },
	{ cmd: "ssh-keygen", label: "ssh-keygen (SSH key generation)", category: "Network & Download" },
	// 文件系统
	{ cmd: "rm", label: "rm (remove files)", category: "Filesystem" },
	{ cmd: "cp", label: "cp (copy files)", category: "Filesystem" },
	{ cmd: "mv", label: "mv (move files)", category: "Filesystem" },
	{ cmd: "chmod", label: "chmod (change permissions)", category: "Filesystem" },
	{ cmd: "ls", label: "ls (list directory)", category: "Filesystem" },
	{ cmd: "cat", label: "cat (concatenate files)", category: "Filesystem" },
	{ cmd: "find", label: "find (search files)", category: "Filesystem" },
	{ cmd: "grep", label: "grep (search text)", category: "Filesystem" },
	{ cmd: "tree", label: "tree (directory tree)", category: "Filesystem" },
	// 运行时
	{ cmd: "node", label: "node (Node.js runtime)", category: "Runtime" },
	{ cmd: "python", label: "python (Python runtime)", category: "Runtime" },
	// 文本处理
	{ cmd: "jq", label: "jq (JSON processor)", category: "Text Processing" },
	{ cmd: "sed", label: "sed (stream editor)", category: "Text Processing" },
	{ cmd: "awk", label: "awk (text processing)", category: "Text Processing" },
	{ cmd: "sort", label: "sort (sort lines)", category: "Text Processing" },
	{ cmd: "diff", label: "diff (compare files)", category: "Text Processing" },
	{ cmd: "iconv", label: "iconv (encoding converter)", category: "Text Processing" },
	// 系统信息
	{ cmd: "ps", label: "ps (process list)", category: "System & Info" },
	{ cmd: "top", label: "top (process monitor)", category: "System & Info" },
	{ cmd: "du", label: "du (disk usage)", category: "System & Info" },
	{ cmd: "df", label: "df (disk free)", category: "System & Info" },
	{ cmd: "uname", label: "uname (system info)", category: "System & Info" },
	{ cmd: "whoami", label: "whoami (current user)", category: "System & Info" },
	{ cmd: "env", label: "env (environment variables)", category: "System & Info" },
	{ cmd: "date", label: "date (system date)", category: "System & Info" },
] as const;

// ──────────────────────── RuleTemplate ────────────────────────

/** 模板 selections 值类型（各字段按模板分支含义不同）。 */
export interface TemplateSelections {
	cmd?: string;
	subcmd?: string;
	/** Custom 模板直接传完整字段 */
	pattern?: string;
	action?: PermissionAction;
	tool?: string;
	description?: string;
}

/** build 返回的 Rule（无 id，由 commitFill 赋值）。 */
export interface RuleWithoutId {
	tool: string;
	pattern: string;
	action: PermissionAction;
	source: RuleSource;
	description?: string;
}

export interface RuleTemplate {
	id: string;
	label: string;
	description: string;
	build(selections: TemplateSelections): RuleWithoutId;
}

// ──────────────────────── 5 个模板 ────────────────────────

export const allowFamilyTemplate: RuleTemplate = {
	id: "allow-family",
	label: "Allow command family",
	description: "Allow all invocations of a command (e.g., npm install, npm run build, npm with no args)",
	build(selections): RuleWithoutId {
		const cmd = selections.cmd ?? "unknown";
		return {
			tool: "bash",
			pattern: `${cmd} *`,
			action: "allow",
			source: "user",
		};
	},
};

export const denyFamilyTemplate: RuleTemplate = {
	id: "deny-family",
	label: "Deny command family",
	description: "Deny all invocations of a command (or specific subcommand)",
	build(selections): RuleWithoutId {
		const cmd = selections.cmd ?? "unknown";
		const subcmd = selections.subcmd;
		if (subcmd === undefined || subcmd === "__any__") {
			return {
				tool: "bash",
				pattern: `${cmd} *`,
				action: "deny",
				source: "user",
			};
		}
		return {
			tool: "bash",
			pattern: `${cmd} ${subcmd} *`,
			action: "deny",
			source: "user",
		};
	},
};

export const askBeforeTemplate: RuleTemplate = {
	id: "ask-before",
	label: "Ask before command",
	description: "Ask for confirmation before running a command",
	build(selections): RuleWithoutId {
		const cmd = selections.cmd ?? "unknown";
		return {
			tool: "bash",
			pattern: `${cmd} *`,
			action: "ask",
			source: "user",
		};
	},
};

export const allowSubcmdTemplate: RuleTemplate = {
	id: "allow-subcmd",
	label: "Allow specific subcommand",
	description: "Allow only a specific subcommand (e.g., git status, git log)",
	build(selections): RuleWithoutId {
		const cmd = selections.cmd ?? "unknown";
		const subcmd = selections.subcmd;
		// __any__ 哨兵：用户在 RPC 流程选了「all subcommands」→ 退化为 allow-family 语义，
		// 避免拼成永不匹配的死规则 `<cmd> __any__ *`（与 deny-family 对称）。
		if (subcmd === undefined || subcmd === "__any__") {
			return {
				tool: "bash",
				pattern: `${cmd} *`,
				action: "allow",
				source: "user",
			};
		}
		return {
			tool: "bash",
			pattern: `${cmd} ${subcmd} *`,
			action: "allow",
			source: "user",
		};
	},
};

export const customTemplate: RuleTemplate = {
	id: "custom",
	label: "Custom (advanced)",
	description: "Define a custom rule with arbitrary pattern, action, and tool",
	build(selections): RuleWithoutId {
		return {
			tool: selections.tool ?? "bash",
			pattern: selections.pattern ?? "*",
			action: selections.action ?? "allow",
			source: "user",
			description: selections.description,
		};
	},
};

/** 所有模板（5 个，顺序固定）。 */
export const ALL_TEMPLATES: readonly RuleTemplate[] = [
	allowFamilyTemplate,
	denyFamilyTemplate,
	askBeforeTemplate,
	allowSubcmdTemplate,
	customTemplate,
] as const;

// ──────────────────────── applyOps ────────────────────────

/** RuleOp discriminated union（G13：add 时 rule.id 已是真实 user-N）。 */
export type RuleOp =
	| { kind: "add"; rule: Rule }
	| { kind: "edit"; id: string; rule: Rule }
	| { kind: "delete"; id: string };

/**
 * 纯函数：对 userRules 施加 ops，返回新数组。
 * - add：push op.rule（id 已赋值）
 * - edit：findIndex(id) + 替换
 * - delete：filter 过滤
 *
 * G8/G13：无 nextId 参数（add 时 rule.id 由 sessionIdCounter 立即赋值）。
 */
export function applyOps(userRules: Rule[], ops: RuleOp[]): Rule[] {
	let result = [...userRules];
	for (const op of ops) {
		switch (op.kind) {
			case "add": {
				result = [...result, op.rule];
				break;
			}
			case "edit": {
				const idx = result.findIndex((r) => r.id === op.id);
				if (idx >= 0) {
					result = [...result.slice(0, idx), op.rule, ...result.slice(idx + 1)];
				}
				break;
			}
			case "delete": {
				result = result.filter((r) => r.id !== op.id);
				break;
			}
		}
	}
	return result;
}

// ──────────────────────── makeNextIdCounter ────────────────────────

/**
 * 构造 sessionIdCounter 闭包：从已有规则中提取 user-N 最大值 +1 递增。
 *
 * G13：commitFill 时 `rule.id = this.sessionIdCounter()` 立即拿到真实 id。
 */
export function makeNextIdCounter(existingRules: Rule[]): () => string {
	let maxN = 0;
	for (const rule of existingRules) {
		const m = /^user-(\d+)$/.exec(rule.id);
		if (m !== null) {
			const n = Number.parseInt(m[1], 10);
			if (n > maxN) maxN = n;
		}
	}
	let next = maxN + 1;
	return (): string => `user-${next++}`;
}
