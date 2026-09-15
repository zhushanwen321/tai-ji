#!/bin/bash
# fix-node-pty-permissions.sh
#
# 修复 node-pty 1.1.0 上游打包 bug（两个独立 bug，都在此脚本处理）：
#
# Bug 1 — spawn-helper 丢 +x 权限位
#   prebuild tarball 内 spawn-helper 是 644（应为 755）。
#   现象：runtime 调 pty.spawn 时报 "posix_spawnp failed"（node-pty fork 需 exec helper）。
#   本地复现：tar -tvf <node-pty tarball> | grep spawn-helper  → -rw-r--r--
#
# Bug 2 — helperPath 二次 asar 替换 [HISTORICAL]
#   node-pty lib/unixTerminal.js 计算 helperPath 时无条件做
#     helperPath.replace('app.asar', 'app.asar.unpacked')
#   设计假设：node-pty JS 在 app.asar 内、helper 在 app.asar.unpacked 内。
#   但本项目 electron-builder.yml 的 asarUnpack 把整个 node-pty 都 unpack
#   （含 JS），打包后 __dirname 已含 app.asar.unpacked，replace 二次污染
#   → app.asar.unpacked.unpacked/.../spawn-helper（不存在）
#   → posix_spawn ENOENT → 抛笼统 "posix_spawnp failed."（node-pty 吞了 errno）。
#   上游 issue/PR：https://github.com/microsoft/node-pty/issues/923
#                  https://github.com/microsoft/node-pty/pull/924 （至今未合并）
#   修复 = 等价 PR #924：replace 前加 guard，已含 .unpacked 则跳过。
#
# 触发：pnpm install 后自动执行（根 package.json postinstall）。
# 幂等：找不到文件 / 已是 755 / 已是 patched 形态，都不报错。

set -euo pipefail

# 定位所有 node-pty 副本（pnpm isolated 模式下根 node_modules 和 .pnpm/ 各有一份）。
# electron-builder 可能从任意副本拷贝，必须全部 patch，否则产物含未 patch 版本。
# 历史事故：isolated 模式下只 patch 了根 node_modules/node-pty，electron-builder 从
# .pnpm/ 副本拷贝，产物缺 helperPath guard → posix_spawnp failed。
NODE_PTY_DIRS=()

for candidate in \
  node_modules/node-pty \
  node_modules/.pnpm/node-pty@*/node_modules/node-pty; do
  if [ -d "$candidate/prebuilds" ]; then
    NODE_PTY_DIRS+=("$candidate")
  fi
done

if [ ${#NODE_PTY_DIRS[@]} -eq 0 ]; then
  # node-pty 未安装（如纯 renderer 开发），静默退出
  exit 0
fi

# ── Bug 2: patch helperPath 二次 asar 替换 guard（等价上游 PR #924）─────────
# 目标文件：lib/unixTerminal.js。node-pty 升级若改了文件结构，匹配失败只 warn 不 fail。
#
# Bug 2 是 Unix-only：node-pty 在 win 走 windowsTerminal.js（不做 asar 替换），
# unixTerminal.js 在 win 不被加载，此 patch 无需在 win 应用。
# 跳过可彻底避免 win 上 perl 可用性不确定的问题（chmod 段在 win 上是 no-op，无需 guard）。
OS_TYPE="$(uname -s 2>/dev/null || echo unknown)"
case "$OS_TYPE" in
  MINGW*|MSYS*|CYGWIN*)
    # Windows：不需要 helperPath patch（unixTerminal.js 不被 win 加载），但仍需 chmod
    SKIP_HELPERPATH_PATCH=1
    ;;
  *)
    SKIP_HELPERPATH_PATCH=0
    ;;
esac

# 对每个 node-pty 副本执行 chmod + helperPath patch
TOTAL_FIXED=0
TOTAL_PATCHED=0
for NODE_PTY_DIR in "${NODE_PTY_DIRS[@]}"; do
  # 给所有平台的 spawn-helper 加 +x（unix 平台需要；win 的不在此 glob）
  FIXED=0
  while IFS= read -r -d '' helper; do
    if [ ! -x "$helper" ]; then
      chmod +x "$helper"
      FIXED=$((FIXED + 1))
    fi
  done < <(find "$NODE_PTY_DIR/prebuilds" -name spawn-helper -print0 2>/dev/null || true)
  TOTAL_FIXED=$((TOTAL_FIXED + FIXED))

  if [ "$SKIP_HELPERPATH_PATCH" = "1" ]; then
    continue
  fi

  UNIX_TERMINAL="$NODE_PTY_DIR/lib/unixTerminal.js"

  if [ ! -f "$UNIX_TERMINAL" ]; then
    continue
  fi

  # 幂等检测：两个 guard 标记都存在才算已 patch（防部分应用的半成品）。
  GUARD_COUNT=$(grep -c "helperPath.indexOf('" "$UNIX_TERMINAL" 2>/dev/null || true)
  if [ "$GUARD_COUNT" -ge 2 ]; then
    continue # 已 patch（两个 guard 都在），跳过
  fi

  # 原始两行（精确匹配，无前导空格——顶层语句）：
  #   helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');
  #   helperPath = helperPath.replace('node_modules.asar', 'node_modules.asar.unpacked');
  # 用 perl 替换（sed 在 macOS BSD 下多行替换转义繁琐，perl 跨平台一致）。
  perl -0777 -i -pe '
    s{helperPath = helperPath\.replace\('"'"'app\.asar'"'"', '"'"'app\.asar\.unpacked'"'"'\);}
     {if (helperPath.indexOf('"'"'app.asar.unpacked'"'"') === -1) { helperPath = helperPath.replace('"'"'app.asar'"'"', '"'"'app\.asar\.unpacked'"'"'); }}sg;
    s{helperPath = helperPath\.replace\('"'"'node_modules\.asar'"'"', '"'"'node_modules\.asar\.unpacked'"'"'\);}
     {if (helperPath.indexOf('"'"'node_modules.asar.unpacked'"'"') === -1) { helperPath = helperPath.replace('"'"'node_modules\.asar'"'"', '"'"'node_modules\.asar\.unpacked'"'"'); }}sg;
  ' "$UNIX_TERMINAL"

  # 验证 patch 生效
  GUARD_COUNT_AFTER=$(grep -c "helperPath.indexOf('" "$UNIX_TERMINAL" 2>/dev/null || true)
  if [ "$GUARD_COUNT_AFTER" -ge 2 ]; then
    TOTAL_PATCHED=$((TOTAL_PATCHED + 1))
  else
    echo "[fix-node-pty] WARN: helperPath patch did not apply for $NODE_PTY_DIR — unixTerminal.js format may have changed"
  fi
done

if [ "$TOTAL_FIXED" -gt 0 ]; then
  echo "[fix-node-pty] chmod +x $TOTAL_FIXED spawn-helper binary(ies) across ${#NODE_PTY_DIRS[@]} copies (upstream 1.1.0 tarball permission bug)"
fi
if [ "$TOTAL_PATCHED" -gt 0 ]; then
  echo "[fix-node-pty] patched helperPath double-replace guard in $TOTAL_PATCHED/${#NODE_PTY_DIRS[@]} copies (upstream #923/#924)"
fi
