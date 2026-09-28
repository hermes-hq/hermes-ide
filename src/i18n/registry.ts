import { getSetting, setSetting } from "../api/settings";

export type TranslationMessages = Record<string, string>;

export interface LanguagePack {
  locale: string;
  label: string;
  nativeLabel?: string;
  messages: TranslationMessages;
}

/**
 * A language pack whose messages are fetched only when the language is
 * actually used. Its name shows in the language picker right away; the
 * translations load when the user picks it (or at startup when it is the
 * saved language). Until they arrive, English is shown.
 */
export interface LazyLanguagePack {
  locale: string;
  label: string;
  nativeLabel?: string;
  load: () => Promise<LanguagePack>;
}

export interface I18nSnapshot {
  currentLanguage: string;
  languages: LanguagePack[];
}

export const UI_LANGUAGE_SETTING = "ui_language";
const UI_LANGUAGE_STORAGE_KEY = "hermes.ui_language";

const ENGLISH_PACK: LanguagePack = {
  locale: "en",
  label: "English",
  nativeLabel: "English",
  messages: {
    "app.plugins": "Plugins",
    "app.app": "App",
    "app.settings": "Settings",
    "app.context": "Context",
    "app.usage": "Usage · plan & limits",
    "app.workbench": "Workbench",
    "app.folders": "Folders",
    "app.help": "Help",
    "app.tools": "Tools",
    "app.view": "View",
    "app.session": "Session",
    "composer.builder": "Builder",
    "composer.openPromptBuilder": "Open prompt builder",
    "composer.openPromptBuilderTitle": "Open prompt builder ({shortcut})",
    "composer.compose": "Compose",
    "composer.openComposer": "Open composer",
    "composer.openComposerTitle": "Open composer ({shortcut})",
    "composer.resize": "Resize composer",
    "composer.slashCommands": "Slash commands",
    "composer.noSlashCommands": "No commands available yet — Claude will publish them once it's ready.",
    "composer.attachedImages": "Attached images",
    "composer.removeImage": "Remove image",
    "composer.removePastedImage": "Remove pasted image",
    "composer.messagePlaceholder": "Message {label}…  (/ for commands)",
    "composer.typeMessagePlaceholder": "Type a message…",
    "composer.composeAgentMessage": "Compose agent message",
    "composer.restore": "Restore",
    "composer.maximize": "Maximize",
    "composer.restoreComposer": "Restore composer",
    "composer.maximizeComposer": "Maximize composer",
    "composer.minimizeToIcon": "Minimize to icon",
    "composer.minimizeComposer": "Minimize composer",
    "composer.toggleTerminal": "Toggle inline shell terminal",
    "composer.terminal": "Terminal",
    "composer.attach": "Attach",
    "composer.attachImage": "Attach image",
    "composer.attachImageHint": "Attach image (PNG, JPG, GIF, WebP, BMP)",
    "composer.switchModel": "Switch model — current: {model}",
    "composer.modelSwitchFailed": "Model switch failed — keeping current model.",
    "composer.modelSwapFailed": "model swap failed",
    "composer.permissionMode": "Permission mode: {mode}",
    "composer.permissionModeTitle": "Permission mode: {mode} — click to switch",
    "composer.permissionSwitchFailed": "Permission swap failed — keeping current mode.",
    "composer.permissionSwapFailed": "permission swap failed",
    "composer.effort": "Effort",
    "composer.effortTitle": "Thinking effort — respawns Claude with --effort",
    "composer.effortLevel": "Effort: {level}",
    "composer.effortSwitchFailed": "Effort swap failed — keeping current level.",
    "composer.effortSwapFailed": "effort swap failed",
    "composer.connecting": "connecting…",
    "composer.send": "Send",
    "composer.sendTitle": "Send (Enter · Shift+Enter for newline)",
    "composer.sendMessage": "Send message",
    "builder.title": "Prompt Composer",
    "builder.templates": "Templates",
    "builder.browseTemplatesButton": "Browse templates",
    "builder.browseTemplatesTitle": "Browse templates ({shortcut})",
    "builder.startFromTemplate": "Start from a template",
    "builder.browseTemplates": "Browse {count} ready-to-use prompt templates",
    "builder.task": "Task",
    "builder.taskPlaceholder": "What should the AI do? This is the main instruction.",
    "builder.scope": "Scope",
    "builder.scopePlaceholder": "Files, directories, or boundaries. e.g. Focus on src/auth/. Don't touch tests.",
    "builder.advanced": "Advanced",
    "builder.toggleAdvanced": "Toggle advanced options",
    "builder.constraints": "Constraints",
    "builder.constraintsPlaceholder": "Rules, limitations, requirements. e.g. No new dependencies. Keep backward compat.",
    "builder.additionalStyleNotes": "Additional Style Notes",
    "builder.additionalStyleNotesPlaceholder": "Extra style instructions beyond the presets above. e.g. Show line references.",
    "builder.preview": "Preview",
    "builder.emptyPreview": "Fill in the fields to see the compiled prompt...",
    "builder.templateNamePlaceholder": "Template name...",
    "builder.saveTemplate": "Save Template",
    "builder.clearAllFields": "Clear all fields?",
    "builder.yesClear": "Yes, clear",
    "builder.clear": "Clear",
    "builder.copy": "Copy",
    "builder.send": "Send",
    "builder.searchTemplates": "Search templates...",
    "builder.myTemplates": "My Templates",
    "builder.builtIn": "Built-in",
    "builder.pinned": "Pinned",
    "builder.noTemplatesMatch": "No templates match \"{query}\"",
    "builder.import": "Import",
    "builder.exportAll": "Export All",
    "builder.importTemplatesHint": "Import templates from a .hermes-prompts file",
    "builder.exportAllHint": "Export all saved templates to a .hermes-prompts file",
    "builder.groupNamePlaceholder": "Group name...",
    "builder.newGroup": "New Group",
    "builder.ungrouped": "Ungrouped",
    "builder.noTemplatesInGroup": "No templates in this group",
    "builder.noSavedTemplates": "No saved templates yet. Save a prompt or import a bundle.",
    "builder.pinTemplate": "Pin template",
    "builder.unpinTemplate": "Unpin template",
    "builder.moveToGroup": "Move to group",
    "builder.exportTemplate": "Export template",
    "builder.deleteTemplate": "Delete template",
    "builder.renameGroup": "Rename group",
    "builder.deleteGroup": "Delete group (templates are kept)",
    "builder.roles": "Roles",
    "builder.role": "role",
    "builder.rolesSelectedPlaceholder": "{count} selected - search to add more...",
    "builder.searchRoles": "Search roles...",
    "builder.removeRole": "Remove role",
    "builder.deleteCustomRole": "Delete custom role",
    "builder.noRolesMatch": "No roles match \"{query}\"",
    "builder.createCustomRole": "Create custom role...",
    "builder.invalidRole": "Invalid role",
    "builder.label": "Label",
    "builder.descriptionOptional": "Description (optional)",
    "builder.roleLabelPlaceholder": "e.g. Data Engineer",
    "builder.roleDescriptionPlaceholder": "e.g. ETL, data pipelines, warehousing",
    "builder.systemInstruction": "System Instruction",
    "builder.systemInstructionPlaceholder": "e.g. You are a data engineer with expertise in...",
    "builder.style": "Style",
    "builder.stylesSelectedPlaceholder": "{count} selected - search to add more...",
    "builder.searchStyles": "Search styles...",
    "builder.removeStyle": "Remove style",
    "builder.deleteCustomStyle": "Delete custom style",
    "builder.noStylesMatch": "No styles match \"{query}\"",
    "builder.createCustomStyle": "Create custom style...",
    "builder.invalidStyle": "Invalid style",
    "builder.styleLabelPlaceholder": "e.g. Minimalist",
    "builder.styleDescriptionPlaceholder": "e.g. Extremely minimal output",
    "builder.levelInstruction": "Level {level} instruction",
    "builder.intensityLevel": "Intensity: {level}/5",
    "builder.levelDot": "Level {level}",
    "builder.subtleVersion": "Subtle version...",
    "builder.standardVersion": "Standard version...",
    "builder.maximumIntensity": "Maximum intensity...",
    "builder.save": "Save",
    "builder.close": "Close (Esc)",
    "builder.exportedTemplate": "Exported \"{name}\"",
    "builder.exportedAll": "Exported {count} templates",
    "builder.exportFailed": "Export failed: {error}",
    "builder.importFailed": "Import failed: {error}",
    "builder.invalidBundleJson": "Invalid bundle file: not valid JSON",
    "builder.importedTemplates": "{count} templates",
    "builder.importedRoles": "{count} roles",
    "builder.importedStyles": "{count} styles",
    "builder.importedSummary": "Imported {parts}",
    "builder.importedSummarySkipped": "Imported {parts} ({count} skipped)",
    "builder.nothingToImport": "Nothing new to import",
    "builder.nothingToImportSkipped": "Nothing new to import ({count} skipped)",
    "session.new": "New session",
    "session.step": "Step {current} of {total}",
    "startupProblem.newerData.title": "Your data is from a newer version of Hermes",
    "startupProblem.newerData.message": "This data was saved by a newer version of Hermes (data version {found}; this version understands up to {supported}). Hermes has not opened or changed it. Install the latest version of Hermes to keep using your sessions and settings.",
    "startupProblem.backupFailed.title": "Hermes could not back up your data",
    "startupProblem.backupFailed.message": "Hermes needs to update its data, but could not save a backup first, so nothing was changed: {detail}",
    "startupProblem.migrationFailed.title": "Hermes could not update your data",
    "startupProblem.migrationFailed.message": "Hermes could not update its data (step {step}). The update was undone and your data is unchanged: {detail}",
    "startupProblem.openFailed.title": "Hermes could not open your data",
    "startupProblem.openFailed.message": "Hermes could not open its data: {detail}",
    "startupProblem.dataFile": "Data file",
    "startupProblem.quit": "Quit Hermes",
    "common.close": "Close",
    "common.continue": "Continue",
    "common.back": "Back",
    "common.next": "Next",
    "common.skip": "Skip",
    "common.create": "Create",
    "common.none": "None",
    "common.browse": "Browse",
    "common.scan": "Scan",
    "common.creating": "Creating...",
    "common.checking": "Checking...",
    "common.retry": "Retry",
    "common.navigate": "navigate",
    "common.select": "select",
    "common.toggle": "toggle",
    "common.selectedCount": "Next ({count} selected)",
    "session.chooseAgent": "What do you want to run?",
    "session.agentView": "Agent view for Claude",
    "session.agentViewHint": "Optional. Hermes shows the conversation, tool runs and diffs in its own view instead of Claude's terminal interface.",
    "session.agentViewSummary": "Claude · Agent view",
    "session.connectSsh": "Connect over SSH",
    "session.projectContext": "Project context",
    "session.workingDirectory": "Working directory",
    "session.selectFolders": "Select folders",
    "session.projectContextHint": "Claude can work across these folders. The first is the project root.",
    "session.workingDirectoryHint": "Your shell will open in this folder.",
    "session.selectFoldersHint": "The AI can work across all selected folders. The first folder is the working directory.",
    "session.selectBranches": "Select branches",
    "session.selectBranchesHint": "Each project gets its own isolated branch so changes in this session don't affect other sessions.",
    "session.continueWithoutIsolation": "Continue without isolation",
    "session.filterFolders": "Filter folders...",
    "session.noFolders": "No folders found. Scan a directory below to add one.",
    "session.noFoldersMatch": "No folders matching \"{query}\"",
    "session.folderNotFound": "Folder not found",
    "session.notGitRepo": "Not a git repository",
    "session.pathOrBrowse": "Path or browse...",
    "session.account": "Account",
    "session.account.active": "Switcher active",
    "session.account.acc1": "Account 1",
    "session.account.acc2": "Account 2",
    "session.accountHint": "Choose which configured account this session should use.",
    "session.approvalFlow": "Approval Flow",
    "session.prefixCommand": "Prefix command",
    "session.customFlags": "Custom flags",
    "session.prefixCommandHint": "Prepended to the launch command:",
    "session.customFlagsHint": "Appended to the AI agent launch command",
    "session.flagsPlaceholder": "e.g. --model opus --permission-mode plan",
    "session.preview": "Preview",
    "session.channels": "Channels",
    "session.channelsHint": "Let Claude interact with external services during this session.",
    "session.plainShell": "Plain shell",
    "session.noAiAgent": "No AI agent",
    "session.sshRemote": "SSH Remote",
    "session.sshHostPlaceholder": "Host (e.g. 192.168.1.100 or myserver.com)",
    "session.sshUserPlaceholder": "User (optional — uses ~/.ssh/config)",
    "session.sshPortPlaceholder": "Port",
    "session.sshIdentityFilePlaceholder": "Identity file (optional, e.g. ~/.ssh/id_rsa)",
    "session.sshJumpHostPlaceholder": "Jump host (optional, e.g. bastion.example.com)",
    "session.sshLabelExample": "Label (e.g. My Server)",
    "session.sshConfigHint": "Uses your system SSH config and agent for authentication.",
    "session.tmuxSessions": "tmux sessions",
    "session.newTmuxSession": "New tmux session",
    "session.newTmuxSessionHint": "Create a new persistent session",
    "session.notDetected": "Not detected",
    "session.cliNotDetected": "{cli} was not detected on your system.",
    "session.customAgentName": "Name",
    "session.customAgentNamePlaceholder": "e.g. My agent",
    "session.customAgentCommand": "Command",
    "session.customAgentCommandPlaceholder": "e.g. aider --model sonnet",
    "session.customAgentCommandHint": "Hermes starts this command in the session's terminal, as if you typed it.",
    "session.agentLaunchFailed": "{agent} was not found. Install with: {command}",
    "session.agentLaunchFailedNoInstall": "{agent} was not found.",
    "session.customAgentLaunchFailed": "The custom agent's command was not found. Check the command in a new session.",
    "agentSetup.chipTitle": "Instruction files this agent loads. Click for its settings, skills and MCP servers.",
    "agentSetup.noInstructions": "No instruction file",
    "agentSetup.title": "{agent}: what it loads",
    "agentSetup.instructions": "Instruction files",
    "agentSetup.settings": "Settings",
    "agentSetup.skills": "Skills",
    "agentSetup.mcp": "MCP servers each agent sees here",
    "agentSetup.none": "None",
    "agentSetup.notLoaded": "not loaded",
    "agentSetup.global": "global",
    "agentSetup.attached": "attached folder",
    "agentSetup.linkedFrom": "linked from {file}",
    "agentSetup.link": "Link {file} to AGENTS.md",
    "agentSetup.linkHint": "Adds @AGENTS.md to {file}, so this agent follows the same project rules as the others.",
    "agentSetup.readOnly": "Hermes only reads these files. It writes MCP servers only to the project's .mcp.json.",
    "agentSetup.unknown": "Hermes does not know where this agent keeps its setup.",
    "agentSetup.linkFailed": "Could not link: {error}",
    "safety.looser": "Looser than default",
    "safety.looserFlag": "Started with {flag}, which is looser than Hermes's default: write inside the folder, ask before using the network or other folders.",
    "safety.looserVendor": "{agent} has no launch option that holds it to Hermes's default. {note}",
    "safety.hermesDefault": "Hermes default",
    "session.saved": "Saved",
    "session.recent": "Recent",
    "session.confirm": "Confirm",
    "session.connection": "Connection:",
    "session.host": "Host:",
    "session.folder": "Folder:",
    "session.folders": "Folders:",
    "session.mode": "Mode:",
    "session.namePlaceholder": "Session name (optional)",
    "session.descriptionPlaceholder": "Description (optional)",
    "session.project": "Project",
    "session.newProject": "+ New",
    "session.projectName": "Project name...",
    "session.color": "Color",
    "session.createSession": "Create session",
    "session.createHint": "create",
    "session.closeHint": "close",
    "usage.title": "USAGE",
    "usage.live": "live",
    "usage.agentOnly": "Usage telemetry is only available for agent-mode sessions.",
    "usage.account": "Account",
    "usage.plan": "Plan",
    "usage.email": "Email",
    "usage.org": "Org",
    "usage.provider": "Provider",
    "usage.auth": "Auth",
    "usage.waitingAccount": "waiting for account probe...",
    "usage.rateLimits": "Rate limits",
    "usage.noLimits": "no limits reported yet - sent any messages?",
    "usage.thisSession": "This session",
    "usage.cost": "Cost",
    "usage.input": "Input",
    "usage.output": "Output",
    "usage.footnote": "Snapshot updated on every turn. Limits reported by Claude.",
    "usage.currentSession": "Current session",
    "usage.weeklyAllModels": "Weekly · all models",
    "usage.weeklySonnet": "Weekly · Sonnet only",
    "usage.weeklyOpus": "Weekly · Opus only",
    "usage.weeklyHaiku": "Weekly · Haiku only",
    "usage.dailyWindow": "Daily window",
    "usage.activeWindow": "Active window",
    "usage.freshWindow": "fresh window",
    "usage.resetsInDaysHours": "resets in {days}d {hours}h",
    "usage.resetsInHoursMinutes": "resets in {hours}h {minutes}m",
    "usage.resetsInMinutes": "resets in {minutes}m",
    "usage.resetsInSeconds": "resets in {seconds}s",
    "usage.extraActive": "Extra usage active",
    "branch.selectBranch": "Select Branch",
    "branch.existingBranch": "Existing Branch",
    "branch.newBranch": "New Branch",
    "branch.fetch": "Fetch",
    "branch.fetching": "Fetching...",
    "branch.fetchLatest": "Fetch latest branches from remote",
    "branch.loading": "Loading branches...",
    "branch.loadFailed": "Failed to load branches: {error}",
    "branch.retryLoading": "Retry loading branches",
    "branch.useCurrent": "Use current branch",
    "branch.noneFound": "No local branches found. This project may not be a git repository, or the repository has no commits yet.",
    "branch.filterBranches": "Filter branches...",
    "branch.noMatches": "No branches matching \"{query}\"",
    "branch.current": "current",
    "branch.remote": "remote",
    "branch.inUse": "in use",
    "branch.branchName": "Branch Name",
    "branch.basedOn": "Based On",
    "branch.useCurrentHint": "Uses the same branch as other sessions - changes will be shared",
    "branch.createAndUse": "Create & Use Branch",
    "permission.default.shortLabel": "Default",
    "permission.default.description": "The AI asks before editing files or running commands.",
    "permission.acceptEdits.shortLabel": "Accept Edits",
    "permission.acceptEdits.description": "Auto-accept file edits, still ask for shell commands.",
    "permission.plan.shortLabel": "Plan",
    "permission.plan.description": "Read-only exploration and planning - no edits allowed.",
    "permission.auto.shortLabel": "Auto",
    "permission.auto.description": "Background classifier handles approvals automatically.",
    "permission.dontAsk.shortLabel": "Don't Ask",
    "permission.dontAsk.description": "Execute all actions without asking. Still applies safety guardrails.",
    "permission.bypassPermissions.shortLabel": "Bypass",
    "permission.bypassPermissions.description": "No permission checks at all. Use with caution.",
    "empty.beginSession": "Begin a session",
    "empty.newSessionTitle": "New session",
    "empty.newSessionDesc": "Run Claude, Codex or any agent in its own terminal, or open a plain shell.",
    "empty.commandPaletteTitle": "Command palette",
    "empty.commandPaletteDesc": "Jump to settings, themes, recent sessions, anywhere.",
    "empty.contextPanelTitle": "Context panel",
    "empty.contextPanelDesc": "MCP servers, memory, permissions — show or hide.",
    "empty.contextPanelPlaceholder": "Open a session to inspect its context — MCP servers, memory, and permissions show up here.",
    "empty.dropFolderHint": "or drop a folder onto the window to bind it as a workspace.",
    "empty.recentSessions": "Recent sessions",
    "empty.logbook": "Logbook",
    "empty.mostRecent": "most-recent first",
    "empty.footer": "made for the workshop",
    "empty.tagline": "an instrument panel for working with code & agents.",
    "palette.newSession": "New Session",
    "palette.toggleContext": "Toggle Context Panel",
    "palette.toggleSidebar": "Toggle Sidebar",
    "palette.settingsGeneral": "Settings / General",
    "palette.settingsAppearance": "Settings / Appearance",
    "palette.settingsTheme": "Settings / Theme",
    "palette.settingsGit": "Settings / Git",
    "palette.settingsPrivacy": "Settings / Privacy",
    "palette.settingsShortcuts": "Settings / Shortcuts",
    "palette.settingsPlugins": "Settings / Plugins",
    "palette.pluginSettings": "Settings / {name}",
    "palette.costDashboard": "Cost Dashboard",
    "palette.toggleFlowMode": "Toggle Flow Mode",
    "palette.addFolder": "Add Folder...",
    "palette.scanCurrentDirectory": "Scan Current Directory",
    "palette.promptComposer": "Prompt Composer",
    "palette.keyboardShortcuts": "Keyboard Shortcuts",
    "palette.toggleGitPanel": "Toggle Git Panel",
    "palette.searchInFolder": "Search in Folder",
    "palette.checkPluginUpdates": "Check for Plugin Updates",
    "palette.placeholder": "Type a command or session name...",
    "palette.noResults": "No results for \"{query}\"",
    "close.agent.title": "End conversation?",
    "close.terminal.title": "Close session?",
    "close.agent.body": "This will end the conversation with Claude.",
    "close.terminal.body": "This will terminate the running terminal session.",
    "close.agent.confirm": "End conversation",
    "close.terminal.confirm": "Close session",
    "session.deleteData.confirm": "Delete Hermes's cached data for this session? This clears its history, token usage and remembered context in Hermes. The session and its repository are left untouched.",
    "close.dontAsk": "Don't ask again",
    "common.cancel": "Cancel",
    "status.active": "{count} active",
    "status.working": "WORKING",
    "status.needsInput": "NEEDS INPUT",
    "status.tokens": "{count} tokens",
    "status.copyCost": "Copy Cost",
    "status.copyTokenCount": "Copy Token Count",
    "status.copyWorkingDirectory": "Copy Working Directory",
    "status.projectContext": "Project context: {path}",
    "status.workingDirectory": "Working directory: {path}",
    "status.reportBug": "Report a Bug",
    "status.keyboardShortcuts": "Keyboard Shortcuts ({shortcut})",
    "statusbar.ioTitle": "Input: {input} · Output: {output}",
    "statusbar.update.available": "Update to v{version}",
    "statusbar.update.check": "Check for updates",
    "statusbar.update.downloading": "Downloading v{version}…",
    "statusbar.update.ready": "v{version} ready",
    "time.justNow": "just now",
    "time.minutesAgo": "{n}m ago",
    "time.hoursAgo": "{n}h ago",
    "time.daysAgo": "{n}d ago",
    "settings.title": "Settings",
    "settings.general": "General",
    "settings.appearance": "Appearance",
    "settings.ssh": "SSH",
    "settings.git": "Git",
    "settings.shortcuts": "Shortcuts",
    "settings.aiAgent": "AI Agent",
    "settings.privacy": "Privacy",
    "settings.flags": "Flags",
    "settings.flags.hint": "Hidden developer section. Release channel detected at startup: {channel}. Overrides below take effect the next time Hermes launches.",
    "settings.flags.default": "Default for channel",
    "settings.flags.forceOn": "Force on",
    "settings.flags.forceOff": "Force off",
    "settings.defaultShell": "Default Shell",
    "settings.systemDefault": "System default",
    "settings.terminalScrollback": "Terminal Scrollback",
    "settings.lines": "{count} lines",
    "settings.shellSuggestions": "Hermes inline suggestions",
    "settings.shellSuggestionsHint": "Show Hermes's own command suggestions as you type. Turn off to use your shell's own autosuggestions instead. Applies to new terminal sessions.",
    "settings.updateChannel": "Update channel",
    "settings.updateChannelStable": "Stable",
    "settings.updateChannelBeta": "Beta — gets releases before stable",
    "settings.updateChannelHint": "Beta builds have passed the same automated checks as stable ones but have not been used by other people yet. You can switch back at any time; the next stable release brings you back in line.",
    "settings.defaultWorkingDirectory": "Default Working Directory",
    "settings.homeDirectoryPlaceholder": "~ (home directory)",
    "settings.commandPaletteShortcut": "Command Palette Shortcut",
    "settings.defaultOption": "default",
    "settings.freesShortcut": "frees {shortcut} for Clear Terminal",
    "settings.requiresRestartMenu": "Requires restart to update the native menu",
    "settings.preferredEditor": "Preferred External Editor",
    "settings.editorHint": "Editor used when opening files from the file browser",
    "settings.restoreSessions": "Restore Sessions on Launch",
    "settings.restoreHint": "Re-open previous sessions and layout when the app restarts",
    "settings.always": "Always",
    "settings.never": "Never",
    "settings.confirmBeforeClosing": "Confirm before closing sessions",
    "settings.confirmBeforeClosingHint": "Show a confirmation dialog when closing a terminal session",
    "settings.theme": "Theme",
    "settings.dark": "Dark",
    "settings.light": "Light",
    "settings.pluginUpdates": "Plugin Updates",
    "settings.checkPluginUpdates": "Check for plugin updates",
    "settings.onStartup": "On startup",
    "settings.daily": "Daily",
    "settings.weekly": "Weekly",
    "settings.autoUpdatePlugins": "Auto-update plugins",
    "settings.autoUpdatePluginsHint": "Automatically install plugin updates when they become available.",
    "settings.analytics": "Send anonymous usage analytics",
    "settings.analyticsHint": "Help improve Hermes IDE by sending anonymous usage data. No personal information, terminal content, or file paths are collected.",
    "settings.export": "Export Settings",
    "settings.import": "Import Settings",
    "settings.exported": "Settings exported",
    "settings.imported": "Settings imported",
    "settings.exportFailed": "Export failed: {error}",
    "settings.importFailed": "Import failed: {error}",
    "settings.agentTimelineStyle": "Agent Timeline Style",
    "settings.agentTimelineHint": "Modern uses the speaker-chip layout with sans-serif body. Classic restores the denser logbook style.",
    "settings.modernDefault": "Modern (default)",
    "settings.classicCompact": "Classic compact",
    "settings.uiScale": "UI Scale",
    "settings.uiScaleHint": "Scales icons, text and spacing (not terminal)",
    "settings.terminalFontSize": "Terminal Font Size",
    "settings.fontFamily": "Font Family",
    "settings.windowSize": "Window Size",
    "settings.decreaseWidth": "Decrease width",
    "settings.increaseWidth": "Increase width",
    "settings.decreaseHeight": "Decrease height",
    "settings.increaseHeight": "Increase height",
    "settings.shortcutsHint": "All available keyboard shortcuts. Customization coming soon.",
    "settings.sshFileEditor": "SSH File Editor",
    "settings.terminalEditors": "Terminal editors (run in PTY)",
    "settings.guiEditors": "GUI editors (open locally via SSH remote)",
    "settings.sshEditorHint": "Editor used when opening files on SSH sessions",
    "settings.savedHosts": "Saved Hosts",
    "settings.noSshHosts": "No saved SSH hosts yet.",
    "settings.label": "Label",
    "settings.host": "Host",
    "settings.user": "User",
    "settings.port": "Port",
    "settings.identityFile": "Identity File (optional)",
    "settings.jumpHost": "Jump Host (optional)",
    "settings.serverLabelPlaceholder": "My Server",
    "settings.hostPlaceholder": "example.com",
    "settings.userPlaceholder": "root",
    "settings.identityFilePlaceholder": "~/.ssh/id_rsa",
    "settings.jumpHostPlaceholder": "bastion.example.com",
    "settings.save": "Save",
    "settings.edit": "Edit",
    "settings.addHost": "Add Host",
    "settings.autoRefreshInterval": "Auto-refresh Interval",
    "settings.oneSecond": "1 second",
    "settings.seconds": "{count} seconds",
    "settings.off": "Off",
    "settings.authorNameOverride": "Author Name Override",
    "settings.authorEmailOverride": "Author Email Override",
    "settings.useGitConfig": "Use git config (default)",
    "settings.autoStageCommit": "Auto-stage all changes on commit",
    "settings.showUntracked": "Show untracked files",
    "settings.aiAgentHint": "Default permission mode and launch-command customization for new AI agent sessions. All values can be overridden per session in the session creator.",
    "settings.defaultPermissionMode": "Default permission mode",
    "settings.askPermissions": "Ask Permissions",
    "settings.acceptEdits": "Accept Edits",
    "settings.planMode": "Plan Mode",
    "settings.autoMode": "Auto Mode",
    "settings.bypassPermissions": "Bypass Permissions",
    "settings.customCommandSuffix": "Custom command suffix (applies to every agent)",
    "settings.customCommandSuffixPlaceholder": "e.g. --model opus --max-tokens 4096",
    "settings.customCommandSuffixHint": "Text appended to AI agent launch commands in every new session.",
    "settings.perAgentPrefix": "Per-agent launch prefix",
    "settings.perAgentPrefixHint": "Prepended to the launch command for the matching agent, for example {example1} on macOS or {example2} on Windows. Runs on your local machine. Ignored for SSH sessions.",
    "settings.agents": "Agents",
    "settings.prefixExamples": "{agent} prefix examples",
    "settings.preview": "Preview",
    "plugins.search": "Search plugins...",
    "plugins.installed": "Installed",
    "plugins.browse": "Browse",
    "plugins.all": "All",
    "plugins.loading": "Loading plugins...",
    "plugins.noMatches": "No matches",
    "plugins.noInstalledMatch": "No installed plugins match \"{query}\"",
    "plugins.noPluginsInstalled": "No plugins installed",
    "plugins.browseHint": "Browse the store to discover and install plugins.",
    "plugins.noPluginsAvailable": "No plugins available",
    "plugins.registryUnavailable": "The plugin registry is empty or could not be reached.",
    "plugins.install": "Install",
    "plugins.disable": "Disable",
    "plugins.enable": "Enable",
    "plugins.builtIn": "Built-in",
    "plugins.uninstall": "Uninstall",
    "plugins.permissions": "Permissions",
    "plugins.author": "Author:",
    "plugins.category": "Category:",
    "plugins.source": "Source:",
    "plugins.checkUpdates": "Check for updates",
    "plugins.updateAll": "Update All ({count})",
    "plugins.off": "off",
    "plugins.update": "update",
    "plugins.updateTo": "Update to v{version}",
    "plugins.whatsNew": "What's new in v{version}",
    "plugins.latestChanges": "Latest changes (v{version})",
    "plugins.incompatibleTitle": "Incompatible with your app version",
    "plugins.incompatibleBody": "This plugin requires Hermes IDE v{minVersion} or later. You are on v{appVersion}. Please update the app first.",
    "plugins.noFilterMatches": "No plugins match your filters. Try a different search or category.",
    "plugins.loadingShort": "Loading...",
    "plugins.uninstallConfirmTitle": "Uninstall \"{name}\"?",
    "plugins.uninstallConfirmDesc": "This will remove the plugin files. This action cannot be undone.",
    "plugins.installConfirmTitle": "Install \"{name}\"?",
    "plugins.installConfirmDesc": "This plugin requests the following permissions:",
    "plugins.installPhase.downloading": "Downloading...",
    "plugins.installPhase.installing": "Installing...",
    "plugins.installPhase.done": "Done",
    "plugins.permission.storage": "Read and write persistent data on your device",
    "plugins.permission.network": "Make network requests to external services",
    "plugins.permission.clipboardRead": "Read text from your clipboard",
    "plugins.permission.clipboardWrite": "Write text to your clipboard",
    "plugins.permission.notifications": "Show desktop notifications",
    "plugins.permission.sessionsRead": "Access terminal session information",
    "plugins.permission.shellExec": "Execute shell commands on your system",
    "plugins.apiV1Badge": "old API",
    "plugins.apiV1Deprecated": "Built for the old plugin API (v1). It still works, but Hermes {version} stops loading it: ask the author for an update.",
    "plugins.apiUnavailableBadge": "not loaded",
    "plugins.apiV2NotEnabled": "Needs plugin API v2, which this version of Hermes does not turn on yet.",
    "plugins.apiUnsupported": "Needs plugin API {version}, which this version of Hermes does not support.",
    "plugins.apiVersion": "Plugin API:",
    "plugins.reviewChecks": "Review checks",
    "plugins.permission.inboxRaise": "Add items to your inbox",
    "plugins.permission.featuresRead": "Read your feature tracks (read only)",
    "plugins.permission.reviewChecks": "Add checks to code review",
    "workspace.projects": "Projects",
    "workspace.projectCount": "{count} projects",
    "workspace.pathPlaceholder": "Path to scan (e.g. ~/Projects)",
    "workspace.noProjects": "No projects detected yet.",
    "workspace.scanHome": "Scan home directory",
    "workspace.scanning": "Scanning...",
    "workspace.scan.pending": "Pending",
    "workspace.scan.surface": "Surface",
    "workspace.scan.deep": "Deep",
    "workspace.scan.full": "Full",
    "workspace.triggerDeepScan": "Trigger deep scan",
    "workspace.deleteProject": "Delete project",
    "common.delete": "Delete",
    "common.confirmQuestion": "Confirm?",
    "shortcuts.title": "Keyboard Shortcuts",
    "shortcuts.group.hermes": "Hermes",
    "shortcuts.group.file": "File",
    "shortcuts.group.edit": "Edit",
    "shortcuts.group.view": "View",
    "shortcuts.group.session": "Session",
    "shortcuts.group.panes": "Panes",
    "shortcuts.item.hermes.settings": "Settings...",
    "shortcuts.item.file.newSession": "New Session",
    "shortcuts.item.file.newSessionTab": "New Tab",
    "shortcuts.item.file.closePane": "Close Pane",
    "shortcuts.item.file.fileExplorer": "File Explorer",
    "shortcuts.item.edit.sendInterrupt": "Send Interrupt",
    "shortcuts.item.view.toggleSidebar": "Sidebar",
    "shortcuts.item.view.commandPalette": "Command Palette",
    "shortcuts.item.view.promptComposer": "Prompt Composer",
    "shortcuts.item.view.processPanel": "Process Panel",
    "shortcuts.item.view.gitPanel": "Git Panel",
    "shortcuts.item.view.contextPanel": "Context Panel",
    "shortcuts.item.view.costDashboard": "Cost Dashboard",
    "shortcuts.item.view.shortcuts": "Keyboard Shortcuts",
    "shortcuts.item.view.splitHorizontal": "Split Right",
    "shortcuts.item.view.splitVertical": "Split Down",
    "shortcuts.item.view.flowMode": "Flow Mode",
    "shortcuts.item.view.searchPanel": "Search Panel",
    "shortcuts.item.view.fullscreen": "Toggle Fullscreen",
    "shortcuts.item.session.copyContext": "Copy Context",
    "shortcuts.item.app.commandPaletteAlt": "Command Palette (alternate)",
    "shortcuts.item.app.toggleWorkbench": "Workbench",
    "shortcuts.item.app.focusComposer": "Focus Composer",
    "shortcuts.item.app.switchSession": "Switch to Session 1–9",
    "shortcuts.item.app.attentionNext": "Jump to Next Waiting Agent",
    "shortcuts.item.app.attentionInbox": "Attention Inbox",
    "attention.title": "Attention inbox",
    "attention.badgeLabel": "Attention inbox: {count} blocked on you",
    "attention.blockedSection": "Blocked on you",
    "attention.readySection": "Ready for you",
    "attention.empty": "Nothing is waiting on you.",
    "attention.workspace": "Workspace",
    "attention.muted": "muted",
    "attention.announceNew": "{agent} {state} in {task}",
    "attention.announceMuted": "{task} muted for 1 hour",
    "attention.announceUnmuted": "{task} unmuted",
    "attention.announceOpen": "{blocked} blocked on you, {ready} ready for you",
    "attention.nothingWaiting": "No agent is waiting on you",
    "attention.peekLabel": "Request detail (read-only)",
    "attention.peekSession": "Session",
    "attention.peekState": "State",
    "attention.peekSince": "Waiting since",
    "attention.peekNoDetail": "The agent said nothing more. Jump to its pane to see it.",
    "attention.peekAnswerHint": "Answer in the agent's own interface: press Enter to jump to its pane.",
    "attention.ageNow": "just now",
    "attention.ageMinutes": "{n} min",
    "attention.ageHours": "{n} h",
    "attention.hint": "↑↓ select · Space peek · ⏎ jump · M mute 1 h · Esc close",
    "attention.notifyTitle": "{agent} {state}",
    "attention.state.needs_approval": "needs approval",
    "attention.state.needs_answer": "has a question",
    "attention.state.plan_ready": "has a plan ready",
    "attention.state.done_unread": "is done",
    "attention.state.blocked": "needs you",
    "attention.state.ready": "is ready",
    "attention.state.gate": "is waiting at a gate",
    "attention.state.error": "hit an error",
    "attention.state.limit": "hit a usage limit",
    "settings.awayNotify": "Away notifications",
    "settings.awayNotifyUrl": "Send to this address",
    "settings.awayNotifyHint": "When an agent is blocked on you and you are not looking at it, Hermes sends one message to this address: a webhook (JSON), an ntfy topic URL, or a Telegram bot sendMessage URL with chat_id. It carries only the agent, the task name and the state, never prompts or code. Leave it empty to send nothing.",
    "settings.awayNotifyInvalid": "Use an http:// or https:// address.",
    "shortcuts.item.app.focusNextPane": "Focus Next Pane",
    "shortcuts.item.app.focusPreviousPane": "Focus Previous Pane",
    "sessions.title": "SESSIONS",
    "sessions.noActive": "No active sessions",
    "sessions.createHint": "Press {shortcut} to create one",
    "sessions.newProject": "New Project",
    "sessions.projectName": "Project name...",
    "sessions.ungrouped": "Ungrouped",
    "sessions.dropRemoveProject": "Drop here to remove from project",
    "sessions.noProject": "No Project",
    "sessions.addDescription": "Add description...",
    "sessions.reconnect": "Reconnect",
    "sessions.working": "working",
    "sessions.needsInput": "needs input",
    "sessions.ready": "ready",
    "sessions.starting": "starting",
    "sessions.disconnected": "disconnected",
    "sessions.startupPrompt": "waiting at a startup prompt",
    "agentStatus.needs_approval": "needs approval",
    "agentStatus.needs_answer": "asked you",
    "agentStatus.gate": "gate ready",
    "agentStatus.check_failed": "check failed",
    "agentStatus.error": "error",
    "agentStatus.limited": "limited",
    "agentStatus.plan_ready": "plan ready",
    "agentStatus.done_unread": "done",
    "agentStatus.working": "working",
    "agentStatus.startup_prompt": "waiting at a startup prompt",
    "agentStatus.starting": "starting",
    "agentStatus.idle": "idle",
    "agentStatus.exited": "exited",
    "agentStatus.guessed": "guessed",
    "agentStatus.confidence.exact": "Reported by the agent itself",
    "agentStatus.confidence.signal": "From a notification the terminal printed",
    "agentStatus.confidence.guessed": "Guessed from the terminal's output",
    "status.kind.needs_approval": "needs approval",
    "status.kind.needs_answer": "needs an answer",
    "status.kind.gate": "waiting at a gate",
    "status.kind.check_failed": "check failed",
    "status.kind.error": "error",
    "status.kind.limited": "rate limited",
    "status.kind.plan_ready": "plan ready",
    "status.kind.done_unread": "done",
    "status.kind.working": "working",
    "status.kind.startup_prompt": "waiting at a startup prompt",
    "status.kind.starting": "starting",
    "status.kind.idle": "idle",
    "status.kind.exited": "exited",
    "status.source.hook": "hook",
    "status.source.osc": "notification",
    "status.source.stream": "event stream",
    "status.source.e2e": "test",
    "status.source.guessed": "guessed",
    "status.confidence.exact": "exact",
    "status.confidence.signal": "signal",
    "status.confidence.guessed": "guessed",
    "status.subagentOne": "{count} sub-agent",
    "status.subagents": "{count} sub-agents",
    "status.inboxHint": "Attention inbox ({shortcut})",
    "settings.statusStrip": "Status line above agent sessions",
    "settings.statusStripHint": "One line that says what each terminal agent is doing and how Hermes knows. The agent's own output is unchanged either way.",
    "sessions.modelChipLabel": "Model: {model}",
    "sessions.permissionModeChipLabel": "Permission mode: {mode}",
    "language.panel.title": "Interface language",
    "language.panel.selectLabel": "Language",
    "language.panel.subtitle": "Language packs are provided by plugins. English remains the core fallback.",
    "language.panel.active": "Active",
    "agentError.busy.title": "{agent} is already running",
    "agentError.busy.message": "{agent} is already running in this session. Wait for it to finish, then send your message again.",
    "agentError.spawnFailed.title": "Couldn't start {agent}",
    "agentError.spawnFailed.message": "Hermes couldn't start {agent}. Check the details, fix what they point to, then retry.",
    "agentError.signedOut.title": "{agent} is signed out",
    "agentError.signedOut.message": "Sign in to {agent} in the terminal that opens, then send your message again.",
    "agentError.protocol.title": "{agent} sent output Hermes couldn't read",
    "agentError.protocol.message": "{agent} printed something that isn't part of its normal output, so this turn may be incomplete. Retry to restart {agent}; the conversation is kept.",
    "agentError.exited.title": "{agent} stopped",
    "agentError.exited.message": "{agent} stopped unexpectedly. Retry to restart it; the conversation is kept.",
    "agentError.exited.messageWithStatus": "{agent} stopped unexpectedly ({status}). Retry to restart it; the conversation is kept.",
    "agentError.exitCode": "exit code {code}",
    "agentError.exitSignal": "signal {signal}",
    "agentError.details": "Details",
    "agentError.retry": "Retry",
    "agentError.restarting": "Restarting…",
    "agentError.signIn": "Sign in",
    "agentError.dismiss": "Dismiss",
    "agentError.signInSessionLabel": "Sign in to {agent}",
    "crash.app.title": "Something went wrong",
    "crash.app.hint": "Your sessions are still running. Reload to bring the window back.",
    "crash.pane.title": "This pane stopped working",
    "crash.pane.titleNamed": "This pane stopped working: {label}",
    "crash.pane.hint": "Other panes are not affected. Reload to try again.",
    "crash.block.title": "This block could not be shown",
    "crash.block.titleNamed": "This block could not be shown: {label}",
    "crash.block.hint": "The rest of the conversation is not affected.",
    "crash.reload": "Reload",
    "crash.reloadPane": "Reload pane",
    "crash.closePane": "Close pane",
  },
};

const packs = new Map<string, LanguagePack>([[ENGLISH_PACK.locale, ENGLISH_PACK]]);
const listeners = new Set<() => void>();
let currentLanguage = "en";
let initialized = false;
/** Registered lazy packs whose messages have not been fetched yet. */
const lazyLoaders = new WeakMap<LanguagePack, () => Promise<LanguagePack>>();
/** In-flight fetches, one per registered lazy pack. */
const lazyLoads = new WeakMap<LanguagePack, Promise<void>>();
/** Language most recently asked for through setLanguage (last call wins). */
let requestedLanguage: string | null = null;

function isLazyPack(pack: LanguagePack | LazyLanguagePack): pack is LazyLanguagePack {
  return typeof (pack as LazyLanguagePack).load === "function" && !(pack as LanguagePack).messages;
}

function normalizePack(pack: LanguagePack | LazyLanguagePack): LanguagePack {
  const locale = pack.locale.trim();
  if (!locale) throw new Error("Language pack locale is required.");
  return {
    locale,
    label: pack.label.trim() || locale,
    nativeLabel: pack.nativeLabel?.trim() || pack.label.trim() || locale,
    messages: isLazyPack(pack) ? {} : { ...pack.messages },
  };
}

/**
 * Makes sure the messages of the pack registered for `locale` are present,
 * fetching them if the pack was registered lazily. Resolves once they are
 * (or immediately for packs that are already complete / not registered).
 */
export function ensureLanguageLoaded(locale: string): Promise<void> {
  const entry = packs.get(locale);
  if (!entry) return Promise.resolve();
  const loader = lazyLoaders.get(entry);
  if (!loader) return Promise.resolve();
  let load = lazyLoads.get(entry);
  if (!load) {
    load = loader().then(
      (full) => {
        lazyLoaders.delete(entry);
        lazyLoads.delete(entry);
        // Disposed or replaced while loading: nothing to fill in.
        if (packs.get(entry.locale) !== entry) return;
        entry.messages = { ...full.messages };
        notify();
      },
      (err: unknown) => {
        lazyLoads.delete(entry); // let a later attempt retry
        throw err;
      },
    );
    lazyLoads.set(entry, load);
  }
  return load;
}

// Cached snapshot so getI18nSnapshot() returns a referentially stable value
// between mutations — required for useSyncExternalStore consumers.
let snapshotCache: I18nSnapshot | null = null;

function notify(): void {
  snapshotCache = null;
  for (const listener of listeners) {
    try { listener(); } catch {}
  }
}

export function getI18nSnapshot(): I18nSnapshot {
  if (!snapshotCache) {
    snapshotCache = {
      currentLanguage,
      languages: Array.from(packs.values()).sort((a, b) => a.label.localeCompare(b.label)),
    };
  }
  return snapshotCache;
}

export function subscribeI18n(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function initI18n(): Promise<void> {
  if (initialized) return;
  initialized = true;
  // Capture the language at init start: a setLanguage() call that lands while
  // the async settings read is in flight must win over the stored value.
  const languageAtInit = currentLanguage;
  const stored = (await getSetting(UI_LANGUAGE_SETTING).catch(() => "")) || localStorage.getItem(UI_LANGUAGE_STORAGE_KEY) || "";
  if (!stored || currentLanguage !== languageAtInit) return;
  // Apply the stored locale even if no pack is registered for it yet (packs
  // arrive with plugins): keep it as a pending preference — translate()
  // falls back to English until the matching pack registers.
  currentLanguage = stored;
  notify();
  ensureLanguageLoaded(stored).catch((err) => console.warn(`[i18n] Failed to load language "${stored}":`, err));
}

export function registerLanguagePack(pack: LanguagePack | LazyLanguagePack): { dispose(): void } {
  const normalized = normalizePack(pack);
  if (isLazyPack(pack)) lazyLoaders.set(normalized, pack.load);
  const previous = packs.get(normalized.locale);
  packs.set(normalized.locale, normalized);
  notify();
  // The saved language may be this one: fetch its messages now.
  if (currentLanguage === normalized.locale) {
    ensureLanguageLoaded(normalized.locale).catch((err) =>
      console.warn(`[i18n] Failed to load language "${normalized.locale}":`, err),
    );
  }
  return {
    dispose() {
      // Ownership check: only remove/restore when the live entry is still the
      // pack this disposable registered. If another plugin has re-registered
      // the locale since, this dispose is stale and must leave it alone.
      if (packs.get(normalized.locale) !== normalized) return;
      if (previous) {
        packs.set(previous.locale, previous);
      } else {
        packs.delete(normalized.locale);
        if (currentLanguage === normalized.locale) {
          currentLanguage = "en";
          setSetting(UI_LANGUAGE_SETTING, "en").catch(console.warn);
        }
      }
      notify();
    },
  };
}

// Cheap case normalization so "PT-br" / "EN" still match a registered
// "pt-BR" / "en" pack. Language subtag lowercased, region subtag uppercased.
function normalizeLocale(locale: string): string {
  const [language, region] = locale.trim().split("-");
  const lang = language.toLowerCase();
  return region ? `${lang}-${region.toUpperCase()}` : lang;
}

export async function setLanguage(locale: string): Promise<void> {
  const normalized = normalizeLocale(locale);
  if (!packs.has(normalized)) {
    console.warn(`[i18n] Ignoring setLanguage("${locale}"): no language pack is registered for "${normalized}".`);
    return;
  }
  requestedLanguage = normalized;
  try {
    await ensureLanguageLoaded(normalized);
  } catch (err) {
    console.warn(`[i18n] Could not load language "${normalized}"; keeping "${currentLanguage}".`, err);
    return;
  }
  // A newer setLanguage() call arrived while this one was loading.
  if (requestedLanguage !== normalized) return;
  currentLanguage = normalized;
  notify();
  localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, normalized);
  await setSetting(UI_LANGUAGE_SETTING, normalized).catch(console.warn);
}

export function getCurrentLanguage(): string {
  return currentLanguage;
}

/**
 * The language the user last picked, as mirrored in local storage (the
 * settings database may be unavailable). "en" when none is stored.
 */
export function getStoredUiLanguage(): string {
  try {
    return localStorage.getItem(UI_LANGUAGE_STORAGE_KEY) || "en";
  } catch {
    return "en";
  }
}

// Keys already reported as missing, so the dev warning fires once per key.
const warnedMissingKeys = new Set<string>();

// NOTE on pluralization: count-bearing strings use plain {count} / {n}
// substitution only — there is no CLDR plural-form selection (one/few/many)
// yet. Phrase count-bearing copy so a bare number reads acceptably in every
// language until that lands.
export function translate(key: string, values?: Record<string, string | number>): string {
  return translateIn(packs.get(currentLanguage), key, values);
}

/**
 * Like translate(), but with an explicit pack (English when undefined). For
 * the few screens shown before plugins register their packs, such as the
 * one shown when Hermes cannot open its data.
 */
export function translateIn(active: LanguagePack | undefined, key: string, values?: Record<string, string | number>): string {
  let text = active?.messages[key] ?? ENGLISH_PACK.messages[key];
  if (text === undefined) {
    // Missing from both the active pack and English: render the raw key, and
    // warn once per key in dev so the gap gets fixed instead of shipping.
    if (import.meta.env.DEV && !warnedMissingKeys.has(key)) {
      warnedMissingKeys.add(key);
      console.warn(`[i18n] Missing translation key "${key}" (locale "${active?.locale ?? "en"}", no English fallback).`);
    }
    text = key;
  }
  if (!values) return text;
  return text.replace(/\{(\w+)\}/g, (_match, name: string) => String(values[name] ?? `{${name}}`));
}
