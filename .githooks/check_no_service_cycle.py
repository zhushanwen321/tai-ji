#!/usr/bin/env python3
"""
检测 runtime services 之间的循环依赖 —— 落实 D6c 防护（phase-5 guardrails 5.4）。

背景：Phase 3 把 session-service 拆成 session/ 子模块，子模块经 ISessionServiceInternal
接口解耦（runtime/src/interfaces.ts）。本脚本把「services 之间不得出现具体类循环 import」
固化为 pre-commit 检查，防止未来回退引入循环（D6c 误诊再现）。

检测范围：packages/runtime/src/services/**/*.ts（含 plugin-service 子系统）。
检测对象：value import（排除 `import type`）的具体类标识符（首字母大写）。
建图后用三色 DFS 找环；有环 → exit 2 + 打印环路径。

不报：单向依赖（含组合根 Facade 装配，如 session-service.ts → TreeService，合法 DI）；
import type（接口依赖不造成运行时耦合）；types.ts/plugin-types.ts；指向 services 外的 import。

退出码：0 通过 / 2 发现循环
"""

import collections
import re
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SERVICES_ROOT = PROJECT_ROOT / "packages" / "runtime" / "src" / "services"

IMPORT_RE = re.compile(r"^\s*import\s+\{([^}]*)\}\s+from\s+['\"]([^'\"]+)['\"]")
TYPE_SUFFIXES = (".ts", ".js")
SKIP_FILES = ("types.ts", "plugin-types.ts")


def normalize_target(src_path: Path) -> str | None:
    """解析 import 目标，返回相对 services/ 的 posix key（去后缀）；services 外返回 None。"""
    try:
        rel = src_path.resolve().relative_to(SERVICES_ROOT.resolve())
    except ValueError:
        return None  # 目标在 services 外（infra/adapters/shared）—— 不算 service 间依赖
    if rel.name in SKIP_FILES:
        return None
    # 去掉 .ts/.js 后缀作为节点 key
    name = rel.name
    for suf in TYPE_SUFFIXES:
        if name.endswith(suf):
            name = name[: -len(suf)]
            break
    return str(rel.with_name(name)).replace("\\", "/")


def concrete_symbols(named: str) -> list[str]:
    """从命名导入块提取具体类标识符（首字母大写），排除 `import type` 已过滤的行。"""
    out: list[str] = []
    for piece in named.split(","):
        token = piece.strip()
        if not token:
            continue
        # 处理 `Foo as Bar` / `Foo: type`
        ident = re.split(r"\s+as\s+|:", token)[0].strip()
        if ident and ident[0].isupper():
            out.append(ident)
    return out


def build_graph() -> dict[str, set[str]]:
    adj: dict[str, set[str]] = collections.defaultdict(set)
    for f in sorted(SERVICES_ROOT.rglob("*.ts")):
        if f.name in SKIP_FILES:
            continue
        src_file = str(f.relative_to(SERVICES_ROOT)).replace("\\", "/")
        for suf in TYPE_SUFFIXES:
            if src_file.endswith(suf):
                src_file = src_file[: -len(suf)]
                break
        for line in f.read_text(encoding="utf-8").splitlines():
            if line.strip().startswith("import type") or line.strip().startswith("//"):
                continue
            m = IMPORT_RE.match(line)
            if not m:
                continue
            named, src = m.group(1), m.group(2)
            tgt = normalize_target(f.parent / src)
            if tgt is None:
                continue
            if concrete_symbols(named):
                adj[src_file].add(tgt)
    return adj


def find_cycles(adj: dict[str, set[str]]) -> list[list[str]]:
    """三色 DFS 收集所有环（返回环路径，首尾相同）。"""
    nodes = set(adj) | {t for vs in adj.values() for t in vs}
    color = {n: 0 for n in nodes}  # 0=white 1=gray 2=black
    cycles: list[list[str]] = []

    def dfs(n: str, path: list[str]) -> None:
        color[n] = 1
        for nb in sorted(adj.get(n, ())):
            if color.get(nb, 0) == 1:
                cycles.append(path + [n, nb])
            elif color.get(nb, 0) == 0:
                dfs(nb, path + [n])
        color[n] = 2

    for n in sorted(nodes):
        if color[n] == 0:
            dfs(n, [])
    return cycles


def main() -> int:
    adj = build_graph()
    cycles = find_cycles(adj)
    if not cycles:
        edge_count = sum(len(v) for v in adj.values())
        print(f"[OK] services 循环依赖检查通过（{edge_count} 条具体类依赖边，无环）")
        return 0
    print("[ERROR] 检测到 runtime services 循环依赖（D6c）— 请用接口/事件解耦：")
    seen: set[tuple[str, ...]] = set()
    for c in cycles:
        key = tuple(c)
        if key in seen:
            continue
        seen.add(key)
        print("  " + " -> ".join(c))
    print("\n[INFO] 子模块改用 runtime/src/interfaces.ts 的接口（如 ISessionServiceInternal）；")
    print("        组合根 Facade 装配的具体类 import 不算循环（单向依赖）。")
    print("\033[0;31m[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。\033[0m")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
