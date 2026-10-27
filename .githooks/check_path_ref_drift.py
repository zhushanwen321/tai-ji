#!/usr/bin/env python3
# 路径引用漂移检查：staged 变更删除/移动了文件时，全仓代码与脚本范围 grep 旧路径的
# 字符串残留引用——检查触发正则 / 测试 fixture / 构建与钩子脚本里内嵌的路径不随迁移
# 更新 = 防线静默失效（钩子不触发、测试 ENOENT，要到 CI 或构建才暴露；v0.10.14 轮
# 实例：markdown-sanitize.ts 迁 renderer→ui 后 install-hooks.sh 触发正则与检查测试
# fixture 仍指老路径）。
#
# 匹配口径：旧路径去扩展名的完整相对串；正则转义形态（`foo\.ts`）与普通形态同判
# （模式中 `.` 匹配字面 `.` 或 `\.`）。只查 tracked 文本文件，docs/ 排除（历史叙述
# 引用旧位置合法，其映射面由 check-doc-symbol-drift.mjs 管辖）。
#
# 豁免：PATH_REF_EXEMPT（下方登记表，唯一登记处，逐条附理由）——仅限「引用语义
# 合理保留」的条目；新豁免须先在此登记再加白，禁止改检查逻辑绕过。
#
# 用法：node/pre-commit 直跑 `python3 .githooks/check_path_ref_drift.py`；staged 无
# 删除/移动时零成本放行。

from __future__ import annotations
import re
import subprocess
import sys

# (旧路径, 引用文件完整相对路径) → 理由。按完整路径精确匹配。空表为常态；登记即声明「该引用不随迁移更新是有意为之」。
PATH_REF_EXEMPT = {
    # 退役守卫检查（scripts/check-wool-retirement.mjs）：断言已删除的羊毛界面/类型文件保持
    # 不存在（防复活），引用即检查语义本身
    ("packages/renderer/src/components/settings/provider/WoolWizard/WoolWizard.vue",
     "scripts/check-wool-retirement.mjs"): "retirement-guard",
    ("packages/renderer/src/components/settings/provider/WoolWizard/WoolEntryCard.vue",
     "scripts/check-wool-retirement.mjs"): "retirement-guard",
    ("packages/renderer/src/components/settings/provider/__tests__/WoolWizard.test.ts",
     "scripts/check-wool-retirement.mjs"): "retirement-guard",
    ("packages/renderer/src/composables/features/settings/useWool.ts",
     "scripts/check-wool-retirement.mjs"): "retirement-guard",
    ("packages/renderer/src/composables/features/settings/useWoolEntries.ts",
     "scripts/check-wool-retirement.mjs"): "retirement-guard",
    ("packages/renderer/src/composables/features/settings/useWoolWizard.ts",
     "scripts/check-wool-retirement.mjs"): "retirement-guard",
    ("packages/renderer/src/composables/features/settings/__tests__/useWool.test.ts",
     "scripts/check-wool-retirement.mjs"): "retirement-guard",
    ("packages/renderer/src/i18n/locales/zh-CN/wool.ts",
     "scripts/check-wool-retirement.mjs"): "retirement-guard",
    ("packages/renderer/src/i18n/locales/en-US/wool.ts",
     "scripts/check-wool-retirement.mjs"): "retirement-guard",
    ("packages/shared/src/wool.ts",
     "packages/shared/src/__tests__/wool.test.ts"): "retirement-guard",
}

SCAN_PATHSPEC = [
    ".",
    ":(exclude)docs",
    ":(exclude)pnpm-lock.yaml",
    # 自排除：PATH_REF_EXEMPT 登记行含已删路径字面量，属登记数据非残留引用
    ":(exclude).githooks/check_path_ref_drift.py",
]


def staged_removed_paths():
    """staged 删除(D)/重命名(R*)的旧路径清单。"""
    out = subprocess.run(
        ["git", "diff", "--cached", "--name-status", "--diff-filter=RD"],
        capture_output=True, text=True,
    )
    if out.returncode != 0:
        print(f"[path-ref-drift] git diff 失败：{out.stderr.strip()}")
        sys.exit(2)
    paths = []
    for line in out.stdout.splitlines():
        parts = line.split("\t")
        if parts[0].startswith("R") and len(parts) >= 3:
            paths.append(parts[1])  # rename：旧路径在第 2 列
        elif parts[0] == "D" and len(parts) >= 2:
            paths.append(parts[1])
    return paths


def path_to_pattern(rel_path):
    """旧路径 → 残留引用正则：去扩展名字面串，`.` 匹配 `.` 或 `\\.`（正则转义形态同判）。"""
    stem = re.sub(r"\.[^./]+$", "", rel_path)
    # 替换产物 `\\?\\.`（ERE）= 可选前置反斜杠 + 字面点，普通 `foo.ts` 与源码正则
    # 转义 `foo\\.ts` 同判；写成 `\\\\.`（字面反斜杠 + 任意字符）会让含点 stem
    # （如 X.test.ts 去扩展名后的 X.test）的普通形态永不命中。
    return re.escape(stem).replace("\\.", "\\\\?\\.")


def self_check_pattern():
    """匹配口径探针（纯内存，毫秒级）：stem 含点的路径（如 X.test.ts）构造出的
    pattern 必须普通形态与正则转义形态同判（文件头「匹配口径」的机器化）。检查器
    自身口径破损 = 防线静默失效，与被检查对象同类故障，须 fail-fast。"""
    pattern = path_to_pattern("pkg/dir/Example.test.ts")
    for label, sample in [
        ("普通形态", 'ref "pkg/dir/Example.test.ts"'),
        ("正则转义形态", 'ref "pkg/dir/Example\\.test.ts"'),
    ]:
        if not re.search(pattern, sample):
            print(f"[path-ref-drift] 匹配口径自检失败：{label}样例 {sample!r} 未被 "
                  f"pattern {pattern!r} 命中；禁止改 path_to_pattern 的同判口径绕过，"
                  "确需调整先同步文件头「匹配口径」声明与本探针")
            sys.exit(2)


def points_at_sibling_only(line, old):
    """命中行是否只指向同 stem 不同扩展名的兄弟文件（如旧 preload.js 删除后行内引用
    全部是 preload.ts）——去扩展名匹配的副作用误伤，非残留，豁免。行内含任一旧扩展名
    具体引用、或只有裸 stem 引用（指向不明，旧文件删除后失效）时按残留处理。"""
    stem = re.sub(r"\.[^./]+$", "", old)
    old_ext = old[len(stem):]
    exts = re.findall(re.escape(stem) + r"\.([A-Za-z0-9]+)", line)
    return bool(exts) and all("." + e != old_ext for e in exts)


def grep_pattern(pattern):
    out = subprocess.run(
        ["git", "grep", "-E", "-I", "-n", "-e", pattern, "--", *SCAN_PATHSPEC],
        capture_output=True, text=True,
    )
    if out.returncode not in (0, 1):
        print(f"[path-ref-drift] git grep 失败：{out.stderr.strip()}")
        sys.exit(2)
    return [l for l in out.stdout.splitlines() if l.strip()]


def main():
    removed = staged_removed_paths()
    if not removed:
        print("[path-ref-drift] OK：staged 无删除/移动文件，跳过路径残留检查")
        return

    self_check_pattern()

    hits = []
    for old in removed:
        pattern = path_to_pattern(old)
        for line in grep_pattern(pattern):
            if points_at_sibling_only(line, old):
                continue
            ref_file = line.split(":", 1)[0]
            if (old, ref_file) in PATH_REF_EXEMPT:
                continue
            hits.append((old, line))

    if hits:
        print("[path-ref-drift] 失败：删除/移动的旧路径仍有残留引用（防线/配置静默失效风险）")
        for old, line in hits:
            print(f"  ✗ {line}")
            print(f"    （旧路径 {old}）")
        print("[FIX] 逐条把引用更新为迁移后的新路径；确属有意保留的引用，"
              "先在 .githooks/check_path_ref_drift.py 的 PATH_REF_EXEMPT 登记理由后重试。")
        sys.exit(1)
    print(f"[path-ref-drift] OK：{len(removed)} 个删除/移动路径无残留引用")


if __name__ == "__main__":
    main()
