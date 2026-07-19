import type { PluginModule } from "../PluginRuntime";
import type { Disposable } from "../types";
import { languagePacks } from "../../i18n/packs";

let registrationDisposables: Disposable[] = [];

export const languagePackPlugin: PluginModule = {
  manifest: {
    id: "hermes.language-pack",
    name: "Hermes Language Pack",
    version: "0.1.0",
    description: "Adds popular interface languages through the plugin i18n API.",
    author: "Hermes",
    activationEvents: [{ type: "onStartup" }],
    contributes: {},
  },
  activate(api) {
    for (const disposable of registrationDisposables) {
      disposable.dispose();
    }
    registrationDisposables = languagePacks.map((pack) => api.i18n.registerLanguagePack(pack));
  },
  deactivate() {
    for (const disposable of registrationDisposables) {
      disposable.dispose();
    }
    registrationDisposables = [];
  },
};
