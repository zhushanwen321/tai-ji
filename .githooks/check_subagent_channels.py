#!/usr/bin/env python3
r"""
custom 消息注入点唯一性检查（C-ext-19，pi-boundary-reliability §3.3 D5/D7-G4 +
统一投递重构 D3 裁决 1 波 3 落地）。

规则（authority：docs/architecture/pi-boundary-reliability.md D5「确认式送达」；
统一投递设计 .tmp/tech-design/unified-delivery.md §3.7「custom 注入点唯一——投递端
口的 sendMessage 是全项目通知唯一出口」）：
  规则 1（deliverAs 注入点唯一）：扫描 extensions/ 全部 .ts 源码（排除 __tests__/
  与 *.test.ts / *.d.ts——测试模拟串不拦，同 install-hooks.sh EXTENSION_FILES 的
  __tests__|\.test\. 排除先例），deliverAs:"steer"/"followUp"/"nextTurn" 字面量不得
  出现在 delivery-port 白名单外——custom 车道唯一执行者 =
  extensions/shared/delivery-port（port.deliver → 内核受理 → pi.sendMessage 直达
  pi 唯一队列，受理前落 session entry 投递日志 + details-id 送达凭据 + session_start
  差集重放）。deliverAs 字面量注入点在检查层面收敛——字面量形态结构性排除，
  变量传参形态不在射程（goal/plan 等经参数传递的注入由端口迁移波次收敛）；
  交互式注入（extension-conventions.md
  「Event handler 消息注入」节）不属禁令对象，豁免须定性登记（文件白名单或行级
  g4-allow 注释）。
  规则 2（--model）："--model" 字面量不得出现在模型引用白名单外（扫描范围保持
  subagent-workflow 域——全 extensions 的模型引用漂移由 MODELREF 检查
  E2E-MODELREF-01 单独看护，不在本检查重复扩大范围）：扩展域内字符串→模型身份只允许经
  shared/model-ref.ts（assertCanonicalModelRef，切片 1 U1），禁裸串拼
  （事故 A F1：影子精确匹配 vs pi pattern 引擎互不知晓 → 静默换模 429）。

白名单机制（两档；扩白名单必须给职责定性注释）：
  - 文件级：规则 1 = WHITELIST_DELIVERAS（路径相对 extensions/）；
    规则 2 = WHITELIST_MODEL（路径相对 extensions/universal/subagent-workflow/src/）；
  - 行级豁免：违规行内含 `g4-allow:`（或全角 `g4-allow：`）且带非空定性理由，
    如 `// g4-allow: 交互注入——非结果语义`。裸标记无理由不生效。

用法：
  python3 .githooks/check_subagent_channels.py                 # staged 模式：staged 含 extensions/ 文件 → 全量扫描
  python3 .githooks/check_subagent_channels.py --all           # 全仓模式（CI invariants 等价步）
  python3 .githooks/check_subagent_channels.py --all --root D  # fixture 自测（D 为含 extensions 结构的根）

退出码: 0 通过 / 2 违规
"""

from __future__ import annotations
import re
import subprocess
import sys
from pathlib import Path

EXT_PREFIX = "extensions"
# 规则 2 的扫描域保持 subagent-workflow 包（--model 禁令的事故面；规则 1 已扩全 extensions）
PKG_PREFIX = "extensions/universal/subagent-workflow"
PKG_SRC_SUFFIX = f"{PKG_PREFIX}/src"

# ── 规则 1 白名单（路径相对 extensions/；扩白名单必须给职责定性注释）────────
# delivery-port：custom 车道唯一执行者本体（port.deliver → 内核 → pi.sendMessage
# 直达唯一队列）——全项目通知唯一出口（统一投递设计 §3.7）。
# 其余条目 = 逐文件定性豁免；后续包经 port 迁移时对应条目摘除（清单单调收缩）。
WHITELIST_DELIVERAS = {
    "shared/delivery-port/src/delivery-port.ts",
    "shared/delivery-port/src/pi-host.ts",
    # port 缺席降级直发（设计 §3.7 缺席语义：装配异常窗口的 at-most-once 兜底 +
    # warn 留痕；主路径本体经 port.deliver 入账——统一投递波 3）。
    "universal/base-tool-enhance/src/background/notify.ts",
    # scheduler steer 直投（scheduler-steer-direct-dispatch 设计，2026-09-14 用户
    # 裁决）：提醒类豁免——不需要必达，steer 立即打断是期望行为；u6-exempt-eval
    # 终态裁决「不迁」。
    "universal/scheduler/src/runtime.ts",
    # smart-context 五类通知（deliverAs:'nextTurn' 依赖「随下一次用户 prompt 注入」
    # 语义，port 两档队列不承载）：u6-exempt-eval 终态裁决「不迁」。
    "universal/smart-context/src/notices.ts",
    # plan 上下文注入（评审/恢复/执行提示，dialog 驱动的交互语义——非异步结果通知）。
    "universal/plan/src/tool.ts",
    "universal/plan/src/execution-notice.ts",
    "universal/plan/src/index.ts",
    # structured-output 门禁重试提醒（回喂：结构化校验失败后把错误清单发回子代理
    # 重试——hook 同步路径的活体交互通道，非异步结果通知）。
    "universal/structured-output/src/workflow-hook.ts",
    # goal continuation 提示通道（sendContextMessage 声明与注释——实装经参数传递；
    # agent-end 后唤醒继续的提示注入，丢失后果 = goal 停摆用户可见，非异步结果
    # 通知）。统一投递设计未列入迁移波次，处置待后续设计裁决（迁移候选）。
    "universal/goal/src/ports.ts",
    "universal/goal/src/adapters/event-handlers/agent-end.ts",
}
# ── 规则 2 白名单（路径相对 extensions/universal/subagent-workflow/src/）────
# 模型引用规范权威源文件 = packages/subagent-core/src/shared/model-ref.ts
# （assertCanonicalModelRef，跨包单源，本域零副本）。域内 "--model" 唯一生产
# 出现面 = host/pi-host.ts argv 解析词表（行级 g4-allow：解析词表成员，非模型
# 引用拼装）；无文件级白名单成员。
WHITELIST_MODEL: set[str] = set()

DELIVERAS_RE = re.compile(r"""deliverAs:\s*["'](steer|followUp|nextTurn)["']""")
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


def iter_ts_files(root_dir: Path):
    """按固定顺序产出待扫 .ts 文件（排除 __tests__ / *.test.ts / *.d.ts）。"""
    for path in sorted(root_dir.rglob("*.ts")):
        if "__tests__" in path.parts or path.name.endswith((".test.ts", ".d.ts")):
            continue
        yield path


def scan_deliveras(ext_root: Path) -> tuple[list[str], int]:
    """规则 1：extensions 全域 deliverAs 注入点唯一性，返回 (违规明细, 扫描文件数)。"""
    violations: list[str] = []
    scanned = 0
    if not ext_root.is_dir():
        return violations, scanned
    for path in iter_ts_files(ext_root):
        rel = path.relative_to(ext_root).as_posix()
        scanned += 1
        try:
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError as e:
            violations.append(f"{EXT_PREFIX}/{rel}: 文件不可读（{e}）")
            continue
        for idx, line in enumerate(lines, 1):
            where = f"{EXT_PREFIX}/{rel}:{idx}"
            exempt = bool(EXEMPT_RE.search(line))
            if not exempt and rel not in WHITELIST_DELIVERAS:
                m = DELIVERAS_RE.search(line)
                if m:
                    violations.append(f"{where}  deliverAs:{m.group(1)}（delivery-port 白名单外，{CONSTRAINT_ID}）")
    return violations, scanned


def scan_model_flag(root: Path) -> tuple[list[str], int]:
    """规则 2：subagent-workflow 域 --model 裸串禁令，返回 (违规明细, 扫描文件数)。"""
    violations: list[str] = []
    scanned = 0
    pkg_src = root / PKG_SRC_SUFFIX
    if not pkg_src.is_dir():
        return violations, scanned
    for path in iter_ts_files(pkg_src):
        rel = path.relative_to(pkg_src).as_posix()
        scanned += 1
        try:
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError as e:
            violations.append(f"{PKG_SRC_SUFFIX}/{rel}: 文件不可读（{e}）")
            continue
        for idx, line in enumerate(lines, 1):
            where = f"{PKG_SRC_SUFFIX}/{rel}:{idx}"
            if not EXEMPT_RE.search(line) and rel not in WHITELIST_MODEL and MODEL_FLAG_RE.search(line):
                violations.append(f'{where}  "--model" 字面量（模型引用白名单外，{CONSTRAINT_ID}）')
    return violations, scanned


def main() -> int:
    mode_all, root_arg = parse_args(sys.argv[1:])
    root = Path(root_arg).resolve() if root_arg else Path(__file__).resolve().parent.parent

    if not mode_all:
        # staged 模式：extensions/ 无 staged 变更时无扫描范围；有则全量扫描
        #（拦「任一扩展文件被改时新增的违规」，与 --all 同语义）
        staged = [f for f in staged_files(root) if f.startswith(f"{EXT_PREFIX}/")]
        if not staged:
            return 0

    deliveras_violations, deliveras_scanned = scan_deliveras(root / EXT_PREFIX)
    model_violations, model_scanned = scan_model_flag(root)
    violations = deliveras_violations + model_violations
    if violations:
        print(f"[check_subagent_channels] custom 注入点/通道禁则违规（{CONSTRAINT_ID}）：")
        for v in violations:
            print(f"  - {v}")
        print()
        print("修复指引：")
        print("  - 结果语义通知（任务/作业完成类）→ 经投递端口入账：getDeliveryPort().deliver(")
        print("    {id: <幂等键>, timing: 'steer'|'followUp', payload: {kind:'custom', ...}})")
        print("    （extensions/shared/delivery-port——受理前落投递日志 + details-id 送达凭据 +")
        print("    session_start 差集重放；禁依赖 pi 内存队列的 at-most-once 投递）")
        print("  - 模型身份引用 → shared/model-ref.ts（assertCanonicalModelRef）；argv 拼装只许白名单模块")
        print("  - 白名单定义处：.githooks/check_subagent_channels.py 顶部 WHITELIST_*（扩白名单须给职责定性注释）")
        print("  - 合法交互注入 / 设计豁免类 / 契约文案等定性豁免：违规行加 `// g4-allow: <定性理由>`")
        print(f"  - 约束 {CONSTRAINT_ID}：{DESIGN_DOC} §3.3 D5/D7-G4 + docs/extensions/extension-conventions.md")
        return 2
    print(
        f"[check_subagent_channels] 通过（{CONSTRAINT_ID}；deliverAs 扫 {deliveras_scanned} 文件 / "
        f"白名单 {len(WHITELIST_DELIVERAS)}，--model 扫 {model_scanned} 文件 / 白名单 {len(WHITELIST_MODEL)}）"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
