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

## 9. 通过 SPI 外设直接读传感器寄存器（Halt 状态）

在 Halt CPU 后，可以通过操作 SPI 外设寄存器来直接读取传感器数据，适合验证芯片型号、寄存器值。

### 9.1 关键步骤

1. **解除 DBGMCU 冻结**：DBGMCU_APB1_FZ (0xE0042008) 控制外设在调试时是否冻结。bit15=DBG_SPI3_STOP，写 0 使 SPI3 在 Halt 时继续工作。
2. **控制 CS 引脚**：通过 GPIO BSRR 寄存器控制片选，不要用 ODR（BSRR 不会中断打断）。
3. **写 SPIx_DR 发起传输**：写入要发送的字节，硬件自动产生时钟。
4. **读 SPIx_SR 等待完成**：检查 RXNE (bit0) 标志。
5. **读 SPIx_DR 获取数据**：读取接收到的字节。
6. **拉高 CS 结束传输**。

### 9.2 示例：读 BMI08x 加速度计芯片 ID

BMI085 ACC ID = 0x1F, BMI088 ACC ID = 0x1E。芯片 ID 寄存器地址 = 0x00，读操作时地址高位置 1。

```
// SPI3 外设 @ 0x40003C00
// CSB_ACCEL = PB7, GPIOB_BSRR = 0x48000418
// CSB_GYRO  = PA15, GPIOA_BSRR = 0x48000018

Device STM32F302CB
Si SWD
Speed 4000
Connect
Halt

// 1. 解冻 SPI3（不清除则 SPI 不工作）
w4 0xE0042008, 0x00000000
sleep 10

// 2. 拉低 CS (BSRR 高16位置位 = 拉低)
w4 0x48000418, 0x00800000
sleep 5

// 3. 发读命令 (reg 0x00 | 0x80)
w4 0x40003C0C, 0x00000080
sleep 50

// 4. 检查 SR，读 DR (收到 dummy)
mem32 0x40003C08 1
mem32 0x40003C0C 1

// 5. 发 dummy 0x00 获取实际数据
w4 0x40003C0C, 0x00000000
sleep 50
mem32 0x40003C08 1
mem32 0x40003C0C 1    // DR 的低16位含接收数据

// 6. 拉高 CS
w4 0x48000418, 0x00000080

// 7. 恢复 DBGMCU 设置
w4 0xE0042008, 0x00001800
Exit
```

> SPI3_DR 是 16 位寄存器，`mem32` 读取会返回 32 位值，实际数据在低 16 位中。
> 对于 8 位数据帧，接收字节在 DR[7:0] 或 DR[15:8] 取决于具体实现，需结合已知芯片 ID 验证。
> `sleep` 时间要足够让 SPI 时钟完成字节传输（几十 ms 安全）。
> 读完后必须恢复 DBGMCU 配置，否则外设行为异常。

### 9.3 SPI3 寄存器地址（STM32F302）

| 寄存器 | 地址 | 关键位 |
|--------|------|--------|
| SPI3_CR1 | 0x40003C00 | bit1=CPOL, bit0=CPHA, bit6=SPE, bit2=MSTR, bits5:3=BR |
| SPI3_CR2 | 0x40003C04 | bits11:8=DS(数据位-1), bit8=FRXTH |
| SPI3_SR  | 0x40003C08 | bit0=RXNE, bit1=TXE, bit5=BSY, bit6=FRE(帧错误) |
| SPI3_DR  | 0x40003C0C | 写=发送, 读=接收 |

### 9.4 SR 状态解读

| 值 | 含义 |
|----|------|
| 0x403 | RXNE=1, TXE=1 → 数据就绪，可发下一字节 |
| 0x603 | 同上 + FTLVL>0 → TX FIFO 有数据 |
| 0x643 | FRE=1 → **帧格式错误**（NSS 时序或 SPI 模式不匹配） |

## 10. 运行时 SRAM Dump 与分析

### 10.1 基本流程

```
// go.jlink — 让芯片运行
Device STM32F302CB Si SWD Speed 4000 Connect go sleep 200 Exit

// 等几秒后 halt 并 dump
Device STM32F302CB Si SWD Speed 4000 Connect halt savebin ram.bin, 0x20000000, 0x4000 Exit
```

> `go` 命令恢复 CPU 运行，`sleep` 等待期间 CPU 继续执行。
> `savebin` 必须在 Halt 后使用，否则数据可能不一致。
> 对 STM32F302CBTx (16KB RAM)，dump 长度 = 0x4000。

### 10.2 通过 Python 分析 Dump

```python
import struct
with open('ram.bin', 'rb') as f:
    data = f.read()

def rf(addr):  # 读 float
    o = addr - 0x20000000
    return struct.unpack('<f', data[o:o+4])[0]
    
def ri16(addr):  # 读 int16
    o = addr - 0x20000000
    return struct.unpack('<h', data[o:o+2])[0]
```

**常用变量特征值搜索：**

| 特征 | 说明 |
|------|------|
| 三个连续 1.0 (float) | g_acc_factor = {1.0, 1.0, 1.0} |
| 9.8 附近 (float) | body_acc (重力加速度) |
| 0x78563412 (uint32) | IAP 标志位（存于 0x08008000，RAM 中也有影子） |
| 0x48000400 (uint32) | GPIOB 基地址（dev 结构体特征） |
| 0x48000000 (uint32) | GPIOA 基地址 |

**PoseInfo 结构体特征：**
```c
struct PoseInfo {  // 共 28 字节 / 7 个 float
    float roll;      // 弧度, [-pi, pi]
    float pitch;
    float yaw;
    float vel_roll;  // rad/s
    float vel_pitch;
    float vel_yaw;
    float body_acc;  // m/s2, ≈9.8 静止时
};
```
在 dump 中通过搜索 body_acc≈9.8 反推结构体起始地址。

## 11. 双固件烧录（Boot + App 不同地址）

对 IAP 架构（Boot @ 0x08000000, App @ 0x08010000），必须指定烧录地址：

```
// 烧 Boot
loadfile BOOT.bin, 0x08000000
// 烧 App
loadfile APP.bin, 0x08010000
// 确认 IAP 标志区干净（让 Boot 直接跳 App）
w4 0x08008000, 0xFFFFFFFF
verify 0x08008000, 1
go
```

> `loadfile` 比 `loadbin` 更通用，支持 .hex/.bin 自动识别。
> 烧录前建议先 `erase` 全片擦除，避免新旧代码残留。

## 12. CAN 外设调试要点

| 检查项 | 寄存器/命令 | 正常值 |
|--------|-----------|--------|
| 中断使能(NVIC) | mem32 0xE000E100 1 | bit20=1 (USB_LP_CAN_RX0) |
| CAN 中断使能 | mem32 0x40006414 1 | bit1=1 (FMPIE0) |
| 总线错误 | mem32 0x40006418 1 | 0x00000000 (LEC=0, REC=0, TEC=0) |
| 波特率 | mem32 0x4000641C 1 | 0x00120005 (1Mbps for F302) |
| 是否收到数据 | mem32 0x40006404 1 | bit11(RX)=1 时有总线活动 |
| 是否冻结 | mem32 0x40006400 1 | bit16(DBF)=0 时正常; Halt 后=1 会冻结 |

**排查误区：** Halt 后读 CAN MSR 发现 RX=0，不一定是总线没数据——可能是 DBF=1 导致 CAN 外设冻结。正确做法：不 Halt 直接 `mem32` 读。

## 注意事项

- `mem32` **不 halt CPU**，可直接读运行中的寄存器
- **`pe32` 不是有效 JLink 命令**，读内存始终用 `mem32`
- `Halt` 之后若 CAN MCR bit16 DBF=1，**CAN 会冻结**，MSR 的 RX 位会消失，调试时注意这个陷阱
- Halt 后 SPI 外设也可能冻结（DBGMCU 控制），需要先清除对应的 DBG_STOP 位
- JLink 脚本中不支持循环。需要批量读时，用多次 `mem32` + `sleep` 的组合
- 芯片型号必须和实际匹配（F302xC vs F302x8 等），否则 `Connect` 失败
- `w4` 写 32 位值到寄存器，对 16 位寄存器只取低 16 位
- 一个 JLink 脚本文件内同一条命令不要写两遍（如 `connect`），否则第二遍会报错
- `sleep` 单位 ms，最大约 1000-2000ms（视版本）
