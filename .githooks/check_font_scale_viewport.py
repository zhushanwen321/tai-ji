#!/usr/bin/env python3
"""
视口字号自动档禁令检查（demo 固定 px 视觉权威，字号不随窗口宽度漂移）

规则（三个字号 token 文件）：
  1. 禁止出现 `font-scale-mq` 字面量（视口媒体查询自动档位变量，已裁决删除）；
  2. CSS 文件内 @media 块禁止声明 --font-scale-* / --text-* 自定义属性
     （视口驱动的字号缩放通道整体禁入；prefers-reduced-motion 等非字号
     @media 不受影响）。

管辖区（字号 token 的唯一三处权威文件）：
  - packages/renderer/src/style.css（值真值）
  - packages/mobile-renderer/src/styles/tokens.css（mobile 镜像副本）
  - docs/DESIGN.md（投影）

用户字号档位（--font-scale-u）与分区档位（--font-scale-sidebar/chat/drawer）是
合法机制，不在禁令范围。

运行方式:
  python3 .githooks/check_font_scale_viewport.py

退出码:
  0 — 通过（或任一文件不存在）
  2 — 有违规
"""

import sys
from pathlib import Path

RED = '\033[0;31m'
GREEN = '\033[0;32m'
YELLOW = '\033[1;33m'
NC = '\033[0m'

# (路径, 是否做 @media 块级检查)；md 文件只查字面量（投影漂移面）
GUARDED_FILES = [
    ('packages/renderer/src/style.css', True),
    ('packages/mobile-renderer/src/styles/tokens.css', True),
    ('docs/DESIGN.md', False),
]

BANNED_LITERAL = 'font-scale-mq'
# 'font-size:' 带冒号匹配声明形态，避开 data-font-size 属性选择器的子串误伤
BANNED_MEDIA_PROPS = ('--font-scale-', '--text-', 'font-size:')


def is_comment_line(stripped: str) -> bool:
    return stripped.startswith(('/*', '*', '//'))


def check_literal(filepath: str) -> list[str]:
    """规则 1：禁用字面量逐行扫描"""
    path = Path(filepath)
    if not path.exists():
        return []
    violations = []
    for lineno, line in enumerate(path.read_text(encoding='utf-8').splitlines(), 1):
        stripped = line.strip()
        if BANNED_LITERAL in stripped:
            violations.append(f'{filepath}:{lineno}: 出现禁用字面量 {BANNED_LITERAL}：{stripped}')
    return violations


def check_media_blocks(filepath: str) -> list[str]:
    """规则 2：@media 块内声明字号 token 即违规（花括号深度扫描）。

    行内归属按「计入本行开括号后的深度」判定：多行块的块体行与
    单行块（@media ... { :root { --x: 1; } }）同样命中——单行块净深度为 0，
    若按处理后深度判定会漏检。
    """
    path = Path(filepath)
    if not path.exists():
        return []
    violations = []
    depth = 0
    media_depth = None  # 进入 @media 块时的外层深度；None = 当前不在 @media 块内
    for lineno, line in enumerate(path.read_text(encoding='utf-8').splitlines(), 1):
        stripped = line.strip()
        if media_depth is None and stripped.startswith('@media'):
            media_depth = depth
        depth_open = depth + line.count('{')
        in_media_body = media_depth is not None and depth_open > media_depth
        if (
            in_media_body
            and not is_comment_line(stripped)
            and any(prop in stripped for prop in BANNED_MEDIA_PROPS)
            and ':' in stripped
        ):
            violations.append(f'{filepath}:{lineno}: @media 块内声明字号 token：{stripped}')
        depth += line.count('{') - line.count('}')
        if media_depth is not None and depth <= media_depth:
            media_depth = None
    return violations


def main() -> int:
    violations: list[str] = []
    for filepath, check_media in GUARDED_FILES:
        if not Path(filepath).exists():
            print(f'{YELLOW}[SKIP] {filepath} 不存在{NC}')
            continue
        violations.extend(check_literal(filepath))
        if check_media:
            violations.extend(check_media_blocks(filepath))

    if not violations:
        print(f'{GREEN}[OK] 字号 token 三文件无视口自动档（{BANNED_LITERAL} / 字号 @media）残留{NC}')
        return 0

    print(f'{RED}[ERROR] 视口字号自动档禁令检查失败（{len(violations)} 处）：{NC}')
    print()
    for v in violations:
        print(f'  {RED}{v}{NC}')
    print()
    print(f'{YELLOW}修复方式：{NC}')
    print(f'  视口媒体查询驱动的字号缩放（{BANNED_LITERAL} 自动档 / @media 内声明 --font-scale-*、--text-*）')
    print(f'  已裁决删除：demo 视觉权威为固定 px，字号只由用户全局档位（--font-scale-u）')
    print(f'  与分区档位（--font-scale-sidebar/chat/drawer）驱动，不随窗口宽度漂移。')
    print(f'  删除违规声明与对应 @media 块；用户/分区档位机制见 style.css 字号 scale 段注释。')
    return 2


if __name__ == '__main__':
    sys.exit(main())
