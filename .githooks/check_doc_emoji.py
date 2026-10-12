#!/usr/bin/env python3
"""文档 emoji 检测：README 系文档与 Release notes 禁装饰 emoji。

两个消费方共享同一实现（检测逻辑 SSOT，禁止复制第二份）：
- pre-commit（install-hooks.sh 生成段）：传 staged 的 README.md / README_EN.md，
  拦 README 面向用户文档的装饰 emoji 回潮
- merge 流程 release.sh：传 release notes 文件，写入 GitHub Release 前校验

拦截范围 = 装饰性 emoji 及其呈现字符：主 emoji 区（1F000-1FAFF，含国旗/扩展）、
杂项符号 + Dingbats（2600-27BF，含 ✅❌⚠✓✗）、2B00-2BFF（⭐⬆ 等）、VS16（FE0F）。
明确不拦（功能性排版符号，不是 emoji）：2300-23FF（⌘ 等 Mac 键位符号）、
2190-21FF（→ 等排版箭头）。docs/ 下技术文档的 ✓/⚠/✗ 功能符号不在本检查范围。

用法：
    python3 check_doc_emoji.py <file> [<file>...]

退出码：0 = 干净；1 = 命中 emoji；2 = 用法/环境错误
"""

import re
import sys

EMOJI_PATTERN = re.compile(
    "["
    "\U0001F000-\U0001FAFF"  # 主 emoji 区（含区域指示符国旗、Supplement/Extended）
    "\U00002600-\U000027BF"  # 杂项符号 + Dingbats（✅ ❌ ⚠ ✓ ✗ ✂ ✈ …）
    "\U00002B00-\U00002BFF"  # ⭐ ⬆ ⬇ 等
    "\U0000FE0F"             # Variation Selector-16（emoji 呈现选择子）
    "]"
)


def scan_file(path):
    """返回 [(lineno, emoji_chars, line_text)]，同一行多字符聚合为一条。"""
    hits = []
    with open(path, encoding="utf-8") as f:
        for lineno, line in enumerate(f, 1):
            found = EMOJI_PATTERN.findall(line)
            if found:
                hits.append((lineno, "".join(found), line.rstrip()))
    return hits


def main(argv):
    if len(argv) < 2:
        print("用法: python3 check_doc_emoji.py <file> [<file>...]", file=sys.stderr)
        print("  pre-commit 形态: 传 staged 的 README.md / README_EN.md", file=sys.stderr)
        print("  release notes 形态: merge/scripts/release.sh 写入 GitHub Release 前传 notes 文件", file=sys.stderr)
        return 2

    total = 0
    for path in argv[1:]:
        try:
            hits = scan_file(path)
        except OSError as exc:
            print(f"[ERROR] 无法读取 {path}: {exc}", file=sys.stderr)
            return 2
        for lineno, chars, line_text in hits:
            print(f"[ERROR] {path}:{lineno} 含 emoji: {chars}")
            print(f"    {line_text.strip()}")
            total += 1

    if total:
        print(f"\n共 {total} 处。")
        print("[FIX] 删除 emoji 或改为文字表述后重试（docs/ 下技术功能符号不在本检查范围）。")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
