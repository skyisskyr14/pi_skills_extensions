---
name: stm32-cmake-arch
description: 设计、审查或整理 STM32CubeMX + HAL + CMake 固件的目录、依赖、RT-Thread 集成、App/Boot 分区和 User 层边界。用于将 Keil 工程迁移到 Cube/CMake、建立 system/app/driver/task/init 架构，或避免重构破坏 Boot/App 兼容性。
---

# STM32CubeMX + CMake User 架构

使用本 skill 建立或审查新固件架构。它定义代码应该放在哪里；涉及旧工程行为
等价、IAP 或 Boot/App 交接时，必须同时使用 `embedded-refactor` skill。

## 主架构

```
Core/HAL  提供启动、时钟、Cube 外设句柄和 HAL 运行环境
    ↓
system    完成 RTOS/板级适配，并提供受控的公共项目头文件
    ↓
app       定义按业务域归类的参数、协议、数据模型和可调阈值
    ↓
driver    封装硬件能力、DMA/IRQ 和协议机械细节
    ↓
task      编排线程、业务时序、状态机和消息路由
    ↓
init      作为组合根，启动顶层模块并保持启动顺序
```

`tool` 是可选的纯工具层：只放跨 task 的无硬件、无业务状态工具；不要用它逃避
明确的层归属。

## 层职责与禁止项

| 层 | 放什么 | 不放什么 |
| --- | --- | --- |
| `Core/`, `Drivers/` | Cube 代码、启动文件、HAL、链接输入 | 业务状态机和协议策略 |
| `User/system/` | RT-Thread 板级适配、RTOS 配置、板级交接、公共门面 | 产品业务线程 |
| `User/app/<domain>/` | 宏、枚举、协议常量、结构体、可调参数 | 寄存器操作、线程循环 |
| `User/driver/` | HAL/寄存器、GPIO、DMA、IRQ、序列化、硬件缓存 | 产品状态迁移与周期策略 |
| `User/task/` | 线程入口、周期、状态机、命令路由、业务时序 | 随意直接改寄存器 |
| `User/init.c` | 一次性外设补充初始化、顶层 task 启动顺序 | 长期运行的业务循环 |
| `User/tool/` | 无状态/无硬件共享工具 | 某个业务域的策略或驱动 |

历史兼容例外必须写在注释中：例如 driver 为保持旧协议可能更新一个 PM 兼容标志，
或 Core 的 UART IRQ 必须在 USER CODE 区接入既有环形缓冲。例外不是新代码可以
复制的通用模式。

## 目录模板

```text
App/
├── Core/                         # Cube/HAL runtime
├── Drivers/                      # Cube/HAL/CMSIS
├── User/
│   ├── system/                   # RTOS + board adaptation + shared facade
│   ├── app/
│   │   ├── pm/                   # Power-management config/model
│   │   ├── bm/                   # Battery/BMS config/model
│   │   └── cmd/                  # Command/protocol config/model
│   ├── driver/
│   │   ├── inc/
│   │   └── src/
│   ├── task/
│   │   ├── inc/
│   │   └── src/
│   ├── tool/                     # Optional pure shared utilities
│   ├── ARCHITECTURE.md
│   └── init.c
├── cmake/
└── CMakeLists.txt
```

Boot 可采用同一原则，但不要求与 App 目录机械对称。Boot 只保留它实际需要的
system、driver、IAP 和裸机入口；不能为了“架构整齐”引入 App 的 RTOS 或业务层。

## 依赖规则

1. `app` 不能依赖 `task` 或 `driver`。
2. `driver` 可以依赖 HAL、CMSIS 和必要的公共类型；默认不依赖 `task`。
3. `task` 读取 `app`，调用 `driver`，拥有业务状态和调度。
4. `init` 只启动顶层任务；子任务由拥有它的 task 创建。
5. `system/drv_common.h` 可作为旧工程过渡门面，但新文件优先包含直接依赖，避免
   将所有模块耦合到一个聚合头。
6. 每个公共头文件必须能独立编译；不要依赖偶然的 include 顺序。

## Cube、HAL 与中断

- 把 Cube 生成内容视为受管理代码。优先放扩展到 USER CODE 区；如果必须修改
  生成文件的非 USER 区（例如向量/IRQ 所有权），保存最小、可重放的补丁并说明原因。
- 不允许两个实现同时拥有同一个 IRQ、RXNE、DMA stream、SysTick 或外设状态机。
- RT-Thread 与 HAL 共用 SysTick 时，明确谁调用 HAL tick、谁推进 RT tick，且只保留
  一个有效的 `SysTick_Handler`。
- RTOS 接管的 PendSV/HardFault 必须与启动汇编和链接配置一致。
- HAL 初始化失败时先检查 Boot 遗留时钟/寄存器状态，不要盲目在任务中反复初始化。

## CMake 规则

1. 显式列出 `User/system`、`User/driver/src`、`User/task/src`、`User/tool/src` 和
   `User/init.c` 的源文件。
2. 显式提供 `User/system`、每个 `app` 域、`driver/inc`、`task/inc`、`tool/inc` 和
   共享 IAP 的 include 路径。
3. App/Boot 使用各自链接脚本和 Flash ORIGIN；不要让 App 默认为地址 0。
4. 将芯片、`USE_HAL_DRIVER`、App/Boot 分支宏和 ABI 选项放在可审查的 CMake 目标上。
5. CMake cache 绑定绝对源目录；复制项目后删除/重新配置对应 build 目录，不能复用
   原路径生成的 `CMakeCache.txt`。

## 重构检查

- [ ] 新代码按上述层归属，没有为方便而把业务塞进 driver 或 init。
- [ ] `app` 的可调参数与协议定义不散落在 task/driver 源码。
- [ ] task 周期和所有 tick/ms 单位已记录。
- [ ] IRQ/DMA 的唯一所有者明确。
- [ ] Core 的必要补丁可解释、可重复，不会被 Cube 生成静默覆盖。
- [ ] App/Boot 链接地址、VTOR、IAP 标志和共享库分支已验证。
- [ ] Debug 与 Release 都从干净 CMake 配置构建成功。
