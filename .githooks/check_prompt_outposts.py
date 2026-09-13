#!/usr/bin/env python3
"""
用户内容出站点静态守卫（adversarial-review-fixes A2 D-A2-3）

扫描 packages/runtime/src 的三个用户内容出站方法调用点（.prompt( / .steer( /
.followUp(），对照白名单（文件路径 + 行内稳定子串指纹 + 内容性质 + 注入状态 +
登记理由）逐一放行；未登记的新调用点 → 退出码 2 红。

设计依据与背景：原设计文档 adversarial-review-fixes.md §3.2 A2（D-A2-3；已删除，git 可追溯）——出站点守卫原则：用户内容出站必须经注入器，本注释自足
起因：MF-B（@ 定向消息带 skill chip 绕过 SkillInjector 直发 client.prompt）与
MF-C（landing 首发同缺口）——注入器以「N 入口挂载」模式存在，新增用户内容
出站通路时没有「必须经注入」的机器约束，靠人记住，各漏一处。本守卫把
「忘挂注入」从人责变机器责（复用 check_spawn_env_boundary.py 的成熟模式）。

扫描宽度裁决：匹配任意接收者的 `.prompt(` / `.steer(` / `.followUp(`，
不限定 `client.` 前缀——设计期 grep 用 `client.prompt(` 字面量，handoff-service
的 `srcClient.prompt(` / `newClient.prompt(` 即因此漏出（实施期实测抓回，本守卫
正是为堵这类变量名形态逃逸而存在）。方法接收者改名（const c = client）不构成
绕过面。
已知边界（登记接受）：CALL_RE 按单行匹配，`client.` 在行末、`prompt(` 在次行
行首（无点号）的跨行链式形态不命中——现存代码 `await client.prompt(` 同行风格
占绝对主流（268 文件实测零漏网），多行解析复杂度与该逃逸面不成比例；若未来
出现跨行形态的新出站点且被本守卫漏检，按未登记红处理（补白名单或改同行风格）。

判定模型：
1. 逐行匹配（注释行跳过：行首空白后以 // 、 * 、 /* 开头）；
2. 命中行查 OUTPOST_CALLSITES（file_suffix + line_snippet）：命中放行并计入
   白名单统计；用行内容子串而非行号做指纹，代码平移不会让登记静默漂移；
3. 未命中 → 违规，报文件:行号 + 行内容 + 修复指引。

退出码：0=通过；2=存在未登记调用点；1=脚本自身异常。
白名单增删（新增出站点 / 语义变化）须同步本头注释的登记理由（原设计文档已删除，git 可追溯）
A2 节登记并过评审——内部命令（cancel/workflows/__xyz_*__）与代理构造模板文本
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
# 白名单（file_suffix, line_snippet, content_kind, injection, reason）
#   content_kind: 'user'（用户内容，composer 富内容出口）| 'internal'（内部命令 /
#                 固定模板 / 代理构造文本——非 skill chip 出口路径）
#   injection:    'injected'（经 SkillInjector 处理）| 'exempt'（豁免——无标记
#                 天然 no-op 也不走注入开销，或非用户内容语义上不需要）
#   line_snippet 必须是调用点行的真实子串（行内容子串防行号漂移）。
# ---------------------------------------------------------------------------

OUTPOST_CALLSITES = [
    # --- 已挂注入（用户内容） ---
    (
        "services/session/message-dispatcher.ts",
        "client.prompt(injection.text, images)",
        "user",
        "injected",
        "sendPrompt 骨架（composer 直发主链基准）：injector.inject 在 hook 之后、"
        "prompt 之前（D9 挂载契约）",
    ),
    (
        "services/session/message-dispatcher.ts",
        "client.steer(injection.text)",
        "user",
        "injected",
        "steerMessage：入队前统一注入（与 sendPrompt 同构）",
    ),
    (
        "services/session/message-dispatcher.ts",
        "client.followUp(injection.text)",
        "user",
        "injected",
        "followUpMessage：入队前统一注入（与 sendPrompt 同构）",
    ),
    (
        "services/session/session-delivery-registry.ts",
        "client.prompt(injection.text, undefined, streamingBehavior)",
        "user",
        "injected",
        "[A2 MF-C] deliverText 单点出站：三消费方（landing 首发直投 sendDirect / "
        "session_manager send 的 agent 构造 prompt / completion-backflow 回流通知）"
        "统一「字面标记即展开、无标记 no-op」（设计 D-A2-1 裁决）",
    ),
    (
        "services/session/session-records.ts",
        "/subagents message ${params.subagentId}",
        "user",
        "injected",
        "[A2 MF-B] subagentAction message：encodeDirectiveText 之前对原始 text 注入",
    ),
    (
        "services/session/session-records.ts",
        "/subagents start ${params.slug}",
        "user",
        "injected",
        "[A2 MF-B] subagentAction start：encode 之前对原始 task 注入（@ 定向首发）",
    ),
    # --- 内部命令 / 代理构造模板（豁免注入） ---
    (
        "services/session/session-records.ts",
        "/subagents cancel ${params.subagentId}",
        "internal",
        "exempt",
        "cancel 只带 subagentId（runtime 自产 id，非用户内容），设计显式跳过注入",
    ),
    (
        "services/session/session-records.ts",
        "/workflows ${action} ${runId}",
        "internal",
        "exempt",
        "workflowAction 生命周期命令（action/runId 均 runtime 域枚举与 id）",
    ),
    (
        "services/session/session-service.ts",
        "prompt('/__xyz_reload__', undefined, undefined, { maintenance: true })",
        "internal",
        "exempt",
        "promptReload 内部命令（无参字面命令）；idle-pi-reclamation D1 起带 maintenance"
        " 标记——维护通道不刷新 RpcClient 空闲时钟（skill 变更风暴不污染回收判定）",
    ),
    (
        "services/session/trace-sync.ts",
        "'/__xyz_get_system_prompt__'",
        "internal",
        "exempt",
        "system-prompt 留痕探针内部命令（builtin agent-ext 包注册，无用户内容）",
    ),
    (
        "services/handoff-service.ts",
        "srcClient.prompt(buildHandoffPrompt())",
        "internal",
        "exempt",
        "handoff turn 固定模板（buildHandoffPrompt 无参常量文本，非 composer 富内容"
        "出口）；设计期 grep 用 client. 字面量漏出的调用点，实施期实测抓回归档登记",
    ),
    (
        "services/handoff-service.ts",
        "newClient.prompt(finalPrompt)",
        "internal",
        "exempt",
        "承接 session 开场注入：LLM 产出的 handoff 文档 + sanitizeReply 清洗后的"
        "用户附言（控制字符折叠 + 截断）——非 composer skill chip 出口路径，"
        "登记豁免；若未来 handoff 支持富内容需回头重审",
    ),
]


def iter_ts_files(scan_base):
    for dirpath, dirnames, filenames in os.walk(scan_base):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDED_DIR_PARTS]
        for name in sorted(filenames):
            if not name.endswith(".ts"):
                continue
            if name.endswith(EXCLUDED_FILE_SUFFIXES):
                continue
            yield os.path.join(dirpath, name)


def exempted(rel_path, line_text):
    for suffix, snippet, _kind, _inj, _reason in OUTPOST_CALLSITES:
        if rel_path.endswith(suffix) and snippet in line_text:
            return True
    return False


FIX_HINT = """[fix] 用户内容出站必须经 SkillInjector（packages/runtime/src/services/session/skill-injector.ts）:
      在 client.prompt/steer/followUp 之前: const injection = await injector.inject(client, text)
      发送成功后发布提示: publishSkillNotices(getMessageBus(), sessionId, text, injection.notices)
      （共享函数 skill-notice-publisher.ts；时机契约 = client 发送 await 之后）
      内部命令/固定模板可豁免: .githooks/check_prompt_outposts.py OUTPOST_CALLSITES
      登记五元组（文件+指纹+内容性质+注入状态+理由）后过评审
      设计依据: adversarial-review-fixes.md §3.2 A2（已删除，git 可追溯）"""


def run(scan_root):
    violations = []  # (rel_path, lineno, method, line)
    exempt_hits = []  # (rel_path, lineno)
    files = sorted(iter_ts_files(scan_root))

    for path in files:
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

    user_injected = sum(1 for e in OUTPOST_CALLSITES if e[3] == "injected")
    internal_exempt = sum(1 for e in OUTPOST_CALLSITES if e[3] == "exempt")
    print(
        f"[prompt-outposts] 扫描 ts 文件 {len(files)} | 白名单登记 {len(OUTPOST_CALLSITES)} 条 "
        f"(用户内容已注入 {user_injected} / 内部命令豁免 {internal_exempt}) | "
        f"命中放行 {len(exempt_hits)} 处 | 未登记违规 {len(violations)}"
    )

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
    parser = argparse.ArgumentParser(description="用户内容出站点守卫（A2 D-A2-3）")
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
    except Exception as exc:  # noqa: BLE001 守卫自身崩溃不能静默放行
        print(f"[ERROR] 守卫脚本异常: {exc}", file=sys.stderr)
        sys.exit(1)
