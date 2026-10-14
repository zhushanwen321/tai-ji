# dev 提速 symlink 形态与本地签名构建互斥

状态：开放（本地构建环境债，不影响 CI；签名构建前需手动恢复）。

## 现象

`pnpm dev` 装配器把 worktree 的 `apps/electron/resources/pi/` 建成指向 workspace 级缓存 `.pi-binary-cache/` 的 symlink（免重复下载，见 `apps/electron/scripts/dev-instance-lib.mjs`）。electron-builder 打包时按链接原样拷贝进 bundle，`codesign --validate` 以「bundle 必须自包含」拒绝：报 `invalid destination for symbolic link in bundle`（指向 bundle 外部路径的链接即使目标存在也判无效）。CI 不受影响（无本地缓存，`prepare-pi-resources.sh` 走真实下载复制）。

## 判定

构建报 `invalid destination for symbolic link in bundle` 时扫描产物内符号链接：

```bash
find <builder-output>/TaiJi.app -type l
```

目标解析后不在 `.app` 目录内的即肇事链接（当前已知肇事源 = `Contents/Resources/pi/` 下的 6 项）。

## 恢复

把 staged 资源的 symlink 替换为真实复制（产物目录 gitignored，不改仓库文件）：

```bash
cd apps/electron/resources/pi
for link in *; do if [ -L "$link" ]; then target="$(readlink "$link")" && rm "$link" && cp -R "$target" "$link"; fi; done
```

替换后清 `apps/electron/dist/builder-output` 重跑构建。注意：下次 `pnpm dev` 可能重建 symlink 形态，签名构建前需重查。

## 修复方向

`dev-instance-lib.mjs` 的 symlink stage 与「签名构建」加互斥感知：构建入口（preflight 或 pre-merge-check 构建步）检测 `resources/pi` 含外部 symlink 即提示先执行上述恢复命令，或装配器提供 `--copy-pi` 形态供构建前使用。
