#!/usr/bin/env python3
"""
模型可见性投喂单点调用点白名单检查（约束 C-ext-31，provider-catalog-sync 设计 §3.4 第 2 层）。

规则：全仓 `extensions/` 下 `registerProvider` / `registerNativeProvider` /
`registerVirtualModel` 的**调用点**只允许出现在两个白名单包内；白名单外出现即红。

  - extensions/universal/provider-live-sync/ —— 投喂通道本体（写入单点）。
    目录投喂模块 src/catalog-bridge.ts 在扩展工厂期经 pi.registerProvider 把
    taiji 目录缓存里 pi 还没有的模型注入 pi 进程注册表；同包既有 refresh 链
    （models.json/auth.json 监视 + modelRegistry.refresh）同属该通道。
    语义 = 「taiji 侧数据 → pi 注册表常驻条目」的可见性投喂。

  - extensions/universal/scheduler/ —— ack 合成轮与 backend 转发，**语义不同**。
    src/ack-turn.ts 在确认轮窗口内临时注册合成 provider 覆写 streamSimple、
    one-shot 注销（src/backend.ts 的 registerProvider 只是转发 pi 的适配层）。
    语义 = 执行通道覆写（临时、有注销），不是可见性投喂，故不在禁列。
    两包语义区分写在此处防后来者误把 scheduler 当「第二投喂方」清掉。

为什么禁「白名单外新开注入点」：注入修的是 pi 进程注册表这一事实源，注册表
的全部消费方（--model 解析 / rpc set_model / rename / smart-context /
permission 分类器 / scheduler / subagent 模型校验 / provider 对账）零改动即
自动受益。新开注入点 = 绕过单点、制造第二写入方，两侧数据各自演化后
「展示可见 ≠ 执行可用」在该子集反向复现。

测试目录排除（`__tests__/`、`tests/`）：仓内既有测试 mock 桩是白名单外的
**合法引用**，不属注入调用点——scheduler `src/__tests__/`（ack-contract.test.ts
的 backend 桩、active-path.test.ts 的 `registerProvider = vi.fn()`、
mock-backend.ts 的桩实现）与 structured-output `tests/mock-pi-fixture.ts`
的 `registerProvider: vi.fn()` / `registerVirtualModel: vi.fn()` 都是对 pi API
的桩化，不是真实注入。不排除会对既有测试资产误报红。**禁止删除本排除规则**——
新增测试 mock 桩同样落在排除范围内。

扫描口径：
  - 文件类型 = .ts / .mts / .cts / .js / .mjs（排除 .d.ts 声明文件）；
  - 先剥离注释（行注释 // 与块注释 /* */），注释与文档提及不计命中；
  - 命中形态 = 标识符后紧跟 `(` 的**调用**；接口方法签名与方法实现
    （`registerProvider(...): void` / `registerProvider(...) {`，闭合括号后
    紧跟 `:` 或 `{`）判为声明、不计命中；
  - 全仓扫描（不走 staged 过滤）——白名单是包粒度全集，与提交范围无关，
    确定性语义便于 CI 与本地同口径复跑。

零第三方依赖（纯标准库）。实测 ~0.05s（655 个源文件全仓扫描）。

退出码: 0 通过 / 1 发现白名单外调用点
"""

import re
import sys
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SCAN_ROOT = PROJECT_ROOT / "extensions"

# 白名单（包/路径粒度，前缀按仓库根相对 posix 路径判定）
WHITELIST_PREFIXES = (
    "extensions/universal/provider-live-sync/",
    "extensions/universal/scheduler/",
)

# 测试目录排除（路径片段判定，任意层级命中即排除）
TEST_DIR_NAMES = ("__tests__", "tests")

SCAN_SUFFIXES = (".ts", ".mts", ".cts", ".js", ".mjs")

# 调用点词表：注入 pi 注册表的三个官方扩展点
REGISTER_RE = re.compile(r"\b(registerProvider|registerNativeProvider|registerVirtualModel)\s*\(")


def strip_comments(text: str) -> str:
    """剥离块注释与行注释——**原位替换为空格**（保留长度与换行），使剥离后文本的
    偏移与行号和原文逐字对应，违规明细报的行号可直接定位到源文件。

    保守近似：字符串字面量内的 // 不处理（URL 等会被截断为空格，同
    .githooks/check_pi_type_leak.py 口径）——调用点命中已足够精确。
    """

    def blank(m: re.Match) -> str:
        return "".join("\n" if c == "\n" else " " for c in m.group(0))

    text = re.sub(r"/\*.*?\*/", blank, text, flags=re.DOTALL)
    text = re.sub(r"/\*.*$", blank, text, flags=re.DOTALL)
    out_lines = []
    for line in text.split("\n"):
        idx = line.find("//")
        if idx != -1:
            line = line[:idx] + " " * (len(line) - idx)
        out_lines.append(line)
    return "\n".join(out_lines)


def is_declaration(text: str, open_paren: int) -> bool:
    """判定 `NAME(` 是声明还是调用：从开括号按深度找到配对闭括号，看其后首个
    非空白字符——`:`（接口方法签名的返回类型标注）或 `{`（方法实现体）即声明。

    实参内的对象字面量（`registerProvider(model.provider, { ... })`）在括号
    深度内，不影响闭括号定位。
    """
    depth = 0
    i = open_paren
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                break
        i += 1
    if i >= n:
        # 括号未闭合（截断/异常形态）——保守判为调用，宁可误报不漏报
        return False
    j = i + 1
    while j < n and text[j] in " \t\r\n":
        j += 1
    return j < n and text[j] in ":"


def line_of(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


def main() -> int:
    if not SCAN_ROOT.is_dir():
        print(f"[check_register_allowlist] 扫描根不存在: {SCAN_ROOT}")
        return 1

    started = time.perf_counter()
    violations: list[str] = []
    scanned = 0
    whitelisted_hits = 0

    for f in sorted(SCAN_ROOT.rglob("*")):
        if not f.is_file() or f.suffix not in SCAN_SUFFIXES:
            continue
        if f.name.endswith(".d.ts"):
            continue
        rel = f.relative_to(PROJECT_ROOT).as_posix()
        if any(part in TEST_DIR_NAMES for part in f.parts):
            continue
        scanned += 1
        stripped = strip_comments(f.read_text(encoding="utf-8", errors="replace"))
        in_whitelist = rel.startswith(WHITELIST_PREFIXES)
        for m in REGISTER_RE.finditer(stripped):
            if is_declaration(stripped, m.end() - 1):
                continue
            if in_whitelist:
                whitelisted_hits += 1
                continue
            violations.append(
                f"{rel}:{line_of(stripped, m.start())}: `{m.group(1)}` 调用点"
                f"（模型可见性投喂单点 = provider-live-sync 包，C-ext-31）"
            )

    elapsed = time.perf_counter() - started
    print(
        f"[check_register_allowlist] 扫描 {scanned} 个源文件（extensions/，已排除测试目录），"
        f"白名单内命中 {whitelisted_hits} 处，耗时 {elapsed:.2f}s"
    )

    if violations:
        print(
            "[check_register_allowlist] 发现白名单外的注册表注入调用点"
            "（docs/constraints.json C-ext-31：投喂单点 = provider-live-sync）："
        )
        for v in violations:
            print(f"  ✗ {v}")
        print(
            "[FIX] 扩展需要模型一律查 pi 注册表；查不到 = 投喂缺口，"
            "报给 provider-live-sync 补数据来源（改其投喂模块输入），"
            "禁止自行注入或静默降级扩大化。"
        )
        print(
            "[FIX] 确属合法新注入点（语义非可见性投喂，如执行通道临时覆写）："
            "在 .githooks/check_register_allowlist.py 的 WHITELIST_PREFIXES "
            "登记包路径并在头注释写明语义区分，同步 docs/constraints.json C-ext-31。"
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
