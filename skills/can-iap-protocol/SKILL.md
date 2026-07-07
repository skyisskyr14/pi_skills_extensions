---
name: can-iap-protocol
description: STM32 CAN IAP 升级协议完整调试指南——包含协议逆向、帧格式对齐、原 Boot 协议解析（ExtId 解帧、IAP_FLAG 机制）、StdPeriphLib→HAL 跳转后 CAN 初始化修复、FreeRTOS 任务上下文陷阱、大端/小端差异、CAN FIFO 溢出、JLink 双设备调试等。适用于跨项目 CAN IAP 协议适配和疑难故障排查。
---

# CAN IAP 升级协议调试 Skill

从 STM32F405↔STM32F302 CAN IAP 跨项目协议适配的完整实战蒸馏。

## 一、CAN 扩展帧协议解析（最重要！）

### ExtId = (PNG << 16) | (Target << 8) | Source

| 字段 | 位域 | 宽度 | 说明 |
|------|------|------|------|
| PNG | 28:16 | 13bit | 功能码 |
| Target | 15:8 | 8bit | 目标节点地址 |
| Source | 7:0 | 8bit | 源节点地址 |

### 原 Boot 协议参数速查

```c
TARGET_ADDR = 1      // Boot 只处理来自地址 1(Host) 的帧
MPU_ADDR    = 4      // Boot 自身地址
HOST        = 0x01   // 上位机地址
DEVICE      = 0x04   // 设备地址
```

### Boot 接收 ISR 路径
Boot 用 `USB_LP_CAN1_RX0_IRQHandler`（`dri/can_dri.c`），**不是** `iap/can.c` 中的 `CAN1_RX1_IRQHandler`（后者是死代码）。

### CAN 滤波器：全通
```c
FilterMode   = IdMask
FilterScale  = 32bit
FilterId     = 0x0000
FilterMask   = 0x0000   // mask=0 → 接收所有帧
FIFO         = FIFO0
```

## 二、IAP 命令 PNG 与 Payload 格式

| 命令 | PNG | Payload | 说明 |
|------|-----|---------|------|
| CHECK | 0x403 | 无 | 在线检测，返回固件版本(8B, DLC=8) |
| ERASE | 0x400 | FirmwareSize(4B, **BE32**) | 擦除 APP 区 |
| WRITE_INFO | 0x401 | Offset(4B, BE32) + DataLen(4B, BE32) | 声明下次写入 |
| DATA | 0x420~0x4A0 | 帧号=(PNG-0x420), DLC=8 | 数据分片(8B/帧) |
| EXECUTE | 0x405 | ExecuteType(4B, BE32) | 跳转执行 |
| SUCCESS | 0x408 | **DLC=0** | 成功应答(无载荷!) |
| FAILED | 0x409 | **DLC=0** | 失败应答(无载荷!) |

### 关键细节
- EXECUTE 命令**不回复**（Boot 直接跳转）→ 上位机超时后转入 APP_CONFIRM
- SUCCESS/FAIL DLC=0 → 上位机不能强制检查 DLC==8
- 数据帧 CRC16 初值为 **0x0000**（非标准 0xFFFF），CRC 写入格式为 **BE16**

## 三、IAP 升级完整流程

```
上位机                   F302 Boot
  |                       |
  |-- CHECK(0x403) ------>|  在线检测
  |<---- 版本信息(8B) ----|
  |                       |
  |-- ERASE(0x400) ------>|  擦除 APP 区
  |<---- SUCCESS(0x408) --|  (DLC=0)
  |                       |
  |-- WRITE_INFO(0x401) ->|  声明写入参数
  |<---- SUCCESS(0x408) --|
  |                       |
  |-- DATA(0x420) ------->|  数据分片(129帧/块)
  |-- DATA(0x421) ------->|
  |  ...                  |
  |-- DATA(0x4A0) ------->|  最后帧含 CRC16
  |<-- SUCCESS/FAILED ----|
  |                       |
  |-- EXECUTE(0x405) ---->|  跳转到 App
  |   (无应答!)           |  Boot 直接跳转
  |                       |
  |   等待超时 → APP_CONFIRM
  |                       |
  |<-- App CAN 帧 --------|  App 启动, CAN 开始通信
```

### 帧间间隔
上位机数据帧之间**必须 osDelay(2ms)**，否则裸机 Boot 单线程处理不及导致 FIFO 溢出 → 序号错乱 → 升级失败。

## 四、IAP 标志位机制（0x08008000）

### 原理
Boot 启动时检查 `*(uint32_t *)0x08008000`：
```c
if (*((uint32_t *)0x08008000) != 0x78563412)
    JumpToApp();      // 标志未设置 → 直接跳 App
// 否则留在 Boot 模式等待 CAN 命令
Can_Init(CAN1);       // 初始化 CAN
while(1) {            // 等待 IAP 命令
    if (RxMsgFlag) ExecuteCommand();
}
```

### 关键行为
| 场景 | 0x08008000 值 | Boot 行为 |
|------|--------------|----------|
| 首次上电(无 App) | 任意 | 尝试跳转→SP 无效→留在 Boot |
| App 正常运行 | 0xFFFFFFFF | 跳转 App |
| 进入 IAP 模式 | 0x78563412 | 留在 Boot |
| IAP 升级后 | **0x78563412** | 留在 Boot(除非 App 清除) |

### App 清除标志
**App 启动时必须在 `IAP_Init()` 中擦除该标志**，否则下次上电 Boot 不跳 App：
```c
if (*(uint32_t *)IAP_FLAG_ADDR != 0xFFFFFFFF)
    EraseFlash(IAP_FLAG_ADDR, IAP_FLAG_END);  // 清除标志区
```

**调试注意：** JLink 烧录 Boot 不覆盖 0x08008000（该地址在 Boot 区域内但可能不在 hex 中）。IAP 后残留的标志会导致下次上电不进 App。需用 JLink 手动清除：`w4 0x08008000 0xFFFFFFFF`

## 五、StdPeriphLib Boot → HAL App：CAN 初始化陷阱

### 问题根因
原 Boot 使用 **StdPeriphLib**。跳转前调用 `RCC_DeInit()` **复位所有时钟但不复位外设寄存器**。App 使用 **HAL 库**重新初始化。CAN 外设的状态机残留导致 HAL_CAN_Init 无法正确配置。

### 失败表现
```jlink
E000ED08 = 08010000            # VTOR 正确,App 在运行
40006400 = 00010004            # MCR: TXFP=1(Boot残留),INRQ=0,SLEEP=0
40006418 = FF000013            # ESR: TEC=255→CAN 发射器错误饱和
```

### 正确修复：CAN 初始化必须在 MX_CAN_Init 上下文完成

**❌ 错误：** 在 FreeRTOS 任务上下文中调用 HAL_CAN_ConfigFilter + HAL_CAN_Start
```c
// AppCan_Init() → 由 FreeRTOS app_main 任务调用
void AppCan_Init(void) {
    HAL_CAN_ConfigFilter(&hcan, &filter);  // ❌ 失败! CAN 状态机异常
    HAL_CAN_Start(&hcan);                  // ❌ 失败!
}
```

**✅ 正确：** 在 MX_CAN_Init 的 USER CODE 段中完成（main 上下文，FreeRTOS 启动前）
```c
// can.c → MX_CAN_Init() → USER CODE CAN_Init 2
void MX_CAN_Init(void) {
    hcan.Instance = CAN;
    // ... HAL_CAN_Init ...
    
    /* USER CODE BEGIN CAN_Init 2 */
    CAN_Config_Filter();          // ✅ 同原 App 流程
    HAL_CAN_Start(&hcan);         // ✅ CAN 正常启动
    /* USER CODE END CAN_Init 2 */
}
```

### 为什么 AppCan_Init 中 CAN 初始化会失败？
1. MX_CAN_Init 中 HAL_CAN_Init 成功，State=READY
2. FreeRTOS 启动，app_main 任务运行
3. AppCan_Init 调用 HAL_CAN_ConfigFilter → 进入 INIT 模式 → 配置过滤器
4. **此时 CAN 状态机从 StdPeriphLib 残留状态切换时卡住**（INRQ=1,INAK=1 不退出）
5. HAL_CAN_Start 也失败 → CAN 从未离开初始化模式

## 六、字节序速查

### IAP 协议：全部大端（BE）
```c
// 大端写入
data[0] = (value >> 24) & 0xFF;  // MSB
data[1] = (value >> 16) & 0xFF;
data[2] = (value >>  8) & 0xFF;
data[3] = (value >>  0) & 0xFF;  // LSB

// 大端读取
value = (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3];
```

### IMU 协议：小端（LE）
```c
// 姿态数据(来自 App)
yaw   = (int16_t)(data[0] | (data[1] << 8));    // LE16
pitch = (int16_t)(data[2] | (data[3] << 8));
roll  = (int16_t)(data[4] | (data[5] << 8));
body_acc = (int16_t)(data[6] | (data[7] << 8));
```

**调试要点：**
1. IAP 帧用 BE32，IMU 姿态用 LE16 → 同一项目内混用两种字节序
2. 错误表现为 ERASE 大小异常（如 1024 → 1073741824）

## 七、FreeRTOS 任务优先级

### CAN TX 饥饿
当 `can_analyze_task` 和 `can_tx_task` **同优先级**时，can_an 不 yield 导致 can_tx 被饿死：
```c
#define CAN_RX_TASK_PRIORITY      (tskIDLE_PRIORITY + 5)  // 最高,快速排空 FIFO
#define CAN_TX_TASK_PRIORITY      (tskIDLE_PRIORITY + 5)  // 必须 >= can_an
#define CAN_ANALYZE_TASK_PRIORITY (tskIDLE_PRIORITY + 4)  // 解析最慢
```

## 八、双 JLink 并行调试

```bash
# 405 侧: JLink SN 69409970
JLink.exe -USB 69409970 -Device STM32F405RG -Si SWD -Speed 4000

# 302 侧: JLink SN 69402950
JLink.exe -USB 69402950 -Device STM32F302xC -Si SWD -Speed 4000
```

### 运行时探测 CAN 寄存器
```jlink
mem32 0x40006400 4    # MCR, MSR, TSR, ?
mem32 0x40006418 1    # ESR → TEC/REC/LEC
mem32 0x4000641C 1    # BTR → 验证波特率
mem32 0xE000ED08 1    # VTOR → 确认 App 是否在运行
mem32 0x08008000 1    # IAP 标志位
```

## 九、常见故障速查

| 现象 | 可能原因 | 排查方向 |
|------|---------|---------|
| 升级进度卡住、rx 不增长 | CAN FIFO 溢出 | 加帧间 osDelay(2ms) |
| rx>0 但 hit=0 | ExtId 地址不匹配 | 检查 HOST/DEVICE 定义 |
| ERASE 成功但后续全失败 | 字节序错误 | 确认 BE vs LE |
| IAP 后 App CAN 不通 | CAN 外设状态残留 | CAN init 必须在 MX_CAN_Init 中,不在 FreeRTOS 任务中 |
| 重新上电后不进 App | IAP_FLAG 未清除 | App 启动时擦除 0x08008000 标志区 |
| 升级完提示"busy" | 上位机还在 wait_final_ack | 等 3-5 秒超时自动转 success |
| TEC=255 | CAN 发送全失败 | 检查 CAN 初始化位置、波特率、物理连接 |
| JLink 烧录后不工作 | IAP_FLAG 残留 | JLink 手动清除: `w4 0x08008000 0xFFFFFFFF` |

## 十、协议适配检查清单

适配新项目的 CAN IAP 协议时,按此顺序逐项验证：

- [ ] ExtId 格式: `(PNG << 16)|(Target << 8)|Source` ? 还是 StdId?
- [ ] TARGET_ADDR / HOST_NODE_ID 值
- [ ] Boot 自身 MY_CAN_ID / DEVICE_NODE_ID 值
- [ ] IAP 命令 PNG 值: ERASE=0x400? WRITE_INFO=0x401? DATA_BASE=0x420?
- [ ] Payload 字节序: BE32 还是 LE32?
- [ ] SUCCESS/FAIL 应答 DLC: 0 还是 8?
- [ ] EXECUTE 是否回复?
- [ ] CRC16 初值: 0x0000 还是 0xFFFF?
- [ ] IAP 标志位地址和魔数值
- [ ] App 启动时是否清除 IAP 标志?
- [ ] CAN 初始化在 MX_CAN_Init 中还是 FreeRTOS 任务中?
- [ ] 数据帧间是否需要延时?
