# 图片缓存孤儿判据的枚举深度失配（生产两层布局 × 单层扫描）

> **状态**：待裁决（未动工）。**来源**：2026-10-04 feat-chat-html-support 设计期核实（tech-design 审查反哺——设计拟对齐该先例时，逐层核对发现先例自身失配）。**性质**：存量缺陷，非本设计引入；本设计**不复制**该形态（新判据显式声明三棵树各自的枚举深度）。
>
> **与本次设计的关系**：设计 D7 回收② 的产物目录回收判据在形态上对齐 `image-cache.ts` 的文件系统级判据（「超龄 + 会话树无同名文件」），但**深度规格另写**（主树两层 / subagent 三层 / btw 三层），并在检查点 7 用例中要求真实嵌套层级夹具。本条的修复不阻塞该设计。

## 现象

`apps/electron/main/images/image-cache.ts` 的孤儿判据 `isOrphanSessionDir`（设计时坐标 197-210 行）按**单层**列举 sessions 目录：

```
for (const f of readdirSync(sessionsDir)) {
  if (f.includes('.jsonl') && sessionFileIdFromName(f) === sessionDirName) return false
}
```

而生产布局是**两层**：`<dataDir>/agent/sessions/<encodeCwd>/<ISO时间戳>_<uuid>.jsonl`（本机盘面实测：`~/.taiji/agent/sessions/--Users-…--/…jsonl`；pi 默认 session dir = `<agentDir>/sessions/<safePath(cwd)>`）。单层 `readdirSync` 只会读到 `encodeCwd` 目录名（不含 `.jsonl`）→ 判据**恒返回「孤儿」**。

## 影响

- `scanOrphanImageCaches`（启动扫）：mtime 超 30 天的图片缓存目录**全部被删**，无论所属会话是否仍活跃——与代码注释自陈的「活 session 目录永不命中清理」不符。
- `enforceImageCacheGlobalCap`（512MB 软上限）：超限时「只清孤儿判死目录」同样退化为「清全部超龄目录」。
- 后果量级：图片缓存是**纯缓存**（内容 sha256 命名、可幂等重建、renderer 侧 LRU 只释放内存），故影响 = 可感知的重建成本（重新读盘 / 重新解码），非数据丢失。

## 为何测试没抓到

`apps/electron/main/images/__tests__/image-cache.test.ts` 的夹具把 session 文件**平铺**写在 `sessionsDir` 下（设计时坐标 180-181 行：`writeFileSync(join(sessionsDir, ALIVE_FILE), …)`），与生产的两层布局不符——夹具形态与判据实现同构，故用例全绿。（该文件头注记录了同族教训：「曾致孤儿判据/级联派生双盲」，本次是同一族问题的深度维度残留。）

## 建议方向（修复时定案）

1. 判据改为按生产层级列举（主树两层；若纳入 subagent / btw 树，各按其层数），或改为「按 cwd 目录逐层下探」的通用遍历。
2. 夹具改为真实嵌套层级（`sessionsDir/<encodeCwd>/<file>.jsonl`），并补一条「活会话超龄缓存不清」的端到端断言（当前该断言在夹具形态下无意义）。
3. 复核 `sessionFileIdFromName` 的末段 `_` 解析前提（pi 的 `assertValidSessionId` 允许 `_`，含 `_` 的 sid 会解析失配 → 判据失明）；失配时的保守取向（视为存在、不清）值得在修复时一并裁决。

## 参照

- 设计文档 `.tmp/tech-design/chat-html-support.md` §6.7 D7 回收②（新判据的深度规格写法与保守取向）、§11 检查点 7（用例族）
- 同族登记：`docs/todo/data-dir-accumulation-cleanup.md`（数据目录累积物清理缺口的单一登记处）
