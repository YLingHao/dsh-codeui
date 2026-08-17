# dsh-codeui (Code UI)

> DeepSeek Harness 代码审阅工作台：像看 GitHub PR 一样，按轮查看 AI 改过哪些文件、具体改了什么，并从右侧轮次轨道一键跳回对应的对话现场。
>
> A code-review workbench for DeepSeek Harness: inspect every file an agent changed in each turn with a side-by-side diff, and jump from an always-on turn rail straight back to that turn in the conversation.

[中文](#中文) | [English](#english)

---

<a id="中文"></a>

## 中文

### 项目简介

`dsh-codeui`（内部名 `codeui`）是 DeepSeek Harness 的 Cordis UI 插件。它不重做主对话窗口，而是补齐代码审阅场景最需要的三块：

- **工作区资源管理器**：文件树 + 只读 Git 状态标记（M / A / D / R / U / !）、分支和领先/落后信息。
- **按轮切换的代码差异面板**：列出本轮修改的文件，支持分栏/统一 diff，可查看每个文件在“改前 / 改后 / 当前”的完整内容，并支持只读累计 `git diff HEAD` 和导出 patch。
- **右侧常驻轮次跳转轨道**：固定显示 10 个轮次点；悬停查看该轮用户提问；点击任意轮次会跳转到对应提问行。目标轮次尚未加载时，插件会自动向上滚动对话、自动点击“加载更早”，直到目标轮次进入当前会话窗口后再定位高亮。

### 功能亮点

- 支持 `write`、`edit` 和 `str_replace_editor`（`create` / `str_replace` / `insert`）的修改捕获。
- Diff 面板和轨道共享全量轮次历史，轮次选择器始终显示所有轮次。
- 双栏 diff 分界线可拖动（5%–95%），大文件自动降级为前缀/后缀块算法。
- 对话右移、资源管理器、Git 标记均可独立开关。
- 插件语言支持“跟随系统 / 简体中文 / English”。
- 全部 Git 操作均为只读，不写入、不提交、不切换分支。

### 安装（静态插件，推荐）

本仓库按 npm 包规范组织，包名为 `dsh-codeui`。下面的安装命令直接从 GitHub 安装，**不需要先注册或发布到 npm registry**；只有希望用户直接执行 `npm install dsh-codeui`（短名安装）时，才需要把它发布到 npm。

#### 第 1 步：安装包

```bash
dsh plugin --profile web add github:YLingHao/dsh-codeui
```

也可以手动安装：

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

**方式 B：写入 patch 层**（适合不想改 bundles 的现有 profile）

编辑 `$DSH_HOME/profiles/web/cordis.patch.yml`（或全局 `$DSH_HOME/cordis.patch.yml`），加入：

```yaml
- insert:
    - id: codeui
      name: 'dsh-codeui'
```

#### 第 3 步：重启

```bash
dsh web
```

浏览器打开后建议 Ctrl+F5 强制刷新。若已安装 `dsh-market`，也可以直接在市场中搜索安装；本仓库的 GitHub Topics 建议添加 `dsh-plugin`。

### 安装（动态 Cordis 插件）

旧版动态安装方式仍然可用，适合不能使用 npm 包的场景：

1. 在 DeepSeek Harness 中使用 `cordis_define` 新建插件：`kind: "new"`，`idPrefix: "codeui"`。
2. `code.host` 填入 `host.js` 的内容，`code.client` 填入 `client.js` 的内容。
3. 在界面批准运行（单勾 = 本次版本，双勾 = 未来版本自动放行）。

`host.js` / `client.js` 与 `lib/` 下的静态版本功能同步；静态包是推荐安装方式。

### 使用

- 左下角 📁 按钮切换资源管理器。
- 会话开始且 AI 修改文件后，代码差异面板自动打开；关闭后保持关闭，直到下一轮新修改。
- 右侧轨道始终常驻：轮次点与提问行在同一滚动容器内，固定显示 10 个点；点击未加载的旧轮次时，对话会自动上滚并连续加载更早历史，最后定位到目标提问并高亮。
- 差异面板顶部轮次选择器显示完整历史轮次，可切换、上一步/下一步。
- 设置页（`设置 → Code UI`）可关闭/开启资源管理器、差异面板、对话右移、Git 标记，并切换插件语言。

### Git 权限说明

插件只执行只读命令：

```bash
git rev-parse --show-toplevel
git -c core.quotepath=false -c diff.renames=false status --porcelain=v1 -z --branch
git -c core.quotepath=false diff --no-ext-diff --unified=3 HEAD -- .
```

Git 不可用时自动降级：隐藏状态标记，patch 导出显示提示。

### 文件结构

```
dsh-codeui/
├── package.json        # npm 包清单（含 dsh.client / dsh.bundle.patch）
├── cordis.patch.yml    # bundle 自注册 patch（静态安装方式 A）
├── index.js            # 动态插件包清单（host.js + client.js 对应关系）
├── host.js             # 动态 Host 半边（function body）
├── client.js           # 动态 Client 半边（function body）
├── lib/
│   ├── index.js        # 静态 Host：webServer 路由 /codeui/api/*
│   └── client.js       # 静态 Client bundle（dsh.client）
├── README.md
└── LICENSE
```

### 设计边界

- 主对话窗口、工具调用和批准日志由 harness 自身提供，本插件不重复实现。
- “每轮快照”由浏览器端根据会话日志中的编辑工具参数重建：AI 修改过的文件可精确回看；未修改过的文件显示当前磁盘内容。全量 Git 快照、代码标记/留言、AI 辅助审查属于后续计划。

---

<a id="english"></a>

## English

### Introduction

`dsh-codeui` (internal plugin id `codeui`) is a Cordis UI plugin for DeepSeek Harness. It keeps the native chat untouched and adds a code-review workflow around it:

- **Workspace explorer** — file tree with read-only Git badges (M / A / D / R / U / !), branch and ahead/behind information.
- **Per-turn diff panel** — changed-file list for each turn, split or unified diff, `before / after / current` full-file views, and a read-only cumulative `git diff HEAD` with patch export.
- **Always-on turn rail** — 10 turn dots pinned to the right; hover to preview the turn's user question; click any turn to jump back to that question in the chat. If the target turn is not loaded yet, the plugin auto-scrolls the conversation up, keeps clicking "Load earlier" until the turn is loaded, then scrolls to and highlights the question.

### Highlights

- Captures edits from `write`, `edit`, and `str_replace_editor` (`create` / `str_replace` / `insert`).
- The turn selector and the rail always see the full session turn history.
- Draggable split divider (5%–95%); large-file diffs degrade gracefully.
- Explorer, diff panel, chat-reorder and Git badges can be toggled independently.
- UI language: auto / Simplified Chinese / English.
- Git access is strictly read-only.

### Install (static package, recommended)

This repository is organized as an npm package named `dsh-codeui`. The commands below install it straight from GitHub — **no npm registry registration or publication is required**. Publishing to npm is only needed if you want users to run `npm install dsh-codeui` by short name.

#### Step 1: install the package

```bash
dsh plugin --profile web add github:YLingHao/dsh-codeui
```

Or manually:

```bash
cd "$DSH_HOME/profiles/web"
pnpm add github:YLingHao/dsh-codeui
```

#### Step 2: register the plugin (choose one)

**Option A: register as a bundle** (uses this repo's `cordis.patch.yml`)

Edit `$DSH_HOME/profiles/web/package.json` and append `dsh-codeui` to `dsh.profile.bundles`:

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

**Option B: register through a patch layer** (best for an existing profile)

Edit `$DSH_HOME/profiles/web/cordis.patch.yml` (or the global `$DSH_HOME/cordis.patch.yml`) and add:

```yaml
- insert:
    - id: codeui
      name: 'dsh-codeui'
```

#### Step 3: restart

```bash
dsh web
```

Do a hard refresh (Ctrl+F5) in the browser. If you have `dsh-market` installed, you can also install from its UI; add the GitHub topic `dsh-plugin` to this repository for marketplace discovery.

### Install (dynamic Cordis plugin)

The original dynamic install path is still supported:

1. In DeepSeek Harness, create a plugin with `cordis_define`: `kind: "new"`, `idPrefix: "codeui"`.
2. Set `code.host` to the contents of `host.js` and `code.client` to the contents of `client.js`.
3. Approve the run in the UI.

`host.js` / `client.js` stay in sync with the static `lib/` implementation; the static package is the recommended distribution.

### Usage

- Toggle the explorer with the 📁 button in the sidebar footer.
- The diff panel opens automatically when a new turn edits files and stays closed after a manual close.
- The rail is always resident: turn dots and question rows share one scroll container and exactly 10 dots are visible. Clicking an unloaded old turn auto-scrolls and loads earlier history until the target question is reached.
- The turn selector in the diff panel lists every turn in the session.
- `Settings → Code UI` controls the explorer, diff panel, chat reorder, Git badges, and plugin language.

### Git commands (read-only)

```bash
git rev-parse --show-toplevel
git -c core.quotepath=false -c diff.renames=false status --porcelain=v1 -z --branch
git -c core.quotepath=false diff --no-ext-diff --unified=3 HEAD -- .
```

When Git is unavailable the plugin degrades silently: badges disappear and patch export reports the limitation.

### Repository layout

```
dsh-codeui/
├── package.json        # npm manifest (dsh.client + dsh.bundle.patch)
├── cordis.patch.yml    # bundle self-registration patch (static install, option A)
├── index.js            # dynamic plugin package manifest (host.js + client.js)
├── host.js             # dynamic host half (Cordis function body)
├── client.js           # dynamic client half (Cordis function body)
├── lib/
│   ├── index.js        # static host: webServer routes under /codeui/api/*
│   └── client.js       # static client bundle (dsh.client)
├── README.md
└── LICENSE
```

### Scope

The native conversation, tool-call log, and approval UI stay in the harness. Turn snapshots are reconstructed client-side from edit tool parameters, so agent-edited files can be inspected per turn; untouched files show current disk content. Full Git-level snapshots, inline comments, and AI-assisted review are future work.

## License

MIT
