#!/usr/bin/env python3
"""
CSS 规范检查：确保 style.css 不含组件级样式

规则：style.css 只允许包含以下内容：
  1. CSS 变量（:root / [data-theme]）
  2. Base reset（* 选择器、body、html、::-webkit-scrollbar 等）
  3. 全局状态类白名单（.hidden）
  4. @media / :focus-visible / prefers-reduced-motion

禁止：新的 .xxx-yyy 组件样式规则出现在 style.css 中

运行方式:
  python3 .githooks/check_css_tokens.py

退出码:
  0 — 通过
  2 — 有违规
"""

import re
import sys
from pathlib import Path

# 允许出现在 style.css 中的 class（白名单）
ALLOWED_CLASSES = {
    'hidden',
}

# [HISTORICAL] 全局动画原语类白名单（与 @keyframes 同层，非组件级样式）
# 这类 class 是跨多组件共享的过渡/动画原语，特征：
#   1. 被多个组件消费（如 .reka-popover-transition 被 Popover/Select/HoverCard 共用）
#   2. 使用 Tailwind 无法表达的 CSS 特性（@starting-style、[data-state] 属性选择器）
#   3. 属于 style.css 的「全局动画原语」层，与既有 @keyframes（spin/pulse-*/taiji-spin 等）并列
# 判据登记于本地工作流档案（2026-08-09 animation audit，overlay 进出场过渡篇）。
# 误报背景：原规则把所有含 `-` 的 class 选择器判为「组件级」，但全局共享原语不在其列。
# 新增此类 class 时必须在此登记并确认满足上述三条特征，禁止为单组件样式开口子。
ALLOWED_GLOBAL_ANIMATION_CLASSES = {
    'reka-popover-transition',   # popover 族进出场（Popover/Select/HoverCard 共用，跟随触发点 scale）
    'reka-dialog-transition',    # dialog 居中 modal 进出场（transform 含 translate 居中 + scale）
    'reka-overlay-transition',   # dialog 遮罩纯 opacity 过渡
}

RED = '\033[0;31m'
GREEN = '\033[0;32m'
YELLOW = '\033[1;33m'
NC = '\033[0m'

STYLE_CSS = 'packages/renderer/src/style.css'


def check_style_css(filepath: str) -> list[str]:
    """检查 style.css 中是否出现组件级 class"""
    path = Path(filepath)
    if not path.exists():
        return []

    lines = path.read_text(encoding='utf-8').splitlines()
    violations = []

    for i, line in enumerate(lines, 1):
        stripped = line.strip()

        # 跳过空行、注释、@规则
        if not stripped or stripped.startswith('/*') or stripped.startswith('*') or stripped.startswith('//'):
            continue
        if stripped.startswith('@') or stripped.startswith('}') or stripped.startswith(':'):
            continue

        # 检测 .xxx-yyy { 形式的规则（组件级 class 特征：含 -）
        m = re.match(r'^\.([a-z][a-z0-9_-]*)\s*\{', stripped)
        if m:
            cls = m.group(1)
            if cls not in ALLOWED_CLASSES and cls not in ALLOWED_GLOBAL_ANIMATION_CLASSES and '-' in cls:
                violations.append(
                    f"  {filepath}:{i}  .{cls} {{ — 组件级样式不应出现在 style.css 中，"
                    f"应使用 Tailwind 工具类或 <style scoped>"
                )

    return violations


def check_scoped_styles(files: list[str]) -> list[str]:
    """
    检查 .vue 文件的 <style scoped> 是否包含 Tailwind 可替代的属性。
    只警告，不报错（因为有些场景确实需要）。
    """
    # Tailwind 可轻松替代的 CSS 属性
    TW_COMPATIBLE_PROPS = {
        'display', 'flex-direction', 'flex-wrap', 'justify-content', 'align-items',
        'gap', 'padding', 'padding-top', 'padding-bottom', 'padding-left', 'padding-right',
        'margin', 'margin-top', 'margin-bottom', 'margin-left', 'margin-right',
        'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
        'border-radius', 'border', 'border-top', 'border-bottom', 'border-left', 'border-right',
        'font-size', 'font-weight', 'font-family', 'line-height', 'letter-spacing',
        'text-align', 'text-transform', 'white-space', 'word-break',
        'color', 'background', 'background-color', 'opacity',
        'cursor', 'overflow', 'overflow-x', 'overflow-y',
        'position', 'top', 'bottom', 'left', 'right', 'z-index',
        'transition', 'transform', 'box-shadow',
    }

    warnings = []
    for filepath in files:
        path = Path(filepath)
        if not path.exists() or not path.suffix == '.vue':
            continue

        content = path.read_text(encoding='utf-8')
        # 提取 <style scoped> 部分
        in_scoped = False
        scoped_lines = []
        for line in content.splitlines():
            if '<style scoped>' in line:
                in_scoped = True
                continue
            if '</style>' in line and in_scoped:
                in_scoped = False
                continue
            if in_scoped:
                scoped_lines.append(line)

        if not scoped_lines:
            continue

        for i, line in enumerate(scoped_lines, 1):
            stripped = line.strip()
            # 检查是否是 CSS 属性声明
            m = re.match(r'^([a-z-]+)\s*:', stripped)
            if m:
                prop = m.group(1)
                if prop in TW_COMPATIBLE_PROPS:
                    # 检查是否在伪元素/后代选择器块内（合法场景）
                    # 简单判断：如果该行前面有 { 且不是 .xxx {，则可能是后代选择器
                    warnings.append(
                        f"  {filepath}:<style>:{i}  {prop}: — 可考虑用 Tailwind 工具类替代"
                    )

    return warnings


def main():
    files = sys.argv[1:] if len(sys.argv) > 1 else [STYLE_CSS]

    violations = []
    for f in files:
        if STYLE_CSS in f or f.endswith('style.css'):
            violations.extend(check_style_css(f))

    if violations:
        print(f'{RED}[ERROR] CSS 规范检查失败{NC}')
        print(f'{YELLOW}style.css 中发现组件级样式，应迁移到 Tailwind 工具类或 <style scoped>:{NC}')
        print()
        for v in violations:
            print(f'{RED}{v}{NC}')
        print()
        print(f'{YELLOW}规则: style.css 只放 design tokens（CSS 变量）和 base reset{NC}')
        print('\033[0;31m[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。\033[0m')
        sys.exit(2)

    # 检查 scoped style 警告（非阻塞）
    vue_files = [f for f in files if f.endswith('.vue')] if len(files) > 1 else []
    if vue_files:
        warnings = check_scoped_styles(vue_files)
        if warnings:
            print(f'{YELLOW}[WARN] <style scoped> 中有 Tailwind 可替代的属性（非阻塞）:{NC}')
            for w in warnings:
                print(f'{YELLOW}{w}{NC}')
            print()

    print(f'{GREEN}[OK] CSS 规范检查通过{NC}')
    sys.exit(0)


if __name__ == '__main__':
    main()
