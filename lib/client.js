window.__ModuleLoader__.load({
  id: "dsh-codeui",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");

/**
 * Code UI — Client half (P0) (static bundle).
 *
 * Layout
 *   - File explorer: additive left-docked overlay (`shell.overlay`) with
 *     workspace file tree, refresh control, and read-only Git status badges
 *     (M/A/U/D/...). Git decoration degrades silently when unavailable.
 *   - Middle editor: replaces the `details` slot. It shows the files changed
 *     in the selected turn, a turn switcher, and a SIDE-BY-SIDE (split) or
 *     unified full-file diff. "before"/"after"/"current" modes provide the
 *     per-turn snapshot browser for every file the agent has edited.
 *   - Right jump rail: always-resident, registered in `shell.overlay`
 *     (independent of the code panel). Turn data is collected by a null
 *     component mounted in `conversation.session.header.utilities`, so the
 *     rail keeps working even when the code panel is disabled. Hovering a
 *     node shows the user's question for that turn; clicking it scrolls the
 *     harness chat window to that turn and synchronizes the diff panel.
 *   - Chat on the right: CSS `order` reorder of the frame's grid columns.
 *
 * Plain-JavaScript module registered through window.__ModuleLoader__; the
 * exports are a Cordis plugin ({ apply }) for the web client composition.
 * Host communication uses same-origin fetch against /codeui/api/* routes
 * registered by the static host half.
 */
const h = React.createElement

// Layout service captured in apply() for use by module-level components.
let layoutRef = null
let sessionsService = null
let lastReviewSessionId = null
function reviewWidthPct() {
  try {
    const el = document.querySelector('.codeui-diff')
    const vw = window.innerWidth
    if (!el || !vw) return 42
    const pct = (el.getBoundingClientRect().width / vw) * 100
    return Math.max(20, Math.min(60, pct))
  } catch (e) { return 42 }
}
function setReviewWidthPct(pct) {
  const next = Math.max(20, Math.min(60, Number(pct) || 42))
  if (typeof document !== 'undefined' && document.documentElement) document.documentElement.style.setProperty('--codeui-review-w', next + 'vw')
}

// ---------- settings persistence ----------
const SETTINGS_STORAGE_KEY = 'dsh-codeui.settings.v1'
const DEFAULT_SETTINGS = { showExplorer: true, showDiff: true, reorderLayout: true, showGit: true, language: 'auto' }
function loadStoredSettings() {
  const next = Object.assign({}, DEFAULT_SETTINGS)
  try {
    if (typeof localStorage === 'undefined') return next
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY)
    if (!raw) return next
    const saved = JSON.parse(raw)
    if (!saved || typeof saved !== 'object') return next
    if (typeof saved.showExplorer === 'boolean') next.showExplorer = saved.showExplorer
    if (typeof saved.showDiff === 'boolean') next.showDiff = saved.showDiff
    if (typeof saved.reorderLayout === 'boolean') next.reorderLayout = saved.reorderLayout
    if (typeof saved.showGit === 'boolean') next.showGit = saved.showGit
    if (saved.language === 'auto' || saved.language === 'zh-CN' || saved.language === 'en') next.language = saved.language
  } catch (e) {}
  return next
}
function saveStoredSettings(settings) {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({
      showExplorer: !!settings.showExplorer,
      showDiff: !!settings.showDiff,
      reorderLayout: !!settings.reorderLayout,
      showGit: !!settings.showGit,
      language: settings.language === 'zh-CN' || settings.language === 'en' ? settings.language : 'auto',
    }))
  } catch (e) {}
}

// ---------- static host bridge (webServer routes + same-origin fetch) ----------
async function hostCall(method, args) {
  try {
    const res = await fetch('/codeui/api/' + method, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args || {}),
    })
    if (!res.ok) return { ok: false, error: 'http-' + res.status }
    return await res.json()
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}
// Package-owned stylesheet insertion; the loader tracks style tags owned by
// this plugin via the data-plugin attribute for unload cleanup.
function insertCss(css, id) {
  if (typeof document !== 'undefined') {
    const sel = 'style[data-plugin="dsh-codeui"][data-plugin-css="' + id + '"]'
    if (document.querySelector(sel)) return function () {}
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-codeui'
    tag.dataset.pluginCss = id
    tag.textContent = css
    document.head.appendChild(tag)
    return function () {
      if (tag.parentNode) tag.parentNode.removeChild(tag)
    }
  }
  return function () {}
}

// ---------- shared in-memory state (process-local, per skill guidance) ----------
const state = {
  explorerOpen: false,
  tabs: [],              // [{ path, content, loading, error, auto, lastTime }]
  activePath: null,      // selected tab path
  dismissed: new Map(),  // path -> lastTime at dismissal (changed files the user closed)
  settings: loadStoredSettings(), // persisted to localStorage on every change
  selectedTurn: null,    // null = follow latest; otherwise an exact turn number
  detailsManuallyClosed: false,
  turnView: null,        // { sessionId, turns, latestTurn, running, lastClosedTurn }
  turnFiles: {},         // turn -> { turn, files: [{ path, added, removed }], added, removed }
  turnFilesSessionId: '',
  workspaceRoot: '',
  git: { available: null, branch: '', upstream: null, ahead: 0, behind: 0, repoRoot: '', entries: [], error: null },
  railNotice: null,
}
const listeners = new Set()
function notify() { for (const fn of Array.from(listeners)) { try { fn() } catch (e) {} } }
function subscribe(fn) { listeners.add(fn); return function () { listeners.delete(fn) } }
function patchState(patch) { Object.assign(state, patch); if (patch.settings) saveStoredSettings(state.settings); notify() }
function useShared() {
  const [, force] = React.useState(0)
  React.useEffect(function () { return subscribe(function () { force(function (n) { return n + 1 }) }) }, [])
  return state
}

// ---------- i18n ----------
const STRINGS = {
  'zh-CN': {
    status_running: '执行中',
    status_error: '失败',
    status_warning: '需注意',
    status_done: '完成',
    risk_sensitive: '敏感/凭据文件',
    risk_deps: '依赖清单',
    risk_ci: 'CI/容器/版本控制配置',
    risk_binary: '二进制/数据库文件',
    risk_private_key: '出现私钥',
    risk_secret: '出现疑似密钥/口令',
    risk_intranet: '出现内网地址',
    risk_large: '超大改动',
    turn_files_changed: '修改 {n} 个文件',
    turn_user_question: '用户提问',
    turn_auto: '自动轮次',
    turn_no_question: '（无用户提问）',
    turn_label: '第 {n} 轮',
    files_changed_meta: '修改 {n} 个文件',
    back_latest: '回到最新轮次',
    rail_nav: 'Code UI 轮次导航',
    rail_no_session: 'Code UI：暂无活动会话',
    rail_no_user: '第 {n} 轮没有用户提问，无法定位到对话',
    rail_not_loaded: '第 {n} 轮不在当前已加载的对话窗口中（可先加载更早历史）',
    rail_loading_older: '正在自动向上滚动并加载更早对话…',
    export_failed: '导出失败：浏览器不支持下载',
    explorer_title: '资源管理器',
    explorer_refresh: '刷新（含 Git 状态）',
    explorer_close: '关闭',
    explorer_toggle: '切换资源管理器 (Code UI)',
    explorer_resolving: '正在解析工作目录…',
    explorer_no_root: '未找到工作目录，请先选择一个工作区。',
    explorer_empty: '目录为空',
    explorer_loading: '加载中…',
    divider_drag: '拖动调整两栏宽度',
    diff_title: 'Review',
    diff_running: '执行中',
    diff_risk_title: '本轮回看时请优先检查这些文件',
    diff_prev: '上一轮',
    diff_next: '下一轮',
    diff_latest: '最新（第 {n} 轮）',
    diff_latest_none: '最新（暂无轮次）',
    diff_view_split: '分栏',
    diff_view_unified: '统一',
    diff_view_before: '改前',
    diff_view_after: '改后',
    diff_view_current: '当前',
    diff_reload: '重新读取磁盘并重建差异',
    diff_cumulative: '累计 diff',
    diff_cumulative_close: '关闭累计 diff',
    diff_cumulative_title: '查看相对 HEAD 的累计 patch（只读 git diff）',
    diff_export: '导出 patch',
    diff_export_title: '导出相对 HEAD 的累计 patch（只读 git diff）',
    diff_reading: '读取中…',
    diff_workspace_missing: '未找到工作区',
    diff_exporting: '导出中…',
    diff_exported: '已导出 codeui.patch',
    diff_no_head_diff: '当前没有相对 HEAD 的差异',
    git_unavailable: 'Git 不可用：',
    files_title: '本轮文件 {n}',
    files_collapse: '收起文件列表',
    files_expand: '展开文件列表',
    files_none: '本轮没有捕获到 write/edit 修改。',
    diff_cumulative_label: '累计 diff（相对 HEAD）· ',
    diff_empty: '暂无打开的文件。\n从左侧资源管理器点击文件，或开始对话让智能体修改代码。',
    diff_calculating: '计算差异中…',
    diff_turn_before: '第 {n} 轮修改前',
    diff_turn_after: '第 {n} 轮修改后',
    diff_current_disk: '当前磁盘内容',
    review_card_edited: 'Edited {n} files',
    review_card_button: 'Review',
    diff_turn_suffix: '（第 {n} 轮）',
    diff_added: '新增',
    diff_removed: '删除',
    diff_no_changes: '（无差异）',
    diff_no_version: '该文件没有可重建的版本记录。',
    diff_loading: '加载中…',
    diff_preview: '文件预览',
    diff_no_content: '该文件暂无内容。',
    settings_title: 'Code UI',
    settings_desc: '代码审阅工作台：最左侧资源管理器（含只读 Git 状态标记）、右侧 Review 面板（按轮查看代码差异，默认单栏、可切换双栏）、右侧常驻轮次快速跳转轨道（悬停查看问题，点击跳回对话）。',
    settings_show_explorer: '显示资源管理器',
    settings_show_diff: '显示 Review 面板',
    settings_reorder: '对话右移 / 代码居中',
    settings_show_git: '显示 Git 状态标记',
    settings_language: '插件语言',
    language_auto: '跟随系统',
    language_zh: '简体中文',
    language_en: 'English',
    slot_rail: 'Code UI 轮次导航',
    slot_turn_sync: 'Code UI 轮次同步',
    slot_explorer: '资源管理器',
    slot_settings: 'Code UI',
  },
  en: {
    status_running: 'Running',
    status_error: 'Failed',
    status_warning: 'Attention',
    status_done: 'Done',
    risk_sensitive: 'Sensitive/credential file',
    risk_deps: 'Dependency manifest',
    risk_ci: 'CI/container/VCS config',
    risk_binary: 'Binary/database file',
    risk_private_key: 'Private key found',
    risk_secret: 'Possible secret/password found',
    risk_intranet: 'Private network address found',
    risk_large: 'Very large change',
    turn_files_changed: '{n} files changed',
    turn_user_question: 'User question',
    turn_auto: 'Automatic turn',
    turn_no_question: '(No user question)',
    turn_label: 'Turn {n}',
    files_changed_meta: '{n} files changed',
    back_latest: 'Back to latest',
    rail_nav: 'Code UI turn navigation',
    rail_no_session: 'Code UI: no active session',
    rail_no_user: 'Turn {n} has no user question to jump to',
    rail_not_loaded: 'Turn {n} is outside the loaded conversation window (load older history first)',
    rail_loading_older: 'Auto-scrolling up and loading older conversation…',
    export_failed: 'Export failed: download unsupported',
    explorer_title: 'Explorer',
    explorer_refresh: 'Refresh (with Git status)',
    explorer_close: 'Close',
    explorer_toggle: 'Toggle explorer (Code UI)',
    explorer_resolving: 'Resolving workspace…',
    explorer_no_root: 'Workspace not found. Please choose a workspace first.',
    explorer_empty: 'Folder is empty',
    explorer_loading: 'Loading…',
    divider_drag: 'Drag to resize columns',
    diff_title: 'Review',
    diff_running: 'Running',
    diff_risk_title: 'Review these files first for this turn',
    diff_prev: 'Previous turn',
    diff_next: 'Next turn',
    diff_latest: 'Latest (turn {n})',
    diff_latest_none: 'Latest (no turns)',
    diff_view_split: 'Split',
    diff_view_unified: 'Unified',
    diff_view_before: 'Before',
    diff_view_after: 'After',
    diff_view_current: 'Current',
    diff_reload: 'Reload from disk and rebuild diff',
    diff_cumulative: 'Cumulative diff',
    diff_cumulative_close: 'Close cumulative diff',
    diff_cumulative_title: 'View cumulative patch vs HEAD (read-only git diff)',
    diff_export: 'Export patch',
    diff_export_title: 'Export cumulative patch vs HEAD (read-only git diff)',
    diff_reading: 'Reading…',
    diff_workspace_missing: 'Workspace not found',
    diff_exporting: 'Exporting…',
    diff_exported: 'Exported codeui.patch',
    diff_no_head_diff: 'No changes relative to HEAD',
    git_unavailable: 'Git unavailable: ',
    files_title: 'Files this turn: {n}',
    files_collapse: 'Collapse file list',
    files_expand: 'Expand file list',
    files_none: 'No write/edit changes captured in this turn.',
    diff_cumulative_label: 'Cumulative diff (vs HEAD) · ',
    diff_empty: 'No open files.\nClick a file in the explorer, or start a conversation and let the agent edit code.',
    diff_calculating: 'Calculating diff…',
    diff_turn_before: 'Turn {n} before',
    diff_turn_after: 'Turn {n} after',
    diff_current_disk: 'Current disk content',
    review_card_edited: 'Edited {n} files',
    review_card_button: 'Review',
    diff_turn_suffix: ' (turn {n})',
    diff_added: 'added',
    diff_removed: 'deleted',
    diff_no_changes: '(No changes)',
    diff_no_version: 'No reconstructable version for this file.',
    diff_loading: 'Loading…',
    diff_preview: 'File preview',
    diff_no_content: 'This file has no content.',
    settings_title: 'Code UI',
    settings_desc: 'Code review workbench: file explorer with read-only Git badges, a right-side Review panel with per-turn unified/split diffs, and an always-on turn jump rail with hover previews.',
    settings_show_explorer: 'Show explorer',
    settings_show_diff: 'Show Review panel',
    settings_reorder: 'Move chat right / code centered',
    settings_show_git: 'Show Git status badges',
    settings_language: 'Plugin language',
    language_auto: 'Follow system',
    language_zh: '简体中文',
    language_en: 'English',
    slot_rail: 'Code UI turn navigation',
    slot_turn_sync: 'Code UI turn sync',
    slot_explorer: 'Explorer',
    slot_settings: 'Code UI',
  },
}
function currentLang() {
  const pref = state.settings && state.settings.language
  if (pref === 'zh-CN' || pref === 'en') return pref
  try {
    if (typeof navigator !== 'undefined' && navigator.language && String(navigator.language).toLowerCase().indexOf('zh') === 0) return 'zh-CN'
  } catch (e) {}
  return 'en'
}
function tr(key, params) {
  const dict = STRINGS[currentLang()] || STRINGS['zh-CN']
  let text = dict[key]
  if (text == null) text = STRINGS['zh-CN'][key]
  if (text == null) return key
  if (params) {
    for (const name of Object.keys(params)) {
      text = text.split('{' + name + '}').join(String(params[name]))
    }
  }
  return text
}

// ---------- small helpers ----------
function baseName(p) {
  const s = String(p || '')
  const parts = s.split(/[\\/]/)
  return parts[parts.length - 1] || s
}
function normPath(p) { return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '') }
function splitLines(text) { return (text == null || text === '') ? [] : String(text).split('\n') }
function countLines(text) { return (text == null || text === '') ? 0 : String(text).split('\n').length }
function truncate(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max) + '…' : s
}
function parseArgs(raw) {
  if (typeof raw !== 'string' || raw === '') return null
  try { return JSON.parse(raw) } catch (e) { return null }
}
function pickPath(args) {
  if (args && typeof args.file_path === 'string' && args.file_path !== '') return args.file_path
  if (args && typeof args.path === 'string' && args.path !== '') return args.path
  return null
}
function pathTail(p) {
  return normPath(p).replace(/^\/+/, '').replace(/^[A-Za-z]:\//, '')
}
// Merge differently-shaped paths for the same file (e.g. `E:/AICode/...`
// from edit/write vs `/AICode/...` from str_replace_editor) so they land in
// one tab and one version history.
function mergePathKey(path, map) {
  const p = normPath(path)
  if (map.has(p)) return p
  const tail = pathTail(p)
  if (!tail) return p
  const candidates = []
  for (const existing of map.keys()) {
    const et = pathTail(existing)
    if (!et) continue
    if (et === tail || et.endsWith('/' + tail) || tail.endsWith('/' + et)) candidates.push(existing)
  }
  return candidates.length === 1 ? candidates[0] : p
}
function readContentBlocks(content) {
  if (!Array.isArray(content)) return ''
  return content.map(function (b) {
    if (b && b.type === 'text' && typeof b.text === 'string') return b.text
    if (b && typeof b.text === 'string') return b.text
    return ''
  }).join('')
}

// ---------- tab helpers ----------
function findTab(path) { for (const t of state.tabs) if (t.path === path) return t; return null }
function focusTab(path) { if (state.activePath !== path) { state.activePath = path; notify() } }
function loadContent(tab) {
  tab.loading = true
  notify()
  hostCall('readFile', { path: tab.path }).then(function (res) {
    if (findTab(tab.path) !== tab) return
    if (res && res.ok) { tab.content = res.content; tab.loading = false; tab.error = null }
    else { tab.content = null; tab.loading = false; tab.error = (res && res.error) || 'read-failed' }
    notify()
  }).catch(function (e) {
    if (findTab(tab.path) !== tab) return
    tab.content = null; tab.loading = false; tab.error = String((e && e.message) || e)
    notify()
  })
}
function addFileTab(path) {
  const existing = findTab(path)
  if (existing) { focusTab(path); return }
  const tab = { path: path, content: null, loading: true, error: null, auto: false, lastTime: 0 }
  state.tabs = state.tabs.concat([tab])
  state.activePath = path
  notify()
  loadContent(tab)
}
function closeTab(path) {
  const t = findTab(path)
  state.tabs = state.tabs.filter(function (x) { return x.path !== path })
  state.dismissed.set(path, t ? (t.lastTime || 0) : 0)
  if (state.activePath === path) state.activePath = state.tabs.length ? state.tabs[0].path : null
  notify()
}
function syncTabs(filesMap) {
  let changed = false
  for (const entry of filesMap) {
    const path = entry[0]
    const f = entry[1]
    const dt = state.dismissed.get(path)
    if (dt != null && f.lastTime <= dt) continue
    if (dt != null) { state.dismissed.delete(path); changed = true }
    const t = findTab(path)
    if (t) { if (t.lastTime !== f.lastTime) { t.lastTime = f.lastTime; changed = true } continue }
    state.tabs = state.tabs.concat([{ path: path, content: null, loading: false, error: null, auto: true, lastTime: f.lastTime }])
    changed = true
  }
  const paths = new Set(Array.from(filesMap.keys()))
  const kept = state.tabs.filter(function (t) { return !t.auto || paths.has(t.path) })
  if (kept.length !== state.tabs.length) { state.tabs = kept; changed = true }
  if (state.tabs.length === 0) { if (state.activePath != null) { state.activePath = null; changed = true } }
  else if (!state.activePath || !findTab(state.activePath)) { state.activePath = state.tabs[0].path; changed = true }
  if (changed) notify()
}

// ---------- risk classification ----------
function pathRiskReasons(path) {
  const p = normPath(path)
  const lower = p.toLowerCase()
  const reasons = []
  const base = lower.split('/').pop() || lower
  if (/^\.env(\.|$)/.test(base) || base === '.env' || /(^|\/|\.)secrets?(\.|$)/.test(lower) || base === 'id_rsa' || base.endsWith('.pem') || base.endsWith('.key')) {
    reasons.push(tr('risk_sensitive'))
  }
  if (base === 'package.json' || base === 'requirements.txt' || base === 'pyproject.toml' || base === 'cargo.toml' || base === 'go.mod' || base === 'pom.xml' || base === 'build.gradle' || base === 'pnpm-lock.yaml' || base === 'package-lock.json') {
    reasons.push(tr('risk_deps'))
  }
  if (/^\.github\/workflows\//.test(lower) || base === 'dockerfile' || lower.endsWith('.dockerfile') || base === 'docker-compose.yml' || base === 'docker-compose.yaml' || base === '.gitignore' || base === '.gitconfig' || lower.includes('.circleci/') || lower.startsWith('.gitlab-ci')) {
    reasons.push(tr('risk_ci'))
  }
  if (lower.endsWith('.db') || lower.endsWith('.sqlite') || lower.endsWith('.sqlite3') || lower.endsWith('.exe') || lower.endsWith('.dll') || lower.endsWith('.bin') || lower.endsWith('.pdf') || lower.endsWith('.zip')) {
    reasons.push(tr('risk_binary'))
  }
  return reasons
}
function contentRiskReasons(text) {
  const s = String(text || '')
  const reasons = []
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(s)) reasons.push(tr('risk_private_key'))
  if (/(?:api[_-]?key|secret|access[_-]?token|refresh[_-]?token|password|passwd)\s*[:=]\s*["'][^"']{6,}["']/i.test(s)) reasons.push(tr('risk_secret'))
  if (/\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/.test(s)) reasons.push(tr('risk_intranet'))
  if (countLines(s) > 400) reasons.push(tr('risk_large'))
  return reasons
}
function mergeRisk(a, b) {
  const set = new Set((a && a.reasons) || [])
  for (const r of (b && b.reasons) || []) set.add(r)
  const reasons = Array.from(set)
  let level = 'none'
  for (const r of reasons) {
    if (/私钥|密钥|凭据|密码|token|password|secret|private key|credential/i.test(r)) { level = 'high'; break }
    level = 'medium'
  }
  return { level: level, reasons: reasons }
}

// Collect the ordered file-modification operations per file from the session
// log. Supported tools: write, edit, and str_replace_editor
// (create / str_replace / insert).
function collectFiles(snapshot) {
  const map = new Map()
  if (!snapshot) return map

  const turnEnds = snapshot.turnEnds
  const sortedTurns = turnEnds ? Array.from(turnEnds.entries()).sort(function (a, b) { return a[0] - b[0] }) : []
  function turnForSeq(seq) {
    for (const pair of sortedTurns) { if (seq <= pair[1]) return pair[0] }
    return sortedTurns.length ? sortedTurns[sortedTurns.length - 1][0] + 1 : 1
  }

  function addOp(path, op) {
    if (typeof path !== 'string' || path === '') return
    const key = mergePathKey(path, map)
    let f = map.get(key)
    if (!f) { f = { ops: [], lastTime: 0, lastTurn: 0, risk: { level: 'none', reasons: pathRiskReasons(key) } }; map.set(key, f) }
    f.ops.push(op)
    if (typeof op.time === 'number' && op.time > f.lastTime) f.lastTime = op.time
    if (typeof op.turn === 'number' && op.turn > f.lastTurn) f.lastTurn = op.turn
    const cRisk = contentRiskReasons(op.content || op.newStr || op.oldStr || op.text || '')
    f.risk = mergeRisk(f.risk, { reasons: cRisk, level: cRisk.length ? 'medium' : 'none' })
  }

  function addToolModification(name, rawArgs, seq, time, fallbackTurn) {
    const args = parseArgs(rawArgs)
    if (!args) return
    const path = pickPath(args)
    if (!path) return
    const turn = typeof fallbackTurn === 'number' ? fallbackTurn : turnForSeq(seq)
    if (name === 'write') {
      addOp(path, { op: 'write', content: (typeof args.content === 'string') ? args.content : '', turn: turn, time: time })
    } else if (name === 'edit') {
      addOp(path, {
        op: 'edit',
        oldStr: (typeof args.old_string === 'string') ? args.old_string : '',
        newStr: (typeof args.new_string === 'string') ? args.new_string : '',
        replaceAll: !!(args.replace_all === true),
        turn: turn,
        time: time,
      })
    } else if (name === 'str_replace_editor') {
      const command = args.command
      if (command === 'create') {
        addOp(path, { op: 'write', content: (typeof args.file_text === 'string') ? args.file_text : '', turn: turn, time: time })
      } else if (command === 'str_replace') {
        addOp(path, {
          op: 'edit',
          oldStr: (typeof args.old_str === 'string') ? args.old_str : '',
          newStr: (typeof args.new_str === 'string') ? args.new_str : '',
          replaceAll: !!(args.replace_all === true),
          turn: turn,
          time: time,
        })
      } else if (command === 'insert') {
        if (typeof args.insert_line !== 'number') return
        addOp(path, { op: 'insert', line: args.insert_line, text: (typeof args.new_str === 'string') ? args.new_str : '', turn: turn, time: time })
      }
    }
  }

  if (Array.isArray(snapshot.nodes)) {
    for (const node of snapshot.nodes) {
      if (!node || node.kind !== 'tool-result' || !node.call) continue
      if (node.call.name !== 'edit' && node.call.name !== 'write' && node.call.name !== 'str_replace_editor') continue
      addToolModification(node.call.name, node.call.argsRaw, node.seq, node.time, null)
    }
  }
  if (Array.isArray(snapshot.runningCalls)) {
    for (const rc of snapshot.runningCalls) {
      if (!rc || (rc.name !== 'edit' && rc.name !== 'write' && rc.name !== 'str_replace_editor')) continue
      addToolModification(rc.name, rc.argsRaw, 0, rc.time, (typeof rc.turn === 'number') ? rc.turn : 0)
    }
  }
  for (const f of map.values()) f.ops.sort(function (a, b) { return a.time - b.time })
  return map
}

function changedPathsForTurn(filesMap, turn) {
  const out = []
  for (const entry of filesMap) {
    const path = entry[0]
    const ops = entry[1].ops
    let hit = turn == null
    for (const o of ops) {
      if (turn == null || o.turn === turn) { hit = true; break }
    }
    if (hit) out.push(path)
  }
  return out
}

// Build the turn model used by both the right jump rail and the diff panel.
function buildTurnModel(snapshot, filesMap) {
  const turns = []
  const byNumber = new Map()
  const addTurn = function (t) {
    if (!t || typeof t.turn !== 'number' || byNumber.has(t.turn)) return
    byNumber.set(t.turn, t)
    turns.push(t)
  }

  const timeline = snapshot && snapshot.chat && snapshot.chat.timeline
  if (timeline && Array.isArray(timeline.turnOrder) && timeline.turns && typeof timeline.turns.get === 'function') {
    for (const n of timeline.turnOrder) {
      const loc = timeline.turns.get(n)
      if (!loc) continue
      const start = loc.start || null
      const end = loc.end || null
      addTurn({
        turn: n,
        startSeq: start && typeof start.seq === 'number' ? start.seq : null,
        endSeq: end && typeof end.seq === 'number' ? end.seq : null,
        startTime: start && typeof start.time === 'number' ? start.time : null,
        endTime: end && typeof end.time === 'number' ? end.time : null,
        status: loc.status || 'unknown',
      })
    }
  }
  if (turns.length === 0) {
    const ends = snapshot && snapshot.turnEnds ? Array.from(snapshot.turnEnds.entries()) : []
    ends.sort(function (a, b) { return a[0] - b[0] })
    for (const pair of ends) {
      const timing = snapshot && snapshot.turnTimings && typeof snapshot.turnTimings.get === 'function' ? snapshot.turnTimings.get(pair[0]) : null
      addTurn({
        turn: pair[0],
        startSeq: null,
        endSeq: pair[1],
        startTime: timing && typeof timing.startTime === 'number' ? timing.startTime : null,
        endTime: timing && typeof timing.endTime === 'number' ? timing.endTime : null,
        status: 'closed',
      })
    }
  }
  turns.sort(function (a, b) { return a.turn - b.turn })
  let maxTurn = turns.length ? turns[turns.length - 1].turn : 0

  // Map user nodes (kind === 'user') to the turn they belong to.
  const userNodes = []
  if (snapshot && Array.isArray(snapshot.nodes)) {
    for (const node of snapshot.nodes) if (node && node.kind === 'user') userNodes.push(node)
  }
  function turnForSeq(seq) {
    let best = null
    for (const t of turns) {
      if (t.startSeq != null && seq < t.startSeq) break
      if (t.startSeq == null) continue
      if (t.endSeq == null || seq <= t.endSeq) best = t.turn
    }
    if (best != null) return best
    return turns.length ? turns[0].turn : 1
  }
  for (let i = 0; i < userNodes.length; i++) {
    const node = userNodes[i]
    const turn = turnForSeq(node.seq)
    let t = byNumber.get(turn)
    if (!t) { t = { turn: turn, startSeq: null, endSeq: null, startTime: null, endTime: null, status: 'unknown' }; addTurn(t); turns.sort(function (a, b) { return a.turn - b.turn }); if (turn > maxTurn) maxTurn = turn }
    if (t.userSeq == null) {
      const text = readContentBlocks(node.content)
      t.userSeq = node.seq
      t.userIndex = i
      t.userTitle = truncate(text.split('\n')[0], 96) || (text ? truncate(text, 96) : '')
      t.userFull = text.length > 600 ? text.slice(0, 600) + '…' : text
    }
  }

  // Turn outcome markers and file statistics.
  if (snapshot && Array.isArray(snapshot.nodes)) {
    for (const node of snapshot.nodes) {
      if (!node || typeof node.turn !== 'number') continue
      const t = byNumber.get(node.turn)
      if (!t) continue
      if (node.kind === 'turn-error') t.error = true
      else if (node.kind === 'turn-max-tokens') t.warning = true
    }
  }
  const fileSets = new Map()
  const riskByTurn = new Map()
  for (const entry of filesMap) {
    const path = entry[0]
    const f = entry[1]
    for (const op of f.ops) {
      if (!fileSets.has(op.turn)) fileSets.set(op.turn, new Set())
      fileSets.get(op.turn).add(path)
      riskByTurn.set(op.turn, mergeRisk(riskByTurn.get(op.turn), f.risk))
    }
  }
  const running = !!(snapshot && snapshot.running)
  let lastClosedTurn = 0
  for (const t of turns) {
    t.files = Array.from((fileSets.get(t.turn) || new Set()).values())
    t.fileCount = t.files.length
    t.risk = riskByTurn.get(t.turn) || { level: 'none', reasons: [] }
    if (t.endSeq != null) lastClosedTurn = Math.max(lastClosedTurn, t.turn)
    if (t.error) t.status = 'error'
    else if (t.warning) t.status = 'warning'
    else if (t.endSeq != null || t.status === 'closed') t.status = 'done'
    else if (running && t.turn === maxTurn) t.status = 'running'
    else t.status = 'done'
    t.title = t.userTitle || (t.fileCount ? tr('turn_files_changed', { n: t.fileCount }) : (t.userSeq != null ? tr('turn_user_question') : tr('turn_auto')))
  }
  return {
    sessionId: snapshot ? snapshot.sessionId : '',
    turns: turns,
    latestTurn: maxTurn,
    running: running,
    lastClosedTurn: lastClosedTurn,
    hasMore: !!(snapshot && snapshot.hasMore),
  }
}

function publishTurnView(model) {
  let next = model
  const prev = state.turnView
  if (prev && prev.sessionId === model.sessionId && Array.isArray(prev.turns) && prev.turns.length > 0 && Array.isArray(model.turns)) {
    next = mergeTurnModels(model, prev)
  }
  const patch = { turnView: next }
  if (!state.turnView || state.turnView.sessionId !== next.sessionId) patch.selectedTurn = null
  if (state.selectedTurn != null && !next.turns.some(function (t) { return t.turn === state.selectedTurn })) patch.selectedTurn = null
  patchState(patch)
}

function mergeTurnModels(live, history) {
  const base = live || { sessionId: (history && history.sessionId) || '', turns: [], latestTurn: 0, running: false, lastClosedTurn: 0, hasMore: false }
  const h = history && Array.isArray(history.turns) ? history.turns : []
  if (h.length === 0) return base
  const liveMap = new Map()
  for (const t of base.turns || []) liveMap.set(t.turn, t)
  const merged = []
  for (const ht of h) {
    const lt = liveMap.get(ht.turn)
    if (lt) {
      merged.push(Object.assign({}, ht, {
        fileCount: lt.fileCount || 0,
        files: lt.files || [],
        risk: lt.risk || { level: 'none', reasons: [] },
        status: lt.status || ht.status,
        userIndex: lt.userIndex != null ? lt.userIndex : undefined,
        userSeq: lt.userSeq != null ? lt.userSeq : ht.userSeq,
        userTitle: lt.userTitle || ht.userTitle,
        userFull: lt.userFull || ht.userFull,
        title: lt.userTitle || ht.userTitle || tr('turn_user_question'),
      }))
    } else {
      merged.push(Object.assign({}, ht, {
        fileCount: ht.fileCount || 0,
        files: ht.files || [],
        risk: ht.risk || { level: 'none', reasons: [] },
        // History `userIndex` is an index into the FULL persisted user list;
        // it must not be used against the currently-rendered DOM window (whose
        // first row is the first loaded turn, not global turn 1). The live
        // branch supplies the correct in-window index once the turn is loaded.
        userIndex: undefined,
        title: ht.userTitle || ht.title || tr('turn_user_question'),
      }))
    }
  }
  const historyNumbers = new Set(merged.map(function (t) { return t.turn }))
  for (const lt of base.turns || []) if (!historyNumbers.has(lt.turn)) merged.push(lt)
  merged.sort(function (a, b) { return a.turn - b.turn })
  return {
    sessionId: base.sessionId,
    turns: merged,
    latestTurn: Math.max(base.latestTurn || 0, history && history.latestTurn || 0),
    running: base.running,
    lastClosedTurn: Math.max(base.lastClosedTurn || 0, history && history.lastClosedTurn || 0),
    hasMore: base.hasMore,
  }
}


// ---------- diff helpers ----------
function diffRows(oldText, newText) {
  const oldLines = splitLines(oldText)
  const newLines = splitLines(newText)
  let start = 0
  const minLen = Math.min(oldLines.length, newLines.length)
  while (start < minLen && oldLines[start] === newLines[start]) start++
  let eo = oldLines.length
  let en = newLines.length
  while (eo > start && en > start && oldLines[eo - 1] === newLines[en - 1]) { eo--; en-- }
  const rows = []
  let newN = 0
  for (let i = 0; i < start; i++) { newN++; rows.push({ t: 'ctx', n: newN, text: oldLines[i] }) }
  for (let i = start; i < eo; i++) rows.push({ t: 'del', n: null, text: oldLines[i] })
  for (let i = start; i < en; i++) { newN++; rows.push({ t: 'add', n: newN, text: newLines[i] }) }
  for (let i = eo; i < oldLines.length; i++) { newN++; rows.push({ t: 'ctx', n: newN, text: oldLines[i] }) }
  return rows
}

function lineSimilarity(a, b) {
  if (a === b) return 1
  const la = a.length
  const lb = b.length
  if (!la || !lb) return 0
  let p = 0
  while (p < la && p < lb && a[p] === b[p]) p++
  let s = 0
  while (s < la - p && s < lb - p && a[la - 1 - s] === b[lb - 1 - s]) s++
  return (p + s * 2) / (la + lb)
}

const LCS_CELL_CAP = 900000
function lcsOps(a, b) {
  const n = a.length
  const m = b.length
  const width = m + 1
  const dp = new Uint32Array((n + 1) * width)
  for (let i = 1; i <= n; i++) {
    const ai = a[i - 1]
    const row = i * width
    const prev = (i - 1) * width
    for (let j = 1; j <= m; j++) {
      if (ai === b[j - 1]) dp[row + j] = dp[prev + j - 1] + 1
      else dp[row + j] = dp[prev + j] > dp[row + j - 1] ? dp[prev + j] : dp[row + j - 1]
    }
  }
  const ops = []
  let i = n
  let j = m
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) { ops.push({ t: 'e', text: a[i - 1] }); i--; j-- }
    else if (dp[(i - 1) * width + j] >= dp[i * width + j - 1]) { ops.push({ t: 'd', text: a[i - 1] }); i-- }
    else { ops.push({ t: 'a', text: b[j - 1] }); j-- }
  }
  while (i > 0) { ops.push({ t: 'd', text: a[i - 1] }); i-- }
  while (j > 0) { ops.push({ t: 'a', text: b[j - 1] }); j-- }
  ops.reverse()
  return ops
}

function pairRun(dels, adds) {
  const result = []
  if (dels.length * adds.length <= 2600) {
    const used = new Set()
    for (const d of dels) {
      let best = -1
      let bestScore = 0.38
      for (let k = 0; k < adds.length; k++) {
        if (used.has(k)) continue
        const score = lineSimilarity(d.text, adds[k].text)
        if (score > bestScore) { bestScore = score; best = k }
      }
      if (best >= 0) { used.add(best); result.push({ t: 'pair', del: d, add: adds[best] }) }
      else result.push({ t: 'del', del: d })
    }
    for (let k = 0; k < adds.length; k++) if (!used.has(k)) result.push({ t: 'add', add: adds[k] })
  } else {
    const n = Math.max(dels.length, adds.length)
    for (let k = 0; k < n; k++) {
      if (k < dels.length) result.push({ t: 'del', del: dels[k] })
      if (k < adds.length) result.push({ t: 'add', add: adds[k] })
    }
  }
  return result
}

// Aligned rows for a side-by-side view.
function alignedDiffRows(oldText, newText) {
  const oldLines = splitLines(oldText)
  const newLines = splitLines(newText)
  let start = 0
  const minLen = Math.min(oldLines.length, newLines.length)
  while (start < minLen && oldLines[start] === newLines[start]) start++
  let eo = oldLines.length
  let en = newLines.length
  while (eo > start && en > start && oldLines[eo - 1] === newLines[en - 1]) { eo--; en-- }

  const rows = []
  let ln = 0
  let rn = 0
  for (let i = 0; i < start; i++) { ln++; rn++; rows.push({ t: 'ctx', ln: ln, rn: rn, ltext: oldLines[i], rtext: oldLines[i] }) }

  const midA = oldLines.slice(start, eo)
  const midB = newLines.slice(start, en)
  const canLcs = midA.length * midB.length <= LCS_CELL_CAP
  const flat = []

  if (canLcs) {
    const ops = lcsOps(midA, midB)
    let i = 0
    while (i < ops.length) {
      if (ops[i].t === 'e') { flat.push({ t: 'e', text: ops[i].text }); i++ }
      else if (ops[i].t === 'd' || ops[i].t === 'a') {
        const dels = []
        const adds = []
        while (i < ops.length && (ops[i].t === 'd' || ops[i].t === 'a')) {
          if (ops[i].t === 'd') dels.push(ops[i])
          else adds.push(ops[i])
          i++
        }
        for (const item of pairRun(dels, adds)) flat.push(item)
      }
    }
  } else {
    for (const line of midA) flat.push({ t: 'd', text: line })
    for (const line of midB) flat.push({ t: 'a', text: line })
  }

  for (const item of flat) {
    if (item.t === 'e') { ln++; rn++; rows.push({ t: 'ctx', ln: ln, rn: rn, ltext: item.text, rtext: item.text }) }
    else if (item.t === 'd' || item.t === 'del') { ln++; rows.push({ t: 'del', ln: ln, rn: null, ltext: item.del ? item.del.text : item.text, rtext: '' }) }
    else if (item.t === 'a' || item.t === 'add') { rn++; rows.push({ t: 'add', ln: null, rn: rn, ltext: '', rtext: item.add ? item.add.text : item.text }) }
    else if (item.t === 'pair') { ln++; rn++; rows.push({ t: 'mod', ln: ln, rn: rn, ltext: item.del.text, rtext: item.add.text }) }
  }

  for (let i = eo; i < oldLines.length; i++) { ln++; rn++; rows.push({ t: 'ctx', ln: ln, rn: rn, ltext: oldLines[i], rtext: oldLines[i] }) }
  return rows
}

function diffStats(oldText, newText) {
  const oldLines = splitLines(oldText)
  const newLines = splitLines(newText)
  let added = 0
  let removed = 0
  if (oldLines.length * newLines.length <= LCS_CELL_CAP) {
    const rows = alignedDiffRows(oldText, newText)
    for (const r of rows) {
      if (r.t === 'add') added++
      else if (r.t === 'del') removed++
      else if (r.t === 'mod') { added++; removed++ }
    }
    return { added: added, removed: removed }
  }
  const rows = diffRows(oldText, newText)
  for (const r of rows) {
    if (r.t === 'add') added++
    else if (r.t === 'del') removed++
  }
  return { added: added, removed: removed }
}

// ---------- file version reconstruction ----------
function applyEdit(content, o) {
  if (o.replaceAll) return content.split(o.oldStr).join(o.newStr)
  return content.replace(o.oldStr, function () { return o.newStr })
}
function reverseEdit(content, o) {
  if (o.replaceAll) return content.split(o.newStr).join(o.oldStr)
  return content.replace(o.newStr, function () { return o.oldStr })
}
function insertLines(content, line, text) {
  const lines = splitLines(content)
  const added = splitLines(text)
  const at = Math.max(0, Math.min(lines.length, Number(line) || 0))
  Array.prototype.splice.apply(lines, [at, 0].concat(added))
  return lines.join('\n')
}
function removeInsertedLines(content, line, text) {
  const lines = splitLines(content)
  const added = splitLines(text)
  const at = Math.max(0, Math.min(lines.length, Number(line) || 0))
  const count = Math.min(added.length, Math.max(0, lines.length - at))
  lines.splice(at, count)
  return lines.join('\n')
}
async function readCurrentContent(path) {
  try {
    const res = await hostCall('readFile', { path: path })
    if (res && res.ok && typeof res.content === 'string') return res.content
  } catch (e) {}
  return ''
}

// Reconstruct the full content before/after every turn for one file.
async function computeVersionMap(path, ops) {
  const current = await readCurrentContent(path)
  const turns = {}
  if (!ops || ops.length === 0) return { current: current, turns: turns }

  let base
  if (ops[0].op === 'write') {
    base = ''
  } else {
    base = current
    for (let i = ops.length - 1; i >= 0; i--) {
      const o = ops[i]
      if (o.op === 'edit') base = reverseEdit(base, o)
      else if (o.op === 'insert') base = removeInsertedLines(base, o.line, o.text)
      else base = ''
    }
  }

  let content = base
  let i = 0
  while (i < ops.length) {
    const turn = ops[i].turn
    const before = content
    while (i < ops.length && ops[i].turn === turn) {
      const o = ops[i]
      if (o.op === 'write') content = o.content
      else if (o.op === 'insert') content = insertLines(content, o.line, o.text)
      else content = applyEdit(content, o)
      i++
    }
    const after = content
    const stats = diffStats(before, after)
    turns[turn] = { before: before, after: after, added: stats.added, removed: stats.removed }
  }
  return { current: current, turns: turns }
}

function versionSignature(filesMap) {
  const parts = []
  for (const entry of filesMap) {
    const path = entry[0]
    const ops = entry[1].ops
    parts.push(path + ':' + ops.length + ':' + (ops.length ? (ops[0].time + '|' + ops[ops.length - 1].time) : ''))
  }
  return parts.join(';;')
}
const versionCache = { sig: null, maps: null }
function clearVersionCache() { versionCache.sig = null; versionCache.maps = null }

function latestTurnForFile(versionMap, turn) {
  if (!versionMap || !versionMap.turns) return null
  const keys = Object.keys(versionMap.turns).map(Number)
  if (!keys.length) return null
  if (turn != null && versionMap.turns[turn]) return turn
  return keys.sort(function (a, b) { return a - b })[keys.length - 1]
}

function latestEditedPath(filesMap) {
  let bestPath = null
  let bestTime = -1
  for (const entry of filesMap) {
    const f = entry[1]
    if (f && typeof f.lastTime === 'number' && f.lastTime > bestTime) { bestTime = f.lastTime; bestPath = entry[0] }
  }
  return bestPath
}

// File paths currently being edited by in-flight edit/write calls, most recent first.
function runningEditPaths(snapshot) {
  const list = []
  if (snapshot && Array.isArray(snapshot.runningCalls)) {
    for (const rc of snapshot.runningCalls) {
      if (!rc || (rc.name !== 'edit' && rc.name !== 'write' && rc.name !== 'str_replace_editor')) continue
      const args = parseArgs(rc.argsRaw)
      if (rc.name === 'str_replace_editor' && args && args.command !== 'create' && args.command !== 'str_replace' && args.command !== 'insert') continue
      const path = pickPath(args)
      if (path) list.push({ path: path, time: (typeof rc.time === 'number') ? rc.time : 0 })
    }
  }
  list.sort(function (a, b) { return b.time - a.time })
  return list
}

// ---------- per-turn review card summary ----------
function opLineDelta(op) {
  if (!op) return { added: 0, removed: 0 }
  if (op.op === 'write') return { added: countLines(op.content || ''), removed: 0 }
  if (op.op === 'edit') return { added: countLines(op.newStr || ''), removed: countLines(op.oldStr || '') }
  if (op.op === 'insert') return { added: countLines(op.text || ''), removed: 0 }
  return { added: 0, removed: 0 }
}
function fileTurnDelta(path, turn, filesMap) {
  const f = filesMap && filesMap.get(path)
  if (!f || !Array.isArray(f.ops) || turn == null) return null
  let added = 0
  let removed = 0
  let hit = false
  for (const op of f.ops) {
    if (op && op.turn === turn) {
      hit = true
      const d = opLineDelta(op)
      added += d.added
      removed += d.removed
    }
  }
  return hit ? { added: added, removed: removed } : null
}
function renderToolDeltaRows(path, turn, filesMap) {
  const f = filesMap && filesMap.get(path)
  const els = []
  let added = 0
  let removed = 0
  let oldLine = 0
  let newLine = 0
  const push = function (type, line) {
    if (type === 'add') {
      newLine++
      added++
      els.push(h('div', { className: 'codeui-diff-row codeui-diff-add', key: 'a' + els.length },
        h('span', { className: 'codeui-diff-gutter' }, '+'),
        h('span', { className: 'codeui-diff-num' }, ''),
        h('span', { className: 'codeui-diff-num' }, String(newLine)),
        h('span', { className: 'codeui-diff-text' }, line)
      ))
    } else {
      oldLine++
      removed++
      els.push(h('div', { className: 'codeui-diff-row codeui-diff-del', key: 'd' + els.length },
        h('span', { className: 'codeui-diff-gutter' }, '-'),
        h('span', { className: 'codeui-diff-num' }, String(oldLine)),
        h('span', { className: 'codeui-diff-num' }, ''),
        h('span', { className: 'codeui-diff-text' }, line)
      ))
    }
  }
  if (f) {
    for (const op of f.ops) {
      if (!op || op.turn !== turn) continue
      if (op.op === 'write') for (const line of splitLines(op.content || '')) push('add', line)
      else if (op.op === 'edit') {
        for (const line of splitLines(op.oldStr || '')) push('del', line)
        for (const line of splitLines(op.newStr || '')) push('add', line)
      } else if (op.op === 'insert') {
        for (const line of splitLines(op.text || '')) push('add', line)
      }
    }
  }
  return { els: els, added: added, removed: removed }
}

function mergeHistoryFilesMap(filesMap, turnModel, turn) {
  const next = new Map(filesMap || [])
  if (!turnModel || turn == null) return next
  const ht = turnModel.turns.find(function (t) { return t.turn === turn })
  if (!ht || !Array.isArray(ht.files)) return next
  for (const hf of ht.files) {
    if (!hf || typeof hf.path !== 'string') continue
    const key = mergePathKey(hf.path, next)
    const existing = next.get(key)
    const histOps = (Array.isArray(hf.ops) ? hf.ops : []).map(function (op) { return Object.assign({}, op, { turn: op && typeof op.turn === 'number' ? op.turn : turn }) })
    if (existing) {
      const liveTurns = new Set(existing.ops.map(function (o) { return o && o.turn }))
      const mergedOps = existing.ops.slice()
      for (const op of histOps) if (op && !liveTurns.has(op.turn)) mergedOps.push(op)
      mergedOps.sort(function (a, b) { return ((a && a.time) || 0) - ((b && b.time) || 0) })
      next.set(key, Object.assign({}, existing, { ops: mergedOps }))
    } else {
      next.set(key, { ops: histOps, lastTime: 0, lastTurn: turn, risk: { level: 'none', reasons: [] } })
    }
  }
  return next
}

function toolDeltaText(path, turn, filesMap, kind) {
  const f = filesMap && filesMap.get(path)
  const before = []
  const after = []
  if (f) {
    for (const op of f.ops) {
      if (!op || op.turn !== turn) continue
      if (op.op === 'write') { for (const line of splitLines(op.content || '')) after.push(line) }
      else if (op.op === 'edit') { for (const line of splitLines(op.oldStr || '')) before.push(line); for (const line of splitLines(op.newStr || '')) after.push(line) }
      else if (op.op === 'insert') { for (const line of splitLines(op.text || '')) after.push(line) }
    }
  }
  return (kind === 'before' ? before : after).join('\n')
}

function renderToolDeltaView(path, turn, filesMap) {
  const r = renderToolDeltaRows(path, turn, filesMap)
  return h('div', { className: 'codeui-diff-content' },
    h('div', { className: 'codeui-diff-filepath', title: path }, path + tr('diff_turn_suffix', { n: turn })),
    h('div', { className: 'codeui-diff-stats' },
      h('span', { className: 'codeui-add-count' }, '+' + r.added + ' ' + tr('diff_added')),
      h('span', { className: 'codeui-del-count' }, '-' + r.removed + ' ' + tr('diff_removed'))
    ),
    h('div', { className: 'codeui-diff-scroll' }, r.els.length ? r.els : h('div', { className: 'codeui-diff-empty' }, tr('diff_no_changes')))
  )
}
function buildTurnFileSummary(filesMap) {
  const byTurn = new Map()
  for (const entry of filesMap) {
    const path = entry[0]
    const f = entry[1]
    if (!f || !Array.isArray(f.ops)) continue
    for (const op of f.ops) {
      if (!op || typeof op.turn !== 'number') continue
      const d = opLineDelta(op)
      if (!d.added && !d.removed) continue
      let cell = byTurn.get(op.turn)
      if (!cell) { cell = { files: new Map(), added: 0, removed: 0 }; byTurn.set(op.turn, cell) }
      let row = cell.files.get(path)
      if (!row) { row = { path: path, added: 0, removed: 0 }; cell.files.set(path, row) }
      row.added += d.added
      row.removed += d.removed
      cell.added += d.added
      cell.removed += d.removed
    }
  }
  const out = {}
  for (const entry of byTurn) {
    const turn = entry[0]
    const cell = entry[1]
    const files = Array.from(cell.files.values())
    files.sort(function (a, b) {
      return ((b.added + b.removed) - (a.added + a.removed)) || String(a.path).localeCompare(String(b.path))
    })
    out[turn] = { turn: turn, files: files, added: cell.added, removed: cell.removed }
  }
  return out
}
function reviewDisplayPath(path, root) {
  const p = normPath(path)
  const r = normPath(root || '')
  if (r && p.indexOf(r + '/') === 0) {
    const rel = p.slice(r.length + 1)
    const parts = r.split('/')
    const base = parts[parts.length - 1]
    return base ? base + '/' + rel : rel
  }
  return p
}

// ---------- Git state / patch export ----------
function loadGitStatus(root) {
  if (!root || !state.settings.showGit) { patchState({ git: { available: null, branch: '', upstream: null, ahead: 0, behind: 0, repoRoot: '', entries: [], error: null } }); return }
  hostCall('gitStatus', { path: root }).then(function (res) {
    if (res && res.ok) {
      patchState({ git: { available: true, branch: res.branch || '', upstream: res.upstream || null, ahead: res.ahead || 0, behind: res.behind || 0, repoRoot: res.repoRoot || '', entries: Array.isArray(res.entries) ? res.entries : [], error: null } })
    } else {
      patchState({ git: { available: false, branch: '', upstream: null, ahead: 0, behind: 0, repoRoot: '', entries: [], error: (res && res.error) || 'git-unavailable' } })
    }
  }).catch(function () {
    patchState({ git: { available: false, branch: '', upstream: null, ahead: 0, behind: 0, repoRoot: '', entries: [], error: 'git-unavailable' } })
  })
}
function downloadPatch(text) {
  try {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'codeui.patch'
    document.body.appendChild(a)
    a.click()
    a.remove()
  } catch (e) {
    patchState({ railNotice: tr('export_failed') })
  }
}

// ---------- chat jump navigation ----------
function visibleUserRows() {
  const rows = []
  try {
    const all = document.querySelectorAll('[data-chat-anchor-key][data-chat-flow-kind="user"]')
    for (const row of all) {
      const host = row.closest('[data-conversation-scroll]')
      if (host && host.getBoundingClientRect().height > 0) rows.push(row)
    }
  } catch (e) {}
  return rows
}
function scrollHostToBottom() {
  try {
    const host = document.querySelector('[data-conversation-scroll]')
    if (host) host.scrollTop = host.scrollHeight
    else window.scrollTo(0, document.body.scrollHeight)
  } catch (e) {}
}
function scrollHostToRow(row) {
  try {
    const host = row.closest('[data-conversation-scroll]')
    if (host) {
      const hostRect = host.getBoundingClientRect()
      const rowRect = row.getBoundingClientRect()
      const offset = Math.min(120, Math.max(40, host.clientHeight * 0.18))
      host.scrollTop = Math.max(0, host.scrollTop + rowRect.top - hostRect.top - offset)
    } else {
      row.scrollIntoView({ block: 'start' })
    }
  } catch (e) {
    try { row.scrollIntoView({ block: 'start' }) } catch (e2) {}
  }
}
function flashRow(row) {
  try {
    row.classList.remove('codeui-chat-flash')
    void row.offsetWidth
    row.classList.add('codeui-chat-flash')
    if (typeof requestAnimationFrame !== 'function') return
    const start = performance.now()
    const tick = function (ts) {
      if (ts - start >= 1600) {
        row.classList.remove('codeui-chat-flash')
        return
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  } catch (e) {}
}
let lastLoadOlderClickAt = 0
function loadOlderLabelMatches(raw) {
  const text = String(raw || '')
  const compact = text.replace(/\s+/g, '')
  if (!compact) return false
  return compact.indexOf('加载更早') >= 0 || compact.indexOf('Loadolder') >= 0 || compact.indexOf('Loadearlier') >= 0 || compact.indexOf('Loadmore') >= 0 || /load\s*older/i.test(text) || /load\s*earlier/i.test(text) || /load\s*more/i.test(text)
}
function findConversationScrollHost() {
  try {
    const hosts = document.querySelectorAll('[data-conversation-scroll]')
    for (const host of hosts) {
      if (host && host.getBoundingClientRect && host.getBoundingClientRect().height > 0) return host
    }
  } catch (e) {}
  return null
}
function findLoadOlderButtonIn(host) {
  if (!host || !host.querySelectorAll) return null
  const buttons = host.querySelectorAll('button')
  for (const button of buttons) {
    if (loadOlderLabelMatches(button.textContent || '')) return button
  }
  // Label can change while a page is loading; fall back to the harness
  // "older" container so we can still detect the disabled loading state.
  try {
    const container = host.querySelector('[class*="older"]')
    if (container) {
      const button = container.querySelector('button')
      if (button) return button
    }
  } catch (e) {}
  return null
}
function clickLoadOlderButton() {
  try {
    const hosts = document.querySelectorAll('[data-conversation-scroll]')
    for (const host of hosts) {
      const button = findLoadOlderButtonIn(host)
      if (button && !button.disabled) { button.click(); return true }
    }
  } catch (e) {}
  return false
}
function scrollHostTowardTop(host) {
  if (!host) return false
  const top = Number(host.scrollTop) || 0
  if (top <= 1) { host.scrollTop = 0; return false }
  host.scrollTop = Math.max(0, top - Math.max(16, Math.min(320, top * 0.14)))
  return true
}
function freshTurnInfo(turnNumber) {
  const view = state.turnView
  if (view && Array.isArray(view.turns)) {
    const t = view.turns.find(function (x) { return x.turn === turnNumber })
    if (t) return t
  }
  return null
}

// ---------- aggressive older-history loading for far-back turn jumps ----------
// Two complementary paths:
//   1. Runtime sessions service `loadOlder()` pages straight back to the
//      target seq (fast path when the service is reachable from the plugin).
//   2. Visible conversation driving: scroll the chat viewport up to the
//      "load older" button, auto-click it, and keep paging/clicking until the
//      target row is rendered. If a click is not auto-triggered, the viewport
//      is left at the top so the user can click it manually.
let directLoadKey = null
let directLoadResult = null
let jumpRun = 0
function captureSessionService(ctx) {
  try {
    const service = ctx && ctx.get ? ctx.get('sessions') : null
    if (service && typeof service.get === 'function') sessionsService = service
  } catch (e) {}
}
function clockNow() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()
}
function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms) })
}
async function loadOlderUntil(sessionId, targetSeq) {
  const key = sessionId + ':' + targetSeq
  directLoadKey = key
  directLoadResult = null
  if (!sessionsService || typeof sessionsService.get !== 'function') return 'no-service'
  let session = null
  try { session = sessionsService.get(sessionId) } catch (e) { session = null }
  if (!session) return 'no-session'
  if (typeof session.open === 'function') {
    try { await session.open() } catch (e) {}
  }
  if (typeof session.loadOlder !== 'function') return 'no-loader'
  const startedAt = Date.now()
  let pages = 0
  while (directLoadKey === key && pages < 600 && Date.now() - startedAt < 90000) {
    if (session.hasMore !== true) break
    const baseSeq = typeof session.baseSeq === 'number' ? session.baseSeq : null
    if (baseSeq != null && targetSeq != null && targetSeq >= baseSeq) break
    if (session.loadingOlder) { await sleep(60); continue }
    const pending = session.loadOlder()
    if (pending && typeof pending.then === 'function') {
      try { await pending } catch (e) { return 'error' }
    } else {
      await sleep(40)
    }
    pages++
  }
  return directLoadKey === key ? 'done' : 'cancelled'
}
function scheduleJumpToTurn(turn, attempt, startedAt, token) {
  if (!turn) { scrollHostToBottom(); return }
  const isNewRun = token == null
  if (isNewRun) { lastLoadOlderClickAt = 0; directLoadKey = null; directLoadResult = null }
  const run = isNewRun ? ++jumpRun : token
  const started = startedAt == null ? clockNow() : startedAt
  const fresh = freshTurnInfo(turn.turn) || turn
  if (fresh.userSeq == null) {
    patchState({ railNotice: tr('rail_no_user', { n: turn.turn }) })
    return
  }
  const rows = visibleUserRows()
  let row = fresh.userIndex != null ? (rows[fresh.userIndex] || null) : null
  if (!row && fresh.userTitle) {
    const needle = String(fresh.userTitle).replace(/\s+/g, ' ').slice(0, 48).toLowerCase()
    for (const candidate of rows) {
      const text = String(candidate.textContent || '').replace(/\s+/g, ' ').toLowerCase()
      if (needle && text.indexOf(needle) >= 0) { row = candidate; break }
    }
  }
  if (row) {
    scrollHostToRow(row)
    flashRow(row)
    patchState({ railNotice: null })
    return
  }

  const view = state.turnView
  const sessionId = view ? view.sessionId : ''
  const loadingText = tr('rail_loading_older')
  const hasService = !!(sessionsService && typeof sessionsService.get === 'function')
  if (hasService && sessionId && fresh.userSeq != null) {
    const key = sessionId + ':' + fresh.userSeq
    if (directLoadKey !== key) {
      directLoadKey = key
      directLoadResult = null
      loadOlderUntil(sessionId, fresh.userSeq).then(function (result) {
        if (directLoadKey === key) directLoadResult = result
      }).catch(function () {
        if (directLoadKey === key) directLoadResult = 'error'
      })
    }
  }
  const directBusy = hasService && sessionId && fresh.userSeq != null && directLoadKey === (sessionId + ':' + fresh.userSeq) && directLoadResult == null
  const canLoad = !!(view && view.hasMore === true)
  const now = clockNow()

  // Drive the visible conversation toward the target turn: scroll up to the
  // harness "load older" button, auto-click it, wait out a loading page, then
  // keep paging until the target user row exists.
  const host = findConversationScrollHost()
  const olderButton = host ? findLoadOlderButtonIn(host) : null
  const atTop = host ? (Number(host.scrollTop) || 0) <= 2 : true
  let loadingPath = false
  if (host && !atTop) {
    loadingPath = true
    scrollHostTowardTop(host)
  } else if (olderButton && !olderButton.disabled) {
    loadingPath = true
    if (now - lastLoadOlderClickAt >= 250) {
      lastLoadOlderClickAt = now
      olderButton.click()
    }
  } else if (olderButton) {
    loadingPath = true
  } else if (!host && canLoad) {
    loadingPath = true
    if (now - lastLoadOlderClickAt >= 250) {
      lastLoadOlderClickAt = now
      clickLoadOlderButton()
    }
  }

  const waitingAtTopForUser = atTop && olderButton != null
  if (directBusy || canLoad || loadingPath) {
    if (state.railNotice !== loadingText) patchState({ railNotice: loadingText })
  } else if (!waitingAtTopForUser && now - started >= 3000) {
    patchState({ railNotice: tr('rail_not_loaded', { n: turn.turn }) })
    return
  }
  if (now - started >= 90000) {
    patchState({ railNotice: tr('rail_not_loaded', { n: turn.turn }) })
    return
  }
  if (run !== jumpRun) return
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(function () {
      if (run !== jumpRun) return
      scheduleJumpToTurn(turn, 0, started, run)
    })
  } else {
    patchState({ railNotice: tr('rail_not_loaded', { n: turn.turn }) })
  }
}
function chooseTurn(turnNumber, model, shouldJump) {
  if (turnNumber == null) {
    patchState({ selectedTurn: null, railNotice: null })
    if (shouldJump) {
      const latest = model && model.turns && model.turns.length ? model.turns[model.turns.length - 1] : null
      if (latest && latest.userIndex != null) scheduleJumpToTurn(latest, 0)
      else scrollHostToBottom()
    }
    return
  }
  if (model && model.turns) {
    const found = model.turns.find(function (t) { return t.turn === turnNumber })
    if (!found) return
    patchState({ selectedTurn: turnNumber, railNotice: null })
    if (shouldJump) scheduleJumpToTurn(found, 0)
  }
}



// ---------- turn-tail review card ----------
function openReviewTurn(turnNumber) {
  // Respect the setting: when Review is disabled, card clicks do nothing.
  if (!state.settings.showDiff) return
  patchState({
    selectedTurn: turnNumber,
    detailsManuallyClosed: false,
    railNotice: null,
  })
  if (layoutRef && typeof layoutRef.openDetails === 'function') layoutRef.openDetails()
}
function openReviewFile(turnNumber, path) {
  if (!state.settings.showDiff) return
  openReviewTurn(turnNumber)
  addFileTab(normPath(path))
}
function selectTurnReviewCard(owner) {
  let turnNumber = null
  try {
    if (owner && typeof owner.turn === 'number') turnNumber = owner.turn
    else if (owner && owner.turn && typeof owner.turn.turn === 'number') turnNumber = owner.turn.turn
  } catch (e) {}
  if (turnNumber == null) return null
  // Always match so the component mounts and subscribes to the shared state;
  // the live summary may only be published just after the turn-tail renders.
  return { turn: turnNumber }
}
function TurnReviewCard(props) {
  const shared = useShared()
  const matched = props.matched
  const turnNumber = matched && typeof matched.turn === 'number' ? matched.turn : null
  if (turnNumber == null) return null
  const sessionOk = shared.turnFilesSessionId && shared.turnView && shared.turnFilesSessionId === shared.turnView.sessionId
  const summary = sessionOk ? (shared.turnFiles && shared.turnFiles[turnNumber]) : null
  if (!summary || !Array.isArray(summary.files) || summary.files.length === 0) return null
  const rows = summary.files.map(function (f) {
    return h('div', {
      key: f.path,
      className: 'codeui-turn-review-file',
      title: f.path,
      onClick: function () { openReviewFile(summary.turn, f.path) },
    },
      h('span', { className: 'codeui-turn-review-path' }, reviewDisplayPath(f.path, shared.workspaceRoot)),
      h('span', { className: 'codeui-turn-review-file-stats' },
        h('span', { className: 'codeui-turn-review-added' }, '+' + f.added),
        h('span', { className: 'codeui-turn-review-removed' }, '-' + f.removed)
      )
    )
  })
  return h('div', {
    className: 'codeui-turn-review-card',
    onWheel: function (e) {
      if (e && e.currentTarget) {
        const list = e.currentTarget.querySelector('.codeui-turn-review-files')
        if (list) list.scrollTop += (e.deltaY || 0)
        if (e.preventDefault) e.preventDefault()
        if (e.stopPropagation) e.stopPropagation()
      }
    },
  },
    h('div', { className: 'codeui-turn-review-head' },
      h('span', { className: 'codeui-turn-review-label' }, tr('review_card_edited', { n: summary.files.length })),
      h('button', { className: 'codeui-turn-review-button', type: 'button', onClick: function () { openReviewTurn(summary.turn) } }, tr('review_card_button'))
    ),
    h('div', { className: 'codeui-turn-review-totals' },
      h('span', { className: 'codeui-turn-review-added' }, '+' + summary.added),
      h('span', { className: 'codeui-turn-review-removed' }, '-' + summary.removed)
    ),
    h('div', { className: 'codeui-turn-review-files' }, rows)
  )
}

// ---------- DOM bridge: keep review cards under every turn tail ----------
// The turn-tail slot is a chain whose FIRST matching entry wins, so a second
// chain entry cannot render below the built-in Produced Files row. We instead
// mount a root-level null component that watches `[data-turn-tail]` nodes and
// inserts/updates a plain-DOM card right after the produced-files row (or at
// the tail when that row is absent).
function reviewSummaryForTurn(turn) {
  if (!state.turnFilesSessionId || !state.turnView || state.turnFilesSessionId !== state.turnView.sessionId) return null
  return state.turnFiles && state.turnFiles[turn] || null
}
function reviewCardSignature(turn, summary) {
  return turn + '|' + state.workspaceRoot + '|' + currentLang() + '|' + JSON.stringify(summary)
}
function renderReviewCardDom(card, turn, summary) {
  if (!card || typeof document === 'undefined') return
  card.textContent = ''
  card.className = 'codeui-turn-review-card'
  card.setAttribute('data-codeui-turn', String(turn))
  const head = document.createElement('div')
  head.className = 'codeui-turn-review-head'
  const label = document.createElement('span')
  label.className = 'codeui-turn-review-label'
  label.textContent = tr('review_card_edited', { n: summary.files.length })
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'codeui-turn-review-button'
  button.textContent = tr('review_card_button')
  button.addEventListener('click', function () { openReviewTurn(turn) })
  head.appendChild(label)
  head.appendChild(button)
  const totals = document.createElement('div')
  totals.className = 'codeui-turn-review-totals'
  const totalAdded = document.createElement('span')
  totalAdded.className = 'codeui-turn-review-added'
  totalAdded.textContent = '+' + summary.added
  const totalRemoved = document.createElement('span')
  totalRemoved.className = 'codeui-turn-review-removed'
  totalRemoved.textContent = '-' + summary.removed
  totals.appendChild(totalAdded)
  totals.appendChild(totalRemoved)
  const list = document.createElement('div')
  list.className = 'codeui-turn-review-files'
  for (const f of summary.files) {
    const row = document.createElement('div')
    row.className = 'codeui-turn-review-file'
    row.title = f.path
    const pathNode = document.createElement('span')
    pathNode.className = 'codeui-turn-review-path'
    pathNode.textContent = reviewDisplayPath(f.path, state.workspaceRoot)
    const stats = document.createElement('span')
    stats.className = 'codeui-turn-review-file-stats'
    const added = document.createElement('span')
    added.className = 'codeui-turn-review-added'
    added.textContent = '+' + f.added
    const removed = document.createElement('span')
    removed.className = 'codeui-turn-review-removed'
    removed.textContent = '-' + f.removed
    stats.appendChild(added)
    stats.appendChild(removed)
    row.appendChild(pathNode)
    row.appendChild(stats)
    row.addEventListener('click', function () { openReviewFile(turn, f.path) })
    list.appendChild(row)
  }
  card.appendChild(head)
  card.appendChild(totals)
  card.appendChild(list)
  card.onwheel = function (e) {
    if (e && e.currentTarget) {
      const files = e.currentTarget.querySelector('.codeui-turn-review-files')
      if (files) files.scrollTop += (e.deltaY || 0)
      if (e.preventDefault) e.preventDefault()
      if (e.stopPropagation) e.stopPropagation()
    }
  }
}
function syncReviewCardDom() {
  if (typeof document === 'undefined') return
  let tails
  try { tails = document.querySelectorAll('[data-turn-tail]') } catch (e) { return }
  for (const tail of tails) {
    let turn = Number(tail.getAttribute('data-turn-tail'))
    if (!Number.isFinite(turn)) continue
    const summary = reviewSummaryForTurn(turn)
    const producedRow = tail.querySelector('[data-produced-files-row]')
    let anchor = null
    if (producedRow && producedRow.parentElement && producedRow.parentElement !== tail) anchor = producedRow.parentElement
    let card = tail.querySelector('[data-codeui-review-card]')
    if (!summary || !Array.isArray(summary.files) || summary.files.length === 0) {
      if (card) card.remove()
      continue
    }
    const sig = reviewCardSignature(turn, summary)
    if (card && card.getAttribute('data-codeui-signature') === sig) continue
    if (!card) {
      card = document.createElement('div')
      card.setAttribute('data-codeui-review-card', '')
      if (anchor) anchor.insertAdjacentElement('afterend', card)
      else tail.appendChild(card)
    } else if (anchor && card.parentElement !== anchor.parentElement) {
      card.remove()
      anchor.insertAdjacentElement('afterend', card)
    } else if (!anchor && card.parentElement !== tail) {
      card.remove()
      tail.appendChild(card)
    }
    card.setAttribute('data-codeui-signature', sig)
    renderReviewCardDom(card, turn, summary)
  }
}
function ReviewCardDomBridge() {
  const shared = useShared()
  React.useEffect(function () {
    let observer = null
    let timer = null
    if (typeof document !== 'undefined' && typeof MutationObserver !== 'undefined') {
      observer = new MutationObserver(function () { syncReviewCardDom() })
      observer.observe(document.body, { childList: true, subtree: true })
    }
    if (typeof setInterval === 'function') timer = setInterval(function () { syncReviewCardDom() }, 700)
    return function () {
      if (observer) observer.disconnect()
      if (timer != null) clearInterval(timer)
    }
  }, [])
  React.useEffect(function () {
    syncReviewCardDom()
  }, [shared.turnFiles, shared.turnFilesSessionId, shared.workspaceRoot, shared.settings.language])
  return null
}



// ---------- styles ----------
const BASE_CSS = `
.pI_x6G_frame:not([data-details-collapsed]){grid-template-columns:fit-content(420px) minmax(0,1fr) clamp(20vw,var(--codeui-review-w,42vw),60vw)!important}
.pI_x6G_frame:not([data-details-collapsed]) .pI_x6G_handle[data-side=details]{display:none!important}
.codeui-explorer-toggle{cursor:pointer;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#666);font-size:15px}
.codeui-explorer-toggle:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#222)}
.codeui-explorer{position:absolute;left:0;top:0;bottom:0;width:320px;max-width:80vw;background:var(--dsw-specific-sidebar-fill,var(--dsw-alias-bg-base,#fff));border-right:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));box-shadow:0 0 24px rgba(0,0,0,.12);display:flex;flex-direction:column;pointer-events:auto;z-index:21;animation:codeui-slide-in .18s ease}
@keyframes codeui-slide-in{from{transform:translateX(-100%)}to{transform:translateX(0)}}
.codeui-explorer-header{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;flex:none;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08))}
.codeui-explorer-title{font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,#666)}
.codeui-explorer-actions{display:flex;align-items:center;gap:4px}
.codeui-explorer-close,.codeui-explorer-refresh{cursor:pointer;border:none;background:transparent;color:var(--dsw-alias-label-secondary,#666);font-size:14px;padding:2px 6px;border-radius:4px}
.codeui-explorer-close:hover,.codeui-explorer-refresh:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}
.codeui-explorer-body{flex:1;overflow:auto;padding:4px 0;font-size:13px}
.codeui-explorer-root{padding:4px 12px;color:var(--dsw-alias-label-secondary,#777);font-size:11px;word-break:break-all;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06));margin-bottom:4px}
.codeui-explorer-git{padding:2px 12px 6px;color:var(--dsw-alias-label-secondary,#777);font-size:11px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06))}
.codeui-explorer-empty{padding:16px 12px;color:var(--dsw-alias-label-secondary,#777);font-size:12px;line-height:1.6}
.codeui-tree-row{display:flex;align-items:center;gap:4px;padding:3px 8px;cursor:pointer;white-space:nowrap}
.codeui-tree-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
.codeui-tree-chevron{width:12px;font-size:10px;color:var(--dsw-alias-label-secondary,#888);flex:none;text-align:center}
.codeui-tree-icon{flex:none;font-size:13px}
.codeui-tree-name{overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-primary,#222);flex:0 1 auto}
.codeui-git-badge{flex:none;margin-left:auto;font-size:10px;font-weight:700;padding:0 5px;border-radius:8px;color:var(--dsw-alias-label-secondary,#777)}
.codeui-git-badge-M,.codeui-git-badge-A,.codeui-git-badge-D,.codeui-git-badge-R,.codeui-git-badge-U{color:#2f81f7}
.codeui-git-badge-!{color:#f85149}
.codeui-tree-error{padding:8px 12px;color:#f85149;font-size:12px}

.codeui-diff{height:100%;display:flex;flex-direction:column;overflow:hidden;background:var(--dsw-alias-bg-base,#fff);padding-right:0;position:relative;box-sizing:border-box}
.codeui-review-resize{position:absolute;left:0;top:0;bottom:0;width:9px;cursor:col-resize;touch-action:none;z-index:45;background:transparent}
.codeui-review-resize::after{content:"";position:absolute;left:4px;top:0;bottom:0;width:2px;background:var(--dsw-alias-border-l2,rgba(0,0,0,.16));opacity:.5}
.codeui-review-resize:hover::after,.codeui-review-resize-on::after{opacity:1;background:#2f81f7}
.codeui-diff-header{display:flex;align-items:center;gap:8px;padding:10px 12px;flex:none;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08))}
.codeui-diff-title{font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,#666)}
.codeui-diff-close{margin-left:auto;cursor:pointer;border:none;background:transparent;color:var(--dsw-alias-label-secondary,#666);font-size:14px;padding:2px 6px;border-radius:4px}
.codeui-diff-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}
.codeui-running-pill{background:rgba(47,129,247,.15);color:#2f81f7;border-radius:10px;padding:1px 8px;font-size:11px}
.codeui-risk-pill{background:rgba(248,81,73,.13);color:#f85149;border-radius:10px;padding:1px 8px;font-size:11px}
.codeui-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:6px;padding:6px 12px;flex:none;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06))}
.codeui-select{font:inherit;font-size:12px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.18));border-radius:7px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#222);padding:3px 6px;max-width:220px}
.codeui-btn{font:inherit;font-size:12px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.18));border-radius:7px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#222);padding:3px 8px;cursor:pointer}
.codeui-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}
.codeui-btn:disabled{opacity:.45;cursor:default}
.codeui-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.18));border-radius:7px;overflow:hidden}
.codeui-seg-btn{border:none;background:transparent;font:inherit;font-size:11px;padding:3px 7px;cursor:pointer;color:var(--dsw-alias-label-secondary,#666)}
.codeui-seg-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}
.codeui-seg-on{background:#2f81f7;color:#fff}
.codeui-seg-on:hover{background:#2f81f7}
.codeui-msg{font-size:11px;color:var(--dsw-alias-label-secondary,#777)}
.codeui-msg-err{color:#f85149}

.codeui-tabbar{display:flex;align-items:stretch;gap:0;flex:none;overflow-x:auto;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));background:var(--dsw-specific-sidebar-fill,transparent)}
.codeui-tab{display:inline-flex;align-items:center;gap:6px;padding:7px 10px;font-size:12px;color:var(--dsw-alias-label-secondary,#666);cursor:pointer;border-bottom:2px solid transparent;white-space:nowrap;user-select:none;flex:none}
.codeui-tab:hover{color:var(--dsw-alias-label-primary,#222);background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
.codeui-tab-active{color:var(--dsw-alias-label-primary,#222);border-bottom-color:#2f81f7}
.codeui-tab-name{max-width:160px;overflow:hidden;text-overflow:ellipsis}
.codeui-tab-close{border:none;background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary,#888);font-size:12px;padding:0 3px;border-radius:3px;line-height:1;flex:none}
.codeui-tab-close:hover{color:var(--dsw-alias-label-primary,#222);background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.12))}

.codeui-diff-body{flex:1;display:flex;min-height:0}
.codeui-diff-files{flex:none;width:210px;overflow:auto;border-right:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));background:var(--dsw-specific-sidebar-fill,transparent)}
.codeui-files-title{padding:8px 12px;font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary,#666);border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06));position:sticky;top:0;background:inherit;z-index:1}
.codeui-file-row{display:flex;align-items:center;gap:5px;padding:5px 10px;cursor:pointer;border-left:2px solid transparent;font-size:12px;white-space:nowrap}
.codeui-file-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
.codeui-file-row-active{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.09));border-left-color:#2f81f7}
.codeui-file-name{overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-primary,#222)}
.codeui-file-stats{flex:none;font-size:10px;font-variant-numeric:tabular-nums}
.codeui-add-count{color:#2ea043}
.codeui-del-count{color:#f85149}
.codeui-risk-icon{flex:none;font-size:11px}
.codeui-files-empty{padding:14px 12px;color:var(--dsw-alias-label-secondary,#777);font-size:12px;line-height:1.6}
.codeui-diff-main{flex:1;display:flex;flex-direction:column;min-width:0}
.codeui-diff-content{flex:1;display:flex;flex-direction:column;min-height:0}
.codeui-diff-filepath{padding:8px 12px;font-size:12px;color:var(--dsw-alias-label-secondary,#777);border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));word-break:break-all;flex:none}
.codeui-diff-stats{flex:none;display:flex;gap:12px;padding:4px 12px;font-size:12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06))}
.codeui-diff-scroll{flex:1;overflow:auto;font-family:var(--dsh-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:12px}
.codeui-diff-empty{flex:1;overflow:auto;padding:24px 16px;color:var(--dsw-alias-label-secondary,#777);font-size:12px;line-height:1.6;white-space:pre-wrap}

.codeui-diff-row{display:flex;min-width:max-content}
.codeui-diff-gutter{width:22px;flex:none;text-align:center;color:var(--dsw-alias-label-secondary,#999);user-select:none}
.codeui-diff-num{width:40px;flex:none;text-align:right;padding-right:10px;color:var(--dsw-alias-label-secondary,#999);opacity:.7;user-select:none}
.codeui-diff-text{white-space:pre;padding-right:16px}
.codeui-diff-ctx{background:transparent}
.codeui-diff-ctx .codeui-diff-text{color:var(--dsw-alias-label-primary,#222)}
.codeui-diff-add{background:rgba(46,160,67,.14)}
.codeui-diff-add .codeui-diff-gutter{color:#2ea043}
.codeui-diff-add .codeui-diff-text{color:#1a7f37}
.codeui-diff-del{background:rgba(248,81,73,.14)}
.codeui-diff-del .codeui-diff-gutter{color:#f85149}
.codeui-diff-del .codeui-diff-text{color:#cf222e}
[data-ds-dark-theme] .codeui-diff-add .codeui-diff-text{color:#7ee787}
[data-ds-dark-theme] .codeui-diff-del .codeui-diff-text{color:#ffa198}

.codeui-split{display:flex;align-items:stretch;width:max-content;min-width:100%}
.codeui-split-row{display:flex;width:100%;min-width:max-content}
.codeui-split-pane{flex:0 0 auto;min-width:0;overflow-x:auto;overflow-y:hidden;position:relative}
.codeui-split-cell{display:flex;width:100%;min-width:0}
.codeui-split-cell .codeui-diff-gutter{width:14px;font-size:11px}
.codeui-split-cell .codeui-diff-num{width:30px;padding-right:6px}
.codeui-split-cell .codeui-diff-text{white-space:pre;padding-right:10px}
.codeui-split-divider{flex:0 0 7px;width:7px;background:var(--dsw-alias-border-l1,rgba(0,0,0,.08));cursor:col-resize;align-self:stretch;position:relative}
.codeui-split-divider:hover,.codeui-split-divider:active{background:rgba(47,129,247,.35)}
.codeui-split-del{background:rgba(248,81,73,.14)}
.codeui-split-add{background:rgba(46,160,67,.14)}
.codeui-split-del .codeui-diff-gutter{color:#f85149}
.codeui-split-add .codeui-diff-gutter{color:#2ea043}
.codeui-split-del .codeui-diff-text{color:#cf222e}
.codeui-split-add .codeui-diff-text{color:#1a7f37}
[data-ds-dark-theme] .codeui-split-del .codeui-diff-text{color:#ffa198}
[data-ds-dark-theme] .codeui-split-add .codeui-diff-text{color:#7ee787}
.codeui-file-preview{margin:0;padding:12px;overflow:auto;font-family:var(--dsh-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:12px;color:var(--dsw-alias-label-primary,#222);white-space:pre}
.codeui-textlines{display:table;min-width:100%;border-collapse:collapse}
.codeui-textrow{display:table-row}
.codeui-textnum{display:table-cell;width:44px;padding-right:10px;text-align:right;color:var(--dsw-alias-label-secondary,#999);user-select:none;opacity:.7}
.codeui-textline{display:table-cell;white-space:pre;padding-right:16px;color:var(--dsw-alias-label-primary,#222)}

.codeui-chat-flash{animation:codeui-chat-flash 1.6s ease}
@keyframes codeui-chat-flash{0%,60%{box-shadow:inset 3px 0 0 #2f81f7;background:rgba(47,129,247,.10)}100%{box-shadow:inset 3px 0 0 transparent;background:transparent}}

.codeui-rail{position:absolute;right:14px;top:0;bottom:0;width:34px;pointer-events:none;display:flex;flex-direction:column;align-items:flex-end;justify-content:center;background:transparent;z-index:30}
.codeui-rail-body{pointer-events:auto;display:flex;flex-direction:column;align-items:center;width:34px;border-radius:12px;transition:width .15s ease,background .15s ease,box-shadow .15s ease}
.codeui-rail-expanded .codeui-rail-body{width:242px;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));box-shadow:var(--dsw-shadow-lv2,0 8px 28px rgba(0,0,0,.16))}
.codeui-rail-handle{flex:none;height:18px;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary,#999);font-size:11px;cursor:default}
.codeui-rail-list{box-sizing:border-box;width:100%;height:281px;overflow-y:auto;overflow-x:hidden;display:flex;flex-direction:column;gap:5px;padding:8px 0;scrollbar-width:none}
.codeui-rail-list::-webkit-scrollbar{display:none}
.codeui-rail-turnrow{display:flex;align-items:center;justify-content:flex-end;gap:6px;min-height:22px;padding-right:6px;cursor:pointer;border-radius:8px}
.codeui-rail-turnrow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}
.codeui-rail-turnrow-selected{background:rgba(47,129,247,.10)}
.codeui-rail-question{width:0;opacity:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:12px;line-height:22px;color:var(--dsw-alias-label-primary,#222);cursor:pointer;transition:width .15s ease,opacity .15s ease}
.codeui-rail-expanded .codeui-rail-question{width:208px;opacity:1;padding:0 8px}
.codeui-rail-node{position:relative;flex:none;width:22px;height:22px;display:flex;align-items:center;justify-content:center;cursor:pointer;border-radius:6px;color:var(--dsw-alias-label-tertiary,#aaa)}
.codeui-rail-node:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.08));color:#111}
.codeui-rail-node-selected{background:rgba(47,129,247,.16);color:#2f81f7}
.codeui-rail-line{display:block;width:10px;border-radius:2px;background:currentColor}
.codeui-rail-line-thin{height:1.5px;opacity:.5}
.codeui-rail-line-thick{height:2.5px;opacity:.7}
.codeui-rail-node:hover .codeui-rail-line{background:#111;opacity:1}
.codeui-rail-node-selected .codeui-rail-line{width:12px;opacity:1;background:#2f81f7}
.codeui-rail-node-running .codeui-rail-line{background:#2f81f7;opacity:1;animation:codeui-pulse 1.1s ease-in-out infinite}
@keyframes codeui-pulse{0%,100%{opacity:.35}50%{opacity:1}}
.codeui-rail-node-error .codeui-rail-line{background:#f85149;opacity:.95}
.codeui-rail-node-warning .codeui-rail-line{background:#d29922;opacity:.95}
.codeui-rail-card{position:fixed;right:390px;transform:translateY(-50%);width:210px;max-height:78vh;overflow:hidden;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:12px;box-shadow:var(--dsw-shadow-lv2,0 8px 28px rgba(0,0,0,.16));padding:10px 12px;text-align:left;cursor:default;pointer-events:auto;z-index:50}
.codeui-rail-card-head{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#222);margin-bottom:5px}
.codeui-rail-card-status{font-size:10px;font-weight:400;border-radius:8px;padding:1px 7px;color:var(--dsw-alias-label-secondary,#777);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14))}
.codeui-rail-card-status-running{color:#2f81f7;border-color:rgba(47,129,247,.4)}
.codeui-rail-card-status-error{color:#f85149;border-color:rgba(248,81,73,.4)}
.codeui-rail-card-meta{font-size:11px;color:var(--dsw-alias-label-secondary,#777);margin-top:6px;display:flex;gap:10px;flex-wrap:wrap}
.codeui-rail-card-risk{color:#f85149}
.codeui-rail-card-files{display:flex;flex-direction:column;max-height:66px;overflow-y:scroll;overflow-x:hidden;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-border-l2,rgba(0,0,0,.22)) transparent;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06));margin-top:6px;padding-top:3px;padding-right:3px}
.codeui-rail-card-files::-webkit-scrollbar{width:8px;height:8px}
.codeui-rail-card-files::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2,rgba(0,0,0,.22));border-radius:4px}
.codeui-rail-card-files::-webkit-scrollbar-track{background:transparent}
.codeui-rail-card-file{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:21px;padding:0 2px;border-radius:4px;cursor:pointer}
.codeui-rail-card-file:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
.codeui-rail-card-file-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--dsw-alias-label-primary,#222)}
.codeui-rail-card-file-stats{flex:none;display:flex;gap:8px;font-variant-numeric:tabular-nums;font-size:11px}
.codeui-rail-card-added{color:#2ea043}
.codeui-rail-card-removed{color:#f85149}
.codeui-turn-review-card{margin-top:8px;width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff);padding:8px 10px;color:var(--dsw-alias-label-primary,#222);font-size:12px}
.codeui-turn-review-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
.codeui-turn-review-label{font-weight:600;white-space:nowrap}
.codeui-turn-review-button{flex:none;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.16));background:var(--dsw-alias-bg-layer-1,#fff);color:#2f81f7;border-radius:7px;padding:2px 10px;font-size:12px;cursor:pointer}
.codeui-turn-review-button:hover{background:rgba(47,129,247,.08)}
.codeui-turn-review-totals{display:flex;gap:14px;margin:5px 0 6px;font-weight:600}
.codeui-turn-review-added{color:#2ea043}
.codeui-turn-review-removed{color:#f85149}
.codeui-turn-review-files{display:flex;flex-direction:column;max-height:44px;overflow-y:auto;overflow-x:hidden;scrollbar-width:none;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06));padding-top:3px}
.codeui-turn-review-files::-webkit-scrollbar{display:none}
.codeui-turn-review-file{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:21px;padding:0 4px;border-radius:5px;cursor:pointer}
.codeui-turn-review-file:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
.codeui-turn-review-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--dsw-alias-label-primary,#222)}
.codeui-turn-review-file-stats{flex:none;display:flex;gap:10px;font-variant-numeric:tabular-nums}
.codeui-rail-empty{position:absolute;right:0;top:0;bottom:0;width:34px;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary,#999);font-size:11px;pointer-events:auto}
.codeui-rail-latest{position:absolute;right:4px;bottom:18px;width:24px;height:24px;pointer-events:auto;border-radius:50%;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.2));background:var(--dsw-alias-button-floating-fill,#fff);color:#2f81f7;font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:var(--dsw-shadow-lv2,0 4px 14px rgba(0,0,0,.14))}
.codeui-rail-latest:hover{background:var(--dsw-alias-button-floating-hover,#f5f5f5)}
.codeui-rail-notice{position:absolute;right:42px;bottom:18px;max-width:260px;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:9px;box-shadow:var(--dsw-shadow-lv2,0 6px 18px rgba(0,0,0,.14));padding:6px 9px;font-size:11px;color:var(--dsw-alias-label-secondary,#777);pointer-events:none}

.codeui-settings{padding:8px 4px;max-width:560px}
.codeui-settings h3{margin:0 0 4px;font-size:15px}
.codeui-settings-desc{margin:0 0 12px;color:var(--dsw-alias-label-secondary,#777);font-size:12px;line-height:1.5}
.codeui-setting-row{display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08))}
.codeui-setting-label{font-size:13px;color:var(--dsw-alias-label-primary,#222)}
.codeui-switch{position:relative;width:38px;height:22px;border-radius:11px;border:none;cursor:pointer;background:var(--dsw-alias-border-l2,rgba(0,0,0,.2));transition:background .15s;flex:none}
.codeui-switch-on{background:#2f81f7}
.codeui-switch-knob{position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;transition:transform .15s}
.codeui-switch-on .codeui-switch-knob{transform:translateX(16px)}
`

const REORDER_CSS = `
.pI_x6G_frame:not([data-details-collapsed]) .pI_x6G_centerCol{order:3}
.pI_x6G_frame:not([data-details-collapsed]) .pI_x6G_detailsCol{order:2;border-left:none;border-right:1px solid var(--dsw-alias-border-l2)}
.pI_x6G_frame:not([data-details-collapsed]) .pI_x6G_handle[data-side="details"]:after{opacity:.55}
.pI_x6G_frame:not([data-details-collapsed]) .pI_x6G_centerCol .FJxK0a_root{white-space:normal;overflow:visible;text-overflow:clip;line-height:18px;padding-bottom:2px}
.pI_x6G_frame:not([data-details-collapsed]) .pI_x6G_centerCol .uV2eYG_row{flex-wrap:wrap;row-gap:6px}
.pI_x6G_frame:not([data-details-collapsed]) .pI_x6G_centerCol .uV2eYG_trailing{flex:0 1 auto;margin-left:auto}
`


// ---------- render helpers ----------
function gitBadgeLetter(entry) {
  const y = entry && entry.y
  const x = entry && entry.x
  if (y === '?') return 'U'
  if (y === '!') return '!'
  if (y && y !== ' ') return y
  if (x && x !== ' ') return x
  return null
}
function statusLabel(t) {
  if (t.status === 'running') return tr('status_running')
  if (t.status === 'error') return tr('status_error')
  if (t.status === 'warning') return tr('status_warning')
  return tr('status_done')
}
function formatDuration(t) {
  if (t.startTime == null || t.endTime == null) return ''
  const sec = Math.max(0, Math.round((t.endTime - t.startTime) / 1000))
  if (sec < 60) return sec + 's'
  return Math.floor(sec / 60) + 'm' + (sec % 60) + 's'
}

function renderUnifiedRows(d) {
  const rows = alignedDiffRows(d.before, d.after)
  let added = 0
  let removed = 0
  const rowEls = []
  const push = function (r, side) {
    const isAdd = side === 'add'
    const cls = isAdd ? 'codeui-diff-add' : 'codeui-diff-del'
    const sign = isAdd ? '+' : '-'
    const oldNum = isAdd ? '' : (r.ln == null ? '' : String(r.ln))
    const newNum = isAdd ? (r.rn == null ? '' : String(r.rn)) : ''
    const text = isAdd ? (r.rtext || '') : (r.ltext || '')
    if (isAdd) added++; else removed++
    rowEls.push(h('div', { className: 'codeui-diff-row ' + cls, key: rowEls.length },
      h('span', { className: 'codeui-diff-gutter' }, sign),
      h('span', { className: 'codeui-diff-num' }, oldNum),
      h('span', { className: 'codeui-diff-num' }, newNum),
      h('span', { className: 'codeui-diff-text' }, text === '' ? '\u00a0' : text)
    ))
  }
  for (const r of rows) {
    if (r.t === 'ctx') {
      rowEls.push(h('div', { className: 'codeui-diff-row codeui-diff-ctx', key: rowEls.length },
        h('span', { className: 'codeui-diff-gutter' }, ' '),
        h('span', { className: 'codeui-diff-num' }, r.ln == null ? '' : String(r.ln)),
        h('span', { className: 'codeui-diff-num' }, r.rn == null ? '' : String(r.rn)),
        h('span', { className: 'codeui-diff-text' }, r.ltext === '' ? '\u00a0' : r.ltext)
      ))
    } else if (r.t === 'mod') {
      push(r, 'del')
      push(r, 'add')
    } else {
      push(r, r.t === 'add' ? 'add' : 'del')
    }
  }
  return { added: added, removed: removed, els: rowEls }
}

function splitSide(row, side) {
  const isLeft = side === 'l'
  const n = isLeft ? row.ln : row.rn
  const text = isLeft ? row.ltext : row.rtext
  const t = row.t
  const cls = 'codeui-split-cell' +
    (t === 'del' || (t === 'mod' && isLeft) ? ' codeui-split-del' : '') +
    (t === 'add' || (t === 'mod' && !isLeft) ? ' codeui-split-add' : '')
  const sign = t === 'del' ? '-' : t === 'add' ? '+' : t === 'mod' ? (isLeft ? '-' : '+') : ' '
  return h('div', { className: cls },
    h('span', { className: 'codeui-diff-gutter' }, sign),
    h('span', { className: 'codeui-diff-num' }, n == null ? '' : String(n)),
    h('span', { className: 'codeui-diff-text' }, text === '' ? '\u00a0' : text)
  )
}

function renderSplitRows(d, splitRatio, onSplitDrag) {
  const rows = alignedDiffRows(d.before, d.after)
  const leftPct = Math.max(0.05, Math.min(0.95, splitRatio == null ? 0.5 : splitRatio)) * 100
  const rightPct = 100 - leftPct
  const leftRows = []
  const rightRows = []
  for (let i = 0; i < rows.length; i++) {
    leftRows.push(h('div', { className: 'codeui-split-row', key: 'l' + i }, splitSide(rows[i], 'l')))
    rightRows.push(h('div', { className: 'codeui-split-row', key: 'r' + i }, splitSide(rows[i], 'r')))
  }
  const els = h('div', { className: 'codeui-split' },
    h('div', { className: 'codeui-split-pane', style: { width: leftPct + '%' } }, leftRows),
    h('div', {
      className: 'codeui-split-divider',
      onMouseDown: function (e) { if (onSplitDrag) onSplitDrag(e) },
      title: tr('divider_drag'),
    }),
    h('div', { className: 'codeui-split-pane', style: { width: rightPct + '%' } }, rightRows)
  )
  let added = 0
  let removed = 0
  for (const r of rows) {
    if (r.t === 'add') added++
    else if (r.t === 'del') removed++
    else if (r.t === 'mod') { added++; removed++ }
  }
  return { added: added, removed: removed, els: els }
}

function renderFullText(content, label) {
  const lines = splitLines(content)
  const rows = []
  for (let i = 0; i < lines.length; i++) {
    rows.push(h('div', { className: 'codeui-textrow', key: i },
      h('span', { className: 'codeui-textnum' }, String(i + 1)),
      h('span', { className: 'codeui-textline' }, lines[i] === '' ? '\u00a0' : lines[i])
    ))
  }
  return h('div', { className: 'codeui-diff-content' },
    h('div', { className: 'codeui-diff-filepath' }, label),
    h('div', { className: 'codeui-diff-scroll' }, h('div', { className: 'codeui-textlines' }, rows))
  )
}

// ---------- Explorer panel ----------
function ExplorerPanel(props) {
  const shared = useShared()
  const ws = props.useWorkspaces ? props.useWorkspaces(function (s) { return s }) : null
  const items = (ws && Array.isArray(ws.items)) ? ws.items : []
  const recentId = ws ? ws.recentWorkspaceId : undefined

  const [root, setRoot] = React.useState('')
  const [resolved, setResolved] = React.useState(false)
  const [tree, setTree] = React.useState({})
  const [expanded, setExpanded] = React.useState(new Set())

  function loadDir(path) {
    if (!path) return
    hostCall('listDir', { path: path }).then(function (res) {
      const entry = (res && res.ok)
        ? { dirs: (Array.isArray(res.dirs) ? res.dirs : []), files: (Array.isArray(res.files) ? res.files : []), loaded: true, error: null }
        : { dirs: [], files: [], loaded: true, error: (res && res.error) || 'load-failed' }
      setTree(function (t) { const nt = Object.assign({}, t); nt[path] = entry; return nt })
    }).catch(function (e) {
      setTree(function (t) { const nt = Object.assign({}, t); nt[path] = { dirs: [], files: [], loaded: true, error: String((e && e.message) || e) }; return nt })
    })
  }

  function refresh() {
    if (root) loadDir(root)
    if (shared.settings.showGit && root) loadGitStatus(root)
  }

  const rootRef = React.useRef('')
  React.useEffect(function () {
    let cancelled = false
    ;(async function () {
      let r = ''
      const cur = (recentId && items.find(function (w) { return w && w.workspaceId === recentId })) || items[0]
      if (cur && typeof cur.path === 'string' && cur.path !== '') r = cur.path
      else {
        try {
          const res = await hostCall('workspaceRoot', {})
          if (res && res.ok && typeof res.root === 'string') r = res.root
        } catch (e) {}
      }
      if (cancelled) return
      setResolved(true)
      patchState({ workspaceRoot: r })
      if (r !== rootRef.current) {
        rootRef.current = r
        setRoot(r)
        if (r) loadDir(r)
      }
      if (shared.settings.showGit) loadGitStatus(r)
    })()
    return function () { cancelled = true }
  }, [items, recentId, shared.settings.showGit])

  React.useEffect(function () {
    if (shared.explorerOpen && root) loadDir(root)
  }, [shared.explorerOpen, root])

  // Refresh the root listing and Git badges after a turn closes.
  const lastClosed = shared.turnView ? shared.turnView.lastClosedTurn : 0
  React.useEffect(function () {
    if (!root || lastClosed <= 0) return
    loadDir(root)
    if (shared.settings.showGit) loadGitStatus(root)
  }, [root, lastClosed, shared.settings.showGit])

  function toggleDir(path) {
    setExpanded(function (prev) {
      const next = new Set(prev)
      if (next.has(path)) { next.delete(path) }
      else { next.add(path); if (!tree[path] || !tree[path].loaded) loadDir(path) }
      return next
    })
  }

  function openFile(path) {
    if (!shared.settings.showDiff) return
    patchState({ selectedTurn: null, detailsManuallyClosed: false, railNotice: null })
    addFileTab(normPath(path))
    if (layoutRef && typeof layoutRef.openDetails === 'function') layoutRef.openDetails()
  }

  const gitMap = React.useMemo(function () {
    const map = new Map()
    if (shared.git && Array.isArray(shared.git.entries)) {
      const bases = []
      const ws = normPath(shared.workspaceRoot || '')
      const rr = normPath(shared.git.repoRoot || '')
      if (ws) bases.push(ws)
      if (rr && rr !== ws) bases.push(rr)
      for (const e of shared.git.entries) {
        const ep = normPath(e.path)
        map.set(ep, e)
        for (const base of bases) map.set(normPath(base + '/' + ep), e)
      }
    }
    return map
  }, [shared.git, shared.workspaceRoot])

  function gitEntryFor(itemPath) {
    const p = normPath(itemPath)
    let entry = gitMap.get(p)
    if (entry) return entry
    if (shared.git && Array.isArray(shared.git.entries) && shared.git.entries.length <= 500) {
      for (const e of shared.git.entries) {
        const ep = normPath(e.path)
        if (p.endsWith('/' + ep) || ep.endsWith('/' + p)) return e
      }
    }
    return null
  }

  function renderNode(item, depth, isDir) {
    const pad = 8 + depth * 14
    const isOpen = isDir && expanded.has(item.path)
    const kids = (isDir && isOpen) ? tree[item.path] : null
    const git = (isDir || !shared.settings.showGit) ? null : gitEntryFor(item.path)
    const badge = git ? gitBadgeLetter(git) : null
    const row = h('div', {
      className: 'codeui-tree-row',
      style: { paddingLeft: pad + 'px' },
      onClick: function () { if (isDir) toggleDir(item.path); else openFile(item.path) },
      title: item.path,
    },
      h('span', { className: 'codeui-tree-chevron' }, isDir ? (isOpen ? '\u25be' : '\u25b8') : ''),
      h('span', { className: 'codeui-tree-icon' }, isDir ? '\ud83d\udcc1' : '\ud83d\udcc4'),
      h('span', { className: 'codeui-tree-name' }, item.name),
      badge ? h('span', { className: 'codeui-git-badge codeui-git-badge-' + badge, title: item.path }, badge) : null
    )
    const children = []
    if (kids && kids.loaded) {
      if (kids.error) children.push(h('div', { className: 'codeui-tree-error', style: { paddingLeft: (pad + 16) + 'px' } }, kids.error))
      else {
        for (const d of kids.dirs) children.push(renderNode(d, depth + 1, true))
        for (const f of kids.files) children.push(renderNode(f, depth + 1, false))
      }
    }
    return h('div', { key: item.path }, row, children)
  }

  if (!shared.settings.showExplorer || !shared.explorerOpen) return null

  const rootEntry = root ? tree[root] : null
  let body
  if (!resolved) body = h('div', { className: 'codeui-explorer-empty' }, tr('explorer_resolving'))
  else if (!root) body = h('div', { className: 'codeui-explorer-empty' }, tr('explorer_no_root'))
  else if (rootEntry && rootEntry.error) body = h('div', { className: 'codeui-tree-error' }, rootEntry.error)
  else if (rootEntry && rootEntry.loaded) {
    const rows = []
    for (const d of rootEntry.dirs) rows.push(renderNode(d, 0, true))
    for (const f of rootEntry.files) rows.push(renderNode(f, 0, false))
    body = rows.length === 0 ? h('div', { className: 'codeui-explorer-empty' }, tr('explorer_empty')) : rows
  } else body = h('div', { className: 'codeui-explorer-empty' }, tr('explorer_loading'))

  const gitLine = shared.settings.showGit && shared.git.available
    ? h('div', { className: 'codeui-explorer-git' }, '\u2387 ' + shared.git.branch + (shared.git.upstream ? ' \u2192 ' + shared.git.upstream : '') + (shared.git.ahead ? ' \u2191' + shared.git.ahead : '') + (shared.git.behind ? ' \u2193' + shared.git.behind : ''))
    : null

  return h('div', { className: 'codeui-explorer' },
    h('div', { className: 'codeui-explorer-header' },
      h('span', { className: 'codeui-explorer-title' }, tr('explorer_title')),
      h('span', { className: 'codeui-explorer-actions' },
        h('button', { className: 'codeui-explorer-refresh', onClick: refresh, title: tr('explorer_refresh') }, '\u21bb'),
        h('button', { className: 'codeui-explorer-close', onClick: function () { patchState({ explorerOpen: false }) }, title: tr('explorer_close') }, '\u2715')
      )
    ),
    root ? h('div', { className: 'codeui-explorer-root', title: root }, root) : null,
    gitLine,
    h('div', { className: 'codeui-explorer-body' }, body)
  )
}

function ExplorerToggle() {
  const shared = useShared()
  return h('button', {
    className: 'codeui-explorer-toggle',
    title: tr('explorer_toggle'),
    onClick: function () { patchState({ explorerOpen: !shared.explorerOpen }) },
  }, '\ud83d\udcc1')
}


// ---------- turn data collector (null UI) ----------
// Mounted in a session-scoped list slot so the always-resident right rail
// receives fresh turn data even when the code-diff panel is disabled.
function TurnSync(props) {
  const snap = props.useSession ? props.useSession(function (s) { return s }) : null
  const filesMap = React.useMemo(function () { return collectFiles(snap) }, [snap])
  const turnFiles = React.useMemo(function () { return buildTurnFileSummary(filesMap) }, [filesMap])
  const model = React.useMemo(function () { return buildTurnModel(snap, filesMap) }, [snap, filesMap])
  const sessionId = snap ? snap.sessionId : ''
  const [history, setHistory] = React.useState(null)

  React.useEffect(function () {
    let cancelled = false
    if (!sessionId) { setHistory(null); return }
    hostCall('turnHistory', { sessionId: sessionId }).then(function (res) {
      if (cancelled) return
      if (res && res.ok && Array.isArray(res.turns)) {
        setHistory({ sessionId: sessionId, turns: res.turns, latestTurn: res.latestTurn, lastClosedTurn: res.lastClosedTurn })
      } else {
        setHistory(null)
      }
    }).catch(function () { if (!cancelled) setHistory(null) })
    return function () { cancelled = true }
  }, [sessionId])

  const merged = React.useMemo(function () { return mergeTurnModels(model, history) }, [model, history])
  React.useEffect(function () {
    publishTurnView(merged)
  }, [merged])
  React.useEffect(function () {
    patchState({ turnFiles: turnFiles, turnFilesSessionId: sessionId })
  }, [turnFiles, sessionId])
  return null
}

// ---------- always-resident right jump rail ----------
function JumpRail(props) {
  const shared = useShared()
  const currentId = props.useSessions ? props.useSessions(function (s) { return s && s.current }) : null
  const [railHover, setRailHover] = React.useState(false)
  const [rowHover, setRowHover] = React.useState(null)
  const trackRef = React.useRef(null)
  const cardKeepTimer = React.useRef(null)
  const model = shared.turnView
  const active = !!(model && currentId != null && model.sessionId === currentId)
  const turns = active && model ? model.turns : []
  const latestTurn = active && model ? model.latestTurn : null
  const selected = shared.selectedTurn
  const lastAutoTurn = React.useRef(null)
  const lastAutoTurnLength = React.useRef(0)

  React.useEffect(function () {
    const track = trackRef.current
    if (!track || turns.length === 0) return
    if (selected == null) {
      if (lastAutoTurn.current !== latestTurn || lastAutoTurnLength.current !== turns.length) {
        lastAutoTurn.current = latestTurn
        lastAutoTurnLength.current = turns.length
        track.scrollTop = track.scrollHeight
      }
    } else {
      const node = track.querySelector('[data-turn="' + selected + '"]')
      if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' })
    }
  }, [selected, latestTurn, turns.length])

  if (!active) {
    return h('div', { className: 'codeui-rail' },
      h('div', { className: 'codeui-rail-empty', title: tr('rail_no_session') }, '\u2502')
    )
  }

  const turnRows = turns.map(function (t, idx) {
    const isLatest = t.turn === latestTurn
    const isSelected = (selected != null && t.turn === selected) || (selected == null && isLatest)
    const nodeCls = 'codeui-rail-node' +
      (t.userSeq == null ? ' codeui-rail-node-auto' : ' codeui-rail-node-user') +
      (isSelected ? ' codeui-rail-node-selected' : '') +
      (t.status === 'running' ? ' codeui-rail-node-running' : '') +
      (t.status === 'error' ? ' codeui-rail-node-error' : '') +
      (t.status === 'warning' ? ' codeui-rail-node-warning' : '')
    const rowCls = 'codeui-rail-turnrow' + (isSelected ? ' codeui-rail-turnrow-selected' : '')
    return h('div', {
      key: t.turn,
      className: rowCls,
      'data-turn': String(t.turn),
      onClick: function () {
        setRailHover(false)
        setRowHover(null)
        chooseTurn(isLatest ? null : t.turn, model, true)
      },
    },
      h('div', {
        className: 'codeui-rail-question',
        title: t.userFull || t.userTitle || t.title || '',
        onMouseEnter: function (e) {
          if (cardKeepTimer.current) clearTimeout(cardKeepTimer.current)
          const rect = e.currentTarget.getBoundingClientRect()
          setRowHover({
            turn: t.turn,
            top: Math.min(window.innerHeight - 150, Math.max(130, rect.top + rect.height / 2)),
            right: window.innerWidth - rect.left + 12,
          })
        },
        onMouseLeave: function () {
          if (cardKeepTimer.current) clearTimeout(cardKeepTimer.current)
          cardKeepTimer.current = setTimeout(function () {
            setRowHover(function (prev) { return prev && prev.turn === t.turn ? null : prev })
          }, 160)
        },
      }, t.userTitle || t.title || tr('turn_no_question')),
      h('div', { className: nodeCls, title: tr('turn_label', { n: t.turn }) },
        h('span', { className: 'codeui-rail-line ' + (idx % 2 === 0 ? 'codeui-rail-line-thin' : 'codeui-rail-line-thick') })
      )
    )
  })

  let hoverCard = null
  if (rowHover) {
    const ht = model.turns.find(function (t) { return t.turn === rowHover.turn })
    if (ht) {
      const sessionOk = shared.turnFilesSessionId && shared.turnView && shared.turnFilesSessionId === shared.turnView.sessionId
      const turnSummary = sessionOk && shared.turnFiles ? shared.turnFiles[ht.turn] : null
      const historyFiles = Array.isArray(ht.files) ? ht.files : []
      const cardFiles = turnSummary && Array.isArray(turnSummary.files) && turnSummary.files.length ? turnSummary.files : historyFiles
      const fileCount = cardFiles.length || ht.fileCount || 0
      const fileRows = cardFiles.map(function (f) {
        return h('div', {
          key: f.path,
          className: 'codeui-rail-card-file',
          title: f.path,
          onClick: function () { openReviewFile(ht.turn, f.path) },
        },
          h('span', { className: 'codeui-rail-card-file-path' }, reviewDisplayPath(f.path, shared.workspaceRoot)),
          h('span', { className: 'codeui-rail-card-file-stats' },
            h('span', { className: 'codeui-rail-card-added' }, '+' + f.added),
            h('span', { className: 'codeui-rail-card-removed' }, '-' + f.removed)
          )
        )
      })
      const clearHoverSoon = function () {
        if (cardKeepTimer.current) clearTimeout(cardKeepTimer.current)
        cardKeepTimer.current = setTimeout(function () {
          setRailHover(false)
          setRowHover(function (prev) { return prev && prev.turn === ht.turn ? null : prev })
        }, 140)
      }
      hoverCard = h('div', {
        className: 'codeui-rail-card',
        style: { top: rowHover.top + 'px', right: (rowHover.right != null ? rowHover.right : 390) + 'px' },
        onMouseEnter: function () { if (cardKeepTimer.current) clearTimeout(cardKeepTimer.current); setRailHover(true) },
        onMouseLeave: clearHoverSoon,
        onWheel: function (e) {
          if (e && e.currentTarget) {
            const list = e.currentTarget.querySelector('.codeui-rail-card-files')
            if (list) list.scrollTop += (e.deltaY || 0)
            if (e.preventDefault) e.preventDefault()
            if (e.stopPropagation) e.stopPropagation()
          }
        },
      },
        h('div', { className: 'codeui-rail-card-head' },
          h('span', null, tr('turn_label', { n: ht.turn })),
          h('span', { className: 'codeui-rail-card-status codeui-rail-card-status-' + ht.status }, statusLabel(ht))
        ),
        fileRows.length ? h('div', { className: 'codeui-rail-card-files' }, fileRows) : null,
        h('div', { className: 'codeui-rail-card-meta' },
          fileCount ? h('span', null, tr('files_changed_meta', { n: fileCount })) : null,
          formatDuration(ht) ? h('span', null, formatDuration(ht)) : null
        )
      )
    }
  }

  const notice = shared.railNotice
    ? h('div', { className: 'codeui-rail-notice' }, shared.railNotice)
    : null

  return h('div', {
    className: 'codeui-rail' + (railHover ? ' codeui-rail-expanded' : ''),
  },
    h('div', {
      className: 'codeui-rail-body',
      onMouseEnter: function () { if (cardKeepTimer.current) clearTimeout(cardKeepTimer.current); setRailHover(true) },
      onMouseLeave: function () {
        if (cardKeepTimer.current) clearTimeout(cardKeepTimer.current)
        cardKeepTimer.current = setTimeout(function () {
          setRailHover(false)
          setRowHover(null)
        }, 280)
      },
    },
      h('div', { className: 'codeui-rail-handle', title: tr('rail_nav') }, '\u2502'),
      h('div', { className: 'codeui-rail-list', ref: trackRef }, turnRows)
    ),
    hoverCard,
    notice
  )
}

// ---------- middle editor (details column) ----------
function DiffPanel(props) {
  const shared = useShared()
  const snap = props.useSession ? props.useSession(function (s) { return s }) : null
  const filesMap = React.useMemo(function () { return collectFiles(snap) }, [snap])
  const rawTurnModel = React.useMemo(function () { return buildTurnModel(snap, filesMap) }, [snap, filesMap])
  // Prefer the merged full-history view published by TurnSync so the turn
  // selector and file list always see every turn, including unloaded history.
  const turnModel = (shared.turnView && snap && shared.turnView.sessionId === snap.sessionId) ? shared.turnView : rawTurnModel
  const [diffs, setDiffs] = React.useState(versionCache.maps || {})
  const [diffLoading, setDiffLoading] = React.useState({})
  const [viewMode, setViewMode] = React.useState('unified')
  const [filesOpen, setFilesOpen] = React.useState(false)
  const [patchMsg, setPatchMsg] = React.useState(null)
  const [cumulative, setCumulative] = React.useState(null)
  const [cumLoading, setCumLoading] = React.useState(false)
  const [splitRatio, setSplitRatio] = React.useState(0.5)
  const [resizing, setResizing] = React.useState(false)
  const lastAutoOpenSession = React.useRef(null)
  const lastAutoOpenTime = React.useRef(0)
  const lastAutoOpenSince = React.useRef(0)
  const lastAutoTurnSession = React.useRef(null)

  // Reset the raw cumulative patch view when switching sessions.
  React.useEffect(function () {
    setCumulative(null)
    setPatchMsg(null)
  }, [snap && snap.sessionId])

  // Switching conversations must never leave/auto-open the Review panel.
  // Use a module-level marker so this also works when the details slot
  // unmounts and remounts during the switch.
  React.useEffect(function () {
    const sid = snap && snap.sessionId
    if (!sid) return
    if (lastReviewSessionId !== null && lastReviewSessionId !== sid) {
      const close = function () {
        if (layoutRef && typeof layoutRef.closeDetails === 'function') layoutRef.closeDetails()
      }
      close()
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(close)
    }
    lastReviewSessionId = sid
  }, [snap && snap.sessionId])

  const validSelected = shared.selectedTurn != null && turnModel.turns.some(function (t) { return t.turn === shared.selectedTurn })
  const effectiveTurn = validSelected ? shared.selectedTurn : null
  const currentTurn = effectiveTurn != null
    ? turnModel.turns.find(function (t) { return t.turn === effectiveTurn })
    : (turnModel.turns.length ? turnModel.turns[turnModel.turns.length - 1] : null)
  const selectedIdx = effectiveTurn == null ? -1 : turnModel.turns.findIndex(function (t) { return t.turn === effectiveTurn })
  // When following the latest, scope the file list to the newest turn instead
  // of showing the accumulated changes from the whole session.
  const displayTurn = effectiveTurn != null ? effectiveTurn : (currentTurn ? currentTurn.turn : null)
  // Merge full-history file ops for the selected turn so unloaded old turns
  // still render real tool-argument diffs in the Review panel.
  const effectiveFilesMap = React.useMemo(function () { return mergeHistoryFilesMap(filesMap, turnModel, displayTurn) }, [filesMap, turnModel, displayTurn])

  // Keep the shared collector in sync too (cheap, same memo inputs).
  React.useEffect(function () {
    publishTurnView(rawTurnModel)
  }, [rawTurnModel])

  // A new turn in the SAME session gives a fresh chance to auto-open the
  // panel. Switching sessions must never reset or open anything.
  React.useEffect(function () {
    const sid = snap && snap.sessionId
    if (!sid) return
    if (lastAutoTurnSession.current !== sid) { lastAutoTurnSession.current = sid; return }
    patchState({ detailsManuallyClosed: false })
  }, [snap && snap.sessionId, turnModel.latestTurn])

  // Auto-open the Review panel only when a NEW edit arrives in the current
  // session (detected by a newer operation time). Loading older history and
  // switching sessions do not increase the latest edit time, so they never
  // auto-open the panel.
  React.useEffect(function () {
    const sid = snap && snap.sessionId
    const latest = latestEditedPath(filesMap)
    const latestTime = latest && filesMap.get(latest) ? (filesMap.get(latest).lastTime || 0) : 0
    if (!sid) { lastAutoOpenSession.current = null; lastAutoOpenTime.current = 0; lastAutoOpenSince.current = 0; return }
    if (lastAutoOpenSession.current !== sid) {
      lastAutoOpenSession.current = sid
      lastAutoOpenSince.current = Date.now()
      lastAutoOpenTime.current = latestTime
      if (latest) focusTab(latest)
      return
    }
    if (latest && latestTime > lastAutoOpenTime.current) {
      lastAutoOpenTime.current = latestTime
      // Only open when this edit was created after the session became
      // current. Existing history loaded on open/switch/load-older has an
      // older timestamp and must never auto-open the panel.
      if (latestTime >= lastAutoOpenSince.current && shared.settings.showDiff && !shared.detailsManuallyClosed && layoutRef) layoutRef.openDetails()
      focusTab(latest)
    }
  }, [filesMap])

  // Recompute per-turn full-content versions whenever the op set changes.
  React.useEffect(function () {
    const sig = versionSignature(effectiveFilesMap)
    if (versionCache.sig === sig && versionCache.maps) { setDiffs(versionCache.maps); setDiffLoading({}); return }
    let cancelled = false
    const paths = Array.from(effectiveFilesMap.keys())
    const loading = {}
    for (const p of paths) loading[p] = true
    setDiffLoading(loading)
    Promise.all(paths.map(function (p) {
      return computeVersionMap(p, effectiveFilesMap.get(p).ops).then(function (r) { return { path: p, r: r } }).catch(function () { return { path: p, r: { current: '', turns: {}, error: true } } })
    })).then(function (results) {
      if (cancelled) return
      const next = {}
      for (const item of results) next[item.path] = item.r
      versionCache.sig = sig
      versionCache.maps = next
      setDiffs(next)
      setDiffLoading({})
    })
    return function () { cancelled = true }
  }, [effectiveFilesMap])

  // Keep the tab set in sync with changed files.
  React.useEffect(function () { syncTabs(filesMap) }, [filesMap])

  // While running, prioritize the file currently being edited — but never
  // yank the user away from a historical turn they are reviewing.
  React.useEffect(function () {
    if (!snap || !snap.running || shared.selectedTurn != null) return
    const rp = runningEditPaths(snap)
    if (rp.length > 0) focusTab(rp[0].path)
  }, [snap])

  if (!shared.settings.showDiff) return null

  const close = function () {
    patchState({ detailsManuallyClosed: true })
    if (layoutRef) layoutRef.closeDetails()
  }
  function startReviewResize(e) {
    if (!e || (e.button != null && e.button !== 0)) return
    if (e.preventDefault) e.preventDefault()
    if (e.stopPropagation) e.stopPropagation()
    const handle = e.currentTarget
    const startX = e.clientX
    const startPct = reviewWidthPct()
    setResizing(true)
    if (document && document.body) { document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none' }
    const move = function (ev) {
      if (ev && typeof ev.clientX === 'number') setReviewWidthPct(startPct + ((startX - ev.clientX) / (window.innerWidth || 1)) * 100)
    }
    const up = function () {
      if (handle && handle.removeEventListener) {
        handle.removeEventListener('pointermove', move)
        handle.removeEventListener('pointerup', up)
        handle.removeEventListener('pointercancel', up)
      }
      if (document && document.body) { document.body.style.cursor = ''; document.body.style.userSelect = '' }
      setResizing(false)
    }
    if (handle && handle.setPointerCapture && typeof e.pointerId === 'number') {
      try { handle.setPointerCapture(e.pointerId) } catch (err) {}
    }
    if (handle && handle.addEventListener) {
      handle.addEventListener('pointermove', move)
      handle.addEventListener('pointerup', up)
      handle.addEventListener('pointercancel', up)
    }
  }
  const activeTab = shared.activePath ? findTab(shared.activePath) : null
  const changedPaths = changedPathsForTurn(effectiveFilesMap, displayTurn).sort(function (a, b) {
    const fa = effectiveFilesMap.get(a)
    const fb = effectiveFilesMap.get(b)
    return ((fb && fb.lastTime) || 0) - ((fa && fa.lastTime) || 0)
  })

  function chooseReviewTurn(turnNumber) {
    chooseTurn(turnNumber, turnModel, false)
    setFilesOpen(true)
  }
  function selectTurnFromSelect(value) {
    chooseReviewTurn(value === 'latest' ? null : Number(value))
  }
  function stepTurn(delta) {
    if (!turnModel.turns.length) return
    const idx = effectiveTurn == null ? turnModel.turns.length - 1 : turnModel.turns.findIndex(function (t) { return t.turn === effectiveTurn })
    const next = turnModel.turns[Math.min(turnModel.turns.length - 1, Math.max(0, idx + delta))]
    if (next) chooseReviewTurn(next.turn)
  }
  function reloadVersions() {
    clearVersionCache()
    setDiffs({})
    const sig = versionSignature(effectiveFilesMap)
    const paths = Array.from(effectiveFilesMap.keys())
    const loading = {}
    for (const p of paths) loading[p] = true
    setDiffLoading(loading)
    Promise.all(paths.map(function (p) {
      return computeVersionMap(p, effectiveFilesMap.get(p).ops).then(function (r) { return { path: p, r: r } }).catch(function () { return { path: p, r: { current: '', turns: {}, error: true } } })
    })).then(function (results) {
      const next = {}
      for (const item of results) next[item.path] = item.r
      versionCache.sig = sig
      versionCache.maps = next
      setDiffs(next)
      setDiffLoading({})
    })
  }
  function exportPatch() {
    if (!shared.workspaceRoot) { setPatchMsg(tr('diff_workspace_missing')); return }
    setPatchMsg(tr('diff_exporting'))
    hostCall('gitDiff', { path: shared.workspaceRoot }).then(function (res) {
      if (res && res.ok) {
        if (res.diff) { downloadPatch(res.diff); setPatchMsg(tr('diff_exported')) }
        else setPatchMsg(tr('diff_no_head_diff'))
      } else {
        setPatchMsg(tr('git_unavailable') + ((res && res.error) || 'unknown'))
      }
    }).catch(function (e) { setPatchMsg(tr('git_unavailable') + String((e && e.message) || e)) })
  }
  function showCumulative() {
    if (cumulative != null) { setCumulative(null); return }
    if (!shared.workspaceRoot) { setPatchMsg(tr('diff_workspace_missing')); return }
    setCumLoading(true)
    setPatchMsg(null)
    hostCall('gitDiff', { path: shared.workspaceRoot }).then(function (res) {
      setCumLoading(false)
      if (res && res.ok) {
        setCumulative(res.diff || '')
        if (!res.diff) setPatchMsg(tr('diff_no_head_diff'))
      } else {
        setCumulative(null)
        setPatchMsg(tr('git_unavailable') + ((res && res.error) || 'unknown'))
      }
    }).catch(function (e) {
      setCumLoading(false)
      setCumulative(null)
      setPatchMsg(tr('git_unavailable') + String((e && e.message) || e))
    })
  }
    function beginSplitDrag(e) {
      if (e && e.preventDefault) e.preventDefault()
      const scroller = e.currentTarget && e.currentTarget.closest ? e.currentTarget.closest('.codeui-diff-scroll') : null
      if (!scroller) return
      const rect = scroller.getBoundingClientRect()
      if (!rect || rect.width <= 0) return
      const startX = e.clientX
      const startRatio = splitRatio
      let latest = startRatio
      let scheduled = false
      const move = function (ev) {
        latest = Math.max(0.05, Math.min(0.95, startRatio + (ev.clientX - startX) / rect.width))
        if (scheduled) return
        scheduled = true
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(function () { scheduled = false; setSplitRatio(latest) })
        } else {
          scheduled = false
          setSplitRatio(latest)
        }
      }
      const up = function () {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    }

  const turnOptions = turnModel.turns.map(function (t) {
    return h('option', { key: t.turn, value: String(t.turn) }, tr('turn_label', { n: t.turn }) + ' · ' + truncate(t.title || '', 22))
  })
  const turnSelect = h('select', { className: 'codeui-select', value: effectiveTurn == null ? 'latest' : String(effectiveTurn), onChange: function (e) { selectTurnFromSelect(e.target.value) } },
    h('option', { value: 'latest' }, turnModel.latestTurn ? tr('diff_latest', { n: turnModel.latestTurn }) : tr('diff_latest_none')),
    turnOptions
  )

  const fileRows = changedPaths.map(function (path) {
    const f = effectiveFilesMap.get(path)
    const vm = diffs[path]
    const key = displayTurn != null ? displayTurn : (f ? f.lastTurn : null)
    const delta = fileTurnDelta(path, key, effectiveFilesMap)
    let added = null
    let removed = null
    if (delta && (delta.added || delta.removed)) {
      added = delta.added
      removed = delta.removed
    } else if (vm && key != null && vm.turns[key]) {
      added = vm.turns[key].added
      removed = vm.turns[key].removed
    }
    const loading = diffLoading[path]
    const risk = f && f.risk && f.risk.level !== 'none'
    const isActive = activeTab && activeTab.path === path
    return h('div', {
      key: path,
      className: 'codeui-file-row' + (isActive ? ' codeui-file-row-active' : ''),
      onClick: function () { const existing = findTab(path); if (existing) focusTab(path); else addFileTab(path) },
      title: path,
    },
      risk ? h('span', { className: 'codeui-risk-icon', title: (f.risk.reasons || []).join('；') }, '\u26a0') : null,
      h('span', { className: 'codeui-file-name' }, baseName(path)),
      loading ? h('span', { className: 'codeui-file-stats' }, '…')
        : h('span', { className: 'codeui-file-stats' },
            added != null ? h('span', { className: 'codeui-add-count' }, '+' + added) : null,
            added != null && removed != null ? ' ' : null,
            removed != null ? h('span', { className: 'codeui-del-count' }, '-' + removed) : null
          )
    )
  })

  const filePanel = filesOpen
    ? h('div', { className: 'codeui-diff-files' },
        h('div', { className: 'codeui-files-title' },
          tr('files_title', { n: changedPaths.length }),
          h('button', { className: 'codeui-btn', style: { marginLeft: 6, padding: '0 5px' }, onClick: function () { setFilesOpen(false) }, title: tr('files_collapse') }, '\u25c0')
        ),
        changedPaths.length ? fileRows : h('div', { className: 'codeui-files-empty' }, tr('files_none'))
      )
    : null

  const tabBar = h('div', { className: 'codeui-tabbar' },
    !filesOpen ? h('button', { className: 'codeui-btn', style: { margin: '4px' }, onClick: function () { setFilesOpen(true) }, title: tr('files_expand') }, '\u25b6') : null,
    shared.tabs.map(function (t) {
      return h('div', {
        key: t.path,
        className: 'codeui-tab' + (t.path === shared.activePath ? ' codeui-tab-active' : ''),
        title: t.path,
        onClick: function () { focusTab(t.path) },
      },
        h('span', { className: 'codeui-tab-name' }, baseName(t.path)),
        h('button', { className: 'codeui-tab-close', title: tr('explorer_close'), onClick: function (e) { e.stopPropagation(); closeTab(t.path) } }, '\u2715')
      )
    })
  )

  let body
  if (cumulative != null) {
    body = h('div', { className: 'codeui-diff-content' },
      h('div', { className: 'codeui-diff-filepath' }, tr('diff_cumulative_label') + (shared.git.branch || shared.workspaceRoot)),
      h('div', { className: 'codeui-diff-scroll' }, h('pre', { className: 'codeui-file-preview' }, cumulative === '' ? tr('diff_no_changes') : cumulative))
    )
  } else if (!activeTab) {
    body = h('div', { className: 'codeui-diff-empty' },
      tr('diff_empty')
    )
  } else {
    const activePathKey = mergePathKey(activeTab.path, effectiveFilesMap)
    const vm = diffs[activePathKey]
    const loading = diffLoading[activePathKey]
    const isChanged = effectiveFilesMap.has(activePathKey)
    if (isChanged && loading) {
      body = h('div', { className: 'codeui-diff-empty' }, tr('diff_calculating'))
    } else if (isChanged && vm) {
      const key = latestTurnForFile(vm, effectiveTurn)
      let d = key != null ? vm.turns[key] : null
      const delta = key != null ? fileTurnDelta(activePathKey, key, effectiveFilesMap) : null
      if (!d && delta && (delta.added || delta.removed)) d = { before: '', after: '', added: delta.added, removed: delta.removed, synthetic: true }
      if (d) {
        const mismatch = !!(delta && (delta.added !== d.added || delta.removed !== d.removed))
        const useToolDelta = !!(d.synthetic || mismatch)
        const mode = viewMode
        if (mode === 'before') body = useToolDelta ? renderFullText(toolDeltaText(activePathKey, key, effectiveFilesMap, 'before'), activeTab.path + ' · ' + tr('diff_turn_before', { n: key })) : renderFullText(d.before, activeTab.path + ' · ' + tr('diff_turn_before', { n: key }))
        else if (mode === 'after') body = useToolDelta ? renderFullText(toolDeltaText(activePathKey, key, effectiveFilesMap, 'after'), activeTab.path + ' · ' + tr('diff_turn_after', { n: key })) : renderFullText(d.after, activeTab.path + ' · ' + tr('diff_turn_after', { n: key }))
        else if (mode === 'current') body = vm && vm.current != null ? renderFullText(vm.current, activeTab.path + ' · ' + tr('diff_current_disk')) : renderToolDeltaView(activePathKey, key, effectiveFilesMap)
        else if (mode === 'unified') {
          const r = useToolDelta ? renderToolDeltaRows(activePathKey, key, effectiveFilesMap) : renderUnifiedRows(d)
          const shown = delta || r
          body = h('div', { className: 'codeui-diff-content' },
            h('div', { className: 'codeui-diff-filepath', title: activeTab.path }, activeTab.path + tr('diff_turn_suffix', { n: key })),
            h('div', { className: 'codeui-diff-stats' },
              h('span', { className: 'codeui-add-count' }, '+' + shown.added + ' ' + tr('diff_added')),
              h('span', { className: 'codeui-del-count' }, '-' + shown.removed + ' ' + tr('diff_removed'))
            ),
            h('div', { className: 'codeui-diff-scroll' }, r.els.length ? r.els : h('div', { className: 'codeui-diff-empty' }, tr('diff_no_changes')))
          )
        } else {
          const r = useToolDelta ? renderSplitRows({ before: toolDeltaText(activePathKey, key, effectiveFilesMap, 'before'), after: toolDeltaText(activePathKey, key, effectiveFilesMap, 'after') }, splitRatio, beginSplitDrag) : renderSplitRows(d, splitRatio, beginSplitDrag)
          const shown = delta || r
          body = h('div', { className: 'codeui-diff-content' },
            h('div', { className: 'codeui-diff-filepath', title: activeTab.path }, activeTab.path + tr('diff_turn_suffix', { n: key })),
            h('div', { className: 'codeui-diff-stats' },
              h('span', { className: 'codeui-add-count' }, '+' + shown.added + ' ' + tr('diff_added')),
              h('span', { className: 'codeui-del-count' }, '-' + shown.removed + ' ' + tr('diff_removed'))
            ),
            h('div', { className: 'codeui-diff-scroll' }, r.els)
          )
        }
      } else {
        body = h('div', { className: 'codeui-diff-empty' }, tr('diff_no_version'))
      }
    } else if (activeTab.loading) {
      body = h('div', { className: 'codeui-diff-empty' }, tr('diff_loading'))
    } else if (activeTab.error) {
      body = h('div', { className: 'codeui-tree-error' }, activeTab.error)
    } else if (activeTab.content != null) {
      body = renderFullText(activeTab.content, activeTab.path + ' · ' + tr('diff_preview'))
    } else {
      body = h('div', { className: 'codeui-diff-empty' }, tr('diff_no_content'))
    }
  }

  const riskCount = (currentTurn && currentTurn.files || []).reduce(function (n, path) {
    const f = filesMap.get(path)
    return n + (f && f.risk && f.risk.level !== 'none' ? 1 : 0)
  }, 0)

  const resizeHandle = h('div', { className: 'codeui-review-resize' + (resizing ? ' codeui-review-resize-on' : ''), onPointerDown: startReviewResize })
  return h('div', { className: 'codeui-diff' },
    resizeHandle,
    h('div', { className: 'codeui-diff-header' },
      h('span', { className: 'codeui-diff-title' }, tr('diff_title')),
      (snap && snap.running) ? h('span', { className: 'codeui-running-pill' }, tr('diff_running')) : null,
      riskCount ? h('span', { className: 'codeui-risk-pill', title: tr('diff_risk_title') }, '\u26a0 ' + riskCount) : null,
      h('button', { className: 'codeui-diff-close', type: 'button', onClick: close, title: tr('explorer_close') }, '\u2715')
    ),
    h('div', { className: 'codeui-toolbar' },
      h('button', { className: 'codeui-btn', onClick: function () { stepTurn(-1) }, disabled: turnModel.turns.length < 2 || (effectiveTurn != null && selectedIdx <= 0), title: tr('diff_prev') }, '\u2039'),
      turnSelect,
      h('button', { className: 'codeui-btn', onClick: function () { stepTurn(1) }, disabled: turnModel.turns.length < 2 || effectiveTurn == null, title: tr('diff_next') }, '\u203a'),
      h('span', { className: 'codeui-seg' },
        h('button', { className: 'codeui-seg-btn' + (viewMode === 'unified' ? ' codeui-seg-on' : ''), onClick: function () { setViewMode('unified') } }, tr('diff_view_unified')),
        h('button', { className: 'codeui-seg-btn' + (viewMode === 'split' ? ' codeui-seg-on' : ''), onClick: function () { setViewMode('split') } }, tr('diff_view_split')),
        h('button', { className: 'codeui-seg-btn' + (viewMode === 'before' ? ' codeui-seg-on' : ''), onClick: function () { setViewMode('before') } }, tr('diff_view_before')),
        h('button', { className: 'codeui-seg-btn' + (viewMode === 'after' ? ' codeui-seg-on' : ''), onClick: function () { setViewMode('after') } }, tr('diff_view_after')),
        h('button', { className: 'codeui-seg-btn' + (viewMode === 'current' ? ' codeui-seg-on' : ''), onClick: function () { setViewMode('current') } }, tr('diff_view_current'))
      ),
      h('button', { className: 'codeui-btn', onClick: reloadVersions, title: tr('diff_reload') }, '\u21bb'),
      h('button', { className: 'codeui-btn', onClick: showCumulative, disabled: cumLoading, title: tr('diff_cumulative_title') }, cumLoading ? tr('diff_reading') : (cumulative != null ? tr('diff_cumulative_close') : tr('diff_cumulative'))),
      h('button', { className: 'codeui-btn', onClick: exportPatch, title: tr('diff_export_title') }, tr('diff_export')),
      patchMsg ? h('span', { className: patchMsg.indexOf('不可用') >= 0 || patchMsg.indexOf('unavailable') >= 0 ? 'codeui-msg codeui-msg-err' : 'codeui-msg' }, patchMsg) : null
    ),
    h('div', { className: 'codeui-diff-body' },
      filePanel,
      h('div', { className: 'codeui-diff-main' },
        tabBar,
        body
      )
    )
  )
}


// ---------- settings page ----------
function CodeUISettings() {
  const shared = useShared()
  function toggle(key) {
    patchState({ settings: Object.assign({}, shared.settings, { [key]: !shared.settings[key] }) })
  }
  function row(label, key) {
    return h('label', { className: 'codeui-setting-row' },
      h('span', { className: 'codeui-setting-label' }, label),
      h('button', {
        className: 'codeui-switch' + (shared.settings[key] ? ' codeui-switch-on' : ''),
        role: 'switch',
        'aria-checked': shared.settings[key] ? 'true' : 'false',
        onClick: function (e) { e.preventDefault(); toggle(key) },
      }, h('span', { className: 'codeui-switch-knob' }))
    )
  }
  function languageRow() {
    return h('label', { className: 'codeui-setting-row' },
      h('span', { className: 'codeui-setting-label' }, tr('settings_language')),
      h('select', {
        className: 'codeui-select',
        value: shared.settings.language || 'auto',
        onChange: function (e) {
          patchState({ settings: Object.assign({}, shared.settings, { language: e.target.value }) })
        },
      },
        h('option', { value: 'auto' }, tr('language_auto')),
        h('option', { value: 'zh-CN' }, tr('language_zh')),
        h('option', { value: 'en' }, tr('language_en'))
      )
    )
  }
  return h('div', { className: 'codeui-settings' },
    h('h3', null, 'Code UI'),
    h('p', { className: 'codeui-settings-desc' }, tr('settings_desc')),
    row(tr('settings_show_explorer'), 'showExplorer'),
    row(tr('settings_show_diff'), 'showDiff'),
    row(tr('settings_show_git'), 'showGit'),
    languageRow(),
  )
}

// Layout panel actions are wired only after the Harness root entry mounts.
// Running this from apply() is too early on newer Harness builds.
function LayoutSync() {
  React.useEffect(function () {
    let last = state.settings.showDiff
    function sync() {
      if (!layoutRef) return
      // Only close when the user disables the panel. Enabling it must NOT
      // auto-open the Review panel.
      if (!last) layoutRef.closeDetails()
    }
    sync()
    return subscribe(function () {
      if (state.settings.showDiff === last) return
      last = state.settings.showDiff
      sync()
    })
  }, [])
  return null
}

function apply(ctx) {
  const slots = ctx.get('slots')
  if (slots === undefined) return
  const layout = ctx.get('layout')
  layoutRef = layout
  captureSessionService(ctx)

  ctx.effect(function () { return insertCss(BASE_CSS, 'base') })

  // Always-resident right jump rail (root overlay; independent of details).
  slots.inject('shell.overlay', function () { return slots.register({ name: 'shell.overlay', id: 'codeui-layout-sync', order: -100 }, LayoutSync) })
  slots.inject('shell.overlay', function () { return slots.register({ name: 'shell.overlay', id: 'codeui-jump-rail', order: 60, label: function () { return tr('slot_rail') } }, JumpRail) })
  slots.inject('shell.overlay', function () { return slots.register({ name: 'shell.overlay', id: 'codeui-review-dom', order: 61 }, ReviewCardDomBridge) })

  // Session-scoped null collector that keeps the rail fed with turn data.
  slots.inject('conversation.session.header.utilities', function () { return slots.register({ name: 'conversation.session.header.utilities', id: 'codeui-turn-sync', order: 100, label: function () { return tr('slot_turn_sync') } }, TurnSync) })

  slots.inject('shell.overlay', function () { return slots.register({ name: 'shell.overlay', id: 'codeui-explorer', order: 0 }, ExplorerPanel) })
  slots.inject('sidebar.footer.action', function () { return slots.register({ name: 'sidebar.footer.action', id: 'codeui-explorer-toggle', order: 0, label: function () { return tr('slot_explorer') } }, ExplorerToggle) })
  // `details` is a single slot; use a lower priority to shadow the built-in
  // registration without colliding with its default priority 0.
  slots.inject('details', function () { return slots.register({ name: 'details', priority: -100, label: function () { return tr('diff_title') } }, DiffPanel) })
  slots.inject('settings.section', function () { return slots.register({ name: 'settings.section', id: 'codeui', order: 100, label: function () { return tr('slot_settings') } }, CodeUISettings) })
}

    exports.apply = apply;
    return module.exports;
  }
});
