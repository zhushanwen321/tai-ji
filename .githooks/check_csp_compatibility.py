#!/usr/bin/env python3
"""
CSP 能力一致性检查：renderer/ui 源码中的 CSP 敏感 API 必须与 index.html CSP 指令一致。

背景（2026-08-21 v0.9.3+ 线上事故）：index.html CSP 收紧为 script-src 'self' 后，
shiki 默认 Oniguruma 引擎的 WebAssembly.instantiate 被 CSP 拒绝（CompileError）→
createHighlighter 抛错 → 全部 markdown 渲染静默降级纯文本（对话流/用户气泡/drawer
skill 文档无格式 + 换行丢失，跨 v0.9.3/v0.9.4 两个版本）。测试环境（vitest/jsdom）
无 CSP 约束测不出，commit 时 CSP 只验证了「违规为零」没验证「既有功能仍正常」。

检查规则：
  源码出现敏感 API 且 index.html CSP 未放行对应能力 → 违规：
    - `WebAssembly.`      → 需 script-src 含 'wasm-unsafe-eval' 或 'unsafe-eval'
    - `eval(`             → 需 script-src 含 'unsafe-eval'
    - `new Function(`     → 需 script-src 含 'unsafe-eval'

  白名单（ALLOWLIST）：确有正当需要（如未来引入合法 WASM 依赖）时，同步改 index.html
  CSP 放行 + 在 ALLOWLIST 登记文件，把「能力变更」变成显式决策而非静默漂移。

已知局限：无法发现第三方依赖内部（如 shiki oniguruma loader）的 WASM 使用——
产物级防护见 scripts/postbuild-validate.sh 的 renderer chunk WASM 扫描。

退出码：0 通过 / 2 违规
"""

import re
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
INDEX_HTML = PROJECT_ROOT / "packages" / "renderer" / "index.html"
SCAN_ROOTS = [
    PROJECT_ROOT / "packages" / "renderer" / "src",
    PROJECT_ROOT / "packages" / "ui" / "src",
]

# 合法使用敏感 API 的文件（相对各自 SCAN_ROOT，posix 路径）。当前为空——
# renderer 在 CSP script-src 'self' 下不允许任何 eval/WASM 能力。
ALLOWLIST: set[str] = set()

# CSP 敏感 API → 所需的 script-src source（任一满足即可）
SENSITIVE_PATTERNS = [
    (re.compile(r"WebAssembly\s*\."), "'wasm-unsafe-eval' 或 'unsafe-eval'"),
    (re.compile(r"(^|[^\w.$])eval\s*\("), "'unsafe-eval'"),
    (re.compile(r"new\s+Function\s*\("), "'unsafe-eval'"),
]

# 提取含 CSP 的 <meta> 标签，再在标签内提取 content 属性值。
# content 值内含单引号 source（如 'self'），属性界定用哪种引号就匹配到哪种（反向引用），
# 不能用「排除两种引号」的字符类——会在值内首个 'self' 处截断。
META_TAG = re.compile(r"<meta\b[^>]*Content-Security-Policy[^>]*>", re.IGNORECASE | re.DOTALL)
CONTENT_ATTR = re.compile(r"content=(?P<q>[\"'])(?P<value>(?:(?!(?P=q)).)+)(?P=q)", re.IGNORECASE | re.DOTALL)


def parse_csp_script_sources() -> list[str] | None:
    """解析 index.html CSP meta 的 script-src source 列表；无 CSP 或无 script-src 返回 None。"""
    if not INDEX_HTML.exists():
        return None
    text = INDEX_HTML.read_text(encoding="utf-8")
    tag = META_TAG.search(text)
    if not tag:
        return None
    content = CONTENT_ATTR.search(tag.group(0))
    if not content:
        return None
    policy = content.group("value")
    for directive in policy.split(";"):
        parts = directive.strip().split()
        if parts and parts[0] == "script-src":
            return parts[1:]
    return None


def main() -> int:
    script_sources = parse_csp_script_sources()
    if script_sources is None:
        print("[ERROR] 无法解析 packages/renderer/index.html 的 script-src 指令（CSP meta 缺失或格式变化）")
        print("        请检查 CSP meta 标签完整性；本检查依赖它做能力一致性判定")
        return 2

    has_unsafe_eval = "'unsafe-eval'" in script_sources
    has_wasm = has_unsafe_eval or "'wasm-unsafe-eval'" in script_sources
    # CSP 放行状态变化时打印，方便 review 时注意到能力边界
    print(
        f"[INFO] script-src = {' '.join(script_sources)}"
        f"（wasm={has_wasm}, eval={has_unsafe_eval}）"
    )

    errors: list[str] = []
    for scan_root in SCAN_ROOTS:
        if not scan_root.exists():
            continue
        for f in sorted(scan_root.rglob("*")):
            if f.suffix not in (".ts", ".tsx", ".vue"):
                continue
            rel = f.relative_to(scan_root).as_posix()
            # [HISTORICAL] 测试文件排除：单测在 node/jsdom 环境无 CSP 约束（如 jsdom
            # polyfill 用 eval 是测试基建职责），规则目标是产品代码运行时能力一致。
            if rel.startswith("__tests__/") or ".test." in f.name:
                continue
            if rel in ALLOWLIST:
                continue
            text = f.read_text(encoding="utf-8")
            for ln_no, line in enumerate(text.splitlines(), 1):
                stripped = line.strip()
                if stripped.startswith("//") or stripped.startswith("*") or stripped.startswith("/*"):
                    continue
                for pattern, needed in SENSITIVE_PATTERNS:
                    if not pattern.search(line):
                        continue
                    if needed == "'unsafe-eval'" and has_unsafe_eval:
                        continue
                    if needed != "'unsafe-eval'" and has_wasm:
                        continue
                    scope = f.relative_to(PROJECT_ROOT).as_posix()
                    errors.append(f"  {scope}:{ln_no}: {stripped[:100]}")

    if errors:
        print("[ERROR] renderer/ui 源码使用了 CSP 未放行的能力（script-src 'self' 不含 eval/wasm）")
        print("        本次事故背景：CSP 拦 WASM 曾致全部 markdown 渲染静默降级纯文本（2026-08 v0.9.3+）")
        print("        修复方向（按优先级）：")
        print("          1. 改用无该能力的实现（参考 composables/logic/markdown.ts 的")
        print("             createJavaScriptRegexEngine 替代 Oniguruma WASM）")
        print("          2. 确属正当需要：index.html CSP 增补对应 source（wasm 用 'wasm-unsafe-eval'）")
        print("             并在本脚本 ALLOWLIST 登记该文件，把能力变更变成显式决策")
        print("\n".join(errors))
        print()
        print("\033[0;31m[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。\033[0m")
        return 2

    print("[OK] CSP 能力一致性检查通过（源码无未放行的 eval/WebAssembly 用法）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
