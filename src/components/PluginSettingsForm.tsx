import { useState, useEffect, useCallback } from "react";
import { invokeAsPlugin } from "../plugins/identity";
import type { PluginSettingsSchema, PluginSettingDefinition } from "../plugins/types";
import type { PluginRuntime } from "../plugins/PluginRuntime";

interface PluginSettingsFormProps {
	pluginId: string;
	schema: PluginSettingsSchema;
	runtime?: PluginRuntime;
}

export function PluginSettingsForm({ pluginId, schema, runtime }: PluginSettingsFormProps) {
	const [values, setValues] = useState<Record<string, string | number | boolean>>({});
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		setLoading(true);
		invokeAsPlugin<Record<string, string>>(pluginId, "get_plugin_settings_batch")
			.then((stored) => {
				const resolved: Record<string, string | number | boolean> = {};
				for (const [key, def] of Object.entries(schema)) {
					const raw = stored[key];
					if (raw !== undefined) {
						resolved[key] = coerce(raw, def);
					} else {
						resolved[key] = def.default;
					}
				}
				setValues(resolved);
			})
			.catch(() => {
				// Fall back to defaults
				const defaults: Record<string, string | number | boolean> = {};
				for (const [key, def] of Object.entries(schema)) {
					defaults[key] = def.default;
				}
				setValues(defaults);
			})
			.finally(() => setLoading(false));
	}, [pluginId, schema]);

	const handleChange = useCallback(
		(key: string, value: string | number | boolean) => {
			setValues((prev) => ({ ...prev, [key]: value }));
			const storageKey = `__setting:${key}`;
			invokeAsPlugin(pluginId, "set_plugin_setting", {
				key: storageKey,
				value: String(value),
			}).catch(console.error);
			runtime?.notifySettingChanged(pluginId, key, value);
		},
		[pluginId, runtime],
	);

	if (loading) {
		return <div className="ps-loading">Loading settings...</div>;
	}

	const entries = Object.entries(schema).sort(
		([, a], [, b]) => (a.order ?? 0) - (b.order ?? 0),
	);

	if (entries.length === 0) return null;

	return (
		<div className="ps-form">
			<div className="ps-title">Settings</div>
			{entries.map(([key, def]) => (
				<SettingField
					key={key}
					settingKey={key}
					definition={def}
					value={values[key] ?? def.default}
					onChange={handleChange}
				/>
			))}
		</div>
	);
}

function SettingField({
	settingKey,
	definition,
	value,
	onChange,
}: {
	settingKey: string;
	definition: PluginSettingDefinition;
	value: string | number | boolean;
	onChange: (key: string, value: string | number | boolean) => void;
}) {
	return (
		<div className="ps-field">
			<label className="ps-label" htmlFor={`ps-${settingKey}`}>
				{definition.title}
			</label>
			{definition.description && (
				<span className="ps-hint">{definition.description}</span>
			)}
			<div className="ps-control">
				{definition.type === "string" && (
					<input
						id={`ps-${settingKey}`}
						type="text"
						className="ps-input"
						value={String(value)}
						placeholder={(definition as any).placeholder ?? ""}
						maxLength={(definition as any).maxLength}
						onChange={(e) => onChange(settingKey, e.target.value)}
					/>
				)}
				{definition.type === "number" && (
					<input
						id={`ps-${settingKey}`}
						type="number"
						className="ps-input ps-input-number"
						value={Number(value)}
						min={definition.min}
						max={definition.max}
						step={definition.step}
						onChange={(e) => onChange(settingKey, parseFloat(e.target.value) || 0)}
					/>
				)}
				{definition.type === "boolean" && (
					<button
						id={`ps-${settingKey}`}
						type="button"
						className={`ps-toggle${value ? " ps-toggle-on" : ""}`}
						onClick={() => onChange(settingKey, !value)}
						role="switch"
						aria-checked={!!value}
					>
						<span className="ps-toggle-knob" />
					</button>
				)}
				{definition.type === "select" && (
					<select
						id={`ps-${settingKey}`}
						className="ps-select"
						value={String(value)}
						onChange={(e) => onChange(settingKey, e.target.value)}
					>
						{definition.options.map((opt) => (
							<option key={opt.value} value={opt.value}>
								{opt.label}
							</option>
						))}
					</select>
				)}
			</div>
		</div>
	);
}

function coerce(raw: string, def: PluginSettingDefinition): string | number | boolean {
	switch (def.type) {
		case "number":
			return parseFloat(raw) || def.default;
		case "boolean":
			return raw === "true";
		case "select":
		case "string":
		default:
			return raw;
	}
}
