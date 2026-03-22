import { useState, useRef, useEffect, useCallback } from "react";
import { writeFileContent, sshWriteFile } from "../api/git";

interface UseFileEditorOptions {
	sessionId: string;
	projectId: string;
	filePath: string;
	initialContent: string;
	initialMtime: number;
	isSSH: boolean;
	autoSaveDelay?: number;
}

interface UseFileEditorReturn {
	content: string;
	setContent: (value: string) => void;
	isDirty: boolean;
	isSaving: boolean;
	saveError: string | null;
	save: () => Promise<void>;
	lastSavedAt: number | null;
}

export function useFileEditor(opts: UseFileEditorOptions): UseFileEditorReturn {
	const { sessionId, projectId, filePath, initialContent, initialMtime, isSSH, autoSaveDelay = 2000 } = opts;

	const [content, setContentState] = useState(initialContent);
	const [originalContent, setOriginalContent] = useState(initialContent);
	const [, setMtime] = useState(initialMtime);
	const [isSaving, setIsSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
	const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const contentRef = useRef(content);

	const isDirty = content !== originalContent;

	const setContent = useCallback((value: string) => {
		setContentState(value);
		contentRef.current = value;
		setSaveError(null);
	}, []);

	// Reset state when file changes
	useEffect(() => {
		setContentState(initialContent);
		setOriginalContent(initialContent);
		setMtime(initialMtime);
		contentRef.current = initialContent;
		setSaveError(null);
		setLastSavedAt(null);
	}, [filePath, initialContent, initialMtime]);

	const doSave = useCallback(async () => {
		const currentContent = contentRef.current;
		if (currentContent === originalContent) return;

		setIsSaving(true);
		setSaveError(null);
		try {
			if (isSSH) {
				await sshWriteFile(sessionId, filePath, currentContent);
			} else {
				const newMtime = await writeFileContent(sessionId, projectId, filePath, currentContent);
				setMtime(newMtime);
			}
			setOriginalContent(currentContent);
			setLastSavedAt(Date.now());
		} catch (err) {
			setSaveError(err instanceof Error ? err.message : String(err));
		} finally {
			setIsSaving(false);
		}
	}, [sessionId, projectId, filePath, isSSH, originalContent]);

	// Immediate save (Cmd+S)
	const save = useCallback(async () => {
		if (autoSaveTimer.current) {
			clearTimeout(autoSaveTimer.current);
			autoSaveTimer.current = null;
		}
		await doSave();
	}, [doSave]);

	// Auto-save with debounce
	useEffect(() => {
		if (content === originalContent) return;

		if (autoSaveTimer.current) {
			clearTimeout(autoSaveTimer.current);
		}
		autoSaveTimer.current = setTimeout(() => {
			doSave();
		}, autoSaveDelay);

		return () => {
			if (autoSaveTimer.current) {
				clearTimeout(autoSaveTimer.current);
			}
		};
	}, [content, originalContent, autoSaveDelay, doSave]);

	// Cleanup on unmount
	useEffect(() => {
		return () => {
			if (autoSaveTimer.current) {
				clearTimeout(autoSaveTimer.current);
			}
		};
	}, []);

	return {
		content,
		setContent,
		isDirty,
		isSaving,
		saveError,
		save,
		lastSavedAt,
	};
}
