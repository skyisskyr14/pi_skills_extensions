---
name: project-sessions
description: "将 pi session 从全局目录迁移到项目本地，跟随 git 共享。触发：项目session、session本地化、初始化session、同步session、/skill:project-sessions init|sync"
---

# Project Sessions

让 pi 的对话 session 跟随项目一起存入 git 仓库，团队成员拉取后用 `/resume` 即可看到完整对话历史（含 fork 父子层级关系）。

两个子命令：

---

## `/skill:project-sessions init` — 初始化项目 session 目录

在项目根目录创建 `.pi/settings.json`（或合并已有），设置 `sessionDir`，创建 `.pi/sessions/` 目录，并确保 `.gitignore` 不会排除它。

操作步骤：

1. 确认当前工作目录（cwd）是项目根目录——如果不是，先向用户确认
2. 若 `.pi/settings.json` 已存在，读取内容；否则新建空 `{}`
3. **关键**：合并 `"sessionDir": "sessions"` 进去（见下方注意事项）
4. 写入 `.pi/settings.json`
5. 检查 `.gitignore`：若存在 `.pi/` 或 `.pi` 规则，追加 `!.pi/sessions/` 将其排除；若没有 `.gitignore` 且用户确认需要，则新建
6. 创建 `.pi/sessions/` 目录
7. 提示用户：之后该项目的所有 pi 会话会自动存入 `.pi/sessions/`，可以 `git add` 进仓库

### ⚠️ sessionDir 路径注意事项

`.pi/settings.json` 中的路径**相对于 `.pi/` 目录解析**，所以：

- ✅ 正确：`"sessionDir": "sessions"` → 解析为 `.pi/sessions/`
- ❌ 错误：`"sessionDir": ".pi/sessions"` → 解析为 `.pi/.pi/sessions/`（路径不存在，导致 `/resume` 无法显示层级关系）

---

## `/skill:project-sessions sync` — 同步全局 session 到本地项目

把 `~/.pi/agent/sessions/` 下属于当前 cwd 的旧 session 文件复制到项目的 `.pi/sessions/`，并**自动修复所有 fork session 的 parentSession 路径和清理残留**。

操作步骤：

1. 将当前 cwd 的绝对路径按 pi 的编码规则转换：
   - Windows：盘符冒号去掉，反斜杠 `\` 替换为 `-`，首尾加 `--`
   - 例如 `D:\projects\foo` → `--D--projects-foo--`
   - Linux/macOS：`/` 替换为 `-`，首尾加 `--`
2. 检查 `~/.pi/agent/sessions/<encoded-cwd>/` 是否存在；不存在则告知用户无旧 session
3. 确保 `.pi/sessions/` 目录存在（没 init 过就先执行 init）
4. 复制该目录下所有 `.jsonl` 文件到 `.pi/sessions/`
5. **⚠️ 修复 parentSession 路径**（这是 `/resume` 显示层级关系的关键）：
   - 扫描所有复制过来的 `.jsonl` 文件的第一行
   - 找到 `"parentSession"` 字段——它指向的是原本的全局路径
   - 用项目本地 `.pi/sessions/` 的绝对路径替换旧的全局路径
   - 示例：`C:\\Users\\xxx\\.pi\\agent\\sessions\\--项目--\\父session.jsonl`
     → `D:\\项目\\.pi\\sessions\\父session.jsonl`
   - 具体操作见下方"parentSession 修复脚本"
6. **清理全局残留**：删除 `~/.pi/agent/sessions/<encoded-cwd>/` 目录，避免 pi 启动时从两个源读到重复数据
7. 告知用户操作完成，提醒**重启 pi** 后 `/resume` 即可看到完整层级

### parentSession 修复脚本

用 Python 处理（跨平台，处理 JSON 转义准确）：

```python
import os, json, shutil

sessions_dir = '.pi/sessions'
# 注意：用 os.path.abspath 获取绝对路径
abs_sessions = os.path.abspath(sessions_dir)

for fname in os.listdir(sessions_dir):
    if not fname.endswith('.jsonl'):
        continue
    fpath = os.path.join(sessions_dir, fname)
    with open(fpath, 'r', encoding='utf-8') as f:
        lines = f.readlines()
    if not lines or '"parentSession"' not in lines[0]:
        continue

    data = json.loads(lines[0])
    old_ps = data.get('parentSession', '')
    if not old_ps:
        continue

    parent_fname = os.path.basename(old_ps)
    new_ps = os.path.join(abs_sessions, parent_fname).replace('\\', '\\\\')

    # 替换旧路径（注意 JSON 中反斜杠被转义为 \\，匹配时也要用 \\\\）
    lines[0] = lines[0].replace(old_ps.replace('\\', '\\\\'), new_ps)
    with open(fpath, 'w', encoding='utf-8') as f:
        f.writelines(lines)
    print(f'fixed: {fname}')

# 清理全局残留
old_global = os.path.expanduser(
    '~/.pi/agent/sessions/--D--your-project--'
)
if os.path.exists(old_global):
    shutil.rmtree(old_global)
    print('cleaned global dir')
```

### 原理说明

pi 的 fork session 文件第一行 JSON 包含 `"parentSession"` 字段，指向父 session 文件的**绝对路径**。当 session 从全局目录搬到项目本地后，这个路径仍然指向旧的全局位置。pi 启动时按 `sessionDir` 找到 session 文件，但通过 `parentSession` 找父 session 时去了旧路径（可能已不存在），导致 `/resume` 中 fork 层级断裂。

修复 `parentSession` 指向新位置后，pi 就能正确重建完整的 fork 树。

---

## 对话触发词

自然语言中这些词会触发对应功能：

- **"初始化项目session"**、"session本地化"、"项目session存储" → 执行 init
- **"同步全局session"**、"把session迁到项目"、"迁移session到本地" → 执行 sync（含 parentSession 修复 + 全局清理）
- **"项目session初始化并同步"** → 先 init 再 sync
