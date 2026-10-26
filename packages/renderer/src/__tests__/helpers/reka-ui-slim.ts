/**
 * reka-ui 瘦入口 shim —— renderer vitest 的 'reka-ui' alias 目标（见 packages/renderer/vitest.config.ts）。
 *
 * 为什么存在：reka-ui/dist/index.js 是桶文件，import 会求值全部组件目录（裸 Node 实测
 * 450-520ms/次；threads 池 isolate 模式下每个测试文件独立装载一次，265 个 UI 测试文件
 * 合计 ~75s CPU，为 renderer 装载成本第一热点——见 .tmp/round4-a-import-durations.md）。
 * 包 package.json 的 exports 映射无组件子路径，裸 'reka-ui/xxx' 深路径会被拦截；相对
 * 文件路径 import 不走包解析、不受拦截，故本文件按组件 dist 文件逐个 re-export。
 *
 * 维护规则（fail-fast）：新增 reka-ui 组件/符号 import **或 re-export**（ui 包
 * primitives 有 `export { X } from 'reka-ui'` 转发形态）时，必须在此补对应 re-export——
 * 缺导出不会在收集期报错，而是组件运行时变 undefined（"Invalid vnode type" Vue warn /
 * 相关断言红），定位时先 diff 本文件与全仓 reka-ui 符号全集。定位方法：
 * `ls node_modules/reka-ui/dist/<Component>/` 找 <Symbol>.js，确认其导出名
 * （约定 <Symbol>_default，上下文注入器/injectXxxRootContext 同文件）。
 *
 * 边界：仅测试侧生效（vitest.config.ts resolve.alias）；生产构建与 tsc typecheck 不经
 * 此文件——typecheck 时源码仍 import 'reka-ui' 裸说明符（解析到包自身类型），且本文件
 * 位于 tsconfig 的测试目录排除范围（src 下 __tests__ 目录整体排除）。类型 re-export 从
 * dist/index.js 取（TS 解析相邻分块 index.d.ts；export type 在转译期整体擦除，零运行
 * 时装载成本）。
 */

// ---- 共享工具（dist/shared/，非组件目录）----
export { useForwardProps } from '../../../../../node_modules/reka-ui/dist/shared/useForwardProps.js'
export { useForwardPropsEmits } from '../../../../../node_modules/reka-ui/dist/shared/useForwardPropsEmits.js'

// ---- Primitive / Label ----
export { Primitive } from '../../../../../node_modules/reka-ui/dist/Primitive/Primitive.js'
export { Label_default as Label } from '../../../../../node_modules/reka-ui/dist/Label/Label.js'

// ---- Checkbox ----
export { CheckboxRoot_default as CheckboxRoot } from '../../../../../node_modules/reka-ui/dist/Checkbox/CheckboxRoot.js'
export { CheckboxIndicator_default as CheckboxIndicator } from '../../../../../node_modules/reka-ui/dist/Checkbox/CheckboxIndicator.js'

// ---- Collapsible ----
export { CollapsibleRoot_default as CollapsibleRoot } from '../../../../../node_modules/reka-ui/dist/Collapsible/CollapsibleRoot.js'
export { CollapsibleTrigger_default as CollapsibleTrigger } from '../../../../../node_modules/reka-ui/dist/Collapsible/CollapsibleTrigger.js'
export { CollapsibleContent_default as CollapsibleContent } from '../../../../../node_modules/reka-ui/dist/Collapsible/CollapsibleContent.js'

// ---- ContextMenu ----
export { ContextMenuRoot_default as ContextMenuRoot } from '../../../../../node_modules/reka-ui/dist/ContextMenu/ContextMenuRoot.js'
export { ContextMenuTrigger_default as ContextMenuTrigger } from '../../../../../node_modules/reka-ui/dist/ContextMenu/ContextMenuTrigger.js'
export { ContextMenuPortal_default as ContextMenuPortal } from '../../../../../node_modules/reka-ui/dist/ContextMenu/ContextMenuPortal.js'
export { ContextMenuContent_default as ContextMenuContent } from '../../../../../node_modules/reka-ui/dist/ContextMenu/ContextMenuContent.js'
export { ContextMenuItem_default as ContextMenuItem } from '../../../../../node_modules/reka-ui/dist/ContextMenu/ContextMenuItem.js'
export { ContextMenuSeparator_default as ContextMenuSeparator } from '../../../../../node_modules/reka-ui/dist/ContextMenu/ContextMenuSeparator.js'

// ---- Dialog ----
export { DialogRoot_default as DialogRoot, injectDialogRootContext } from '../../../../../node_modules/reka-ui/dist/Dialog/DialogRoot.js'
export { DialogPortal_default as DialogPortal } from '../../../../../node_modules/reka-ui/dist/Dialog/DialogPortal.js'
export { DialogOverlay_default as DialogOverlay } from '../../../../../node_modules/reka-ui/dist/Dialog/DialogOverlay.js'
export { DialogContent_default as DialogContent } from '../../../../../node_modules/reka-ui/dist/Dialog/DialogContent.js'
export { DialogTitle_default as DialogTitle } from '../../../../../node_modules/reka-ui/dist/Dialog/DialogTitle.js'
export { DialogDescription_default as DialogDescription } from '../../../../../node_modules/reka-ui/dist/Dialog/DialogDescription.js'
export { DialogClose_default as DialogClose } from '../../../../../node_modules/reka-ui/dist/Dialog/DialogClose.js'

// ---- HoverCard ----
export { HoverCardRoot_default as HoverCardRoot } from '../../../../../node_modules/reka-ui/dist/HoverCard/HoverCardRoot.js'
export { HoverCardTrigger_default as HoverCardTrigger } from '../../../../../node_modules/reka-ui/dist/HoverCard/HoverCardTrigger.js'
export { HoverCardPortal_default as HoverCardPortal } from '../../../../../node_modules/reka-ui/dist/HoverCard/HoverCardPortal.js'
export { HoverCardContent_default as HoverCardContent } from '../../../../../node_modules/reka-ui/dist/HoverCard/HoverCardContent.js'

// ---- Popover ----
export { PopoverRoot_default as PopoverRoot, injectPopoverRootContext } from '../../../../../node_modules/reka-ui/dist/Popover/PopoverRoot.js'
export { PopoverTrigger_default as PopoverTrigger } from '../../../../../node_modules/reka-ui/dist/Popover/PopoverTrigger.js'
export { PopoverAnchor_default as PopoverAnchor } from '../../../../../node_modules/reka-ui/dist/Popover/PopoverAnchor.js'
export { PopoverClose_default as PopoverClose } from '../../../../../node_modules/reka-ui/dist/Popover/PopoverClose.js'
export { PopoverPortal_default as PopoverPortal } from '../../../../../node_modules/reka-ui/dist/Popover/PopoverPortal.js'
export { PopoverContent_default as PopoverContent } from '../../../../../node_modules/reka-ui/dist/Popover/PopoverContent.js'

// ---- ScrollArea ----
export { ScrollAreaRoot_default as ScrollAreaRoot } from '../../../../../node_modules/reka-ui/dist/ScrollArea/ScrollAreaRoot.js'
export { ScrollAreaViewport_default as ScrollAreaViewport } from '../../../../../node_modules/reka-ui/dist/ScrollArea/ScrollAreaViewport.js'
export { ScrollAreaScrollbar_default as ScrollAreaScrollbar } from '../../../../../node_modules/reka-ui/dist/ScrollArea/ScrollAreaScrollbar.js'
export { ScrollAreaThumb_default as ScrollAreaThumb } from '../../../../../node_modules/reka-ui/dist/ScrollArea/ScrollAreaThumb.js'
export { ScrollAreaCorner_default as ScrollAreaCorner } from '../../../../../node_modules/reka-ui/dist/ScrollArea/ScrollAreaCorner.js'

// ---- Select ----
export { SelectRoot_default as SelectRoot, injectSelectRootContext } from '../../../../../node_modules/reka-ui/dist/Select/SelectRoot.js'
export { SelectTrigger_default as SelectTrigger } from '../../../../../node_modules/reka-ui/dist/Select/SelectTrigger.js'
export { SelectValue_default as SelectValue } from '../../../../../node_modules/reka-ui/dist/Select/SelectValue.js'
export { SelectIcon_default as SelectIcon } from '../../../../../node_modules/reka-ui/dist/Select/SelectIcon.js'
export { SelectPortal_default as SelectPortal } from '../../../../../node_modules/reka-ui/dist/Select/SelectPortal.js'
export { SelectContent_default as SelectContent } from '../../../../../node_modules/reka-ui/dist/Select/SelectContent.js'
export { SelectViewport_default as SelectViewport } from '../../../../../node_modules/reka-ui/dist/Select/SelectViewport.js'
export { SelectItem_default as SelectItem } from '../../../../../node_modules/reka-ui/dist/Select/SelectItem.js'
export { SelectItemText_default as SelectItemText } from '../../../../../node_modules/reka-ui/dist/Select/SelectItemText.js'
export { SelectGroup_default as SelectGroup } from '../../../../../node_modules/reka-ui/dist/Select/SelectGroup.js'
export { SelectLabel_default as SelectLabel } from '../../../../../node_modules/reka-ui/dist/Select/SelectLabel.js'
export { SelectSeparator_default as SelectSeparator } from '../../../../../node_modules/reka-ui/dist/Select/SelectSeparator.js'

// ---- Switch ----
export { SwitchRoot_default as SwitchRoot } from '../../../../../node_modules/reka-ui/dist/Switch/SwitchRoot.js'
export { SwitchThumb_default as SwitchThumb } from '../../../../../node_modules/reka-ui/dist/Switch/SwitchThumb.js'

// ---- Tooltip ----
export { TooltipProvider_default as TooltipProvider } from '../../../../../node_modules/reka-ui/dist/Tooltip/TooltipProvider.js'
export { TooltipRoot_default as TooltipRoot } from '../../../../../node_modules/reka-ui/dist/Tooltip/TooltipRoot.js'
export { TooltipTrigger_default as TooltipTrigger } from '../../../../../node_modules/reka-ui/dist/Tooltip/TooltipTrigger.js'
export { TooltipPortal_default as TooltipPortal } from '../../../../../node_modules/reka-ui/dist/Tooltip/TooltipPortal.js'
export { TooltipContent_default as TooltipContent } from '../../../../../node_modules/reka-ui/dist/Tooltip/TooltipContent.js'

// ---- 类型符号（export type 转译期擦除，不产生对 dist/index.js 的运行时装载）----
export type {
  AcceptableValue,
  CheckboxCheckedState,
  CheckboxRootEmits,
  CheckboxRootProps,
  CollapsibleContentProps,
  CollapsibleRootEmits,
  CollapsibleRootProps,
  CollapsibleTriggerProps,
  DialogContentEmits,
  DialogContentProps,
  DialogDescriptionProps,
  DialogRootEmits,
  DialogRootProps,
  DialogTitleProps,
  HoverCardContentProps,
  HoverCardRootEmits,
  HoverCardRootProps,
  LabelProps,
  PopoverContentEmits,
  PopoverContentProps,
  PopoverRootEmits,
  PopoverRootProps,
  PrimitiveProps,
  ScrollAreaRootProps,
  ScrollAreaScrollbarProps,
  SelectContentEmits,
  SelectContentProps,
  SelectItemEmits,
  SelectItemProps,
  SelectRootEmits,
  SelectRootProps,
  SelectTriggerProps,
  SelectValueProps,
  SwitchRootEmits,
  SwitchRootProps,
  TooltipContentProps,
  TooltipRootEmits,
  TooltipRootProps,
} from '../../../../../node_modules/reka-ui/dist/index.js'
