# PRD: Native Menu Bar & Application-Wide Right-Click Behavior

**Product**: Hermes IDE
**Version**: 0.4.x
**Author**: Product Management
**Status**: Draft
**Created**: 2026-02-27
**Platform**: macOS 13+ (Ventura and later)
**Stack**: Tauri 2.x (Rust backend) + React 18/TypeScript (frontend)

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Goals & Non-Goals](#2-goals--non-goals)
3. [User Personas](#3-user-personas)
4. [Current State Analysis](#4-current-state-analysis)
5. [Requirements — Application-Wide Right-Click Behavior Map](#5-requirements--application-wide-right-click-behavior-map)
6. [Requirements — Native Menu Bar](#6-requirements--native-menu-bar)
7. [Requirements — Context Menus per Surface](#7-requirements--context-menus-per-surface)
8. [Shared UX Guidelines](#8-shared-ux-guidelines)
9. [Technical Architecture](#9-technical-architecture)
10. [Success Metrics](#10-success-metrics)
11. [Out of Scope](#11-out-of-scope)
12. [Rollout Plan](#12-rollout-plan)
13. [Open Questions](#13-open-questions)
14. [Appendix](#14-appendix)

---

## 1. Problem Statement

Hermes IDE has **no deliberate right-click strategy**. The application does not suppress the default Chromium WebView context menu globally, nor does it provide purpose-built context menus for the vast majority of its surfaces. The result is a broken, inconsistent experience:

- **On most surfaces** (sidebar backgrounds, panel headers, status bar, activity bar, dividers, empty areas, buttons, labels), right-clicking shows the **raw Chromium/WebView context menu** — a browser debug menu with items like "Inspect Element", "Reload", "View Page Source", "Save As..." — completely inappropriate for a native desktop application.
- **On two surfaces** (Session List items, Process Panel rows), right-clicking shows a **custom `<div>`-overlay context menu** that works but is inconsistent in style and implementation.
- **On all other interactive surfaces** (terminal, git files, file explorer, branches, commits, stashes, search results, context entries, pane headers, timeline entries), right-clicking shows either the raw browser menu or nothing useful.

Additionally, Hermes IDE has **no native macOS menu bar** — no File, Edit, View, or Help menus. All keyboard shortcuts are invisible, standard macOS behaviors (Services, Hide, Quit) are missing, and users have no way to discover features by browsing menus.

### Impact Summary

| Problem | Where | What Users See | Consequence |
|---------|-------|----------------|-------------|
| Browser context menu leaking through | ~90% of app surface | "Inspect Element", "Reload", "Save As...", "View Page Source" | App feels like a webpage, not a native app. Users lose trust. Accidentally clicking "Reload" destroys all session state. |
| No right-click on terminal | Terminal pane | Browser context menu OR nothing | Cannot Copy/Paste via right-click — fundamental terminal expectation broken. |
| No right-click on git files | Git panel file rows | Browser context menu | Cannot Stage/Unstage/Discard via right-click. Users forced to use tiny icon buttons. |
| No right-click on file explorer | File tree items | Browser context menu | Cannot Open/Rename/Delete/Reveal in Finder. Baseline IDE feature missing. |
| No right-click on tabs/panes | Pane headers | Browser context menu | Cannot Close/Split/Move panes via right-click. |
| No right-click on text inputs | PromptComposer, search fields | Browser context menu (with "Inspect Element") | Cut/Copy/Paste available but mixed with inappropriate browser items. |
| Inconsistent custom menus | SessionList vs ProcessPanel | Two different visual styles and behaviors | Two ad-hoc implementations with duplicated event logic, different CSS, no submenu/keyboard support. |
| No native menu bar | Top of screen | Empty / Tauri stub menu | Shortcuts undiscoverable. Standard macOS actions missing. VoiceOver cannot announce actions. |
| `user-select: none` on UI elements | Topbar, sidebar, headers, labels | Right-click shows browser menu with all items grayed out | User gets a useless empty-looking menu. Worst possible experience. |
| "Reload" in browser context menu | Everywhere the browser menu leaks | Clicking "Reload" refreshes the webview | **All running sessions, terminal state, and unsaved work are destroyed.** This is a data-loss risk. |

### Why This Is Urgent

1. **Data-loss risk**: The Chromium "Reload" menu item is accessible on nearly every surface. One accidental click destroys all terminal sessions.
2. **First-impression damage**: New users right-click within seconds of using any app. Seeing "Inspect Element" immediately signals "this is a web app pretending to be native."
3. **Scaling problem**: As more features are added, the number of surfaces without proper right-click handling grows. Fixing this now establishes the pattern for all future components.

---

## 2. Goals & Non-Goals

### Goals

| # | Goal | Measurement |
|---|------|-------------|
| G1 | **Eliminate the browser context menu entirely** — no user should ever see "Inspect Element", "Reload", "Save As...", or "View Page Source" anywhere in the app | Zero occurrences of browser context menu in any surface, verified by manual audit of all 43+ components |
| G2 | **Define explicit right-click behavior for every pixel** of the application surface — either a purpose-built context menu, or a deliberate suppression with no menu | 100% of app surfaces covered in the behavior map (Section 5) |
| G3 | **Provide a complete native macOS menu bar** that surfaces all features and keyboard shortcuts | All existing shortcuts appear in menus with correct accelerators |
| G4 | **Standardize context menu implementation** into a single system | Zero ad-hoc `<div>`-based context menus remain |
| G5 | **Pass macOS HIG compliance** for menu bar and context menu behavior | Menu bar follows Apple's standard ordering and naming |
| G6 | **Make every feature discoverable** through menus or right-click | Users can find any action by browsing the menu bar or right-clicking the relevant element |

### Non-Goals

| # | Non-Goal | Rationale |
|---|----------|-----------|
| NG1 | Custom theming for native menus | Native menus inherit system appearance. |
| NG2 | Touch Bar support | Deprecated by Apple. |
| NG3 | Tray/dock menu | Separate feature, separate PRD. |
| NG4 | Windows/Linux menus | macOS 13+ only. |
| NG5 | Menu bar plugin/extension API | Not in this phase. |
| NG6 | Re-enabling browser DevTools context menu for developers | Use `Cmd+Opt+I` for DevTools instead. |

---

## 3. User Personas

### Persona 1: "The Power User" — Alex

| Attribute | Detail |
|-----------|--------|
| Role | Senior full-stack developer |
| Tools | Daily user of VS Code, iTerm2, and various CLI tools |
| Expectations | Right-click everywhere. Uses context menus to stage git hunks, copy terminal output, reveal files in Finder. |
| Pain Points | "When I right-click in the terminal and see 'Inspect Element', I know this is just a web app in disguise." |
| Key Scenarios | Copy/Paste in terminal, stage/discard git files via right-click, split panes via right-click on tab |

### Persona 2: "The Newcomer" — Sam

| Attribute | Detail |
|-----------|--------|
| Role | Junior developer, first week using Hermes IDE |
| Tools | Previously used only VS Code's integrated terminal |
| Expectations | Discovers features by exploring menus. Looks at the menu bar to understand what the app can do. |
| Pain Points | "I right-clicked on the sidebar to try to create a new session and got a weird browser menu with 'View Page Source'. I thought the app was broken." |
| Key Scenarios | Browsing Edit > Preferences, View > Toggle Sidebar, File > New Session |

### Persona 3: "The Accessibility-Conscious User" — Jordan

| Attribute | Detail |
|-----------|--------|
| Role | Developer with RSI, relies on keyboard navigation + macOS accessibility |
| Tools | macOS VoiceOver, Keyboard Navigation, custom key remapping |
| Expectations | Menu bar navigable via `Ctrl+F2`. All actions reachable without a mouse. |
| Pain Points | "If the app has no menu bar, VoiceOver can't announce available actions and I can't navigate them." |
| Key Scenarios | Navigating to View > Toggle Sidebar via keyboard, using Services menu for text operations |

### Persona 4: "The Workflow Optimizer" — Morgan

| Attribute | Detail |
|-----------|--------|
| Role | DevOps engineer managing multiple projects simultaneously |
| Tools | Uses Hermes IDE for multi-session terminal workflows |
| Expectations | Quick actions via right-click without hunting for tiny icon buttons. |
| Pain Points | "I accidentally clicked 'Reload' in the context menu and lost all my terminal sessions. I had 6 running." |
| Key Scenarios | Batch git operations, killing processes, managing session groups |

---

## 4. Current State Analysis

### 4.1 Right-Click Behavior Audit — Complete Surface Map

The following table documents what **currently happens** when a user right-clicks every distinct surface in the application. This audit was performed by examining all component files, CSS, and Tauri configuration.

**Legend:**
- **Browser Menu** = The raw Chromium/WebView context menu appears (Inspect Element, Reload, Save As, etc.)
- **Custom Menu** = A custom `<div>`-overlay context menu appears
- **Nothing** = The event is suppressed but no replacement menu is shown
- **xterm** = xterm.js handles the event internally

#### Sidebar Region

| Surface | Current Behavior | `user-select` | `onContextMenu` handler | File |
|---------|-----------------|---------------|------------------------|------|
| Session list item | **Custom Menu** (Rename, Group) | `none` | Yes — `preventDefault()` + state | `SessionList.tsx:79-82` |
| Session list — empty area below items | **Browser Menu** | `none` | No handler | `SessionList.tsx` |
| Session group header | **Browser Menu** | `none` | No handler | `SessionList.tsx` |
| Activity bar icon buttons | **Browser Menu** | `none` | No handler | `ActivityBar.tsx` |
| Activity bar — background area | **Browser Menu** | `none` | No handler | `ActivityBar.css:12` |
| Git panel — file row | **Browser Menu** | varies | No handler | `GitFileRow.tsx` |
| Git panel — project section header | **Browser Menu** | `none` | No handler | `GitProjectSection.tsx` |
| Git panel — branch selector item | **Browser Menu** | varies | No handler | `GitBranchSelector.tsx` |
| Git panel — commit row (log view) | **Browser Menu** | varies | No handler | `GitLogView.tsx` |
| Git panel — stash entry | **Browser Menu** | varies | No handler | `GitStashSection.tsx` |
| Git panel — diff view content | **Browser Menu** | varies | No handler | `GitDiffView.tsx` |
| Git panel — merge banner | **Browser Menu** | varies | No handler | `GitMergeBanner.tsx` |
| Git panel — conflict viewer | **Browser Menu** | varies | No handler | `GitConflictViewer.tsx` |
| File explorer — file/folder item | **Browser Menu** | `none` | No handler | `FileExplorerPanel.tsx` |
| File explorer — empty area | **Browser Menu** | `none` | No handler | `FileExplorerPanel.tsx` |
| Search panel — result row | **Browser Menu** | varies | No handler | `SearchPanel.tsx` |
| Search panel — search input | **Browser Menu** (with Cut/Copy/Paste + browser items) | auto | No handler | `SearchPanel.tsx` |
| Context panel — context entry | **Browser Menu** | varies | No handler | `ContextPanel.tsx` |
| Context panel — file tree directory | **Browser Menu** | `none` | No handler | `ContextPanel.css:731` |
| Process panel — process row | **Custom Menu** (Kill, Copy PID, Reveal) | varies | Yes — `preventDefault()` + state | `ProcessPanel.tsx:500-503` |
| Process panel — header/empty area | **Browser Menu** | varies | No handler | `ProcessPanel.tsx` |

#### Main Content Region

| Surface | Current Behavior | `user-select` | `onContextMenu` handler | File |
|---------|-----------------|---------------|------------------------|------|
| Terminal pane — xterm viewport | **Browser Menu** (xterm does not suppress it) | N/A (canvas) | No handler | `TerminalPane.tsx` |
| Terminal pane — ghost text overlay | **Passed through** (`pointer-events: none`) | N/A | No handler | `TerminalPane.css:56` |
| Split pane divider | **Browser Menu** | varies | No handler | `SplitDivider.tsx` |
| Prompt Composer — text input | **Browser Menu** (with Cut/Copy/Paste + browser items) | auto | No handler | `PromptComposer.tsx` |
| Execution Timeline — entry row | **Browser Menu** | varies | No handler | `ExecutionTimeline.tsx` |
| Cost Dashboard — row | **Browser Menu** | varies | No handler | `CostDashboard.tsx` |

#### Chrome / Window Region

| Surface | Current Behavior | `user-select` | `onContextMenu` handler | File |
|---------|-----------------|---------------|------------------------|------|
| Top bar (title bar area) | **Browser Menu** | `none` | No handler (only `mousedown` for drag) | `topbar.css:10-11`, `App.tsx:181-194` |
| Top bar — control buttons | **Browser Menu** | `none` | No handler | `topbar.css` |
| Status bar | **Browser Menu** | varies | No handler | `StatusBar.tsx` |
| Context status bar | **Browser Menu** | varies | No handler | `ContextStatusBar.tsx` |

#### Overlay / Modal Region

| Surface | Current Behavior | `user-select` | `onContextMenu` handler | File |
|---------|-----------------|---------------|------------------------|------|
| Command Palette — item | **Browser Menu** | varies | No handler | `CommandPalette.tsx` |
| Command Palette — search input | **Browser Menu** (with browser items) | auto | No handler | `CommandPalette.tsx` |
| Template Picker — item | **Browser Menu** | `none` | No handler | `TemplatePicker.tsx` |
| Settings — input fields | **Browser Menu** (with browser items) | auto | No handler | `Settings.tsx` |
| Settings — labels/sections | **Browser Menu** | `none` | No handler | `Settings.css:161` |
| Close Session Dialog | **Browser Menu** | `none` | No handler | `CloseSessionDialog.css:45` |
| Role Selector | **Browser Menu** | varies | No handler | `RoleSelector.tsx` |
| Style Selector | **Browser Menu** | varies | No handler | `StyleSelector.tsx` |
| Stuck Overlay | **Browser Menu** | varies | No handler | `StuckOverlay.tsx` |
| Toast notifications | **Browser Menu** | varies | No handler | `AutoToast.tsx`, `FlowToast.tsx` |

#### Visual Overlays (pointer-events: none)

These surfaces pass right-click events through to whatever is behind them:

| Surface | Behavior | File |
|---------|----------|------|
| CRT scanline overlay | Pass-through | `layout.css:43` |
| Drag capture overlay | Pass-through | `layout.css:72` |
| Drop zone overlay | Pass-through | `layout.css:87,112` |
| Ghost text overlay | Pass-through | `TerminalPane.css:56` |
| Activity bar badge | Pass-through | `ActivityBar.css:96` |
| Session creator glow | Pass-through | `SessionCreator.css:137` |

### 4.2 Key Findings

1. **43 out of 45+ distinct surfaces show the raw browser context menu.** Only SessionList items and ProcessPanel rows have custom handling.
2. **12 surfaces have `user-select: none`**, meaning the browser context menu appears with all text-related items grayed out — a useless, confusing menu.
3. **No global `contextmenu` event suppression exists** in `App.tsx`, `index.html`, or Tauri config.
4. **The "Reload" item in the browser context menu is a data-loss vector** — clicking it refreshes the webview, destroying all terminal sessions, unsaved state, and running processes.
5. **xterm.js does not suppress the browser context menu** on its own — it appears over the terminal canvas.

### 4.3 Native Menu Bar — Current State

- `tauri.conf.json` has no `"menu"` configuration.
- No `Menu`, `MenuItem`, or `Submenu` imports in Rust code.
- Tauri provides only a minimal stub menu (app name + Quit).
- All 25+ keyboard shortcuts are in `App.tsx` via `useEffect` (lines 55–135) — invisible to users.
- Standard macOS behaviors (Services, Hide, Hide Others, Show All) are not available.
- `Cmd+Q` works only because of the Tauri stub. `Cmd+H`, `Cmd+M` do not work.

### 4.4 Existing Custom Context Menu Implementation

Both existing menus follow this pattern:

```
State: { visible: boolean, x: number, y: number, targetId: string }
Trigger: onContextMenu → e.preventDefault() → set state with position
Render: fixed-position <div> at (x, y) with <button> items
Dismiss: mousedown outside OR Escape key
```

**Problems:**
1. Two independent implementations with duplicated dismiss logic.
2. No submenu support.
3. No keyboard navigation (arrow keys, type-to-select).
4. No separator support.
5. No disabled-item state.
6. No edge clamping — menus can render off-screen.
7. No native look-and-feel.
8. No keyboard shortcut hints in items.
9. Different CSS classes and slightly different styling between the two.

---

## 5. Requirements — Application-Wide Right-Click Behavior Map

This is the **definitive specification** for what must happen on right-click for every surface in the application. Every pixel must have an intentional behavior — either a purpose-built context menu or a deliberate, clean suppression.

### 5.1 Global Right-Click Suppression (REQ-GLOBAL-RCM)

**The default Chromium/WebView context menu must be completely eliminated from the application.**

| ID | Requirement | Acceptance Criteria |
|----|-------------|---------------------|
| RCM-1 | Add a global `contextmenu` event listener on `document` that calls `e.preventDefault()` for all events not handled by a specific context menu | AC: Right-clicking anywhere in the app never shows "Inspect Element", "Reload", "Save As...", or "View Page Source". Verified on every surface listed in Section 4.1. |
| RCM-2 | The global listener must run at the **capture phase** (`addEventListener('contextmenu', handler, true)`) to intercept before any component | AC: No component can accidentally let the browser menu through by failing to call `preventDefault()`. |
| RCM-3 | Components with specific context menus must **stop propagation** after handling, so the global suppressor does not interfere | AC: Custom context menus render correctly. The global handler does not swallow events intended for component-level handlers. |
| RCM-4 | DevTools access must be preserved via `Cmd+Opt+I` (keyboard shortcut), not via the context menu | AC: Developers can still open DevTools using the keyboard shortcut. No "Inspect Element" menu item exists anywhere. |

### 5.2 Right-Click Behavior Classification

Every surface in the application falls into one of four categories:

| Category | Behavior | Visual Feedback | Example Surfaces |
|----------|----------|----------------|------------------|
| **A — Rich Context Menu** | Right-click shows a purpose-built native context menu with actions relevant to the target element | Native macOS popup menu appears | Terminal, Session items, Git file rows, File Explorer items, Process rows |
| **B — Text Input Context Menu** | Right-click shows a standard text-editing context menu (Cut, Copy, Paste, Select All) | Native macOS popup menu appears | PromptComposer, search inputs, rename fields, Settings inputs |
| **C — Suppressed (No Menu)** | Right-click is silently consumed. No menu appears, no visual feedback. | Nothing happens | Dividers, overlays, backgrounds without actionable context, decorative elements |
| **D — Contextual Fallback Menu** | Right-click shows a lightweight menu with general app actions for that region | Native macOS popup menu with general items | Empty sidebar area, panel backgrounds, status bar |

### 5.3 Complete Surface-to-Behavior Mapping

This is the **authoritative mapping**. Every component must implement exactly the behavior specified here.

#### 5.3.1 Sidebar Region

| Surface | Category | Right-Click Behavior | Details |
|---------|----------|---------------------|---------|
| Session list item | **A** | Session context menu | See Section 7.2 |
| Session list — empty area | **D** | Fallback: [New Session, New Session from Template...] | Provides quick session creation from empty space |
| Session group header | **A** | Group menu: [Rename Group, Ungroup All, Delete Group] | Operates on the group as a whole |
| Activity bar — icon button | **C** | Suppressed | Icons are single-action; no meaningful right-click context. Tooltip on hover is sufficient. |
| Activity bar — background | **C** | Suppressed | Non-interactive decorative area |
| Git panel — file row | **A** | Git file context menu | See Section 7.3 |
| Git panel — section header (e.g., "Staged Changes") | **D** | Section menu: [Stage All / Unstage All, Collapse Section] | Operates on the section |
| Git panel — branch selector item | **A** | Branch context menu | See Section 7.4 |
| Git panel — commit row | **A** | Commit context menu | See Section 7.5 |
| Git panel — stash entry | **A** | Stash context menu | See Section 7.6 |
| Git panel — diff view content | **A** | Diff context menu: [Copy Selection, Copy Line, Copy Hunk, Stage Hunk, Unstage Hunk] | Context-sensitive to diff content |
| Git panel — merge banner | **C** | Suppressed | Banner is a call-to-action with buttons; right-click is not meaningful |
| Git panel — conflict viewer content | **B** | Text context menu (Copy, Select All) | Content is text; standard text operations apply |
| Git panel — empty state | **C** | Suppressed | Nothing actionable in an empty state |
| File explorer — file item | **A** | File context menu | See Section 7.7 |
| File explorer — folder item | **A** | Folder context menu | See Section 7.7 (variant) |
| File explorer — empty area | **D** | Fallback: [New File..., New Folder..., Refresh, Open in Terminal] | Operates on the current root directory |
| File explorer — header / title | **C** | Suppressed | Header is not actionable beyond its own UI |
| Search panel — result row | **A** | Search result context menu | See Section 7.8 |
| Search panel — search input | **B** | Text context menu | Standard Cut/Copy/Paste/Select All |
| Search panel — empty results area | **C** | Suppressed | Nothing to act on |
| Context panel — context entry | **A** | Context entry menu | See Section 7.9 |
| Context panel — file tree directory | **A** | Directory menu: [Expand/Collapse, Remove from Context, Copy Path] | Operates on context directory entry |
| Context panel — empty area | **C** | Suppressed | Nothing to act on |
| Process panel — process row | **A** | Process context menu | See Section 7.10 |
| Process panel — column header | **C** | Suppressed | Column headers are not actionable (no sort/hide column features yet) |
| Process panel — empty area | **C** | Suppressed | Nothing to act on |

#### 5.3.2 Main Content Region

| Surface | Category | Right-Click Behavior | Details |
|---------|----------|---------------------|---------|
| Terminal pane — viewport | **A** | Terminal context menu | See Section 7.1 — **highest priority** |
| Terminal pane — outside xterm (padding) | **C** | Suppressed | Clicks should focus the terminal, not show menus |
| Split pane header / tab area | **A** | Pane header context menu | See Section 7.12 |
| Split pane divider | **C** | Suppressed | Divider is a drag handle, not an actionable element |
| Prompt Composer — text area | **B** | Text context menu | Standard Cut/Copy/Paste/Select All |
| Prompt Composer — buttons/toolbar | **C** | Suppressed | Buttons have specific click actions |
| Execution Timeline — entry row | **A** | Timeline context menu | See Section 7.11 |
| Execution Timeline — empty area | **C** | Suppressed | Nothing to act on |
| Cost Dashboard — data row | **A** | Minimal menu: [Copy Row Data, Copy All as CSV] | Allows data extraction |
| Cost Dashboard — header/empty area | **D** | Fallback: [Export as CSV, Refresh] | General dashboard actions |
| Empty state (no sessions) | **C** | Suppressed | EmptyState component has CTA buttons; right-click is not meaningful |

#### 5.3.3 Chrome / Window Region

| Surface | Category | Right-Click Behavior | Details |
|---------|----------|---------------------|---------|
| Top bar — drag area | **C** | Suppressed | This area is for window dragging; menus would interfere with drag detection |
| Top bar — control buttons (traffic lights area) | **C** | Suppressed | System window controls handle their own events natively |
| Top bar — custom title / center content | **C** | Suppressed | Decorative area |
| Status bar — general area | **D** | Fallback: [Toggle Status Bar Items ▸] | Allows showing/hiding individual status bar sections |
| Status bar — specific item (e.g., branch name) | **A** | Contextual: [Copy Branch Name, Switch Branch...] | Action depends on which status bar widget is clicked |
| Context status bar | **C** | Suppressed | Informational display, not actionable via right-click |
| Scope bar | **C** | Suppressed | Mode indicator, not actionable via right-click |
| Provider actions bar — buttons | **C** | Suppressed | Buttons have specific click actions |

#### 5.3.4 Overlays / Modals

| Surface | Category | Right-Click Behavior | Details |
|---------|----------|---------------------|---------|
| Command Palette — list item | **C** | Suppressed | Items are activated by click/Enter; right-click is not standard for palettes |
| Command Palette — search input | **B** | Text context menu | Standard Cut/Copy/Paste/Select All |
| Command Palette — backdrop | **C** | Suppressed (and dismiss palette) | Clicking outside dismisses, consistent with Escape |
| Template Picker — template item | **C** | Suppressed | Items are activated by click; right-click is not meaningful |
| Template Picker — search input | **B** | Text context menu | Standard Cut/Copy/Paste/Select All |
| Settings — text/number input | **B** | Text context menu | Standard Cut/Copy/Paste/Select All |
| Settings — dropdown/toggle | **C** | Suppressed | These controls have their own interaction model |
| Settings — labels/section headers | **C** | Suppressed | Informational text, not actionable |
| Close Session Dialog | **C** | Suppressed | Dialog has explicit buttons for actions |
| Role Selector — item | **C** | Suppressed | Single-action selection items |
| Style Selector — item | **C** | Suppressed | Single-action selection items |
| Stuck Overlay | **C** | Suppressed | Emergency overlay with explicit action button |
| Toast notifications | **C** | Suppressed | Transient, auto-dismissing elements |
| Any modal backdrop / dimming layer | **C** | Suppressed (and optionally dismiss modal) | Background click behavior should match left-click |

#### 5.3.5 Visual Overlays (pointer-events: none)

These require no changes. They already pass all events through to the layer below:

| Surface | Behavior | Notes |
|---------|----------|-------|
| CRT scanline overlay | Pass-through | The layer below determines the right-click behavior |
| Drag capture overlay | Pass-through | Active only during drag operations |
| Drop zone overlay | Pass-through | Active only during drag-and-drop |
| Ghost text overlay | Pass-through | Terminal underneath receives the event |
| Activity bar badge | Pass-through | Icon underneath receives the event |
| Session creator glow | Pass-through | Element underneath receives the event |

### 5.4 Right-Click Behavior — Global Acceptance Criteria

| ID | Criterion |
|----|-----------|
| RCM-AC1 | **Zero browser context menus**: Right-clicking any surface in the application NEVER shows "Inspect Element", "Reload", "Save As...", "View Page Source", or any other browser-native menu item. Verified exhaustively against every row in Sections 5.3.1–5.3.4. |
| RCM-AC2 | **Category C surfaces show nothing**: Right-clicking a surface marked as Category C results in no visible menu, no visible feedback, and no state change. The event is silently consumed. |
| RCM-AC3 | **Category B surfaces show text menu**: Right-clicking any text input shows exactly [Cut, Copy, Paste, (separator), Select All] — no browser items mixed in. |
| RCM-AC4 | **Category A surfaces show rich menu**: Each Category A surface shows its specified context menu (per Section 7). |
| RCM-AC5 | **Category D surfaces show fallback menu**: Each Category D surface shows its specified lightweight fallback menu. |
| RCM-AC6 | **Ctrl+Click equivalence**: `Ctrl+Click` (macOS alternate right-click) triggers identical behavior to right-click on all surfaces. |
| RCM-AC7 | **Two-finger trackpad tap equivalence**: Two-finger tap on trackpad triggers identical behavior to right-click on all surfaces. |
| RCM-AC8 | **No double menus**: A right-click never shows both a custom menu AND the browser menu simultaneously. |
| RCM-AC9 | **Only one context menu at a time**: If a context menu is already visible, right-clicking elsewhere dismisses the first and opens the new one (or suppresses if Category C). |

---

## 6. Requirements — Native Menu Bar

The native menu bar must be implemented using **Tauri 2.x's `Menu` API** on the Rust side.

### 6.1 Menu Structure

Items marked with `(*)` have an existing keyboard shortcut in `App.tsx`. Items marked with `(+)` are new shortcuts. Items marked with `(sys)` are macOS system-standard.

---

#### 6.1.1 Application Menu — "Hermes"

| # | Item | Shortcut | Action | Acceptance Criteria |
|---|------|----------|--------|---------------------|
| A1 | About Hermes | — | Show about dialog with version, build, and license | AC: Dialog displays app name, version, copyright. |
| A2 | — (separator) | — | — | — |
| A3 | Settings... | `Cmd+,` (*) | Open Settings panel | AC: Same behavior as existing handler. |
| A4 | — (separator) | — | — | — |
| A5 | Services | (sys) | macOS Services submenu | AC: System Services submenu appears and works. |
| A6 | — (separator) | — | — | — |
| A7 | Hide Hermes | `Cmd+H` (sys) | Hide app window | AC: Standard macOS hide. |
| A8 | Hide Others | `Cmd+Opt+H` (sys) | Hide other apps | AC: Standard macOS behavior. |
| A9 | Show All | — (sys) | Unhide all apps | AC: Standard macOS behavior. |
| A10 | — (separator) | — | — | — |
| A11 | Quit Hermes | `Cmd+Q` (sys) | Quit application | AC: App quits. Confirmation if active sessions (see EC-M1). |

**Edge Cases:**
- **EC-M1**: Quitting with active sessions — If sessions have `phase != 'destroyed'`, show: "You have N active sessions. Quit anyway?" [Cancel, Quit]. Include "Don't ask again" checkbox.

---

#### 6.1.2 File Menu

| # | Item | Shortcut | Action | Acceptance Criteria |
|---|------|----------|--------|---------------------|
| F1 | New Session | `Cmd+N` (*) | Create a new terminal session | AC: Identical to current handler. |
| F2 | New Session from Template... | `Cmd+Shift+N` (+) | Open TemplatePicker | AC: TemplatePicker modal opens. |
| F3 | — (separator) | — | — | — |
| F4 | Close Session | `Cmd+W` (*) | Close the active session/pane | AC: Identical to current handler. |
| F5 | Close All Sessions | `Cmd+Shift+W` (+) | Close all sessions | AC: All sessions destroyed. Confirmation if running processes (EC-M2). |
| F6 | — (separator) | — | — | — |
| F7 | Open Realm... | `Cmd+R` (*) | Open Realm picker | AC: ProjectPicker opens. |
| F8 | Open File Explorer | `Cmd+F` (*) | Toggle file explorer | AC: File Explorer panel toggles. |
| F9 | — (separator) | — | — | — |
| F10 | Export Session History... | `Cmd+Shift+E` (+) | Export active session's command history | AC: Save dialog. Export as `.txt` or `.md`. |

**Edge Cases:**
- **EC-M2**: Close All with running processes — "N sessions have running processes. Close all?" [Cancel, Force Close].
- **EC-M3**: Items disabled (grayed out) when not applicable — "Close Session" disabled with zero sessions.

---

#### 6.1.3 Edit Menu

| # | Item | Shortcut | Action | Acceptance Criteria |
|---|------|----------|--------|---------------------|
| E1 | Undo | `Cmd+Z` (sys) | Undo in text inputs (not terminal) | AC: Works in PromptComposer, search fields, rename inputs. Disabled when terminal focused. |
| E2 | Redo | `Cmd+Shift+Z` (sys) | Redo in text inputs | AC: Works in same contexts as Undo. See EC-M4 for conflict resolution. |
| E3 | — (separator) | — | — | — |
| E4 | Cut | `Cmd+X` (sys) | Cut selected text | AC: Works in text inputs. In terminal, cuts selected text. |
| E5 | Copy | `Cmd+C` (sys) | Copy selected text / SIGINT | AC: Terminal — if selection, copy; if no selection, send SIGINT. Other inputs, standard copy. See EC-M5. |
| E6 | Paste | `Cmd+V` (sys) | Paste clipboard content | AC: Terminal — paste into PTY. Other inputs, standard paste. |
| E7 | Select All | `Cmd+A` (sys) | Select all in focused element | AC: Terminal — select buffer. Inputs — select text. |
| E8 | — (separator) | — | — | — |
| E9 | Find in Project... | `Cmd+Shift+F` (*) | Open search panel | AC: SearchPanel opens. |
| E10 | — (separator) | — | — | — |
| E11 | Start Dictation... | (sys) | macOS dictation | AC: System dictation starts. |
| E12 | Emoji & Symbols | `Ctrl+Cmd+Space` (sys) | macOS character viewer | AC: System character viewer opens. |

**Edge Cases:**
- **EC-M4**: `Cmd+Shift+Z` is currently "Toggle Flow Mode". Must be remapped (suggested: `Cmd+Shift+Enter`) to give `Cmd+Shift+Z` to Redo.
- **EC-M5**: `Cmd+C` dual behavior — native menu fires before webview. The handler must inspect terminal focus + selection state.
- **EC-M6**: Undo/Redo disabled when terminal pane has focus.

---

#### 6.1.4 View Menu

| # | Item | Shortcut | Action | Acceptance Criteria |
|---|------|----------|--------|---------------------|
| V1 | Toggle Sidebar | `Cmd+B` (*) | Show/hide sidebar | AC: Sidebar toggles. Checkmark when visible. |
| V2 | — (separator) | — | — | — |
| V3 | Command Palette | `Cmd+K` (*) | Open command palette | AC: CommandPalette opens. |
| V4 | Prompt Composer | `Cmd+J` (*) | Open prompt composer | AC: PromptComposer opens. |
| V5 | — (separator) | — | — | — |
| V6 | Panels ▸ | — | Submenu for panel toggles | — |
| V6a | &nbsp;&nbsp; Git | `Cmd+G` (*) | Toggle Git panel | AC: Toggles. Checkmark when visible. |
| V6b | &nbsp;&nbsp; Processes | `Cmd+P` (*) | Toggle Process panel | AC: Toggles. Checkmark when visible. |
| V6c | &nbsp;&nbsp; Context | `Cmd+E` (*) | Toggle Context panel | AC: Toggles. Checkmark when visible. |
| V6d | &nbsp;&nbsp; File Explorer | `Cmd+F` (*) | Toggle File Explorer | AC: Toggles. Checkmark when visible. |
| V6e | &nbsp;&nbsp; Search | `Cmd+Shift+F` (*) | Toggle Search panel | AC: Toggles. Checkmark when visible. |
| V6f | &nbsp;&nbsp; Execution Timeline | `Cmd+L` (*) | Toggle Timeline | AC: Toggles. Checkmark when visible. |
| V6g | &nbsp;&nbsp; Cost Dashboard | `Cmd+$` (*) | Toggle Dashboard | AC: Toggles. Checkmark when visible. |
| V7 | — (separator) | — | — | — |
| V8 | Split Pane Right | `Cmd+D` (*) | Split horizontally | AC: New pane to the right. Disabled if no session. |
| V9 | Split Pane Down | `Cmd+Shift+D` (*) | Split vertically | AC: New pane below. Disabled if no session. |
| V10 | — (separator) | — | — | — |
| V11 | Actual Size | `Cmd+0` (+) | Reset terminal font size | AC: Font resets to default. |
| V12 | Zoom In | `Cmd+=` (+) | Increase font size | AC: +1pt. |
| V13 | Zoom Out | `Cmd+-` (+) | Decrease font size | AC: -1pt. Minimum 8pt. |
| V14 | — (separator) | — | — | — |
| V15 | Enter Full Screen | `Ctrl+Cmd+F` (sys) | macOS full-screen | AC: Standard macOS behavior. |

**Edge Cases:**
- **EC-M7**: Panel checkmarks must sync with React state via Tauri events.
- **EC-M8**: Zoom affects terminal font (xterm.js `fontSize`), NOT webview zoom. Intercept before webview processes.

---

#### 6.1.5 Session Menu

| # | Item | Shortcut | Action | Acceptance Criteria |
|---|------|----------|--------|---------------------|
| S1 | Rename Session... | — | Inline rename for active session | AC: Name field becomes editable. Disabled if no session. |
| S2 | Duplicate Session | — (+) | Clone session config | AC: New session with same working directory. |
| S3 | — (separator) | — | — | — |
| S4 | Assign to Group ▸ | — | Submenu: existing groups + "New Group..." | AC: Session moved to group instantly. |
| S5 | Remove from Group | — | Remove from group | AC: Disabled if not grouped. |
| S6 | — (separator) | — | — | — |
| S7 | Execution Mode ▸ | — | Manual / Assisted / Autonomous (radio) | AC: Mode changes. Current mode has radio indicator. |
| S8 | — (separator) | — | — | — |
| S9 | Clear Terminal | `Cmd+Shift+K` (+) | Soft-clear terminal | AC: Viewport cleared. Scrollback preserved. |
| S10 | Reset Terminal | — | Hard reset terminal | AC: Full reset. Scrollback cleared. |
| S11 | — (separator) | — | — | — |
| S12 | Previous Session | `Cmd+Shift+[` (+) | Switch to previous session | AC: Wraps around. |
| S13 | Next Session | `Cmd+Shift+]` (+) | Switch to next session | AC: Wraps around. |
| S14 | Session 1–9 | `Cmd+1`–`Cmd+9` (*) | Switch to session N | AC: Same as existing handlers. |

---

#### 6.1.6 Window Menu

| # | Item | Shortcut | Action | Acceptance Criteria |
|---|------|----------|--------|---------------------|
| W1 | Minimize | `Cmd+M` (sys) | Minimize | AC: Standard macOS. |
| W2 | Zoom | — (sys) | macOS zoom | AC: Standard macOS. |
| W3 | — (separator) | — | — | — |
| W4 | Bring All to Front | — (sys) | Bring all to front | AC: Standard macOS. |

---

#### 6.1.7 Help Menu

| # | Item | Shortcut | Action | Acceptance Criteria |
|---|------|----------|--------|---------------------|
| H1 | Search | — (sys) | macOS Help search | AC: System search. Searches all menu items. |
| H2 | Keyboard Shortcuts | `Cmd+/` (*) | Open Shortcuts panel | AC: ShortcutsPanel opens. |
| H3 | — (separator) | — | — | — |
| H4 | Release Notes | — | Open release notes URL | AC: Opens in default browser. |
| H5 | Report a Bug... | — | Open issue tracker URL | AC: Opens in default browser. |

---

### 6.2 Menu Bar — Global Acceptance Criteria

| ID | Criterion |
|----|-----------|
| MAC-1 | All items with shortcuts display correct accelerator glyphs (⌘, ⇧, ⌥, ⌃). |
| MAC-2 | Non-applicable items are **grayed out** (disabled), never hidden. |
| MAC-3 | Menu bar accessible via `Ctrl+F2` and fully keyboard-navigable. |
| MAC-4 | Services submenu functional. |
| MAC-5 | System items (Hide, Minimize, Zoom, Full Screen, etc.) behave identically to native macOS apps. |
| MAC-6 | Toggle checkmarks update in real-time when state changes via shortcuts or UI. |
| MAC-7 | Menu bar uses system font and rendering. |
| MAC-8 | Native menu shortcuts take precedence over React `keydown` handlers. Once a shortcut is in the native menu, remove the React handler. |
| MAC-9 | Menu bar follows macOS standard order: `[Apple] | Hermes | File | Edit | View | Session | Window | Help`. |

---

## 7. Requirements — Context Menus per Surface

### 7.0 Context Menu Infrastructure (REQ-CTX-INFRA)

| Attribute | Specification |
|-----------|---------------|
| **Primary approach** | **Tauri 2.x native popup menu API** (`Menu::popup`) for all Category A and D context menus |
| **Text input menus (Category B)** | Implement a reusable native text-editing popup menu: [Cut, Copy, Paste, (separator), Select All]. Shared across all text inputs. |
| **Migration** | `SessionContextMenu.tsx` and the inline ProcessPanel menu are migrated to native popups, then deleted |
| **Keyboard navigation** | Arrow keys, Enter, Escape, Right (submenu), Left (close submenu) — native menus provide this automatically |
| **Edge clamping** | Native menus handle this automatically |
| **Shortcut hints** | Menu items display associated keyboard shortcuts on the right |
| **Disabled state** | Non-applicable items appear grayed out, never hidden |
| **Separators** | Visual separators between logical groups |

**Acceptance Criteria:**
- AC1: Zero `<div>`-based context menu implementations remain after migration.
- AC2: All context menus dismiss on click-outside or Escape.
- AC3: All context menus appear within 50ms of right-click.
- AC4: All context menus render fully within window bounds.

---

### 7.1 Terminal Pane Context Menu

**Component**: `TerminalPane.tsx`
**Trigger**: Right-click in terminal viewport
**Priority**: P0 (Critical)

| # | Item | Shortcut Hint | Condition | Action | Acceptance Criteria |
|---|------|---------------|-----------|--------|---------------------|
| T1 | Copy | `⌘C` | Text selected | Copy selected text | AC: Text copied. Selection NOT cleared after copy (iTerm2 behavior). |
| T2 | Paste | `⌘V` | Always | Paste into PTY | AC: Clipboard text written to PTY stdin. Multi-line paste warning (EC-T1). |
| T3 | — (separator) | — | — | — | — |
| T4 | Select All | `⌘A` | Always | Select all buffer content | AC: All scrollback + viewport selected. |
| T5 | — (separator) | — | — | — | — |
| T6 | Clear Terminal | `⌘⇧K` | Always | Soft-clear viewport | AC: Viewport cleared. Scrollback preserved. |
| T7 | Reset Terminal | — | Always | Hard reset | AC: Terminal reset. Scrollback cleared. |
| T8 | — (separator) | — | — | — | — |
| T9 | Split Right | `⌘D` | Always | Horizontal split | AC: New pane right. |
| T10 | Split Down | `⌘⇧D` | Always | Vertical split | AC: New pane below. |
| T11 | — (separator) | — | — | — | — |
| T12 | Search... | `⌘⇧F` | Always | Open search panel | AC: SearchPanel opens with focus in search input. |

**Edge Cases:**
- **EC-T1**: Multi-line paste warning — clipboard has `\n`: "Paste N lines into terminal?" [Cancel, Paste]. "Don't ask again" checkbox.
- **EC-T2**: Right-click must NOT clear existing text selection.
- **EC-T3**: Mouse-mode apps (vim, htop, tmux) — right-click still shows context menu. `Opt+right-click` to pass through to the app.
- **EC-T4**: Copy is **disabled** (grayed out) when no text is selected. Label remains "Copy" (not "Interrupt").

---

### 7.2 Session List Context Menu

**Component**: `SessionList.tsx`
**Trigger**: Right-click on session item
**Priority**: P0 (Existing — migrate + enhance)

| # | Item | Condition | Action | Acceptance Criteria |
|---|------|-----------|--------|---------------------|
| SL1 | Rename... | Always | Start inline rename | AC: Name field becomes editable. |
| SL2 | Duplicate Session | Always | Clone session config | AC: New session with same working directory. |
| SL3 | — (separator) | — | — | — |
| SL4 | Assign to Group ▸ | Always | Submenu: groups + "New Group..." | AC: Instant group assignment. |
| SL5 | Remove from Group | In a group | Remove from group | AC: Disabled if not grouped. |
| SL6 | — (separator) | — | — | — |
| SL7 | Execution Mode ▸ | Always | Manual / Assisted / Autonomous (radio) | AC: Current mode has radio indicator. |
| SL8 | — (separator) | — | — | — |
| SL9 | Close Session | Always | Destroy session | AC: Confirmation if process running. |

**Edge Cases:**
- **EC-SL1**: Right-clicking a non-active session does NOT switch to it. Menu operates on the right-clicked session.
- **EC-SL2**: Right-clicking empty area below sessions → Category D fallback: [New Session, New Session from Template...].

---

### 7.3 Git File Row Context Menu

**Component**: `GitFileRow.tsx` / `GitProjectSection.tsx`
**Trigger**: Right-click on file row in Git panel
**Priority**: P0

| # | Item | Condition | Action | Acceptance Criteria |
|---|------|-----------|--------|---------------------|
| GF1 | Stage File | Unstaged or untracked | Stage (`git add`) | AC: File moves to Staged section. |
| GF2 | Unstage File | Staged | Unstage (`git reset HEAD`) | AC: File moves to Unstaged section. |
| GF3 | — (separator) | — | — | — |
| GF4 | View Diff | Modified | Open diff view | AC: GitDiffView opens for this file. |
| GF5 | — (separator) | — | — | — |
| GF6 | Discard Changes... | Modified (unstaged) | Revert to HEAD | AC: Confirmation: "Discard changes to [filename]? This cannot be undone." [Cancel, Discard]. |
| GF7 | — (separator) | — | — | — |
| GF8 | Copy File Path | Always | Copy relative path | AC: `src/components/Foo.tsx` copied. |
| GF9 | Copy Absolute Path | Always | Copy absolute path | AC: Full path copied. |
| GF10 | Reveal in Finder | Always | Open parent dir in Finder | AC: Finder opens with file selected. |
| GF11 | Open in Terminal | Always | New session in file's directory | AC: New session with `cwd` set. |

**Edge Cases:**
- **EC-GF1**: Untracked files — "Discard Changes" becomes "Delete File..." with confirmation.
- **EC-GF2**: Binary files — "View Diff" is disabled with "(binary)" suffix.
- **EC-GF3**: Conflicted files — additional item: "Open Conflict Resolver".

---

### 7.4 Git Branch Selector Context Menu

**Component**: `GitBranchSelector.tsx`
**Trigger**: Right-click on branch name
**Priority**: P1

| # | Item | Condition | Action | Acceptance Criteria |
|---|------|-----------|--------|---------------------|
| GB1 | Checkout | Not current branch | Switch to branch | AC: Confirmation if uncommitted changes. |
| GB2 | — (separator) | — | — | — |
| GB3 | Merge into Current... | Not current branch | Merge into current | AC: Merge executed. Conflicts → GitMergeBanner. |
| GB4 | — (separator) | — | — | — |
| GB5 | Copy Branch Name | Always | Copy name to clipboard | AC: Name copied. |
| GB6 | — (separator) | — | — | — |
| GB7 | Delete Branch... | Not current & is local | Delete local branch | AC: Confirmation. Force delete if unmerged. |

**Edge Cases:**
- **EC-GB1**: Remote-only branches — "Delete" disabled. Tooltip: "Cannot delete remote branches."
- **EC-GB2**: Current branch — "Checkout" and "Delete" disabled.

---

### 7.5 Git Log View Context Menu

**Component**: `GitLogView.tsx`
**Trigger**: Right-click on commit row
**Priority**: P1

| # | Item | Condition | Action | Acceptance Criteria |
|---|------|-----------|--------|---------------------|
| GL1 | Copy Commit SHA | Always | Copy full 40-char SHA | AC: SHA copied. |
| GL2 | Copy Short SHA | Always | Copy 7-char SHA | AC: Short SHA copied. |
| GL3 | Copy Commit Message | Always | Copy commit message | AC: Full message copied. |
| GL4 | — (separator) | — | — | — |
| GL5 | Checkout Commit... | Always | Checkout (detached HEAD) | AC: Warning about detached HEAD. Commit checked out. |
| GL6 | — (separator) | — | — | — |
| GL7 | View Details | Always | Open commit detail view | AC: GitCommitDetailView opens. |

---

### 7.6 Git Stash Section Context Menu

**Component**: `GitStashSection.tsx`
**Trigger**: Right-click on stash entry
**Priority**: P1

| # | Item | Condition | Action | Acceptance Criteria |
|---|------|-----------|--------|---------------------|
| GS1 | Apply Stash | Always | Apply without removing | AC: Changes applied. Stash remains. |
| GS2 | Pop Stash | Always | Apply and remove | AC: Changes applied. Stash removed. |
| GS3 | — (separator) | — | — | — |
| GS4 | Drop Stash... | Always | Delete stash entry | AC: Confirmation: "Drop stash?" [Cancel, Drop]. |

---

### 7.7 File Explorer Context Menu

**Component**: `FileExplorerPanel.tsx`
**Trigger**: Right-click on file or folder
**Priority**: P0

#### File Variant

| # | Item | Condition | Action | Acceptance Criteria |
|---|------|-----------|--------|---------------------|
| FE1 | Open in Terminal | Always | New session in file's parent dir | AC: New session with `cwd` set. |
| FE2 | — (separator) | — | — | — |
| FE3 | Rename... | Always | Inline rename | AC: Name becomes editable. Renames on Enter. |
| FE4 | Delete... | Always | Delete file | AC: Confirmation: "Delete [name]? This cannot be undone." Recursive for directories. |
| FE5 | — (separator) | — | — | — |
| FE6 | Copy Path | Always | Copy relative path | AC: Relative path copied. |
| FE7 | Copy Absolute Path | Always | Copy absolute path | AC: Absolute path copied. |
| FE8 | — (separator) | — | — | — |
| FE9 | Reveal in Finder | Always | Open in Finder | AC: Finder opens with file selected. |

#### Folder Variant (additional items)

| # | Item | Condition | Action | Acceptance Criteria |
|---|------|-----------|--------|---------------------|
| FD1 | Open in Terminal | Always | New session in this directory | AC: New session with `cwd` set. |
| FD2 | — (separator) | — | — | — |
| FD3 | New File... | Always | Create file in this directory | AC: Inline input appears. File created on Enter. |
| FD4 | New Folder... | Always | Create folder in this directory | AC: Inline input appears. Folder created on Enter. |
| FD5 | — (separator) | — | — | — |
| FD6 | Rename... | Always | Inline rename | AC: Name becomes editable. |
| FD7 | Delete... | Always | Delete directory recursively | AC: Confirmation. Recursive delete. |
| FD8 | — (separator) | — | — | — |
| FD9 | Copy Path | Always | Copy relative path | AC: Path copied. |
| FD10 | Copy Absolute Path | Always | Copy absolute path | AC: Path copied. |
| FD11 | — (separator) | — | — | — |
| FD12 | Reveal in Finder | Always | Open in Finder | AC: Finder opens. |

**Edge Cases:**
- **EC-FE1**: Empty area right-click → Category D fallback: [New File..., New Folder..., Refresh, Open in Terminal].
- **EC-FE2**: File locked or in use → error toast: "Cannot delete [name]: file is in use."
- **EC-FE3**: Rename collision → error toast: "A file with that name already exists."

---

### 7.8 Search Results Context Menu

**Component**: `SearchPanel.tsx`
**Trigger**: Right-click on search result row
**Priority**: P2

| # | Item | Condition | Action | Acceptance Criteria |
|---|------|-----------|--------|---------------------|
| SR1 | Open in Terminal | Always | New session at file's directory | AC: New session with `cwd` set. |
| SR2 | — (separator) | — | — | — |
| SR3 | Copy Path | Always | Copy relative path | AC: Path copied. |
| SR4 | Copy Absolute Path | Always | Copy absolute path | AC: Path copied. |
| SR5 | Reveal in Finder | Always | Open in Finder | AC: Finder opens. |

---

### 7.9 Context Panel Context Menu

**Component**: `ContextPanel.tsx`
**Trigger**: Right-click on context entry
**Priority**: P2

| # | Item | Condition | Action | Acceptance Criteria |
|---|------|-----------|--------|---------------------|
| CP1 | Pin / Unpin | Always | Toggle pin state | AC: Visual indicator updates. |
| CP2 | Remove | Always | Remove from context | AC: Entry disappears. |
| CP3 | — (separator) | — | — | — |
| CP4 | Copy Path | Entry is a file | Copy path | AC: Path copied. |

---

### 7.10 Process Panel Context Menu (Migration + Enhancement)

**Component**: `ProcessPanel.tsx`
**Trigger**: Right-click on process row
**Priority**: P1 (Migrate existing)

| # | Item | Condition | Action | Acceptance Criteria |
|---|------|-----------|--------|---------------------|
| PP1 | Copy PID | Always | Copy PID to clipboard | AC: PID copied as string. |
| PP2 | — (separator) | — | — | — |
| PP3 | Send SIGTERM | Running | Send SIGTERM | AC: Signal sent. |
| PP4 | Send SIGKILL | Running | Send SIGKILL | AC: Process exits immediately. |
| PP5 | Kill Process Tree | Running & advanced mode | Kill tree recursively | AC: All children killed. |
| PP6 | — (separator) | — | — | — |
| PP7 | Reveal in Finder | Always | Reveal executable | AC: Finder opens. |
| PP8 | Copy Executable Path | Always | Copy exe path | AC: Path copied. |

---

### 7.11 Execution Timeline Context Menu

**Component**: `ExecutionTimeline.tsx`
**Trigger**: Right-click on timeline entry
**Priority**: P2

| # | Item | Condition | Action | Acceptance Criteria |
|---|------|-----------|--------|---------------------|
| ET1 | Copy Command | Always | Copy command text | AC: Command string copied. |
| ET2 | Re-run Command | Always | Execute again in active session | AC: Command written to PTY. |
| ET3 | — (separator) | — | — | — |
| ET4 | Copy Output | Output captured | Copy stdout/stderr | AC: Output copied. |

---

### 7.12 Pane Header Context Menu

**Component**: `SplitPane.tsx` / pane header area
**Trigger**: Right-click on pane tab header
**Priority**: P1

| # | Item | Condition | Action | Acceptance Criteria |
|---|------|-----------|--------|---------------------|
| PH1 | Split Right | Always | Horizontal split | AC: New pane right. |
| PH2 | Split Down | Always | Vertical split | AC: New pane below. |
| PH3 | — (separator) | — | — | — |
| PH4 | Close Pane | >1 pane exists | Close this pane | AC: Pane removed. |
| PH5 | Close Other Panes | >1 pane exists | Close all except this | AC: Only this pane remains. Confirmation if processes running. |

---

### 7.13 Category D — Fallback Menus

These menus appear on surfaces that are not directly actionable but belong to a region where general actions make sense.

#### 7.13.1 Empty Sidebar Area

| # | Item | Action |
|---|------|--------|
| D1 | New Session | Create new session |
| D2 | New Session from Template... | Open TemplatePicker |

#### 7.13.2 Git Section Header (e.g., "Staged Changes", "Unstaged Changes")

| # | Item | Condition | Action |
|---|------|-----------|--------|
| D3 | Stage All | Section is "Unstaged" or "Untracked" | Stage all files in this section |
| D4 | Unstage All | Section is "Staged" | Unstage all files |
| D5 | — (separator) | — | — |
| D6 | Collapse Section | Always | Collapse/expand the section |

#### 7.13.3 File Explorer — Empty Area

| # | Item | Action |
|---|------|--------|
| D7 | New File... | Create file in root |
| D8 | New Folder... | Create folder in root |
| D9 | — (separator) | — |
| D10 | Refresh | Reload file tree |
| D11 | Open in Terminal | New session in root dir |

#### 7.13.4 Cost Dashboard — Header/Empty Area

| # | Item | Action |
|---|------|--------|
| D12 | Export as CSV | Export cost data |
| D13 | Refresh | Reload cost data |

#### 7.13.5 Status Bar — General Area

| # | Item | Action |
|---|------|--------|
| D14 | Toggle Status Bar Items ▸ | Submenu with checkboxes for each status bar widget |

#### 7.13.6 Status Bar — Branch Name Widget

| # | Item | Action |
|---|------|--------|
| D15 | Copy Branch Name | Copy current branch name to clipboard |
| D16 | Switch Branch... | Open branch selector |

---

## 8. Shared UX Guidelines

### 8.1 Visual Design

| Property | Specification |
|----------|---------------|
| Menu style | Native macOS context menus via Tauri `Menu::popup`. No custom rendering. |
| Light/Dark mode | Inherits from macOS system appearance automatically. |
| Menu width | Determined by the OS. |
| Icons | Not required for v1. Text-only items. |

### 8.2 Interaction Model

| Behavior | Specification |
|----------|---------------|
| Trigger | `contextmenu` event: right-click, `Ctrl+Click`, two-finger trackpad tap |
| Dismiss | Click outside, Escape, or selecting an item (native handles this) |
| Multiple menus | Only one context menu visible at a time |
| Nested submenus | Supported. Max depth: 2 levels |
| Animation | Native macOS system animation |

### 8.3 Accessibility

| Requirement | Specification |
|-------------|---------------|
| VoiceOver | Native menus are automatically VoiceOver-accessible |
| Keyboard activation | `Shift+F10` or macOS context menu key opens the menu for the focused element |
| Role attributes | Not needed for native menus |
| Focus management | Native menus handle focus trapping and restoration |

### 8.4 Performance

| Requirement | Specification |
|-------------|---------------|
| Time to render | < 50ms from right-click to menu visible |
| IPC overhead | Batch all data into a single `invoke` call per menu |
| Caching | Static menus pre-built at session start. Dynamic menus built per invocation. |

---

## 9. Technical Architecture

### 9.1 Global Right-Click Suppression

```typescript
// App.tsx — top-level, capture phase
document.addEventListener('contextmenu', (e) => {
  // If a component-level handler already handled this event
  // (stopPropagation was called), this won't fire.
  // For everything else, prevent the browser menu.
  e.preventDefault();
}, true);
```

Components with Category A/B/D menus call `e.stopPropagation()` after showing their menu.
Components with Category C behavior do nothing — the global handler suppresses the browser menu.

### 9.2 Native Menu Bar

```
┌──────────────────────────────────┐
│         Rust (Tauri)             │
│  ┌──────────────────────────┐   │
│  │  menu::build_app_menu()  │   │  Builds full menu bar at startup
│  │  → Menu, Submenu,        │   │  using Tauri 2.x Menu API
│  │    MenuItem, CheckMenuItem│   │
│  └──────────┬───────────────┘   │
│             │                    │
│  ┌──────────▼───────────────┐   │
│  │  Event Handlers           │   │  Menu item → Tauri event
│  │  on_menu_event(id)        │   │  emitted to frontend
│  └──────────┬───────────────┘   │
│             │                    │
├─────────────┼────────────────────┤
│ IPC Bridge  │  (Tauri events)    │
├─────────────┼────────────────────┤
│             │                    │
│  ┌──────────▼───────────────┐   │
│  │  React Event Listener     │   │  listen('menu-event')
│  │  → dispatch(action)       │   │  → existing SessionContext
│  └──────────────────────────┘   │
│         React (Frontend)         │
└──────────────────────────────────┘
```

### 9.3 Context Menu Flow

```
┌──────────────────────────────────┐
│         React (Frontend)         │
│  ┌──────────────────────────┐   │
│  │  onContextMenu handler    │   │  1. e.preventDefault()
│  │  → Gather context data    │   │  2. e.stopPropagation()
│  │  → invoke('show_context_  │   │  3. Build menu spec
│  │     menu', { items })     │   │  4. Send to Rust
│  └──────────┬───────────────┘   │
│             │                    │
├─────────────┼────────────────────┤
│             │                    │
│  ┌──────────▼───────────────┐   │
│  │  Rust: show_context_menu  │   │  Build + show native popup
│  │  → Menu::popup()          │   │
│  └──────────┬───────────────┘   │
│             │                    │
│  ┌──────────▼───────────────┐   │
│  │  User selects item        │   │  Emit action event
│  │  → emit('ctx-action')     │   │
│  └──────────┬───────────────┘   │
│             │                    │
├─────────────┼────────────────────┤
│             │                    │
│  ┌──────────▼───────────────┐   │
│  │  React: handle action     │   │  Execute the action
│  │  → dispatch / invoke      │   │
│  └──────────────────────────┘   │
└──────────────────────────────────┘
```

### 9.4 Text Input Context Menu (Category B)

For text inputs (PromptComposer, search fields, etc.), a reusable native text menu is shown:

```typescript
// useTextContextMenu.ts
function useTextContextMenu(inputRef: RefObject<HTMLInputElement | HTMLTextAreaElement>) {
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const hasSelection = inputRef.current?.selectionStart !== inputRef.current?.selectionEnd;
    const hasClipboard = true; // Cannot check synchronously; always enable Paste

    invoke('show_context_menu', {
      items: [
        { id: 'cut', label: 'Cut', enabled: hasSelection, accelerator: 'Cmd+X' },
        { id: 'copy', label: 'Copy', enabled: hasSelection, accelerator: 'Cmd+C' },
        { id: 'paste', label: 'Paste', enabled: hasClipboard, accelerator: 'Cmd+V' },
        { type: 'separator' },
        { id: 'selectAll', label: 'Select All', accelerator: 'Cmd+A' },
      ]
    });
  }, []);

  return { onContextMenu: handleContextMenu };
}
```

### 9.5 File Change Inventory

| File | Change | Description |
|------|--------|-------------|
| `src-tauri/src/lib.rs` | Major | Add Menu builder, event handlers, new `show_context_menu` command |
| `src-tauri/src/menu.rs` | **New** | Native menu bar and popup menu construction |
| `src-tauri/tauri.conf.json` | Minor | Menu capabilities if needed |
| `src/App.tsx` | Major | Add global `contextmenu` suppression. Remove React `keydown` handlers migrated to native menu. Add menu event listener. |
| `src/hooks/useContextMenu.ts` | **New** | Hook for Category A native context menus |
| `src/hooks/useTextContextMenu.ts` | **New** | Hook for Category B text input menus |
| `src/components/SessionContextMenu.tsx` | **Delete** | Replaced by native popup |
| `src/components/SessionList.tsx` | Minor | Use `useContextMenu`, add empty-area handler |
| `src/components/ProcessPanel.tsx` | Minor | Remove inline menu, use `useContextMenu` |
| `src/components/TerminalPane.tsx` | Minor | Add `onContextMenu` with `useContextMenu` |
| `src/components/GitFileRow.tsx` | Minor | Add `onContextMenu` |
| `src/components/GitProjectSection.tsx` | Minor | Add section header context menu |
| `src/components/GitBranchSelector.tsx` | Minor | Add `onContextMenu` |
| `src/components/GitLogView.tsx` | Minor | Add `onContextMenu` |
| `src/components/GitStashSection.tsx` | Minor | Add `onContextMenu` |
| `src/components/GitDiffView.tsx` | Minor | Add `onContextMenu` for diff content |
| `src/components/FileExplorerPanel.tsx` | Minor | Add `onContextMenu` for files + empty area |
| `src/components/SearchPanel.tsx` | Minor | Add `onContextMenu` for results + text input |
| `src/components/ContextPanel.tsx` | Minor | Add `onContextMenu` |
| `src/components/SplitPane.tsx` | Minor | Add `onContextMenu` on pane headers |
| `src/components/ExecutionTimeline.tsx` | Minor | Add `onContextMenu` |
| `src/components/CostDashboard.tsx` | Minor | Add `onContextMenu` for rows + header |
| `src/components/PromptComposer.tsx` | Minor | Add `useTextContextMenu` |
| `src/components/CommandPalette.tsx` | Minor | Add `useTextContextMenu` for search input |
| `src/components/TemplatePicker.tsx` | Minor | Add `useTextContextMenu` for search input |
| `src/components/Settings.tsx` | Minor | Add `useTextContextMenu` for input fields |
| `src/components/StatusBar.tsx` | Minor | Add `onContextMenu` for widgets + fallback |
| `src/styles/components/SessionList.css` | Minor | Remove `.session-context-menu` styles |
| `src/styles/components/ProcessPanel.css` | Minor | Remove `.process-context-menu` styles |

---

## 10. Success Metrics

### 10.1 Quantitative

| Metric | Target | Method |
|--------|--------|--------|
| Browser context menu occurrences | **0** across all surfaces | Manual exhaustive audit + automated test: intercept all `contextmenu` events, verify none reach browser default |
| Context menu coverage | **100%** of Category A/B/D surfaces | Audit against Section 5.3 checklist |
| Context menu latency | **< 50ms** from right-click to menu visible | Performance profiling |
| Menu bar shortcut accuracy | **100%** of shortcuts match behavior | Automated test: trigger each shortcut, verify action |
| Custom `<div>` context menus remaining | **0** | Code search for `position: fixed` + `contextmenu` patterns |
| Accessibility compliance | Menu bar navigable via VoiceOver | VoiceOver testing |

### 10.2 Qualitative

| Metric | Target | Method |
|--------|--------|--------|
| "App feels native" | Positive sentiment in feedback | Post-update survey |
| Reduced "how do I..." questions | Decrease after release | Support channel monitoring |
| macOS HIG compliance | Zero ordering/naming violations | Manual review against Apple HIG |

---

## 11. Out of Scope

| Item | Rationale |
|------|-----------|
| Custom menu item icons | Text-only for v1. Native menus support icons but add complexity. |
| User-customizable menus | Fixed structure. No add/remove/reorder. |
| Dock menu | Separate feature. |
| Touch Bar | Deprecated by Apple. |
| Windows/Linux menus | macOS-only app. |
| Toolbar | No toolbar planned. |
| Drag-and-drop from menus | Click-only items. |
| Plugin/extension menu items | No third-party extensibility in this phase. |
| Localization / i18n | English only for v1. |
| Re-enabling browser DevTools context menu | Use `Cmd+Opt+I` instead. |

---

## 12. Rollout Plan

### Phase 1: Foundation + Global Suppression (Week 1–2)

| Task | Details |
|------|---------|
| **Global `contextmenu` suppression** | Add capture-phase listener in `App.tsx` to eliminate browser context menu on ALL surfaces. This is the single most impactful change — eliminates the "Reload" data-loss risk immediately. |
| Implement `menu.rs` module | Build full native menu bar in Rust. |
| Wire menu events to frontend | Event bridge from Rust menu actions → React dispatcher. |
| Remove React keyboard handlers | Migrate all shortcuts from `App.tsx` `useEffect` to native menu accelerators. |
| Implement `useContextMenu` hook | Shared hook for native popup menus. |
| Implement `useTextContextMenu` hook | Shared hook for text input menus. |
| Test standard menu items | Verify Hide/Quit/Minimize/Full Screen/Services. |

### Phase 2: P0 Context Menus (Week 3–4)

| Task | Details |
|------|---------|
| Terminal context menu | Copy/Paste/Clear/Split — highest user impact. |
| Session list migration | Migrate `SessionContextMenu.tsx` to native popup. Delete old component. |
| Git file row menu | Stage/Unstage/Discard/Diff/Reveal. |
| File Explorer menu | Open/New/Rename/Delete/Reveal — file + folder variants. |
| Text input menus | Apply `useTextContextMenu` to PromptComposer, all search inputs, Settings inputs. |

### Phase 3: P1 Context Menus + Migration (Week 5–6)

| Task | Details |
|------|---------|
| Process panel migration | Migrate inline menu to native popup. |
| Git branch/log/stash menus | Context menus for remaining Git surfaces. |
| Pane header menu | Split/Close on pane tabs. |
| Git section header menus | Stage All / Unstage All on section headers. |
| Status bar menus | Branch name widget + general fallback. |

### Phase 4: P2 Menus + Polish (Week 7–8)

| Task | Details |
|------|---------|
| Search results menu | Open/Copy Path/Reveal. |
| Context panel menu | Pin/Unpin/Remove/Copy Path. |
| Execution timeline menu | Copy Command/Re-run/Copy Output. |
| Cost dashboard menu | Copy Row/Export CSV. |
| Empty-area fallback menus | Sidebar empty, file explorer empty. |
| Menu state synchronization | Checkmarks + disabled states update in real-time. |
| Edge case testing | Multi-line paste, mouse-mode terminal, shortcut conflicts. |
| Accessibility audit | VoiceOver testing, keyboard navigation verification. |
| **Exhaustive surface audit** | Right-click every pixel of the app against Section 5.3 checklist. Document any gaps. |

---

## 13. Open Questions

| # | Question | Impact | Resolution Needed By |
|---|----------|--------|---------------------|
| OQ1 | Should `Cmd+Shift+Z` remain "Toggle Flow Mode" or be remapped to give `Cmd+Shift+Z` to Redo? | Existing users may have muscle memory. | Phase 1 start |
| OQ2 | Should context menus be 100% native (`Menu::popup`) or hybrid with a custom React component for richer rendering (previews, icons)? | Native = better a11y + look; custom = more flexibility. | Phase 1 start |
| OQ3 | How should `Cmd+C` dual behavior (Copy vs. SIGINT) work with native menu bar? | Native menu accelerators fire before webview. Need to intercept + check selection state. | Phase 1 |
| OQ4 | Should "Close All Sessions" require confirmation even when no processes are running? | Risk of accidental data loss. | Phase 1 |
| OQ5 | Multi-line paste warning in terminal — opt-in or opt-out? | Power users vs. new users trade-off. | Phase 2 |
| OQ6 | Should File Explorer include "Open in Default Editor" (VS Code, etc.)? | Useful but adds dependency on detecting default editor. | Phase 3 |
| OQ7 | Should the global `contextmenu` suppression be shipped as a hotfix BEFORE the full menu implementation, given the "Reload" data-loss risk? | Two-line change that eliminates the most dangerous bug immediately. | Immediately |
| OQ8 | For Category C surfaces, should right-click show a brief visual feedback (subtle ripple/flash) or be completely invisible? | Users might wonder if their right-click was "received" or if the app is frozen. | Phase 1 |
| OQ9 | Should there be a "Copy as" submenu in the terminal context menu (Copy as Plain Text, Copy as HTML with formatting, Copy as Rich Text)? | Useful for pasting terminal output into documents with syntax colors preserved. | Phase 2 |

---

## 14. Appendix

### 14.1 macOS Standard Menu Order

```
[Apple] | App Name | File | Edit | View | [App-Specific] | Window | Help
```

For Hermes IDE:

```
[Apple] | Hermes | File | Edit | View | Session | Window | Help
```

### 14.2 Existing Keyboard Shortcuts (Complete Mapping)

| Shortcut | Current Action | In Menu Bar | Location |
|----------|---------------|-------------|----------|
| `Cmd+N` | New Session | Yes | File > New Session |
| `Cmd+T` | New Session (legacy) | No | Removed — `Cmd+N` is canonical |
| `Cmd+W` | Close Session/Pane | Yes | File > Close Session |
| `Cmd+D` | Split Right | Yes | View > Split Pane Right |
| `Cmd+Shift+D` | Split Down | Yes | View > Split Pane Down |
| `Cmd+K` | Command Palette | Yes | View > Command Palette |
| `Cmd+E` | Toggle Context Panel | Yes | View > Panels > Context |
| `Cmd+J` | Prompt Composer | Yes | View > Prompt Composer |
| `Cmd+R` | Open Realm Picker | Yes | File > Open Realm... |
| `Cmd+B` | Toggle Sidebar | Yes | View > Toggle Sidebar |
| `Cmd+P` | Process Panel | Yes | View > Panels > Processes |
| `Cmd+G` | Git Panel | Yes | View > Panels > Git |
| `Cmd+F` | File Explorer | Yes | File > Open File Explorer |
| `Cmd+Shift+F` | Search Panel | Yes | Edit > Find in Project... |
| `Cmd+L` | Execution Timeline | Yes | View > Panels > Timeline |
| `Cmd+$` | Cost Dashboard | Yes | View > Panels > Cost Dashboard |
| `Cmd+,` | Settings | Yes | Hermes > Settings... |
| `Cmd+/` | Shortcuts Help | Yes | Help > Keyboard Shortcuts |
| `Cmd+Shift+Z` | Toggle Flow Mode | **Conflict** | Needs remapping |
| `Cmd+Opt+Arrow` | Navigate Panes | No | Not in menu (complex key combo) |
| `Cmd+1`–`Cmd+9` | Switch to Session N | Yes | Session > Session 1–9 |
| `F1` | Interrupt (Stuck) | No | Not in menu (emergency key) |
| `F3` | Auto-execute Suggestion | No | Not in menu (contextual) |

### 14.3 Application Surface Map (Visual)

```
┌─────────────────────────────────────────────────────────────────────┐
│  Top Bar (C: Suppressed)           [native traffic lights]         │
├────────┬────────────────────────────────────────────────────────────┤
│        │                                                            │
│  Act.  │  ┌─ Sidebar ──────────────┐  ┌─ Main Area ──────────────┐│
│  Bar   │  │                        │  │                           ││
│  (C)   │  │  SessionList    (A)    │  │  ┌─ Pane Header ── (A) ──┐││
│        │  │  └ empty area   (D)    │  │  │                       │││
│        │  │                        │  │  │  Terminal Pane  (A)   │││
│        │  │  GitPanel              │  │  │                       │││
│        │  │  ├ section hdr  (D)    │  │  └───────────────────────┘││
│        │  │  ├ GitFileRow   (A)    │  │  ┌─ Pane Header ── (A) ──┐││
│        │  │  ├ GitBranch    (A)    │  │  │                       │││
│        │  │  ├ GitLog       (A)    │  │  │  Terminal Pane  (A)   │││
│        │  │  ├ GitStash     (A)    │  │  │                       │││
│        │  │  ├ DiffView     (A)    │  │  └───────────────────────┘││
│        │  │  └ empty state  (C)    │  │        Divider (C)        ││
│        │  │                        │  │                           ││
│        │  │  FileExplorer          │  │  PromptComposer  (B)      ││
│        │  │  ├ file item    (A)    │  │                           ││
│        │  │  ├ folder item  (A)    │  │                           ││
│        │  │  └ empty area   (D)    │  └───────────────────────────┘│
│        │  │                        │                                │
│        │  │  SearchPanel           │  Execution Timeline  (A)      │
│        │  │  ├ result row   (A)    │                                │
│        │  │  ├ search input (B)    │  Cost Dashboard               │
│        │  │  └ empty area   (C)    │  ├ data row   (A)             │
│        │  │                        │  └ header     (D)             │
│        │  │  ContextPanel          │                                │
│        │  │  ├ entry        (A)    │                                │
│        │  │  └ empty area   (C)    │                                │
│        │  │                        │                                │
│        │  │  ProcessPanel          │                                │
│        │  │  ├ row          (A)    │                                │
│        │  │  └ header       (C)    │                                │
│        │  └────────────────────────┘                                │
│        │                                                            │
├────────┴────────────────────────────────────────────────────────────┤
│  Status Bar: general (D) | branch widget (A) | other widgets (C)   │
└─────────────────────────────────────────────────────────────────────┘

Legend:
  (A) = Rich Context Menu — purpose-built native menu with relevant actions
  (B) = Text Input Menu — Cut / Copy / Paste / Select All
  (C) = Suppressed — no menu, event silently consumed
  (D) = Contextual Fallback — lightweight menu with general region actions
```

### 14.4 Risk: "Reload" Data-Loss Scenario

```
Current state (DANGEROUS):

  User right-clicks anywhere in the app
         │
         ▼
  Browser context menu appears
  ┌──────────────────┐
  │ Back             │
  │ Forward          │
  │ Reload         ◄─┼── One click destroys everything
  │ Save As...       │
  │ Print...         │
  │ Inspect Element  │
  └──────────────────┘
         │
         ▼ (user clicks Reload)
         │
  WebView refreshes → All React state destroyed
         │
  ┌──────────────────────────────┐
  │ LOST:                        │
  │ • All terminal sessions      │
  │ • All running processes      │
  │ • All PTY connections        │
  │ • Unsaved prompt drafts      │
  │ • Panel states               │
  │ • Navigation history         │
  └──────────────────────────────┘
```

**This is eliminated by REQ-GLOBAL-RCM (Section 5.1)** — the very first task in Phase 1.

---

*End of PRD*
