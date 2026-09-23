#!/usr/bin/env python3
"""coverage-gate.py — pr-cr-fix 阶段 1.6 增量覆盖率门禁（Gate-1.6）。

[HISTORICAL 2026-08-21] 曾稳定假 pass，根因已查实并修复（验收：真实 diff 全量 17 包
非空报告 + 高阈值探针双向）：
1. 主因：OK 路径构建 entry 但从未执行 `report[pkg] = entry`（仅 SKIP/FAIL 路径记录）。
   全部包 OK 时 report 恒空 → 旧代码 `all(空)==True` 判 pass → coverage.json 出现
   verdict=pass 且 packages={}（产物证据）。这解释了 KNOWN-ISSUE 全部症状：包迭代、
   vitest 实跑、report 恒 0、无 traceback、python -I 复现；exec 内联曾正确检出 FAIL
   是因为 FAIL 路径有记录。修复：OK 路径补记录 + `len(report)==len(pkgs)` 记账闭合
   守卫（不闭合即 exit 2）+ all-SKIP 改判工具错误 exit 2（旧代码 all(空)==True 的
   同族坑）。
2. lcov SF 是包相对路径（SF:src/App.vue），旧版按 basename 兜底匹配，同名文件
   （多个 index.ts）会拿错 hits_map。修复：去包前缀后全字符串精确匹配。
3. node-linker=hoisted（ADR-0032）下 renderer 的 devDep 提升使 13 个未声明包幻影
   可用（provider 探针恒 True）。修复：按 package.json 声明判定，全部 vitest 包
   已补声明 @vitest/coverage-v8。
4. 纵深防御（非主因）：并发 git 进程活动下 `git diff` 偶发空输出——git_diff_names()
   以 rev-list 为锚做瞬态判定 + 3 次重试 + 空输出且有 commit ahead 时 exit 2。
5. extensions/shared/<lib> 三层目录曾被 parts[:2] 切到不存在的 extensions/shared/
   package.json 而静默漏门禁。修复：pkg_dir_of() 按前缀分层切片。
6. [2026-09-22 盲区] extensions/universal|taiji/<pkg>（同为三层）仍被旧特判折叠成
   无 package.json 的组目录、resources/plugins/<name> 落在 PKG_PREFIXES 外——6 包
   40 个 src 文件 + scheduler-manager 668 行合入时 gate 零可见。修复：pkg_dir_of()
   改为向上探测最近含 package.json 的祖先（深度不再硬编码）、resources/plugins/
   前缀纳入 PKG_PREFIXES（builtin 插件包根平铺布局走 flat 档 include）、前缀内
   缺装配的目录记 unmeasured 显式登记（stderr + coverage.json），静默路径清零。

对 base...HEAD 改动过 src/ 的 workspace 包跑 `vitest run --coverage`（lcov），
解析 lcov 的 DA 行命中数据 + git diff 新增行号，计算**可执行新增行的覆盖率**。
增量覆盖率 < min-incremental（默认 80%，业界新代码覆盖事实标准——Sonar Way 默认
门禁；2026-08-21 从 50% 起步值 ratchet 上调）→ fail（exit 1）。

口径说明：
- 分母 = 新增行中出现在 lcov DA 记录里的行（可执行行；注释/空行/类型声明不计）
- 分子 = 其中被至少一个测试命中（DA hits > 0）的行
- 与 renderer 全量 thresholds gate（vitest.config 内，防线不同）互补：全量阈值防整体
  退化，增量阈值防「新代码不写测试」。TEST-STRATEGY.md §7「以增量覆盖率为准」的
  工具化落地。

各包启用条件：package.json devDependencies 声明 @vitest/coverage-v8（按声明而非
node 解析，原因见上 [HISTORICAL] #3）。未声明的包记 SKIP 并给出启用指引。

用法：python3 coverage-gate.py [--base main] [--min-incremental 80] [--packages a,b]
      [--extra-packages a,b] [--debug]
      --packages：交集过滤器，只收窄 changed_packages() 结果（无 src/ 改动的包不在
      集合内，任何参数值都加不进去）。
      --extra-packages：追加器，无条件并入包集合（不要求该包有 src/ 改动；典型用途：
      diff 含 packages/shared/src 时传 --extra-packages packages/runtime,packages/renderer
      承接下游兜底，见 pr-cr-fix 精简设计 D12）。追加包无新增行时走 total=0 → 100% 记
      OK 的现有路径；路径无效或缺 vitest.config.ts 记 FAIL 条目，不静默跳过。
退出码：0 = pass；1 = fail（增量不足或测试失败）；2 = 工具错误（git 异常 / 记账不闭合 /
      all-SKIP 配置错误）
产出：.review/coverage.json（packages 增量口径 + files 全文件级真实覆盖率，
      后者供 metrics-gate.py 替换 fallow 静态估算消费）
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import time
from pathlib import Path

MIN_INCREMENTAL_DEFAULT = 80.0
# 只对这些前缀下的包做 gate（apps/electron 无独立 vitest 包；resources/plugins =
# builtin 插件包，2026-09-22 显式裁决纳入——scheduler-manager 装配 vitest 后盲区合入
# 的 MF-1-7 形态不允许再发生；前缀内缺装配的包由 unmeasured 登记显式出声，不静默）
PKG_PREFIXES = ("packages/", "extensions/", "resources/plugins/")
# builtin 插件包根平铺布局的源文件扩展（无 src/ 段，判据与 workspace 包不同）；
# 匹配用 .search（后缀锚定）——re.match 锚串首，对完整 repo 路径恒不命中
PLUGIN_SOURCE_SUFFIX = re.compile(r"\.(ts|tsx|mts|vue)$")

DEBUG = False


def debug(msg: str) -> None:
    if DEBUG:
        print(f"[debug] {msg}", file=sys.stderr)


def sh(cmd: list[str], cwd: Path | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)


def git_diff_names(repo_root: Path, base: str) -> list[str]:
    """git diff --name-only，带瞬态空输出防护。

    并发 git 进程活动下 diff 偶发空输出（2026-08-21 假 pass 根因 #1）。以
    rev-list 为锚区分：无 commit ahead 时空 diff 合法；有 commit ahead 时空 diff
    只能是瞬态——重试 3 次，仍空按工具错误中止（exit 2），绝不判 pass。
    """
    for attempt in range(1, 4):
        proc = sh(["git", "diff", f"{base}...HEAD", "--name-only", "-M"], repo_root)
        if proc.returncode != 0:
            print(f"ERROR: git diff 失败：{proc.stderr.strip()}", file=sys.stderr)
            sys.exit(2)
        lines = [l.strip() for l in proc.stdout.splitlines() if l.strip()]
        if lines:
            return lines
        rc = sh(["git", "rev-list", "--count", f"{base}..HEAD"], repo_root)
        ahead = int(rc.stdout.strip()) if rc.returncode == 0 and rc.stdout.strip().isdigit() else -1
        if ahead == 0:
            return []
        print(f"WARN: git diff 输出为空但 {base}..HEAD 有 {ahead} 个 commit（疑似瞬态），"
              f"重试 {attempt}/3", file=sys.stderr)
        time.sleep(1)
    print(f"ERROR: git diff 连续 3 次空输出而 {base}..HEAD 有 commit——git 异常，中止。"
          f"恢复：确认无并发 git 进程后重跑本脚本", file=sys.stderr)
    sys.exit(2)


def pkg_dir_of(repo_root: Path, repo_file: str) -> str | None:
    """repo 相对文件 → 所属包目录（向上探测最近含 package.json 的祖先）。

    [HISTORICAL 2026-09-22 盲区] 旧实现按前缀特判切片（extensions/shared/ 三层、
    其余两层）：extensions/universal|taiji/<pkg> 被折叠成无 package.json 的组目录、
    resources/plugins/<name> 落在 PKG_PREFIXES 外——两者都被 changed_packages 的
    is_file 过滤静默吞掉（6 包 40 个 src 文件 + scheduler-manager 668 行合入时
    gate 零可见，MF-1-8）。修复：分层深度不再硬编码，从文件父目录逐级向上（最多
    3 层：packages/<pkg> 两层、extensions/<group>/<pkg> 与 resources/plugins/<name>
    三层），最近含 package.json 的目录即包根；候选必须落在 PKG_PREFIXES 之下，
    探测跳出前缀即 None（组目录无 package.json 的中间态由 changed_packages 记
    unmeasured，不静默）。
    """
    parts = repo_file.split("/")
    for depth in range(min(len(parts) - 1, 3), 1, -1):
        candidate = "/".join(parts[:depth])
        if not candidate.startswith(PKG_PREFIXES):
            break  # 前缀是路径段前缀，一旦跳出更浅的候选不可能再命中
        if (repo_root / candidate / "package.json").is_file():
            return candidate
    return None


def changed_packages(repo_root: Path, base: str) -> tuple[dict[str, list[str]], dict[str, str]]:
    """返回 ({包目录: 改动的源文件列表}, {包目录: 不测量原因})。

    源文件判据：/src/ 路径段（workspace 包布局），或 resources/plugins/ 前缀下的
    源扩展（builtin 插件包根平铺布局——index.ts 在包根，无 src/ 段；测试文件
    __tests__/**.test.* 不算源）。前缀内但缺 package.json / vitest.config.ts 的
    目录记入 unmeasured（gate 输出显式登记「改动不测量」，不静默跳过）。
    """
    pkgs: dict[str, list[str]] = {}
    unmeasured: dict[str, str] = {}
    for f in git_diff_names(repo_root, base):
        in_plugin_prefix = f.startswith("resources/plugins/")
        if "/src/" not in f and not (
            in_plugin_prefix and PLUGIN_SOURCE_SUFFIX.search(f) and "__tests__" not in f
        ):
            continue
        pkg = pkg_dir_of(repo_root, f)
        if pkg is None:
            continue
        if not (repo_root / pkg / "package.json").is_file():
            unmeasured.setdefault(pkg, "缺 package.json（非包目录布局）")
            continue
        if not (repo_root / pkg / "vitest.config.ts").is_file():
            unmeasured.setdefault(
                pkg, "缺 vitest.config.ts（无测试装配，改动不测量；装配后自动纳入）")
            continue
        pkgs.setdefault(pkg, []).append(f)
    return pkgs, unmeasured


def coverage_declared(pkg_dir: Path) -> bool:
    """包 package.json 是否声明 @vitest/coverage-v8。

    按声明而非 node 解析判定：node-linker=hoisted 下根提升使 node 解析恒真，
    未声明包靠 renderer 的 devDep 幻影可用，renderer 删依赖即静默全 SKIP
    （2026-08-21 假 pass 根因 #3）。
    """
    try:
        pkg = json.loads((pkg_dir / "package.json").read_text())
    except (OSError, json.JSONDecodeError):
        return False
    deps = {**pkg.get("devDependencies", {}), **pkg.get("dependencies", {})}
    return "@vitest/coverage-v8" in deps


def run_coverage(pkg_dir: Path, flat_layout: bool = False) -> tuple[bool, str]:
    """包内跑 vitest --coverage 产 lcov。返回 (ok, 说明)。

    TAIJI_SKIP_REAL_PI=1 与 CI 同口径（TEST-STRATEGY §4 双轨设计）：真实 pi 子进程用例
    不在覆盖率测量目标内（慢且环境敏感，插桩开销下必超时），走 mock 双轨即可。
    reportsDirectory 显式钉死：防包级 vitest.config 覆盖默认输出位置。
    flat_layout（resources/plugins 插件包，包根平铺：index.ts 在包根、测试在
    __tests__/）：include= 整包 + exclude __tests__；workspace 包维持 src/ 档。
    """
    lcov = pkg_dir / "coverage" / "lcov.info"
    cov_include = "." if flat_layout else "src"
    cov_exclude = "__tests__/**" if flat_layout else "src/**/__tests__/**"
    cmd = [
        "npx", "vitest", "run", "--coverage",
        "--coverage.reporter=lcov", "--coverage.reporter=json-summary",
        "--coverage.reportsDirectory=coverage",
        f"--coverage.include={cov_include}",
        f"--coverage.exclude={cov_exclude}",
    ]
    import os
    # 降载开关（opt-in，默认口径不变）：TAIJI_COVERAGE_GATE_SERIAL=1 时测试文件串行跑。
    # 背景：11 包连跑的包内默认并发下，faux 真进程时序断言（idle-pi-reclaim）与 vitest
    # worker teardown 竞态会随机 1 例级失败（单包复跑均绿、断言本身无问题）——串行只排除
    # CPU 竞争对时序敏感用例的干扰，不改变任何断言与覆盖范围。
    if os.environ.get("TAIJI_COVERAGE_GATE_SERIAL") == "1":
        cmd.append("--no-file-parallelism")
    env = {**os.environ, "TAIJI_SKIP_REAL_PI": "1"}
    debug(f"run_coverage: {' '.join(cmd)}  (cwd={pkg_dir})")
    proc = subprocess.run(cmd, cwd=pkg_dir, capture_output=True, text=True, env=env)
    if proc.returncode != 0:
        return False, f"测试失败（exit={proc.returncode}）：\n{(proc.stdout + proc.stderr)[-800:]}"
    if not lcov.is_file():
        return False, f"未产出 {lcov.relative_to(pkg_dir.parent)}"
    return True, ""


def parse_lcov(lcov_path: Path) -> dict[str, dict[int, int]]:
    """lcov → {SF 路径（包相对）: {行号: hits}}。SF 段内 DA:line,hits 累加。"""
    coverage: dict[str, dict[int, int]] = {}
    current: str | None = None
    for raw in lcov_path.read_text(errors="replace").splitlines():
        if raw.startswith("SF:"):
            current = raw[3:].strip()
            coverage.setdefault(current, {})
        elif raw.startswith("DA:") and current:
            line_no, hits = raw[3:].split(",")[0:2]
            d = coverage[current]
            n = int(line_no)
            d[n] = d.get(n, 0) + int(hits)
        elif raw == "end_of_record":
            current = None
    return coverage


def added_lines(repo_root: Path, base: str, files: list[str]) -> dict[str, set[int]]:
    """git diff -U0 提取每个文件的新增行号（新增 + 修改行，即 + 侧 hunk 全部行）。"""
    result: dict[str, set[int]] = {}
    for f in files:
        d = sh(["git", "diff", f"{base}...HEAD", "-U0", "-M", "--", f], repo_root)
        lines: set[int] = set()
        for m in re.finditer(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@", d.stdout, re.M):
            start = int(m.group(1))
            count = int(m.group(2)) if m.group(2) is not None else 1
            lines.update(range(start, start + count))
        if lines:
            result[f] = lines
    return result


def incremental_pct(coverage: dict[str, dict[int, int]], pkg: str,
                    added: dict[str, set[int]]) -> tuple[float, int, int, list[str], list[str]]:
    """(增量覆盖率%, 覆盖行数, 可执行新增行数, 未覆盖文件清单, 无 lcov 记录文件清单)。

    lcov SF 是包相对路径（SF:src/App.vue），added 是 repo 相对（packages/<pkg>/src/App.vue）：
    去包前缀后全字符串精确匹配。禁止 basename 兜底——同名文件（多个 index.ts）会拿错
    hits_map（2026-08-21 假 pass 根因 #2）。无 lcov 记录的新文件不入分母（无可执行行或
    未被任何测试加载），但列出供 debug。
    """
    covered = total = 0
    uncovered_files: list[str] = []
    no_lcov: list[str] = []
    for rel_file, lines in added.items():
        sf_key = rel_file[len(pkg) + 1:] if rel_file.startswith(pkg + "/") else rel_file
        hits_map = coverage.get(sf_key)
        if hits_map is None:
            no_lcov.append(rel_file)
            continue
        executable = [n for n in lines if n in hits_map]
        if not executable:
            continue
        hit = sum(1 for n in executable if hits_map[n] > 0)
        if hit < len(executable):
            # 条目语义 = 未覆盖行数/总可执行行（I-13 修正：旧格式 (hit/total) 是已覆盖数，
            # 与字段名 uncovered 直觉相反，下游按「未覆盖 X 行」消费会系统性夸大缺口）。
            uncovered_files.append(f"{rel_file} ({len(executable) - hit} uncovered / {len(executable)})")
        covered += hit
        total += len(executable)
        debug(f"match {rel_file}: executable={len(executable)} hit={hit}")
    pct = (covered / total * 100) if total else 100.0
    return pct, covered, total, uncovered_files, no_lcov


def main() -> None:
    global DEBUG
    args = sys.argv[1:]
    base = args[args.index("--base") + 1] if "--base" in args else "main"
    min_pct = float(args[args.index("--min-incremental") + 1]) if "--min-incremental" in args else MIN_INCREMENTAL_DEFAULT
    # --packages 与 --extra-packages 语义不同、可共存：前者是交集过滤器（只收窄
    # changed_packages() 结果，无 src/ 改动的包加不进去）；后者是追加器（无条件并入
    # 包集合，见文件头 docstring）
    only = args[args.index("--packages") + 1].split(",") if "--packages" in args else None
    extra_arg = args[args.index("--extra-packages") + 1] if "--extra-packages" in args else None
    DEBUG = "--debug" in args

    repo_root = Path(subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip())
    pkgs, unmeasured = changed_packages(repo_root, base)
    if only:
        pkgs = {k: v for k, v in pkgs.items() if k in only}
    # 前缀内但缺装配的目录：显式登记「改动不测量」——静默跳过正是 2026-09-22 盲区
    # 根因（extensions/<group>/<pkg> 折叠丢失 + resources 落前缀外，MF-1-8）
    if unmeasured:
        print("WARN: 前缀内目录改动不测量（缺装配，登记如下，不静默）：", file=sys.stderr)
        for pkg_dir_name, reason in sorted(unmeasured.items()):
            print(f"  UNMEASURED {pkg_dir_name}: {reason}", file=sys.stderr)
    # --extra-packages 追加（在 --packages 过滤之后，追加不受交集过滤器影响）。追加包
    # 不要求 src/ 改动（setdefault：已在 changed 集合的包保留原 files 列表）。路径无效/
    # 缺 vitest.config.ts 的同样并入集合（记账闭合守卫要求每个迭代包产出 report 条目），
    # 由主循环开头记 FAIL——不静默跳过
    extra_invalid: dict[str, str] = {}
    if extra_arg:
        for p in dict.fromkeys(x.strip() for x in extra_arg.split(",") if x.strip()):
            pkgs.setdefault(p, [])
            if not (repo_root / p / "package.json").is_file():
                extra_invalid[p] = (f"--extra-packages 追加包无效：{p} 缺 package.json"
                                    "（目录不存在或非 workspace 包）；恢复：修正路径后重跑")
            elif not (repo_root / p / "vitest.config.ts").is_file():
                extra_invalid[p] = (f"--extra-packages 追加包 {p} 缺 vitest.config.ts，"
                                    "无法跑 coverage；恢复：补齐 config 或从 --extra-packages 移除该包")
    if not pkgs:
        # git_diff_names 已在源头拦截瞬态空 diff；到达此处 = diff 非空但没有
        # src/ 改动的 vitest 包（纯 docs/scripts 改动），合法 pass
        print(f"Gate-1.6 pass：base={base} 无带 src/ 改动的 vitest 包")
        (repo_root / ".review").mkdir(exist_ok=True)
        (repo_root / ".review" / "coverage.json").write_text(json.dumps(
            {"verdict": "pass", "base": base, "packages": {}, "unmeasured": unmeasured,
             "note": "no changed vitest packages"}, indent=2))
        sys.exit(0)

    report: dict[str, dict] = {}
    verdict = "pass"
    # 全文件级真实覆盖率（repo 相对路径 → executable/hit/pct），供 Gate-1.5 metrics-gate
    # 替换 fallow 静态估算消费；仅 OK 包贡献（SKIP/FAIL 包无 lcov）
    file_cov: dict[str, dict] = {}
    for pkg, files in sorted(pkgs.items()):
        pkg_dir = repo_root / pkg
        entry: dict = {"changed_src_files": len(files)}
        # --extra-packages 追加包合法性失败（路径无效/缺 config）：记 FAIL 条目，
        # 参照下方 SKIP/FAIL 记账风格，不静默跳过
        if pkg in extra_invalid:
            entry.update({"status": "FAIL", "reason": extra_invalid[pkg]})
            report[pkg] = entry
            verdict = "fail"
            print(f"  FAIL {pkg}: {extra_invalid[pkg]}")
            continue
        if not coverage_declared(pkg_dir):
            entry["status"] = "SKIP"
            entry["note"] = "未声明 @vitest/coverage-v8；启用：cd %s && pnpm add -D @vitest/coverage-v8" % pkg
            report[pkg] = entry
            print(f"  SKIP {pkg}: {entry['note']}")
            continue
        ok, err = run_coverage(pkg_dir, flat_layout=pkg.startswith("resources/plugins/"))
        if not ok:
            entry.update({"status": "FAIL", "reason": err})
            report[pkg] = entry
            verdict = "fail"
            print(f"  FAIL {pkg}: {err.splitlines()[0] if err else ''}")
            continue
        cov = parse_lcov(pkg_dir / "coverage" / "lcov.info")
        debug(f"{pkg}: lcov SF={len(cov)} files, changed={len(files)}")
        for sf, hits in cov.items():
            executable = len(hits)
            hit = sum(1 for h in hits.values() if h > 0)
            file_cov[f"{pkg}/{sf}"] = {
                "executable": executable, "hit": hit,
                "pct": round(hit / executable * 100, 1) if executable else 100.0,
            }
        added = added_lines(repo_root, base, files)
        pct, covered, total, unc, no_lcov = incremental_pct(cov, pkg, added)
        summary_file = pkg_dir / "coverage" / "coverage-summary.json"
        overall = ""
        if summary_file.is_file():
            try:
                g = json.loads(summary_file.read_text()).get("total", {})
                overall = f"（全量 lines {g.get('lines', {}).get('pct', '?')}%）"
            except json.JSONDecodeError:
                pass
        entry.update({
            "status": "OK", "incremental_pct": round(pct, 1),
            "covered_executable_added_lines": covered,
            "executable_added_lines": total,
            "overall": overall, "uncovered_files": unc[:10],
            "files_without_lcov": no_lcov[:10],
        })
        if pct < min_pct:
            entry["status"] = "FAIL"
            entry["reason"] = f"增量覆盖率 {pct:.1f}% < {min_pct}%"
            verdict = "fail"
        report[pkg] = entry
        print(f"  {entry['status']:<4} {pkg}: 增量 {pct:.1f}% ({covered}/{total} 可执行新增行) {overall}")

    # 记账闭合：每个进入迭代的包必须产出 report 条目，堵住任何静默路径
    if len(report) != len(pkgs):
        print(f"ERROR: 迭代 {len(pkgs)} 包但 report 只有 {len(report)} 条——记账不闭合，中止",
              file=sys.stderr)
        sys.exit(2)
    # all-SKIP = 工具配置错误（无任何包可评估），不判 pass——2026-08-21 假 pass 根因 #3
    if report and all(v.get("status") == "SKIP" for v in report.values()):
        print("ERROR: 全部包 SKIP（无一声明 @vitest/coverage-v8）——门禁空转视为配置错误，"
              "不判 pass。恢复：见上方各包 SKIP 行的启用指引", file=sys.stderr)
        (repo_root / ".review").mkdir(exist_ok=True)
        (repo_root / ".review" / "coverage.json").write_text(json.dumps(
            {"verdict": "error", "base": base, "packages": report,
             "reason": "all packages SKIPped - coverage provider undeclared everywhere"}, indent=2))
        sys.exit(2)

    out = {"verdict": verdict, "base": base, "min_incremental": min_pct,
           "packages": report, "files": file_cov, "unmeasured": unmeasured}
    (repo_root / ".review").mkdir(exist_ok=True)
    (repo_root / ".review" / "coverage.json").write_text(json.dumps(out, indent=2, ensure_ascii=False))
    print(f"Gate-1.6 verdict={verdict}  min_incremental={min_pct}%  (base={base}, pkgs={len(report)})")
    for pkg, e in report.items():
        if e.get("status") == "OK":
            print(f"  OK   {pkg}: 增量 {e['incremental_pct']}% "
                  f"({e['covered_executable_added_lines']}/{e['executable_added_lines']} 可执行新增行) {e.get('overall','')}")
        else:
            print(f"  {e['status']:<4} {pkg}: {e.get('reason') or e.get('note')}")
    print(f"报告: {repo_root / '.review' / 'coverage.json'}")
    sys.exit(1 if verdict == "fail" else 0)


if __name__ == "__main__":
    main()
