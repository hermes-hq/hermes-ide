use std::collections::HashMap;
use std::path::Path;
use walkdir::WalkDir;

use super::{ArchitectureInfo, Convention};

// Reuse skip/deny lists from workspace
const SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "vendor",
    "build",
    "dist",
    "__pycache__",
    ".next",
    ".nuxt",
    "target",
    ".cache",
    ".venv",
    "venv",
    ".tox",
    "coverage",
    ".nyc_output",
    ".turbo",
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
    #[allow(clippy::type_complexity)]
    let markers: &[(&str, &str, Option<fn(&str) -> Vec<String>>)] = &[
        // JavaScript / TypeScript
        (
            "package.json",
            "JavaScript/TypeScript",
            Some(detect_js_frameworks),
        ),
        ("deno.json", "TypeScript", None),
        ("deno.jsonc", "TypeScript", None),
        // Rust
        ("Cargo.toml", "Rust", Some(detect_rust_frameworks)),
        // Python
        ("pyproject.toml", "Python", Some(detect_python_frameworks)),
        ("requirements.txt", "Python", Some(detect_python_frameworks)),
        ("setup.py", "Python", Some(detect_python_frameworks)),
        ("Pipfile", "Python", Some(detect_python_frameworks)),
        // Go
        ("go.mod", "Go", Some(detect_go_frameworks)),
        // Ruby
        ("Gemfile", "Ruby", Some(detect_ruby_frameworks)),
        // Java / JVM
        ("pom.xml", "Java", Some(detect_java_frameworks)),
        ("build.gradle", "Java/Kotlin", Some(detect_jvm_frameworks)),
        ("build.gradle.kts", "Kotlin", Some(detect_jvm_frameworks)),
        // PHP
        ("composer.json", "PHP", Some(detect_php_frameworks)),
        // Dart / Flutter
        ("pubspec.yaml", "Dart", Some(detect_dart_frameworks)),
        // Swift
        ("Package.swift", "Swift", Some(detect_swift_frameworks)),
        // C / C++
        ("CMakeLists.txt", "C++", Some(detect_cpp_frameworks)),
        ("meson.build", "C", None),
        // Elixir
        ("mix.exs", "Elixir", Some(detect_elixir_frameworks)),
        // Scala
        ("build.sbt", "Scala", Some(detect_scala_frameworks)),
        // Haskell
        ("stack.yaml", "Haskell", None),
        ("cabal.project", "Haskell", None),
        // Zig
        ("build.zig", "Zig", None),
        // Julia
        ("Project.toml", "Julia", None),
        // Clojure
        ("project.clj", "Clojure", None),
        ("deps.edn", "Clojure", None),
        // Erlang
        ("rebar.config", "Erlang", None),
        // OCaml
        ("dune-project", "OCaml", None),
        // Perl
        ("cpanfile", "Perl", None),
        ("Makefile.PL", "Perl", None),
        // Gleam
        ("gleam.toml", "Gleam", None),
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

    // .NET / C# / F# — check for .sln, .csproj, .fsproj at root (names vary)
    if let Ok(entries) = std::fs::read_dir(root) {
        for entry in entries.filter_map(|e| e.ok()) {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str.ends_with(".sln")
                || name_str.ends_with(".csproj")
                || name_str.ends_with(".fsproj")
            {
                let lang = if name_str.ends_with(".fsproj") {
                    "F#"
                } else {
                    "C#"
                };
                if !languages.contains(&lang.to_string()) {
                    languages.push(lang.to_string());
                }
                if name_str.ends_with(".csproj") || name_str.ends_with(".fsproj") {
                    if let Ok(content) = std::fs::read_to_string(entry.path()) {
                        for fw in detect_csharp_frameworks(&content) {
                            if !frameworks.contains(&fw) {
                                frameworks.push(fw);
                            }
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
        ("ts", "TypeScript"),
        ("tsx", "TypeScript"),
        ("js", "JavaScript"),
        ("jsx", "JavaScript"),
        ("py", "Python"),
        ("rs", "Rust"),
        ("go", "Go"),
        ("rb", "Ruby"),
        ("java", "Java"),
        ("kt", "Kotlin"),
        ("swift", "Swift"),
        ("cs", "C#"),
        ("cpp", "C++"),
        ("cc", "C++"),
        ("cxx", "C++"),
        ("c", "C"),
        ("php", "PHP"),
        ("lua", "Lua"),
        ("dart", "Dart"),
        ("ex", "Elixir"),
        ("exs", "Elixir"),
        ("scala", "Scala"),
        ("hs", "Haskell"),
        ("zig", "Zig"),
        ("jl", "Julia"),
        ("pl", "Perl"),
        ("pm", "Perl"),
        ("r", "R"),
        ("R", "R"),
        ("m", "Objective-C"),
        ("fs", "F#"),
        ("fsx", "F#"),
        ("clj", "Clojure"),
        ("cljs", "Clojure"),
        ("erl", "Erlang"),
        ("hrl", "Erlang"),
        ("ml", "OCaml"),
        ("mli", "OCaml"),
        ("nim", "Nim"),
        ("cr", "Crystal"),
        ("groovy", "Groovy"),
        ("gleam", "Gleam"),
        ("vue", "Vue"),
        ("svelte", "Svelte"),
    ];

    for (ext, lang) in ext_lang_map {
        if ext_counts.get(ext).copied().unwrap_or(0) > 2 {
            let lang_str = lang.to_string();
            if !languages.contains(&lang_str) {
                languages.push(lang_str);
            }
        }
    }

    SurfaceScanResult {
        languages,
        frameworks,
    }
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
        ("ts", "TypeScript"),
        ("tsx", "TypeScript"),
        ("js", "JavaScript"),
        ("jsx", "JavaScript"),
        ("py", "Python"),
        ("rs", "Rust"),
        ("go", "Go"),
        ("rb", "Ruby"),
        ("java", "Java"),
        ("kt", "Kotlin"),
        ("swift", "Swift"),
        ("cs", "C#"),
        ("cpp", "C++"),
        ("cc", "C++"),
        ("cxx", "C++"),
        ("c", "C"),
        ("php", "PHP"),
        ("lua", "Lua"),
        ("dart", "Dart"),
        ("ex", "Elixir"),
        ("exs", "Elixir"),
        ("scala", "Scala"),
        ("hs", "Haskell"),
        ("zig", "Zig"),
        ("jl", "Julia"),
        ("pl", "Perl"),
        ("pm", "Perl"),
        ("r", "R"),
        ("R", "R"),
        ("m", "Objective-C"),
        ("fs", "F#"),
        ("fsx", "F#"),
        ("clj", "Clojure"),
        ("cljs", "Clojure"),
        ("erl", "Erlang"),
        ("hrl", "Erlang"),
        ("ml", "OCaml"),
        ("mli", "OCaml"),
        ("nim", "Nim"),
        ("cr", "Crystal"),
        ("groovy", "Groovy"),
        ("gleam", "Gleam"),
        ("vue", "Vue"),
        ("svelte", "Svelte"),
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
            "src/main.rs",
            "src/lib.rs",
            "src/index.ts",
            "src/index.js",
            "src/main.ts",
            "src/main.js",
            "src/App.tsx",
            "src/App.jsx",
            "app/page.tsx",
            "app/layout.tsx",
            "pages/index.tsx",
            "pages/index.js",
            "main.py",
            "app.py",
            "manage.py",
            "main.go",
            "cmd/main.go",
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
    let sample_exts = [
        "ts", "tsx", "js", "jsx", "rs", "py", "go", "rb", "java", "kt", "php", "cs", "swift", "ex",
        "exs", "scala", "clj", "lua",
    ];

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
        if file_count >= 200 {
            break;
        }
        if !entry.file_type().is_file() {
            continue;
        }

        let ext_match = entry
            .path()
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| sample_exts.contains(&e))
            .unwrap_or(false);

        if !ext_match {
            continue;
        }
        file_count += 1;

        if let Ok(content) = std::fs::read_to_string(entry.path()) {
            // Count import patterns (first 50 lines)
            for line in content.lines().take(50) {
                let trimmed = line.trim();
                if trimmed.starts_with("import ")
                    || trimmed.starts_with("from ")
                    || trimmed.starts_with("use ")
                    || trimmed.starts_with("require(")
                {
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
        "packages",
        "apps",
        "lerna.json",
        "pnpm-workspace.yaml",
        "turbo.json",
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
        let has_controllers =
            root.join("controllers").is_dir() || root.join("src/controllers").is_dir();
        let has_models = root.join("models").is_dir() || root.join("src/models").is_dir();
        let has_views = root.join("views").is_dir()
            || root.join("src/views").is_dir()
            || root.join("templates").is_dir();
        if has_controllers && has_models {
            pattern = "mvc".to_string();
            if has_controllers {
                layers.push("controllers".to_string());
            }
            if has_models {
                layers.push("models".to_string());
            }
            if has_views {
                layers.push("views".to_string());
            }
        }
    }

    // Next.js App Router
    if pattern == "unknown" && root.join("app").is_dir() {
        let has_page = root.join("app/page.tsx").exists() || root.join("app/page.jsx").exists();
        let has_layout =
            root.join("app/layout.tsx").exists() || root.join("app/layout.jsx").exists();
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
        if root.join("src").is_dir() {
            layers.push("src".to_string());
        }
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
        if root.join("src").is_dir() {
            layers.push("src".to_string());
        }
        if root.join("tests").is_dir() {
            layers.push("tests".to_string());
        }
    }

    // Generic src layout
    if pattern == "unknown" {
        if root.join("src").is_dir() {
            pattern = "src-layout".to_string();
            layers.push("src".to_string());
        }
        // Detect common layers
        for dir in &[
            "api",
            "services",
            "models",
            "utils",
            "lib",
            "components",
            "hooks",
            "styles",
            "tests",
        ] {
            if (root.join(dir).is_dir() || root.join(format!("src/{}", dir)).is_dir())
                && !layers.contains(&dir.to_string())
            {
                layers.push(dir.to_string());
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
                if content.contains("\"singleQuote\": true")
                    || content.contains("singleQuote: true")
                {
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
    for eslint_file in &[
        ".eslintrc",
        ".eslintrc.json",
        ".eslintrc.js",
        ".eslintrc.yml",
        "eslint.config.js",
        "eslint.config.mjs",
    ] {
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
    if root.join("Dockerfile").exists()
        || root.join("docker-compose.yml").exists()
        || root.join("docker-compose.yaml").exists()
    {
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

/// Simple substring-match helper: check if any (key, name) pair matches content.
fn detect_by_substring(content: &str, checks: &[(&str, &str)]) -> Vec<String> {
    let mut frameworks = Vec::new();
    for (key, name) in checks {
        if content.contains(key) {
            frameworks.push(name.to_string());
        }
    }
    frameworks
}

// ─── JavaScript / TypeScript (package.json) ──────────────────────────

fn detect_js_frameworks(content: &str) -> Vec<String> {
    let mut frameworks = Vec::new();
    let checks = [
        ("next", "Next.js"),
        ("react", "React"),
        ("vue", "Vue"),
        ("nuxt", "Nuxt"),
        ("svelte", "Svelte"),
        ("angular", "Angular"),
        ("express", "Express"),
        ("fastify", "Fastify"),
        ("nest", "NestJS"),
        ("remix", "Remix"),
        ("astro", "Astro"),
        ("tauri", "Tauri"),
        ("electron", "Electron"),
        ("gatsby", "Gatsby"),
        ("ember", "Ember"),
        ("hono", "Hono"),
        ("koa", "Koa"),
        ("elysia", "Elysia"),
        ("solid-js", "SolidJS"),
        ("qwik", "Qwik"),
        ("three", "Three.js"),
        ("socket.io", "Socket.IO"),
    ];
    for (key, name) in checks {
        if content.contains(&format!("\"{}\"", key)) || content.contains(&format!("\"@{}/", key)) {
            frameworks.push(name.to_string());
        }
    }
    frameworks
}

// ─── Rust (Cargo.toml) ──────────────────────────────────────────────

fn detect_rust_frameworks(content: &str) -> Vec<String> {
    detect_by_substring(
        content,
        &[
            ("actix-web", "Actix"),
            ("axum", "Axum"),
            ("rocket", "Rocket"),
            ("tauri", "Tauri"),
            ("tokio", "Tokio"),
            ("warp", "Warp"),
            ("hyper", "Hyper"),
            ("tonic", "Tonic"),
            ("diesel", "Diesel"),
            ("sqlx", "SQLx"),
            ("sea-orm", "SeaORM"),
            ("leptos", "Leptos"),
            ("yew", "Yew"),
            ("dioxus", "Dioxus"),
            ("bevy", "Bevy"),
        ],
    )
}

// ─── Python (pyproject.toml, requirements.txt, setup.py, Pipfile) ───

fn detect_python_frameworks(content: &str) -> Vec<String> {
    let lower = content.to_lowercase();
    detect_by_substring(
        &lower,
        &[
            ("django", "Django"),
            ("flask", "Flask"),
            ("fastapi", "FastAPI"),
            ("starlette", "Starlette"),
            ("tornado", "Tornado"),
            ("pyramid", "Pyramid"),
            ("sanic", "Sanic"),
            ("aiohttp", "aiohttp"),
            ("bottle", "Bottle"),
            ("streamlit", "Streamlit"),
            ("dash", "Dash"),
            ("celery", "Celery"),
            ("sqlalchemy", "SQLAlchemy"),
            ("scrapy", "Scrapy"),
            ("pytest", "pytest"),
            ("tensorflow", "TensorFlow"),
            ("torch", "PyTorch"),
            ("pandas", "pandas"),
            ("numpy", "NumPy"),
            ("pydantic", "Pydantic"),
            ("uvicorn", "Uvicorn"),
        ],
    )
}

// ─── Go (go.mod) ────────────────────────────────────────────────────

fn detect_go_frameworks(content: &str) -> Vec<String> {
    detect_by_substring(
        content,
        &[
            ("gin-gonic/gin", "Gin"),
            ("labstack/echo", "Echo"),
            ("gofiber/fiber", "Fiber"),
            ("go-chi/chi", "Chi"),
            ("gorilla/mux", "Gorilla"),
            ("beego/beego", "Beego"),
            ("gohugoio/hugo", "Hugo"),
            ("bufbuild/buf", "Buf"),
            ("grpc/grpc-go", "gRPC"),
            ("google.golang.org/grpc", "gRPC"),
            ("gorm.io/gorm", "GORM"),
            ("ent/ent", "Ent"),
            ("cobra", "Cobra"),
            ("urfave/cli", "urfave/cli"),
        ],
    )
}

// ─── Ruby (Gemfile) ─────────────────────────────────────────────────

fn detect_ruby_frameworks(content: &str) -> Vec<String> {
    detect_by_substring(
        content,
        &[
            ("rails", "Rails"),
            ("sinatra", "Sinatra"),
            ("hanami", "Hanami"),
            ("grape", "Grape"),
            ("roda", "Roda"),
            ("jekyll", "Jekyll"),
            ("rspec", "RSpec"),
            ("sidekiq", "Sidekiq"),
        ],
    )
}

// ─── Java (pom.xml) ─────────────────────────────────────────────────

fn detect_java_frameworks(content: &str) -> Vec<String> {
    detect_by_substring(
        content,
        &[
            ("spring-boot", "Spring Boot"),
            ("spring-", "Spring"),
            ("quarkus", "Quarkus"),
            ("micronaut", "Micronaut"),
            ("hibernate", "Hibernate"),
            ("vertx", "Vert.x"),
            ("junit", "JUnit"),
            ("maven-", "Maven"),
            ("jakarta.", "Jakarta EE"),
            ("struts", "Struts"),
        ],
    )
}

// ─── JVM (build.gradle / build.gradle.kts) ──────────────────────────

fn detect_jvm_frameworks(content: &str) -> Vec<String> {
    detect_by_substring(
        content,
        &[
            ("spring-boot", "Spring Boot"),
            ("org.springframework", "Spring"),
            ("ktor", "Ktor"),
            ("quarkus", "Quarkus"),
            ("micronaut", "Micronaut"),
            ("android", "Android"),
            ("compose", "Jetpack Compose"),
            ("hibernate", "Hibernate"),
            ("exposed", "Exposed"),
            ("junit", "JUnit"),
        ],
    )
}

// ─── PHP (composer.json) ────────────────────────────────────────────

fn detect_php_frameworks(content: &str) -> Vec<String> {
    detect_by_substring(
        content,
        &[
            ("laravel/framework", "Laravel"),
            ("laravel/lumen", "Lumen"),
            ("symfony/", "Symfony"),
            ("slim/slim", "Slim"),
            ("cakephp/cakephp", "CakePHP"),
            ("yiisoft/", "Yii"),
            ("codeigniter", "CodeIgniter"),
            ("wordpress", "WordPress"),
            ("drupal/", "Drupal"),
            ("livewire", "Livewire"),
            ("phpunit", "PHPUnit"),
            ("filament", "Filament"),
        ],
    )
}

// ─── Dart (pubspec.yaml) ────────────────────────────────────────────

fn detect_dart_frameworks(content: &str) -> Vec<String> {
    detect_by_substring(
        content,
        &[
            ("flutter", "Flutter"),
            ("serverpod", "Serverpod"),
            ("dart_frog", "Dart Frog"),
        ],
    )
}

// ─── Swift (Package.swift) ──────────────────────────────────────────

fn detect_swift_frameworks(content: &str) -> Vec<String> {
    detect_by_substring(
        content,
        &[
            ("vapor", "Vapor"),
            ("Vapor", "Vapor"),
            ("kitura", "Kitura"),
            ("Kitura", "Kitura"),
            ("perfect", "Perfect"),
            ("Perfect", "Perfect"),
            ("hummingbird", "Hummingbird"),
            ("Hummingbird", "Hummingbird"),
        ],
    )
}

// ─── C / C++ (CMakeLists.txt) ───────────────────────────────────────

fn detect_cpp_frameworks(content: &str) -> Vec<String> {
    detect_by_substring(
        content,
        &[
            ("Qt", "Qt"),
            ("Boost", "Boost"),
            ("OpenCV", "OpenCV"),
            ("gRPC", "gRPC"),
            ("grpc", "gRPC"),
            ("SFML", "SFML"),
            ("SDL2", "SDL"),
            ("SDL", "SDL"),
            ("wxWidgets", "wxWidgets"),
            ("imgui", "ImGui"),
            ("Vulkan", "Vulkan"),
            ("OpenGL", "OpenGL"),
            ("CUDA", "CUDA"),
            ("GTest", "GTest"),
        ],
    )
}

// ─── C# / .NET (.csproj) ───────────────────────────────────────────

fn detect_csharp_frameworks(content: &str) -> Vec<String> {
    detect_by_substring(
        content,
        &[
            ("Microsoft.AspNetCore", "ASP.NET"),
            ("AspNetCore", "ASP.NET"),
            ("Blazor", "Blazor"),
            ("Microsoft.Maui", "MAUI"),
            ("Xamarin", "Xamarin"),
            ("EntityFramework", "Entity Framework"),
            ("WPF", "WPF"),
            ("WindowsForms", "WinForms"),
            ("Avalonia", "Avalonia"),
            ("Unity", "Unity"),
            ("xunit", "xUnit"),
            ("NUnit", "NUnit"),
        ],
    )
}

// ─── Elixir (mix.exs) ──────────────────────────────────────────────

fn detect_elixir_frameworks(content: &str) -> Vec<String> {
    detect_by_substring(
        content,
        &[
            (":phoenix", "Phoenix"),
            (":ecto", "Ecto"),
            (":nerves", "Nerves"),
            (":absinthe", "Absinthe"),
            (":live_view", "LiveView"),
            (":oban", "Oban"),
        ],
    )
}

// ─── Scala (build.sbt) ─────────────────────────────────────────────

fn detect_scala_frameworks(content: &str) -> Vec<String> {
    detect_by_substring(
        content,
        &[
            ("play", "Play"),
            ("akka", "Akka"),
            ("pekko", "Pekko"),
            ("spark", "Spark"),
            ("zio", "ZIO"),
            ("http4s", "http4s"),
            ("cats", "Cats"),
            ("scalafx", "ScalaFX"),
            ("scalatest", "ScalaTest"),
        ],
    )
}

// ─── Import Module Extraction ───────────────────────────────────────

fn extract_import_module(line: &str) -> Option<String> {
    // JS/TS: import ... from "module"
    if let Some(pos) = line.find("from ") {
        let rest = &line[pos + 5..];
        let trimmed = rest
            .trim()
            .trim_matches(|c| c == '\'' || c == '"' || c == ';');
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
    if let Some(stripped) = line.strip_prefix("use ") {
        let rest = stripped.trim().trim_end_matches(';');
        let module = rest.split("::").next().unwrap_or(rest);
        if module != "std"
            && module != "core"
            && module != "alloc"
            && module != "self"
            && module != "super"
            && module != "crate"
        {
            return Some(module.to_string());
        }
    }
    // Python: import module / from module import ...
    if line.starts_with("import ") && !line.contains("from") {
        let rest = line[7..]
            .trim()
            .split([',', ' ', '.'])
            .next()?;
        if !rest.is_empty() {
            return Some(rest.to_string());
        }
    }
    None
}
