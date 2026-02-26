export interface CommandEntry {
  command: string;
  description: string;
  category: string;
  contexts: string[];
}

// Pre-built index keyed by first token for O(1) lookup
const index = new Map<string, CommandEntry[]>();

const commands: CommandEntry[] = [
  // ─── Git ────────────────────────────────────────────────────
  { command: "git status", description: "Show working tree status", category: "git", contexts: ["git"] },
  { command: "git add .", description: "Stage all changes", category: "git", contexts: ["git"] },
  { command: "git add -p", description: "Interactively stage hunks", category: "git", contexts: ["git"] },
  { command: "git commit -m \"\"", description: "Commit with message", category: "git", contexts: ["git"] },
  { command: "git commit --amend", description: "Amend last commit", category: "git", contexts: ["git"] },
  { command: "git push", description: "Push to remote", category: "git", contexts: ["git"] },
  { command: "git push -u origin", description: "Push and set upstream", category: "git", contexts: ["git"] },
  { command: "git push --force-with-lease", description: "Force push safely", category: "git", contexts: ["git"] },
  { command: "git pull", description: "Fetch and merge remote", category: "git", contexts: ["git"] },
  { command: "git pull --rebase", description: "Rebase on pull", category: "git", contexts: ["git"] },
  { command: "git fetch", description: "Download remote refs", category: "git", contexts: ["git"] },
  { command: "git fetch --prune", description: "Fetch and prune stale refs", category: "git", contexts: ["git"] },
  { command: "git checkout -b", description: "Create and switch to new branch", category: "git", contexts: ["git"] },
  { command: "git checkout", description: "Switch branches or restore files", category: "git", contexts: ["git"] },
  { command: "git switch", description: "Switch branches", category: "git", contexts: ["git"] },
  { command: "git switch -c", description: "Create and switch to new branch", category: "git", contexts: ["git"] },
  { command: "git branch", description: "List branches", category: "git", contexts: ["git"] },
  { command: "git branch -d", description: "Delete merged branch", category: "git", contexts: ["git"] },
  { command: "git branch -D", description: "Force delete branch", category: "git", contexts: ["git"] },
  { command: "git merge", description: "Merge branch into current", category: "git", contexts: ["git"] },
  { command: "git rebase", description: "Rebase current branch", category: "git", contexts: ["git"] },
  { command: "git rebase -i", description: "Interactive rebase", category: "git", contexts: ["git"] },
  { command: "git log --oneline", description: "Compact commit history", category: "git", contexts: ["git"] },
  { command: "git log --graph --oneline", description: "Visual branch history", category: "git", contexts: ["git"] },
  { command: "git diff", description: "Show unstaged changes", category: "git", contexts: ["git"] },
  { command: "git diff --staged", description: "Show staged changes", category: "git", contexts: ["git"] },
  { command: "git stash", description: "Stash working changes", category: "git", contexts: ["git"] },
  { command: "git stash pop", description: "Apply and drop stash", category: "git", contexts: ["git"] },
  { command: "git stash list", description: "List stashes", category: "git", contexts: ["git"] },
  { command: "git reset --soft HEAD~1", description: "Undo last commit, keep changes", category: "git", contexts: ["git"] },
  { command: "git reset --hard HEAD", description: "Discard all local changes", category: "git", contexts: ["git"] },
  { command: "git cherry-pick", description: "Apply specific commit", category: "git", contexts: ["git"] },
  { command: "git tag", description: "List or create tags", category: "git", contexts: ["git"] },
  { command: "git remote -v", description: "Show remotes with URLs", category: "git", contexts: ["git"] },
  { command: "git clone", description: "Clone a repository", category: "git", contexts: [] },
  { command: "git init", description: "Initialize repository", category: "git", contexts: [] },
  { command: "git bisect start", description: "Binary search for bad commit", category: "git", contexts: ["git"] },
  { command: "git blame", description: "Show line-by-line authorship", category: "git", contexts: ["git"] },
  { command: "git clean -fd", description: "Remove untracked files and dirs", category: "git", contexts: ["git"] },
  { command: "git reflog", description: "Show reference log", category: "git", contexts: ["git"] },

  // ─── npm ────────────────────────────────────────────────────
  { command: "npm install", description: "Install dependencies", category: "npm", contexts: ["npm"] },
  { command: "npm install --save-dev", description: "Install as dev dependency", category: "npm", contexts: ["npm"] },
  { command: "npm run dev", description: "Run dev script", category: "npm", contexts: ["npm"] },
  { command: "npm run build", description: "Run build script", category: "npm", contexts: ["npm"] },
  { command: "npm run test", description: "Run test script", category: "npm", contexts: ["npm"] },
  { command: "npm run start", description: "Run start script", category: "npm", contexts: ["npm"] },
  { command: "npm run lint", description: "Run lint script", category: "npm", contexts: ["npm"] },
  { command: "npm ci", description: "Clean install from lockfile", category: "npm", contexts: ["npm"] },
  { command: "npm outdated", description: "Check outdated packages", category: "npm", contexts: ["npm"] },
  { command: "npm update", description: "Update packages", category: "npm", contexts: ["npm"] },
  { command: "npm ls", description: "List installed packages", category: "npm", contexts: ["npm"] },
  { command: "npm init -y", description: "Initialize package.json", category: "npm", contexts: [] },
  { command: "npm audit", description: "Run security audit", category: "npm", contexts: ["npm"] },
  { command: "npm audit fix", description: "Fix audit issues", category: "npm", contexts: ["npm"] },
  { command: "npm cache clean --force", description: "Clear npm cache", category: "npm", contexts: ["npm"] },
  { command: "npm exec", description: "Run package binary", category: "npm", contexts: ["npm"] },
  { command: "npx", description: "Execute package binary", category: "npm", contexts: ["npm"] },

  // ─── yarn ───────────────────────────────────────────────────
  { command: "yarn install", description: "Install dependencies", category: "yarn", contexts: ["yarn"] },
  { command: "yarn add", description: "Add dependency", category: "yarn", contexts: ["yarn"] },
  { command: "yarn add -D", description: "Add dev dependency", category: "yarn", contexts: ["yarn"] },
  { command: "yarn dev", description: "Run dev script", category: "yarn", contexts: ["yarn"] },
  { command: "yarn build", description: "Run build script", category: "yarn", contexts: ["yarn"] },
  { command: "yarn test", description: "Run test script", category: "yarn", contexts: ["yarn"] },
  { command: "yarn remove", description: "Remove dependency", category: "yarn", contexts: ["yarn"] },

  // ─── pnpm ───────────────────────────────────────────────────
  { command: "pnpm install", description: "Install dependencies", category: "pnpm", contexts: ["pnpm"] },
  { command: "pnpm add", description: "Add dependency", category: "pnpm", contexts: ["pnpm"] },
  { command: "pnpm add -D", description: "Add dev dependency", category: "pnpm", contexts: ["pnpm"] },
  { command: "pnpm dev", description: "Run dev script", category: "pnpm", contexts: ["pnpm"] },
  { command: "pnpm build", description: "Run build script", category: "pnpm", contexts: ["pnpm"] },
  { command: "pnpm test", description: "Run test script", category: "pnpm", contexts: ["pnpm"] },
  { command: "pnpm remove", description: "Remove dependency", category: "pnpm", contexts: ["pnpm"] },
  { command: "pnpm dlx", description: "Execute package binary", category: "pnpm", contexts: ["pnpm"] },

  // ─── bun ────────────────────────────────────────────────────
  { command: "bun install", description: "Install dependencies", category: "bun", contexts: ["bun"] },
  { command: "bun add", description: "Add dependency", category: "bun", contexts: ["bun"] },
  { command: "bun add -d", description: "Add dev dependency", category: "bun", contexts: ["bun"] },
  { command: "bun dev", description: "Run dev script", category: "bun", contexts: ["bun"] },
  { command: "bun run", description: "Run script or file", category: "bun", contexts: ["bun"] },
  { command: "bun test", description: "Run tests", category: "bun", contexts: ["bun"] },
  { command: "bun build", description: "Bundle code", category: "bun", contexts: ["bun"] },

  // ─── Docker ─────────────────────────────────────────────────
  { command: "docker ps", description: "List running containers", category: "docker", contexts: ["docker"] },
  { command: "docker ps -a", description: "List all containers", category: "docker", contexts: ["docker"] },
  { command: "docker images", description: "List images", category: "docker", contexts: ["docker"] },
  { command: "docker build -t", description: "Build image with tag", category: "docker", contexts: ["docker"] },
  { command: "docker run", description: "Run container", category: "docker", contexts: ["docker"] },
  { command: "docker run -it", description: "Run interactive container", category: "docker", contexts: ["docker"] },
  { command: "docker compose up", description: "Start compose services", category: "docker", contexts: ["docker"] },
  { command: "docker compose up -d", description: "Start compose in background", category: "docker", contexts: ["docker"] },
  { command: "docker compose down", description: "Stop compose services", category: "docker", contexts: ["docker"] },
  { command: "docker compose logs -f", description: "Follow compose logs", category: "docker", contexts: ["docker"] },
  { command: "docker stop", description: "Stop container", category: "docker", contexts: ["docker"] },
  { command: "docker rm", description: "Remove container", category: "docker", contexts: ["docker"] },
  { command: "docker rmi", description: "Remove image", category: "docker", contexts: ["docker"] },
  { command: "docker exec -it", description: "Execute in running container", category: "docker", contexts: ["docker"] },
  { command: "docker logs -f", description: "Follow container logs", category: "docker", contexts: ["docker"] },
  { command: "docker system prune", description: "Remove unused data", category: "docker", contexts: ["docker"] },

  // ─── Cargo (Rust) ───────────────────────────────────────────
  { command: "cargo build", description: "Compile project", category: "cargo", contexts: ["rust"] },
  { command: "cargo build --release", description: "Compile optimized release", category: "cargo", contexts: ["rust"] },
  { command: "cargo run", description: "Compile and run", category: "cargo", contexts: ["rust"] },
  { command: "cargo test", description: "Run tests", category: "cargo", contexts: ["rust"] },
  { command: "cargo check", description: "Type-check without building", category: "cargo", contexts: ["rust"] },
  { command: "cargo clippy", description: "Run linter", category: "cargo", contexts: ["rust"] },
  { command: "cargo fmt", description: "Format code", category: "cargo", contexts: ["rust"] },
  { command: "cargo add", description: "Add dependency", category: "cargo", contexts: ["rust"] },
  { command: "cargo update", description: "Update dependencies", category: "cargo", contexts: ["rust"] },
  { command: "cargo doc --open", description: "Generate and open docs", category: "cargo", contexts: ["rust"] },
  { command: "cargo clean", description: "Remove build artifacts", category: "cargo", contexts: ["rust"] },

  // ─── Python ─────────────────────────────────────────────────
  { command: "python", description: "Run Python interpreter", category: "python", contexts: ["python"] },
  { command: "python -m venv .venv", description: "Create virtual environment", category: "python", contexts: ["python"] },
  { command: "pip install", description: "Install package", category: "python", contexts: ["python"] },
  { command: "pip install -r requirements.txt", description: "Install from requirements", category: "python", contexts: ["python"] },
  { command: "pip freeze", description: "List installed packages", category: "python", contexts: ["python"] },
  { command: "pytest", description: "Run tests", category: "python", contexts: ["python"] },
  { command: "pytest -v", description: "Run tests verbose", category: "python", contexts: ["python"] },
  { command: "source .venv/bin/activate", description: "Activate virtualenv", category: "python", contexts: ["python"] },
  { command: "uv pip install", description: "Fast pip install", category: "python", contexts: ["python"] },
  { command: "poetry install", description: "Install poetry deps", category: "python", contexts: ["python"] },

  // ─── Go ─────────────────────────────────────────────────────
  { command: "go build", description: "Compile packages", category: "go", contexts: ["go"] },
  { command: "go run .", description: "Compile and run", category: "go", contexts: ["go"] },
  { command: "go test ./...", description: "Run all tests", category: "go", contexts: ["go"] },
  { command: "go mod tidy", description: "Clean module dependencies", category: "go", contexts: ["go"] },
  { command: "go get", description: "Add dependency", category: "go", contexts: ["go"] },
  { command: "go fmt ./...", description: "Format all files", category: "go", contexts: ["go"] },
  { command: "go vet ./...", description: "Report suspicious constructs", category: "go", contexts: ["go"] },

  // ─── Framework CLIs ─────────────────────────────────────────
  { command: "next dev", description: "Start Next.js dev server", category: "next", contexts: ["next"] },
  { command: "next build", description: "Build Next.js for production", category: "next", contexts: ["next"] },
  { command: "next start", description: "Start Next.js production", category: "next", contexts: ["next"] },
  { command: "vite", description: "Start Vite dev server", category: "vite", contexts: ["vite"] },
  { command: "vite build", description: "Build with Vite", category: "vite", contexts: ["vite"] },
  { command: "vite preview", description: "Preview Vite build", category: "vite", contexts: ["vite"] },
  { command: "remix dev", description: "Start Remix dev server", category: "remix", contexts: ["remix"] },
  { command: "astro dev", description: "Start Astro dev server", category: "astro", contexts: ["astro"] },
  { command: "nuxt dev", description: "Start Nuxt dev server", category: "nuxt", contexts: ["nuxt"] },
  { command: "flutter run", description: "Run Flutter app", category: "flutter", contexts: ["flutter"] },
  { command: "flutter build", description: "Build Flutter app", category: "flutter", contexts: ["flutter"] },
  { command: "flutter test", description: "Run Flutter tests", category: "flutter", contexts: ["flutter"] },

  // ─── Tauri ──────────────────────────────────────────────────
  { command: "cargo tauri dev", description: "Start Tauri dev", category: "tauri", contexts: ["tauri"] },
  { command: "cargo tauri build", description: "Build Tauri app", category: "tauri", contexts: ["tauri"] },
  { command: "npx tauri dev", description: "Start Tauri dev (npm)", category: "tauri", contexts: ["tauri"] },
  { command: "npx tauri build", description: "Build Tauri app (npm)", category: "tauri", contexts: ["tauri"] },

  // ─── System Utilities ───────────────────────────────────────
  { command: "ls", description: "List directory contents", category: "system", contexts: [] },
  { command: "ls -la", description: "List all with details", category: "system", contexts: [] },
  { command: "ls -lh", description: "List with human-readable sizes", category: "system", contexts: [] },
  { command: "cd", description: "Change directory", category: "system", contexts: [] },
  { command: "cd ..", description: "Go up one directory", category: "system", contexts: [] },
  { command: "cd ~", description: "Go to home directory", category: "system", contexts: [] },
  { command: "pwd", description: "Print working directory", category: "system", contexts: [] },
  { command: "mkdir", description: "Create directory", category: "system", contexts: [] },
  { command: "mkdir -p", description: "Create nested directories", category: "system", contexts: [] },
  { command: "rm", description: "Remove files", category: "system", contexts: [] },
  { command: "rm -rf", description: "Force remove recursively", category: "system", contexts: [] },
  { command: "cp", description: "Copy files", category: "system", contexts: [] },
  { command: "cp -r", description: "Copy directories recursively", category: "system", contexts: [] },
  { command: "mv", description: "Move or rename files", category: "system", contexts: [] },
  { command: "cat", description: "Display file contents", category: "system", contexts: [] },
  { command: "less", description: "Page through file", category: "system", contexts: [] },
  { command: "head", description: "Show first lines", category: "system", contexts: [] },
  { command: "tail", description: "Show last lines", category: "system", contexts: [] },
  { command: "tail -f", description: "Follow file changes", category: "system", contexts: [] },
  { command: "grep", description: "Search text in files", category: "system", contexts: [] },
  { command: "grep -r", description: "Recursive text search", category: "system", contexts: [] },
  { command: "grep -rn", description: "Recursive search with line numbers", category: "system", contexts: [] },
  { command: "find . -name", description: "Find files by name", category: "system", contexts: [] },
  { command: "find . -type f", description: "Find files only", category: "system", contexts: [] },
  { command: "wc -l", description: "Count lines", category: "system", contexts: [] },
  { command: "du -sh", description: "Disk usage summary", category: "system", contexts: [] },
  { command: "df -h", description: "Disk free space", category: "system", contexts: [] },
  { command: "chmod", description: "Change file permissions", category: "system", contexts: [] },
  { command: "chown", description: "Change file owner", category: "system", contexts: [] },
  { command: "ln -s", description: "Create symbolic link", category: "system", contexts: [] },
  { command: "touch", description: "Create empty file", category: "system", contexts: [] },
  { command: "echo", description: "Print text", category: "system", contexts: [] },
  { command: "which", description: "Locate command binary", category: "system", contexts: [] },
  { command: "whoami", description: "Show current user", category: "system", contexts: [] },
  { command: "hostname", description: "Show hostname", category: "system", contexts: [] },
  { command: "env", description: "Show environment variables", category: "system", contexts: [] },
  { command: "export", description: "Set environment variable", category: "system", contexts: [] },
  { command: "alias", description: "Create command alias", category: "system", contexts: [] },
  { command: "history", description: "Show command history", category: "system", contexts: [] },
  { command: "clear", description: "Clear terminal screen", category: "system", contexts: [] },
  { command: "man", description: "Show manual page", category: "system", contexts: [] },
  { command: "top", description: "Show running processes", category: "system", contexts: [] },
  { command: "htop", description: "Interactive process viewer", category: "system", contexts: [] },
  { command: "ps aux", description: "List all processes", category: "system", contexts: [] },
  { command: "kill", description: "Terminate process", category: "system", contexts: [] },
  { command: "killall", description: "Kill by process name", category: "system", contexts: [] },
  { command: "curl", description: "Transfer data from URL", category: "system", contexts: [] },
  { command: "curl -X POST", description: "Send POST request", category: "system", contexts: [] },
  { command: "wget", description: "Download file from URL", category: "system", contexts: [] },
  { command: "ssh", description: "Secure shell connection", category: "system", contexts: [] },
  { command: "scp", description: "Secure copy over SSH", category: "system", contexts: [] },
  { command: "rsync -avz", description: "Sync files with progress", category: "system", contexts: [] },
  { command: "tar -czf", description: "Create compressed archive", category: "system", contexts: [] },
  { command: "tar -xzf", description: "Extract compressed archive", category: "system", contexts: [] },
  { command: "zip", description: "Create zip archive", category: "system", contexts: [] },
  { command: "unzip", description: "Extract zip archive", category: "system", contexts: [] },
  { command: "sed", description: "Stream editor", category: "system", contexts: [] },
  { command: "awk", description: "Pattern processing", category: "system", contexts: [] },
  { command: "sort", description: "Sort lines", category: "system", contexts: [] },
  { command: "uniq", description: "Remove duplicate lines", category: "system", contexts: [] },
  { command: "xargs", description: "Build commands from input", category: "system", contexts: [] },
  { command: "tee", description: "Write to file and stdout", category: "system", contexts: [] },
  { command: "watch", description: "Run command periodically", category: "system", contexts: [] },
  { command: "date", description: "Show current date/time", category: "system", contexts: [] },
  { command: "cal", description: "Show calendar", category: "system", contexts: [] },
  { command: "uptime", description: "Show system uptime", category: "system", contexts: [] },
  { command: "uname -a", description: "Show system info", category: "system", contexts: [] },
  { command: "lsof", description: "List open files", category: "system", contexts: [] },
  { command: "lsof -i", description: "List network connections", category: "system", contexts: [] },
  { command: "netstat -tlnp", description: "Show listening ports", category: "system", contexts: [] },
  { command: "ifconfig", description: "Show network interfaces", category: "system", contexts: [] },
  { command: "ping", description: "Test network connectivity", category: "system", contexts: [] },
  { command: "traceroute", description: "Trace packet route", category: "system", contexts: [] },
  { command: "dig", description: "DNS lookup", category: "system", contexts: [] },
  { command: "nslookup", description: "Query DNS", category: "system", contexts: [] },
  { command: "pbcopy", description: "Copy to clipboard (macOS)", category: "system", contexts: [] },
  { command: "pbpaste", description: "Paste from clipboard (macOS)", category: "system", contexts: [] },
  { command: "open .", description: "Open current dir in Finder", category: "system", contexts: [] },
  { command: "code .", description: "Open in VS Code", category: "system", contexts: [] },

  // ─── Homebrew ───────────────────────────────────────────────
  { command: "brew install", description: "Install package", category: "brew", contexts: [] },
  { command: "brew update", description: "Update Homebrew", category: "brew", contexts: [] },
  { command: "brew upgrade", description: "Upgrade packages", category: "brew", contexts: [] },
  { command: "brew list", description: "List installed packages", category: "brew", contexts: [] },
  { command: "brew search", description: "Search packages", category: "brew", contexts: [] },
  { command: "brew info", description: "Show package info", category: "brew", contexts: [] },
  { command: "brew uninstall", description: "Remove package", category: "brew", contexts: [] },
  { command: "brew services", description: "Manage services", category: "brew", contexts: [] },

  // ─── Kubernetes ─────────────────────────────────────────────
  { command: "kubectl get pods", description: "List pods", category: "k8s", contexts: ["k8s"] },
  { command: "kubectl get services", description: "List services", category: "k8s", contexts: ["k8s"] },
  { command: "kubectl get deployments", description: "List deployments", category: "k8s", contexts: ["k8s"] },
  { command: "kubectl apply -f", description: "Apply config from file", category: "k8s", contexts: ["k8s"] },
  { command: "kubectl logs -f", description: "Follow pod logs", category: "k8s", contexts: ["k8s"] },
  { command: "kubectl describe pod", description: "Describe pod details", category: "k8s", contexts: ["k8s"] },
  { command: "kubectl exec -it", description: "Execute in pod", category: "k8s", contexts: ["k8s"] },
  { command: "kubectl delete", description: "Delete resource", category: "k8s", contexts: ["k8s"] },
  { command: "kubectl port-forward", description: "Forward local port to pod", category: "k8s", contexts: ["k8s"] },
  { command: "kubectl scale", description: "Scale deployment", category: "k8s", contexts: ["k8s"] },

  // ─── Terraform ──────────────────────────────────────────────
  { command: "terraform init", description: "Initialize Terraform", category: "terraform", contexts: ["terraform"] },
  { command: "terraform plan", description: "Preview changes", category: "terraform", contexts: ["terraform"] },
  { command: "terraform apply", description: "Apply changes", category: "terraform", contexts: ["terraform"] },
  { command: "terraform destroy", description: "Destroy infrastructure", category: "terraform", contexts: ["terraform"] },
  { command: "terraform fmt", description: "Format config files", category: "terraform", contexts: ["terraform"] },
  { command: "terraform validate", description: "Validate config", category: "terraform", contexts: ["terraform"] },

  // ─── Make ───────────────────────────────────────────────────
  { command: "make", description: "Run default target", category: "make", contexts: ["make"] },
  { command: "make build", description: "Run build target", category: "make", contexts: ["make"] },
  { command: "make test", description: "Run test target", category: "make", contexts: ["make"] },
  { command: "make clean", description: "Run clean target", category: "make", contexts: ["make"] },
  { command: "make install", description: "Run install target", category: "make", contexts: ["make"] },

  // ─── TypeScript / tsc ───────────────────────────────────────
  { command: "tsc", description: "Compile TypeScript", category: "typescript", contexts: ["typescript"] },
  { command: "tsc --noEmit", description: "Type-check only", category: "typescript", contexts: ["typescript"] },
  { command: "tsc --watch", description: "Compile in watch mode", category: "typescript", contexts: ["typescript"] },
  { command: "tsc --init", description: "Initialize tsconfig.json", category: "typescript", contexts: ["typescript"] },
  { command: "npx tsc --noEmit", description: "Type-check with npx", category: "typescript", contexts: ["typescript"] },

  // ─── ESLint / Prettier ──────────────────────────────────────
  { command: "eslint .", description: "Lint current directory", category: "lint", contexts: ["typescript", "javascript"] },
  { command: "eslint --fix .", description: "Lint and auto-fix", category: "lint", contexts: ["typescript", "javascript"] },
  { command: "prettier --write .", description: "Format all files", category: "lint", contexts: ["typescript", "javascript"] },
  { command: "prettier --check .", description: "Check formatting", category: "lint", contexts: ["typescript", "javascript"] },

  // ─── Jest / Vitest ──────────────────────────────────────────
  { command: "jest", description: "Run Jest tests", category: "test", contexts: ["jest"] },
  { command: "jest --watch", description: "Run Jest in watch mode", category: "test", contexts: ["jest"] },
  { command: "jest --coverage", description: "Run with coverage", category: "test", contexts: ["jest"] },
  { command: "vitest", description: "Run Vitest", category: "test", contexts: ["vitest"] },
  { command: "vitest run", description: "Run Vitest once", category: "test", contexts: ["vitest"] },

  // ─── Misc CLIs ──────────────────────────────────────────────
  { command: "gh pr create", description: "Create pull request", category: "gh", contexts: ["git"] },
  { command: "gh pr list", description: "List pull requests", category: "gh", contexts: ["git"] },
  { command: "gh pr checkout", description: "Checkout PR branch", category: "gh", contexts: ["git"] },
  { command: "gh issue list", description: "List issues", category: "gh", contexts: ["git"] },
  { command: "gh repo clone", description: "Clone GitHub repo", category: "gh", contexts: [] },
  { command: "vercel", description: "Deploy to Vercel", category: "vercel", contexts: ["next", "vite"] },
  { command: "vercel dev", description: "Start Vercel dev server", category: "vercel", contexts: ["next", "vite"] },
  { command: "netlify dev", description: "Start Netlify dev server", category: "netlify", contexts: [] },
  { command: "wrangler dev", description: "Start Cloudflare dev server", category: "cloudflare", contexts: [] },
  { command: "prisma migrate dev", description: "Run Prisma migrations", category: "prisma", contexts: ["prisma"] },
  { command: "prisma generate", description: "Generate Prisma client", category: "prisma", contexts: ["prisma"] },
  { command: "prisma studio", description: "Open Prisma Studio", category: "prisma", contexts: ["prisma"] },
  { command: "prisma db push", description: "Push schema to database", category: "prisma", contexts: ["prisma"] },
];

// Build the index
for (const entry of commands) {
  const firstToken = entry.command.split(" ")[0];
  const existing = index.get(firstToken);
  if (existing) {
    existing.push(entry);
  } else {
    index.set(firstToken, [entry]);
  }
}

/** O(1) lookup by first token, then linear scan within category */
export function lookupCommands(input: string): CommandEntry[] {
  const trimmed = input.trim();
  if (!trimmed) return [];

  const tokens = trimmed.split(/\s+/);
  const firstToken = tokens[0];
  const candidates = index.get(firstToken);
  if (!candidates) return [];

  // Filter to commands that start with the full input
  return candidates.filter((c) => c.command.startsWith(trimmed));
}

/** Get all commands for a given first token (for broader matching) */
export function lookupByFirstToken(token: string): CommandEntry[] {
  return index.get(token) ?? [];
}

/** Get all first tokens that start with a prefix (for partial first-token matching) */
export function lookupByPrefix(prefix: string): CommandEntry[] {
  const trimmed = prefix.trim();
  if (!trimmed) return [];
  const results: CommandEntry[] = [];
  for (const [token, entries] of index) {
    if (token.startsWith(trimmed)) {
      results.push(...entries);
    }
  }
  return results;
}
