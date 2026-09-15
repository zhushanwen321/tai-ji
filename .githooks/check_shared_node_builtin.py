#!/usr/bin/env python3
"""
shared 层 node 内置模块检查（C-state-05）——落实 ADR-0027 W1a 教训。

规则：扫描 packages/shared/src/ 的 .ts 源码（排除 *.test.ts 与 __tests__/），
import 语句 from 'node:*' 即违规——shared 是浏览器/runtime 共享层，node 内置模块
在浏览器直接崩；node 专属路径工具归 runtime path-utils，纯计算函数放 shared
必须零 IO 零 node 依赖。

存量基线（2026-08-22 首次接入时登记）：paths.ts（getConfigDir 等动态推导的实现处，
import node:os/node:path）——疑似与 ADR-0027 冲突，待架构确认后收编（挪 runtime 或
拆分纯计算部分）；确认前不拦，其余文件违规即拦。

退出码: 0 通过 / 2 违规
"""

import re
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SHARED_SRC = PROJECT_ROOT / "packages/shared/src"

# 存量待治理（2026-08-22 基线；治理完成后删除即全量拦截）
ALLOWLIST_FILES = {"paths.ts"}

NODE_IMPORT_RE = re.compile(r"""from\s+['"]node:[^'"]+['"]""")


def main() -> int:
    violations = []
    for f in sorted(SHARED_SRC.rglob("*.ts")):
        if f.name.endswith(".test.ts") or "__tests__" in f.parts:
            continue
        if f.name in ALLOWLIST_FILES:
            continue
        if NODE_IMPORT_RE.search(f.read_text(encoding="utf-8", errors="replace")):
            violations.append(
                f"{f.relative_to(PROJECT_ROOT).as_posix()}: import node 内置模块（shared 是浏览器/runtime 共享层，ADR-0027）"
            )

    if violations:
        print("[check_shared_node_builtin] shared 层存在 node 内置 import（ADR-0027 W1a）：")
        for v in violations:
            print(f"  - {v}")
        print("修复方向：node 专属逻辑移至 runtime（path-utils 等）；shared 只留零 IO 纯计算。")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
