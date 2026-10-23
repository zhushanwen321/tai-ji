#!/usr/bin/env python3
"""
runtime 打包面 CJS 兼容形态检查（C-build-01 前置化）——落实 AGENTS.md 规则 12「Electron 打包约束」。

规则（事故最高发区，打包后 CJS bundle 失效形态）：
  扫描根 = packages/runtime/src + runtime tsup noExternal 所列 workspace 包的 src/
  （扫描根从 packages/runtime/tsup.config.ts 动态提取——workspace 包经 noExternal 内联
  进 bundle，其源码形态同样是 CJS 失效面；npm 三方包自带构建链，不扫）。剥离注释后：
  - 规则 A：代码行含 `import.meta.` 属性访问 → 违规（tsup CJS 输出中 import.meta 被替换
    为 var import_meta = {}，任何属性都为 undefined）。合法形态：guard 行内使用
    （同一行含 `typeof import.meta`）或 allowlist 登记的权威 guard 实现。
  - 规则 B：代码行含 `globalThis.__dirname` → 违规（CJS 中 __dirname 是模块局部变量，
    不在 globalThis 上）。裸 __dirname 是 CJS 合法用法，不拦。

workspace 包判定（动态提取，无第二份清单）：对 noExternal 每个包名，经
packages/runtime/node_modules/<pkg> symlink realpath 解析实体，实体落在 pnpm workspace
声明目录（packages/ apps/ extensions/）且路径不含 node_modules 段 = workspace 包。

存量豁免（权威 guard 实现豁免，本规则的参照实现，key = 仓库相对路径）：
- packages/runtime/src/services/plugin-service/plugin-host.ts——双形态（CJS/ESM）路径
  解析的权威 guard（typeof __dirname / typeof import.meta 双检查 + 清晰报错）。
- packages/subagent-core/src/execution/engine/d8-compat.ts——corePackageDir() 双形态
  guard（try/catch import.meta.url 后回落 __dirname；src TS 源码包的 ESM 消费方走
  import.meta 分支，runtime CJS bundle 内联后走 __dirname 分支）。

退出码: 0 通过 / 2 违规
"""

from __future__ import annotations
import re
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
RUNTIME_SRC = PROJECT_ROOT / "packages/runtime/src"
TSUP_CONFIG = PROJECT_ROOT / "packages/runtime/tsup.config.ts"
RUNTIME_MODULES = PROJECT_ROOT / "packages/runtime/node_modules"

# workspace 实体必须落在 pnpm-workspace.yaml 声明的这些目录内（前缀判定）
WORKSPACE_DIR_PREFIXES = ("packages/", "apps/", "extensions/")

# 权威 guard 实现豁免（本规则的参照实现；key = 仓库相对路径）
ALLOWLIST_FILES = {
    "packages/runtime/src/services/plugin-service/plugin-host.ts",
    "packages/subagent-core/src/execution/engine/d8-compat.ts",
}

META_URL_RE = re.compile(r"import\.meta\.")
GLOBAL_DIRNAME_RE = re.compile(r"globalThis\.__dirname")
GUARD_MARK = "typeof import.meta"
NOEXTERNAL_RE = re.compile(r"noExternal:\s*\[([^\]]+)\]")


def resolve_workspace_scan_roots() -> list[Path]:
    """扫描根 = runtime src + noExternal 所列 workspace 包的 src（动态提取，无双清单）。"""
    roots = [RUNTIME_SRC]
    content = TSUP_CONFIG.read_text(encoding="utf-8", errors="replace")
    match = NOEXTERNAL_RE.search(content)
    if match is None:
        return roots
    pkgs = [s.strip().strip("'\"") for s in match.group(1).split(",")]
    for pkg in filter(None, pkgs):
        link = RUNTIME_MODULES / pkg
        try:
            real = link.resolve(strict=True)
        except OSError:
            continue  # npm 包或未安装——node_modules 无此链接，非 workspace 实体
        rel = real.relative_to(PROJECT_ROOT)
        rel_posix = rel.as_posix()
        parts = rel.parts
        if "node_modules" in parts:
            continue  # pnpm .pnpm 实体 / 包内嵌套依赖 = npm 包，不扫
        if not rel_posix.startswith(WORKSPACE_DIR_PREFIXES):
            continue
        src = real / "src"
        if src.is_dir():
            roots.append(src)
    return roots


def strip_comments(text: str) -> str:
    """剥除 // 行注释与 /* */ 块注释（含单行闭合的 JSDoc——按行定位的朴素实现剥不掉
    `/** ... */` 同行闭合形态，扩展扫描根后在 core 包 JSDoc 上实际暴露过误报）。"""
    out_lines = []
    in_block = False
    for line in text.splitlines():
        result = []
        i = 0
        n = len(line)
        while i < n:
            if in_block:
                end = line.find("*/", i)
                if end == -1:
                    break  # 行尾仍在块注释中
                in_block = False
                i = end + 2
                continue
            if line[i] == "/" and i + 1 < n and line[i + 1] == "/":
                break  # 行注释：丢弃剩余部分
            if line[i] == "/" and i + 1 < n and line[i + 1] == "*":
                end = line.find("*/", i + 2)
                if end == -1:
                    in_block = True
                    break
                i = end + 2
                continue
            result.append(line[i])
            i += 1
        out_lines.append("".join(result))
    return "\n".join(out_lines)


def main() -> int:
    violations = []
    for src_root in resolve_workspace_scan_roots():
        for f in sorted(src_root.rglob("*.ts")):
            if f.name.endswith(".test.ts") or "__tests__" in f.parts:
                continue
            rel = f.relative_to(PROJECT_ROOT).as_posix()
            if rel in ALLOWLIST_FILES:
                continue
            stripped = strip_comments(f.read_text(encoding="utf-8", errors="replace"))
            for lineno, line in enumerate(stripped.splitlines(), 1):
                if META_URL_RE.search(line) and GUARD_MARK not in line:
                    violations.append(
                        f"{rel}:{lineno}: import.meta 属性访问无 guard（CJS bundle 中为 undefined）"
                    )
                if GLOBAL_DIRNAME_RE.search(line):
                    violations.append(f"{rel}:{lineno}: globalThis.__dirname（CJS 中 __dirname 不在 globalThis 上）")

    if violations:
        print("[check_runtime_meta_url] runtime 打包面源码存在 CJS bundle 失效形态（AGENTS.md 规则 12）：")
        for v in violations:
            print(f"  - {v}")
        print("修复方向：路径解析用 typeof __dirname !== 'undefined' ? __dirname : undefined guard（参照 plugin-host.ts），双形态 guard 实现可登记脚本 allowlist（参照 d8-compat.ts）。")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
