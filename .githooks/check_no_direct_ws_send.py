#!/usr/bin/env python3
"""
禁止 renderer 直调 ws-client.send 或 window.electronAPI —— 落实 D3/R4 统一门面
（phase-5 guardrails 5.3 + B1 IPC 门面）。

背景：Phase 1 把 ws send 直调收敛到 api client；B1 把 window.electronAPI.* IPC 直调
收敛到 api（window/dialog/runtime-port/system domain）。本脚本把这两条不变量固化为
pre-commit 检查，防止 store/composable/组件回退到直调底层通道。

扫描范围（SCAN_ROOTS）：renderer/src 全量 + ui/src/extension-host——两处的出站
桥接件共用同一 ws-client 直调不变量，扫描不得留下包级盲区。

白名单（合法直调点，键 = packages/ 下相对路径）：
  ws-client send（extension-host 出站桥接件直连 core ws-client）：
    - renderer/src/composables/shell/useExtensionHostBridge.ts  bridge 直连
      （mountPoints.sync / executeCommand 出站）
    - ui/src/extension-host/shell-adapters.ts       壳适配件直连（plugin.uiResponse
      出站，由 renderer 壳装配）
  electronAPI：
    - renderer/src/lib/ipc.ts       IPC 封装层（electronAPI 的唯一真实消费者）

检测目标：
  1. `import { ... send ... } from '.../ws-client'`（含 `send as 别名`）
  2. `window.electronAPI.` 调用（store/composable/组件应改用 api.window/dialog/...）

退出码：0 通过 / 2 违规
"""

import re
import sys
from collections.abc import Iterator
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
PACKAGES_ROOT = PROJECT_ROOT / "packages"
SCAN_ROOTS = [
    PACKAGES_ROOT / "renderer" / "src",
    PACKAGES_ROOT / "ui" / "src" / "extension-host",
]

WS_WHITELIST = {
    "renderer/src/composables/shell/useExtensionHostBridge.ts",
    "ui/src/extension-host/shell-adapters.ts",
}

IPC_WHITELIST = {
    "renderer/src/lib/ipc.ts",
}

# 命名导入块 + from '.../ws-client'（type-only import 同样拦，防止 import type 规避）
WS_CLIENT_IMPORT = re.compile(
    r"import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['\"][^'\"]*ws-client['\"]"
)

# window.electronAPI.<method> 调用（含可选链 window.electronAPI?.method）
ELECTRON_API_CALL = re.compile(r"window\.electronAPI\s*\?\s*\.\s*\w+|window\.electronAPI\.\w+")


def _scan_targets() -> Iterator[tuple[Path, str]]:
    for root in SCAN_ROOTS:
        for f in sorted(root.rglob("*")):
            if f.suffix not in (".ts", ".vue"):
                continue
            yield f, f.relative_to(PACKAGES_ROOT).as_posix()


def scan_ws() -> list[str]:
    errors: list[str] = []
    for f, rel in _scan_targets():
        # [HISTORICAL] __tests__/ 排除：单元测试测 ws-client.send 本身是其职责，
        # 与业务代码（store/composable/组件）直调底层通道是两回事。规则目标是
        # 防止业务侧绕过 api 门面，不是禁止测试。
        # [tc-transport-consolidation u4] 排除条件从 startswith("__tests__/") 修正为
        # 目录段匹配：嵌套 __tests__/（如 composables/shell/__tests__/）同样排除——
        # u4 改锚后 extension-host-dialog.test 经 vi.mock 拦截 core ws-client.send，
        # 顶级前缀匹配漏掉嵌套测试目录造成误报（与既有 [HISTORICAL] 意图一致）。
        if rel.startswith("__tests__/") or "/__tests__/" in rel:
            continue
        text = f.read_text(encoding="utf-8")
        for ln_no, line in enumerate(text.splitlines(), 1):
            stripped = line.strip()
            if stripped.startswith("//"):
                continue
            m = WS_CLIENT_IMPORT.search(line)
            if not m:
                continue
            named = m.group(1)
            if re.search(r"(^|,\s*|\s+)send(\s+as\s+|\s*,|\s*$)", named):
                if rel in WS_WHITELIST:
                    continue
                errors.append(f"  {rel}:{ln_no}: {stripped}")
    return errors


def scan_ipc() -> list[str]:
    errors: list[str] = []
    for f, rel in _scan_targets():
        # [HISTORICAL] __tests__/ 排除（与 scan_ws 同理，见上方注释；含嵌套目录段匹配）
        if rel.startswith("__tests__/") or "/__tests__/" in rel:
            continue
        text = f.read_text(encoding="utf-8")
        for ln_no, line in enumerate(text.splitlines(), 1):
            stripped = line.strip()
            if stripped.startswith("//"):
                continue
            if ELECTRON_API_CALL.search(line) and rel not in IPC_WHITELIST:
                errors.append(f"  {rel}:{ln_no}: {stripped}")
    return errors


def main() -> int:
    ws_errors = scan_ws()
    ipc_errors = scan_ipc()
    if ws_errors:
        print("[ERROR] renderer 禁止直调 ws-client.send，统一走 api client（D3 统一门面）")
        print("        合法封装层（白名单）：" + ", ".join(sorted(WS_WHITELIST)))
        print("\n".join(ws_errors))
    if ipc_errors:
        print("[ERROR] renderer 禁止直调 window.electronAPI，统一走 api client（B1 IPC 门面）")
        print("        合法封装层（白名单）：" + ", ".join(sorted(IPC_WHITELIST)))
        print("        改用 api.window.* / api.dialog.* / api.runtimePort.* / api.system.*")
        print("\n".join(ipc_errors))
    if ws_errors or ipc_errors:
        print()
        print("\033[0;31m[原则] 无论是否本次改动引入的问题，都必须当场直接修复解决，不允许跳过。\033[0m")
        return 2
    print("[OK] ws-client send + electronAPI 直调检查通过（仅白名单文件合法）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
