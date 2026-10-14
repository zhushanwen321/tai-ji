# dev 提速 symlink 形态与本地签名构建互斥

状态：已修复关闭（2026-10-14：构建入口互斥检测落地，`pnpm build` 与 preflight 双挂载；复发时按「现象」判定、「恢复」处置）。

## 现象

worktree 的 `apps/electron/resources/pi/` 在**worktree 创建时**（`setup-worktree.sh`，git-cwt 触发）把 6 个顶层条目（assets / export-html / package.json / photon_rs_bg.wasm / pi-darwin-arm64 / theme）逐文件 symlink 到 workspace 级缓存 `.pi-binary-cache/`（免重复下载；`pnpm dev` 复用该 stage 形态，dev 装配器只做版本劈叉校验不重建）。electron-builder 打包时按链接原样拷进 bundle，`codesign --validate` 以「bundle 必须自包含」拒绝：报 `invalid destination for symbolic link in bundle`（指向 bundle 外部路径的链接即使目标存在也判无效）。CI 不受影响（`prepare-pi-resources.sh` 走真实下载 + `cp -RL` dereference 复制，无 symlink）。

## 根因（为什么既有检查没拦住）

preflight 检查 7 当时已存在，但含**错误豁免**：`git check-ignore` 命中的 symlink 直接跳过——其假设「gitignored 的 dev 缓存 symlink 不进 git，非打包风险」是错的，electron-builder 的拷贝源是**磁盘**而非 git，gitignored symlink 恰是本地打包的头号风险源。且 preflight 只在 pre-commit（配置文件变更时）与 CI build.yml 显式 step 运行，本地 `pnpm build` 全程不经过它——构建入口零检测。

## 判定

构建报 `invalid destination for symbolic link in bundle` 时扫描产物内符号链接：

```bash
find <builder-output>/TaiJi.app -type l
```

目标解析后不在 `.app` 目录内的即肇事链接。

## 修复（现行机制）

逻辑单一源 = `scripts/check-pi-resources-links.mjs`（Node 跨平台），双挂载：

- **构建入口**：`apps/electron/package.json` 的 `build` 脚本最前 `node ../../scripts/check-pi-resources-links.mjs &&`——本地 `pnpm build` 直接触发，发现外部 symlink 即拦截并给恢复指引（CI 上无 symlink，零影响）。
- **preflight 检查 7**：改为调用同一脚本（错误豁免已删，附 [HISTORICAL] 注释）。

脚本语义：`resources/pi` 缺失 → 放行（CI fresh checkout / 未 stage 常态）；symlink 目标解析后落在 `resources/pi` 内部 → 放行；否则（含断链）→ 拦截。`--fix` 将外部 symlink 替换为真实复制（递归实体化，断链报错、环形链接显式报错并建议清缓存重跑 prepare、失败清理半成品、修毕复检）。

## 恢复（构建被拦时）

```bash
node scripts/check-pi-resources-links.mjs --fix
```

替换后重跑构建。注意：下次 git-cwt 创建 worktree 会重建 symlink 形态，签名构建前检测会自动拦截并提示本命令。

## 实测记录（2026-10-14）

- 干净缓存（pi-0.84.1）：5 项 symlink → `--fix` 一次通过，递归 0 symlink 残留，pi 二进制可执行位保留。
- 脏缓存（pi-0.80.3，历史遗留）：目录内部有跨 workspace 环形子链接（`assets/assets` → 旧 workspace 同名目录，链接图成环）→ `--fix` 明确报「环形链接 + 建议删缓存重跑 prepare-pi-resources.sh」，半成品自动清理；该缓存目录本体建议人工清理（`rm -rf .pi-binary-cache/pi-0.80.3-darwin-arm64`，pi 已升级不再使用）。
- preflight 全脚本集成：检查 7 段落输出与放行/拦截语义正确。
