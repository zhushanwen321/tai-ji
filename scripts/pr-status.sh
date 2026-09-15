#!/usr/bin/env bash
# pr-status.sh — 三阶段 gate 状态查询
#
# 输出 JSON 描述 PR 的当前状态，让调用方（主 agent / subagent）能判断
# 三阶段 gate 各自是否通过：
#   - stage0_pr:       PR 是否存在、本地/远程同步性
#   - stage1_review:   review 报告状态（最新 aggregated.md 的 must_fix）
#   - stage2_premerge: pre-merge 验证状态（最近一次跑 pr-pre-merge.sh 的结果）
#
# 用法:
#   bash scripts/pr-status.sh
#   bash scripts/pr-status.sh --review-dir <path>   # 自定义 review 报告目录
#
# 退出码:
#   0 = 始终为 0（查询脚本，失败用 JSON 字段标记，不靠 exit code 表达）
#   1 = git 仓库缺失
#
# 约定：
#   review 目录结构（与 review-fix-loop.js 工作流对齐）：
#     $REVIEW_DIR/run-<id>/round-N/aggregated.md
#     $REVIEW_DIR/run-<id>/state.json
#
#   简短轮次（不通过 workflow，手工跑）也可：
#     $REVIEW_DIR/latest/aggregated.md

set -euo pipefail

REVIEW_DIR=".review"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --review-dir) REVIEW_DIR="$2"; shift 2 ;;
        -h|--help)
            sed -n '2,11p' "$0" | sed 's/^# \?//'
            exit 0
            ;;
        *) echo "Unknown arg: $1" >&2; exit 1 ;;
    esac
done

GIT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || { echo "Not a git repo" >&2; exit 1; })"
cd "$GIT_ROOT"

BRANCH="$(git branch --show-current)"
BASE="main"

# 把所有判断交给 python3，单一可靠输出
exec python3 - "$BRANCH" "$BASE" "$REVIEW_DIR" "$GIT_ROOT" <<'PY'
import json, os, re, subprocess, sys
from pathlib import Path

branch, base, review_dir_name, git_root = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
review_dir = Path(git_root) / review_dir_name

# ── Stage 0: PR 状态
pr_exists = False
pr_number = pr_url = pr_state = ""
pr_json_str = "[]"
if subprocess.run(["which", "gh"], capture_output=True).returncode == 0:
    r = subprocess.run(
        ["gh", "pr", "list", "--head", branch, "--base", base,
         "--state", "open", "--json", "number,url,state"],
        capture_output=True, text=True, cwd=git_root,
    )
    pr_json_str = r.stdout.strip() or "[]"
try:
    items = json.loads(pr_json_str) if pr_json_str else []
    if items:
        pr_exists = True
        pr_number = str(items[0].get("number", ""))
        pr_url = items[0].get("url", "")
        pr_state = items[0].get("state", "")
except Exception:
    pass

# local vs remote HEAD
# [HISTORICAL] bare repo workspace：origin 指向本地 bare repo（不随 push 更新），
# GitHub 远程叫 github（见 AGENTS.md §14）。必须先查 github，fallback origin（普通 repo）。
# 否则 push 成功后 local_ahead_of_origin 仍 > 0，ready_to_submit 恒 false。
commit_ahead = 0
push_state = "unknown"
try:
    remote_ref = None
    remote_name = None
    for cand in ("github", "origin"):
        rev = subprocess.run(
            ["git", "rev-parse", "--verify", f"{cand}/{branch}"],
            capture_output=True, text=True, cwd=git_root,
        )
        if rev.returncode == 0:
            remote_ref = f"{cand}/{branch}"
            remote_name = cand
            break
    if remote_ref:
        ahead = subprocess.run(
            ["git", "rev-list", "--count", f"{remote_ref}..HEAD"],
            capture_output=True, text=True, cwd=git_root,
        )
        commit_ahead = int((ahead.stdout or "0").strip() or 0)
        push_state = "in_sync" if commit_ahead == 0 else f"ahead_by_{commit_ahead}"
    else:
        push_state = "no_upstream"
except Exception:
    push_state = "error"

stage0 = {
    "pr_exists": pr_exists,
    "pr_number": pr_number,
    "pr_url": pr_url,
    "pr_state": pr_state,
    "branch": branch,
    "base": base,
    "local_ahead_of_origin": commit_ahead,
    "push_state": push_state,
}

# ── Stage 1: Review 状态
report_exists = False
latest_round = 0
latest_aggregated = ""
must_fix = suggestion = info = 0

if review_dir.is_dir():
    # 找最新 run 的最新 round：排序 key = (runId, round) 双键，runId 优先（最新 run 优先）
    # run-<id> 的 id 是 unix timestamp 秒数，大的更新；round 同理。
    def _run_round_key(p):
        run_m = re.search(r"run-(\d+)", p.parent.name)
        round_m = re.search(r"round-(\d+)", p.name)
        return (int(run_m.group(1)) if run_m else 0,
                int(round_m.group(1)) if round_m else 0)
    rounds = sorted(
        (p for p in review_dir.glob("run-*/round-*")),
        key=_run_round_key,
        reverse=True,
    )
    if not rounds:
        # 简短轮次：直接 .review/latest/aggregated.md
        latest = review_dir / "latest" / "aggregated.md"
        if latest.is_file():
            rounds = [latest.parent]
    if rounds:
        latest_round_dir = rounds[0]
        latest_aggregated = str(latest_round_dir / "aggregated.md")
        m = re.search(r"round-(\d+)", latest_round_dir.name)
        if m:
            latest_round = int(m.group(1))
        agg = Path(latest_aggregated)
        if agg.is_file():
            report_exists = True
            content = agg.read_text(errors="replace")
            # 取 ## Summary 段（到下一个 ## 标题）
            in_summary = False
            summary_text = ""
            for line in content.splitlines():
                if line.startswith("## Summary"):
                    in_summary = True
                    continue
                if in_summary and line.startswith("## "):
                    break
                if in_summary:
                    summary_text += line + "\n"

            def grab_int(label):
                m = re.search(r"[-*]\s*" + re.escape(label) + r"\s*[:：]\s*(\d+)", summary_text, re.I)
                return int(m.group(1)) if m else 0
            must_fix = grab_int("Must-fix") or grab_int("Mustfix")
            suggestion = grab_int("Suggestions") or grab_int("Suggestion")
            info = grab_int("Infos") or grab_int("Info")

stage1 = {
    "report_exists": report_exists,
    "latest_round": latest_round,
    "latest_aggregated": latest_aggregated,
    "must_fix": must_fix,
    "suggestion": suggestion,
    "info": info,
    # clean = 修复前快照的 must_fix==0。单轮不循环下 aggregated.md 数字不反映修复后状态，
    # 故 clean 不再是 ready_to_submit 的硬条件（见 ready 公式）。保留供诊断。
    "clean": (must_fix == 0),
    "clean_note": "snapshot before fix; gate closure verified by worker receipts (pr-cr-fix SKILL.md Gate-3 软 gate)",
}

# ── Stage 2: Pre-merge 状态
marker = review_dir / "premerge-result"
last_run = "never"
last_result = "not_run"
if marker.is_file():
    try:
        text = marker.read_text()
        m = re.search(r'timestamp="([^"]*)"', text)
        if m:
            last_run = m.group(1)
        m = re.search(r'result="([^"]*)"', text)
        if m:
            last_result = m.group(1)
    except Exception:
        pass

if last_result == "PASS":
    import time
    age_seconds = time.time() - marker.stat().st_mtime
    age_minutes = age_seconds / 60
    if age_minutes > 30:
        last_result = "STALE"

stage2 = {
    "marker_file": str(marker),
    "last_run": last_run,
    "result": last_result,
}

# ── 综合 ready_to_submit
# stage1.clean 不作为硬条件：「单轮不循环」下 aggregated.md 的 must_fix 是修复前快照，
# 修复闭合由 pr-cr-fix 主 agent 校验 worker 回执保证（软 gate），不由本脚本读快照数字保证。
# 硬 gate = PR 存在 + 本地已同步 + pre-merge PASS。
ready = (
    stage0["pr_exists"] is True
    and stage0["local_ahead_of_origin"] == 0
    and stage2["result"] == "PASS"
)

out = {
    "stage0_pr": stage0,
    "stage1_review": stage1,
    "stage2_premerge": stage2,
    "ready_to_submit": ready,
}
print(json.dumps(out, indent=2, ensure_ascii=False))
PY
