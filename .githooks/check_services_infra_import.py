#!/usr/bin/env python3
"""
services 层 infra 直接 import 检查（C-comm-03）——落实 runtime 三层设计「services 层 IO 一律经 port」。

规则（规格 SSOT：docs/architecture/runtime-layering.md 第二部分「跨切面例外」）：
  扫描 packages/runtime/src/services/ 的 .ts 源码（排除 *.test.ts 与 __tests__/），
  value import（排除 import type）中 from 路径含 /infra/ 且目标模块不在白名单 → 违规。
  import type 豁免（与 check_no_service_cycle.py 同理：接口依赖不造成运行时耦合）。

白名单（受控例外）：
  文档登记四类：logger / pi-paths / git-status-parser / ignore-parser
  现状基线（2026-08-22 首次接入时登记）：session-file-utils / session-entry-mapper /
    pi-provider-store / session-attach-assert / message-converter / file-change-reconciler
  ——基线模块待专项收编（经 port 或明确豁免理由后更新本清单），新增 infra value import 直接拦。
  session-binding-fields（2026-08-26 登记）：绑定字段注册表 SSOT（sidecar-binding-sync 设计），
    纯声明数据 + 纯函数，自 session-file-utils 抽出（同族受控例外，随 R3 一并收编）。

退出码: 0 通过 / 2 违规
"""

import re
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SERVICES_ROOT = PROJECT_ROOT / "packages/runtime/src/services"

# 受控例外：文档登记四类 + 现状基线（见 docstring）
ALLOWED_MODULES = {
    # 文档登记（runtime-layering「跨切面例外」）
    "logger",
    "pi-paths",
    "git-status-parser",
    "ignore-parser",
    # crash-journal：崩溃台账 writer（crash-forensics-and-watchdog 设计 D1），logger 类横切
    # 关注点——无业务语义、process-wide 单例、best-effort 决策点双写（写失败不抛进业务链），
    # 2026-09-11 随 E 组取证链落地列入（同 logger「为它定义 port 只会增加无意义的间接层」裁决）
    "crash-journal",
    # mem-pressure：os 级内存压力即时查询（crash-forensics-and-watchdog 设计 D3 高水位延迟 /
    # D4 采样形态裁决，u5 交付、u7c 消费），logger 类横切关注点——无业务语义、无状态（每次
    # 调用重新读 os，零采样环/缓存）、只读（node:os + /proc + sysctl，无副作用、查询永不
    # reject），2026-09-11 随 E 组恢复链落地列入（同 crash-journal 裁决：port 只增加无意义
    # 间接层）
    "mem-pressure",
    # 现状基线（2026-08-22，待专项治理收编或正式豁免）
    "session-file-utils",
    "session-entry-mapper",
    "pi-provider-store",
    "session-attach-assert",
    "message-converter",
    "file-change-reconciler",
    # sidecar-binding-sync 注册表 SSOT（2026-08-26）：纯声明+纯函数，同 session-file-utils 族随 R3 收编
    "session-binding-fields",
    # 外部会话扫描域（import-session 2026-09-02）：scanExternalSessions + 缓存 + 批常量，
    # 纯函数（fs/promises 全注入路径参数，无模块级服务状态副作用），自 session-file-utils 抽出
    # （Gate A lint max-lines 拆分），同族受控例外随 R3 收编
    "session-file-external-scan",
    # spawn-env 出站契约构建器（2026-08-27）：纯函数（env 全 DI 不触 process.env），
    # terminal-service / plugin-host-process 消费 buildOutboundChildEnv 组装子进程 env
    # （env-propagation-boundary 设计 C-proc-09），同族随 R3 收编
    "spawn-env",
    # git-repo-resolver（2026-09-17）：无状态只读 walk-up 路径解析（fs 只读遍历，无副作用、
    # 查询不 reject），同 mem-pressure 裁决形态——IGitRepoResolver port 已存在且注入可用，
    # value import 仅为注入缺省实例服务（repo-observer sharedRepoObserver 单例 +
    # git-state-service fallback 两处构造点），为此定义 factory port 只增加无意义间接层
    "git-repo-resolver",
    # argv-redact（2026-09-19，模式体系 argv 脱敏）：kernel 类纯函数（无状态、无 IO、无副作用，
    # 纯字符串/数组遮蔽），services 侧消费方仅 reap-orphan-pi 的 crash journal 摘要出口——
    # 「日志回显前蔽值」属 logger 类横切关注点，与 crash-journal / mem-pressure 同裁决形态：
    # 为它定义 port 只会增加无意义间接层（遮蔽是写日志的前置纯变换，非可替换的 IO 能力）。
    # 登记同步见 docs/architecture/runtime-layering.md §3 ③e
    "argv-redact",
}

# value import 行（import { X } from '...infra/...'；import type 豁免）
IMPORT_RE = re.compile(r"""^\s*import\s+\{[^}]*\}\s+from\s+['"]([^'"]*infra/[^'"]+)['"]""", re.MULTILINE)


def main() -> int:
    violations = []
    for f in sorted(SERVICES_ROOT.rglob("*.ts")):
        if f.name.endswith(".test.ts") or "__tests__" in f.parts:
            continue
        rel = f.relative_to(PROJECT_ROOT).as_posix()
        for m in IMPORT_RE.finditer(f.read_text(encoding="utf-8", errors="replace")):
            module = Path(m.group(1)).stem
            if module not in ALLOWED_MODULES:
                violations.append(f"{rel}: value import infra/{module}（services 层 IO 须经 port 接口）")

    if violations:
        print("[check_services_infra_import] services 层存在白名单外的 infra value import（三层设计「跨切面例外」）：")
        for v in violations:
            print(f"  - {v}")
        print("修复方向：在 services/ports 定义接口，infra 层实现后经构造注入；纯函数例外归 kernel 类并登记白名单。")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
