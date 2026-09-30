#!/usr/bin/env python3
"""metrics-gate.py — pr-cr-fix 阶段 1.5 确定性度量门禁（Gate-1.5）。

包装 `fallow audit`（机器计算），按显式双轨规则判定（脚本判定而非 fallow verdict）：
- FAIL：introduced 函数圈复杂度 > maxCyclomatic；新增循环依赖；新增 unresolved import
- WARN：introduced 认知复杂度 > maxCognitive 或 CRAP >= maxCrap；其余 introduced dead-code；新增重复块

为什么不直接用 fallow 的 verdict：fallow 的 complexity findings 超阈值即 fail、无 warn 档；
且无 --coverage 数据时覆盖率是估算值（无测试路径的文件 cov≈0，CC>=5 即触发 CRAP>=30），
把认知复杂度/CRAP 放进 fail 档会误杀。故门禁与报告用同一份 audit JSON、两套阈值在脚本内显式判定。

真实覆盖率消费（2026-08-21 接入）：同 base 的 `.review/coverage.json`（Gate-1.6 coverage-gate
产出）存在时，complexity warn 条目按**文件级 lcov 真实覆盖率**分流——≥80% 移入 covered 列表
（出 warn，保留展示与证据链），<80% 或无 lcov 记录留 warn 并附 coverage_real 注记；数据缺失/
base 不匹配时整体降级回 fallow 静态估算（行为同旧版）。运行顺序：coverage-gate 先跑、
metrics-gate 后跑（SKILL.md 阶段 1.5/1.6 执行序）。

用法：python3 metrics-gate.py [--base main]
退出码：0 = pass/warn（放行）；1 = fail（打回）；2 = 工具/运行错误（中止，含 argv 参数错误）
产出：.review/metrics.json（阶段 2 review agent 的靶子清单来源）
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

DEFAULTS = {"maxCyclomatic": 15, "maxCognitive": 15, "maxCrap": 30.0}

# 除 complexity/circular/unresolved 外，introduced 后计入 WARN 的 dead-code 类别
WARN_DEAD_CODE_KINDS = [
    "unused_files",
    "unused_exports",
    "unused_types",
    "unused_dependencies",
    "unused_dev_dependencies",
    "unused_class_members",
    "unlisted_dependencies",
    "duplicate_exports",
    "private_type_leaks",
    "type_only_dependencies",
    "test_only_dependencies",
    "re_export_cycles",
    "boundary_violations",
]

# 2026-09-30 裁决：修复型门禁禁止 top-N 截断——清单必须全量报告，否则总工作量不可见、
# 完成判定不可能、修复退化为清一组浮一组的循环。下方 warn/fail/targets/stdout 全部全量。

# 文件级真实覆盖率 ≥ 此值时，complexity warn 条目视为「复杂但有充分测试证据」→ 移入
# covered 列表（出 warn 保留展示）。文件级是函数级的有损近似（函数体行区间需 AST 才
# 能精确），warn 分流用途下可接受；精确函数级需 fallow --coverage 接 lcov，后续再议。
REAL_COVERAGE_COVERED_PCT = 80.0


def load_real_coverage(repo_root: Path, base: str) -> dict[str, dict] | None:
    """读 Gate-1.6 产出的 .review/coverage.json files 节。

    返回 None（整体降级 fallow 静态估算）的条件：文件缺失 / JSON 损坏 / base 不匹配 /
    files 节为空。调用方必须先跑 coverage-gate（同 base）才有真实数据。
    """
    p = repo_root / ".review" / "coverage.json"
    if not p.is_file():
        return None
    try:
        data = json.loads(p.read_text())
    except json.JSONDecodeError:
        return None
    if data.get("base") != base:
        return None
    files = data.get("files")
    return files if isinstance(files, dict) and files else None


def locate_dead_code_item(kind: str, item: dict) -> dict:
    """从 fallow dead_code 条目提取可定位的 path/line。

    各 kind 顶层字段不一致（R2 monorepo-impact S-3：unlisted_dependencies 无 path 只有
    imported_from[]，duplicate_exports 只有 locations[]）——逐 kind 映射，保证 warn 条目
    可定位到文件。
    """
    if kind == "unlisted_dependencies":
        first = (item.get("imported_from") or [{}])[0]
        return {"path": first.get("path"), "line": first.get("line"),
                "note": f"package={item.get('package_name')}"}
    if kind == "duplicate_exports":
        locs = item.get("locations") or []
        return {"path": locs[0].get("path") if locs else None,
                "line": locs[0].get("line") if locs else None,
                "files": [l.get("path") for l in locs],
                "note": f"export={item.get('export_name')}"}
    return {"path": item.get("path"), "line": item.get("line"),
            "note": item.get("parent_name") or ""}


def load_thresholds(repo_root: Path) -> dict:
    config = repo_root / ".fallowrc.json"
    if not config.is_file():
        # SKILL.md 称 .fallowrc.json 是阈值 SSOT：缺失必须出声（否则「用内置默认
        # 阈值跑完门禁」看起来像按配置跑，实际口径可能不符 SSOT）
        print(f"WARN: 仓库根 .fallowrc.json 缺失，用内置默认阈值 {DEFAULTS}——"
              f"该文件是阈值 SSOT，缺失时请确认用默认阈值是有意为之", file=sys.stderr)
        return dict(DEFAULTS)
    try:
        health = json.loads(config.read_text()).get("health", {})
    except json.JSONDecodeError:
        print(f"WARN: .fallowrc.json 解析失败，用默认阈值 {DEFAULTS}", file=sys.stderr)
        return dict(DEFAULTS)
    return {k: health.get(k, v) for k, v in DEFAULTS.items()}


def run_audit(repo_root: Path, base: str) -> dict:
    cmd = ["fallow", "audit", "--changed-since", base, "--format", "json", "--quiet"]
    proc = subprocess.run(cmd, cwd=repo_root, capture_output=True, text=True)
    if proc.returncode == 2:
        print(f"ERROR: fallow audit 运行失败：\n{proc.stderr.strip()}", file=sys.stderr)
        sys.exit(2)
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        print(f"ERROR: fallow 输出非 JSON（exit={proc.returncode}）：{proc.stderr.strip()[:500]}", file=sys.stderr)
        sys.exit(2)


def judge(report: dict, thresholds: dict, real_cov: dict[str, dict] | None) -> dict:
    max_cc = thresholds["maxCyclomatic"]
    max_cog = thresholds["maxCognitive"]
    max_crap = thresholds["maxCrap"]
    fail: list[dict] = []
    warn: list[dict] = []
    covered: list[dict] = []  # 真实覆盖率 ≥80% 的 complexity 条目（出 warn，保留证据链）
    targets: list[dict] = []

    for f in report.get("complexity", {}).get("findings", []):
        if not f.get("introduced"):
            continue
        entry = {
            "type": "complexity",
            "path": f["path"],
            "line": f["line"],
            "name": f["name"],
            "cyclomatic": f["cyclomatic"],
            "cognitive": f["cognitive"],
            "crap": f.get("crap"),
            "coverage_tier": f.get("coverage_tier"),
        }
        # coverage 为估算值时 crap 仅供排序参考，不进 fail 判定
        if f["cyclomatic"] > max_cc:
            fail.append({**entry, "reason": f"cyclomatic {f['cyclomatic']} > {max_cc}"})
        elif f["cognitive"] > max_cog or (f.get("crap") or 0) >= max_crap:
            item = {**entry, "reason": f"cognitive {f['cognitive']} / crap {f.get('crap')}"}
            rc = real_cov.get(item["path"]) if real_cov else None
            if rc is not None:
                item["coverage_real"] = {"pct": rc["pct"], "basis": "file-level lcov (Gate-1.6)"}
                if rc["pct"] >= REAL_COVERAGE_COVERED_PCT:
                    covered.append(item)
                else:
                    warn.append(item)
            else:
                item["coverage_basis"] = ("fallow-static (no lcov record: file not loaded by "
                                          "any test or package not coverage-gated)") if real_cov else "fallow-static"
                warn.append(item)
        if f.get("crap") is not None:
            rc = real_cov.get(entry["path"]) if real_cov else None
            if rc is not None:
                entry["coverage_real"] = {"pct": rc["pct"], "basis": "file-level lcov (Gate-1.6)"}
            targets.append(entry)

    dead = report.get("dead_code", {})
    for c in dead.get("circular_dependencies") or []:
        if c.get("introduced"):
            fail.append({"type": "circular-dependency", "files": c.get("files", []), "reason": "新增循环依赖"})
    for u in dead.get("unresolved_imports") or []:
        if u.get("introduced"):
            fail.append({
                "type": "unresolved-import",
                "path": u.get("path"),
                "line": u.get("line"),
                "reason": f"无法解析的 import: {u.get('specifier')}",
            })
    for kind in WARN_DEAD_CODE_KINDS:
        for item in dead.get(kind) or []:
            if isinstance(item, dict) and item.get("introduced"):
                warn.append({"type": kind, **locate_dead_code_item(kind, item),
                             "reason": item.get("export_name") or item.get("member_name")
                                       or item.get("package_name") or item.get("type_name") or kind})

    dup_groups = [g for g in report.get("duplication", {}).get("clone_groups", []) if g.get("introduced")]
    for g in sorted(dup_groups, key=lambda g: -(g.get("line_count") or 0)):
        # fallow clone_groups instance 的字段是 file/start_line（无 path/line 键），
        # 取错键会全量得 None（R3 monorepo-impact S-2 的 5 条 path=null 根因）
        files = [i.get("file") for i in g.get("instances", []) if isinstance(i, dict)]
        # path = 首个实例文件（便于 grep 定位；完整面在 files 数组，同 locate_dead_code_item 的 files 模式）
        warn.append({"type": "duplication", "path": files[0] if files else None, "files": files,
                     "reason": f"重复块 {g.get('line_count')} 行 × {len(files)} 处"})

    targets.sort(key=lambda e: -(e.get("crap") or 0))
    verdict = "fail" if fail else ("warn" if warn else "pass")
    return {
        "verdict": verdict,
        "fail": fail,
        "warn": warn,
        "covered": covered,
        "targets": {"high_crap": targets},
        "stats": {
            "fail": len(fail),
            "warn": len(warn),
            "covered_by_real_coverage": len(covered),
            "coverage_basis": "lcov-file-level" if real_cov is not None else "fallow-static",
            "duplication_introduced_groups": len(dup_groups),
            "thresholds": thresholds,
        },
    }


# argv 契约：--flag value 空格分隔取值。等号写法（--base=develop）与本脚本无关，
# 按未识别参数 fail-fast——静默忽略会让「参数拼错/写错形式」伪装成正常门禁结果
# （eg: --base=develop 回落默认 main，跑出来一切正常但基线是错的）。
VALUE_FLAGS = ("--base",)
BOOL_FLAGS = ()


def parse_argv(args: list[str]) -> None:
    """argv 预检：未识别参数 fail-fast、--flag 缺值友好报错（均 exit 2）。

    主解析按 `args.index(flag) + 1` 精确取值，无法感知拼错 / 等号写法 / 缺值：
    这些错误要么静默回落默认值，要么在 flag 位于末尾时抛裸 IndexError。本预检
    只诊断不改写取值——成功路径的解析逻辑完全不变。
    """
    usage = "用法：python3 metrics-gate.py [--base main]（等号写法 --flag=value 不支持，请用空格分隔取值）"
    i = 0
    while i < len(args):
        arg = args[i]
        if arg.startswith("--"):
            if arg in VALUE_FLAGS:
                if i + 1 >= len(args) or args[i + 1].startswith("--"):
                    print(f"ERROR: {arg} 缺少参数值。{usage}", file=sys.stderr)
                    sys.exit(2)
                i += 2
                continue
            if arg in BOOL_FLAGS:
                i += 1
                continue
            print(f"ERROR: 未识别的参数 {arg}。已知参数：{', '.join(VALUE_FLAGS + BOOL_FLAGS)}。"
                  f"{usage}", file=sys.stderr)
            sys.exit(2)
        i += 1


def main() -> None:
    parse_argv(sys.argv[1:])
    base = "main"
    if "--base" in sys.argv:
        base = sys.argv[sys.argv.index("--base") + 1]
    if shutil.which("fallow") is None:
        print("ERROR: 未找到 fallow。安装：npm i -g fallow（实测版本 2.88.2）", file=sys.stderr)
        sys.exit(2)

    repo_root = Path(subprocess.check_output(
        ["git", "rev-parse", "--show-toplevel"], text=True).strip())
    thresholds = load_thresholds(repo_root)
    real_cov = load_real_coverage(repo_root, base)
    report = run_audit(repo_root, base)
    result = judge(report, thresholds, real_cov)
    result["base"] = base

    out_dir = repo_root / ".review"
    out_dir.mkdir(exist_ok=True)
    (out_dir / "metrics.json").write_text(json.dumps(result, indent=2, ensure_ascii=False))

    s = result["stats"]
    print(f"Gate-1.5 verdict={result['verdict']}  fail={s['fail']} warn={s['warn']} "
          f"covered={s['covered_by_real_coverage']}({s['coverage_basis']}) "
          f"dup_groups={s['duplication_introduced_groups']}  (base={base}, thresholds={s['thresholds']})")
    for item in result["fail"]:
        loc = item.get("path") or ",".join(item.get("files", []))
        print(f"  FAIL [{item['type']}] {loc}:{item.get('line', '')} {item.get('name', '')} — {item.get('reason')}")
    for item in result["warn"]:
        loc = item.get("path") or ",".join(item.get("files", []))
        print(f"  WARN [{item['type']}] {loc}:{item.get('line', '')} — {item.get('reason')}")
    print(f"报告: {out_dir / 'metrics.json'}")
    sys.exit(1 if result["verdict"] == "fail" else 0)


if __name__ == "__main__":
    main()
