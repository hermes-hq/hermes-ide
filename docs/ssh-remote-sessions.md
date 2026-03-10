# SSH Remote Sessions

Connect to remote machines directly from Hermes IDE, with the same terminal experience as local sessions.

---

## Phase 1: Alpha (Current)

Spawn SSH sessions via the system `ssh` binary inside a PTY. Leverages existing SSH config, keys, and agent for authentication.

### What works
- **Session creation** — Choose "SSH Remote" in the new session dialog, enter host/user/port
- **System SSH** — Uses `ssh -t user@host` so all your `~/.ssh/config` host aliases, keys, and agent forwarding work out of the box
- **Session persistence** — SSH connection info is saved; sessions restore across app restarts
- **Visual indicator** — SSH sessions show a teal "SSH" badge in the sidebar

### Limitations
- No file browsing or working directory detection on the remote host
- No AI agent integration for SSH sessions
- No connection health monitoring or automatic reconnection
- Authentication failures show as raw terminal output

---

## Phase 2: Connection Management

Improve reliability and add saved connections.

### Planned
- **Saved hosts** — Store frequently used SSH connections with labels
- **Reconnection** — Detect dropped connections and offer to reconnect
- **Connection status** — Show connected/disconnected state in the sidebar
- **Keep-alive** — Configurable ServerAliveInterval to prevent timeouts
- **Multi-hop / ProxyJump** — Explicit UI support for jump hosts

---

## Phase 3: Remote Workspace Awareness

Make the remote environment feel native.

### Planned
- **Remote working directory** — Detect and display the current remote path
- **Remote file explorer** — Browse and open files on the remote host via SFTP
- **Remote git info** — Show branch/status for remote repositories
- **Project detection** — Identify the remote project language/framework

---

## Phase 4: AI Agent Integration

Enable AI-powered workflows on remote machines.

### Planned
- **Remote AI agents** — Launch Claude, Gemini, or other agents inside SSH sessions
- **Context injection** — Provide project context from the remote file system
- **Remote tool calls** — AI agents can read/write files and run commands on the remote host
- **Auto-approve** — Same permission modes as local sessions

---

## Phase 5: Advanced Remote Features

Polish and power-user features.

### Planned
- **Port forwarding UI** — Visual management of local/remote port forwards
- **Remote terminal multiplexing** — Multiple shells on a single SSH connection
- **File transfer** — Drag-and-drop upload/download between local and remote
- **Remote environment variables** — Configure env vars injected into remote sessions
- **SSH key management** — Generate, import, and manage SSH keys from within Hermes
