import "../styles/components/StartupProblemScreen.css";
import type { StartupProblem } from "../api/startupProblem";
import { languagePacks } from "../i18n/packs";
import { getStoredUiLanguage, translateIn } from "../i18n/registry";

interface StartupProblemScreenProps {
	problem: StartupProblem;
	onQuit: () => void;
	/** Defaults to the language the user last picked. */
	locale?: string;
}

const KEY_PREFIX: Record<StartupProblem["kind"], string> = {
	"newer-data": "startupProblem.newerData",
	"backup-failed": "startupProblem.backupFailed",
	"migration-failed": "startupProblem.migrationFailed",
	"open-failed": "startupProblem.openFailed",
};

/**
 * Shown instead of the workspace when Hermes could not open its data.
 * Nothing else starts in this state, so the data stays exactly as it was.
 * Plugins (and with them the language packs) never register here, so the
 * text is translated straight from the built-in packs.
 */
export function StartupProblemScreen({ problem, onQuit, locale = getStoredUiLanguage() }: StartupProblemScreenProps) {
	const pack = languagePacks.find((p) => p.locale.toLowerCase() === locale.toLowerCase());
	const t = (key: string, values?: Record<string, string | number>) => translateIn(pack, key, values);
	const prefix = KEY_PREFIX[problem.kind] as string | undefined;
	const values = {
		found: problem.found ?? "",
		supported: problem.supported ?? "",
		step: problem.step ?? "",
		detail: problem.detail ?? "",
	};
	const title = prefix ? t(`${prefix}.title`) : problem.title;
	const message = prefix ? t(`${prefix}.message`, values) : problem.message;

	return (
		<main className="startup-problem" role="alertdialog" aria-labelledby="startup-problem-title" aria-describedby="startup-problem-message">
			<div className="startup-problem-card">
				<h1 id="startup-problem-title" className="startup-problem-title">
					{title}
				</h1>
				<p id="startup-problem-message" className="startup-problem-message">
					{message}
				</p>
				<p className="startup-problem-path">
					<span className="startup-problem-path-label">{t("startupProblem.dataFile")}</span>
					<code>{problem.dataPath}</code>
				</p>
				<div className="startup-problem-actions">
					<button type="button" className="startup-problem-quit" onClick={onQuit} autoFocus>
						{t("startupProblem.quit")}
					</button>
				</div>
			</div>
		</main>
	);
}
