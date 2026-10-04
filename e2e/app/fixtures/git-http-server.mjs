// A git remote over HTTP that asks for a password, for scenarios that prove
// how the app signs in to push and pull. It serves the bare repositories
// under `root` through git's own `git http-backend` (the smart HTTP
// protocol, the same one GitHub speaks), behind HTTP Basic authentication:
// a request without an accepted user and password gets 401 and a
// `WWW-Authenticate` header, exactly like a hosted remote.
//
//   const server = await startGitHttpServer({ root, accounts: { alice: "secret" } });
//   server.url("remote.git")    // http://127.0.0.1:<port>/remote.git
//   server.seen                 // [{ method, path, user, accepted }] per request
//   await server.close();
//
// Listens on 127.0.0.1 only, on a free port.

import { spawn } from "node:child_process";
import { createServer } from "node:http";

/** The user and password of a Basic Authorization header, or null. */
export function basicCredentials(header) {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header || "");
  if (!m) return null;
  const text = Buffer.from(m[1], "base64").toString("utf8");
  const colon = text.indexOf(":");
  return colon < 0 ? null : { user: text.slice(0, colon), password: text.slice(colon + 1) };
}

export async function startGitHttpServer({ root, accounts, log = () => {} }) {
  const seen = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const creds = basicCredentials(req.headers.authorization);
    const accepted = !!creds && Object.hasOwn(accounts, creds.user) && accounts[creds.user] === creds.password;
    seen.push({ method: req.method, path: url.pathname, query: url.search, user: creds?.user ?? null, accepted });
    if (!accepted) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="hermes-e2e"', "Content-Type": "text/plain" });
      res.end(creds ? "wrong user or password\n" : "authentication required\n");
      return;
    }
    const cgi = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        REQUEST_METHOD: req.method,
        PATH_INFO: decodeURIComponent(url.pathname),
        QUERY_STRING: url.search.replace(/^\?/, ""),
        CONTENT_TYPE: req.headers["content-type"] || "",
        ...(req.headers["content-length"] ? { CONTENT_LENGTH: req.headers["content-length"] } : {}),
        ...(req.headers["content-encoding"] ? { HTTP_CONTENT_ENCODING: req.headers["content-encoding"] } : {}),
        ...(req.headers["git-protocol"] ? { GIT_PROTOCOL: req.headers["git-protocol"] } : {}),
        // An authenticated user may push (http-backend enables receive-pack).
        REMOTE_USER: creds.user,
        REMOTE_ADDR: "127.0.0.1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    req.pipe(cgi.stdin);
    let head = Buffer.alloc(0);
    let headersDone = false;
    cgi.stdout.on("data", (chunk) => {
      if (headersDone) {
        res.write(chunk);
        return;
      }
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      headersDone = true;
      let status = 200;
      const headers = {};
      for (const line of head.subarray(0, end).toString("latin1").split("\r\n")) {
        const colon = line.indexOf(":");
        if (colon < 0) continue;
        const name = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === "status") status = Number.parseInt(value, 10) || 200;
        else headers[name] = value;
      }
      res.writeHead(status, headers);
      res.write(head.subarray(end + 4));
    });
    cgi.stderr.on("data", (d) => log(`  [git http-backend] ${String(d).trim()}`));
    cgi.on("close", () => {
      if (!headersDone) res.writeHead(500).end("git http-backend printed no headers\n");
      else res.end();
    });
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const { port } = server.address();
  return {
    port,
    seen,
    url: (name) => `http://127.0.0.1:${port}/${name}`,
    close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
  };
}
