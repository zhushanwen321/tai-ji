/**
 * 内置规则：安全白名单（50+9）+ 危险规则（permission-gate 12）。
 *
 * ── G3 修正 ──
 * Codex 的 base64/find/rg/git/sed 有 argv 级 flag 子检查，单条 wildcard 无法表达
 * 「base64 但不含 -o」。所以白名单用 `isKnownSafeCommand(argv): boolean` 函数实现
 * （不进 Rule[] 数组），而 permission-gate 12 条危险规则作为 `Rule[]`
 * （source='builtin-danger'，pattern=正则字符串）。
 *
 * 移植忠实源码：
 *  - 安全白名单：codex-cli/codex-rs/shell-command/src/command_safety/is_safe_command.rs
 *    （is_safe_to_call_with_exec / is_safe_git_command / git_branch_is_read_only /
 *     is_valid_sed_n_arg / find_git_subcommand / executable_name_lookup_key）
 *  - git 全局选项：is_dangerous_command.rs（is_git_global_option_with_value /
 *    is_git_global_option_with_inline_value）
 *  - 危险规则：pi-agent-extensions/permission-gate/index.ts DEFAULT_RULES
 *
 * 与源码的差异（合理近似，已注释）：
 *  - Rust `cfg(target_os = "linux")` 的 numfmt/tac：本扩展面向 Pi agent（跨平台），
 *    TS 无编译期 cfg，统一不加入白名单（与源码在非 linux 行为一致）。
 *  - Rust `bash -lc "<script>"` 复合命令解析（parse_shell_lc_plain_commands）：
 *    该职责属于 W2 AST 层（analyzeBashStructure 会把复合命令拆成 commands[][]），
 *    本函数只做单条 argv 判定，不重复实现 bash 解析。
 *  - Windows powershell safelist：非本扩展目标平台，不移植。
 *  - argv[0]=='zsh' → 'bash' 的归一化：保留（与源码一致）。
 */

import type { Rule } from "../types.js";

// ──────────────────────── Codex 安全白名单 ────────────────────────

/**
 * Codex 无条件安全命令（50 个，is_safe_to_call_with_exec 的 match 分支）。
 * 前 24 条移植自 Codex safelist，后 26 条是本扩展在验证无写入 flag 后扩充。
 * numfmt/tac 仅 linux 安全，跨平台不加入。
 */
export const BUILTIN_UNCONDITIONAL_SAFE: ReadonlySet<string> = new Set([
	"arch",
	"basename",
	"cat",
	"cd",
	"cksum",
	"cmp",
	"column",
	"comm",
	"cut",
	"diff",
	"dirname",
	"du",
	"df",
	"echo",
	"expand",
	"expr",
	"false",
	"file",
	"fold",
	"grep",
	"groups",
	"head",
	"id",
	"jq",
	"ls",
	"md5sum",
	"nl",
	"paste",
	"printenv",
	"ps",
	"pwd",
	"readlink",
	"realpath",
	"rev",
	"seq",
	"sha256sum",
	"shasum",
	"stat",
	"tail",
	"tr",
	"true",
	"tsort",
	"uniq",
	"uname",
	"uptime",
	"wc",
	"whereis",
	"who",
	"whoami",
	"which",
]);

/** 9 个带 flag 子检查的条件安全命令。 */
const CONDITIONAL_SAFE_COMMANDS: ReadonlySet<string> = new Set([
	"base64",
	"find",
	"rg",
	"git",
	"sed",
	"sort",
	"iconv",
	"shuf",
	"date",
]);

// ── executable_name_lookup_key（取 basename，非 win32 不转小写/不去后缀） ──

/**
 * 取 argv[0] 的 basename 作为 lookup key。
 *
 * 移植自 Rust executable_name_lookup_key（非 windows 分支）：
 * `Path::new(raw).file_name()`。TS 用 lastIndexOf('/') 近似（命令名不含反斜杠，
 * 且 Windows 路径分隔符在本扩展不做特殊处理）。
 */
function executableNameLookupKey(raw: string): string | undefined {
	if (raw.length === 0) return undefined;
	const slash = raw.lastIndexOf("/");
	return slash >= 0 ? raw.slice(slash + 1) : raw;
}

// ── 合并短 flag 检查工具（G4: 合并 flag 如 -fo 需检测任意位置的 -o）──

/** 短 flag 簇（`-x`）的最小长度：`-` + 至少 1 个 flag 字符。 */
const MIN_SHORT_FLAG_CLUSTER_LENGTH = 2;

/**
 * 检查短 flag 簇中是否含某个字符（如 `-fo` 含 `o`）。
 *
 * 短 flag 簇：以单个 `-` 开头、非 `--`、长度 ≥ 2 的 token。
 * `-o` / `-fo` / `-of` / `-fox` 都算短 flag 簇；`--output` / `--output=x` 不算。
 *
 * @param arg 待检查的 token
 * @param flagChar 要检测的字符（如 "o" 表示 -o）
 * @returns 短 flag 簇中任意位置出现该字符 → true
 */
function shortFlagClusterHasChar(arg: string, flagChar: string): boolean {
	// 只处理短 flag 簇：单个 - 开头，非 --，长度 ≥ 2
	if (!arg.startsWith("-") || arg.startsWith("--") || arg.length < MIN_SHORT_FLAG_CLUSTER_LENGTH) return false;
	// arg 去掉开头的 -，检查剩余字符
	return arg.slice(1).includes(flagChar);
}

// ── base64 ──

const UNSAFE_BASE64_OPTIONS: ReadonlySet<string> = new Set(["-o", "--output"]);

function isSafeBase64(argv: string[]): boolean {
	// 跳过 argv[0]，任一参数命中危险 → 不安全
	return !argv.slice(1).some((arg) => {
		return (
			UNSAFE_BASE64_OPTIONS.has(arg) ||
			arg.startsWith("--output=") ||
			// 合并短 flag 簇含 o（-o / -fo / -of / -fob64）
			shortFlagClusterHasChar(arg, "o")
		);
	});
}

// ── find ──

const UNSAFE_FIND_OPTIONS: ReadonlySet<string> = new Set([
	// 可执行任意命令
	"-exec",
	"-execdir",
	"-ok",
	"-okdir",
	// 删除匹配文件
	"-delete",
	// 把路径写入文件
	"-fls",
	"-fprint",
	"-fprint0",
	"-fprintf",
]);

function isSafeFind(argv: string[]): boolean {
	return !argv.some((arg) => UNSAFE_FIND_OPTIONS.has(arg));
}

// ── rg (ripgrep) ──

const UNSAFE_RIPGREP_OPTIONS_WITH_ARGS: readonly string[] = [
	// 对每个匹配执行任意命令
	"--pre",
	// 取本地 hostname 的命令
	"--hostname-bin",
];

const UNSAFE_RIPGREP_OPTIONS_WITHOUT_ARGS: ReadonlySet<string> = new Set([
	// 调用外部解压工具，谨慎起见不放行
	"--search-zip",
	"-z",
]);

function isSafeRipgrep(argv: string[]): boolean {
	return !argv.some((arg) => {
		if (UNSAFE_RIPGREP_OPTIONS_WITHOUT_ARGS.has(arg)) return true;
		return UNSAFE_RIPGREP_OPTIONS_WITH_ARGS.some(
			(opt) => arg === opt || arg.startsWith(opt + "="),
		);
	});
}

// ── git 全局选项（is_dangerous_command.rs）──

/** 取值的 global option（下一个参数是它的值，需 skip）。 */
const GIT_GLOBAL_OPTION_WITH_VALUE: ReadonlySet<string> = new Set([
	"-C",
	"-c",
	"--config-env",
	"--exec-path",
	"--git-dir",
	"--namespace",
	"--super-prefix",
	"--work-tree",
]);

/** 短选项（如 `-C`/`-c`）的字符长度；更长者带内联值（`-C.`/`-ck=v`）。 */
const SHORT_FLAG_LENGTH = 2;

/** 内联取值的 global option（`--key=value` 形式，自身即完整，不 skip 下一个）。 */
function isGitGlobalOptionWithInlineValue(arg: string): boolean {
	return (
		arg.startsWith("--config-env=") ||
		arg.startsWith("--exec-path=") ||
		arg.startsWith("--git-dir=") ||
		arg.startsWith("--namespace=") ||
		arg.startsWith("--super-prefix=") ||
		arg.startsWith("--work-tree=") ||
			// `-C.` / `-ck=v`（短选项内联值，长度 > SHORT_FLAG_LENGTH）
			((arg.startsWith("-C") || arg.startsWith("-c")) &&
				arg.length > SHORT_FLAG_LENGTH)
	);
}

/**
 * 在 argv 中查找第一个匹配的 git 子命令，跳过它前面的已知 global option。
 *
 * 移植自 Rust find_git_subcommand。返回 [index, subcommand] 或 undefined。
 */
export function findGitSubcommand(
	command: string[],
	subcommands: readonly string[],
): [number, string] | undefined {
	const cmd0 = command[0];
	if (cmd0 === undefined) return undefined;
	if (executableNameLookupKey(cmd0) !== "git") return undefined;

	let skipNext = false;
	for (let idx = 1; idx < command.length; idx++) {
		const arg = command[idx];
		if (arg === undefined) continue;

		if (skipNext) {
			skipNext = false;
			continue;
		}

		if (isGitGlobalOptionWithInlineValue(arg)) continue;

		if (GIT_GLOBAL_OPTION_WITH_VALUE.has(arg)) {
			skipNext = true;
			continue;
		}

		if (arg === "--" || arg.startsWith("-")) continue;

		if (subcommands.includes(arg)) return [idx, arg];

		// 第一个非选项 token 就是子命令；若不在目标列表，停止扫描
		// （避免把后续位置参数如分支名误判为子命令）
		return undefined;
	}

	return undefined;
}

// ── git 子命令选项模式（is_safe_command.rs GitOptionPattern）──

type GitOptionPattern =
	| { kind: "exact"; option: string }
	| { kind: "shortWithInlineValue"; option: string }
	| { kind: "prefix"; prefix: string };

function gitPatternMatches(pattern: GitOptionPattern, arg: string): boolean {
	switch (pattern.kind) {
		case "exact":
			return arg === pattern.option;
		case "shortWithInlineValue":
			return arg.startsWith(pattern.option) && arg.length > pattern.option.length;
		case "prefix":
			return arg.startsWith(pattern.prefix);
	}
}

const UNSAFE_GIT_GLOBAL_OPTIONS: readonly GitOptionPattern[] = [
	{ kind: "exact", option: "-C" },
	{ kind: "shortWithInlineValue", option: "-C" },
	{ kind: "exact", option: "-c" },
	{ kind: "shortWithInlineValue", option: "-c" },
	{ kind: "exact", option: "-p" },
	{ kind: "exact", option: "--config-env" },
	{ kind: "prefix", prefix: "--config-env=" },
	{ kind: "exact", option: "--exec-path" },
	{ kind: "prefix", prefix: "--exec-path=" },
	{ kind: "exact", option: "--git-dir" },
	{ kind: "prefix", prefix: "--git-dir=" },
	{ kind: "exact", option: "--namespace" },
	{ kind: "prefix", prefix: "--namespace=" },
	{ kind: "exact", option: "--paginate" },
	{ kind: "exact", option: "--super-prefix" },
	{ kind: "prefix", prefix: "--super-prefix=" },
	{ kind: "exact", option: "--work-tree" },
	{ kind: "prefix", prefix: "--work-tree=" },
];

const UNSAFE_GIT_SUBCOMMAND_OPTIONS: readonly GitOptionPattern[] = [
	{ kind: "exact", option: "--output" },
	{ kind: "prefix", prefix: "--output=" },
	{ kind: "exact", option: "--ext-diff" },
	{ kind: "exact", option: "--textconv" },
	{ kind: "exact", option: "--exec" },
	{ kind: "prefix", prefix: "--exec=" },
];

function gitMatchesAnyPattern(arg: string, patterns: readonly GitOptionPattern[]): boolean {
	return patterns.some((p) => gitPatternMatches(p, arg));
}

function gitHasUnsafeGlobalOption(globalArgs: string[]): boolean {
	return globalArgs.some((arg) => gitMatchesAnyPattern(arg, UNSAFE_GIT_GLOBAL_OPTIONS));
}

function gitSubcommandArgsAreReadOnly(args: string[]): boolean {
	return !args.some((arg) => gitMatchesAnyPattern(arg, UNSAFE_GIT_SUBCOMMAND_OPTIONS));
}

/** `git branch` 只读 flag 集合。 */
const GIT_BRANCH_READ_ONLY_FLAGS: ReadonlySet<string> = new Set([
	"--list",
	"-l",
	"--show-current",
	"-a",
	"--all",
	"-r",
	"--remotes",
	"-v",
	"-vv",
	"--verbose",
]);

/** `git branch` 仅当参数明确表示只读查询时才安全。 */
function gitBranchIsReadOnly(branchArgs: string[]): boolean {
	if (branchArgs.length === 0) return true; // `git branch` 列分支
	let sawReadOnlyFlag = false;
	for (const arg of branchArgs) {
		if (GIT_BRANCH_READ_ONLY_FLAGS.has(arg) || arg.startsWith("--format=")) {
			sawReadOnlyFlag = true;
		} else {
			// 任何其他 flag 或位置参数可能创建/重命名/删除分支
			return false;
		}
	}
	return sawReadOnlyFlag;
}

const SAFE_GIT_SUBCOMMANDS: readonly string[] = ["status", "log", "diff", "show", "branch"];

function isSafeGitCommand(command: string[]): boolean {
	const found = findGitSubcommand(command, SAFE_GIT_SUBCOMMANDS);
	if (found === undefined) return false;
	const [subcommandIdx, subcommand] = found;

	const globalArgs = command.slice(1, subcommandIdx);
	if (gitHasUnsafeGlobalOption(globalArgs)) return false;

	const subcommandArgs = command.slice(subcommandIdx + 1);

	switch (subcommand) {
		case "status":
		case "log":
		case "diff":
		case "show":
			return gitSubcommandArgsAreReadOnly(subcommandArgs);
		case "branch":
			return (
				gitSubcommandArgsAreReadOnly(subcommandArgs) &&
				gitBranchIsReadOnly(subcommandArgs)
			);
		default:
			return false;
	}
}

// ── sed（仅 `sed -n {N|M,N}p [file]`）──

/** sed `-n {N|M,N}p [file]` 的最大 argv 长度：`sed -n {arg} [file]` = 4。 */
const SED_MAX_ARGV_LENGTH = 4;
/** `M,N` 范围形式按逗号拆分后的段数。 */
const SED_RANGE_PARTS = 2;

/** 匹配 /^(\d+,)?\d+p$/ —— 移植自 is_valid_sed_n_arg。 */
function isValidSedNArg(arg: string | undefined): boolean {
	if (arg === undefined) return false;
	// 必须以 'p' 结尾，剥离之
	if (!arg.endsWith("p")) return false;
	const core = arg.slice(0, -1);
	if (core.length === 0) return false;
	const parts = core.split(",");
	if (parts.length === 1) {
		const [num] = parts;
		return num !== undefined && num.length > 0 && /^\d+$/.test(num);
	}
	if (parts.length === SED_RANGE_PARTS) {
		const [a, b] = parts;
		return (
			a !== undefined &&
			b !== undefined &&
			a.length > 0 &&
			b.length > 0 &&
			/^\d+$/.test(a) &&
			/^\d+$/.test(b)
		);
	}
	return false;
}

function isSafeSed(command: string[]): boolean {
	// command.len() <= SED_MAX_ARGV_LENGTH && command[1]=='-n' && is_valid_sed_n_arg(command[2])
	return (
		command.length <= SED_MAX_ARGV_LENGTH &&
		command[1] === "-n" &&
		isValidSedNArg(command[2])
	);
}

// ── sort ──

const UNSAFE_SORT_OPTIONS: ReadonlySet<string> = new Set(["-o", "--output"]);

function isSafeSort(argv: string[]): boolean {
	return !argv.slice(1).some((arg) => {
		return (
			UNSAFE_SORT_OPTIONS.has(arg) ||
			arg.startsWith("--output=") ||
			// 合并短 flag 簇含 o（-o / -fo / -of / -nfo）
			shortFlagClusterHasChar(arg, "o")
		);
	});
}

// ── iconv ──

const UNSAFE_ICONV_OPTIONS: ReadonlySet<string> = new Set(["-o", "--output"]);

function isSafeIconv(argv: string[]): boolean {
	return !argv.slice(1).some((arg) => {
		return (
			UNSAFE_ICONV_OPTIONS.has(arg) ||
			arg.startsWith("--output=") ||
			// 合并短 flag 簇含 o（-o / -fo / -of）
			shortFlagClusterHasChar(arg, "o")
		);
	});
}

// ── shuf ──

const UNSAFE_SHUF_OPTIONS: ReadonlySet<string> = new Set(["-o", "--output"]);

function isSafeShuf(argv: string[]): boolean {
	return !argv.slice(1).some((arg) => {
		return (
			UNSAFE_SHUF_OPTIONS.has(arg) ||
			arg.startsWith("--output=") ||
			// 合并短 flag 簇含 o（-o / -fo / -of）
			shortFlagClusterHasChar(arg, "o")
		);
	});
}

// ── date ──

const UNSAFE_DATE_OPTIONS: ReadonlySet<string> = new Set(["-s", "--set"]);

function isSafeDate(argv: string[]): boolean {
	return !argv.slice(1).some((arg) => {
		return (
			UNSAFE_DATE_OPTIONS.has(arg) ||
			arg.startsWith("--set=") ||
			// 合并短 flag 簇含 s（-s / -ds / -sd）
			shortFlagClusterHasChar(arg, "s")
		);
	});
}

// ── is_safe_to_call_with_exec（单条 argv 判定）──

function isSafeToCallWithExec(command: string[]): boolean {
	const cmd0 = command[0];
	if (cmd0 === undefined) return false;
	const key = executableNameLookupKey(cmd0);
	if (key === undefined) return false;

	// 无条件 50 安全命令
	if (BUILTIN_UNCONDITIONAL_SAFE.has(key)) return true;

	switch (key) {
		case "base64":
			return isSafeBase64(command);
		case "find":
			return isSafeFind(command);
		case "rg":
			return isSafeRipgrep(command);
		case "git":
			return isSafeGitCommand(command);
		case "sed":
			return isSafeSed(command);
		case "sort":
			return isSafeSort(command);
		case "iconv":
			return isSafeIconv(command);
		case "shuf":
			return isSafeShuf(command);
		case "date":
			return isSafeDate(command);
		default:
			return false;
	}
}

/**
 * 判断 argv 是否命中 Codex 已知安全白名单（50 无条件 + 9 条件）。
 *
 * 对 argv[0]=='zsh' 归一化为 'bash'（与源码一致；但本扩展不实现 bash -lc 复合解析，
 * 故 'bash' 作为 argv[0] 时只走单条 argv 判定，不会被误判为安全——除非 argv[0]
 * 本身就是无条件安全命令，这种情况不存在）。
 *
 * 纯函数：无 side effect，不 spawn 子进程。
 */
export function isKnownSafeCommand(argv: string[]): boolean {
	if (argv.length === 0) return false;

	// argv[0]=='zsh' → 'bash' 归一化（源码行为）
	const normalized: string[] = argv.map((s) => (s === "zsh" ? "bash" : s));

	return isSafeToCallWithExec(normalized);
}

// ──────────────────────── permission-gate 危险规则（12 条）────────────────────────

/**
 * 内置危险规则（permission-gate DEFAULT_RULES，正则字符串 + 'i' flag）。
 *
 * pattern 是 RegExp 源字符串（含 `\b`/`\s` 等），由 matcher.resolvePattern 用
 * `new RegExp(pattern, 'i')` 编译。action='deny'，source='builtin-danger'。
 */
export const BUILTIN_DANGER_RULES: readonly Rule[] = [
	{
		id: "bd-001",
		tool: "bash",
		// 覆盖分离 flag 写法（rm -f -r /）与合并 flag（rm -rf）：
		// `rm` 后任意 token 序列中出现含 `r` 的短 flag 簇（-r/-fr/-rf/-xr...）或 --recursive。
		// 注意：单 `-` 前必须锚定空白（\s-），否则 `.*` 会回溯到长选项 `--verbose` 的
		// 第二个 `-`，把 `-ver` 当成短 flag 簇而误命中。`\s-` 确保只匹配 token 起始的
		// 单连字符短 flag 簇，不会误吃 `--verbose` / `--dir` 等长选项中的 r。
		pattern: "\\brm\\b.*(\\s-(?:[a-zA-Z]*r)|--recursive)",
		action: "deny",
		source: "builtin-danger",
		description: "recursive delete",
	},
	{
		id: "bd-002",
		tool: "bash",
		pattern: "\\bsudo\\b",
		action: "deny",
		source: "builtin-danger",
		description: "sudo",
	},
	{
		id: "bd-003",
		tool: "bash",
		// 覆盖等价写法：777 / a+rwx / ugo+rwx / ugo=rwx（均赋予所有用户写权限）。
		pattern: "\\bchmod\\b.*(777|a\\+rwx|ugo\\+rwx|ugo=rwx)",
		action: "deny",
		source: "builtin-danger",
		description: "world-writable permissions",
	},
	{
		id: "bd-004",
		tool: "bash",
		// 覆盖两类危险设备写入：
		//  1) 重定向 `> /dev/...`：`> /dev/sda`、`> /dev/nvme0n1`、`> /dev/mmcblk0`
		//  2) dd of= 写入：`dd of=/dev/sda`、`dd of=/dev/nvme0n1`
		// 设备名扩展至 [a-z0-9]（支持 nvme0n1 / mmcblk0 等现代命名）。
		pattern: "(>\\s*/dev/(sd|hd|nvme|mmcblk|vd|xvd)[a-z0-9]+|of=/dev/(sd|hd|nvme|mmcblk|vd|xvd)[a-z0-9]+)",
		action: "deny",
		source: "builtin-danger",
		description: "raw device write",
	},
	{
		id: "bd-005",
		tool: "bash",
		pattern: "\\bgit\\s+push\\s+.*(-f\\b|--force\\b)",
		action: "deny",
		source: "builtin-danger",
		description: "force push",
	},
	{
		id: "bd-006",
		tool: "bash",
		pattern: "\\bgit\\s+reset\\s+--hard\\b",
		action: "deny",
		source: "builtin-danger",
		description: "hard reset",
	},
	{
		id: "bd-007",
		tool: "bash",
		// 覆盖分离 flag（git clean -d -f）与合并 flag（git clean -fd）：
		// `git clean` 后任意位置出现含 `f` 的短 flag 簇（-f/-fd/-df）或 --force。
		// 注意：单 `-` 前必须锚定空白（\s-），否则 `.*` 会回溯到长选项 `--files` 的
		// 第二个 `-`，把 `-fil` 当成短 flag 簇而误命中。`\s-` 确保只匹配 token 起始的
		// 单连字符短 flag 簇，不会误吃 `--files` 等长选项中的 f。
		pattern: "\\bgit\\s+clean\\b.*(\\s-(?:[a-zA-Z]*f)|--force)",
		action: "deny",
		source: "builtin-danger",
		description: "git clean --force",
	},
	{
		id: "bd-008",
		tool: "bash",
		// 覆盖 `git checkout .` 与 `git checkout -- .`（均可丢弃工作区所有改动）。
		// 行尾锚定匹配字符串结束或命令分隔符（; & |）。
		pattern: "\\bgit\\s+checkout\\s+(--\\s+)?\\.\\s*($|[;&|])",
		action: "deny",
		source: "builtin-danger",
		description: "git checkout . (discard all)",
	},
	{
		id: "bd-009",
		tool: "bash",
		pattern: "\\bgit\\s+restore\\b",
		action: "deny",
		source: "builtin-danger",
		description: "git restore",
	},
	{
		id: "bd-010",
		tool: "bash",
		pattern: "\\b(curl|wget)\\b.*\\|\\s*(ba)?sh\\b",
		action: "deny",
		source: "builtin-danger",
		description: "pipe to shell",
	},
	{
		id: "bd-011",
		tool: "bash",
		pattern: "\\bgh\\s+repo\\s+(create|delete|rename|archive)\\b",
		action: "deny",
		source: "builtin-danger",
		description: "modify GitHub repo",
	},
	{
		id: "bd-012",
		tool: "bash",
		pattern: "\\bgh\\s+release\\s+(create|delete|edit)\\b",
		action: "deny",
		source: "builtin-danger",
		description: "modify GitHub release",
	},
];

/**
 * 返回默认规则（builtin-danger 12 条）。
 *
 * 深拷贝：每条 Rule 对象都复制（`{ ...r }`），防外部修改返回值后污染共享常量
 * BUILTIN_DANGER_RULES（m6：浅拷贝只复制数组，元素仍共享，caller 改 rule.action
 * /rule.pattern 会污染内置常量，影响后续所有调用）。
 */
export function getDefaultRules(): Rule[] {
	return BUILTIN_DANGER_RULES.map((r) => ({ ...r }));
}

/** 重新导出 CONDITIONAL_SAFE_COMMANDS 仅供测试断言白名单覆盖完整。 */
export const _CONDITIONAL_SAFE_COMMANDS_FOR_TEST = CONDITIONAL_SAFE_COMMANDS;
