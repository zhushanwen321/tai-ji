#!/usr/bin/env python3
r"""
hook 脚本反模式守卫（G3）：set -e 下「VAR=$(cmd) 赋值 + 紧跟 VAR=$? 捕获」组合拦截。

动机：install-hooks.sh（pre-commit 模板源头）有 set -e。在该模式下 `VAR=$(cmd)`
赋值语句的退出码就是命令替换的退出码，cmd 失败时脚本随即终止，紧跟的
`VAR2=$?` 永不可达——诊断输出被吞进 VAR 一起丢失（2026-09 实测：pre-commit 内
ESLint 检查失败 exit 2 零输出，排查无从下手）。正确形态是
`if ! VAR=$(cmd); then`：非零退出被限制在条件表达式内，输出可见、失败分支可达。

检查逻辑（行级状态机）：
  A. 赋值行：`^\s*NAME=$(…)` 且该行以 `)` 收尾（单行命令替换赋值）；
  B. 在其后 ≤3 行窗口内找第一个「实义行」（跳过空行与纯注释行）；
  C. 该行匹配 `^\s*NAME2=$?\s*$` → 违规（NAME/行号定位，给 if ! 修复指引）。
  窗口内先遇到其他语句则停止——不再构成「紧跟」。

已知局限（零依赖静态扫描的边界，朝漏报方向可接受）：
  - 跨行命令替换 `NAME=$(\n … \n)`（首行无闭合括号）不判；
  - `$?` 在同一行内联使用（`cmd; echo $?`）不属本组合，不判。

用法：
  python3 .githooks/check_hook_exitcode_antipattern.py               # 扫 install-hooks.sh（缺省目标）
  python3 .githooks/check_hook_exitcode_antipattern.py <file...>     # 扫指定文件（fixture 自测）

退出码：0 通过 / 2 违规
"""

import re
import sys
from pathlib import Path

DEFAULT_TARGET = Path(__file__).resolve().parent / "install-hooks.sh"

# A. 单行命令替换赋值：NAME=$(...)（行尾闭合；跨行形态见头注「已知局限」）
ASSIGN_RE = re.compile(r"^\s*([A-Za-z_]\w*)=\$\(.+\)\s*$")
# C. 退出码捕获赋值：NAME=$?
CAPTURE_RE = re.compile(r"^\s*[A-Za-z_]\w*=\$\?\s*$")

# B. 「紧跟」窗口：赋值行之后最多向后看的行数
FOLLOW_WINDOW = 3


def scan_file(path: Path) -> list[dict]:
    """单文件扫描，返回违规明细（line 为 1-based 行号）。"""
    lines = path.read_text(encoding="utf-8").splitlines()
    violations: list[dict] = []
    for i, line in enumerate(lines):
        assign = ASSIGN_RE.match(line)
        if not assign:
            continue
        var_name = assign.group(1)
        for j in range(i + 1, min(i + 1 + FOLLOW_WINDOW, len(lines))):
            probe = lines[j]
            stripped = probe.strip()
            if stripped == "" or stripped.startswith("#"):
                continue
            if CAPTURE_RE.match(probe):
                violations.append(
                    {
                        "file": str(path),
                        "line": j + 1,
                        "assign_line": i + 1,
                        "var": var_name,
                        "capture_var": stripped.split("=", 1)[0],
                    }
                )
            break  # 窗口内第一个实义行不是 $? 捕获即不再构成「紧跟」
    return violations


def main(argv: list[str]) -> int:
    targets = [Path(a) for a in argv[1:]] or [DEFAULT_TARGET]
    violations: list[dict] = []
    for target in targets:
        if not target.is_file():
            print(f"[hook-antipattern] ERROR 目标不存在：{target}")
            return 2
        violations.extend(scan_file(target))

    if violations:
        print(f"[hook-antipattern] 守卫拦截：{len(violations)} 处「VAR=$(cmd) 赋值 + 紧跟 EXIT=$? 捕获」反模式\n")
        for v in violations:
            print(
                f"  ✗ {v['file']}:{v['line']} —— `{v['capture_var']}=$?` 不可达："
                f"{v['assign_line']} 行 `{v['var']}=$(…)` 在 set -e 下失败即整脚退出，"
                "诊断输出随变量一起丢失"
            )
        print()
        print("[FIX] 改为 if ! 形态（非零退出限制在条件表达式内，输出可见、失败分支可达）：")
        print("      if ! VAR=$(cmd …); then")
        print("          echo \"$VAR\"   # 诊断输出在此可见")
        print("          exit 1")
        print("      fi")
        return 2

    print(f"[hook-antipattern] OK：无 set -e 退出码捕获反模式（扫描 {len(targets)} 个文件）")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
