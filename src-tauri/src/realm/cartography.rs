use std::collections::HashMap;
use std::path::Path;
use walkdir::WalkDir;

use super::{ArchitectureInfo, Convention};

// Reuse skip/deny lists from workspace
const SKIP_DIRS: &[&str] = &[
    "node_modules", ".git", "vendor", "build", "dist", "__pycache__",
    ".next", ".nuxt", "target", ".cache", ".venv", "venv", ".tox",
    "coverage", ".nyc_output", ".turbo",
];

const DENY_DIRS: &[&str] = &[".ssh", ".aws", ".gnupg", ".kube"];

pub struct SurfaceScanResult {
    pub languages: Vec<String>,
    pub frameworks: Vec<String>,
}

pub struct ScanResult {
    pub languages: Vec<String>,
    pub frameworks: Vec<String>,
    pub architecture: Option<ArchitectureInfo>,
    pub conventions: Vec<Convention>,
}

// ─── Surface Scan (<2s) ──────────────────────────────────────────────
// Walk top 2 levels, detect marker files, extract languages/frameworks

pub fn surface_scan(path: &str) -> SurfaceScanResult {
    let root = Path::new(path);
    let mut languages = Vec::new();
    let mut frameworks = Vec::new();

    // Check marker files at root
    let markers: &[(&str, &str, Option<fn(&str) -> Vec<String>>)] = &[
        ("package.json", "JavaScript/TypeScript", Some(detect_js_frameworks)),
        ("Cargo.toml", "Rust", Some(detect_rust_frameworks)),
        ("go.mod", "Go", None),
        ("pyproject.toml", "Python", None),
        ("requirements.txt", "Python", None),
        ("Gemfile", "Ruby", None),
        ("pom.xml", "Java", None),
        ("build.gradle", "Java/Kotlin", None),
        ("composer.json", "PHP", None),
        ("pubspec.yaml", "Dart", Some(|_| vec!["Flutter".to_string()])),
        ("Package.swift", "Swift", None),
    ];

    for (file, language, detect_fn) in markers {
        let marker_path = root.join(file);
        if marker_path.exists() {
            if !languages.contains(&language.to_string()) {
                languages.push(language.to_string());
            }
            if let Some(detect) = detect_fn {
                if let Ok(content) = std::fs::read_to_string(&marker_path) {
                    for fw in detect(&content) {
                        if !frameworks.contains(&fw) {
                            frameworks.push(fw);
                        }
                    }
                }
            }
        }
    }

    // Count file extensions at depth 2
    let mut ext_counts: HashMap<String, usize> = HashMap::new();
    for entry in WalkDir::new(root)
        .max_depth(2)
        .into_iter()
        .filter_entry(|e| {
            e.file_name()
                .to_str()
                .map(|s| !SKIP_DIRS.contains(&s) && !DENY_DIRS.contains(&s))
                .unwrap_or(true)
        })
        .filter_map(|e| e.ok())
    {
        if entry.file_type().is_file() {
            if let Some(ext) = entry.path().extension().and_then(|e| e.to_str()) {
                *ext_counts.entry(ext.to_lowercase()).or_insert(0) += 1;
            }
        }
    }

    let ext_lang_map = [
        ("ts", "TypeScript"), ("tsx", "TypeScript"),
        ("js", "JavaScript"), ("jsx", "JavaScript"),
        ("py", "Python"), ("rs", "Rust"), ("go", "Go"),
        ("rb", "Ruby"), ("java", "Java"), ("kt", "Kotlin"),
        ("swift", "Swift"), ("cs", "C#"), ("cpp", "C++"), ("c", "C"),
    ];

    for (ext, lang) in ext_lang_map {
        if ext_counts.get(ext).copied().unwrap_or(0) > 2 {
            let lang_str = lang.to_string();
            if !languages.contains(&lang_str) {
                languages.push(lang_str);
            }
        }
    }

    SurfaceScanResult { languages, frameworks }
}

// ─── Deep Scan (<30s) ────────────────────────────────────────────────
// Read config files, detect architecture pattern, extract conventions

pub fn deep_scan(path: &str) -> ScanResult {
    let root = Path::new(path);

    // Start with surface data
    let surface = surface_scan(path);
    let mut languages = surface.languages;
    let frameworks = surface.frameworks;
    let mut conventions = Vec::new();

    // Detect architecture
    let architecture = detect_architecture(root);

    // Extract conventions from config files
    extract_conventions(root, &mut conventions);

    // Deeper file extension counting (depth 3)
    let mut ext_counts: HashMap<String, usize> = HashMap::new();
    for entry in WalkDir::new(root)
        .max_depth(3)
        .into_iter()
        .filter_entry(|e| {
            e.file_name()
                .to_str()
                .map(|s| !SKIP_DIRS.contains(&s) && !DENY_DIRS.contains(&s))
                .unwrap_or(true)
        })
        .filter_map(|e| e.ok())
    {
        if entry.file_type().is_file() {
            if let Some(ext) = entry.path().extension().and_then(|e| e.to_str()) {
                *ext_counts.entry(ext.to_lowercase()).or_insert(0) += 1;
            }
        }
    }

    let ext_lang_map = [
        ("ts", "TypeScript"), ("tsx", "TypeScript"),
        ("js", "JavaScript"), ("jsx", "JavaScript"),
        ("py", "Python"), ("rs", "Rust"), ("go", "Go"),
        ("rb", "Ruby"), ("java", "Java"), ("kt", "Kotlin"),
        ("swift", "Swift"), ("cs", "C#"), ("cpp", "C++"), ("c", "C"),
    ];

    for (ext, lang) in ext_lang_map {
        if ext_counts.get(ext).copied().unwrap_or(0) > 2 {
            let lang_str = lang.to_string();
            if !languages.contains(&lang_str) {
                languages.push(lang_str);
            }
        }
    }

    ScanResult {
        languages,
        frameworks,
        architecture: Some(architecture),
        conventions,
    }
}

// ─── Full Scan (minutes) ─────────────────────────────────────────────
// Sample source files, build dependency graph, detect entry points

pub fn full_scan(path: &str) -> ScanResult {
    let root = Path::new(path);

    // Start with deep scan
    let mut result = deep_scan(path);

    // Enhance architecture with entry points and deeper analysis
    if let Some(ref mut arch) = result.architecture {
        // Detect entry points
        let mut entry_points = Vec::new();
        let entry_files = [
            "src/main.rs", "src/lib.rs", "src/index.ts", "src/index.js",
            "src/main.ts", "src/main.js", "src/App.tsx", "src/App.jsx",
            "app/page.tsx", "app/layout.tsx", "pages/index.tsx", "pages/index.js",
            "main.py", "app.py", "manage.py", "main.go", "cmd/main.go",
        ];

        for entry_file in entry_files {
            if root.join(entry_file).exists() {
                entry_points.push(entry_file.to_string());
            }
        }
        arch.entry_points = entry_points;
    }

    // Sample source files for import patterns
    let mut import_counts: HashMap<String, usize> = HashMap::new();
    let sample_exts = ["ts", "tsx", "js", "jsx", "rs", "py", "go"];

    let mut file_count = 0;
    for entry in WalkDir::new(root)
        .max_depth(5)
        .into_iter()
        .filter_entry(|e| {
            e.file_name()
                .to_str()
                .map(|s| !SKIP_DIRS.contains(&s) && !DENY_DIRS.contains(&s))
                .unwrap_or(true)
        })
        .filter_map(|e| e.ok())
    {
        if file_count >= 200 { break; }
        if !entry.file_type().is_file() { continue; }

        let ext_match = entry.path().extension()
            .and_then(|e| e.to_str())
            .map(|e| sample_exts.contains(&e))
            .unwrap_or(false);

        if !ext_match { continue; }
        file_count += 1;

        if let Ok(content) = std::fs::read_to_string(entry.path()) {
            // Count import patterns (first 50 lines)
            for line in content.lines().take(50) {
                let trimmed = line.trim();
                if trimmed.starts_with("import ") || trimmed.starts_with("from ") ||
                   trimmed.starts_with("use ") || trimmed.starts_with("require(") {
                    // Extract module name
                    if let Some(module) = extract_import_module(trimmed) {
                        *import_counts.entry(module).or_insert(0) += 1;
                    }
                }
            }
        }
    }

    // Add convention about most-used imports
    let mut top_imports: Vec<_> = import_counts.into_iter().collect();
    top_imports.sort_by(|a, b| b.1.cmp(&a.1));
    for (module, count) in top_imports.iter().take(5) {
        if *count > 3 {
            result.conventions.push(Convention {
                rule: format!("frequently-imports: {}", module),
                source: "detected".to_string(),
                confidence: 0.6,
            });
        }
    }

    // Update scan status
    result
}

// ─── Architecture Detection ──────────────────────────────────────────

fn detect_architecture(root: &Path) -> ArchitectureInfo {
    let mut pattern = "unknown".to_string();
    let mut layers = Vec::new();

    // Monorepo detection
    let monorepo_markers = [
        "packages", "apps", "lerna.json", "pnpm-workspace.yaml", "turbo.json",
    ];
    let mut monorepo_score = 0;
    for marker in monorepo_markers {
        if root.join(marker).exists() {
            monorepo_score += 1;
        }
    }
    if monorepo_score >= 2 {
        pattern = "monorepo".to_string();
        // Detect monorepo packages
        for dir in &["packages", "apps", "libs", "modules"] {
            let dir_path = root.join(dir);
            if dir_path.is_dir() {
                layers.push(dir.to_string());
            }
        }
    }

    // MVC detection
    if pattern == "unknown" {
        let has_controllers = root.join("controllers").is_dir() || root.join("src/controllers").is_dir();
        let has_models = root.join("models").is_dir() || root.join("src/models").is_dir();
        let has_views = root.join("views").is_dir() || root.join("src/views").is_dir() || root.join("templates").is_dir();
        if has_controllers && has_models {
            pattern = "mvc".to_string();
            if has_controllers { layers.push("controllers".to_string()); }
            if has_models { layers.push("models".to_string()); }
            if has_views { layers.push("views".to_string()); }
        }
    }

    // Next.js App Router
    if pattern == "unknown" && root.join("app").is_dir() {
        let has_page = root.join("app/page.tsx").exists() || root.join("app/page.jsx").exists();
        let has_layout = root.join("app/layout.tsx").exists() || root.join("app/layout.jsx").exists();
        if has_page || has_layout {
            pattern = "nextjs-app-router".to_string();
            layers.push("app".to_string());
            if root.join("components").is_dir() || root.join("src/components").is_dir() {
                layers.push("components".to_string());
            }
            if root.join("lib").is_dir() || root.join("src/lib").is_dir() {
                layers.push("lib".to_string());
            }
        }
    }

    // Next.js Pages Router
    if pattern == "unknown" && (root.join("pages").is_dir() || root.join("src/pages").is_dir()) {
        let has_index = root.join("pages/index.tsx").exists()
            || root.join("pages/index.jsx").exists()
            || root.join("src/pages/index.tsx").exists();
        if has_index {
            pattern = "nextjs-pages-router".to_string();
            layers.push("pages".to_string());
        }
    }

    // Tauri app
    if pattern == "unknown" && root.join("src-tauri").is_dir() {
        pattern = "tauri-app".to_string();
        layers.push("src-tauri".to_string());
        if root.join("src").is_dir() { layers.push("src".to_string()); }
    }

    // Rust binary/library
    if pattern == "unknown" && root.join("Cargo.toml").exists() {
        if root.join("src/main.rs").exists() && root.join("src/lib.rs").exists() {
            pattern = "rust-mixed".to_string();
        } else if root.join("src/main.rs").exists() {
            pattern = "rust-binary".to_string();
        } else if root.join("src/lib.rs").exists() {
            pattern = "rust-library".to_string();
        }
        if root.join("src").is_dir() { layers.push("src".to_string()); }
        if root.join("tests").is_dir() { layers.push("tests".to_string()); }
    }

    // Generic src layout
    if pattern == "unknown" {
        if root.join("src").is_dir() {
            pattern = "src-layout".to_string();
            layers.push("src".to_string());
        }
        // Detect common layers
        for dir in &["api", "services", "models", "utils", "lib", "components", "hooks", "styles", "tests"] {
            if root.join(dir).is_dir() || root.join(format!("src/{}", dir)).is_dir() {
                if !layers.contains(&dir.to_string()) {
                    layers.push(dir.to_string());
                }
            }
        }
    }

    ArchitectureInfo {
        pattern,
        layers,
        entry_points: Vec::new(), // filled by full_scan
    }
}

// ─── Convention Detection ────────────────────────────────────────────

fn extract_conventions(root: &Path, conventions: &mut Vec<Convention>) {
    // .prettierrc / .prettierrc.json
    for prettier_file in &[".prettierrc", ".prettierrc.json", ".prettierrc.js"] {
        let path = root.join(prettier_file);
        if path.exists() {
            if let Ok(content) = std::fs::read_to_string(&path) {
                if content.contains("\"tabWidth\"") || content.contains("tabWidth") {
                    if content.contains("4") {
                        conventions.push(Convention {
                            rule: "indent: 4 spaces".to_string(),
                            source: "detected".to_string(),
                            confidence: 0.95,
                        });
                    } else if content.contains("2") {
                        conventions.push(Convention {
                            rule: "indent: 2 spaces".to_string(),
                            source: "detected".to_string(),
                            confidence: 0.95,
                        });
                    }
                }
                if content.contains("\"semi\": false") || content.contains("semi: false") {
                    conventions.push(Convention {
                        rule: "no-semicolons".to_string(),
                        source: "detected".to_string(),
                        confidence: 0.95,
                    });
                }
                if content.contains("\"singleQuote\": true") || content.contains("singleQuote: true") {
                    conventions.push(Convention {
                        rule: "single-quotes".to_string(),
                        source: "detected".to_string(),
                        confidence: 0.95,
                    });
                }
                if content.contains("\"printWidth\"") || content.contains("printWidth") {
                    conventions.push(Convention {
                        rule: "has-print-width-config".to_string(),
                        source: "detected".to_string(),
                        confidence: 0.8,
                    });
                }
            }
            break;
        }
    }

    // .editorconfig
    let editorconfig = root.join(".editorconfig");
    if editorconfig.exists() {
        if let Ok(content) = std::fs::read_to_string(&editorconfig) {
            if content.contains("indent_style = tab") {
                conventions.push(Convention {
                    rule: "indent: tabs".to_string(),
                    source: "detected".to_string(),
                    confidence: 0.9,
                });
            } else if content.contains("indent_style = space") {
                // Check indent_size
                if content.contains("indent_size = 4") {
                    conventions.push(Convention {
                        rule: "indent: 4 spaces".to_string(),
                        source: "detected".to_string(),
                        confidence: 0.9,
                    });
                } else if content.contains("indent_size = 2") {
                    conventions.push(Convention {
                        rule: "indent: 2 spaces".to_string(),
                        source: "detected".to_string(),
                        confidence: 0.9,
                    });
                }
            }
        }
    }

    // tsconfig.json
    let tsconfig = root.join("tsconfig.json");
    if tsconfig.exists() {
        if let Ok(content) = std::fs::read_to_string(&tsconfig) {
            if content.contains("\"strict\": true") || content.contains("\"strict\":true") {
                conventions.push(Convention {
                    rule: "typescript-strict-mode".to_string(),
                    source: "detected".to_string(),
                    confidence: 0.95,
                });
            }
            if content.contains("\"paths\"") {
                conventions.push(Convention {
                    rule: "typescript-path-aliases".to_string(),
                    source: "detected".to_string(),
                    confidence: 0.9,
                });
            }
        }
    }

    // .eslintrc / eslint.config
    for eslint_file in &[".eslintrc", ".eslintrc.json", ".eslintrc.js", ".eslintrc.yml", "eslint.config.js", "eslint.config.mjs"] {
        if root.join(eslint_file).exists() {
            conventions.push(Convention {
                rule: "uses-eslint".to_string(),
                source: "detected".to_string(),
                confidence: 0.95,
            });
            break;
        }
    }

    // Cargo.toml edition/lint settings
    let cargo_toml = root.join("Cargo.toml");
    if cargo_toml.exists() {
        if let Ok(content) = std::fs::read_to_string(&cargo_toml) {
            if content.contains("edition = \"2021\"") {
                conventions.push(Convention {
                    rule: "rust-edition-2021".to_string(),
                    source: "detected".to_string(),
                    confidence: 0.95,
                });
            } else if content.contains("edition = \"2024\"") {
                conventions.push(Convention {
                    rule: "rust-edition-2024".to_string(),
                    source: "detected".to_string(),
                    confidence: 0.95,
                });
            }
            if content.contains("[lints]") || content.contains("[workspace.lints]") {
                conventions.push(Convention {
                    rule: "rust-custom-lints".to_string(),
                    source: "detected".to_string(),
                    confidence: 0.8,
                });
            }
        }
    }

    // package.json scripts
    let pkg_json = root.join("package.json");
    if pkg_json.exists() {
        if let Ok(content) = std::fs::read_to_string(&pkg_json) {
            if content.contains("\"test\"") {
                if content.contains("vitest") {
                    conventions.push(Convention {
                        rule: "test-framework: vitest".to_string(),
                        source: "detected".to_string(),
                        confidence: 0.9,
                    });
                } else if content.contains("jest") {
                    conventions.push(Convention {
                        rule: "test-framework: jest".to_string(),
                        source: "detected".to_string(),
                        confidence: 0.9,
                    });
                } else if content.contains("mocha") {
                    conventions.push(Convention {
                        rule: "test-framework: mocha".to_string(),
                        source: "detected".to_string(),
                        confidence: 0.9,
                    });
                }
            }
            if content.contains("\"lint\"") {
                conventions.push(Convention {
                    rule: "has-lint-script".to_string(),
                    source: "detected".to_string(),
                    confidence: 0.8,
                });
            }
            if content.contains("\"build\"") {
                conventions.push(Convention {
                    rule: "has-build-script".to_string(),
                    source: "detected".to_string(),
                    confidence: 0.8,
                });
            }
        }
    }

    // Dockerfile
    if root.join("Dockerfile").exists() || root.join("docker-compose.yml").exists() || root.join("docker-compose.yaml").exists() {
        conventions.push(Convention {
            rule: "uses-docker".to_string(),
            source: "detected".to_string(),
            confidence: 0.95,
        });
    }

    // CI/CD
    if root.join(".github/workflows").is_dir() {
        conventions.push(Convention {
            rule: "ci: github-actions".to_string(),
            source: "detected".to_string(),
            confidence: 0.95,
        });
    }
    if root.join(".gitlab-ci.yml").exists() {
        conventions.push(Convention {
            rule: "ci: gitlab-ci".to_string(),
            source: "detected".to_string(),
            confidence: 0.95,
        });
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────

fn detect_js_frameworks(content: &str) -> Vec<String> {
    let mut frameworks = Vec::new();
    let checks = [
        ("next", "Next.js"), ("react", "React"), ("vue", "Vue"),
        ("nuxt", "Nuxt"), ("svelte", "Svelte"), ("angular", "Angular"),
        ("express", "Express"), ("fastify", "Fastify"), ("nest", "NestJS"),
        ("remix", "Remix"), ("astro", "Astro"), ("tauri", "Tauri"),
        ("electron", "Electron"),
    ];
    for (key, name) in checks {
        if content.contains(&format!("\"{}\"", key))
            || content.contains(&format!("\"@{}/", key))
        {
            frameworks.push(name.to_string());
        }
    }
    frameworks
}

fn detect_rust_frameworks(content: &str) -> Vec<String> {
    let mut frameworks = Vec::new();
    let checks = [
        ("actix-web", "Actix"), ("axum", "Axum"), ("rocket", "Rocket"),
        ("tauri", "Tauri"), ("tokio", "Tokio"), ("warp", "Warp"),
    ];
    for (key, name) in checks {
        if content.contains(key) {
            frameworks.push(name.to_string());
        }
    }
    frameworks
}

fn extract_import_module(line: &str) -> Option<String> {
    // JS/TS: import ... from "module"
    if let Some(pos) = line.find("from ") {
        let rest = &line[pos + 5..];
        let trimmed = rest.trim().trim_matches(|c| c == '\'' || c == '"' || c == ';');
        if !trimmed.is_empty() && !trimmed.starts_with('.') {
            // Extract package name (first path segment, or @scope/name)
            let module = if trimmed.starts_with('@') {
                trimmed.splitn(3, '/').take(2).collect::<Vec<_>>().join("/")
            } else {
                trimmed.split('/').next().unwrap_or(trimmed).to_string()
            };
            return Some(module);
        }
    }
    // Rust: use crate_name::...
    if line.starts_with("use ") {
        let rest = line[4..].trim().trim_end_matches(';');
        let module = rest.split("::").next().unwrap_or(rest);
        if module != "std" && module != "core" && module != "alloc" && module != "self" && module != "super" && module != "crate" {
            return Some(module.to_string());
        }
    }
    None
}
