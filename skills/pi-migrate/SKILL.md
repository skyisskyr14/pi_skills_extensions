---
name: pi-migrate
description: >
  将 pi agent 的会话历史（包括所有分支）从一个项目目录迁移到另一个项目目录。
  处理会话文件复制、parentSession 引用修复、cwd 更新。
  触发词：项目迁移、迁移会话、搬项目、换目录、pi 会话搬家。
---

# Pi 项目会话迁移

## 触发条件

用户想把 pi agent 的会话历史从旧项目目录搬到新项目目录，或项目文件夹移动后会话不认。

## 迁移步骤

### 1. 确认两个路径

```
旧项目:  /path/to/old-project
新项目:  /path/to/new-project
```

### 2. 定位 sessions 目录

sessions 路径格式：`~/.pi/agent/sessions/--<path>--/`，其中 `<path>` 是项目绝对路径，`/` 替换为 `-`，`:` 替换为 `-`。

```bash
ls ~/.pi/agent/sessions/
```

找到旧项目对应的目录名。

### 3. 复制所有会话文件

```bash
cp ~/.pi/agent/sessions/--旧项目目录名--/*.jsonl ~/.pi/agent/sessions/--新项目目录名--/
```

如果新目录不存在，先在新项目里启动一次 pi 生成。

### 4. 修复 parentSession 引用

旧文件 header 中的 `parentSession` 指向旧目录路径，`/resume` 无法渲染层级。

```bash
cd ~/.pi/agent/sessions/--新项目目录名--/
for f in *.jsonl; do
  sed -i 's|旧项目目录名|新项目目录名|g' "$f"
done
```

### 5. 修复 cwd 字段

header 中的 `cwd` 也指向旧路径（JSON 中双反斜杠 `\\`）：

```bash
# 单引号内 \\\\ 匹配 JSON 中的 \\
sed -i 's|旧路径段\\\\旧路径段|新路径段|g' *.jsonl
```

例如：
```bash
sed -i 's|Motor_DW-J4340-2EC\\\\IAP_DEMO|F302_IMU_Driver_PC|g' *.jsonl
```

### 6. 验证

```bash
head -1 任意文件.jsonl
```

检查 `cwd` 和 `parentSession` 是否已改为新路径。

### 7. 启动

```bash
cd 新项目
pi -r
```

`/resume` 应该显示树状层级。

## 注意事项

- 会话文件不依赖项目文件，删旧目录不影响会话
- 消息正文中可能残留旧路径字符串（文件操作记录），不影响使用，可忽略
- 如果新目录的 sessions 目录还不存在，先在新项目启动一次 pi 自动生成
- Windows 路径中反斜杠在 JSON 里是 `\\`，sed 替换时注意转义
