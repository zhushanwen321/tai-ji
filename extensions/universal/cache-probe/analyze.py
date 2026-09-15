#!/usr/bin/env python3
"""cache-probe 归因分析脚本（设计文档 cache-probe-design §7.2）。

输入一个或多个 sessions 目录，输出：
  1. 扫描概览（含 error entry / 畸形行计数，失败要出声）
  2. 命中率基线（与设计文档 §3.1 同口径，供交叉验证）
  3. 归因矩阵：gap<30min + 模型未切换 的 turn 首笔 miss，按前缀变化与否分档
  4. 进程边界（baseline entry）前后指纹漂移统计
  5. 快照方案 GO/NO-GO 决策建议

entry schema v2：normal entry 只存变化项（增量），本脚本回放合并为全量指纹。

用法：python3 extensions/universal/cache-probe/analyze.py ~/.pi/agent/sessions [--since 2026-08-01]
只读，不修改任何文件。
"""
import argparse
import json
import os
import sys
from collections import defaultdict
from datetime import datetime

SKIP_PAT = ("var-folders", "private-tmp")
GAP_BUCKETS = [(0, 300, "a.<5min"), (300, 1800, "b.5-30min"),
               (1800, 43200, "c.30min-12h"), (43200, float("inf"), "d.>12h")]


def parse_ts(s):
    if not s:
        return None
    for fmt in ("%Y-%m-%dT%H:%M:%S.%f%z", "%Y-%m-%dT%H:%M:%S%z"):
        try:
            return datetime.strptime(s.replace("Z", "+0000"), fmt).timestamp()
        except ValueError:
            continue
    return None


def bucket_of(sec):
    for lo, hi, name in GAP_BUCKETS:
        if lo <= sec < hi:
            return name
    return None


def is_real_user(msg):
    c = msg.get("content")
    return isinstance(c, list) and any(b.get("type") == "text" for b in c)


def iter_session_files(roots, since_ts):
    for root in roots:
        if not os.path.isdir(root):
            print(f"[WARN] 目录不存在，跳过：{root}")
            continue
        for dirpath, _dirs, files in os.walk(root):
            if any(p in dirpath for p in SKIP_PAT):
                continue
            for fn in files:
                if not fn.endswith(".jsonl"):
                    continue
                path = os.path.join(dirpath, fn)
                try:
                    if since_ts and os.path.getmtime(path) < since_ts:
                        continue
                except OSError:
                    continue
                yield path


def load_entries(path, counters):
    entries = []
    try:
        with open(path, encoding="utf-8") as fp:
            for line in fp:
                line = line.strip()
                if not line:
                    continue
                try:
                    entries.append(json.loads(line))
                except json.JSONDecodeError:
                    counters["malformed_lines"] += 1
    except OSError:
        counters["unreadable_files"] += 1
        return []
    return entries


def main():
    ap = argparse.ArgumentParser(description="cache-probe 归因分析")
    ap.add_argument("roots", nargs="+", help="sessions 目录（可多个）")
    ap.add_argument("--since", default=None, help="只分析 mtime 在该日期之后的 session（YYYY-MM-DD）")
    args = ap.parse_args()
    since_ts = datetime.strptime(args.since, "%Y-%m-%d").timestamp() if args.since else 0

    counters = defaultdict(int)
    turn_rows = []          # (model, gap_bucket, model_chg, think_chg, prefix_chg, parts, cr, miss)
    baseline_pairs = []     # (start_reason, changed_parts)
    files = list(iter_session_files(args.roots, since_ts))
    counters["sessions"] = len(files)

    for path in files:
        entries = load_entries(path, counters)
        if not entries:
            continue
        current_hashes = None
        prev_snapshot = None
        seen_user_turn = False
        # 切换标记作用域 = 自上一条真实用户发言以来的变化；user 发言时冻结到该 turn，
        # 防止「无 LLM 请求的 turn」把标记泄漏到下一 turn（保守低估样本方向的 bug）
        pending_model = pending_think = False
        turn_model_chg = turn_think_chg = False
        last_ts = None
        gap_bucket = "new"
        seen_first = False
        has_probe_turn = False
        for e in entries:
            ts = parse_ts(e.get("timestamp"))
            t = e.get("type")
            if t == "model_change" and seen_user_turn:
                pending_model = True
            elif t == "thinking_level_change" and seen_user_turn:
                pending_think = True
            elif t == "custom" and e.get("customType") == "cache-probe":
                data = e.get("data") or {}
                if data.get("error"):
                    counters["error_entries"] += 1
                elif isinstance(data.get("h"), dict):
                    if data.get("baseline") and current_hashes is not None:
                        changed = [k for k, v in data["h"].items() if current_hashes.get(k) != v]
                        baseline_pairs.append((data.get("startReason"), changed))
                    # v2 增量 merge：baseline 全量覆盖；normal 增量合并
                    current_hashes = {**(current_hashes or {}), **data["h"]}
            elif t == "message":
                m = e.get("message", {})
                role = m.get("role")
                if role == "user" and is_real_user(m):
                    seen_user_turn = True
                    turn_model_chg, turn_think_chg = pending_model, pending_think
                    pending_model = pending_think = False
                    if last_ts is not None and ts is not None:
                        gap_bucket = bucket_of(ts - last_ts) or "d.>12h"
                    else:
                        gap_bucket = "new"
                    seen_first = False
                elif role == "assistant" and not seen_first:
                    u = m.get("usage") or {}
                    cr = u.get("cacheRead", 0) or 0
                    miss = (u.get("input", 0) or 0) + (u.get("cacheWrite", 0) or 0)
                    if cr or miss:
                        prefix_chg = None
                        parts = []
                        if current_hashes is not None:
                            has_probe_turn = True
                            if prev_snapshot is not None:
                                parts = [k for k, v in current_hashes.items()
                                         if prev_snapshot.get(k) != v]
                                prefix_chg = len(parts) > 0
                        turn_rows.append((m.get("model", "?"), gap_bucket, turn_model_chg,
                                          turn_think_chg, prefix_chg, parts, cr, miss))
                        prev_snapshot = current_hashes
                        seen_first = True
            if ts is not None:
                last_ts = ts
        if has_probe_turn:
            counters["sessions_with_probe"] += 1

    # ---- 输出 ----
    print("=" * 72)
    print("1. 扫描概览")
    print("=" * 72)
    print(f"  sessions: {counters['sessions']}（含 cache-probe 数据 {counters['sessions_with_probe']}）")
    print(f"  turns: {len(turn_rows)}   error entries: {counters['error_entries']}")
    print(f"  畸形行: {counters['malformed_lines']}   不可读文件: {counters['unreadable_files']}")
    think_turns = [r for r in turn_rows if r[3]]
    if think_turns:
        cr = sum(r[6] for r in think_turns)
        tot = cr + sum(r[7] for r in think_turns)
        print(f"  think 切换 turn: {len(think_turns)}（命中率 {cr / tot * 100:.1f}%，历史实测 ≈ 基线，仅监控不参与归因过滤）")

    print()
    print("=" * 72)
    print("2. 命中率基线（全部 turn 首笔，按中断时长；对照设计文档 §3.1 口径）")
    print("=" * 72)
    by_gap = defaultdict(lambda: [0, 0])
    for _m, g, _mc, _tc, _pc, _p, cr, miss in turn_rows:
        by_gap[g][0] += cr
        by_gap[g][1] += miss
    print(f"  {'gap':12s} {'命中':>16s} {'未命中':>16s} {'命中率':>8s}")
    for g in sorted(by_gap):
        cr, miss = by_gap[g]
        tot = cr + miss
        if tot:
            print(f"  {g:12s} {cr:>16,d} {miss:>16,d} {cr / tot * 100:>7.1f}%")

    print()
    print("=" * 72)
    print("3. 归因矩阵：gap<30min + 模型未切换 的 turn 首笔（探针覆盖的 turn）")
    print("=" * 72)
    core = [r for r in turn_rows if r[1] in ("a.<5min", "b.5-30min") and not r[2] and r[4] is not None]
    groups = [
        (True, "前缀变化（可修）", [r for r in core if r[4]]),
        (False, "前缀未变仍 miss（服务端淘汰/链盲区并存）", [r for r in core if not r[4]]),
    ]
    miss_chg = miss_same = 0
    for is_chg, name, rows in groups:
        cr = sum(r[6] for r in rows)
        miss = sum(r[7] for r in rows)
        tot = cr + miss
        hit = cr / tot * 100 if tot else 0.0
        if is_chg:
            miss_chg = miss
        else:
            miss_same = miss
        print(f"  {name}")
        print(f"    turns={len(rows)}  命中={cr:,d}  未命中={miss:,d}  命中率={hit:.1f}%")
    part_hist = defaultdict(int)
    for r in core:
        if r[4]:
            for p in r[5]:
                part_hist[p] += 1
    if part_hist:
        print("  变化部位 Top：")
        for p, n in sorted(part_hist.items(), key=lambda kv: -kv[1])[:8]:
            print(f"    {p}: {n} 次")

    print()
    print("=" * 72)
    print("4. 进程边界漂移（baseline entry 与前一条指纹对比）")
    print("=" * 72)
    if baseline_pairs:
        drift = [p for _r, parts in baseline_pairs if parts for p in parts]
        n_no_drift = sum(1 for _r, parts in baseline_pairs if not parts)
        print(f"  边界事件 {len(baseline_pairs)} 次：漂移 {len(baseline_pairs) - n_no_drift} 次，未漂移 {n_no_drift} 次")
        hist = defaultdict(int)
        for p in drift:
            hist[p] += 1
        for p, n in sorted(hist.items(), key=lambda kv: -kv[1])[:8]:
            print(f"    漂移部位 {p}: {n} 次")
        reasons = defaultdict(int)
        for r, _parts in baseline_pairs:
            reasons[r or "unknown"] += 1
        print(f"  startReason 分布：{dict(reasons)}")
    else:
        print("  暂无 baseline 对比数据（需跨进程场景积累）")

    print()
    print("=" * 72)
    print("5. 决策建议（快照方案 GO/NO-GO 倾向）")
    print("=" * 72)
    n_core = len(core)
    if n_core < 200:
        print(f"  样本不足（归因矩阵 turn 数 {n_core} < 200），继续收集。终止标准见 README.md。")
    elif miss_chg + miss_same == 0:
        print("  归因矩阵内无 miss token，无需快照方案。")
    else:
        share = miss_chg / (miss_chg + miss_same)
        if share >= 0.5:
            top = max(part_hist, key=part_hist.get) if part_hist else "?"
            print(f"  前缀变化贡献 miss 的 {share * 100:.0f}% → GO 倾向：优先固化「{top}」相关前缀。")
        elif share <= 0.3:
            print(f"  前缀变化仅贡献 miss 的 {share * 100:.0f}% → NO-GO 倾向：主因在服务端淘汰/链盲区，快照收益有限。")
        else:
            print(f"  前缀变化贡献 miss 的 {share * 100:.0f}% → 混合成因，结合部位分布与价差人工决策。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
