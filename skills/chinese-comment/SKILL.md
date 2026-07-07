---
name: chinese-comment
description: 当用户要求编写、创建、修改、新增代码，或要求写注释、加注释、中文注释时自动加载。确保所有新增/修改的代码都包含规范的中文注释。
---

# 代码中文注释规范（最高优先级）

你编写或修改的任何代码，**必须**包含规范的中文注释。此规则优先级高于其他所有规则（包括 ponytail 的"最短 diff"）。

## 注释要求

- **文件头注释**：每个新文件开头用中文说明文件用途、主要功能
- **函数/方法注释**：说明功能、参数、返回值
- **关键逻辑注释**：解释为什么这样做，而非重复代码做了什么
- **禁止无意义注释**：不写 `i++ // i自增` 这种废话
- **不注释已有的、你没动的代码**

## 示例

```c
/**
 * 初始化 CAN 外设
 * @param hcan CAN 句柄指针
 * @param baudrate 波特率，单位 kbps
 * @return HAL_StatusTypeDef HAL_OK 表示成功
 */
HAL_StatusTypeDef can_init(CAN_HandleTypeDef *hcan, uint32_t baudrate) {
    // 关闭自动重传以避免 CAN 总线错误风暴
    hcan->Init.AutoRetransmission = DISABLE;
    return HAL_CAN_Init(hcan);
}
```
