# Flow 2 · 单 Agent 对话 → 代码变更审查

**类型**: 日常主路径（每天高频）
**关联**: ADR-0020、Phase 0.4（Markdown）、Phase 2.3（变更集+Diff）、chat-area-critique P0
**依据**: Nielsen 启发式 #3 用户控制（2/4）、#9 错误恢复（2/4）的命门短板

## 目标

用户下达一个编码任务，与单个 Agent 对话完成，并审查 Agent 产出的代码变更。这是产品每天用 100 次的核心战场，"流畅"目标的主考场。

## 屏幕布局

基于 zcode-demo 三栏：左=消息流（50%）| 中=composer（底部常驻）| 右=抽屉区（50%，默认收起）。

## 屏幕序列

### S1 · 任务下达
- composer 聚焦，用户输入任务
- 支持 @-mention 注入文件/符号上下文（Phase 2.7）
- 发送（Cmd+Enter）

### S2 · Agent 流式响应
- 消息流出现 assistant 消息
- 流式渲染顺序：thinking（折叠）→ tool call 卡 → 文本
- tool call 卡显示：工具名、目标文件、状态（running/done/failed）

### S3 · 变更集聚合
- Agent 完成文件改动后，**变更集卡**出现在 assistant 消息下方
- 卡片内容："N 个文件变更 · [查看全部]"
- 状态见下方状态机

### S4 · Diff 审查
- 用户点变更集卡 / [查看全部] → 右抽屉展开，切到 Diff tab
- 抽屉结构：
  - 顶部：文件列表（可切换，含 +/- 行数）
  - 主体：diff 视图（统一/分屏可切）
  - 底部：[Accept] [Reject] 当前文件 · [Accept All] [Reject All]

### S5 · 决策落定
- Accept → diff 标记已接受，计数 -1，自动跳下一个未审查文件
- Reject → 标记已拒绝，agent 后续可重试
- 全部处理完 → 变更集卡变 resolved，抽屉可关闭

### S6 · 继续对话
- 关闭抽屉，回到消息流
- 用户可继续追问 / 下达新任务
- 旧的 resolved 变更集折叠

## 状态机 · 变更集卡

```
accumulating → ready → partially-reviewed → resolved
                 ↓              ↓
             superseded    (用户中途又有新变更)
```

- **accumulating**: agent 还在改，文件数实时增长（带 loading 指示）
- **ready**: agent 完成，等待用户审查
- **partially-reviewed**: 部分 accept/reject
- **resolved**: 全部处理完
- **superseded**: agent 又改了一轮，旧变更集折叠归档

## 状态机 · 消息操作菜单（critique P0 短板）

hover 用户消息 → 显示 ··· → 菜单：
- 编辑并重发（触发 Flow 4 分支）
- 复制
- 引用到新消息
- 删除（带确认）

## 边缘状态

| 场景 | 处理 |
|------|------|
| Agent 只读没改 | 不出变更集卡 |
| 改动跨 50+ 文件 | 变更集卡折叠"查看 N 个变更"，抽屉虚拟滚动 |
| Agent 中途被中断 | 变更集标"未完成"，部分文件 partial diff |
| Reject 后 Agent 重试 | 新变更集出现，旧的标 superseded |
| 单行超长（500+ 字符） | diff 横向滚动 + 折叠相同行 |
| 审查时断网 | 抽屉本地可用，Accept 写回失败 → 重试提示 |
| diff 二进制文件 | 显示"二进制文件，无法预览" |

## 对 zcode-demo 的增量

demo 现有右抽屉 Diff tab（部分覆盖 S4）。需补：
- 变更集聚合卡（S3，全新）
- Accept/Reject 全套交互 + 状态机（S4-S5）
- 消息操作菜单（critique P0，全新）
- 上述边缘状态的可视化样例
