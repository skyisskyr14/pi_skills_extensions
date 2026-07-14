---
name: push-pi-config
description: >
  将全局 pi agent 的 skills、extensions、配置文件推送到 GitHub 远程仓库。
  自动检测是否已初始化 git，未初始化则引导用户配置远程仓库地址。
  触发词：推送skill、同步skill、备份pi配置、push skill、上传扩展。
---

# 推送 Pi 全局配置到远程仓库

## 触发条件

用户想把 `~/.pi/agent/` 下的 skills、extensions、配置文件推送到远程 git 仓库备份或共享。

## 操作流程

### 步骤 1：检查是否已初始化

```bash
ls ~/.pi/agent/.git
```

### 步骤 2A：未初始化（首次配置）

如果 `.git` 目录不存在，询问用户远程仓库地址（如 `https://github.com/用户名/仓库名.git`），然后：

```bash
cd ~/.pi/agent

# 创建 package.json（pi package 声明）
cat > package.json << 'EOF'
{
  "name": "pi-toolbox",
  "version": "1.0.0",
  "description": "我的 pi agent skills 和 extensions 集合",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"]
  }
}
EOF

# 创建 .gitignore（排除私密/大文件）
cat > .gitignore << 'EOF'
sessions/
auth.json
settings.json
trust.json
bin/
npm/
git/
node_modules/
.DS_Store
Thumbs.db
EOF

# 初始化 git 并推送
git init
git remote add origin <用户提供的仓库地址>
git add -A
git commit -m "初始化 pi skills 和 extensions 集合"
git push -u origin master
```

### 步骤 2B：已初始化（日常更新）

```bash
cd ~/.pi/agent
# 可选：同步当前安装的官方包到 pi-install.sh（AI 自动执行）
git add -A
git commit -m "更新 skills/extensions: <简要描述变更>"
git push
```

如果 push 失败（如无权限、远程不存在），提示用户检查仓库地址或权限。

## 额外逻辑（AI 自动执行）

在 `git add -A` 之前，AI 应自动完成以下步骤：

### 1. 同步官方包依赖清单

读取 `settings.json` 中的 `packages` 列表，与 `pi-install.sh` 对比，确保一致性：

- 遍历 `settings.json` 的 `packages` 数组
- 跳过以 `git:github.com/用户名/` 开头的条目（一般是你自己的仓库，不属于第三方依赖）
- 对每个剩余条目，检查 `pi-install.sh` 中是否已有对应的 `pi install` 命令
- 缺少的则追加到 `pi-install.sh` 末尾
- 如果 `pi-install.sh` 中有命令对应的包已从 `settings.json` 中移除，则删除该行
- 如果 `pi-install.sh` 不存在则新建

pi-install.sh 格式示例：
```bash
#!/bin/bash
# pi-install.sh — 安装所有官方/第三方 pi 插件
# 由 push-pi-config skill 自动维护,请勿手动编辑

pi install npm:pi-subagents
pi install npm:pi-todo
pi install git:github.com/DietrichGebert/ponytail@4.8.4
pi install git:github.com/obra/superpowers
```

### 2. 确保新文件被跟踪

如果新建了 `pi-install.sh` 或其他文件，执行 `git add pi-install.sh` 确保被纳入版本控制。

## 注意事项

- `sessions/`、`auth.json`、`settings.json`、`trust.json` 已在 `.gitignore` 中排除，不会被推送
- 换电脑时：克隆仓库 → `cd ~/.pi/agent && bash pi-install.sh` 一键装回所有包
- 新增 skill 只需在 `~/.pi/agent/skills/` 下创建目录和 SKILL.md，推送即可
