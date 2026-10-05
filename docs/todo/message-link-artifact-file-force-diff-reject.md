# 消息内链接打开产物目录文件被 forceDiff 通道拒绝

> **状态**：待裁决（未动工）。**来源**：2026-10-04 feat-chat-html-support D3 验收 A8 重验发现（形态 4 打开通道核查）。**性质**：基线存量行为缺陷，非本分支引入——git 证据：`detailFilePath` watch 段与 main 逐字同构（`git log --all -S detailFilePath` 唯一命中基线首次 import），runtime「路径越界」cwd 守门同为基线机制（`main..HEAD -S` 零命中）。基线期无产物目录（cwd 外可预览文件不存在），该失败形态当时不可达；chat-html-support 新增产物目录后该路径首次可达即暴露。

## 现象

消息流内 markdown 链接指向**产物目录内文件**（如 agent 交付的 `.html`）→ 点击走 `handleAnchorClick` → `openDrawer('detail', { filePath })` → `useDetailPane` 的 `detailFilePath` watch **固定置 `forceDiff=true`** → 走 git.diff 通道 → runtime `file.read` 族 cwd 守门拒绝（「路径越界，禁止读取 cwd 之外的文件」）→ 抽屉打开失败。`autoFallback` 仅覆盖「空 patch」不覆盖「守门 reject」。

chat-html-support v16 起产物 `.html` 的渲染由消息流内联容器承载（链接不再承载预览），点击链接的正确预期行为 = 抽屉源码态；当前连源码态都进不去（在 diff 通道就被拒）。

## 影响面

- 用户点击 agent 消息里指向交付产物的链接（`report.html` 等产物目录相对/绝对路径）→ 抽屉报错/空白，无恢复路径提示。
- 变更集卡（ChangeSetCard）入口不受影响（其语义本就是「看 diff」，forceDiff 对 cwd 内文件成立）；仅「产物目录文件 + 链接入口」组合受损。

## 建议方向（修复时定案）

`detailFilePath` watch 按文件位置分流：解析目标相对 `sessionCwd` 不在 cwd 内（产物目录文件的特征）→ 跳过 forceDiff（其「变更集文件必有 diff」的前提对 cwd 外文件不成立）→ 走常规文件读取通道（产物目录文件经 `localFile:read` 白名单通道，已有实装）。低风险定向修复；修复后补一条「链接打开产物文件 → 源码态」的 e2e 或组件测试。

## 参照

- A8 重验记录：`.tmp/dev-flow/chat-html-support.runlog/A8b.md`（形态 4 偏差与等价通道验证）
- 设计文档 `.tmp/tech-design/chat-html-support.md` §8.2 S4 行（v16 重定义：链接 → 抽屉源码态）
