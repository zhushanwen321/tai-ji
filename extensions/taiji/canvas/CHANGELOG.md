# @zhushanwen/pi-canvas

## 0.4.5

### Patch Changes

- 3107549df: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.24.0 → @zhushanwen/extension-protocol@0.25.0, @zhushanwen/subagent-core@2.1.0 → @zhushanwen/subagent-core@2.1.1)

## 0.4.4

### Patch Changes

- da658a786: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.23.0 → @zhushanwen/extension-protocol@0.24.0, @zhushanwen/subagent-core@2.0.1 → @zhushanwen/subagent-core@2.1.0)

## 0.4.3

### Patch Changes

- 318994f4a: chore: refresh dependency range (triggered by @zhushanwen/subagent-core@2.0.0 → @zhushanwen/subagent-core@2.0.1)

## 0.4.2

### Patch Changes

- e37e7e659: chore: refresh dependency range (triggered by @zhushanwen/subagent-core@1.6.1 → @zhushanwen/subagent-core@2.0.0)

## 0.4.1

### Patch Changes

- df839883b: chore: refresh dependency range (triggered by @zhushanwen/extension-protocol@0.22.0 → @zhushanwen/extension-protocol@0.23.0, @zhushanwen/subagent-core@1.6.0 → @zhushanwen/subagent-core@1.6.1)

## 0.4.0

### Minor Changes

- 58a70ebc9: Canvases are now session-scoped: `canvas_list` only returns canvases created by the current session, and opening another session's canvas with `canvas_enter` is rejected with `forbidden` asking the user to switch to the owning session.

## 0.3.0

### Minor Changes

- 796f01b29: 六个 canvas 工具结果新增 details.summary 收起态一行摘要（GUI 对话流收起态与 pi TUI 折叠态共用同源文本），展开态仍显示完整回包。

## 0.2.0

### Minor Changes

- 7babdefa7: 新增 pi-canvas 扩展：注册 canvas_enter / canvas_edit / canvas_read / canvas_review / canvas_export / canvas_list 六个 deferred 画布工具，agent 经 CANVAS_MARKER 通道与 taiji 画布服务桥接，支持在问题解决画布上生长论证图（论据条目可声明素材性 fact/claim；fact 论据创建即未核实，agent 不自证核实，核实经 canvas_edit patch 翻转后该论据才可作为 passed 依据）、接受 must-fix 审查回推并导出需求卡；仅在 taiji GUI 宿主（rpc 模式）下启用。
