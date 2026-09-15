/**
 * WC1-WC8: wildcardToRegExp 单元测试。
 *
 * 验证 OpenCode 风格 wildcard 语义：
 *  - `*` 跨任意字符（含空格）
 *  - `?` 单字符
 *  - 末尾 ` *` 匹配无参（`ls *` 也匹配 `ls`）
 *  - 元字符转义（`.` `+` `$` 等被字面匹配）
 *  - 全锚定（`^...$`）
 *
 * 注意：win32 平台会加 'i' flag（大小写不敏感），非 win32 大小写敏感。
 * 测试用例在 macOS/linux 跑（大小写敏感），不依赖平台 flag 差异。
 */
import { describe, expect, it } from "vitest";

import { wildcardToRegExp } from "../wildcard.js";

describe("WC: wildcardToRegExp", () => {
	it("WC1: `*` 匹配任意（含空格）", () => {
		const re = wildcardToRegExp("git *");
		expect(re.test("git commit -m msg")).toBe(true);
		// 注意：末尾 ` *` 会被改写为 `( .*)?`，所以 `git *` 也匹配无参 `git`（见 WC3）
		expect(re.test("git")).toBe(true);
		expect(re.test("gitsomething")).toBe(false); // 全锚定
		expect(re.test("hg push")).toBe(false); // 不以 git 开头
	});

	it("WC2: `?` 匹配单字符", () => {
		const re = wildcardToRegExp("git checkout ?");
		expect(re.test("git checkout a")).toBe(true);
		expect(re.test("git checkout ab")).toBe(false); // ? 只匹配 1 个
	});

	it("WC3: 末尾 ` *` 匹配无参（`ls *` 也匹配 `ls`）", () => {
		const re = wildcardToRegExp("ls *");
		expect(re.test("ls")).toBe(true); // 关键：无参也匹配
		expect(re.test("ls -la")).toBe(true);
		expect(re.test("ls /tmp")).toBe(true);
	});

	it("WC4: 空字符串 pattern", () => {
		const re = wildcardToRegExp("");
		expect(re.test("")).toBe(true);
		expect(re.test("x")).toBe(false);
	});

	it("WC5: 特殊字符转义（`.` `+` `$` 被字面匹配）", () => {
		// `.` 应被转义为字面点
		const re = wildcardToRegExp("file.txt");
		expect(re.test("file.txt")).toBe(true);
		expect(re.test("fileXtxt")).toBe(false); // 点不是通配

		// `+` 应被转义
		const re2 = wildcardToRegExp("a+b");
		expect(re2.test("a+b")).toBe(true);
		expect(re2.test("aaab")).toBe(false); // + 不是量词
	});

	it("WC6: 大小写敏感（非 win32）", () => {
		const re = wildcardToRegExp("ls");
		// 非 win32 不加 'i' flag
		if (process.platform !== "win32") {
			expect(re.test("ls")).toBe(true);
			expect(re.test("LS")).toBe(false);
			expect(re.test("Ls")).toBe(false);
		} else {
			expect(re.test("LS")).toBe(true); // win32 大小写不敏感
		}
	});

	it("WC7: 复合 `git *` 匹配多参数命令", () => {
		const re = wildcardToRegExp("git *");
		expect(re.test("git push origin main")).toBe(true);
		expect(re.test("git commit -m 'hello world'")).toBe(true); // 含空格
		expect(re.test("hg push")).toBe(false); // 不以 git 开头
	});

	it("WC8: 边界——纯字面无通配", () => {
		const re = wildcardToRegExp("pwd");
		expect(re.test("pwd")).toBe(true);
		expect(re.test("pwdx")).toBe(false);
		expect(re.test(" pwd")).toBe(false);
	});
});
