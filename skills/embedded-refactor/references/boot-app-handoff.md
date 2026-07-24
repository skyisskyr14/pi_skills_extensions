# Boot/App 交接契约

将 Boot 到 App 的跳转视为 API 调用：Boot 是调用者，App 是被调用者。两端必须对
入口地址、内存、时钟、中断、外设状态和升级标志有一致解释。

## 必须冻结的项目参数

| 项目 | 要记录的值/行为 |
| --- | --- |
| Flash 布局 | Boot、App、参数/标志、升级缓存的起止地址和擦除粒度 |
| 向量表 | App 向量表地址、VTOR 设置者、是否需要对齐 |
| 栈与启动 | App 初始 MSP、Reset_Handler、`.data` 复制、`.bss` 清零 |
| 时钟 | HSE/HSI、PLL、AHB/APB 分频、SysTick 和外设实际时钟 |
| 中断 | NVIC 使能/优先级、PendSV/SysTick 所有权、未决中断清理策略 |
| 外设 | Boot 保留的 GPIO、电源通道、CAN/UART/DMA/定时器寄存器状态 |
| IAP | 进入标志、擦除时机、失败升级、无效 App、跳 App 后的确认流程 |
| RAM | SRAM/CCMRAM 使用、NOLOAD 段、Boot 留下的数据是否允许 App 读取 |

## 跳转前检查

1. App 初始栈指针必须落在合法 RAM 范围。
2. App Reset_Handler 必须落在合法 Flash App 分区。
3. 禁用或明确处理 Boot 使用过的 IRQ、DMA 与 SysTick，避免 App 接管时收到旧事件。
4. 设置 VTOR 到 App 向量表，并设置 MSP 后再跳转 Reset_Handler。
5. 不要无差别 `RCC_DeInit()`、GPIO 全复位或全局中断屏蔽；先证明旧 Boot 的对应行为。

## App 首次初始化检查

1. 不假设所有寄存器处于芯片复位值；旧 Boot 可能保留外设状态。
2. 对每个 HAL 初始化失败，记录外设寄存器和 RCC 时钟状态，不要只重试。
3. 若 App 的 GPIO 初始化会改变机器当前电源状态，拆分为“必须立即配置”和“由 PM
   接管后配置”两组。
4. App 清除 IAP 标志前，确认该时机与升级确认协议一致；过早清除可能掩盖失败，过晚
   清除会让下一次启动停在 Boot。

## 最小验证场景

- 正常上电：Boot 跳 App，App 不复位、不丢电源通道。
- IAP 后重启：进入/退出升级模式符合协议，App 能确认成功。
- 看门狗复位：保留或恢复的电源状态符合旧工程。
- 无效 App：Boot 不跳到非法地址，并保持可升级能力。
- 调试连接：非侵入观察不改变业务连接；Halt/Reset 的影响要单独标注。
