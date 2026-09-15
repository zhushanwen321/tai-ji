// mobile-renderer 入口（W2：调 bootstrap 编排）。
//
// W1 建立的 AC1 依赖边（@taiji/core + @taiji/ui 物理依赖边）在 W2 保留：
//   - providePlatform：core PlatformPort 符号（W1 占位引用，TC-7 回归护栏）。
//     真实注入由 bootstrap() 内部完成（见 ./bootstrap.ts）。
//   - UI_PACKAGE_NAME：ui 包占位常量，console 打印消费。
// bootstrap 接管 App 挂载（W1 的内联 createApp 占位渲染已删除）。
import { providePlatform } from '@taiji/core'
import { UI_PACKAGE_NAME } from '@taiji/ui'
import { bootstrap } from './bootstrap'

// Design tokens 接线（M1d-02）：tailwind.config 的 var(--bg)/var(--border) 等映射
// 需要 CSS 变量有定义；tokens 提取自 renderer style.css（见 styles/tokens.css 头注释）。
import './styles/tokens.css'

// W1 依赖边占位：bootstrap 内部会调 providePlatform，此处仅维持 main.ts 的
// core import（TC-7 回归 + W1 ac1-dependency-edge 护栏）。
void providePlatform

 
console.log(`[mobile-renderer] boot: ui=${UI_PACKAGE_NAME}`)

// 启动壳编排（注入 platform → 注册挂载点 → 挂载 App）。
void bootstrap()
