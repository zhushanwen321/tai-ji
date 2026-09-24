# @zhushanwen/session-core

Coding-agent session 的 canonical 模型与纯 JSONL 原语基座。**零运行时依赖**（import 图不可达任何驱动/外部包），可被 node 侧 tsup 与 extension 侧 esbuild 安全内联，可独立 npm 发布。

## 包定位

「把某个 coding-agent 的 session 读成统一结构」的唯一落点：session-reader（pi 会话读取）、runtime 导入、未来的 coding-agent source 包共用本基座，取代各自为政的字节层副本（首行读取、entry 解析、id 归一化）。

## 导出面

| 导出 | 说明 |
|------|------|
| `Entry` / `ParseResult` / `SessionHeader` / `NormalizedSession` | canonical 模型（D1）：严格 Entry 树，坏行丢弃不占位 |
| `parseSessionContent(content)` | JSONL 文本 → `ParseResult`（坏行计 `skippedLines`，末行半行记 `lastLinePartial`） |
| `parseSessionFile(path)` | `parseSessionContent` 的 async 文件版（ENOENT 等按 fs 原生错误抛出） |
| `serializeSession(entries)` | `Entry[]` → JSONL，与 pi 产物逐字节兼容（`JSON.stringify(entry) + '\n'`） |
| `readFirstJsonlLine(path)` / `readFirstJsonlLineSync(path)` | 首行字节原语（async/sync 双形态）：只读首行、处理 CRLF/LF、跨块多字节安全；空文件/纯空白 → `undefined`；IO 错误上抛由消费方分流 |
| `sessionIdFromFileName(fileName)` | 文件名不变量：剥 `.jsonl` 后最后一个 `_` 之后的尾段；提取不出 → `undefined` |
| `normalizeZcodeRowId(rowId)` | zcode 行 id → 8 位零填充小写十六进制（canonical entry id 域） |

## 显式不进基座

- **header 合法性谓词**：reader 仅要求 `id`、runtime 要求 `id`+`cwd` 非空——语义差异是不可统一的行为契约，各消费侧保留薄包装（≤5 行，共享本基座的 `readFirstJsonlLine`）。
- **形式化 source SPI**：source 契约 = 「产出 `NormalizedSession`」的约定，形式接口在第二个 source 落地时才抽取。
