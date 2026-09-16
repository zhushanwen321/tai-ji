# Changesets

## 高优先级规则

除非 PR 修改了已发布包的运行时行为，否则不要添加 changeset。

## 已发布包

- `@zhushanwen/extension-protocol` — Extension GUI 渲染协议

## 添加 Changeset

```bash
pnpm changeset
```

按提示选择包 + 版本类型（patch/minor/major）+ 描述。
提交生成的 `.changeset/*.md` 文件即可，发布时由 CI 消费。

## 发布

- 正式版：tag `npm-*`（格式 `npm-<slug>-<date>-<time>`）触发 `.github/workflows/release-npm.yml`。main 线采用人工版本判定（`scripts/check-version-changes.sh` + `scripts/apply-version.sh`），不用 `changeset version` 自动推算 type
- 预发布：push `dev-npm-*` 分支触发 `.github/workflows/release-npm-dev.yml`（`--tag dev`），保留 `changeset version` + `changeset pre` 全流程
