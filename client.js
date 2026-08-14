/**
 * Code UI — Client half.
 *
 * Layout
 *   - File explorer: additive left-docked overlay (`shell.overlay`) + a toggle
 *     button in `sidebar.footer.action`. We intentionally do NOT replace the
 *     `sidebar` slot because that would remove the Settings panel and the
 *     plugin list.
 *   - Middle editor: replaces the `details` slot (auto-opened via
 *     `ctx.layout.openDetails()`). It renders a horizontal TAB BAR of open
 *     files and shows ONE continuous diff of the full file — green additions,
 *     red deletions, neutral context — relative to the PREVIOUS turn's full
 *     content. While the agent is running, it auto-focuses the file currently
 *     being edited.
 *   - Chat on the right: a CSS `order` reorder of the frame's grid columns,
 *     scoped to `:not([data-details-collapsed])`. Toggleable from Settings.
 *
 * Plain-JavaScript function body that returns a Cordis Plugin.
 */
const h = React.createElement

// ---------- shared in-memory state (process-local, per skill guidance) ----------
const state = {
  explorerOpen: false,
  tabs: [],            // [{ path, content, loading, error, auto, lastTime }]
  activePath: null,    // selected tab path
  dismissed: new Map(),// path -> lastTime at dismissal (changed files the user closed)
  settings: { showExplorer: true, showDiff: true, reorderLayout: true },
}
const listeners = new Set()
function notify() { for (const fn of Array.from(listeners)) { try { fn() } catch (e) {} } }
function subscribe(fn) { listeners.add(fn); return function () { listeners.delete(fn) } }
function patchState(patch) { Object.assign(state, patch); notify() }
function useShared() {
  const [, force] = React.useState(0)
  React.useEffect(function () { return subscribe(function () { force(function (n) { return n + 1 }) }) }, [])
  return state
}

// ---------- tab helpers ----------
function findTab(path) { for (const t of state.tabs) if (t.path === path) return t; return null }
function focusTab(path) { if (state.activePath !== path) { state.activePath = path; notify() } }
function loadContent(tab) {
  tab.loading = true
  notify()
  host.call('codeui.readFile', { path: tab.path }).then(function (res) {
    if (findTab(tab.path) !== tab) return
    if (res && res.ok) { tab.content = res.content; tab.loading = false; tab.error = null }
    else { tab.content = null; tab.loading = false; tab.error = (res && res.error) || 'read-failed' }
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

// ---------- diff helpers ----------
function baseName(p) {
  const s = String(p || '')
  const parts = s.split(/[\\/]/)
  return parts[parts.length - 1] || s
}
function splitLines(text) { return (text == null || text === '') ? [] : String(text).split('\n') }
function countLines(text) { return (text == null || text === '') ? 0 : String(text).split('\n').length }

// Common prefix + suffix line diff over FULL contents. Produces a single
// continuous sequence: `add`/`ctx` rows carry the CURRENT file's line number
// (1..N, never restarting); `del` rows are removed lines (no number).
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

function parseArgs(raw) {
  if (typeof raw !== 'string' || raw === '') return null
  try { return JSON.parse(raw) } catch (e) { return null }
}
function pickPath(args) {
  if (args && typeof args.file_path === 'string' && args.file_path !== '') return args.file_path
  if (args && typeof args.path === 'string' && args.path !== '') return args.path
  return null
}

// Collect the ordered write/edit OPERATIONS per file from the session log,
// grouping each operation with its turn number and timestamp.
function collectFiles(snapshot) {
  const map = new Map()
  if (!snapshot) return map

  const turnEnds = snapshot.turnEnds
  const sortedTurns = turnEnds ? Array.from(turnEnds.entries()).sort(function (a, b) { return a[0] - b[0] }) : []
  function turnForSeq(seq) {
    for (const pair of sortedTurns) { if (seq <= pair[1]) return pair[0] }
    return sortedTurns.length ? sortedTurns[sortedTurns.length - 1][0] : 0
  }

  function addOp(path, op) {
    if (typeof path !== 'string' || path === '') return
    let f = map.get(path)
    if (!f) { f = { ops: [], lastTime: 0 }; map.set(path, f) }
    f.ops.push(op)
    if (typeof op.time === 'number' && op.time > f.lastTime) f.lastTime = op.time
  }

  if (Array.isArray(snapshot.nodes)) {
    for (const node of snapshot.nodes) {
      if (!node || node.kind !== 'tool-result' || !node.call) continue
      if (node.call.name !== 'edit' && node.call.name !== 'write') continue
      const args = parseArgs(node.call.argsRaw)
      const path = pickPath(args)
      if (!path) continue
      const turn = turnForSeq(node.seq)
      if (node.call.name === 'write') {
        addOp(path, { op: 'write', content: (args && typeof args.content === 'string') ? args.content : '', turn: turn, time: node.time })
      } else {
        addOp(path, {
          op: 'edit',
          oldStr: (args && typeof args.old_string === 'string') ? args.old_string : '',
          newStr: (args && typeof args.new_string === 'string') ? args.new_string : '',
          replaceAll: !!(args && args.replace_all === true),
          turn: turn,
          time: node.time,
        })
      }
    }
  }
  if (Array.isArray(snapshot.runningCalls)) {
    for (const rc of snapshot.runningCalls) {
      if (!rc || (rc.name !== 'edit' && rc.name !== 'write')) continue
      const args = parseArgs(rc.argsRaw)
      const path = pickPath(args)
      if (!path) continue
      const turn = (typeof rc.turn === 'number') ? rc.turn : 0
      if (rc.name === 'write') {
        addOp(path, { op: 'write', content: (args && typeof args.content === 'string') ? args.content : '', turn: turn, time: rc.time })
      } else {
        addOp(path, {
          op: 'edit',
          oldStr: (args && typeof args.old_string === 'string') ? args.old_string : '',
          newStr: (args && typeof args.new_string === 'string') ? args.new_string : '',
          replaceAll: !!(args && args.replace_all === true),
          turn: turn,
          time: rc.time,
        })
      }
    }
  }
  for (const f of map.values()) f.ops.sort(function (a, b) { return a.time - b.time })
  return map
}

function applyEdit(content, o) {
  if (o.replaceAll) return content.split(o.oldStr).join(o.newStr)
  return content.replace(o.oldStr, function () { return o.newStr })
}
function reverseEdit(content, o) {
  if (o.replaceAll) return content.split(o.newStr).join(o.oldStr)
  return content.replace(o.newStr, function () { return o.oldStr })
}
async function readCurrentContent(path) {
  try {
    const res = await host.call('codeui.readFile', { path: path })
    if (res && res.ok && typeof res.content === 'string') return res.content
  } catch (e) {}
  return ''
}

// Reconstruct the file's full content and return the diff reference pair:
// `prevContent` = full content after the previous turn, `currentContent` = now.
async function computeFileDiff(path, ops) {
  if (!ops || ops.length === 0) return { prevContent: '', currentContent: '' }
  let latestTurn = 0
  for (const o of ops) if (o.turn > latestTurn) latestTurn = o.turn
  let firstLatest = ops.length
  for (let i = 0; i < ops.length; i++) { if (ops[i].turn >= latestTurn) { firstLatest = i; break } }

  // Seed the content BEFORE the first operation.
  let content
  if (ops[0].op === 'write') {
    content = '' // a leading write means a new file: nothing before it
  } else {
    // Leading edit on a pre-existing file: read current content, reverse-apply.
    content = await readCurrentContent(path)
    for (let i = ops.length - 1; i >= 0; i--) {
      const o = ops[i]
      if (o.op === 'edit') content = reverseEdit(content, o)
      else content = '' // a write's prior content is unknowable from args
    }
  }

  let prevContent = ''
  for (let i = 0; i < ops.length; i++) {
    const o = ops[i]
    if (i === firstLatest) prevContent = content
    if (o.op === 'write') content = o.content
    else content = applyEdit(content, o)
  }
  return { prevContent: prevContent, currentContent: content }
}

// File paths currently being edited by in-flight edit/write calls, most recent first.
function runningEditPaths(snapshot) {
  const list = []
  if (snapshot && Array.isArray(snapshot.runningCalls)) {
    for (const rc of snapshot.runningCalls) {
      if (!rc || (rc.name !== 'edit' && rc.name !== 'write')) continue
      const path = pickPath(parseArgs(rc.argsRaw))
      if (path) list.push({ path: path, time: (typeof rc.time === 'number') ? rc.time : 0 })
    }
  }
  list.sort(function (a, b) { return b.time - a.time })
  return list
}

// ---------- styles ----------
const BASE_CSS = `
.codeui-explorer-toggle{cursor:pointer;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#666);font-size:15px}
.codeui-explorer-toggle:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#222)}
.codeui-explorer{position:absolute;left:0;top:0;bottom:0;width:300px;max-width:80vw;background:var(--dsw-specific-sidebar-fill,var(--dsw-alias-bg-base,#fff));border-right:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));box-shadow:0 0 24px rgba(0,0,0,.12);display:flex;flex-direction:column;pointer-events:auto;z-index:21;animation:codeui-slide-in .18s ease}
@keyframes codeui-slide-in{from{transform:translateX(-100%)}to{transform:translateX(0)}}
.codeui-explorer-header{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;flex:none;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08))}
.codeui-explorer-title{font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,#666)}
.codeui-explorer-close{cursor:pointer;border:none;background:transparent;color:var(--dsw-alias-label-secondary,#666);font-size:14px;padding:2px 6px;border-radius:4px}
.codeui-explorer-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}
.codeui-explorer-body{flex:1;overflow:auto;padding:4px 0;font-size:13px}
.codeui-explorer-root{padding:4px 12px;color:var(--dsw-alias-label-secondary,#777);font-size:11px;word-break:break-all;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06));margin-bottom:4px}
.codeui-explorer-empty{padding:16px 12px;color:var(--dsw-alias-label-secondary,#777);font-size:12px;line-height:1.6}
.codeui-tree-row{display:flex;align-items:center;gap:4px;padding:3px 8px;cursor:pointer;white-space:nowrap}
.codeui-tree-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
.codeui-tree-chevron{width:12px;font-size:10px;color:var(--dsw-alias-label-secondary,#888);flex:none;text-align:center}
.codeui-tree-icon{flex:none;font-size:13px}
.codeui-tree-name{overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-primary,#222)}
.codeui-tree-error{padding:8px 12px;color:#f85149;font-size:12px}

.codeui-diff{height:100%;display:flex;flex-direction:column;overflow:hidden;background:var(--dsw-alias-bg-base,#fff)}
.codeui-diff-header{display:flex;align-items:center;gap:8px;padding:10px 12px;flex:none;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08))}
.codeui-diff-title{font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,#666)}
.codeui-diff-close{margin-left:auto;cursor:pointer;border:none;background:transparent;color:var(--dsw-alias-label-secondary,#666);font-size:14px;padding:2px 6px;border-radius:4px}
.codeui-diff-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}
.codeui-running-pill{background:rgba(47,129,247,.15);color:#2f81f7;border-radius:10px;padding:1px 8px;font-size:11px}

.codeui-tabbar{display:flex;align-items:stretch;gap:0;flex:none;overflow-x:auto;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));background:var(--dsw-specific-sidebar-fill,transparent)}
.codeui-tab{display:inline-flex;align-items:center;gap:6px;padding:7px 10px;font-size:12px;color:var(--dsw-alias-label-secondary,#666);cursor:pointer;border-bottom:2px solid transparent;white-space:nowrap;user-select:none;flex:none}
.codeui-tab:hover{color:var(--dsw-alias-label-primary,#222);background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
.codeui-tab-active{color:var(--dsw-alias-label-primary,#222);border-bottom-color:#2f81f7}
.codeui-tab-name{max-width:160px;overflow:hidden;text-overflow:ellipsis}
.codeui-tab-close{border:none;background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary,#888);font-size:12px;padding:0 3px;border-radius:3px;line-height:1;flex:none}
.codeui-tab-close:hover{color:var(--dsw-alias-label-primary,#222);background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.12))}

.codeui-diff-content{flex:1;display:flex;flex-direction:column;min-height:0}
.codeui-diff-filepath{padding:8px 12px;font-size:12px;color:var(--dsw-alias-label-secondary,#777);border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));word-break:break-all;flex:none}
.codeui-diff-stats{flex:none;display:flex;gap:12px;padding:4px 12px;font-size:12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06))}
.codeui-add-count{color:#2ea043}
.codeui-del-count{color:#f85149}
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

.codeui-file-preview{margin:0;padding:12px;overflow:auto;font-family:var(--dsh-font-mono,ui-monospace,Menlo,Consolas,monospace);font-size:12px;color:var(--dsw-alias-label-primary,#222);white-space:pre}

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

return {
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return
    const layout = ctx.get('layout')

    ctx.effect(function () { return styles.insert(BASE_CSS) })

    ctx.effect(function () {
      let dispose = null
      function update() {
        if (dispose) { dispose(); dispose = null }
        if (state.settings.reorderLayout) dispose = styles.insert(REORDER_CSS)
      }
      update()
      const off = subscribe(update)
      return function () { off(); if (dispose) dispose() }
    })

    ctx.effect(function () {
      function sync() {
        if (!layout) return
        if (state.settings.showDiff) layout.openDetails()
        else layout.closeDetails()
      }
      sync()
      const off = subscribe(sync)
      return function () { off() }
    })

    // ---- Explorer panel ----
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
        host.call('codeui.listDir', { path: path }).then(function (res) {
          const entry = (res && res.ok)
            ? { dirs: (Array.isArray(res.dirs) ? res.dirs : []), files: (Array.isArray(res.files) ? res.files : []), loaded: true, error: null }
            : { dirs: [], files: [], loaded: true, error: (res && res.error) || 'load-failed' }
          setTree(function (t) { const nt = Object.assign({}, t); nt[path] = entry; return nt })
        })
      }

      React.useEffect(function () {
        let cancelled = false
        ;(async function () {
          let r = ''
          const cur = (recentId && items.find(function (w) { return w && w.workspaceId === recentId })) || items[0]
          if (cur && typeof cur.path === 'string' && cur.path !== '') r = cur.path
          else {
            try {
              const res = await host.call('codeui.workspaceRoot', {})
              if (res && res.ok && typeof res.root === 'string') r = res.root
            } catch (e) {}
          }
          if (cancelled) return
          setRoot(r)
          setResolved(true)
          if (r) loadDir(r)
        })()
        return function () { cancelled = true }
      }, [])

      React.useEffect(function () {
        if (shared.explorerOpen && root) loadDir(root)
      }, [shared.explorerOpen, root])

      function toggleDir(path) {
        setExpanded(function (prev) {
          const next = new Set(prev)
          if (next.has(path)) { next.delete(path) }
          else { next.add(path); if (!tree[path] || !tree[path].loaded) loadDir(path) }
          return next
        })
      }

      function openFile(path) { addFileTab(path) }

      function renderNode(item, depth, isDir) {
        const pad = 8 + depth * 14
        const isOpen = isDir && expanded.has(item.path)
        const kids = (isDir && isOpen) ? tree[item.path] : null
        const row = h('div', {
          className: 'codeui-tree-row',
          style: { paddingLeft: pad + 'px' },
          onClick: function () { if (isDir) toggleDir(item.path); else openFile(item.path) },
          title: item.path,
        },
          h('span', { className: 'codeui-tree-chevron' }, isDir ? (isOpen ? '\u25be' : '\u25b8') : ''),
          h('span', { className: 'codeui-tree-icon' }, isDir ? '\ud83d\udcc1' : '\ud83d\udcc4'),
          h('span', { className: 'codeui-tree-name' }, item.name)
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
      if (!resolved) body = h('div', { className: 'codeui-explorer-empty' }, '正在解析工作目录…')
      else if (!root) body = h('div', { className: 'codeui-explorer-empty' }, '未找到工作目录，请先选择一个工作区。')
      else if (rootEntry && rootEntry.error) body = h('div', { className: 'codeui-tree-error' }, rootEntry.error)
      else if (rootEntry && rootEntry.loaded) {
        const rows = []
        for (const d of rootEntry.dirs) rows.push(renderNode(d, 0, true))
        for (const f of rootEntry.files) rows.push(renderNode(f, 0, false))
        body = rows.length === 0 ? h('div', { className: 'codeui-explorer-empty' }, '目录为空') : rows
      } else body = h('div', { className: 'codeui-explorer-empty' }, '加载中…')

      return h('div', { className: 'codeui-explorer' },
        h('div', { className: 'codeui-explorer-header' },
          h('span', { className: 'codeui-explorer-title' }, '资源管理器'),
          h('button', { className: 'codeui-explorer-close', onClick: function () { patchState({ explorerOpen: false }) }, title: '关闭' }, '\u2715')
        ),
        root ? h('div', { className: 'codeui-explorer-root', title: root }, root) : null,
        h('div', { className: 'codeui-explorer-body' }, body)
      )
    }

    // ---- Explorer toggle ----
    function ExplorerToggle() {
      const shared = useShared()
      return h('button', {
        className: 'codeui-explorer-toggle',
        title: '切换资源管理器 (Code UI)',
        onClick: function () { patchState({ explorerOpen: !shared.explorerOpen }) },
      }, '\ud83d\udcc1')
    }

    // ---- Middle editor (details column): tab bar + single continuous diff ----
    function DiffPanel(props) {
      const shared = useShared()
      const snap = props.useSession ? props.useSession(function (s) { return s }) : null
      const filesMap = React.useMemo(function () { return collectFiles(snap) }, [snap])
      const [diffs, setDiffs] = React.useState({})
      const [diffLoading, setDiffLoading] = React.useState({})

      // Recompute one full-content diff per changed file whenever the ops change.
      React.useEffect(function () {
        let cancelled = false
        const paths = Array.from(filesMap.keys())
        const loading = {}
        for (const p of paths) loading[p] = true
        setDiffLoading(loading)
        Promise.all(paths.map(function (p) {
          return computeFileDiff(p, filesMap.get(p).ops).then(function (r) { return { path: p, r: r } })
        })).then(function (results) {
          if (cancelled) return
          const next = {}
          for (const item of results) next[item.path] = item.r
          setDiffs(next)
          setDiffLoading({})
        })
        return function () { cancelled = true }
      }, [filesMap])

      // Keep the tab set in sync with changed files.
      React.useEffect(function () { syncTabs(filesMap) }, [filesMap])

      // While running, prioritize the file currently being edited.
      React.useEffect(function () {
        if (!snap || !snap.running) return
        const rp = runningEditPaths(snap)
        if (rp.length > 0) focusTab(rp[0].path)
      }, [snap])

      if (!shared.settings.showDiff) return null

      const close = function () { if (layout) layout.closeDetails() }
      const activeTab = shared.activePath ? findTab(shared.activePath) : null

      const tabBar = h('div', { className: 'codeui-tabbar' },
        shared.tabs.map(function (t) {
          return h('div', {
            key: t.path,
            className: 'codeui-tab' + (t.path === shared.activePath ? ' codeui-tab-active' : ''),
            title: t.path,
            onClick: function () { focusTab(t.path) },
          },
            h('span', { className: 'codeui-tab-name' }, baseName(t.path)),
            h('button', { className: 'codeui-tab-close', title: '关闭', onClick: function (e) { e.stopPropagation(); closeTab(t.path) } }, '\u2715')
          )
        })
      )

      let body
      if (!activeTab) {
        body = h('div', { className: 'codeui-diff-empty' },
          '暂无打开的文件。\n从左侧资源管理器点击文件，或开始对话让智能体修改代码。'
        )
      } else {
        const isChanged = filesMap.has(activeTab.path)
        if (isChanged) {
          const d = diffs[activeTab.path]
          if (d) {
            const rows = diffRows(d.prevContent, d.currentContent)
            let added = 0
            let removed = 0
            const rowEls = []
            for (const r of rows) {
              const cls = r.t === 'add' ? 'codeui-diff-add' : r.t === 'del' ? 'codeui-diff-del' : 'codeui-diff-ctx'
              const sign = r.t === 'add' ? '+' : r.t === 'del' ? '-' : ' '
              if (r.t === 'add') added++
              else if (r.t === 'del') removed++
              rowEls.push(h('div', { className: 'codeui-diff-row ' + cls, key: rowEls.length },
                h('span', { className: 'codeui-diff-gutter' }, sign),
                h('span', { className: 'codeui-diff-num' }, r.n == null ? '' : String(r.n)),
                h('span', { className: 'codeui-diff-text' }, r.text === '' ? '\u00a0' : r.text)
              ))
            }
            body = h('div', { className: 'codeui-diff-content' },
              h('div', { className: 'codeui-diff-filepath', title: activeTab.path }, activeTab.path),
              h('div', { className: 'codeui-diff-stats' },
                h('span', { className: 'codeui-add-count' }, '+' + added + ' 新增'),
                h('span', { className: 'codeui-del-count' }, '-' + removed + ' 删除')
              ),
              h('div', { className: 'codeui-diff-scroll' }, rowEls.length ? rowEls : h('div', { className: 'codeui-diff-empty' }, '（无差异）'))
            )
          } else {
            body = h('div', { className: 'codeui-diff-empty' }, '计算差异中…')
          }
        } else if (activeTab.loading) {
          body = h('div', { className: 'codeui-diff-empty' }, '加载中…')
        } else if (activeTab.error) {
          body = h('div', { className: 'codeui-tree-error' }, activeTab.error)
        } else if (activeTab.content != null) {
          body = h('div', { className: 'codeui-diff-content' },
            h('div', { className: 'codeui-diff-filepath', title: activeTab.path }, activeTab.path),
            h('div', { className: 'codeui-diff-scroll' }, h('pre', { className: 'codeui-file-preview' }, activeTab.content))
          )
        } else {
          body = h('div', { className: 'codeui-diff-empty' }, '该文件暂无内容。')
        }
      }

      return h('div', { className: 'codeui-diff' },
        h('div', { className: 'codeui-diff-header' },
          h('span', { className: 'codeui-diff-title' }, '代码变更'),
          (snap && snap.running) ? h('span', { className: 'codeui-running-pill' }, '执行中') : null,
          h('button', { className: 'codeui-diff-close', onClick: close, title: '关闭' }, '\u2715')
        ),
        tabBar,
        body
      )
    }

    // ---- Settings page ----
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
      return h('div', { className: 'codeui-settings' },
        h('h3', null, 'Code UI'),
        h('p', { className: 'codeui-settings-desc' }, 'VSCode 风格代码变更视图：最左侧资源管理器、中间标签式代码编辑器（绿色新增、红色删除、灰色不变）、对话窗口右移。'),
        row('显示资源管理器', 'showExplorer'),
        row('显示代码变更面板', 'showDiff'),
        row('对话右移 / 代码居中', 'reorderLayout')
      )
    }

    slots.inject('shell.overlay', function () { return slots.register({ name: 'shell.overlay', id: 'codeui-explorer', order: 0 }, ExplorerPanel) })
    slots.inject('sidebar.footer.action', function () { return slots.register({ name: 'sidebar.footer.action', id: 'codeui-explorer-toggle', order: 0, label: '资源管理器' }, ExplorerToggle) })
    slots.inject('details', function () { return slots.register({ name: 'details' }, DiffPanel) })
    slots.inject('settings.section', function () { return slots.register({ name: 'settings.section', id: 'codeui', order: 100, label: 'Code UI' }, CodeUISettings) })
  },
}
