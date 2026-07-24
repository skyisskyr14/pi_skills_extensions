---
name: git-quick
description: "Git operations: branch create/switch, stage+commit, push to named remote. Trigger: git quick, quick commit, 提交并推送, or /skill:git-quick branch|commit|push"
---

# Git Quick

两种使用方式：对话触发词 或 `/skill:git-quick` 命令。

**🚫 核心规则：绝不执行任何 git 命令。只展示命令和说明，由用户自己亲自执行。**

---

## 对话触发（适合一次走完 add→commit→push）

直接说以下任意一句：

- **"git quick"**
- **"quick commit"**
- **"提交并推送"**

流程：`git status` → 确认改动 → 展示 `git add` 命令 → 用户提供 commit message → 展示 `git commit` 命令 → 用户确认已提交 → `git remote -v` 列出 → 用户指定 remote → 展示 `git push` 命令。

---

## `/skill:git-quick` 命令（适合单步操作）

### branch — 创建新分支并切换

```
/skill:git-quick branch <分支名>
```

展示命令：`git checkout -b <分支名>`

### commit — 暂存修改，展示 commit 命令

```
/skill:git-quick commit <提交信息>
```

展示命令：`git add -u` 或 `git add -A`，然后 `git commit -m "<提交信息>"`  

### push — 推送到指定远程仓库

```
/skill:git-quick push <remote名称>
```

展示命令：`git push -u <指定remote> <当前分支>`

---

## 注意事项

- 不 rebase，不 merge，不强制推送
- 所有 git 命令仅展示，由用户自己执行
- 必须用户指定 remote，绝不代推
