---
name: jlink-debug
description: 使用 SEGGER JLink 对 STM32 嵌入式项目进行烧录、寄存器读写、运行时监控和硬件问题排查。适用于 CAN/SPI/中断等外设调试场景。
---

# JLink 调试技能

本 skill 封装 JLink Commander 命令行工具的使用方法，用于 STM32 嵌入式固件的烧录和实时硬件调试。

## 环境

- **JLink.exe**: `D:/Program Files/SEGGER/JLink/JLink.exe`（JLink V7.54）
- **接口**: SWD
- **目标芯片**: STM32F302xC（按需替换为实际型号）
- 所有操作在项目 build 目录下执行（包含 `.hex` / `.elf` 文件）

## 1. 烧录固件

### 单文件烧录

创建 JLink 脚本 `flash.jlink`：

```
Device STM32F302xC
Si SWD
Speed 4000
Connect
LoadFile App.hex
Reset
Exit
```

执行：
```bash
cd fireware/App/build/Debug
"D:/Program Files/SEGGER/JLink/JLink.exe" -Device STM32F302xC -If SWD -Speed 4000 -AutoConnect 1 -CommanderScript flash.jlink
```

> 输出显示 `Skipped. Contents already match` 表示 Flash 内容与 hex 文件一致，未重复写入。`O.K.` 表示成功。

### 双固件烧录（Bootloader + App）

```
Device STM32F302xC
Si SWD
Speed 4000
Connect
LoadFile ../../../Bootloader/build/Debug/Bootloader.hex
LoadFile App.hex
Reset
Exit
```

## 2. 寄存器读写

### 读取内存/寄存器（不 Halt CPU）

用 `mem32` 命令可在 CPU 运行状态下读寄存器，不影响外设工作：

```
Device STM32F302xC
Si SWD
Speed 4000
Connect
mem32 0xE000E100 1    # NVIC ISER[0]，检查中断使能
mem32 0x40006404 1    # CAN MSR
mem32 0x40006414 1    # CAN IER
mem32 0x40006400 1    # CAN MCR
mem32 0x40006418 1    # CAN ESR（错误状态）
Exit
```

> 末尾的 `1` 表示读 1 个 32-bit 字。改成 `4` 可连续读 4 个。

### 读取寄存器（Halt CPU）

需要在 CPU 停止时才能读某些寄存器（如 CAN FIFO 数据），加 `Halt` 命令。**注意：Halt 后若 CAN MCR.DBF=1，CAN 外设会冻结。**

```
Device STM32F302xC
Si SWD
Speed 4000
Connect
Halt
mem32 0xE000E100 1
mem32 0x40006404 1
Exit
```

### 写入寄存器

```
Device STM32F302xC
Si SWD
Speed 4000
Connect
w4 0xE000E100 0x00100000    # 强行置位 ISER bit20，使能 CAN RX0 中断
Exit
```

## 3. 运行时批量监控（关键！）

用于排查"中断不进但外设正常"这类问题。在固定间隔连续读寄存器，用户在此期间操作硬件发信号：

```
Device STM32F302xC
Si SWD
Speed 4000
Connect
sleep 1000
mem32 0x40006404 1
sleep 1000
mem32 0x40006404 1
sleep 1000
mem32 0x40006404 1
... （重复 15 次共 15 秒窗口）
Halt
mem32 0xE000E100 1
mem32 0x40006404 1
mem32 0x40006414 1
Exit
```

> `sleep` 单位 ms，`mem32` 不 halt CPU 时外设继续运行。

## 4. 常见寄存器速查表（STM32F302）

| 外设 | 寄存器 | 地址 | 关键位 |
|------|--------|------|--------|
| NVIC | ISER[0] | 0xE000E100 | bit20 = USB_LP_CAN_RX0_IRQn |
| CAN | MCR | 0x40006400 | bit0=INRQ, bit16=DBF |
| CAN | MSR | 0x40006404 | bit11=RX(有数据) |
| CAN | IER | 0x40006414 | bit1=FMPIE0 |
| CAN | ESR | 0x40006418 | REC(低8位), TEC(高8位) |
| CAN | BTR | 0x4000641C | 波特率配置 |

## 5. CAN 中断不进——标准排查流程

按顺序执行：

```
Device STM32F302xC
Si SWD
Speed 4000
Connect
mem32 0xE000E100 1    # ① NVIC ISER bit20 是否=1？
mem32 0x40006414 1    # ② CAN IER FMPIE0 是否=1？
mem32 0x40006400 1    # ③ CAN MCR INRQ=0 且 DBF=0？
mem32 0x40006418 1    # ④ CAN ESR：REC/TEC 是否有错误计数？
mem32 0x4000641C 1    # ⑤ BTR 波特率配置是否正确？
Exit
```

判断逻辑：

| ESR 值 | 含义 | 下一步 |
|--------|------|--------|
| 0x00000000 | 总线完全无信号 | 查物理层：收发器供电、接线、终端电阻、上位机波特率 |
| REC > 0 且递增 | 收到错误帧 | 波特率不匹配或总线干扰 |
| 有数据但不进中断 | ISER 和 IER 正常？ | 检查中断优先级是否在 FreeRTOS 允许范围内 |

> **经验**：ESR=0 是最常见的根因——CAN 收发器没供电、CAN_H/CAN_L 接反、终端电阻缺失、上位机波特率/通道选错。

## 6. 优先级冲突检查

FreeRTOS 要求 `configLIBRARY_MAX_SYSCALL_INTERRUPT_PRIORITY` 范围内的中断才能调用 FromISR API。在 `app_can_service.c` 中配置：

```c
HAL_NVIC_SetPriority(USB_LP_CAN_RX0_IRQn, configLIBRARY_MAX_SYSCALL_INTERRUPT_PRIORITY, 0U);
```

用 JLink 验证：`mem32 0xE000E414 1`（IPR for IRQ20），确保优先级 ≤ `configLIBRARY_MAX_SYSCALL_INTERRUPT_PRIORITY`。

## 7. NVIC 被覆盖问题

如果 `HAL_NVIC_EnableIRQ` 在 `main()` 阶段调用但运行时 ISER 位丢了，原因是 Bootloader 跳转或 FreeRTOS 启动过程清了 NVIC。

**修复方法**：把 `NVIC_EnableIRQ()` 移到最高优先级任务入口处（调度器启动后执行），如 `can_rx_task` 的 `CanRxTask_Run`：

```c
static void CanRxTask_Run(void *argument)
{
    (void)argument;
    AppCan_RegisterRxTask(xTaskGetCurrentTaskHandle());
    NVIC_EnableIRQ(USB_LP_CAN_RX0_IRQn);  // ← 调度器启动后才使能
    for (;;) {
        ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(10U));
        AppCan_DrainRxFifo();
    }
}
```

## 8. 构建命令

```bash
# 强制干净构建
cd fireware/App/build/Debug
"D:/Program Files/w64devkit/bin/ninja.exe" -t clean
"D:/Program Files/w64devkit/bin/ninja.exe"
```

## 注意事项

- `mem32` **不 halt CPU**，可直接读运行中的寄存器
- `Halt` 之后若 CAN MCR bit16 DBF=1，**CAN 会冻结**，MSR 的 RX 位会消失，调试时注意这个陷阱
- JLink 脚本中不支持循环。需要批量读时，用多次 `mem32` + `sleep` 的组合
- 芯片型号必须和实际匹配（F302xC vs F302x8 等），否则 `Connect` 失败
