/**
 * BT 系列：builtins.ts 单元测试。
 *
 * 三组：
 *  - BT-safe-*：Codex 50 无条件 + 9 条件安全命令（isKnownSafeCommand）
 *  - BT-danger-*：permission-gate 12 危险规则（BUILTIN_DANGER_RULES）
 *  - BT-misc：getDefaultRules / findGitSubcommand
 *
 * 移植自 Codex is_safe_command.rs 的 #[test] 用例（known_safe_examples /
 * git_branch_mutating_flags_are_not_safe / git_output_flags_are_not_safe /
 * base64_output_options_are_unsafe / ripgrep_rules / unknown_or_partial 等），
 * 确保白名单行为与源码一致。
 */
import { describe, expect, it } from "vitest";

import {
	BUILTIN_DANGER_RULES,
	BUILTIN_UNCONDITIONAL_SAFE,
	findGitSubcommand,
	getDefaultRules,
	isKnownSafeCommand,
} from "../builtins.js";
import { matchRulesForArgv } from "../matcher.js";

// ──────────────────────── BT-safe: Codex 白名单 ────────────────────────

describe("BT-safe-50: 无条件安全命令（24 Codex + 26 扩充）", () => {
	// 与 is_safe_command.rs `is_safe_to_call_with_exec` 的 match 分支一致
	const cases: string[][] = [
		["cat", "file"],
		["cd", "/tmp"],
		["cut", "-f1"],
		["echo", "hi"],
		["expr", "1+1"],
		["false"],
		["grep", "foo"],
		["head", "file"],
		["id"],
		["ls", "-la"],
		["nl", "-nrz", "Cargo.toml"],
		["paste", "a", "b"],
		["pwd"],
		["rev", "file"],
		["seq", "1", "10"],
		["stat", "file"],
		["tail", "file"],
		["tr", "a", "b"],
		["true"],
		["uname"],
		["uniq", "file"],
		["wc", "file"],
		["which", "node"],
		["whoami"],
		// ── 本扩展扩充（26 条，字母序）──
		["arch"],
		["basename", "/tmp/file.txt"],
		["cksum", "file"],
		["cmp", "a", "b"],
		["column", "-t"],
		["comm", "a", "b"],
		["diff", "a", "b"],
		["dirname", "/tmp/file.txt"],
		["du", "-sh", "."],
		["df", "-h"],
		["expand", "file"],
		["file", "file.txt"],
		["fold", "-w", "80", "file"],
		["groups"],
		["jq", ".", "file.json"],
		["md5sum", "file"],
		["printenv", "PATH"],
		["ps", "aux"],
		["readlink", "link"],
		["realpath", "file"],
		["sha256sum", "file"],
		["shasum", "file"],
		["tsort", "file"],
		["uptime"],
		["whereis", "node"],
		["who"],
	];

	for (const argv of cases) {
		it(`BT-safe-50: ${argv.join(" ")} → safe`, () => {
			expect(isKnownSafeCommand(argv)).toBe(true);
		});
	}

	it("BT-safe-50: 白名单恰好 50 个命令", () => {
		expect(BUILTIN_UNCONDITIONAL_SAFE.size).toBe(50);
	});
});

describe("BT-safe-base64: base64 flag 子检查", () => {
	it("base64 无 -o → safe", () => {
		expect(isKnownSafeCommand(["base64"])).toBe(true);
		expect(isKnownSafeCommand(["base64", "-d"])).toBe(true);
		expect(isKnownSafeCommand(["base64", "input.txt"])).toBe(true);
	});

	it("base64 -o → unsafe（移植 base64_output_options_are_unsafe）", () => {
		expect(isKnownSafeCommand(["base64", "-o", "out.bin"])).toBe(false);
		expect(isKnownSafeCommand(["base64", "--output", "out.bin"])).toBe(false);
		expect(isKnownSafeCommand(["base64", "--output=out.bin"])).toBe(false);
		expect(isKnownSafeCommand(["base64", "-ob64.txt"])).toBe(false); // 合并 flag
	});

	it("base64 -do（合并 -d -o）→ unsafe（G4: 合并 flag 非首位）", () => {
		expect(isKnownSafeCommand(["base64", "-do", "out.bin"])).toBe(false);
		expect(isKnownSafeCommand(["base64", "-fo"])).toBe(false);
	});
});

describe("BT-safe-find: find flag 子检查", () => {
	it("find 无危险选项 → safe", () => {
		expect(isKnownSafeCommand(["find", ".", "-name", "file.txt"])).toBe(true);
	});

	it("find -exec/-delete/-fls 等 → unsafe（移植 unknown_or_partial）", () => {
		expect(
			isKnownSafeCommand(["find", ".", "-name", "file.txt", "-exec", "rm", "{}", ";"]),
		).toBe(false);
		expect(isKnownSafeCommand(["find", ".", "-delete", "-name", "file.txt"])).toBe(false);
		expect(isKnownSafeCommand(["find", ".", "-fls", "/etc/passwd"])).toBe(false);
		expect(isKnownSafeCommand(["find", ".", "-fprint", "/etc/passwd"])).toBe(false);
		expect(isKnownSafeCommand(["find", ".", "-fprint0", "/etc/passwd"])).toBe(false);
		expect(isKnownSafeCommand(["find", ".", "-fprintf", "/root/suid.txt", "%#m %u %p\n"])).toBe(false);
	});
});

describe("BT-safe-rg: ripgrep flag 子检查（移植 ripgrep_rules）", () => {
	it("rg 无危险 flag → safe", () => {
		expect(isKnownSafeCommand(["rg", "Cargo.toml", "-n"])).toBe(true);
		expect(isKnownSafeCommand(["rg", "pattern"])).toBe(true);
	});

	it("rg --search-zip / -z → unsafe", () => {
		expect(isKnownSafeCommand(["rg", "--search-zip", "files"])).toBe(false);
		expect(isKnownSafeCommand(["rg", "-z", "files"])).toBe(false);
	});

	it("rg --pre / --hostname-bin（split 与 = 两种形式）→ unsafe", () => {
		expect(isKnownSafeCommand(["rg", "--pre", "pwned", "files"])).toBe(false);
		expect(isKnownSafeCommand(["rg", "--pre=pwned", "files"])).toBe(false);
		expect(isKnownSafeCommand(["rg", "--hostname-bin", "pwned", "files"])).toBe(false);
		expect(isKnownSafeCommand(["rg", "--hostname-bin=pwned", "files"])).toBe(false);
	});
});

describe("BT-safe-git: git 子命令 + 全局选项检查", () => {
	it("git status/log/diff/show → safe（移植 known_safe_examples）", () => {
		expect(isKnownSafeCommand(["git", "status"])).toBe(true);
		expect(isKnownSafeCommand(["git", "log", "-p", "-1"])).toBe(true);
		expect(isKnownSafeCommand(["git", "diff", "-p"])).toBe(true);
		expect(isKnownSafeCommand(["git", "show", "-p", "HEAD"])).toBe(true);
		expect(isKnownSafeCommand(["git", "log", "--oneline"])).toBe(true);
	});

	it("git push/fetch 等非白名单子命令 → unsafe", () => {
		expect(isKnownSafeCommand(["git", "push"])).toBe(false);
		expect(isKnownSafeCommand(["git", "fetch"])).toBe(false);
		expect(isKnownSafeCommand(["git", "checkout", "status"])).toBe(false); // 第一个位置参数是子命令
	});

	it("git branch 只读 → safe", () => {
		expect(isKnownSafeCommand(["git", "branch"])).toBe(true);
		expect(isKnownSafeCommand(["git", "branch", "--show-current"])).toBe(true);
	});

	it("git branch 变更 flag → unsafe（移植 git_branch_mutating_flags_are_not_safe）", () => {
		expect(isKnownSafeCommand(["git", "branch", "-d", "feature"])).toBe(false);
		expect(isKnownSafeCommand(["git", "branch", "new-branch"])).toBe(false); // 位置参数 = 创建分支
	});

	it("git 全局选项 -C/-c/--paginate → unsafe（移植 git_global_override_flags_are_not_safe）", () => {
		expect(isKnownSafeCommand(["git", "-C", ".", "status"])).toBe(false);
		expect(isKnownSafeCommand(["git", "-C.", "status"])).toBe(false);
		expect(isKnownSafeCommand(["git", "-c", "core.pager=cat", "log", "-n", "1"])).toBe(false);
		expect(isKnownSafeCommand(["git", "-ccore.pager=cat", "status"])).toBe(false);
		expect(isKnownSafeCommand(["git", "--paginate", "log", "-1"])).toBe(false);
		expect(isKnownSafeCommand(["git", "-p", "log", "-1"])).toBe(false);
	});

	it("git 子命令危险输出选项 --output/--ext-diff → unsafe（移植 git_output_flags_are_not_safe）", () => {
		expect(isKnownSafeCommand(["git", "log", "--output=/tmp/out", "-n", "1"])).toBe(false);
		expect(isKnownSafeCommand(["git", "diff", "--output", "/tmp/out"])).toBe(false);
		expect(isKnownSafeCommand(["git", "show", "--output=/tmp/out", "HEAD"])).toBe(false);
	});
});

describe("BT-safe-sed: sed -n {N|M,N}p", () => {
	it("sed -n 1p / sed -n 1,5p → safe（移植 bash_lc_safe_examples）", () => {
		expect(isKnownSafeCommand(["sed", "-n", "1p", "file.txt"])).toBe(true);
		expect(isKnownSafeCommand(["sed", "-n", "1,5p", "file.txt"])).toBe(true);
		expect(isKnownSafeCommand(["sed", "-n", "10p"])).toBe(true);
	});

	it("sed -i / sed s/a/b/ / sed -n xp → unsafe", () => {
		expect(isKnownSafeCommand(["sed", "-i", "s/a/b/"])).toBe(false);
		expect(isKnownSafeCommand(["sed", "s/a/b/"])).toBe(false);
		expect(isKnownSafeCommand(["sed", "-n", "xp", "file.txt"])).toBe(false); // xp 非数字
	});

	it("sed argv > 4 → unsafe", () => {
		// sed -n 1p a b c d（5 参数）超长
		expect(isKnownSafeCommand(["sed", "-n", "1p", "a", "b", "c", "d"])).toBe(false);
	});
});

describe("BT-safe-sort: sort flag 子检查", () => {
	it("sort 无 -o → safe", () => {
		expect(isKnownSafeCommand(["sort", "file.txt"])).toBe(true);
		expect(isKnownSafeCommand(["sort", "-n", "-r"])).toBe(true);
	});
	it("sort -o → unsafe", () => {
		expect(isKnownSafeCommand(["sort", "-o", "out.txt", "in.txt"])).toBe(false);
		expect(isKnownSafeCommand(["sort", "--output", "out.txt"])).toBe(false);
		expect(isKnownSafeCommand(["sort", "--output=out.txt"])).toBe(false);
		expect(isKnownSafeCommand(["sort", "-oout.txt"])).toBe(false);
	});
	it("sort -fo（合并 -f -o）→ unsafe", () => {
		expect(isKnownSafeCommand(["sort", "-fo", "out.txt"])).toBe(false);
		expect(isKnownSafeCommand(["sort", "-nfo", "out.txt"])).toBe(false); // -n -f -o
	});
});

describe("BT-safe-iconv: iconv flag 子检查", () => {
	it("iconv 无 -o → safe", () => {
		expect(isKnownSafeCommand(["iconv", "-f", "UTF-8", "-t", "GBK"])).toBe(true);
	});
	it("iconv -o → unsafe", () => {
		expect(isKnownSafeCommand(["iconv", "-o", "out.txt"])).toBe(false);
		expect(isKnownSafeCommand(["iconv", "--output", "out.txt"])).toBe(false);
	});
	it("iconv -fo（合并）→ unsafe", () => {
		expect(isKnownSafeCommand(["iconv", "-fo", "out.txt"])).toBe(false);
	});
	it("iconv --output= → unsafe", () => {
		expect(isKnownSafeCommand(["iconv", "--output=out.txt"])).toBe(false);
	});
	it("iconv -oout（合并首字符）→ unsafe", () => {
		expect(isKnownSafeCommand(["iconv", "-oout.txt"])).toBe(false);
	});
});

describe("BT-safe-shuf: shuf flag 子检查", () => {
	it("shuf 无 -o → safe", () => {
		expect(isKnownSafeCommand(["shuf", "-i", "1-10"])).toBe(true);
	});
	it("shuf -o → unsafe", () => {
		expect(isKnownSafeCommand(["shuf", "-o", "out.txt"])).toBe(false);
		expect(isKnownSafeCommand(["shuf", "--output=out.txt"])).toBe(false);
	});
	it("shuf -fo（合并）→ unsafe", () => {
		expect(isKnownSafeCommand(["shuf", "-fo", "out.txt"])).toBe(false);
	});
	it("shuf --output（空格形式）→ unsafe", () => {
		expect(isKnownSafeCommand(["shuf", "--output", "out.txt"])).toBe(false);
	});
});

describe("BT-safe-date: date flag 子检查", () => {
	it("date 无 -s → safe", () => {
		expect(isKnownSafeCommand(["date"])).toBe(true);
		expect(isKnownSafeCommand(["date", "+%Y-%m-%d"])).toBe(true);
	});
	it("date -s → unsafe（设置系统时间）", () => {
		expect(isKnownSafeCommand(["date", "-s", "2025-01-01"])).toBe(false);
		expect(isKnownSafeCommand(["date", "--set", "2025-01-01"])).toBe(false);
		expect(isKnownSafeCommand(["date", "--set=2025-01-01"])).toBe(false);
	});
	it("date -ds（合并 -d -s）→ unsafe", () => {
		expect(isKnownSafeCommand(["date", "-ds", "2025-01-01"])).toBe(false);
	});
});

describe("BT-safe-misc: 边界", () => {
	it("空 argv → false", () => {
		expect(isKnownSafeCommand([])).toBe(false);
	});

	it("未知命令 → false（移植 unknown_or_partial）", () => {
		expect(isKnownSafeCommand(["foo"])).toBe(false);
		expect(isKnownSafeCommand(["cargo", "check"])).toBe(false); // cargo 不在白名单
	});

	it("zsh 归一化为 bash（源码行为）", () => {
		// zsh -lc "ls" 在源码里 zsh→bash，但本扩展不实现 bash -lc 解析
		// bash 作为 argv[0] 不在白名单 → false（与 unknown 命令一致）
		expect(isKnownSafeCommand(["zsh", "-lc", "ls"])).toBe(false);
		expect(isKnownSafeCommand(["bash", "-lc", "ls"])).toBe(false);
	});

	it("带路径前缀的命令名（basename lookup）", () => {
		// executableNameLookupKey 取 basename
		expect(isKnownSafeCommand(["/usr/bin/ls"])).toBe(true);
		expect(isKnownSafeCommand(["/usr/bin/git", "status"])).toBe(true);
	});
});

// ──────────────────────── BT-danger: permission-gate 12 危险规则 ────────────────────────

describe("BT-danger: BUILTIN_DANGER_RULES 12 条", () => {
	it("BT-danger-001: recursive delete — rm -rf", () => {
		const re = new RegExp(BUILTIN_DANGER_RULES[0].pattern, "i");
		expect(re.test("rm -rf /")).toBe(true);
		expect(re.test("rm --recursive foo")).toBe(true);
		expect(re.test("rm foo")).toBe(false);
	});

	it("BT-danger-002: sudo", () => {
		const re = new RegExp(BUILTIN_DANGER_RULES[1].pattern, "i");
		expect(re.test("sudo rm /etc/passwd")).toBe(true);
		expect(re.test("ls")).toBe(false);
	});

	it("BT-danger-003: world-writable — chmod 777", () => {
		const re = new RegExp(BUILTIN_DANGER_RULES[2].pattern, "i");
		expect(re.test("chmod 777 file")).toBe(true);
		expect(re.test("chmod 755 file")).toBe(false);
	});

	it("BT-danger-004: raw device — > /dev/sda", () => {
		const re = new RegExp(BUILTIN_DANGER_RULES[3].pattern, "i");
		expect(re.test("dd if=img > /dev/sda")).toBe(true);
		expect(re.test("echo hi")).toBe(false);
	});

	it("BT-danger-005: force push — git push --force", () => {
		const re = new RegExp(BUILTIN_DANGER_RULES[4].pattern, "i");
		expect(re.test("git push origin main --force")).toBe(true);
		expect(re.test("git push -f origin main")).toBe(true);
		expect(re.test("git push origin main")).toBe(false);
	});

	it("BT-danger-006: hard reset — git reset --hard", () => {
		const re = new RegExp(BUILTIN_DANGER_RULES[5].pattern, "i");
		expect(re.test("git reset --hard HEAD~1")).toBe(true);
		expect(re.test("git reset HEAD")).toBe(false);
	});

	it("BT-danger-007: git clean -fd", () => {
		const re = new RegExp(BUILTIN_DANGER_RULES[6].pattern, "i");
		expect(re.test("git clean -fd")).toBe(true);
		expect(re.test("git clean -n")).toBe(false); // dry-run 不含 f
	});

	it("BT-danger-008: git checkout .（discard all）", () => {
		const re = new RegExp(BUILTIN_DANGER_RULES[7].pattern, "i");
		expect(re.test("git checkout .")).toBe(true);
		expect(re.test("git checkout . ;")).toBe(true);
		expect(re.test("git checkout branch")).toBe(false);
	});

	it("BT-danger-009: git restore", () => {
		const re = new RegExp(BUILTIN_DANGER_RULES[8].pattern, "i");
		expect(re.test("git restore file")).toBe(true);
		expect(re.test("git status")).toBe(false);
	});

	it("BT-danger-010: pipe to shell — curl | sh", () => {
		const re = new RegExp(BUILTIN_DANGER_RULES[9].pattern, "i");
		expect(re.test("curl http://x | sh")).toBe(true);
		expect(re.test("wget http://x | bash")).toBe(true);
		expect(re.test("curl http://x -o file")).toBe(false);
	});

	it("BT-danger-011: gh repo create/delete/rename/archive", () => {
		const re = new RegExp(BUILTIN_DANGER_RULES[10].pattern, "i");
		expect(re.test("gh repo delete owner/name")).toBe(true);
		expect(re.test("gh repo create name")).toBe(true);
		expect(re.test("gh repo view owner/name")).toBe(false);
	});

	it("BT-danger-012: gh release create/delete/edit", () => {
		const re = new RegExp(BUILTIN_DANGER_RULES[11].pattern, "i");
		expect(re.test("gh release create v1")).toBe(true);
		expect(re.test("gh release delete v1")).toBe(true);
		expect(re.test("gh release view v1")).toBe(false);
	});

	it("BT-danger-meta: 恰好 12 条，全部 action='deny' source='builtin-danger'", () => {
		expect(BUILTIN_DANGER_RULES.length).toBe(12);
		for (const r of BUILTIN_DANGER_RULES) {
			expect(r.action).toBe("deny");
			expect(r.source).toBe("builtin-danger");
			expect(r.tool).toBe("bash");
		}
	});
});

// ──────────────────────── C2: 分离 flag 写法的正则覆盖（防绕过）────────────────────────

describe("C2: 危险正则覆盖分离 flag 写法（bd-001/003/007/008）", () => {
	// helper：取某 id 规则的 pattern 编译为 RegExp
	const patternFor = (id: string): RegExp => {
		const rule = BUILTIN_DANGER_RULES.find((r) => r.id === id);
		if (!rule) throw new Error(`rule ${id} not found`);
		return new RegExp(rule.pattern, "i");
	};

	it("bd-001: rm 分离 flag `rm -f -r /` 也命中（原来只匹配合并 -rf）", () => {
		const re = patternFor("bd-001");
		// 合并 flag（原有覆盖）
		expect(re.test("rm -rf /")).toBe(true);
		expect(re.test("rm -fr /")).toBe(true);
		// 分离 flag（C2 新覆盖）
		expect(re.test("rm -f -r /")).toBe(true);
		expect(re.test("rm -f -r -f /tmp/x")).toBe(true);
		// 长选项
		expect(re.test("rm --recursive foo")).toBe(true);
		// 非 recursive 不命中
		expect(re.test("rm -f /")).toBe(false);
		expect(re.test("rm foo")).toBe(false);
	});

	it("bd-003: chmod 等价写法 a+rwx / ugo+rwx 也命中（原来只匹配 777）", () => {
		const re = patternFor("bd-003");
		// 777（原有覆盖）
		expect(re.test("chmod 777 file")).toBe(true);
		// 等价符号写法（C2 新覆盖）
		expect(re.test("chmod a+rwx file")).toBe(true);
		expect(re.test("chmod ugo+rwx file")).toBe(true);
		expect(re.test("chmod ugo=rwx file")).toBe(true);
		// 非危险权限不命中
		expect(re.test("chmod 755 file")).toBe(false);
		expect(re.test("chmod a+r file")).toBe(false);
	});

	it("bd-007: git clean 分离 flag `git clean -d -f` 也命中（原来只匹配合并 -fd）", () => {
		const re = patternFor("bd-007");
		// 合并 flag（原有覆盖）
		expect(re.test("git clean -fd")).toBe(true);
		expect(re.test("git clean -df")).toBe(true);
		// 分离 flag（C2 新覆盖）
		expect(re.test("git clean -d -f")).toBe(true);
		expect(re.test("git clean -x -f")).toBe(true);
		// --force
		expect(re.test("git clean --force")).toBe(true);
		// dry-run（无 f）不命中
		expect(re.test("git clean -n")).toBe(false);
		expect(re.test("git clean -d")).toBe(false);
	});

	it("bd-001: 长选项 --verbose 不误报（只匹配短 flag 簇的 r）", () => {
		const re = patternFor("bd-001");
		// 短 flag（原有覆盖）
		expect(re.test("rm -rf /")).toBe(true);
		expect(re.test("rm -fr /")).toBe(true);
		expect(re.test("rm -f -r /")).toBe(true);
		// 长选项含 r 但非 recursive → 不应命中
		expect(re.test("rm --verbose file")).toBe(false);
		expect(re.test("rm --dir foo")).toBe(false);
		// --recursive 命中
		expect(re.test("rm --recursive x")).toBe(true);
		// 短 flag 簇中 r 在任意位置
		expect(re.test("rm -xr /tmp")).toBe(true);
	});

	it("bd-007: 长选项 --files 不误报", () => {
		const re = patternFor("bd-007");
		expect(re.test("git clean -fd")).toBe(true);
		expect(re.test("git clean --force")).toBe(true);
		// 长选项含 f 但非 force → 不应命中
		expect(re.test("git clean --files foo")).toBe(false);
	});

	it("bd-008: git checkout -- . 也命中（原来只匹配 `git checkout .`）", () => {
		const re = patternFor("bd-008");
		// 无 -- （原有覆盖）
		expect(re.test("git checkout .")).toBe(true);
		expect(re.test("git checkout . ;")).toBe(true);
		// 带 -- （C2 新覆盖）
		expect(re.test("git checkout -- .")).toBe(true);
		expect(re.test("git checkout -- . &&")).toBe(true);
		// 普通分支切换不命中
		expect(re.test("git checkout branch")).toBe(false);
		expect(re.test("git checkout -- file.txt")).toBe(false);
	});
});

// ──────────────────────── m8: bd-004 设备重定向规则扩展 ────────────────────────

describe("m8: bd-004 覆盖 dd of=/dev/... 与现代设备名（nvme/mmcblk）", () => {
	const re = new RegExp(
		BUILTIN_DANGER_RULES.find((r) => r.id === "bd-004")!.pattern,
		"i",
	);

	it("重定向 > /dev/sda（原有覆盖）", () => {
		expect(re.test("dd if=img > /dev/sda")).toBe(true);
	});

	it("dd of=/dev/sda（C2/m8 新覆盖）", () => {
		expect(re.test("dd if=img of=/dev/sda")).toBe(true);
		expect(re.test("dd of=/dev/sdb bs=4M")).toBe(true);
	});

	it("现代设备名 nvme0n1 / mmcblk0（m8 新覆盖）", () => {
		expect(re.test("dd of=/dev/nvme0n1")).toBe(true);
		expect(re.test("dd if=img > /dev/nvme0n1p2")).toBe(true);
		expect(re.test("dd of=/dev/mmcblk0")).toBe(true);
	});

	it("非设备写入不误报", () => {
		expect(re.test("echo hi")).toBe(false);
		expect(re.test("cat file > /tmp/out")).toBe(false);
		expect(re.test("echo data > out.txt")).toBe(false);
	});
});

// ──────────────────────── C2 端到端：matchRulesForArgv 真实链路 ────────────────────────

describe("C2-e2e: matchRulesForArgv 对分离 flag 写法返回 deny", () => {
	// builtins.test 直接测内置规则正则；此处补真实匹配链路（matchRulesForArgv）
	const rules = getDefaultRules();

	it("rm -f -r / → deny（bd-001）", () => {
		const r = matchRulesForArgv(["rm", "-f", "-r", "/"], rules);
		expect(r.action).toBe("deny");
		expect(r.matchedRule?.id).toBe("bd-001");
	});

	it("chmod a+rwx file → deny（bd-003）", () => {
		const r = matchRulesForArgv(["chmod", "a+rwx", "file"], rules);
		expect(r.action).toBe("deny");
		expect(r.matchedRule?.id).toBe("bd-003");
	});

	it("git clean -d -f → deny（bd-007）", () => {
		const r = matchRulesForArgv(["git", "clean", "-d", "-f"], rules);
		expect(r.action).toBe("deny");
		expect(r.matchedRule?.id).toBe("bd-007");
	});

	it("git checkout -- . → deny（bd-008）", () => {
		// argv 级：["git","checkout","--","."] join 后 "git checkout -- ."
		const r = matchRulesForArgv(["git", "checkout", "--", "."], rules);
		expect(r.action).toBe("deny");
		expect(r.matchedRule?.id).toBe("bd-008");
	});
});

// ──────────────────────── BT-misc: getDefaultRules / findGitSubcommand ────────────────────────

describe("BT-misc: getDefaultRules", () => {
	it("返回 12 条 builtin-danger 规则（深拷贝：新数组 + 新元素对象）", () => {
		const rules = getDefaultRules();
		expect(rules.length).toBe(12);
		// m6：深拷贝——新数组，元素也是新对象（不共享内置常量引用）
		expect(rules).not.toBe(BUILTIN_DANGER_RULES);
		expect(rules[0]).not.toBe(BUILTIN_DANGER_RULES[0]);
		// 但内容（值）相等
		expect(rules[0]).toEqual(BUILTIN_DANGER_RULES[0]);
	});

	it("深拷贝防外部修改——push 不影响内置常量", () => {
		const rules = getDefaultRules();
		const originalLen = BUILTIN_DANGER_RULES.length;
		rules.push({
			id: "x",
			tool: "bash",
			pattern: "x",
			action: "allow",
			source: "user",
		});
		expect(BUILTIN_DANGER_RULES.length).toBe(originalLen);
	});

	it("m6：深拷贝防元素属性污染——改 rule.action 不影响内置常量", () => {
		// 浅拷贝的缺陷：元素共享引用，改 action 会污染 BUILTIN_DANGER_RULES。
		// 深拷贝后：修改返回值元素的属性不影响内置常量。
		const rules = getDefaultRules();
		const originalAction = BUILTIN_DANGER_RULES[0]!.action;
		// 篡改返回值的第 0 条规则
		rules[0]!.action = "allow";
		rules[0]!.pattern = "tampered";
		// 内置常量未被污染
		expect(BUILTIN_DANGER_RULES[0]!.action).toBe(originalAction);
		expect(BUILTIN_DANGER_RULES[0]!.pattern).not.toBe("tampered");
	});
});

describe("BT-misc: findGitSubcommand", () => {
	it("直接子命令", () => {
		expect(findGitSubcommand(["git", "status"], ["status", "log"])).toEqual([1, "status"]);
	});

	it("跳过 -C path（取值 global option）", () => {
		// -C . status：-C 的下一个参数 . 被 skip，找到 status
		expect(findGitSubcommand(["git", "-C", ".", "status"], ["status"])).toEqual([3, "status"]);
	});

	it("跳过 -Cpath（内联值 global option）", () => {
		expect(findGitSubcommand(["git", "-C.", "status"], ["status"])).toEqual([2, "status"]);
	});

	it("跳过 --git-dir=path（prefix 内联）", () => {
		expect(findGitSubcommand(["git", "--git-dir=.evil", "diff"], ["diff"])).toEqual([2, "diff"]);
	});

	it("非 git 命令 → undefined", () => {
		expect(findGitSubcommand(["hg", "status"], ["status"])).toBeUndefined();
	});

	it("第一个非选项参数不在目标列表 → undefined（不误判后续位置参数）", () => {
		// git checkout status：checkout 不在 [status]，返回 undefined
		expect(findGitSubcommand(["git", "checkout", "status"], ["status"])).toBeUndefined();
	});

	it("无匹配子命令 → undefined", () => {
		expect(findGitSubcommand(["git", "push"], ["status", "log"])).toBeUndefined();
	});
});
