#!/usr/bin/env python3
"""
Pi Extension Tool Schema 顶层 Object 合规检查（OpenAI 兼容性）

规则：`pi.registerTool({ parameters, ... })` 的 `parameters` 序列化后顶层必须含
`type:"object"`。OpenAI function calling 规范要求 parameters 顶层是 object，
**禁止**顶层 `Type.Union` / `Type.Intersect` / `Type.Composite`（序列化为 anyOf/allOf，
无 type）、`Type.Array` 等。违反会导致严格 OpenAI 兼容网关 400 拒绝整个会话启动。

背景：goal_control 与 todo 曾把 `Type.Union([...])` 直接作为 `parameters`（discriminated
union 语义最自然），序列化产物顶层只有 anyOf、无 type，严格网关直接 400。改造为扁平
`Type.Object` + action 字段级 `Type.Union`（等价 enum，序列化为嵌套 anyOf 合规）+
`Static<typeof Schema>` 派生类型 + 运行时分枝校验。范式见 scheduler 的 ScheduleControlParams。
设计文档：docs/extensions/tool-schema-openai-compat.md。

检测策略（静态正则 + 跨文件 parameters 引用验证）：
  1. 收集所有顶层 `const X = Type.Union([` 声明（带变量名 + 位置）；
  2. 全量扫描 "parameters: X" 形式的引用；
  3. 只报"既是顶层 union、又被某 registerTool 的 parameters 直接引用"的变量。
两层过滤确保零误报——合法的"可复用字段级 union 子 schema"（如 ask-user 的
inputOptionElement，嵌在 Type.Array 元素位，序列化为字段级嵌套 anyOf 合规）不被
parameters 直接引用，自然不报。字段级 `action: Type.Union(` 行首是冒号非 const 声明，
层1正则天然不匹配。

运行方式:
  python3 .githooks/check_tool_schema.py

退出码:
  0 — 通过（所有 registerTool 的 parameters 顶层均为 Object）
  2 — 违规（某 parameters 顶层是 Type.Union）
"""

import re
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
EXTENSIONS_DIR = PROJECT_ROOT / 'extensions'

# 顶层 schema 赋值：行首 const/let/var X = Type.Union(
# 不匹配字段级 `action: Type.Union(`（无 const 前缀，冒号而非等号）
# 不匹配 Type.Optional(Type.Union(...))（前缀是 ( 不是 = ，且无 const 声明）
TOPLEVEL_UNION_RE = re.compile(
    r'^[ \t]*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*Type\.Union\s*\(',
    re.MULTILINE,
)

# registerTool 的 parameters 引用：`parameters: <name>`（捕获 name）
# 匹配 `parameters: GoalControlParams` / `parameters: InputSchema` 等
PARAMETERS_REF_RE = re.compile(r'\bparameters\s*:\s*([A-Za-z_$][\w$]*)')


def source_files() -> list[Path]:
    """extensions/ 下的源码 .ts（排除测试/生成物）"""
    if not EXTENSIONS_DIR.exists():
        return []
    result = []
    for ts_file in sorted(EXTENSIONS_DIR.rglob('*.ts')):
        parts = set(ts_file.parts)
        if parts & {'node_modules', 'dist', '__tests__'}:
            continue
        name = ts_file.name
        if name.endswith('.test.ts') or name.endswith('.spec.ts'):
            continue
        result.append(ts_file)
    return result


def collect_toplevel_unions(files: list[Path]) -> dict[str, list[tuple[str, int]]]:
    """返回 {var_name: [(rel_path, line_no), ...]} 所有顶层 Type.Union 赋值"""
    unions: dict[str, list[tuple[str, int]]] = {}
    for ts_file in files:
        text = ts_file.read_text(encoding='utf-8', errors='ignore')
        for match in TOPLEVEL_UNION_RE.finditer(text):
            var_name = match.group(1)
            line_no = text[:match.start()].count('\n') + 1
            rel = ts_file.relative_to(PROJECT_ROOT)
            unions.setdefault(var_name, []).append((str(rel), line_no))
    return unions


def collect_parameters_refs(files: list[Path]) -> set[str]:
    """返回被 `parameters: X` 引用的变量名集合"""
    refs: set[str] = set()
    for ts_file in files:
        text = ts_file.read_text(encoding='utf-8', errors='ignore')
        for match in PARAMETERS_REF_RE.finditer(text):
            refs.add(match.group(1))
    return refs


def main() -> int:
    files = source_files()
    unions = collect_toplevel_unions(files)
    refs = collect_parameters_refs(files)

    errors: list[str] = []
    # 只报：既是顶层 union、又被 parameters 直接引用的变量
    for var_name, locs in sorted(unions.items()):
        if var_name not in refs:
            continue
        for rel, line_no in locs:
            errors.append(
                f'[ERROR] {rel}:{line_no} `{var_name} = Type.Union(...)` '
                f'被 registerTool 的 parameters 引用'
            )
            errors.append(
                f'  顶层 Type.Union 序列化为 {{anyOf:[...]}} 无 type 字段，'
                f'违反 OpenAI function calling 规范（parameters 顶层必须是 type:"object"），'
                f'严格网关 400 拒绝整个会话启动。'
            )
            errors.append(
                f'  修复：改为扁平 Type.Object + action 字段级 Type.Union（等价 enum）'
                f'+ 各分支字段 Type.Optional + Static<typeof Schema> 派生类型 + 运行时分枝校验。'
            )
            errors.append(
                f'  范式参考：extensions/scheduler/src/tool.ts 的 ScheduleControlParams；'
                f'规范见 docs/extensions/extension-conventions.md「Tool 设计」。'
            )

    if errors:
        for e in errors:
            print(e)
        print()
        print('\033[0;31m[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。\033[0m')
        return 2

    print('[OK] Pi extension tool schema 顶层 Object 合规检查通过（所有 parameters 顶层均为 Object）')
    return 0


if __name__ == '__main__':
    sys.exit(main())
