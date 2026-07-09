---
name: project-manager
description: >
  通过飞书管理 pi 项目路径。支持添加/删除/查看项目目录，扫描目录下所有 pi 项目。
  触发词：projects、项目列表、add-path、remove-path。
---

# 项目路径管理

## 触发条件

飞书发送 `projects`、`add-path`、`remove-path` 时触发，由 feishu-server.ts 处理。

## 存储位置

`~/.pi/agent/project-paths.json` — JSON 数组，存所有项目根路径。

格式：
```json
["D:/skyissky/Company/core-self", "D:/skyissky/Company/core-git"]
```

## 飞书命令

| 命令 | 效果 |
|------|------|
| `projects` | 列出所有路径及其下的 pi 项目（按路径分组） |
| `add-path D:/path` | 添加项目根路径 |
| `remove-path D:/path` | 移除项目根路径 |

## 实现要点

- 扫描目录时检查子目录是否有 `.pi` 文件夹来判断是否为 pi 项目
- 不同路径下可能有重名项目，必须按路径分组显示
- 配置文件不存在时初始化为空数组
