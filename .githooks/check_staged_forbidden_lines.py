#!/usr/bin/env python3
"""
staged 新增行禁词检查（C-ext-07 / C-proc-04 的行级增量拦截）。

规则（只查 staged diff 的新增行——「存量不拦、新代码拦」的增量模式）：
  - 规则 A：extensions/ 下 .ts 新增行含 `console.warn(` / `console.error(` → 违规
    （logging-conventions.md 收敛：禁一切裸 console.*；console.log/info 已由
    install-hooks.sh §2c 拦截，本检查补齐 warn/error——存量迁移中，只拦新增）。
  - 规则 B：任意 .ts/.vue/.mjs 新增行含 eslint-disable 且 `--` 后无说明文字 →
    违规（AGENTS.md「禁 eslint-disable-next-line 静默」：规则误报须修规则本体，
    确需豁免必须带说明注释）。.md 文件不拦（文档引用这些词合法）。

用法：
  python3 .githooks/check_staged_forbidden_lines.py            # 检查全部 staged diff
  python3 .githooks/check_staged_forbidden_lines.py <file...>  # 只检查指定文件的 staged diff

退出码: 0 通过 / 2 违规 / 3 无 staged 变更（视为通过，供非 commit 场景直跑）
"""

import re
import subprocess
import sys

DIFF_CMD_PREFIX = ["git", "diff", "--cached", "--unified=0", "--diff-filter=ACMR"]

CONSOLE_RE = re.compile(r"console\.(warn|error)\(")
DISABLE_RE = re.compile(r"eslint-disable")

# [subagent-core 抽离 P0] 规则 A 的 scoped allowlist：core log 端口（HostServices.log 的
# NULL_HOST 缺省 sink）按设计 D2 即为 console——configureCore 之前宿主 appendEntry 通道
# 不存在，该路径仅测试与库误用场景可达；设计文档 docs/architecture/subagent-core-package-extraction.md
# §3.3 D2「缺省 console」，eslint 侧已有同范围 config 级 override（eslint.config.mjs）。
# [u1-move/u1-guards] P1 物理抽包后 src/core 迁至 packages/subagent-core/src/core/；
# 旧 extensions/ 前缀已随迁移删除（一致性审查 r2 裁定：目录迁走后死条目只有负作用
# ——重建同名路径写入 console.warn 会被静默豁免，历史登记由 git 历史承担，与 eslint
# 侧「文件迁走则 glob 跟走」策略对齐）。现前缀登记同一豁免语义——规则 A 目前只扫
# extensions/ 前缀（C 侧由 eslint 的 packages/subagent-core/src no-console:error 块
# 管住，src/core 豁免对应本条目前瞻条目），本条目
# 保证规则 A 扫描面未来若扩到 packages/ 时豁免同步，与 eslint 侧 override
# （packages/subagent-core/src/core/**）一一对应。
ALLOWED_CONSOLE_PREFIXES = (
    "packages/subagent-core/src/core/",
)


def check_file(path: str) -> list[str]:
    """返回该文件 staged 新增行中的违规描述列表。"""
    result = subprocess.run(DIFF_CMD_PREFIX + ["--", path], capture_output=True, text=True)
    violations = []
    for line in result.stdout.splitlines():
        if not line.startswith("+") or line.startswith("+++"):
            continue
        added = line[1:]
        is_ext_ts = path.startswith("extensions/") and path.endswith(".ts")
        console_rule_applies = is_ext_ts and not path.startswith(ALLOWED_CONSOLE_PREFIXES)
        if console_rule_applies and CONSOLE_RE.search(added):
            violations.append(f"{path}: 新增行含 console.warn/error（extensions 日志统一接 @zhushanwen/pi-extension-logger，见 docs/extensions/logging-conventions.md）")
        if path.endswith((".ts", ".vue", ".mjs")) and DISABLE_RE.search(added):
            # eslint-disable 后须带 `-- 说明`（AGENTS.md 禁静默 disable）
            after = added.split("--", 1)
            if len(after) == 1 or not after[1].strip():
                violations.append(f"{path}: 新增行含无说明的 eslint-disable（静默豁免禁止；规则误报须修正规则本体，确需豁免带 `-- 理由`）")
    return violations


def main() -> int:
    args = sys.argv[1:]
    files = args if args else subprocess.run(
        ["git", "diff", "--cached", "--name-only", "--diff-filter=ACMR"],
        capture_output=True, text=True,
    ).stdout.split()
    files = [f for f in files if f.endswith((".ts", ".vue", ".mjs"))]
    if not files:
        return 0

    all_violations = []
    for path in files:
        all_violations.extend(check_file(path))

    if all_violations:
        print("[check_staged_forbidden_lines] staged 新增行含禁用模式：")
        for v in all_violations:
            print(f"  - {v}")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
