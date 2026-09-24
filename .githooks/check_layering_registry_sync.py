#!/usr/bin/env python3
"""
runtime-layering §3 表行 ↔ 守卫 DOCUMENTED_MODULES 集合双向对账（S2②，PR #20 组 B 守卫化）。

背景：services→infra 受控例外有两侧登记——docs/architecture/runtime-layering.md §3「跨切面
例外」表（人读权威）与 .githooks/check_services_infra_import.py 的 DOCUMENTED_MODULES
（机器拦截白名单）。此前互指仅注释级（MF-5-1：守卫白名单加了 crash-correlation 但 §3 表
无对应行，靠 review 才补齐）。本对账器把互指升为机器校验：

  §3 表行模块集 == DOCUMENTED_MODULES（双向相等）

  - §3 有而白名单无 → 文档登记了但守卫没收口（该模块的 value import 会被误拦）
  - 白名单有而 §3 无 → 守卫放行了文档未登记的模块（例外面静默扩大）

BASELINE_MODULES（基线债）不在对账面——它们本就不在 §3 表（待 ports 收编），
收编完成 = 从 BASELINE 删除，若应转正例外则先在 §3 表登记 + 移入 DOCUMENTED。

挂载：与 check_services_infra_import.py 同挂载点（pre-commit 架构约束段 + CI）。
退出码：0 = 一致；1 = 漂移。
"""

import importlib.util
import re
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
GUARD = PROJECT_ROOT / ".githooks" / "check_services_infra_import.py"
DOC = PROJECT_ROOT / "docs" / "architecture" / "runtime-layering.md"

# §3 表行形态：| ① | `infra/logger.ts` | ... （③ 行含两个反引号模块路径）。
# 模块路径可含子目录（infra/pi/pi-paths.ts）——守卫白名单键 = 文件名去扩展（Path.stem 同口径）
MODULE_CELL_RE = re.compile(r"`infra/([a-z0-9/-]+)\.ts`")


def documented_modules() -> set[str]:
    spec = importlib.util.spec_from_file_location("svc_infra_guard", GUARD)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return set(mod.DOCUMENTED_MODULES)


def table_modules() -> set[str]:
    """§3「跨切面例外」表行的模块集合（从『## 3.』到下一个 ### / ## 边界）。

    只取表格行（| 开头）的第 2 列（模块列）——第 4 列「消费方」单元格也会反引号引用
    infra 路径（如 ③e/③f 的「另一消费方 infra/pi/rpc-client.ts」），那是提及不是登记。
    """
    text = DOC.read_text(encoding="utf-8")
    start = text.index("## 3.")
    rest = text[start:]
    nxt = re.search(r"\n#{2,3} ", rest[4:])
    section = rest[: 4 + nxt.start()] if nxt else rest
    names: set[str] = set()
    for line in section.splitlines():
        if not line.lstrip().startswith("|"):
            continue
        cells = line.split("|")
        if len(cells) < 3:
            continue
        for path in MODULE_CELL_RE.findall(cells[2]):
            names.add(path.rsplit("/", 1)[-1])
    return names


def main() -> int:
    doc_side = documented_modules()
    table_side = table_modules()
    only_table = sorted(table_side - doc_side)
    only_guard = sorted(doc_side - table_side)
    if only_table or only_guard:
        print("[check-layering-registry-sync] §3 表行 ↔ 守卫 DOCUMENTED_MODULES 漂移：")
        for m in only_table:
            print(f"  - {m}：runtime-layering §3 已登记，但守卫 DOCUMENTED_MODULES 未收录"
                  f"（该模块 value import 会被守卫误拦）——补入 .githooks/check_services_infra_import.py")
        for m in only_guard:
            print(f"  - {m}：守卫 DOCUMENTED_MODULES 已收录，但 runtime-layering §3 表无对应行"
                  f"（例外面静默扩大）——补 docs/architecture/runtime-layering.md §3 表行（性质/消费方），"
                  f"或若属基线债移入 BASELINE_MODULES")
        return 1
    print(f"[check-layering-registry-sync] OK（§3 ↔ DOCUMENTED_MODULES 双向一致，{len(doc_side)} 模块）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
