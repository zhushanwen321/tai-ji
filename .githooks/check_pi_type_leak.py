#!/usr/bin/env python3
"""
PiXxx 类型泄漏检查（C-comm-02）——落实 runtime 三层设计「PiXxx 类型只在 infra/pi 内部可见」。

规则（规格 SSOT：docs/architecture/runtime-layering.md 第二部分边界规则）：
  扫描 packages/runtime/src/services/ 与 packages/runtime/src/transport/ 的 .ts 源码
  （排除 *.test.ts 与 __tests__/），剥离注释后命中标识符 Pi[A-Z]* 即违规——
  pi 协议类型只允许出现在 infra/pi/ 内部，pi 原始事件必须经 infra/pi/pi-events.ts
  翻译为内部类型后才进 services。

存量基线（2026-08-22 首次接入时登记，ALLOWLIST 之外的文件违规即拦）：
  三层设计落地后 services 层存在 25 个历史引用文件（ports 接口 / migration 解析器 /
  plugin-types / session 子模块等）。本检查以「文件级 allowlist + 增量拦截」上线：
  存量文件待专项治理（治理完成后删除 ALLOWLIST 即全量拦截），新文件引入 PiXxx 直接拦。

退出码: 0 通过 / 2 发现泄漏
"""

import re
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SCAN_DIRS = [
    PROJECT_ROOT / "packages/runtime/src/services",
    PROJECT_ROOT / "packages/runtime/src/transport",
]

# 存量待治理清单（2026-08-22 基线；治理完成后删除即全量拦截）
ALLOWLIST_FILES = {
    "services/handoff-service.ts",
    "services/migration/legacy-provider-migration.ts",
    "services/migration/parsers/codex-parser.ts",
    "services/migration/parsers/pi-parser.ts",
    "services/migration/parsers/zcode-parser.ts",
    "services/migration/provider-importer.ts",
    "services/migration/provider-parser.ts",
    "services/plugin-service/hook-api.ts",
    "services/plugin-service/plugin-types.ts",
    "services/plugin-service/plugin-types/hook-types.ts",
    "services/ports/config.ts",
    "services/ports/pi-engine.ts",
    "services/ports/session.ts",
    "services/preset-service.ts",
    "services/provider-config-helper.ts",
    "services/session-history.ts",
    "services/session/event-interpreter.ts",
    "services/session/replicated-states.config.ts",
    "services/session/session-fork.ts",
    "services/session/session-lifecycle.ts",
    "services/session/session-service.ts",
    "services/session/types.ts",
    "services/skill-dirs.ts",
    "services/skill-registry.ts",
    "services/startup-background-init.ts",
}

PI_TYPE_RE = re.compile(r"\bPi[A-Z]\w*")


def strip_comments(text: str) -> str:
    """剥离块注释与行注释（保守近似：字符串字面量内的 // 不处理——PiXxx 命中已足够精确）。"""
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
        # 截断行注释（不处理 '://' 内的 // —— URL 中无 PiXxx 标识符风险）
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


def rel_to_runtime_src(p: Path) -> str:
    return p.relative_to(PROJECT_ROOT / "packages/runtime/src").as_posix()


def main() -> int:
    violations = []
    for scan_dir in SCAN_DIRS:
        for f in sorted(scan_dir.rglob("*.ts")):
            if f.name.endswith(".test.ts") or "__tests__" in f.parts:
                continue
            rel = rel_to_runtime_src(f)
            if rel in ALLOWLIST_FILES:
                continue
            stripped = strip_comments(f.read_text(encoding="utf-8", errors="replace"))
            for m in PI_TYPE_RE.finditer(stripped):
                violations.append(f"{rel}: 标识符 `{m.group(0)}`（PiXxx 类型只许 infra/pi 内部，翻译后进 services）")
                break  # 每文件报首个即可

    if violations:
        print("[check_pi_type_leak] 发现 PiXxx 类型泄漏（docs/architecture/runtime-layering.md 边界规则）：")
        for v in violations:
            print(f"  - {v}")
        print("修复方向：pi 原始类型/事件经 infra/pi/pi-events.ts 翻译为内部类型后供 services 消费。")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
