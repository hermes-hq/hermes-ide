/**
 * Styles of the views that load on demand (Agent view, Settings, dialogs,
 * side panels, editor). Their code is fetched when first opened, but their
 * styles stay in the startup stylesheet: several always-visible parts reuse
 * these classes, and a view must never flash unstyled while its code loads.
 * Importing them here (from JS, not CSS @import) lets the bundler keep one
 * copy in the startup stylesheet instead of a second one per lazy chunk.
 * Keep in sync when a component moves behind React.lazy.
 */
import "./components/AddMcpDialog.css";
import "./components/AgentContextPanel.css";
import "./components/AskUserQuestionCard.css";
import "./components/AttentionCenter.css";
import "./components/CliCommandBanner.css";
import "./components/CommandPalette.css";
import "./components/ContextPanel.css";
import "./components/ContextPreview.css";
import "./components/ContextStatusBar.css";
import "./components/CostDashboard.css";
import "./components/EditorPane.css";
import "./components/EffortPicker.css";
import "./components/EmbeddedSlashTerminal.css";
import "./components/ExitPlanModeCard.css";
import "./components/FileExplorer.css";
import "./components/FilePreview.css";
import "./components/GitPanel.css";
import "./components/LandSheet.css";
import "./components/McpSection.css";
import "./components/MemorySection.css";
import "./components/ModelPicker.css";
import "./components/OnboardingWizard.css";
import "./components/PermissionRequestModal.css";
import "./components/PermissionsSection.css";
import "./components/PlanModeBanner.css";
import "./components/PluginManager.css";
import "./components/ProcessPanel.css";
import "./components/PromptComposer.css";
import "./components/RoleSelector.css";
import "./components/SearchPanel.css";
import "./components/SessionBranchSelector.css";
import "./components/SessionComposer.css";
import "./components/SessionCreator.css";
import "./components/SessionGitPanel.css";
import "./components/Settings.css";
import "./components/ShortcutsPanel.css";
import "./components/SlashCommandsDropdown.css";
import "./components/StyleSelector.css";
import "./components/TemplatePicker.css";
import "./components/TodoPanel.css";
import "./components/UsagePanel.css";
import "./components/WhatsNewDialog.css";
import "./components/WorkbenchPanel.css";
import "./components/WorkspacePanel.css";
import "./components/WorktreeIndicator.css";
import "./components/WorktreeOverviewPanel.css";
import "./components/agent/AgentSessionView.css";
