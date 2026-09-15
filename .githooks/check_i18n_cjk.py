#!/usr/bin/env python3
"""
i18n CJK 残留检测（维度 B）

规则：.vue 文件 <template> 块不得含 CJK 字符（U+4E00-U+9FFF）。
豁免：HTML 注释（<!-- -->）；ALLOW_FILES 文件级豁免清单。

目的：拦截新增组件模板里的硬编码中文 UI 文案——i18n-frontend + i18n-frontend-p2
两轮排查发现 30+ 处漏网，均为此检测能覆盖的 pattern。

调用方式:
  python3 .githooks/check_i18n_cjk.py <file1.vue> <file2.vue> ...
  （无参数时扫全量 packages/renderer/src/components/**/*.vue）

退出码:
  0 — 通过
  2 — 有 CJK 残留
"""

import re
import sys
from pathlib import Path

RED = '\033[0;31m'
GREEN = '\033[0;32m'
YELLOW = '\033[1;33m'
NC = '\033[0m'

RENDERER_COMPONENTS = Path('packages/renderer/src/components')

# 文件级豁免清单（含 CJK 但属于合理使用：mock fixtures / 数据值非 UI 文案）
# 继承自 locale-sync-check.test.ts U8 的 ALLOW_FILES
ALLOW_FILES = {
    'components/panel/message-stream/gui/Card.vue',
}

# CJK Unified Ideographs U+4E00-U+9FFF
CJK_RE = re.compile(r'[\u4e00-\u9fff]')


def extract_template(source: str) -> str:
    """提取 <template> 块（贪婪匹配到第一个 </template>）"""
    m = re.search(r'<template>([\s\S]*?)</template>', source)
    return m.group(1) if m else ''


def strip_html_comments(tpl: str) -> str:
    """移除 HTML 注释（<!-- ... -->）"""
    return re.sub(r'<!--[\s\S]*?-->', '', tpl)


def find_cjk(vue_file: Path) -> list[tuple[int, str]]:
    """返回 [(line_number, char_preview)] 列表，无 CJK 时为空"""
    source = vue_file.read_text(encoding='utf-8', errors='ignore')
    tpl = extract_template(source)
    if not tpl:
        return []
    tpl_clean = strip_html_comments(tpl)
    hits = []
    for i, line in enumerate(tpl_clean.split('\n'), 1):
        chars = CJK_RE.findall(line)
        if chars:
            hits.append((i, ''.join(chars[:5])))
    return hits


def main() -> int:
    # 确定要检查的文件列表
    args = sys.argv[1:]
    if args:
        files = [Path(a) for a in args if a.endswith('.vue')]
    else:
        # 无参数时扫全量（CI / 手动调用场景）
        files = sorted(RENDERER_COMPONENTS.rglob('*.vue'))

    if not files:
        print(f"{GREEN}[OK] 无 .vue 文件需要检查{NC}")
        return 0

    violations: dict[str, list[tuple[int, str]]] = {}
    for f in files:
        # 计算相对 packages/renderer/src/ 的路径用于 ALLOW_FILES 匹配
        try:
            rel = str(f).split('/packages/renderer/src/', 1)[-1] if '/packages/renderer/src/' in str(f) else str(f)
        except Exception:
            rel = str(f)
        if rel in ALLOW_FILES:
            continue
        if not f.exists():
            continue
        hits = find_cjk(f)
        if hits:
            violations[str(f)] = hits

    if not violations:
        print(f"{GREEN}[OK] i18n CJK 检查通过（{len(files)} 个 .vue 文件无 CJK 残留）{NC}")
        return 0

    print(f"{RED}[ERROR] {len(violations)} 个 .vue 文件模板含 CJK 字符：{NC}")
    print()
    for file, hits in sorted(violations.items()):
        rel = Path(file).relative_to(Path.cwd()) if str(file).startswith(str(Path.cwd())) else file
        print(f"  {rel}:")
        for line_no, preview in hits:
            print(f"    {RED}第 {line_no} 行{NC}: {preview}")
    print()
    print(f"{YELLOW}修复方式：{NC}")
    print(f"  将模板里的硬编码中文替换为 {{{{ t('i18n.key') }}}} 调用，")
    print(f"  并在 zh-CN/en-US locale 文件同步新增对应 key。")
    print(f"  如属合理使用（mock fixtures / 数据值），加入 check_i18n_cjk.py 的 ALLOW_FILES。")
    print()
    print(f"\033[0;31m[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。\033[0m")
    return 2


if __name__ == '__main__':
    sys.exit(main())
