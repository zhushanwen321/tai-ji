#!/usr/bin/env python3
r"""
subagent-workflow 通道禁则检查（C-ext-19，pi-boundary-reliability §3.3 D5 + D7 G4 行）。

规则（authority：docs/architecture/pi-boundary-reliability.md D5「确认式送达」与 D7 G4；
constraints.json 登记 C-ext-19 随 U8 落盘）：
  扫描 extensions/universal/subagent-workflow/src/ 的 .ts 源码
  （排除 __tests__/ 与 *.test.ts / *.d.ts——测试模拟串不拦，同 install-hooks.sh
  EXTENSION_FILES 的 __tests__|\.test\. 排除先例）：
  - 规则 1（deliverAs）：deliverAs:"steer"/"nextTurn" 不得出现在 courier 白名单外——
    结果语义的跨边界通知必须走持久账本 + notifyId 幂等通道（execution/notify-ledger.ts），
    禁止依赖 pi 内存队列的 at-most-once 投递（事故 A F2：十余次完成通知仅 1 次送达）；
    交互式注入（extension-conventions.md「Event handler 消息注入」节）不属禁令对象，
    豁免须行级注释注明定性。
  - 规则 2（--model）："--model" 字面量不得出现在模型引用白名单外——扩展域内
    字符串→模型身份只允许经 shared/model-ref.ts（assertCanonicalModelRef，切片 1 U1），
    禁裸串拼（事故 A F1：影子精确匹配 vs pi pattern 引擎互不知晓 → 静默换模 429）。

白名单机制（两档；扩白名单必须给职责定性注释）：
  - 文件级：下方 WHITELIST_DELIVERAS / WHITELIST_MODEL（路径相对
    extensions/universal/subagent-workflow/src/）；
  - 行级豁免：违规行内含 `g4-allow:`（或全角 `g4-allow：`）且带非空定性理由，
    如 `// g4-allow: 交互注入——非结果语义`。裸标记无理由不生效。

用法：
  python3 .githooks/check_subagent_channels.py                 # staged 模式：staged 含本包文件 → 全包扫描
  python3 .githooks/check_subagent_channels.py --all           # 全仓模式（CI invariants 等价步）
  python3 .githooks/check_subagent_channels.py --all --root D  # fixture 自测（D 为含本包 src 结构的根）

退出码: 0 通过 / 2 违规
"""

import re
import subprocess
import sys
from pathlib import Path

PKG_PREFIX = "extensions/universal/subagent-workflow"
PKG_SRC_SUFFIX = f"{PKG_PREFIX}/src"

# ── 文件级白名单（路径相对 <root>/extensions/universal/subagent-workflow/src/）──
# courier 模块：结果语义通知的合法投递通道（U2 B-ledger：账本 + settled 边沿 courier
# + notifyId 幂等；该文件内 deliverAs 通道已全部删除，白名单是职责定位而非豁免存量）。
WHITELIST_DELIVERAS = {
    "execution/notify-ledger.ts",
}
# 模型引用 / argv 拼装职责模块：
# - shared/model-ref.ts：字符串→模型身份的唯一合法入口（assertCanonicalModelRef，U1）；
# - execution/session-runner.ts：spawn argv 的合法拼装点（经 model-ref 校验后组装）；
# - execution/argv-mirror.ts：主进程 argv 的 flag 解析（VALUED_FLAGS 引用 flag 名以跳过
#   其值，非模型身份构造——与 session-runner 同性质的 argv 职责模块）。
WHITELIST_MODEL = {
    "shared/model-ref.ts",
    "execution/session-runner.ts",
    "execution/argv-mirror.ts",
}

DELIVERAS_RE = re.compile(r"""deliverAs:\s*["'](steer|nextTurn)["']""")
MODEL_FLAG_RE = re.compile(r"""["']--model["']""")
EXEMPT_RE = re.compile(r"g4-allow[:：]\s*\S+")

CONSTRAINT_ID = "C-ext-19"
DESIGN_DOC = "docs/architecture/pi-boundary-reliability.md"


def parse_args(argv: list[str]) -> tuple[bool, str | None]:
    """返回 (全仓模式, 自定义 root)。"""
    mode_all = "--all" in argv
    root = None
    if "--root" in argv:
        i = argv.index("--root")
        if i + 1 >= len(argv) or argv[i + 1].startswith("--"):
            print("用法: check_subagent_channels.py [--all] [--root <dir>]", file=sys.stderr)
            sys.exit(2)
        root = argv[i + 1]
    return mode_all, root


def staged_files(root: Path) -> list[str]:
    result = subprocess.run(
        ["git", "-C", str(root), "diff", "--cached", "--name-only", "--diff-filter=ACMR"],
        capture_output=True, text=True,
    )
    return result.stdout.split()


def scan_pkg(root: Path) -> tuple[list[str], int]:
    """扫描本包 src 树，返回 (违规明细, 扫描文件数)。"""
    pkg_src = root / PKG_SRC_SUFFIX
    violations: list[str] = []
    scanned = 0
    if not pkg_src.is_dir():
        return violations, scanned
    for path in sorted(pkg_src.rglob("*.ts")):
        rel = path.relative_to(pkg_src).as_posix()
        if "__tests__" in path.parts or path.name.endswith((".test.ts", ".d.ts")):
            continue
        scanned += 1
        try:
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError as e:
            violations.append(f"{PKG_SRC_SUFFIX}/{rel}: 文件不可读（{e}）")
            continue
        for idx, line in enumerate(lines, 1):
            where = f"{PKG_SRC_SUFFIX}/{rel}:{idx}"
            exempt = bool(EXEMPT_RE.search(line))
            if not exempt and rel not in WHITELIST_DELIVERAS:
                m = DELIVERAS_RE.search(line)
                if m:
                    violations.append(f"{where}  deliverAs:{m.group(1)}（courier 白名单外，{CONSTRAINT_ID}）")
            if not exempt and rel not in WHITELIST_MODEL and MODEL_FLAG_RE.search(line):
                violations.append(f'{where}  "--model" 字面量（模型引用白名单外，{CONSTRAINT_ID}）')
    return violations, scanned


def main() -> int:
    mode_all, root_arg = parse_args(sys.argv[1:])
    root = Path(root_arg).resolve() if root_arg else Path(__file__).resolve().parent.parent

    if not mode_all:
        # staged 模式：本包无 staged 变更时无扫描面；有则全包扫描
        #（拦「包内任一文件被改时新增的违规」，与 --all 同语义）
        staged = [f for f in staged_files(root) if f.startswith(f"{PKG_PREFIX}/")]
        if not staged:
            return 0

    violations, scanned = scan_pkg(root)
    if violations:
        print(f"[check_subagent_channels] subagent-workflow 通道禁则违规（{CONSTRAINT_ID}）：")
        for v in violations:
            print(f"  - {v}")
        print()
        print("修复指引：")
        print("  - 结果语义通知（subagent/scheduler/webhook 完成）→ 走 execution/notify-ledger.ts")
        print("    持久账本 + notifyId 幂等通道，禁止依赖 pi 内存队列的 at-most-once 投递")
        print("  - 模型身份引用 → shared/model-ref.ts（assertCanonicalModelRef）；argv 拼装只许白名单模块")
        print("  - 白名单定义处：.githooks/check_subagent_channels.py 顶部 WHITELIST_*（扩白名单须给职责定性注释）")
        print("  - 合法交互注入 / 存量待迁移 / 契约文案等定性豁免：违规行加 `// g4-allow: <定性理由>`")
        print(f"  - 约束 {CONSTRAINT_ID}：{DESIGN_DOC} §3.3 D5/D7-G4 + docs/extensions/extension-conventions.md")
        return 2
    print(
        f"[check_subagent_channels] 通过（{CONSTRAINT_ID}；扫描 {scanned} 文件，"
        f"deliverAs 白名单 {len(WHITELIST_DELIVERAS)} + --model 白名单 {len(WHITELIST_MODEL)}）"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
