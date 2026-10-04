#!/usr/bin/env python3
"""
pi 词汇泄漏检查（C-comm-02 + pi1-disposition-chat-flow U3④ / D5⑤）——五项检查。

规则（规格 SSOT：docs/architecture/runtime-layering.md 第二部分边界规则 +
pi1-disposition-chat-flow 设计 D5「pi 词汇合法持有点清单 + 泄漏并入 + 机器检查」）：

  【第 1 项 · 类型（存量口径，2026-08-22 接入）】
  扫描 packages/runtime/src/services/ 与 packages/runtime/src/transport/ 的 .ts 源码，
  剥离注释后命中标识符 Pi[A-Z]* 即违规——pi 协议类型只允许出现在 infra/pi 内部，
  pi 原始事件必须经 infra/pi 翻译为内部类型后才进 services。
  扫描面 = 本次提交（staged）触及的文件 ∩ 规则目录。提交者对自己提交的面负责；
  未暂存的在途改动归属其作者，其作者提交时本检查同样拦截——工作区他人的
  中间态不阻塞无关提交（与 oe-assert 只扫 staged 新增行、前端 ESLint 只扫
  staged 文件同构）。非 git 环境回退全仓扫描。

  【第 2-5 项 · U3④ 新增四项（全量扫描，不走 staged 过滤——设计 D5⑤扫描范围
  声明的口径 = 词汇止点声明覆盖的全部层，验收形态 u3-check.sh / V9① 需要确定性
  全仓语义）】
  扫描范围 = packages/runtime/src + packages/pi-rpc/src + packages/pi-subagent-cli/src
  + packages/shared/src + packages/core/src + packages/renderer/src；文件类型 = .ts
  + .vue（renderer 主体源码是 .vue，不纳入则「覆盖前端层」落空）。测试排除 = 沿用
  *.test.ts 与 __tests__/（测试非运行时载荷、无协议穿透通道——__tests__ 内测试标题
  字符串会命中事件名项，不排除则首跑即违规）。

  - 第 2 项 import：`from '@earendil-works/` 前缀串。盲区：动态 import('...') /
    require 形态检不出（仓内现状零实例，出现时按本头注扩形态）。
  - 第 3 项 事件名：带引号定界字符串**完整值 ∈ 词表**（整串相等，非词边界子串）——
    协议穿透通道是字符串完整值（判别比较 / 派发载荷 / 映射值）；词边界口径会误报
    taiji 自有复合词表 message.<event> 的合法代码（设计 D5⑤④ 选型理由）。
  - 第 4 项 文案：两条 pi prompt() busy 拒绝原文——比其余项更严，**唯一驻留点 =
    packages/runtime/src/infra/pi/**（合法持有点清单内的其他文件也不得持有，
    消费方经 infra/pi/pi-rejection.ts 导入常量）。
  - 第 5 项 方法名：词边界正则匹配 pi 专有方法名 setStatus / setWidget / setTitle /
    set_editor_text。通用对话框词 select/confirm/input/editor/notify 与 taiji 通用
    UI 词汇同形且属 D6 声明的 taiji 侧 dialogKind 值域，不进词表防误报。

  白名单 = pi 词汇合法持有点清单（D5①，与 ADR 同源维护，两处改一处必同步）：
    - packages/runtime/src/infra/pi/**（infra 门面层）
    - packages/runtime/src/services/session/session-delivery-registry.ts（文件头封闭声明）
    - packages/pi-rpc/**（RPC 消息契约镜像）
    - packages/pi-subagent-cli/**（pi spawn 事件直接适配器）
  第 4 项文案的白名单仅 infra/pi/ 前缀。与类型项存量 ALLOWLIST（下方，2026-08-22
  过渡基线）互不取代、不合并维护——两套白名单分管两类词汇。

  ── 事件名词表派生规则（第 3 项词表，设计 D5⑤界定规则，实施按此落地）────────
  词表 = infra/pi/pi-protocol.ts 的 `export const PI_EVENT_NAMES` 常量数组值域
  （D5⑥ 字面量单点化载体），启动时解析提取方括号内带引号字符串字面量（容忍换行 /
  尾逗号 / 成员间注释——注释剥离与下方 strip_comments 同源）。「词表 = 常量表值域 ≡
  PiEvent 联合判别值全集 − 同形剔除集」的等价关系由 TS 侧两层编译期断言机器强制
  （pi-protocol.ts：`as const satisfies readonly PiEvent['type'][]` 子集层 +
  PiEventNameDriftGuard 的 ExpectNever 穷尽层）——联合扩成员而常量表与剔除集均未收
  即 tsc 红，本检查器读「词表 = 常量表值域」的口径不变、python 代码零改动（扩联合
  下次运行自动取到新词表）。
  同形剔除集（6 词，不进扫描词表防误报，与 pi-protocol.ts PiEventNameHomoglyphExempt
  同源）：trace-trigger 联合判别值 3 词（message_end / agent_settled / entry_appended
  ——services/session/types.ts 的 trigger 联合，pi 原始事件名作 taiji 侧触发标签）
  + compaction_end（taiji 侧第四类触发信号 onTraceSync 传值；taiji 判别值是连字符
  'compaction-end'）+ 通用词 2 词（status / error，taiji 通用词汇大面积同形）。
  剔除代价：这 6 词上的 services 层直听 pi 原始事件流（L2 型泄漏）检不住，残余防线
  分档登记见设计 D5⑤②；剔除集扩容时同步本头注 + pi-protocol.ts 类型 + ADR 登记。

  ──「检不出」盲区声明（事件名项口径边界，设计 D5⑤④，登记备查）──────────────
  (a) taiji 复合消息类型尾段（'message.message_start' 等）——完整值 ≠ 词表词，属整串
      口径的选型理由而非盲区（taiji 自有 WS 词表合法代码）；
  (b) 无引号对象键形态（{ agent_start: ... }）——标识符键非字符串字面量，检不出；
      该形态现存实例已随 plugin-bridge 退役清零（曾为 services/plugin-service/
      bridge-interop.ts 的 pi 事件名 → hook 映射表对象键，D7① 删除；ADR-0110 §4
      同口径登记）；
  (c) 日志模板串内嵌（`...agent_start...` 等）——完整值 ≠ 词表词不命中；日志文本非
      协议穿透通道（与测试排除同论证），保留原文。
  未来 (b) 形态泄漏再现时，扩「对象键 word:」匹配形态是纯增量动作（本头注即重审
  触发器）。

  取数失败 fail-fast：常量定位不到（改名 / 重构 / 文件移动）或提取结果为空表时，
  本检查器报错退出非 0 而非以空词表照跑（防空词表 → 事件名项零命中全通过的死检查）；
  每次运行摘要行输出词表基数（首检对账与验收核对词表的既定观察通道）；
  词表全文经开关打印（PI_LEAK_DUMP_VOCAB=1，基数对账出现偏差时核对解析结果
  的现成通道——设计 D5⑤实装口径⑤「词表输出口径」）。

存量基线（第 1 项类型，2026-08-22 首次接入时登记，ALLOWLIST 之外的文件违规即拦）：
  三层设计落地后 services 层存在 25 个历史引用文件（ports 接口 / migration 解析器 /
  plugin-types / session 子模块等）。本检查以「文件级 allowlist + 增量拦截」上线：
  存量文件待专项治理（治理完成后删除 ALLOWLIST 即全量拦截），新文件引入 PiXxx 直接拦。

退出码: 0 通过 / 2 发现泄漏 / 3 事件名词表取数失败（fail-fast）
"""

import os
import re
import subprocess
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent

# ── 第 1 项类型：扫描范围与存量基线（2026-08-22 口径；staged-scope 语义见头注）──
TYPE_SCAN_DIRS = [
    PROJECT_ROOT / "packages/runtime/src/services",
    PROJECT_ROOT / "packages/runtime/src/transport",
]

# 存量待治理清单（2026-08-22 基线；治理完成后删除即全量拦截）
ALLOWLIST_FILES = {
    "services/handoff-service.ts",
    "services/migration/legacy-provider-migration.ts",
    "services/migration/parsers/codex-parser.ts",
    "services/migration/parsers/pi-parser.ts",
    "services/migration/parsers/zcode-parser.ts",
    "services/migration/provider-importer.ts",
    "services/migration/provider-parser.ts",
    "services/plugin-service/hook-api.ts",
    "services/plugin-service/plugin-types.ts",
    "services/plugin-service/plugin-types/hook-types.ts",
    "services/ports/config.ts",
    "services/ports/pi-engine.ts",
    "services/ports/session.ts",
    "services/preset-service.ts",
    "services/provider-config-helper.ts",
    "services/session-history.ts",
    "services/session/event-interpreter.ts",
    "services/session/replicated-states.config.ts",
    "services/session/session-fork.ts",
    "services/session/session-lifecycle.ts",
    "services/session/session-service.ts",
    "services/session/types.ts",
    "services/skill-dirs.ts",
    "services/skill-registry.ts",
    "services/startup-background-init.ts",
}

PI_TYPE_RE = re.compile(r"\bPi[A-Z]\w*")

# ── 第 2-5 项：扫描范围与白名单（pi 词汇合法持有点清单，D5①；与 ADR 同源维护）──
FULL_SCAN_DIRS = [
    PROJECT_ROOT / "packages/runtime/src",
    PROJECT_ROOT / "packages/pi-rpc/src",
    PROJECT_ROOT / "packages/pi-subagent-cli/src",
    PROJECT_ROOT / "packages/shared/src",
    PROJECT_ROOT / "packages/core/src",
    PROJECT_ROOT / "packages/renderer/src",
]

# 合法持有点清单（前缀按 PROJECT_ROOT 相对 posix 路径判定 + 单文件集合）
WHITELIST_PREFIXES = (
    "packages/runtime/src/infra/pi/",
    "packages/pi-rpc/src/",
    "packages/pi-subagent-cli/src/",
)
WHITELIST_FILES = {
    "packages/runtime/src/services/session/session-delivery-registry.ts",
}
# 文案项更严：唯一驻留点 = infra/pi（清单内其他文件也不得持有）
REJECTION_TEXT_WHITELIST_PREFIXES = ("packages/runtime/src/infra/pi/",)

# 第 2 项 import：import 语句形态前缀串（动态 import/require 盲区见头注）
PI_IMPORT_RE = re.compile(r"from\s+['\"]@earendil-works/")

# 第 4 项文案：pi prompt() busy 类确定性拒绝原文（PS-22/PS-23 探针锚定同一原文；
# 与 infra/pi/pi-rejection.ts 的 PI_REJECTION_* 常量逐字一致——改常量必同步此处）
PI_REJECTION_TEXTS = (
    "Cannot submit a prompt while compaction is in progress",
    "Agent is already processing",
)

# 第 5 项方法名：pi 专有命名形态方法名（词边界正则；通用对话框词不进词表防误报，
# 理由见头注第 5 项）
PI_METHOD_RE = re.compile(r"\b(setStatus|setWidget|setTitle|set_editor_text)\b")

# 第 3 项事件名：词表取数路径（头注「事件名词表派生规则」）
PI_PROTOCOL_PATH = PROJECT_ROOT / "packages/runtime/src/infra/pi/pi-protocol.ts"
EVENT_NAMES_CONST = "PI_EVENT_NAMES"
# 带引号定界字符串整串相等：捕获组保证开闭定界符配对，中间是完整值（词表词为
# 小写字母/数字/下划线形态）；模板串内嵌 / 无引号对象键不命中（头注盲区 (b)(c)）
PI_EVENT_NAME_RE = re.compile(r"(['\"`])([a-z][a-z0-9_]*)\1")


def strip_comments(text: str) -> str:
    """剥离块注释与行注释（保守近似：字符串字面量内的 // 不处理——PiXxx 命中已足够精确）。

    U3④ 剥离能力补齐（同一个函数补能力，非第二套实现，design D5⑤③）：
    - 同行开闭的块注释（含单行 JSDoc）——原实现只在同行找不到 */ 结尾时才截断，
      同行开闭形态不剥；
    - .vue 的 HTML 注释 <!-- -->（跨行与同行）。
    对类型项 ALLOWLIST 语义的影响 = 只减少命中（白名单是豁免集合，命中变少不产生误报）。
    """
    # 先剥 HTML 注释（.vue；.ts 无 <!-- --> 字面形态，统一处理无害）
    text = re.sub(r"<!--.*?-->", "", text, flags=re.DOTALL)

    # 块注释：同行/跨行开闭的非贪婪匹配 + 残留未闭合块注释删到文末
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.DOTALL)
    text = re.sub(r"/\*.*$", "", text, flags=re.DOTALL)

    # 行注释逐行截断（不处理 '://' 内的 // —— URL 中无 PiXxx 标识符风险）
    out_lines = []
    for line in text.splitlines():
        idx = line.find("//")
        if idx != -1:
            line = line[:idx]
        out_lines.append(line)
    return "\n".join(out_lines)


def rel_to_runtime_src(p: Path) -> str:
    return p.relative_to(PROJECT_ROOT / "packages/runtime/src").as_posix()


def rel_to_project_root(p: Path) -> str:
    return p.relative_to(PROJECT_ROOT).as_posix()


def staged_files() -> set[str] | None:
    """暂存区文件清单（仓库根相对 posix 路径）。非 git 环境返回 None = 回退全仓扫描。"""
    try:
        out = subprocess.run(
            ["git", "diff", "--cached", "--name-only", "-z"],
            capture_output=True, cwd=PROJECT_ROOT,
        )
    except OSError:
        return None
    if out.returncode != 0:
        return None
    return {p for p in out.stdout.decode("utf-8", errors="replace").split("\0") if p}


def parse_event_names() -> list[str]:
    """从 pi-protocol.ts 解析 PI_EVENT_NAMES 常量数组提取事件名词表（取数路径见头注）。

    容错边界：容忍换行 / 尾逗号 / 成员间注释（先 strip_comments 再提取）。
    fail-fast：常量定位不到（改名 / 重构 / 文件移动）或提取结果为空表 → RuntimeError
    （main 捕获后报错退出 3，防「空词表 → 事件名项零命中全通过」的死检查形态）。
    """
    if not PI_PROTOCOL_PATH.exists():
        raise RuntimeError(
            f"事件名词表取数失败：{PI_PROTOCOL_PATH.relative_to(PROJECT_ROOT)} 不存在"
            f"（检查器头注「事件名词表派生规则」）"
        )
    stripped = strip_comments(PI_PROTOCOL_PATH.read_text(encoding="utf-8", errors="replace"))
    m = re.search(rf"export const {EVENT_NAMES_CONST}\s*=\s*\[", stripped)
    if not m:
        raise RuntimeError(
            f"事件名词表取数失败：未定位到 `export const {EVENT_NAMES_CONST}` 常量数组"
            f"（{PI_PROTOCOL_PATH.relative_to(PROJECT_ROOT)}）——常量改名 / 重构 / 移动时"
            f"同步本检查器头注「事件名词表派生规则」的取数符号名"
        )
    end = stripped.find("]", m.end())
    if end == -1:
        raise RuntimeError(
            f"事件名词表取数失败：{EVENT_NAMES_CONST} 数组未找到闭合 ']'"
            f"（{PI_PROTOCOL_PATH.relative_to(PROJECT_ROOT)}）"
        )
    bracket = stripped[m.end() : end]
    names = re.findall(r"['\"]([a-z][a-z0-9_]*)['\"]", bracket)
    if not names:
        raise RuntimeError(
            f"事件名词表取数失败：{EVENT_NAMES_CONST} 数组内未提取到任何字符串字面量"
            f"（空词表照跑 = 事件名项零命中全通过的死检查，fail-fast 拒绝）"
            f"——书写形态与取数形态脱节时按头注「重审触发条件」处置"
        )
    return names


def main() -> int:
    # 词表取数（fail-fast 于一切检查之前——取不到词表时事件名项不可信）
    try:
        event_names = parse_event_names()
    except RuntimeError as e:
        print(f"[check_pi_type_leak] {e}")
        return 3
    event_name_set = set(event_names)

    staged = staged_files()
    violations: list[str] = []
    scanned = 0

    # ── 第 1 项：类型（staged-scope 口径不变）─────────────────────────────
    for scan_dir in TYPE_SCAN_DIRS:
        for f in sorted(scan_dir.rglob("*.ts")):
            if f.name.endswith(".test.ts") or "__tests__" in f.parts:
                continue
            rel = rel_to_runtime_src(f)
            if staged is not None:
                repo_rel = f"packages/runtime/src/{rel}"  # staged 清单为仓库根相对基准
                if repo_rel not in staged:
                    continue
                if not f.exists():  # staged 删除项无可扫描内容
                    continue
            if rel in ALLOWLIST_FILES:
                continue
            scanned += 1
            stripped = strip_comments(f.read_text(encoding="utf-8", errors="replace"))
            for m in PI_TYPE_RE.finditer(stripped):
                violations.append(f"{rel}: 标识符 `{m.group(0)}`（PiXxx 类型只许 infra/pi 内部，翻译后进 services）")
                break  # 每文件报首个即可

    if staged is not None and scanned == 0:
        print("[check_pi_type_leak] 类型项：staged 无 packages/runtime/src/{services,transport} 规则目录文件，跳过该面")

    # ── 第 2-5 项：四项新增（全量扫描，不走 staged 过滤——头注「第 2-5 项」）──
    for scan_dir in FULL_SCAN_DIRS:
        for ext in ("*.ts", "*.vue"):
            for f in sorted(scan_dir.rglob(ext)):
                rel = rel_to_project_root(f)
                if rel.endswith(".test.ts") or "__tests__" in f.parts:
                    continue
                if rel.startswith(WHITELIST_PREFIXES) or rel in WHITELIST_FILES:
                    continue
                stripped = strip_comments(f.read_text(encoding="utf-8", errors="replace"))

                # 第 2 项 import
                if PI_IMPORT_RE.search(stripped):
                    violations.append(f"{rel}: import '@earendil-works/*'（pi 系包 import 只许合法持有点：infra/pi、pi-rpc、pi-subagent-cli）")

                # 第 3 项事件名（字符串字面量整串相等 ∈ 词表；每文件报首个即可）
                for m in PI_EVENT_NAME_RE.finditer(stripped):
                    if m.group(2) in event_name_set:
                        violations.append(f"{rel}: pi 事件名字面量 `{m.group(2)}`（字面量单点化——引用经 infra/pi/pi-protocol.ts PI_EVENT 具名出口）")
                        break

                # 第 4 项文案（唯一驻留点 = infra/pi）
                if not rel.startswith(REJECTION_TEXT_WHITELIST_PREFIXES):
                    for text in PI_REJECTION_TEXTS:
                        if text in stripped:
                            violations.append(f"{rel}: pi 拒绝文案驻留（唯一驻留点 = infra/pi/pi-rejection.ts，消费方导入常量）")
                            break

                # 第 5 项方法名（词边界）
                m = PI_METHOD_RE.search(stripped)
                if m:
                    violations.append(f"{rel}: pi 方法名 `{m.group(0)}`（只许合法持有点：infra/pi、pi-rpc、pi-subagent-cli）")

    # 摘要行（无论违规与否恒输出——词表基数核对通道，头注「事件名词表派生规则」）
    print(
        f"[check_pi_type_leak] 词表基数 = {len(event_names)}"
        f"（取数路径：解析 packages/runtime/src/infra/pi/pi-protocol.ts 的 {EVENT_NAMES_CONST}）"
    )

    # 词表全文输出口径（PI_LEAK_DUMP_VOCAB=1，头注「词表输出口径」）——按常量表声明
    # 顺序输出，即解析结果原样呈现，不排序不加工（不构成第二套词表数据）
    if os.environ.get("PI_LEAK_DUMP_VOCAB") == "1":
        vocab_lines = "\n".join(f"  - {name}" for name in event_names)
        print(f"[check_pi_type_leak] 词表全文（{len(event_names)} 词，声明顺序）：\n{vocab_lines}")

    if violations:
        print("[check_pi_type_leak] 发现 pi 词汇泄漏（docs/architecture/runtime-layering.md 边界规则 + D5 合法持有点清单）：")
        for v in violations:
            print(f"  - {v}")
        print("修复方向：pi 原始类型/事件经 infra/pi 翻译为内部类型后供消费；字面量/方法名引用经 infra/pi 门面导入。")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
