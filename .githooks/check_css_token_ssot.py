#!/usr/bin/env python3
"""
CSS token SSOT 一致性检查（DESIGN.md frontmatter 投影 ↔ style.css 值真值）

规则：docs/DESIGN.md frontmatter（colors.* / rounded.*）声明的值，
必须与 packages/renderer/src/style.css :root 中对应 CSS 变量的值逐字相等。

[2026-09-13] 页面设计目录（docs/page-design/）退役后的新形态：
值真值 = style.css（运行时唯一源）；DESIGN.md = 视觉权威文档，其 frontmatter
是面向 AI/impeccable 消费的关键值投影。本守卫保证投影不漂移——此前
v6-tokens.css 时代的名称集合校验只能防「漏登记」，防不了「值漂移」，本版
升级为值相等比对。

豁免：以 `_` 开头的内部变量不参与；DESIGN.md 未声明的 style.css token
不检查（style.css 行内注释即其权威叙事，代码即注释）。

运行方式:
  python3 .githooks/check_css_token_ssot.py

退出码:
  0 — 通过（或任一文件不存在）
  2 — 有不一致（值不匹配 / 映射变量在 style.css 缺失）
"""

import re
import sys
from pathlib import Path

RED = '\033[0;31m'
GREEN = '\033[0;32m'
YELLOW = '\033[1;33m'
NC = '\033[0m'

STYLE_CSS = 'packages/renderer/src/style.css'
DESIGN_MD = 'docs/DESIGN.md'

# DESIGN.md frontmatter 键 → style.css :root 变量名
FRONTMATTER_TOKEN_MAP = {
    'colors.bg': '--bg',
    'colors.surface': '--surface',
    'colors.fg': '--neutral-fg',
    'colors.muted': '--neutral-mid',
    'colors.border': '--border',
    'colors.accent': '--accent',
    'colors.success': '--success',
    'colors.warn': '--warn',
    'colors.danger': '--danger',
    'rounded.sm': '--radius-sm',
    'rounded.md': '--radius',
    'rounded.card': '--radius-card',
    'rounded.lg': '--radius-lg',
}


def normalize(value: str) -> str:
    """值归一化：去引号/空白/大小写（hex 比较忽略大小写）"""
    v = value.strip().strip('"').strip("'")
    return re.sub(r'\s+', ' ', v).lower()


def extract_frontmatter_tokens(md_path: Path) -> dict[str, str]:
    """从 DESIGN.md YAML frontmatter 提取 colors.*/rounded.* 两层键值"""
    if not md_path.exists():
        return {}
    text = md_path.read_text(encoding='utf-8')
    fm = re.match(r'^---\s*\n(.*?)\n---\s*\n', text, re.DOTALL)
    if not fm:
        return {}
    tokens: dict[str, str] = {}
    section = ''
    for line in fm.group(1).splitlines():
        top = re.match(r'^(\w+):\s*$', line)
        if top:
            section = top.group(1)
            continue
        kv = re.match(r'^\s{2}(\w[\w-]*):\s*(.+?)\s*$', line)
        if kv and section in ('colors', 'rounded'):
            tokens[f'{section}.{kv.group(1)}'] = kv.group(2)
    return tokens


def extract_css_values(css_path: Path) -> dict[str, str]:
    """从 style.css :root 块提取 --name → value（剥离行内注释）"""
    if not css_path.exists():
        return {}
    text = css_path.read_text(encoding='utf-8')
    root_match = re.search(r':root\s*\{([^}]*)\}', text, re.DOTALL)
    if not root_match:
        return {}
    values: dict[str, str] = {}
    for m in re.finditer(r'(--[a-zA-Z][\w-]*)\s*:\s*([^;]+);', root_match.group(1)):
        values[m.group(1)] = normalize(m.group(2))
    return values


def main() -> int:
    css_path = Path(STYLE_CSS)
    md_path = Path(DESIGN_MD)

    if not css_path.exists() or not md_path.exists():
        print(f"{YELLOW}[SKIP] {STYLE_CSS} 或 {DESIGN_MD} 不存在{NC}")
        return 0

    fm_tokens = extract_frontmatter_tokens(md_path)
    css_values = extract_css_values(css_path)

    mismatches: list[tuple[str, str, str]] = []
    for key, var in FRONTMATTER_TOKEN_MAP.items():
        if key not in fm_tokens:
            mismatches.append((key, '(DESIGN.md 未声明)', css_values.get(var, '(style.css 亦缺失)')))
            continue
        if var not in css_values:
            mismatches.append((key, fm_tokens[key], f'{var} 在 style.css 缺失'))
            continue
        if normalize(fm_tokens[key]) != css_values[var]:
            mismatches.append((key, fm_tokens[key], css_values[var]))

    if not mismatches:
        print(f"{GREEN}[OK] DESIGN.md frontmatter {len(FRONTMATTER_TOKEN_MAP)} 个投影值与 style.css 逐字一致{NC}")
        return 0

    print(f"{RED}[ERROR] DESIGN.md 投影值与 style.css 不一致（{len(mismatches)} 处）：{NC}")
    print()
    for key, fm_val, css_val in mismatches:
        print(f"  {RED}{key}{NC}: DESIGN.md = {fm_val}  |  style.css = {css_val}")
    print()
    print(f"{YELLOW}修复方式：{NC}")
    print(f"  值真值在 {STYLE_CSS}（运行时唯一源）——先改 style.css，")
    print(f"  再把 {DESIGN_MD} frontmatter 同步为一致值；两端必须逐字相等。")
    print()
    print(f"\033[0;31m[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。\033[0m")
    return 2


if __name__ == '__main__':
    sys.exit(main())
