import type { PluginModule } from "../PluginRuntime";
import { languagePackPlugin } from "./languagePack";

export const builtinPlugins: PluginModule[] = [languagePackPlugin];
