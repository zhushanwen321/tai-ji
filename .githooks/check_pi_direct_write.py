#!/usr/bin/env python3
"""
检查 runtime / scripts 代码是否直接写 pi session JSONL 本体（R1，data-source-governance P0.3）。

规则（规格 SSOT：docs/architecture/data-source-governance-plan.md §2 W3 节，逐字冻结；
例外与合法形态登记：docs/architecture/data-source-registry.md）：

  扫描 packages/runtime/src/ 与仓库根 scripts/（排除测试文件），命中需同时满足：
  - 条件 A（文件级圈定候选）：写调用所在文件（剥离注释后）含 sessions 路径推导痕迹——
    getSessionsDir 的 import/调用；或 'sessions' / "sessions" 引号 token（join(…, 'sessions', …)
    参数形态）；或 'sessions/' 路径段字面量。普通标识符（如 sessions Map 字段名）、注释、
    字符串文案普通提及不计入。
  - 写调用形态：openSync(path, 'a'/'w') / appendFile(Sync) / writeFile(Sync) /
    atomicWrite 家族（含 atomicWriteAsync 同族 async 变体）/ createWriteStream
    （流式写，无 flag 限定——默认 'w'，append 形态同属写；W5 补齐，此前该形态可
    完全绕过。logger.ts 的 logs 常驻写流是合法用例：文件内 sessions token 仅存在于
    注释，条件 A 不命中，无需豁免）。
  - 条件 B（内置豁免，写目标路径层级判定，命中任一则放行）：
    ① sidecar 家族六后缀（taiji 自有文件，登记表 §4 ⑤）：写目标语句含 '.meta.json' /
       '.preset.json' / '.project.json' / '.handoff.json' / '.agent.json' / '.model.json'
       字面量（filePath + '.meta.json' 内联形态），或经 projectSidecarPath() /
       presetSidecarPath() / agentSidecarPath() / modelSidecarPath() helper（后缀在 helper
       定义处的间接形态）；文件内任意位置的后缀提及不豁免无关写点（语句级判定）。
    ② 非 sessions 目标：写目标表达式（含同函数内单跳直接赋值链，如
       const tmpFile = join(tmpdir(), …) 随后的 writeFileSync(tmpFile, …)）可见地经
       tmpdir() 或 NON_SESSIONS_DERIVATIONS 枚举的 taiji 自有目录推导函数构造，且该语句
       无 sessions 痕迹（可见的 sessions 构造不豁免），目标不指向 sessions 目录则放行。
    ③ restore-time 归一化临时名（登记表 §4 ⑨，restore-fork-attach-fix W1 F3）：写目标
       语句或其同函数单跳赋值链（如 const tmpPath = join(dirname, basename + '.tmp-migrate-'
       + ts + '.jsonl') 后的 writeFileSync(tmpPath, …)）含 '.tmp-migrate-' 字面量后缀
       （normalizeSessionFileInPlace 构造的同目录临时名，写后紧跟 renameSync 原子覆盖
       原文件）。该形态是 inactive-only 的一次性 legacy 文件归一化，合法边界以登记表
       条目为准。

allowlist（ALLOWLIST）：
  文件级登记例外表（键 = 仓库相对路径，值 = 理由摘要；详情以
  docs/architecture/data-source-registry.md §4 对应条目为准，豁免闭环 = 先登记表补条目
  + 本表登记（§5 第 3 条），禁止在代码里静默绕过）。W11 曾清空为空集（三条 legacy
  直写链路 persistSessionName / persistHandedOff / patchSessionCwd 已迁移或删除）；
  布局迁移 U14a）——jsonl rename-only，writeFile 仅三件套 union tmp+rename 原子写。
  匹配语义：文件级——该文件内未落内置豁免（条件 B）的写点按本表放行，命中处以
  「文件:行」在通过报告中列出（防条目遮蔽新增写点而不可见）。

与参照实现 check_path_whitelist.py 的差异（有意设计，非疏漏）：
  参照实现全文 re.search 不滤注释；本脚本匹配前剥离注释（// 行注释与块注释，保留字符串
  字面量与行号，与 W11 验收 1 的注释感知 grep `grep -vE ':[[:space:]]*(//|\\*)'` 同语义
  取向），并将 sessions 痕迹限定为路径构造语境——防两类形态：① 实现退化为裸 token
  全文匹配（恰是条件 A 明言不计入的「字符串文案普通提及」形态）；② 未来注释文本出现
  join(x, 'sessions') / 'sessions/' 类真实路径构造模式（当前代码零实例，防御性预留）。
  main 结构与 docstring 体例对齐参照实现。

检出边界（诚实声明）：
  - 目标路径经形参间接且整个文件无代码语境 sessions 痕迹的写点不命中（跨文件数据流
    静态不可判定）——session-fork.ts:175 createForkedSessionFile 即此形态（调用点传
    getSessionsDir()，fork 文件内唯一 sessions token 在 JSDoc 注释）。该形态的守卫 =
    登记表「创建型唯一写入口」声明（§4 ⑥）+ S1 语义层。
  - fd 型续写（writeSync(fd, …)）与流实例的 .write(chunk) 方法调用不在写调用清单——
    其源头 openSync('a') / createWriteStream(path) 已被拦截（同根拦截口径；openSync 形态
    随 W11 删除，createWriteStream 形态 W5 补入）。
  - 条件 B 可见性为「语句级 + 同函数单跳赋值链（最近同名赋值）」，更深数据流不可见
    （与 plan r5/r6 的单跳实现取向一致）；字符串字面量内的 API 名提及、正则字面量
    属剥离器/匹配器的已知盲区。
  - 测试文件不进扫描：__tests__/ 与 test/ 目录、*.test.* / *.spec.* 文件；scripts/ 根
    的 verify-* 与 *-e2e.* 端到端 harness 同为测试构造数据（plan「测试构造数据的写点
    非生产写路径，排除是政策性正确」在 scripts/ 侧的延伸——verify-scheduler-e2e.cjs
    :127 的 join(root, 'sessions') trace + :864 legacy scheduler store 预置写即此形态；
    plan 验收 4 的 exit 0 论证未枚举 scripts/ 实况，该延伸是当前 HEAD exit 0 的必要
    条件，已在 W3 汇报中上报主 agent）。

退出码：
  0 — 通过
  2 — 检查失败
"""

import re
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent

# 扫描根：runtime 源码 + 仓库根脚本（.githooks / packages 其他子包不在 R1 范围）
SCAN_ROOTS = [
    PROJECT_ROOT / "packages/runtime/src",
    PROJECT_ROOT / "scripts",
]

SCAN_SUFFIXES = {".ts", ".tsx", ".js", ".mjs", ".cjs", ".sh"}

REGISTRY_DOC = "docs/architecture/data-source-registry.md"

# ---------------------------------------------------------------------------
# 条件 A：sessions 路径推导痕迹（代码语境；注释已在匹配前剥离）
# ---------------------------------------------------------------------------
TRACE_PATTERNS = [
    re.compile(r"\bgetSessionsDir\b"),      # import / 调用 / 定义
    re.compile(r"['\"]sessions['\"]"),      # join(…, 'sessions', …) 参数形态的引号 token
    re.compile(r"['\"`]sessions/"),         # 'sessions/…' 路径段字面量
]

# ---------------------------------------------------------------------------
# 写调用形态（plan W3 冻结清单；atomicWrite 含同族 async 变体）
# ---------------------------------------------------------------------------
WRITE_CALL_PATTERNS = [
    # openSync 首参允许一层括号嵌套（join(...) 形态），flag 限定第二参 'a'/'w'
    ("openSync('a'/'w')", re.compile(
        r"\bopenSync\s*\(\s*(?:[^(),()]|\([^()]*\))+\s*,\s*['\"](?:a|w)['\"]"
    )),
    ("appendFile(Sync)", re.compile(r"\bappendFile(?:Sync)?\s*\(")),
    ("writeFile(Sync)", re.compile(r"\bwriteFile(?:Sync)?\s*\(")),
    ("atomicWrite(家族)", re.compile(r"\batomicWrite(?:Async)?\s*\(")),
    # createWriteStream：流式写形态（W5 补齐审计 #9 缺口），无 flag 限定（默认 'w'）。
    # 写目标判定复用条件 A/B 框架：logger.ts 等合法用例靠「条件 A 不命中（sessions 仅
    # 注释）」或 B② NON_SESSIONS_DERIVATIONS 豁免，无需 allowlist 条目。
    ("createWriteStream", re.compile(r"\bcreateWriteStream\s*\(")),
]

# 写目标首参标识符提取（用于同函数单跳赋值链回溯）
TARGET_ARG_RE = re.compile(
    r"\b(?:openSync|appendFile(?:Sync)?|writeFile(?:Sync)?|atomicWrite(?:Async)?|createWriteStream)"
    r"\s*\(\s*([A-Za-z_$][\w$]*)\s*[,)]"
)

# ---------------------------------------------------------------------------
# 条件 B①：sidecar 家族四后缀（登记表 §4 ⑤，豁免清单与本条一一对应）
# ---------------------------------------------------------------------------
SIDECAR_SUFFIX_RE = re.compile(r"['\"]\.(?:meta|preset|project|handoff|agent|model)\.json['\"]")
# persistBindingSidecar 公共层的参数形态（实参恒为上述 xxxSidecarPath helper——
# sidecar 家族公共写入抽取后的间接一层；code-simplify 批次补充识别）
SIDECAR_HELPER_RE = re.compile(r"\b(?:(?:project|preset|agent|model)SidecarPath|sidecarPathOf)\s*\(")

# ---------------------------------------------------------------------------
# 条件 B③：restore-time 归一化临时名（登记表 §4 ⑨，restore-fork-attach-fix W1 F3）。
#   normalizeSessionFileInPlace 写同目录临时名 <原名>.tmp-migrate-<ts>.jsonl 后紧跟
#   renameSync 原子覆盖原文件——inactive-only 一次性 legacy 归一化（strip session_end /
#   header cwd fallback），与 B① 同为「登记表条目 ↔ 豁免模式一一对应」的语句级判定。
# ---------------------------------------------------------------------------
TMP_MIGRATE_SUFFIX_RE = re.compile(r"['\"]\.tmp-migrate-")

# ---------------------------------------------------------------------------
# 条件 B②：非 sessions 目标的可见推导锚点（spec 指定「脚本内维护枚举清单」）
#   tmpdir() + taiji 自有目录/文件推导函数。getPiRoot/getPiAgentDir 亦纳入——经它们构造
#   sessions 路径会在语句上留下痕迹 token，由「语句含 sessions 痕迹则不豁免」守卫兜住。
# ---------------------------------------------------------------------------
NON_SESSIONS_DERIVATIONS_RE = re.compile(
    r"\b(?:"
    r"tmpdir|"
    r"getAttachmentsDir|getConfigDir|getDataDir|getExtensionsDir|getNpmDir|getTmpDir|"
    r"getCacheDir|getLogsDir|getPluginsDir|"
    r"getAgentsDir|getModelsPath|getSettingsPath|getPiRoot|getPiAgentDir"
    r")\s*\("
)

ASSIGN_RE_TMPL = r"^[ \t]*(?:const|let|var)\s+{name}\s*="
CHAIN_LOOKBACK_LINES = 10   # 同函数单跳赋值链的最大回溯行数
STATEMENT_MAX_SPAN = 5      # 多行语句（括号未闭合）向下拼接的最大行数

# ---------------------------------------------------------------------------
# allowlist：文件级登记例外（registry_doc §4 条目 ↔ 本表一一对应；§5 维护规约第 3 条
# 闭环流程——先登记表补条目，再在此登记，禁止代码静默绕过）。键 = 仓库相对路径
# （文件级），值 = 理由摘要 + 登记表条目锚；命中处在通过报告按「文件:行」列出。
# 行号键随脚本漂移永不生效（教训 impl-plan D-10），dev 侧行号键条目已转文件级。
# ---------------------------------------------------------------------------
ALLOWLIST: dict[str, str] = {
    # 登记表 §4 ⑭（session-reader 布局迁移 U14a / orchestrator D-7 登记）：
    # 一次性手工迁移脚本（node 直跑，不在 app 启动路径）——对 session jsonl 本体
    # 一律 rename-only（步骤 1 rename pi→备份 / 步骤 3/4 header.cwd 分发与旧旧布局
    # 兼并均为 renameSync 搬移）；writeFile 仅 provider 三件套 keyed union 的
    # tmp+rename 原子写与 sessionDir 清除写回（写目标为 agent/ 下 provider 配置，
    # 非 session JSONL 本体，pi 唯一写方原则不破）。前置步骤 0b 进程检测 fail-fast
    # 保证运行时无 pi 并发写方。设计锚：extensions/universal/session-reader/docs/
    # 2026-09-10-session-root-discovery-and-env-transparency.md §6.11。
    # db-isolation W5a 清理工具（dev-0.9.16 侧登记，registry §4 对应条目锚见该侧）：
    # 残留清单/操作凭证落盘两写点，原行号键 :445/:464 转文件级。
    "scripts/zcode-session-db-cleanup.mjs": "zcode 会话 db 清理工具：残留清单/操作凭证落盘两写点（原行号键 :445/:464 转文件级）",
}

# ---------------------------------------------------------------------------
# 语句级特征登记（防线补强）：文件级键放行后，该文件内**新增**未登记写点不再被
# 机器拦截（只落入人读通过报告）——本表为每个文件级条目登记已评审写调用语句的
# 特征正则（按调用形态锚定，不用行号——行号键随脚本漂移永不生效，教训 impl-plan
# D-10）。放行时写点语句匹配任一特征 = 已登记写点静默放行；不匹配 = 仍放行
# （登记滞后不阻断提交）但输出 [WARN] 提示同步登记表与本表，防新增写点在文件级
# 键下静默扩面。新增 ALLOWLIST 条目时应同步登记特征。
# ---------------------------------------------------------------------------
ALLOWLIST_STMT_PATTERNS: dict[str, tuple[re.Pattern, ...]] = {
    # writeAtomic 内唯一写调用（fsMod.writeFileSync(tmp, content) 形态）
    # 残留清单/操作凭证两写点（fs.writeFileSync(...) 同形态）
    "scripts/zcode-session-db-cleanup.mjs": (
        re.compile(r"\bfs\.writeFileSync\s*\("),
    ),
}


def strip_comments(text: str) -> str:
    """剥离 JS/TS 注释，保留字符串字面量与行号（注释字符替换为等长空白）。

    字符级扫描：// 行注释、块注释整体置空；单/双引号与模板字符串内容原样保留。
    已知盲区（docstring 已声明）：正则字面量（如 /'/）可能被误判为字符串定界，
    影响仅限个别行的形态判断，不影响行数。
    """
    out: list[str] = []
    i, n = 0, len(text)
    state = "code"
    while i < n:
        c = text[i]
        nxt = text[i + 1] if i + 1 < n else ""
        if state == "code":
            if c == "/" and nxt == "/":
                state = "line"
                out.append("  ")
                i += 2
                continue
            if c == "/" and nxt == "*":
                state = "block"
                out.append("  ")
                i += 2
                continue
            if c == "'":
                state = "sq"
            elif c == '"':
                state = "dq"
            elif c == "`":
                state = "tpl"
            out.append(c)
            i += 1
            continue
        if state == "line":
            if c == "\n":
                state = "code"
                out.append(c)
            else:
                out.append(" ")
            i += 1
            continue
        if state == "block":
            if c == "*" and nxt == "/":
                state = "code"
                out.append("  ")
                i += 2
                continue
            out.append("\n" if c == "\n" else " ")
            i += 1
            continue
        # 字符串态：保留内容（含定界符），处理转义
        if c == "\\" and nxt:
            out.append(c)
            out.append(nxt)
            i += 2
            continue
        if (state == "sq" and c == "'") or (state == "dq" and c == '"') or (state == "tpl" and c == "`"):
            state = "code"
        out.append(c)
        i += 1
        continue
    return "".join(out)


def strip_shell_comment_lines(text: str) -> str:
    """shell 文件的前置处理：# 注释行内容替换为等长空白（保行号），再走 JS 剥离器。"""
    return re.sub(r"(?m)^[ \t]*#.*$", lambda m: " " * len(m.group(0)), text)


def is_test_file(rel: Path) -> bool:
    """测试文件不进扫描（plan r5：测试构造数据的写点非生产写路径）。"""
    parts = rel.parts
    if any(part in ("__tests__", "test") for part in parts[:-1]):
        return True
    name = rel.name
    if ".test." in name or ".spec." in name:
        return True
    # scripts/ 根的 verify-* / *-e2e.* 端到端 harness：测试构造数据（docstring「检出边界」）
    if parts[0] == "scripts" and (name.startswith("verify-") or "-e2e." in name):
        return True
    return False


def statement_text(lines: list[str], lineno: int) -> str:
    """写调用所在语句文本：本行 + 括号未闭合时向下拼接（封顶 STATEMENT_MAX_SPAN 行）。"""
    text = lines[lineno - 1]
    depth = text.count("(") - text.count(")")
    idx = lineno
    while depth > 0 and idx < len(lines) and idx < lineno - 1 + STATEMENT_MAX_SPAN:
        nxt_line = lines[idx]
        text += "\n" + nxt_line
        depth += nxt_line.count("(") - nxt_line.count(")")
        idx += 1
    return text


def has_trace(text: str) -> bool:
    return any(p.search(text) for p in TRACE_PATTERNS)


def lookup_single_hop_assignment(lines: list[str], lineno: int, stmt: str) -> str | None:
    """写目标首参为标识符时，回溯最近的同名赋值行文本（更早的旧赋值不追——遮蔽语义）。

    B②（非 sessions 目标）与 B③（.tmp-migrate- 临时名）共用的单跳赋值链查找。
    """
    m = TARGET_ARG_RE.search(stmt)
    if not m:
        return None
    assign_re = re.compile(ASSIGN_RE_TMPL.format(name=re.escape(m.group(1))))
    for k in range(lineno - 1, max(lineno - 1 - CHAIN_LOOKBACK_LINES, 0), -1):
        prev = lines[k - 1]
        if assign_re.search(prev):
            return prev
    return None


def exempt_non_sessions_target(lines: list[str], lineno: int) -> bool:
    """条件 B②：写目标可见地经 tmpdir()/taiji 自有目录推导构造，且语句无 sessions 痕迹。"""
    stmt = statement_text(lines, lineno)
    if NON_SESSIONS_DERIVATIONS_RE.search(stmt) and not has_trace(stmt):
        return True
    # 单跳赋值链：写目标为标识符时，回溯最近的同名赋值行
    assign_line = lookup_single_hop_assignment(lines, lineno, stmt)
    if assign_line is not None:
        return bool(NON_SESSIONS_DERIVATIONS_RE.search(assign_line)) and not has_trace(assign_line)
    return False


def exempt_tmp_migrate_target(lines: list[str], lineno: int) -> bool:
    """条件 B③：写目标经 '.tmp-migrate-' 临时名构造（语句级，或单跳赋值链回溯）。

    normalizeSessionFileInPlace 的形态：先 const tmpPath = join(dirname, basename + '.tmp-migrate-'
    + ts + '.jsonl')，再 writeFileSync(tmpPath, …) —— 字面量在赋值行，写语句是标识符，
    故除语句级匹配外还需赋值链回溯（与 B② 同一单跳口径）。
    """
    stmt = statement_text(lines, lineno)
    if TMP_MIGRATE_SUFFIX_RE.search(stmt):
        return True
    assign_line = lookup_single_hop_assignment(lines, lineno, stmt)
    if assign_line is not None:
        return bool(TMP_MIGRATE_SUFFIX_RE.search(assign_line))
    return False


def check_file(filepath: Path) -> tuple[list[str], list[str]]:
    """检查单个文件，返回 (错误列表, 本文件消费掉的 allowlist 条目)。"""
    errors: list[str] = []
    consumed: list[str] = []
    rel_str = filepath.relative_to(PROJECT_ROOT).as_posix()

    try:
        raw = filepath.read_text(encoding="utf-8", errors="replace")
    except OSError as e:
        return [f"[WARN] {rel_str}: 读取失败，跳过 ({e})"], []

    text = strip_shell_comment_lines(raw) if filepath.suffix == ".sh" else raw
    stripped = strip_comments(text)

    # 条件 A：文件级 sessions 路径推导痕迹（代码语境）
    if not has_trace(stripped):
        return [], []

    lines = stripped.split("\n")
    for lineno, line in enumerate(lines, start=1):
        for label, regex in WRITE_CALL_PATTERNS:
            if not regex.search(line):
                continue
            # B① sidecar 家族四后缀（语句级，文件内任意位置的后缀提及不豁免无关写点）
            stmt = statement_text(lines, lineno)
            if SIDECAR_SUFFIX_RE.search(stmt) or SIDECAR_HELPER_RE.search(stmt):
                continue
            # B③ restore-time 归一化临时名（登记表 §4 ⑨，语句级 + 单跳赋值链回溯）
            if exempt_tmp_migrate_target(lines, lineno):
                continue
            # allowlist：文件级登记例外（data-source-registry.md §4，§5 第 3 条闭环）
            if rel_str in ALLOWLIST:
                # 语句级特征校验：匹配已登记特征 = 已评审写点静默放行；不匹配 = 新增
                # 写点，保持文件级放行（登记滞后不阻断提交）但 WARN 可见（防静默扩面）
                patterns = ALLOWLIST_STMT_PATTERNS.get(rel_str)
                if patterns is not None and not any(p.search(stmt) for p in patterns):
                    errors.append(
                        f"[WARN] {rel_str}:{lineno}: allowlist 文件级放行，但写点语句不匹配"
                        f"已登记特征（{label}）——若为新增写点，请同步 {REGISTRY_DOC} §4 条目"
                        f"与本脚本 ALLOWLIST_STMT_PATTERNS"
                    )
                consumed.append(f"{rel_str}:{lineno}")
                continue
            # B② 非 sessions 目标（tmpdir / taiji 自有目录推导，语句无 sessions 痕迹）
            if exempt_non_sessions_target(lines, lineno):
                continue
            errors.append(
                f"[ERROR] {rel_str}:{lineno}: 检出对 pi session JSONL 本体的直写候选"
                f"（{label}），所在文件含 sessions 路径推导痕迹且无豁免"
            )
            errors.append(
                f"  提示: session JSONL 本体的唯一写方是 pi。恢复动作：改经 pi RPC 或扩展 "
                f"appendEntry；若为登记例外，先在 {REGISTRY_DOC} 补条目 + 本脚本 ALLOWLIST 登记"
            )
    return errors, consumed


def main() -> int:
    all_errors: list[str] = []
    consumed_allowlist: set[str] = set()
    scanned = 0

    for root_dir in SCAN_ROOTS:
        if not root_dir.is_dir():
            all_errors.append(
                f"[WARN] 扫描根不存在，跳过: {root_dir.relative_to(PROJECT_ROOT).as_posix()}"
            )
            continue
        for filepath in sorted(root_dir.rglob("*")):
            if not filepath.is_file() or filepath.suffix not in SCAN_SUFFIXES:
                continue
            if is_test_file(filepath.relative_to(PROJECT_ROOT)):
                continue
            scanned += 1
            errors, consumed = check_file(filepath)
            all_errors.extend(errors)
            consumed_allowlist.update(consumed)

    has_error = any(e.startswith("[ERROR]") for e in all_errors)

    for e in all_errors:
        print(e)

    if has_error:
        print()
        print("\033[0;31m[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。\033[0m")
        return 2

    if not has_error:
        hits = ", ".join(sorted(consumed_allowlist)) if consumed_allowlist else "无（W11 已清空）"
        print(
            f"[OK] R1 pi session 直写检查通过：扫描 {scanned} 文件，"
            f"allowlist 命中 {len(consumed_allowlist)} 处（{hits}）"
        )

    return 0


if __name__ == "__main__":
    sys.exit(main())
