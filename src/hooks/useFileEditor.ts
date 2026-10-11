import { useState, useRef, useEffect, useCallback } from "react";
import { writeFileContent, sshWriteFile, FILE_CHANGED_ON_DISK } from "../api/git";

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
	/** A save was refused: the file changed on disk (an agent edited it) since it was loaded. */
	changedOnDisk: boolean;
	save: () => Promise<boolean>;
	/** Save over the changes on disk. */
	overwrite: () => Promise<boolean>;
	lastSavedAt: number | null;
}

export function useFileEditor(opts: UseFileEditorOptions): UseFileEditorReturn {
	const { sessionId, projectId, filePath, initialContent, initialMtime, isSSH, autoSaveDelay = 2000 } = opts;

	const [content, setContentState] = useState(initialContent);
	const [originalContent, setOriginalContent] = useState(initialContent);
	const [, setMtime] = useState(initialMtime);
	const [isSaving, setIsSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [changedOnDisk, setChangedOnDisk] = useState(false);
	const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
	const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const contentRef = useRef(content);
	// The text on disk as of the last successful write, and the save in
	// flight: a save started before the last one returned waits for it and
	// then expects what it wrote, not the text loaded before it.
	const originalRef = useRef(initialContent);
	const saveChain = useRef<Promise<boolean>>(Promise.resolve(true));

	const isDirty = content !== originalContent;

	// Undo/redo is handled natively by CodeMirror's history() extension.
	// This hook only tracks content for dirty state and auto-save.
	const setContent = useCallback((value: string) => {
		setContentState(value);
		contentRef.current = value;
		setSaveError(null);
	}, []);

	// Reset state when file changes
	useEffect(() => {
		setContentState(initialContent);
		setOriginalContent(initialContent);
		originalRef.current = initialContent;
		setMtime(initialMtime);
		contentRef.current = initialContent;
		setSaveError(null);
		setChangedOnDisk(false);
		setLastSavedAt(null);
	}, [filePath, initialContent, initialMtime]);

	const writeOnce = useCallback(async (force: boolean): Promise<boolean> => {
		const currentContent = contentRef.current;
		if (currentContent === originalRef.current) return true;

		setIsSaving(true);
		setSaveError(null);
		try {
			if (isSSH) {
				await sshWriteFile(sessionId, filePath, currentContent);
			} else {
				// Only write over the text this editor loaded (or last saved).
				const newMtime = await writeFileContent(sessionId, projectId, filePath, currentContent, force ? null : originalRef.current);
				setMtime(newMtime);
			}
			originalRef.current = currentContent;
			setOriginalContent(currentContent);
			setChangedOnDisk(false);
			setLastSavedAt(Date.now());
			return true;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (message === FILE_CHANGED_ON_DISK) setChangedOnDisk(true);
			else setSaveError(message);
			return false;
		} finally {
			setIsSaving(false);
		}
	}, [sessionId, projectId, filePath, isSSH]);

	const doSave = useCallback((force = false): Promise<boolean> => {
		saveChain.current = saveChain.current.then(() => writeOnce(force));
		return saveChain.current;
	}, [writeOnce]);

	// Immediate save (Cmd+S) — returns true if save succeeded or was unnecessary
	const save = useCallback(async (): Promise<boolean> => {
		if (autoSaveTimer.current) {
			clearTimeout(autoSaveTimer.current);
			autoSaveTimer.current = null;
		}
		return doSave();
	}, [doSave]);

	const overwrite = useCallback(() => doSave(true), [doSave]);

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
		changedOnDisk,
		save,
		overwrite,
		lastSavedAt,
	};
}
