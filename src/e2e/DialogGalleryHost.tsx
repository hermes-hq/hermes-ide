// Test builds only: App renders this behind VITE_HERMES_E2E === "1" (normal
// builds drop it). It waits for window.__HERMES_E2E__.showDialog(name) and
// only then loads the dialog gallery, so a test run starts with the same
// code and stylesheets as a user's app.

import { lazy, Suspense, useEffect, useState } from "react";
import type { GalleryDialog } from "./DialogGallery";

export const GALLERY_EVENT = "hermes-e2e:dialog";

const DialogGallery = /* @__PURE__ */ lazy(() => import("./DialogGallery").then((m) => ({ default: m.DialogGallery })));

export function DialogGalleryHost() {
	const [name, setName] = useState<GalleryDialog | null>(null);
	useEffect(() => {
		const on = (e: Event) => setName((e as CustomEvent<GalleryDialog | null>).detail);
		window.addEventListener(GALLERY_EVENT, on);
		return () => window.removeEventListener(GALLERY_EVENT, on);
	}, []);
	if (!name) return null;
	return (
		<Suspense fallback={null}>
			<DialogGallery key={name} name={name} onClose={() => setName(null)} />
		</Suspense>
	);
}
