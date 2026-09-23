#!/usr/bin/env python3
"""
infra 层反向 import services 层检查（C-comm-01 三层单向依赖的机器执行补向）。

规则（规格 SSOT：docs/architecture/runtime-layering.md 依赖矩阵 transport→services←infra）：
  扫描 packages/runtime/src/infra/ 的 .ts 源码（排除 *.test.ts 与 __tests__/），
  value import / value re-export 中 from 路径含 /services/ 且目标模块不在白名单 → 违规。
  import type / export type 豁免（接口依赖不造成运行时耦合，与 check_services_infra_import.py
  同理）。

历史缺口（2026-09-20 补）：check_no_service_cycle.py 只扫 services 内部环、
check_services_infra_import.py 只拦 services→infra，infra→services 方向此前无任何
机器拦截（infra/event-adapter 曾经 services/plan-state-extractor import 常量——该次
修复把常量移入 @taiji/shared 后落地本守卫堵向）。

白名单（受控例外，存量基线 2026-09-20 登记，新增 services value import 直接拦）：
  git-executor / shell-runner：infra 实现对应 port 契约所需引用的 Error 类
    （services/ports/<同名>.js 内 Error 类与接口同文件，实现方引用契约相邻物）
  engine-roots：staged 引擎根 env 推导（W9，宿主侧路径推导域，process-manager 消费）
  llm-retry-config-helper：kernel 纯函数（merge/resolve/validate，无 IO 无状态）
  scanner-base：inferSourceType 纯函数（路径→来源类型分类，无 IO）
  provider-catalog：纯派生函数（deriveEnabled / isCatalogProvider / getMergedCatalogModels）
  inflight-mirror：[u7b D5 例外] 在途镜像单例（marker 旁路写、滚动重启判定读，
    event-adapter 消费点已有同款注释登记）

退出码: 0 通过 / 2 违规
"""

import re
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
INFRA_ROOT = PROJECT_ROOT / "packages/runtime/src/infra"

# 受控例外（见 docstring 白名单节）
ALLOWED_MODULES = {
    "git-executor",
    "shell-runner",
    "engine-roots",
    "llm-retry-config-helper",
    "scanner-base",
    "provider-catalog",
    "inflight-mirror",
}

# type-only 语句（import type / export type ... from '...'，含多行形态）先剔除再扫 value
TYPE_ONLY_RE = re.compile(
    r"""^\s*(?:import|export)\s+type\b[^;]*?from\s+['"][^'"]+['"];?\s*$""",
    re.MULTILINE,
)
# value import / re-export：import {..} / import X / import * as X / export {..} from '...services/...'
VALUE_FROM_RE = re.compile(
    r"""(?:import|export)\s+(?:\{[^}]*\}|[\w$]+|\*\s+as\s+[\w$]+)\s+from\s+['"]([^'"]*services/[^'"]+)['"]"""
)


def main() -> int:
    violations = []
    for f in sorted(INFRA_ROOT.rglob("*.ts")):
        if f.name.endswith(".test.ts") or "__tests__" in f.parts:
            continue
        rel = f.relative_to(PROJECT_ROOT).as_posix()
        text = f.read_text(encoding="utf-8", errors="replace")
        stripped = TYPE_ONLY_RE.sub("", text)
        for m in VALUE_FROM_RE.finditer(stripped):
            module = Path(m.group(1)).stem
            if module not in ALLOWED_MODULES:
                violations.append(f"{rel}: value import services/{module}（infra 不得反向依赖 services 层）")

    if violations:
        print("[check_infra_services_import] infra 层存在白名单外的 services value import（三层单向 transport→services←infra）：")
        for v in violations:
            print(f"  - {v}")
        print("修复方向：共享常量/类型移入 @taiji/shared；port 相邻物经 services/ports 接口注入；kernel 纯函数例外须登记白名单。")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
