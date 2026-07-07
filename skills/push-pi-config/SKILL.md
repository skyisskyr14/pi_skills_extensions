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
git add -A
git commit -m "更新 skills/extensions: <简要描述变更>"
git push
```

如果 push 失败（如无权限、远程不存在），提示用户检查仓库地址或权限。

## 注意事项

- `sessions/`、`auth.json`、`settings.json`、`trust.json` 已在 `.gitignore` 中排除，不会被推送
- 换电脑时用 `pi install git:<仓库地址>` 一键装回所有 skills 和 extensions
- 新增 skill 只需在 `~/.pi/agent/skills/` 下创建目录和 SKILL.md，推送即可
