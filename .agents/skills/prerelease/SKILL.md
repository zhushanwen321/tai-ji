---
name: prerelease
description: >-
  发布预发布版本用于测试。支持两种 target：
  Electron 产物（DMG/EXE/AppImage，触发词："发测试版"、"构建测试 DMG"、
  "生成测试包"、"pre-release test"、"beta release"、"draft release"、"测版"）
  和 npm 包（触发词："npm 预发布"、"发 npm beta"、"npm prerelease"）。
  不用于 正式发布——用 merge skill。
---

# prerelease

预发布测试统一入口。创建临时预发布版本，触发 CI 构建，验证产物，测试通过后还原代码。

## Target 路由

| Target | 触发词 | 脚本 | CI Workflow | 版本号 | 验证方式 |
|--------|--------|------|-------------|--------|---------|
| **electron**（默认） | "发测试版"、"beta release"、"测版"、"构建测试 DMG" | `scripts/prerelease-test.sh` | release.yml（push v*-beta tag） | 自动 patch+1 + `-beta`（如 0.4.6 → 0.4.7-beta） | dmg/exe/AppImage 产物存在 |
| **npm** | "npm 预发布"、"发 npm beta"、"npm prerelease" | `scripts/npm-prerelease.sh` | release-npm-dev.yml（push dev-npm-* 分支） | changeset prerelease（0.1.1-dev.0） | curl 官方 registry 确认版本上线 |

npm target 支持两类包：`@taiji/*`（位于 `packages/`）和 `@zhushanwen/pi-*`（位于 `extensions/` 三层分组 `taiji|universal|shared/<pkg>/` 下），脚本按 package.json 的 name 字段自动定位 workspace 目录。

AI 根据触发词自动判断 target。不确定时问用户。

## 核心流程（两 target 共用）

1. 确认工作区干净
2. 临时 bump 版本号 + commit + tag/push → 触发 CI
3. 轮询 CI 直到完成
4. 验证产物完整性
5. **用户确认测试通过后**，还原代码版本

## AI 操作步骤

### [MANDATORY] 1. 执行预发布脚本

```bash
# <workspace-root> = bare-repo workspace 根目录
cd <workspace-root>/main

# Electron target（默认）
bash scripts/prerelease-test.sh

# npm target
bash scripts/npm-prerelease.sh                          # 默认 @zhushanwen/extension-protocol
bash scripts/npm-prerelease.sh @zhushanwen/pi-goal      # 指定包名
```

脚本自动执行所有阶段。AI 只需执行这一步，等待脚本完成。

**脚本 exit 0 前不得宣布"已完成"。** 脚本内部已包含 CI 轮询和产物验证。

### [MANDATORY] 2. 产物通知

**Electron target**：脚本阶段 6 输出产物下载链接，随后阻塞等待你确认（确认前脚本未结束，链接在等待提示之前已输出）。
- macOS: 下载 `.dmg`，拖入 Applications 安装测试
- Windows: 下载 `.exe` 安装测试
- Linux: 下载 `.AppImage` 运行测试

**npm target**：脚本在阶段 6 阻塞询问前输出安装命令（确认前脚本未结束，安装命令已在输出区）：
```bash
npm install <pkg>@dev
```

### [MANDATORY] 3. 确认还原

脚本最后会询问"测试通过？输入 yes 还原版本"。
AI 必须等待用户明确确认后再输入 `yes`。

### [OPTIONAL] 4. CI 失败时的处理

CI 失败或超时时脚本直接中断退出，不会清理任何远程状态：远程会残留 bump commit、beta tag 与 release（npm target 则残留 dev-npm-* 分支）。AI 应：
1. 打开 CI 链接查看失败日志
2. 按脚本失败路径末尾输出的指引手动还原远程残留（Electron target 示例，tag 名以脚本实际输出为准）：

   ```bash
   git reset --hard HEAD~1 && git push github HEAD --force-with-lease
   git push github --delete v0.4.7-beta
   gh release delete v0.4.7-beta --repo zhushanwen321/tai-ji --yes   # release 已创建时
   ```

3. 修复问题后重新运行脚本

## npm target 前置条件

| 条件 | 检查方式 |
|------|---------|
| 包已发布可访问 | `curl -s -o /dev/null -w "%{http_code}" https://registry.npmjs.org/@taiji%2fextension-protocol` 返回 200（不要用 npm view——镜像同步延迟会误报） |
| GitHub repo 有 `NPM_TOKEN` secret | `gh secret list --repo zhushanwen321/tai-ji` |
| changeset 已初始化 | `.changeset/config.json` 存在 |

## 常见错误

| 错误做法 | 正确做法 |
|---------|---------|
| 手动 `npm version` + `git tag` + `git push` | 运行对应脚本，等它自己完成 |
| 脚本还在跑 CI 轮询就说"已完成" | 必须等脚本 exit 0 |
| 跳过产物验证 | 脚本会自动验证，等它输出结果 |

## 版本命名（Electron target）

| 操作 | 版本号 | 说明 |
|------|--------|------|
| 初始状态 | 代码 `0.4.6`，release `v0.4.6` | 最新正式版 |
| Bump 后 | 代码 `0.4.7-beta`，tag `v0.4.7-beta` | 测试版 |
| 还原后 | 代码 `0.4.6`，tag 已删除 | 回到初始状态 |
| 正式发布 | `v0.4.7` | 不受测试版影响 |

## 故障恢复（npm target）

```bash
# 查看 CI 日志
gh run list --workflow=release-npm-dev.yml --repo zhushanwen321/tai-ji --limit 3

# 手动验证 npm 版本——不要用 npm view（npmmirror 等镜像同步延迟会误报），与脚本一致用 curl 查官方 registry：
# dev dist-tag 指向的版本
curl -s https://registry.npmjs.org/-/package/@taiji%2fextension-protocol/dist-tags/dev
# 具体版本是否上线（HTTP 200 = 已上线；scope 包路径中的 / 须写成 %2f）
curl -s -o /dev/null -w "%{http_code}" https://registry.npmjs.org/@taiji%2fextension-protocol/0.1.1-dev.0

# 手动还原（优先用脚本输出的具体分支名 dev-npm-<timestamp>）
git checkout main && git branch -D dev-npm-<timestamp> && git push github --delete dev-npm-<timestamp>

# 或批量清理本地+远程（引号防 glob：无匹配时 bash 会按字面量传给 git 导致 branch not found）
git branch --list 'dev-npm-*' | xargs git branch -D
git branch -r --list 'github/dev-npm-*' | sed 's|github/||' | xargs -n1 git push github --delete
```

---

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[MANDATORY]` | 流程强制要求 | 必须严格遵守 |
| `[OPTIONAL]` | 可选步骤 | 可根据实际情况决定 |
