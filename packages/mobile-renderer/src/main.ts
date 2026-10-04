// mobile-renderer 入口（W2：调 bootstrap 编排）。
//
// W1 建立的 AC1 依赖边（@taiji/core + @taiji/ui 物理依赖边）在 W2 保留：
//   - providePlatform：core PlatformPort 符号（W1 占位引用，TC-7 回归护栏）。
//     真实注入由 bootstrap() 内部完成（见 ./bootstrap.ts）。
//   - UI_PACKAGE_NAME：ui 包占位常量，console 打印消费。
// bootstrap 接管 App 挂载（W1 的内联 createApp 占位渲染已删除）。
// vue-i18n 装配（remote-use D10 bootstrap 行）：i18n 实例在 ./i18n.ts 创建，
// bootstrap 挂载链 .use(i18n)——本入口 import 维持装配点可见性。
import { providePlatform } from '@taiji/core'
import { UI_PACKAGE_NAME } from '@taiji/ui'
import { bootstrap } from './bootstrap'
import { i18n } from './i18n'

// i18n 实例由 bootstrap 挂载链消费；此引用维持 main.ts 装配点可见（tree-shake 防护）
void i18n

// Design tokens 接线（M1d-02）：tailwind.config 的 var(--bg)/var(--border) 等映射
// 需要 CSS 变量有定义；tokens 提取自 renderer style.css（见 styles/tokens.css 头注释）。
import './styles/tokens.css'

// 浮层进出场过渡（dialog 居中依赖 translate(-50%,-50%)，缺失时弹窗出视口）。
// styles/shell.css 是桌面 style.css 同段的 mobile 镜像副本，改动须同步两处。
import './styles/shell.css'

// W1 依赖边占位：bootstrap 内部会调 providePlatform，此处仅维持 main.ts 的
// core import（TC-7 回归 + W1 ac1-dependency-edge 护栏）。
void providePlatform

 
console.log(`[mobile-renderer] boot: ui=${UI_PACKAGE_NAME}`)

// 启动壳编排（注入 platform → 注册挂载点 → 挂载 App）。
void bootstrap()
