# dsh-codeui (Code UI)

> DeepSeek Harness 代码审阅工作台：每一轮对话结束都会生成一份可点击的 Review 卡片；右侧 Review 面板按轮查看文件差异，右侧轮次轨道负责对话跳转，像看 GitHub PR 一样审阅 AI 修改的代码。
>
> A code-review workbench for DeepSeek Harness: every turn ends with a clickable Review card, the right-side Review panel shows per-turn diffs, and the turn rail jumps back to the exact conversation — review AI code changes like a GitHub PR.

[中文](#中文) | [English](#english)

---

<a id="中文"></a>

## 中文

### 项目简介

`dsh-codeui`（内部名 `codeui`）是 DeepSeek Harness 的 Cordis UI 插件，当前以**静态 npm 包**为主要安装与维护形态。它不重做主对话窗口，而是补齐代码审阅场景的完整链路：

- **工作区资源管理器**：文件树 + 只读 Git 状态标记（M / A / D / R / U / !）、分支、领先/落后信息。
- **右侧 Review 面板**：默认单栏（统一）diff，双栏保留；支持改前 / 改后 / 当前三种视图、累计 patch 导出；面板左边界可拖动，宽度范围 20%–60%（默认 42%），右边界紧贴窗口右缘。
- **每轮结尾 Review 卡片**：位于每轮产物列表下方，显示 `Edited N files`、总增删行数、文件路径和每个文件的 `+/-`；默认展开两行文件，可悬停滚动查看全部；点击文件直接打开对应 Review 面板。
- **右侧轮次轨道**：细/粗横线交替表示轮次；悬停提问行弹出该轮文件详情卡（轮次、状态、文件详情、文件数量、任务时长，默认显示 3 个文件并带滚动条）；点击文件打开 Review 面板；点击轮次则跳转对话。对话跳转只由轨道触发，Review 面板中的轮次选择不会滚动对话。

### 功能亮点

- 捕获 `write`、`edit`、`str_replace_editor`（`create` / `str_replace` / `insert`）。
- Host 会扫描完整持久化会话日志，为**未加载的历史轮次**也提供文件修改详情。
- 点击未加载轮次时自动向上滚动对话、自动点击“加载更早”，直到目标轮次进入当前窗口后定位高亮。
- Review 面板与轨道共享全量轮次历史；轮次选择器始终显示所有轮次。
- 设置项持久化到 `localStorage`：资源管理器、Review 面板、Git 标记、插件语言。
- 全部 Git 操作只读：不写入、不提交、不切换分支。

### 安装（静态插件，推荐）

本仓库按 npm 包规范组织，包名为 `dsh-codeui`。以下命令直接从 GitHub 安装，**无需先注册或发布 npm**；只有希望用户执行 `npm install dsh-codeui`（短名安装）时才需要发布到 npm registry。

#### 第 1 步：安装包

```bash
dsh plugin --profile web add github:YLingHao/dsh-codeui
```

或手动安装：

```bash
cd "$DSH_HOME/profiles/web"
pnpm add github:YLingHao/dsh-codeui
```

#### 第 2 步：注册插件（二选一）

**方式 A：作为 bundle 注册**（本仓库自带 `cordis.patch.yml`）

编辑 `$DSH_HOME/profiles/web/package.json`，在 `dsh.profile.bundles` 末尾加入 `dsh-codeui`：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-codeui"
      ]
    }
  }
}
```

**方式 B：写入 patch 层**

编辑 `$DSH_HOME/profiles/web/cordis.patch.yml`（或全局 `$DSH_HOME/cordis.patch.yml`）：

```yaml
- insert:
    - id: codeui
      name: 'dsh-codeui'
```

#### 第 3 步：重启

```bash
dsh web
```

浏览器打开后建议 Ctrl+F5 强刷。已安装 `dsh-market` 的用户，可在 GitHub 仓库添加 `dsh-plugin` Topic 后从市场搜索安装。

### 安装（动态 Cordis 插件）

动态安装保留为兼容方式，适合不能使用 npm 包的环境：

1. 在 DeepSeek Harness 中使用 `cordis_define` 新建插件：`kind: "new"`，`idPrefix: "codeui"`。
2. `code.host` 填入 `host.js`，`code.client` 填入 `client.js`。
3. 在界面批准运行（单勾 = 本次版本，双勾 = 未来版本自动放行）。

> 注意：本项目当前以静态插件为主要维护线；动态版保留可用，但最新 UI 细节以静态版 `lib/` 为准。

### 使用

- 左下角 📁 切换资源管理器。
- 每轮对话结束后，在产物列表下方查看 Review 卡片；点击文件或 `Review` 打开右侧面板。
- Review 面板默认统一视图；“统一”按钮在分段控件最左侧；切换轮次只更新面板，不跳转对话。
- 右侧轨道悬停提问行查看文件详情卡；点击轮次跳转对话。
- `设置 → Code UI`：资源管理器、Review 面板、Git 标记、插件语言；设置自动保存。

### Git 权限说明

```bash
git rev-parse --show-toplevel
git -c core.quotepath=false -c diff.renames=false status --porcelain=v1 -z --branch
git -c core.quotepath=false diff --no-ext-diff --unified=3 HEAD -- .
```

Git 不可用时自动降级：隐藏 Git 标记，patch 导出显示提示。

### 文件结构

```
dsh-codeui/
├── package.json        # npm 包清单（dsh.client / dsh.bundle.patch）
├── cordis.patch.yml    # bundle 自注册 patch
├── index.js            # 动态插件包清单
├── host.js             # 动态 Host 半边（function body）
├── client.js           # 动态 Client 半边（function body）
├── lib/
│   ├── index.js        # 静态 Host：/codeui/api/* + 全量轮次/文件历史
│   └── client.js       # 静态 Client bundle
├── README.md
└── LICENSE
```

### 设计边界

- 主对话窗口、工具调用与批准日志由 harness 提供，插件不重复实现。
- 每轮快照优先由会话日志中的编辑工具参数重建；Host 的全量历史统计保证未加载轮次也有文件详情。
- 全量 Git 快照、代码标记/留言、AI 辅助审查属于后续计划。

---

<a id="english"></a>

## English

### Introduction

`dsh-codeui` (plugin id `codeui`) is a Cordis UI plugin for DeepSeek Harness, maintained primarily as a static npm package. It keeps the native chat untouched and adds a complete code-review loop:

- **Workspace explorer** — file tree with read-only Git badges, branch and ahead/behind info.
- **Right-side Review panel** — unified diff by default with split view available, `before / after / current` modes, cumulative patch export, and a draggable left edge (20%–60%, default 42%) flush with the window's right edge.
- **Turn-end Review card** — rendered under each turn's produced-files list with `Edited N files`, total `+/-` lines, file paths and per-file stats; scroll inside the card to browse all files, click one to open the Review panel.
- **Right turn rail** — alternating thin/thick bars per turn; hovering a question row opens a file-detail card (turn, status, files, file count, duration, with a visible scrollbar); clicking a turn jumps the conversation. Only the rail jumps the conversation — the Review panel's turn selector never scrolls chat.

### Highlights

- Captures `write`, `edit`, and `str_replace_editor` (`create` / `str_replace` / `insert`).
- The host scans the full persisted session log, so even unloaded older turns have file-change details.
- Clicking an unloaded turn auto-scrolls chat, auto-clicks “Load earlier”, then jumps and highlights the target question.
- Full turn history is shared between the Review panel and the rail.
- Settings persist in `localStorage`: explorer, Review panel, Git badges, and language.
- Git access is strictly read-only.

### Install (static package, recommended)

This repository is organized as an npm package named `dsh-codeui`. The commands below install it straight from GitHub — no npm publication is required. Publishing is only needed for the short-name `npm install dsh-codeui`.

#### Step 1: install

```bash
dsh plugin --profile web add github:YLingHao/dsh-codeui
```

Or:

```bash
cd "$DSH_HOME/profiles/web"
pnpm add github:YLingHao/dsh-codeui
```

#### Step 2: register (choose one)

**Option A: bundle** (uses this repo's `cordis.patch.yml`)

Add `dsh-codeui` to `dsh.profile.bundles` in `$DSH_HOME/profiles/web/package.json`:

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-codeui"
      ]
    }
  }
}
```

**Option B: patch layer**

Edit `$DSH_HOME/profiles/web/cordis.patch.yml` (or the global `$DSH_HOME/cordis.patch.yml`):

```yaml
- insert:
    - id: codeui
      name: 'dsh-codeui'
```

#### Step 3: restart

```bash
dsh web
```

Hard-refresh the browser (Ctrl+F5). With `dsh-market` installed, add the GitHub topic `dsh-plugin` for marketplace discovery.

### Install (dynamic Cordis plugin)

Kept for compatibility:

1. In DeepSeek Harness, create a plugin with `cordis_define`: `kind: "new"`, `idPrefix: "codeui"`.
2. Set `code.host` to `host.js` and `code.client` to `client.js`.
3. Approve the run in the UI.

> The static package is the primary maintenance line; the dynamic distribution remains usable but may lag behind the latest `lib/` UI.

### Usage

- Toggle the explorer with the 📁 button.
- After each turn, use the Review card below the produced-files list; click a file or `Review` to open the right panel.
- The Review panel defaults to unified view (“Unified” is the first segmented button); switching turns updates only the panel.
- Hover a rail question row to inspect that turn's files; click the turn to jump the conversation.
- `Settings → Code UI`: explorer, Review panel, Git badges, and language. Changes are saved automatically.

### Git commands (read-only)

```bash
git rev-parse --show-toplevel
git -c core.quotepath=false -c diff.renames=false status --porcelain=v1 -z --branch
git -c core.quotepath=false diff --no-ext-diff --unified=3 HEAD -- .
```

When Git is unavailable the plugin degrades silently.

### Repository layout

```
dsh-codeui/
├── package.json        # npm manifest (dsh.client / dsh.bundle.patch)
├── cordis.patch.yml    # bundle self-registration patch
├── index.js            # dynamic plugin package manifest
├── host.js             # dynamic host half (function body)
├── client.js           # dynamic client half (function body)
├── lib/
│   ├── index.js        # static host: /codeui/api/* + full turn/file history
│   └── client.js       # static client bundle
├── README.md
└── LICENSE
```

### Scope

The native conversation, tool-call log, and approval UI stay in the harness. Turn snapshots are reconstructed from edit tool parameters, with host-side full-history summaries for unloaded turns. Full Git-level snapshots, inline comments, and AI-assisted review are future work.

## License

MIT
