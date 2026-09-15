#!/bin/bash
# scripts/generate-manifest.sh — 生成 sha256 + size 清单（manifest.json）
#
# 遍历 builder-output 目录的产物，计算 sha256 + size，组装 manifest json。
# 供 app 内自动升级做完整性校验，以及 release 页面透明展示文件指纹。
#
# 三平台覆盖问题（2026-07-26 修复）：
#   原先三平台都输出同名 manifest.json，release.yml 的 download-artifact merge-multiple
#   会把三份同名文件互相覆盖，最终只剩「最后下载的那个平台」的 manifest，丢失另两个平台。
#   修复：传 --platform <mac|win|linux> 时按平台命名（manifest-mac.json 等），
#   release.yml 下载后用 jq 合并三份为一个 manifest.json（覆盖全平台 assets）。
#
# 用法:
#   ./scripts/generate-manifest.sh [builder-output-dir] [--platform <mac|win|linux>]
#   builder-output-dir 默认 apps/electron/dist/builder-output
#   --platform 留空 → 输出 manifest.json（兼容本地/旧行为）
#   --platform mac  → 输出 manifest-mac.json（CI 三平台并行构建用）

set -euo pipefail

# 检查失败原则：任何非 0 退出都输出（不管从哪个 exit 点）
trap '[ $? -ne 0 ] && echo "[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。" >&2' EXIT

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# 接受 builder-output 目录参数，默认 apps/electron/dist/builder-output
BUILDER_DIR="${1:-apps/electron/dist/builder-output}"
shift || true

# 解析 --platform 选项（CI 三平台并行构建时传，决定输出文件名后缀）
PLATFORM=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform)
      PLATFORM="${2:-}"
      shift 2
      ;;
    --platform=*)
      PLATFORM="${1#--platform=}"
      shift
      ;;
    *)
      echo "[generate-manifest] WARNING: 忽略未知参数: $1" >&2
      shift
      ;;
  esac
done

if [ ! -d "$BUILDER_DIR" ]; then
  echo "[generate-manifest] ERROR: builder-output 目录不存在: $BUILDER_DIR" >&2
  exit 1
fi

# 输出文件名：传 --platform 时按平台命名（避免三平台同名覆盖），否则用 manifest.json
if [[ -n "$PLATFORM" ]]; then
  MANIFEST_FILE="manifest-${PLATFORM}.json"
else
  MANIFEST_FILE="manifest.json"
fi

# version 从 apps/electron/package.json 读
VERSION=$(node -p "require('./apps/electron/package.json').version")
RELEASED_AT=$(date -u +%FT%TZ)

# 用 node 生成 JSON（shell 拼 JSON 易错）
node -e '
const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const dir = process.argv[1];
const version = process.argv[2];
const releasedAt = process.argv[3];
const manifestFile = process.argv[4];
const assets = {};
for (const file of fs.readdirSync(dir)) {
  const fullPath = path.join(dir, file);
  const stat = fs.statSync(fullPath);
  if (!stat.isFile()) continue;
  // 排除任何已存在的 manifest 文件（manifest.json / manifest-*.json），避免把自己算进去
  if (/^manifest(-.*)?\.json$/.test(file)) continue;
  // 只对实际产物算（.dmg/.exe/.AppImage；mac zip 与 deb target 已删——设计 §3.3.3-C / §3.3.2b，
  // 正则同步收紧防误导：留着匹配不到文件，但会让人误以为仍有 zip/deb 产物形态）
  if (!/\.(dmg|exe|AppImage)$/.test(file)) continue;
  const buf = fs.readFileSync(fullPath);
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
  assets[file] = { sha256, size: stat.size };
}
const manifest = { version, releasedAt, assets };
fs.writeFileSync(path.join(dir, manifestFile), JSON.stringify(manifest, null, 2) + "\n");
console.log("[generate-manifest] Generated " + manifestFile + " with " + Object.keys(assets).length + " assets");
' "$BUILDER_DIR" "$VERSION" "$RELEASED_AT" "$MANIFEST_FILE"
