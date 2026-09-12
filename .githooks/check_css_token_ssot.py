#!/usr/bin/env python3
"""
CSS token SSOT 一致性检查

规则：packages/renderer/src/style.css 的 :root 中定义的 CSS 变量，
必须全部能在 docs/page-design/v6-tokens.css 中找到（token 名称出现）。

目的：防止开发者在 style.css 自行追加 token（如 --reasoning），而 SSOT
（v6-tokens.css）未同步，导致双源不一致（v3 重建 Wave 1 曾发生：
style.css 有 --reasoning:#a78bfa，SSOT 未收录）。

[2026-09-13] SSOT 由 design-tokens.md 改为 v6-tokens.css（css 唯一权威，
ADR-0066；原 design-tokens.md 已删除）。值真值在 style.css（含行内 why
注释），本守卫只做「新增 token 必须登记」的名字集合校验。

豁免：以 `_` 开头的内部变量（非设计 token，如布局辅助）。

运行方式:
  python3 .githooks/check_css_token_ssot.py

退出码:
  0 — 通过（或 style.css/v6-tokens.css 不存在）
  2 — 有违规（style.css 含 SSOT 未收录的 token）
"""

import re
import sys
from pathlib import Path

RED = '\033[0;31m'
GREEN = '\033[0;32m'
YELLOW = '\033[1;33m'
NC = '\033[0m'

STYLE_CSS = 'packages/renderer/src/style.css'
DESIGN_TOKENS = 'docs/page-design/v6-tokens.css'

# 豁免：非设计 token 的 CSS 变量（布局辅助、第三方 shim 等）
# 命名约定：内部变量以 _ 开头自动豁免
INTERNAL_PREFIX = '_'


def extract_css_tokens(css_path: Path) -> set[str]:
    """从 style.css 的 :root 块提取 --xxx 变量名"""
    if not css_path.exists():
        return set()
    text = css_path.read_text(encoding='utf-8')
    # 只取 :root { ... } 内的定义（避免误抓 scoped style）
    root_match = re.search(r':root\s*\{([^}]*)\}', text, re.DOTALL)
    if not root_match:
        return set()
    root_block = root_match.group(1)
    # 匹配 --token-name:
    return set(re.findall(r'(--[a-zA-Z][\w-]*)\s*:', root_block))


def extract_ssot_tokens(md_path: Path) -> set[str]:
    """从 v6-tokens.css 提取所有出现的 --xxx"""
    if not md_path.exists():
        return set()
    text = md_path.read_text(encoding='utf-8')
    return set(re.findall(r'(--[a-zA-Z][\w-]*)', text))


def main() -> int:
    css_path = Path(STYLE_CSS)
    md_path = Path(DESIGN_TOKENS)

    if not css_path.exists():
        print(f"{YELLOW}[SKIP] {STYLE_CSS} 不存在{NC}")
        return 0
    if not md_path.exists():
        print(f"{YELLOW}[SKIP] {DESIGN_TOKENS} 不存在{NC}")
        return 0

    css_tokens = extract_css_tokens(css_path)
    ssot_tokens = extract_ssot_tokens(md_path)

    # 过滤内部变量
    css_tokens = {t for t in css_tokens if not t.lstrip('-').startswith(INTERNAL_PREFIX)}

    missing = css_tokens - ssot_tokens

    if not missing:
        print(f"{GREEN}[OK] style.css 的 {len(css_tokens)} 个 token 全部收录于 v6-tokens.css SSOT{NC}")
        return 0

    print(f"{RED}[ERROR] style.css 含 {len(missing)} 个 SSOT 未收录的 token：{NC}")
    print()
    for t in sorted(missing):
        print(f"  {RED}{t}{NC}")
    print()
    print(f"{YELLOW}修复方式：{NC}")
    print(f"  将上述 token 补入 {DESIGN_TOKENS} 对应章节（含 值/用途/来源），")
    print(f"  或从 style.css 移除（若为临时/调试变量）。")
    print()
    print(f"\033[0;31m[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。\033[0m")
    return 2


if __name__ == '__main__':
    sys.exit(main())
