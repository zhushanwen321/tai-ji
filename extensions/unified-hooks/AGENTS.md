# unified-hooks Extension

## 概述

统一 hooks 扩展，把散落在各处的 hook 集中管理。每个 hook 是独立模块，可以独立启用/禁用。

## 技术栈

- TypeScript（Pi 运行时执行，不独立编译）
- Pi Extension API（`@mariozechner/pi-coding-agent`）

## 架构

```
unified-hooks/
├── index.ts           # 入口，re-export src/index.ts
├── package.json
├── CLAUDE.md
├── README.md
└── src/
    ├── index.ts                          # 扩展工厂函数，注册所有 hooks
    └── hooks/
        ├── edit-whitespace-autofix.ts    # edit 工具 whitespace 自动修复
        └── tool-error-handler.ts         # 工具错误日志
```

## 关键 API 约束

### ctx vs pi 的区别

| API | ctx (ExtensionContext) | pi (ExtensionAPI) |
|-----|----------------------|-------------------|
| sendUserMessage | ❌ 仅 ExtensionCommandContext | ✅ 任何位置 |
| sendMessage | ❌ 仅 ExtensionCommandContext | ✅ 任何位置 |
| sessionManager | ✅ | ❌ |
| signal | ✅ | ❌ |
| cwd | ✅ | ❌ |

**在 event handler 中注入消息，必须用 `pi.sendUserMessage()`，不能用 `ctx.sendUserMessage()`。**

### tool_execution_end 事件结构

```typescript
event = {
  toolCallId: string;
  toolName: string;     // "edit", "read", "bash", ...
  args: unknown;        // tool 输入参数（注意：字段名是 args，不是 input）
  result: unknown;      // tool 执行结果
  isError: boolean;
}
```

注意：**不是** `{ content, details, input }`，是 `{ args, result, isError }`。

### sendUserMessage 的 deliverAs 模式

| 模式 | 行为 |
|------|------|
| `"steer"` | 当前 turn 完成后、下一个 LLM 调用前投递 |
| `"followUp"` | 等待 agent 完全空闲后投递 |
| `"nextTurn"` | 队列到下一个用户 prompt |

edit 失败后需要 AI 立即处理，用 `"steer"`。

### skill 注入的正确方式

**不要**发送 `/skill-name` 文本 — 这不会触发 skill 机制（skill 是命令系统解析的，`sendUserMessage` 发的是普通用户消息）。

**正确做法**：直接把 skill 的核心行为内化到 steer 消息中：

```typescript
pi.sendUserMessage(
  "Edit failed due to whitespace. Run fix_whitespace.py --fix <file>, then retry the edit.",
  { deliverAs: "steer" }
);
```

## Hook 设计原则

1. **独立模块**：每个 hook 是独立文件，独立注册，失败不影响其他 hooks
2. **用 pi 不用 ctx**：event handler 中注入消息用 `pi.sendUserMessage()`
3. **内化行为不调 skill**：steer 消息直接描述动作，不依赖 skill 命令系统
4. **避免循环**：注入的 steer 消息可能触发新的 tool_execution_end，hook 需要幂等或去重

## 添加新 Hook

1. 在 `src/hooks/` 创建新文件：
   ```typescript
   import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

   export function setupMyHook(pi: ExtensionAPI): void {
     pi.on("tool_execution_end", async (event) => {
       // hook 逻辑
     });
   }
   ```

2. 在 `src/index.ts` 的 hookModules 数组中注册
3. `npx tsc --noEmit` 类型检查

## 测试

```bash
cd unified-hooks && npx tsc --noEmit
```
