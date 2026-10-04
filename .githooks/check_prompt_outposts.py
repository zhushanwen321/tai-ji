#!/usr/bin/env python3
"""
用户内容出站点静态检查（adversarial-review-fixes A2 D-A2-3）

扫描 packages/runtime/src 的三个用户内容出站方法调用点（.prompt( / .steer( /
.followUp(），对照白名单（文件路径 + 行内稳定子串指纹 + 注入状态 + 登记理由）
逐一放行；未登记的新调用点 → 退出码 2 红。

设计依据与背景：原设计文档 adversarial-review-fixes.md §3.2 A2（D-A2-3；已删除，git 可追溯）——出站点检查原则：用户内容出站必须经注入器，本注释自足
起因：MF-B（@ 定向消息带 skill chip 绕过 SkillInjector 直发 client.prompt）与
MF-C（landing 首发同缺口）——注入器以「N 入口挂载」模式存在，新增用户内容
出站通路时没有「必须经注入」的机器约束，靠人记住，各漏一处。本检查把
「忘挂注入」从人责变机器责（复用 check_spawn_env_boundary.py 的成熟模式）。

扫描宽度裁决：匹配任意接收者的 `.prompt(` / `.steer(` / `.followUp(`，
不限定 `client.` 前缀——设计期 grep 用 `client.prompt(` 字面量，handoff-service
的 `srcClient.prompt(` / `newClient.prompt(` 即因此漏出（实施期实测抓回，本检查
正是为堵这类变量名形态逃逸而存在）。方法接收者改名（const c = client）不构成
绕过面。
已知边界（登记接受）：CALL_RE 按单行匹配，`client.` 在行末、`prompt(` 在次行
行首（无点号）的跨行链式形态不命中——现存代码 `await client.prompt(` 同行风格
占绝对主流（268 文件实测零漏网），多行解析复杂度与该逃逸面不成比例；若未来
出现跨行形态的新出站点且被本检查漏检，按未登记红处理（补白名单或改同行风格）。

判定模型：
1. 逐行匹配（注释行跳过：行首空白后以 // 、 * 、 /* 开头）；
2. 命中行查 OUTPOST_CALLSITES（file_suffix + line_snippet）：命中放行并计入
   白名单统计；用行内容子串而非行号做指纹，代码平移不会让登记静默漂移；
3. 未命中 → 违规，报文件:行号 + 行内容 + 修复指引。

退出码：0=通过；2=存在未登记调用点；1=脚本自身异常（含白名单结构校验失败——
白名单坏了按脚本异常红，不与「未登记违规」混码）。
白名单增删（新增出站点 / 语义变化）须同步本头注释的登记理由（原设计文档已删除，git 可追溯）
A2 节登记并过评审——内部命令（cancel/workflows/__taiji_*__）与代理构造模板文本
可豁免注入，用户内容必须挂 SkillInjector 后登记 injected。

用法：无参（默认扫仓库根）| --root <dir>（自定扫描根，供测试 fixture 用）。
"""

import argparse
import os
import re
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SCAN_ROOT = "packages/runtime/src"

EXCLUDED_DIR_PARTS = {"__tests__", "test"}
EXCLUDED_FILE_SUFFIXES = (".test.ts", ".spec.ts", ".d.ts")

# 出站方法调用点模式：任意接收者 + 方法名 + (。(?<![\w)]) 排除裸函数调用 prompt(
# 形态；接收者限定点号后（无点号的方法定义 / 接口声明不命中）。
OUTPOST_METHODS = ("prompt", "steer", "followUp")
CALL_RE = re.compile(r"\.\s*(prompt|steer|followUp)\s*\(")

# 注释行剥离：行首空白后以 // 、 * 、 /* 开头的行不参与调用点匹配
COMMENT_LINE_RE = re.compile(r"^\s*(?://|/\*|\*)")

# ---------------------------------------------------------------------------
# 白名单（file_suffix, line_snippet, injection, reason）
#   injection:    'injected'（用户内容，经 SkillInjector 处理后出站）| 'exempt'
#                 （豁免注入——仅限内部命令 / 固定模板 / 代理构造文本，非 skill
#                 chip 出口路径；用户内容登记 exempt 属错登记，语义边界机器不可
#                 判定，靠本注释 + 评审约束）
#   line_snippet 必须是调用点行的真实子串（行内容子串防行号漂移）。
# ---------------------------------------------------------------------------

OUTPOST_CALLSITES = [
    # --- 已挂注入（用户内容） ---
    (
        "services/session/session-delivery-registry.ts",
        "await client.prompt(text, opts.images, opts.behavior)",
        "injected",
        "[u2 内核化] deliverOne 单点出站（port.send 逐条实现 + sendDirect 共用；landing 首发 / "
        "session_manager send / completion-backflow 三消费方均经此）：唯一调用方在 "
        "injector.inject 之后按注入后文本调用（deliverOne 内 injection.text → "
        "promptWithBusyRetry 透传），busy-retry 只改 opts.behavior、文本不换，复用同一"
        "已注入文本；前一版 deliverText 调用点随重构消失，旧条目 "
        "client.prompt(injection.text, undefined, streamingBehavior) 已替换",
    ),
    (
        "services/session/session-delivery-registry.ts",
        "await client.prompt(text, opts.images, opts.behavior, undefined, 0)",
        "injected",
        "[U1 D14③] 同上一条目出站点的命令档条件传参形态（G3 三闸联动：第 4 参无附件、"
        "第 5 参 0=不限时档，仅命令条目走此分支）：文本同为 deliverOne 注入后文本，"
        "注入语义与上一条目完全一致，仅超时档位参数差异",
    ),
    (
        "services/session/session-records.ts",
        "/subagents message ${params.subagentId}",
        "injected",
        "[A2 MF-B] subagentAction message：encodeDirectiveText 之前对原始 text 注入",
    ),
    (
        "services/session/session-records.ts",
        "/subagents start ${params.slug}",
        "injected",
        "[A2 MF-B] subagentAction start：encode 之前对原始 task 注入（@ 定向首发）",
    ),
    # --- 内部命令 / 代理构造模板（豁免注入） ---
    (
        "services/session/session-records.ts",
        "/subagents cancel ${params.subagentId}",
        "exempt",
        "cancel 只带 subagentId（runtime 自产 id，非用户内容），设计显式跳过注入",
    ),
    (
        "services/session/session-records.ts",
        "/workflows ${action} ${runId}",
        "exempt",
        "workflowAction 生命周期命令（action/runId 均 runtime 域枚举与 id）",
    ),
    (
        "services/session/session-service.ts",
        "client.prompt(BG_RECONCILE_COMMAND, undefined, undefined, { maintenance: true })",
        "exempt",
        "bg-notify redelivery 触发命令（无参字面命令，[2026-09-25] 替换退役的"
        " /__taiji_reload__ 条目）；带 maintenance 标记——激活触发不刷新 RpcClient"
        " 空闲时钟（频繁切会话不污染回收判定）",
    ),
    (
        "services/session/trace-sync.ts",
        "'/__taiji_get_system_prompt__'",
        "exempt",
        "system-prompt 留痕探针内部命令（builtin agent-ext 包注册，无用户内容）",
    ),
    (
        "services/session/message-dispatcher.ts",
        "await client.prompt(commandLine)",
        "exempt",
        "[message-revoke U4] sendSystemCommand 系统信令旁路：commandLine = 内部命令名"
        "（__taiji_nav__）+ runtime 域 entryId，无用户内容（与 __taiji_reload__ 豁免同族）；"
        "不经 hook/不经内核（设计 D1 信令通道决策）",
    ),
    (
        "services/handoff-service.ts",
        "srcClient.prompt(buildHandoffPrompt())",
        "exempt",
        "handoff turn 固定模板（buildHandoffPrompt 无参常量文本，非 composer 富内容"
        "出口）；设计期 grep 用 client. 字面量漏出的调用点，实施期实测抓回归档登记",
    ),
    (
        "services/handoff-service.ts",
        "newClient.prompt(finalPrompt)",
        "exempt",
        "承接 session 开场注入：LLM 产出的 handoff 文档 + sanitizeReply 清洗后的"
        "用户附言（控制字符折叠 + 截断）——非 composer skill chip 出口路径，"
        "登记豁免；若未来 handoff 支持富内容需回头重审",
    ),
    (
        "services/session/session-service.ts",
        "client.prompt('/plan abort')",
        "exempt",
        "abortPlan 退出命令：固定命令字面量（无任何用户内容插值），pi 对 / 前缀"
        "prompt 先行执行 extension command；刻意绕 busy 预检（workflowAction 先例，"
        "设计 D5/E9——挂起审批期退出是高概率动线）。MF-1-7 编排自 transport"
        "handler 下沉 session-service（形态对齐 promptReload/workflowAction 命令"
        "编排区），豁免条目随调用点迁移",
    ),
]

# injection 字段合法枚举（白名单加载校验用）：typo 条目既无法放行匹配也不进统计口径，
# 带病扫描等于登记表失效，必须启动即红
VALID_INJECTIONS = ("injected", "exempt")


def validate_whitelist():
    """白名单结构校验（启动即红，exit 1=脚本自身异常通道，非违规码 2）。

    注入语义约束（用户内容必须 'injected'，'exempt' 仅限内部命令/固定模板/代理
    构造文本）为评审约束——原 content_kind 字段与 injection 100% 对角相关（用户
    ↔injected、内部↔exempt），双字段同表意已合并为单字段，语义性错登记机器不可
    判定；机器可判定的结构错误（枚举外值 / 空字段）在此拦截。
    """
    for i, (suffix, snippet, injection, reason) in enumerate(OUTPOST_CALLSITES):
        if not suffix or not snippet or not reason:
            print(f"[ERROR] 白名单条目 #{i} 结构不完整（suffix/snippet/reason 均不得为空）", file=sys.stderr)
            return False
        if injection not in VALID_INJECTIONS:
            print(
                f"[ERROR] 白名单条目 #{i} injection 非法: {injection!r}"
                f"（合法值 {'/'.join(VALID_INJECTIONS)}）——修正 .githooks/check_prompt_outposts.py OUTPOST_CALLSITES",
                file=sys.stderr,
            )
            return False
    return True


def iter_ts_files(scan_base, unreadable_dirs=None):
    def _onerror(err):
        # 不可读目录不得静默漏扫（红线：漏报无信号）——stderr 显形 + 计数
        name = getattr(err, "filename", None) or str(err)
        print(f"[WARN] 目录不可读，跳过: {name}", file=sys.stderr)
        if unreadable_dirs is not None:
            unreadable_dirs.append(name)

    for dirpath, dirnames, filenames in os.walk(scan_base, onerror=_onerror):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDED_DIR_PARTS]
        for name in sorted(filenames):
            if not name.endswith(".ts"):
                continue
            if name.endswith(EXCLUDED_FILE_SUFFIXES):
                continue
            yield os.path.join(dirpath, name)


def exempted(rel_path, line_text):
    for suffix, snippet, _injection, _reason in OUTPOST_CALLSITES:
        if rel_path.endswith(suffix) and snippet in line_text:
            return True
    return False


FIX_HINT = """[fix] 用户内容出站必须经 SkillInjector（packages/runtime/src/services/session/skill-injector.ts）:
      在 client.prompt/steer/followUp 之前: const injection = await injector.inject(client, text)
      发送成功后发布提示: publishSkillNotices(getMessageBus(), sessionId, text, injection.notices)
      （共享函数 skill-notice-publisher.ts；时机契约 = client 发送 await 之后）
      内部命令/固定模板可豁免: .githooks/check_prompt_outposts.py OUTPOST_CALLSITES
      登记四元组（文件+指纹+注入状态+理由）后过评审
      设计依据: adversarial-review-fixes.md §3.2 A2（已删除，git 可追溯）"""


def staged_files():
    """暂存区文件清单（仓库根相对 posix 路径）。非 git 环境返回 None = 回退全目录扫描。"""
    import subprocess

    try:
        out = subprocess.run(
            ["git", "diff", "--cached", "--name-only", "-z"],
            capture_output=True, cwd=REPO_ROOT,
        )
    except OSError:
        return None
    if out.returncode != 0:
        return None
    return {p for p in out.stdout.decode("utf-8", errors="replace").split("\0") if p}


def run(scan_root):
    if not validate_whitelist():
        return 1
    violations = []  # (rel_path, lineno, method, line)
    exempt_hits = []  # (rel_path, lineno)
    unreadable_dirs = []  # os.walk onerror 收集（不可读目录 = 漏扫面，须显形）
    files = sorted(iter_ts_files(scan_root, unreadable_dirs))
    staged = staged_files()  # 扫描面 = staged ∩ 规则树；提交者对自己提交的面负责
    scanned = 0

    for path in files:
        rel_repo = os.path.relpath(path, REPO_ROOT).replace(os.sep, "/")
        if staged is not None:
            if rel_repo not in staged:
                continue
            if not os.path.exists(path):  # staged 删除项无可扫描内容
                continue
        scanned += 1
        rel_path = os.path.relpath(path, scan_root).replace(os.sep, "/")
        try:
            with open(path, encoding="utf-8") as f:
                source = f.read()
        except OSError as e:
            print(f"[ERROR] 无法读取 {rel_path}: {e}", file=sys.stderr)
            return 1

        for lineno, line in enumerate(source.splitlines(), start=1):
            if COMMENT_LINE_RE.match(line):
                continue
            m = CALL_RE.search(line)
            if not m:
                continue
            if exempted(rel_path, line):
                exempt_hits.append((rel_path, lineno))
            else:
                violations.append((rel_path, lineno, m.group(1), line))

    injected_count = sum(1 for e in OUTPOST_CALLSITES if e[2] == "injected")
    exempt_count = sum(1 for e in OUTPOST_CALLSITES if e[2] == "exempt")
    print(
        f"[prompt-outposts] 扫描 ts 文件 {len(files)} | 白名单登记 {len(OUTPOST_CALLSITES)} 条 "
        f"(已注入 {injected_count} / 内部豁免 {exempt_count}) | "
        f"命中放行 {len(exempt_hits)} 处 | 未登记违规 {len(violations)}"
        + (f" | 目录不可读跳过 {len(unreadable_dirs)} 个" if unreadable_dirs else "")
    )

    if staged is not None and scanned == 0:
        print("[prompt-outposts] staged 无 packages/runtime/src 规则树文件，跳过扫描")
        return 0
    if violations:
        print("")
        print("[FAIL] 以下用户内容出站方法调用点未在白名单登记:")
        for rel_path, lineno, method, line in violations:
            print(f"  {rel_path}:{lineno} [.{method}(]")
            print(f"    > {line.strip()[:120]}")
        print("")
        print(FIX_HINT)
        return 2
    return 0


def main():
    parser = argparse.ArgumentParser(description="用户内容出站点检查（A2 D-A2-3）")
    parser.add_argument(
        "--root",
        default=REPO_ROOT,
        help="扫描根目录（默认仓库根；测试 fixture 传 tmp 目录）",
    )
    args = parser.parse_args()
    scan_base = os.path.join(args.root, SCAN_ROOT)
    if not os.path.isdir(scan_base):
        print(f"[ERROR] 扫描根不存在: {scan_base}", file=sys.stderr)
        return 1
    return run(scan_base)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001 检查自身崩溃不能静默放行
        print(f"[ERROR] 检查脚本异常: {exc}", file=sys.stderr)
        sys.exit(1)
