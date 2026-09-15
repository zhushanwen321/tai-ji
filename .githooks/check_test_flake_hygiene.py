#!/usr/bin/env python3
"""
测试 flake 卫生检查：两类「测试自身引入的满载 flake」的静态拦截。

段 1（F5，每次调用都跑，成本 ~0）：
  根 package.json scripts.test 必须含 --no-bail。
  [HISTORICAL] pnpm 递归 test 缺 --no-bail 时，任一包 first-fail 即中止尾部包执行，
  一次满载 flake 只暴露首个失败包，掩盖失败全貌、拖慢归因（教训 commit b7ec0298a）。

段 2（F3，按 staged/指定文件触发）：
  测试文件内 recursive 删除必须在同一次调用中带 maxRetries。
  [HISTORICAL] teardown 的递归删除与在途异步写竞争，满载下 ENOTEMPTY 满载 flake；
  Node 的 rm/rmSync 默认 maxRetries=0，一次瞬态失败即抛（教训 commit d9ad39cb8）。
  只管 recursive 删除：单文件 unlink 无目录枚举竞争面，不拦（误报收益比差）。
  白名单机制：无——仓库规则是检出即修，不留逃生口。

测试文件判定（排除 node_modules）：路径含 /test/ 或 /__tests__/，或文件名以
.test.ts / .test.mjs / .spec.ts 结尾。

扫描形态：rmSync( / fs.rmSync( / fs.promises.rm( / fs/promises 解构后的裸 rm(。
多行调用按括号配平合并；扫描前先把注释与字符串字面量遮蔽（长度不变），防止
注释/字符串里的示例代码与括号干扰配平与判定。

已知局限（零依赖静态扫描的边界，均朝漏报方向可接受）：
  - options 经变量间接传入（如 rmSync(dir, opts)）不判——规则针对字面量形态；
  - TS 正则字面量未遮蔽，其中不平衡括号可能使配平提前截断。

用法：
  python3 .githooks/check_test_flake_hygiene.py            # 段 1 + 段 2（段 2 读 git diff --cached，仓库相对路径）
  python3 .githooks/check_test_flake_hygiene.py <file...>  # 段 1 + 段 2（段 2 扫指定文件，相对调用者 cwd 解析）

退出码：0 通过 / 2 违规
"""

import json
import re
import subprocess
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent

TEST_SUFFIXES = (".test.ts", ".test.mjs", ".spec.ts")

# 调用头。(?<![\w.$]) 保证整体名首字符是词边界：trim( / confirm( / obj.rm( 不误中；
# fs.rmSync( / fs.promises.rm( / 裸 rmSync( / rm(（fs/promises 解构形态）全覆盖。
CALL_HEAD_RE = re.compile(r"(?<![\w.$])(?:fs\.promises\.|fs\.)?(?:rmSync|rm)\s*\(")
RECURSIVE_TRUE_RE = re.compile(r"\brecursive\s*:\s*true\b")
MAX_RETRIES_RE = re.compile(r"\bmaxRetries\b")

# 单个调用配平扫描的行数上限（防不配平输入退化），正常 teardown 调用远小于此
CALL_SCAN_LIMIT_LINES = 200

# 摘录展示的最大字符数
EXCERPT_MAX_CHARS = 200


def mask_lines(lines: list[str]) -> list[str]:
    """把注释与字符串字面量的内容替换为空格（长度与行号不变）。

    返回值与输入逐行对齐：括号配平与规则判定都在遮蔽文本上做，摘录展示用原文。
    """
    out = []
    state = "code"  # code | line_comment | block_comment | squote | dquote | template
    for line in lines:
        masked = []
        i = 0
        n = len(line)
        while i < n:
            ch = line[i]
            nxt = line[i + 1] if i + 1 < n else ""
            if state == "code":
                if ch == "/" and nxt == "/":
                    state = "line_comment"
                    masked.append("  ")
                    i += 2
                    continue
                if ch == "/" and nxt == "*":
                    state = "block_comment"
                    masked.append("  ")
                    i += 2
                    continue
                if ch == "'":
                    state = "squote"
                    masked.append(" ")
                    i += 1
                    continue
                if ch == '"':
                    state = "dquote"
                    masked.append(" ")
                    i += 1
                    continue
                if ch == "`":
                    state = "template"
                    masked.append(" ")
                    i += 1
                    continue
                masked.append(ch)
                i += 1
                continue
            if state == "line_comment":
                masked.append(" ")
                i += 1
                continue
            if state == "block_comment":
                if ch == "*" and nxt == "/":
                    state = "code"
                    masked.append("  ")
                    i += 2
                    continue
                masked.append(" ")
                i += 1
                continue
            # 引号态（squote / dquote / template）
            if ch == "\\":
                masked.append("  ")
                i += 2
                continue
            if (state == "squote" and ch == "'") or (state == "dquote" and ch == '"') or (state == "template" and ch == "`"):
                state = "code"
                masked.append(" ")
                i += 1
                continue
            masked.append(" ")
            i += 1
            continue
        out.append("".join(masked))
        # 行注释不跨行，行末回落；块注释/引号/模板字符串合法跨行，状态保留
        if state == "line_comment":
            state = "code"
    return out


def find_recursive_rm_violations(masked: list[str], raw_lines: list[str], path: str) -> list[tuple[str, str]]:
    """在遮蔽文本上找「recursive: true 且无 maxRetries」的 rm/rmSync 调用。

    返回 (file:line, 单行摘录) 列表。同一行多个调用头逐个独立配平，按 file:line
    去重（如 Promise.all([rm(a), rm(b)]) 一行两处违规，修复按行进行，报一次即可）。
    """
    violations: list[tuple[str, str]] = []
    seen_locs: set[str] = set()
    for ln_idx, line in enumerate(masked):
        for head in CALL_HEAD_RE.finditer(line):
            # depth=1 对应调用头自身的 (，从 head 结束位置继续配平
            depth = 1
            end = ln_idx
            balanced = False
            last = min(len(masked), ln_idx + CALL_SCAN_LIMIT_LINES)
            for li in range(ln_idx, last):
                for ch in masked[li][head.end():] if li == ln_idx else masked[li]:
                    if ch == "(":
                        depth += 1
                    elif ch == ")":
                        depth -= 1
                        if depth == 0:
                            balanced = True
                            break
                if balanced:
                    end = li
                    break
                end = li
            if not balanced:
                # 配平失败（正则字面量等干扰）：按扫描上限截断，宁可多看不可漏看
                end = last - 1
            body = "\n".join(masked[ln_idx:end + 1])
            if RECURSIVE_TRUE_RE.search(body) and not MAX_RETRIES_RE.search(body):
                excerpt = re.sub(r"\s+", " ", " ".join(raw_lines[ln_idx:end + 1])).strip()
                if len(excerpt) > EXCERPT_MAX_CHARS:
                    excerpt = excerpt[:EXCERPT_MAX_CHARS] + "..."
                loc = f"{path}:{ln_idx + 1}"
                if loc not in seen_locs:
                    seen_locs.add(loc)
                    violations.append((loc, excerpt))
    return violations


def is_test_file(path: str) -> bool:
    p = path.replace("\\", "/")
    if "node_modules" in p.split("/"):
        return False
    if p.endswith(TEST_SUFFIXES):
        return True
    return "/test/" in p or p.startswith("test/") or "/__tests__/" in p or p.startswith("__tests__/")


def check_test_script_value(test_script: object) -> list[str]:
    """段 1 判定核心（纯函数，便于自测直接调用）。返回问题描述行列表，空 = 通过。"""
    if test_script is None:
        return [
            "段 1（F5）: 根 package.json 缺 scripts.test 条目",
            "  [FIX] 登记递归测试命令并带 --no-bail，格式: pnpm --filter <pkg...> --no-bail run test",
        ]
    if not isinstance(test_script, str):
        return [f"段 1（F5）: scripts.test 不是字符串（实际 {type(test_script).__name__}），无法检查"]
    if "--no-bail" in test_script:
        return []
    lines = [
        "段 1（F5）: 根 package.json scripts.test 缺 --no-bail",
        f"  当前值: {test_script}",
    ]
    if "run test" in test_script:
        lines.append(f"  应改为: {test_script.replace('run test', '--no-bail run test', 1)}")
    lines += [
        "  通用格式: pnpm --filter <pkg...> --no-bail run test（--no-bail 是递归命令选项，必须放在 run 之前）",
        "  [原因] pnpm 递归缺 --no-bail 时 first-fail 即中止尾部包执行，掩盖失败全貌（commit b7ec0298a）",
    ]
    return lines


def collect_segment1_problems() -> list[str]:
    pkg_path = PROJECT_ROOT / "package.json"
    if not pkg_path.exists():
        return [f"段 1（F5）: 找不到 {pkg_path}（脚本须置于仓库 .githooks/ 下运行）"]
    try:
        pkg = json.loads(pkg_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return [f"段 1（F5）: package.json 解析失败: {exc}"]
    return check_test_script_value(pkg.get("scripts", {}).get("test"))


def scan_test_file(display: str, abspath: Path) -> list[tuple[str, str]]:
    """扫描单个测试文件。display 用于报告定位（保持调用方传入形态），abspath 用于读取。"""
    if not abspath.exists():
        return []
    try:
        text = abspath.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return []
    raw_lines = text.splitlines()
    return find_recursive_rm_violations(mask_lines(raw_lines), raw_lines, display)


def main() -> int:
    problems = collect_segment1_problems()

    args = sys.argv[1:]
    if args:
        # 独立运行模式：参数相对调用者 cwd 解析，loc 按传入字符串展示
        entries = [(f, Path(f).resolve()) for f in args]
    else:
        # hook 模式：git diff --cached 输出仓库相对路径，loc 即仓库相对路径
        result = subprocess.run(
            ["git", "diff", "--cached", "--name-only", "--diff-filter=ACMR"],
            capture_output=True, text=True, cwd=str(PROJECT_ROOT),
        )
        entries = [(f, PROJECT_ROOT / f) for f in result.stdout.split()] if result.returncode == 0 else []
    test_files = [d for d, _ in entries if is_test_file(d)]

    violations: list[tuple[str, str]] = []
    for display, abspath in entries:
        if not is_test_file(display):
            continue
        violations.extend(scan_test_file(display, abspath))
    if violations:
        problems.append(f"段 2（F3）: 测试内 recursive 删除缺 maxRetries（{len(violations)} 处）")
        for loc, excerpt in violations:
            problems.append(f"  - {loc}")
            problems.append(f"      {excerpt}")
        problems += [
            "  [FIX] 在同一次调用参数里补 maxRetries 与 retryDelay:",
            "        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })",
            "        fs.promises.rm 同理: rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })",
            "  [原因] teardown 递归删除与在途异步写竞争，满载下 ENOTEMPTY 满载 flake；",
            "         rm/rmSync 默认 maxRetries=0，一次瞬态失败即抛（教训 commit d9ad39cb8）",
        ]

    if problems:
        print("[check_test_flake_hygiene] 检出测试 flake 卫生问题:")
        for p in problems:
            print(p)
        return 2

    if test_files:
        print(f"[OK] 测试 flake 卫生检查通过（scripts.test 含 --no-bail；{len(test_files)} 个测试文件的 recursive 删除均带 maxRetries）")
    else:
        print("[OK] 测试 flake 卫生检查通过（scripts.test 含 --no-bail；无测试文件扫描对象，F3 零成本跳过）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
