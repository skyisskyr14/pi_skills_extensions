# 嘉立创 EDA 元器件 UUID 数据库管理

## 数据库文件

`D:/skyissky/projects/git/jlc-mcp/components-db.json`

## 使用方式

### 记录新元件

当用户在 EDA 原理图中放置了新元件后：

1. 调用 `sch_get_state` 读取原理图状态
2. 从返回的 components 中提取 `designator`、`name`、`component.libraryUuid`、`component.uuid`
3. 用 `read` 工具读取 `components-db.json`
4. 将新元件添加到 `components` 字段（key 为元件型号/名称，value 为 uuid）
5. 用 `write` 工具写回文件

### 查询元件 UUID

画原理图前，先读取 `components-db.json`，查找需要的元件 UUID。如果找不到，让用户在 EDA 中搜索放置，然后记录。

### 放置元件

使用 `sch_create_component` 工具，参数：
- `component.libraryUuid`: 从数据库的 `libraryUuid` 字段获取
- `component.uuid`: 从数据库的 `components` 字段查找
- `x`, `y`: 坐标
- `rotation`: 旋转角度（可选）

## 数据库格式

```json
{
  "libraryUuid": "库UUID",
  "components": {
    "元件型号": "元件UUID",
    ...
  },
  "updated": "更新日期"
}
```
