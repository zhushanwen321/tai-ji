#!/usr/bin/env python3
"""
runtime 源码 CJS 兼容形态检查（C-build-01 前置化）——落实 AGENTS.md 规则 12「Electron 打包约束」。

规则（事故最高发区，打包后 CJS bundle 失效形态）：
  扫描 packages/runtime/src/ 的 .ts 源码（排除 *.test.ts 与 __tests__/），剥离注释后：
  - 规则 A：代码行含 `import.meta.url` → 违规（tsup CJS 输出中 import.meta 被替换为
    var import_meta = {}，import.meta.url 为 undefined）。合法形态：guard 行内使用
    （同一行含 `typeof import.meta`）或 allowlist 登记的权威 guard 实现。
  - 规则 B：代码行含 `globalThis.__dirname` → 违规（CJS 中 __dirname 是模块局部变量，
    不在 globalThis 上）。裸 __dirname 是 CJS 合法用法，不拦。

存量豁免：services/plugin-service/plugin-host.ts——双形态（CJS/ESM）路径解析的权威
guard 实现（typeof __dirname / typeof import.meta 双守卫 + 清晰报错），正是本规则
推荐形态的参照实现。

退出码: 0 通过 / 2 违规
"""

import re
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
RUNTIME_SRC = PROJECT_ROOT / "packages/runtime/src"

# 权威 guard 实现豁免（本规则的参照实现）
ALLOWLIST_FILES = {"services/plugin-service/plugin-host.ts"}

META_URL_RE = re.compile(r"import\.meta\.url")
GLOBAL_DIRNAME_RE = re.compile(r"globalThis\.__dirname")
GUARD_MARK = "typeof import.meta"


def strip_comments(text: str) -> str:
    out_lines = []
    in_block = False
    for line in text.splitlines():
        if in_block:
            end = line.find("*/")
            if end == -1:
                out_lines.append("")
                continue
            line = line[end + 2 :]
            in_block = False
        idx = line.find("//")
        if idx != -1:
            line = line[:idx]
        start = line.find("/*")
        if start != -1:
            if line.find("*/", start + 2) == -1:
                line = line[:start]
                in_block = True
        out_lines.append(line)
    return "\n".join(out_lines)


def main() -> int:
    violations = []
    for f in sorted(RUNTIME_SRC.rglob("*.ts")):
        if f.name.endswith(".test.ts") or "__tests__" in f.parts:
            continue
        rel = f.relative_to(RUNTIME_SRC).as_posix()
        if rel in ALLOWLIST_FILES:
            continue
        stripped = strip_comments(f.read_text(encoding="utf-8", errors="replace"))
        for lineno, line in enumerate(stripped.splitlines(), 1):
            if META_URL_RE.search(line) and GUARD_MARK not in line:
                violations.append(
                    f"{rel}:{lineno}: import.meta.url 无 guard（CJS bundle 中为 undefined）"
                )
            if GLOBAL_DIRNAME_RE.search(line):
                violations.append(f"{rel}:{lineno}: globalThis.__dirname（CJS 中 __dirname 不在 globalThis 上）")

    if violations:
        print("[check_runtime_meta_url] runtime 源码存在 CJS bundle 失效形态（AGENTS.md 规则 12）：")
        for v in violations:
            print(f"  - {v}")
        print("修复方向：路径解析用 typeof __dirname !== 'undefined' ? __dirname : undefined guard（参照 plugin-host.ts）。")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
