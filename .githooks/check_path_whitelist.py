#!/usr/bin/env python3
"""
检查路径安全白名单是否使用了动态化路径（getConfigDir / getPiAgentDir）。

规则：
  - 包含 allowedPrefixes / allowedDirs 等路径白名单的文件，
    必须 import 或调用 getConfigDir() / getPiAgentDir()。
  - 硬编码 ~/.taiji / ~/.pi 路径到白名单中是不允许的，
    因为实例隔离后路径可能是 ~/.taiji-dev。

退出码：
  0 — 通过
  2 — 检查失败
"""

import re
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent

# 需要检查的文件列表（含 allowedPrefixes 等路径白名单的核心文件）
# 注：runtime 旧 server.ts（含 allowedPrefixes）已在 sidecar→runtime 重命名中拆分，
# 当前 runtime 无路径白名单变量。TARGETS 保留入口文件供未来扩展（文件存在则检查，
# 不存在则软跳过，见 check_file 的空列表返回）。
TARGETS = [
    PROJECT_ROOT / "packages/runtime/src/index.ts",
]

# 白名单变量名模式
ALLOWED_VAR_PATTERNS = [
    r"allowedPrefixes",
    r"allowedDirs",
    r"allowedPaths",
    r"pathWhitelist",
]

# 动态化路径函数
DYNAMIC_FUNCTIONS = [
    r"getConfigDir",
    r"getPiAgentDir",
]


def check_file(filepath: Path) -> list[str]:
    """检查单个文件，返回错误列表。"""
    errors: list[str] = []
    rel = filepath.relative_to(PROJECT_ROOT)

    if not filepath.exists():
        return [f"[WARN] {rel}: 文件不存在，跳过"]

    text = filepath.read_text(encoding="utf-8")

    # 1. 检查是否存在白名单变量
    has_whitelist = False
    for pattern in ALLOWED_VAR_PATTERNS:
        if re.search(rf"\b{pattern}\b", text):
            has_whitelist = True
            break

    if not has_whitelist:
        # 没有白名单变量，无需检查
        return []

    # 2. 检查是否使用了动态路径函数
    has_dynamic = False
    for fn in DYNAMIC_FUNCTIONS:
        if re.search(rf"\b{fn}\b", text):
            has_dynamic = True
            break

    if not has_dynamic:
        errors.append(
            f"[ERROR] {rel}: 发现路径白名单 (allowedPrefixes/allowedDirs) "
            f"但未使用动态路径函数 (getConfigDir/getPiAgentDir)"
        )
        errors.append(
            f"  提示: 白名单中的硬编码路径在实例隔离后可能不匹配，"
            f"应从 getConfigDir()/getPiAgentDir() 动态推导"
        )

    # 3. 检查白名单数组中是否有硬编码的 ~/.taiji 或 ~/.pi 路径
    #    模式: resolve(homeDir, '.taiji') 或 resolve(homeDir, '.pi/agent')
    hardcoded_patterns = [
        (r"resolve\s*\(\s*homeDir\s*,\s*'[^']*\.taiji", "~/.taiji"),
        (r"resolve\s*\(\s*homedir\s*\(\s*\)\s*,\s*'[^']*\.taiji", "~/.taiji (homedir())"),
        # 注意: ~/.pi/agent 是系统 pi 的固定路径，不属于 taiji 实例隔离范围，不检查
    ]

    # 查找白名单数组的上下文（从变量声明到闭合方括号）
    for var_pattern in ALLOWED_VAR_PATTERNS:
        array_match = re.search(
            rf"(?:const|let|var)\s+{var_pattern}\s*=\s*\[([^\]]*)\]", text, re.DOTALL
        )
        if not array_match:
            continue
        array_body = array_match.group(1)

        for regex, label in hardcoded_patterns:
            if re.search(regex, array_body, re.IGNORECASE):
                # 只有 taiji 的路径才需要动态化，~/.pi/agent 是系统 pi 固定路径
                errors.append(
                    f"[WARN] {rel}: {var_pattern} 中包含硬编码路径 {label}，"
                    f"建议改用 getPiAgentDir()/getConfigDir() 动态生成"
                )

    return errors


def main() -> int:
    all_errors: list[str] = []

    for target in TARGETS:
        errors = check_file(target)
        all_errors.extend(errors)

    has_error = any(e.startswith("[ERROR]") for e in all_errors)

    for e in all_errors:
        print(e)

    if has_error:
        print()
        print("\033[0;31m[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。\033[0m")
        return 2

    if not all_errors:
        print("[OK] 路径白名单动态化检查通过")

    return 0


if __name__ == "__main__":
    sys.exit(main())
