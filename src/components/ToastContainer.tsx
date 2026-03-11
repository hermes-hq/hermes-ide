import "../styles/components/ToastContainer.css";
import type { Toast } from "../hooks/useToastStore";

const CheckIcon = () => (
	<svg viewBox="0 0 24 24" width="14" height="14">
		<polyline points="20 6 9 17 4 12" />
	</svg>
);

const InfoIcon = () => (
	<svg viewBox="0 0 24 24" width="14" height="14">
		<circle cx="12" cy="12" r="10" />
		<path d="M12 16v-4" />
		<path d="M12 8h.01" />
	</svg>
);

const WarnIcon = () => (
	<svg viewBox="0 0 24 24" width="14" height="14">
		<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
		<line x1="12" y1="9" x2="12" y2="13" />
		<line x1="12" y1="17" x2="12.01" y2="17" />
	</svg>
);

const ErrorIcon = () => (
	<svg viewBox="0 0 24 24" width="14" height="14">
		<circle cx="12" cy="12" r="10" />
		<line x1="15" y1="9" x2="9" y2="15" />
		<line x1="9" y1="9" x2="15" y2="15" />
	</svg>
);

function getIcon(type: string) {
	switch (type) {
		case "success": return <CheckIcon />;
		case "warning": return <WarnIcon />;
		case "error": return <ErrorIcon />;
		default: return <InfoIcon />;
	}
}

interface ToastContainerProps {
	toasts: Toast[];
	onDismiss: (id: string) => void;
}

export function ToastContainer({ toasts, onDismiss }: ToastContainerProps) {
	if (toasts.length === 0) return null;

	return (
		<div className="toast-container">
			{toasts.map((toast) => (
				<div key={toast.id} className={`toast toast-${toast.type}`}>
					<span className={`toast-icon toast-icon-${toast.type}`}>
						{getIcon(toast.type)}
					</span>
					<span className="toast-message">{toast.message}</span>
					{toast.actions && toast.actions.length > 0 && (
						<div className="toast-actions">
							{toast.actions.map((action, i) => (
								<button
									key={i}
									className={`toast-action-btn${action.primary ? " toast-action-primary" : ""}`}
									onClick={() => {
										action.onClick();
										onDismiss(toast.id);
									}}
								>
									{action.label}
								</button>
							))}
						</div>
					)}
					{toast.dismissible !== false && (
						<button className="toast-close" onClick={() => onDismiss(toast.id)}>&times;</button>
					)}
				</div>
			))}
		</div>
	);
}
