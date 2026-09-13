# ADR-0043: Message.content 重构为 Segment[] 结构化模型

- **状态**: Accepted
- **日期**: 2026-07-16
- **上下文**: `docs/feature-map/` Phase GUI Optimize（目录已并入 `docs/architecture/feature-map.md`，当期版本已删除，git 可追溯）

## 背景

当前 `Message.content` 是纯字符串 `string`。skill badge 的渲染依赖以下链路：

1. 用户在 composer 用 `/skill:cw-cli` 触发，chip 是 contenteditable 的 DOM 元素
2. 发送时 `getTextFromEl` 用 TreeWalker 把 DOM 打平成纯文本（chip label + 零宽空格 + 用户文字）
3. pi 的 `_expandSkillCommand` 把 `/skill:name args` 整体替换为 `<skill name location>SKILL.md全文</skill>\n\nargs`
4. pi JSONL 和 `get_messages` RPC 存的都是展开后文本（含 `<skill>` 标签）
5. xyz 的 `convertPiHistory` 用正则解析 `<skill>` 标签，提取 `skillName` 字段

### 三个问题

1. **实时链路断裂**：`appendUser` 建乐观消息时不设 `skillName`，event-adapter 把 `role==='user'` 的 `message_start` 直接 noop（不回推 user 消息）。导致当前会话刚发送的 skill 消息 badge 不渲染，违反 AGENTS.md 规则 7.5（实时链路 + 持久化链路必须同时打通）。

2. **空格问题**：chip 后的零宽空格 `\u200B` 被 `getTextFromEl` 的 `.replace(/\u200B/g, '')` 过滤，导致 `/skill:cw-cli想要都修复` 无空格发给 pi。此前的自动空格修复（在 `onInput` 里 `el.textContent = spaced`）会破坏 chip DOM 和光标位置，已 revert。

3. **正则债线性增长**：未来多 badge（file 引用、@mention、drawer 行选取追加到 composer 等）每加一种都要在 `appendUser` 加正则、Message 加字段、Turn.vue 加 chip computed。组合时正则互相干扰，越来越脆。

### 方案对比

| 维度 | 方案 A（加字段） | 方案 B（全链路 Segment[]） |
|------|----------------|--------------------------|
| 单 badge 改动 | 小（加一处正则+一个字段） | 大（建基础设施） |
| 多 badge 扩展 | 线性增长（每种 badge 重复一遍） | 常数（加类型+渲染分支） |
| 序列化点 | 多处（getTextFromEl 打平 + appendUser 反解析 + pi 边界拼回） | 一处（pi 边界序列化） |
| 正则依赖 | 持续存在且增长 | 消除（composer DOM 已结构化） |

用户明确预期未来 5+ 种 badge 类型，方案 B 的基础设施投资值得。

## 决策

`Message.content` 改为 `string | Segment[]` 联合类型，按 role 语义区分：

- **user message**: `Segment[]`（badge 载体）
- **assistant message**: `string`（流式 `text_delta` 热路径，无 badge 需求）
- **system/custom message**: `string`（提示文本，无 badge 需求）

Segment 是判别联合：

```typescript
export type Segment =
  | { type: 'text'; text: string }
  | { type: 'skill'; name: string; location?: string }
  | { type: 'file'; path: string; lineRange?: [number, number] }
  | { type: 'mention'; name: string }
```

### 序列化边界

```
[composer DOM] chips + text
    ↓ getSegmentsFromEl（改造 getTextFromEl）
[Composer.draft] Segment[]
    ↓ useChat.send/steer/followUp
    ↓ chatApi.send(sid, segmentsToPrompt(segments))     ← 序列化
[WS protocol] content: string（不变）
    ↓ runtime → pi prompt("/skill:cw-cli 想要都修复")
[pi] _expandSkillCommand → <skill>标签 → 存 JSONL
    ↓ pi 回返（RPC getMessages / JSONL 文件）
[xyz 防腐层] parsePiUserContent → Segment[]              ← 反序列化（唯一）
    ↓ convertPiHistory / session-history 两条路径
[chat store / 渲染] 全程 Segment[]                        ← 无任何解析
```

### 归一化函数

`packages/shared/src/segments.ts` 提供：
- `segmentsToText(segments)`: Segment[] → 纯文本（skill→`/skill:name`，file→`path`，mention→`@name`）
- `textToSegments(text)`: 纯文本 → Segment[]（无 badge 时产出单个 text segment）
- `segmentsToPrompt(segments)`: Segment[] → pi prompt 字符串（当前与 segmentsToText 相同，语义分离供未来分化）

### DOM 解析

改造 `getTextFromEl` → `getSegmentsFromEl`：TreeWalker 遍历 DOM，遇到 `.slash-chip`/`.mention-chip` 元素时产出对应 chip segment（type/name 从 data 属性读），遇到文本节点产出 text segment。确定性遍历，非正则猜测。

## 备选方案

方案 A：Message 加独立字段（`skillName`/`filePath`/...），每加一种 badge 加一处正则 + 一个字段 + 一个 chip computed。短期改动小，但正则债随 badge 类型线性增长。

## 后果

**正面**：
- 消除正则解析，badge 信息从 composer DOM 一路结构化传递到渲染层
- 空格问题在 `segmentsToPrompt` 序列化点自然解决
- 未来加 badge 类型只需：Segment 加 case + DOM data 属性 + getSegmentsFromEl 加分支 + Turn.vue 加渲染分支
- 实时链路 skillName 在 `appendUser` 时自然设置（content 就是 Segment[]），不需等 pi 回流

**负面**：
- `Message.content` 从 `string` 变联合类型，影响约 20+ 消费点（复制/编辑/导出/pending 匹配/markdown 渲染等），需 `segmentsToText()` 归一化适配
- mock 数据和测试断言需批量更新
- `findPendingIndex` 的 `m.content === text` 比较需改为 `segmentsToText()` 两边归一化

## 关联

- 修复 skill badge 实时链路断裂（AGENTS.md 规则 7.5）
- 修复 skill 命令空格缺失问题
- 为未来 file 引用 / mention badge 奠定基础设施
