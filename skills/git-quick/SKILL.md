---
name: git-quick
description: "Git operations: branch create/switch, stage+commit, push to named remote. Trigger: git quick, quick commit, 提交并推送, or /skill:git-quick branch|commit|push"
---

# Git Quick

两种使用方式：对话触发词 或 `/skill:git-quick` 命令。

---

## 对话触发（适合一次走完 add→commit→push）

直接说以下任意一句：

- **"git quick"**
- **"quick commit"**
- **"提交并推送"**

流程：`git status` → 确认改动 → `git add -u` → 用户提供 commit message → `git commit` → `git remote -v` 列出 → 用户指定 remote → `git push`。

---

## `/skill:git-quick` 命令（适合单步操作）

### branch — 创建新分支并切换

```
/skill:git-quick branch <分支名>
```

执行：`git checkout -b <分支名>`

### commit — 暂存所有修改并提交

```
/skill:git-quick commit <提交信息>
```

执行：`git add -u` → `git commit -m "<提交信息>"`  
新增 untracked 源码文件先 `git add`，编译产物/二进制跳过。

### push — 推送到指定远程仓库

```
/skill:git-quick push <remote名称>
```

执行：`git remote -v` 列出所有 → `git push -u <指定remote> <当前分支>`  
远程没有该分支则自动创建并设置 upstream。

**推送重试机制**：`git push` 失败后自动重试，最多 3 次，每次间隔 2 秒。3 次全部失败后才告知用户网络不通。

---

## 注意事项

- 不 rebase，不 merge，不强制推送
- 必须用户指定 remote，绝不自动推所有
- push 最多重试 3 次，失败后提示用户检查网络/代理
