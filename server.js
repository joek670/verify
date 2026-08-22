import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./public/", import.meta.url));
const port = Number(process.env.PORT) || 4173;
const types = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

// Sent on every response, including errors, so an error page is never sniffed,
// framed, or allowed to load anything the app itself could not load.
const securityHeaders = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

const TEXT = { ...securityHeaders, "Content-Type": "text/plain; charset=utf-8" };

// Parsing a request target against a relative base reads `//host/path` as a
// protocol-relative URL, which discards the path and leaves pathname as "/".
// Building an absolute URL with an explicit origin keeps the whole target in
// the pathname, so it can be resolved and rejected on its own merits.
function requestPathname(target) {
  try {
    return new URL(`http://localhost${target.startsWith("/") ? target : `/${target}`}`).pathname;
  } catch {
    return null;
  }
}

export const server = createServer((request, response) => {
  const pathname = requestPathname(request.url ?? "/");
  if (pathname === null) {
    response.writeHead(400, TEXT).end("Bad request");
    return;
  }

  const requested = pathname.replace(/^\/+/, "") || "index.html";
  const filePath = normalize(join(root, requested));

  if (!filePath.startsWith(root)) {
    response.writeHead(403, TEXT).end("Forbidden");
    return;
  }

  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) throw new Error("Not a file");
    response.writeHead(200, {
      ...securityHeaders,
      "Content-Length": stat.size,
      "Content-Type": types[extname(filePath)] ?? "application/octet-stream",
    });
    // A ReadStream that errors with no listener throws an uncaught exception and takes
    // the process down. statSync passing does not rule that out: the file can be
    // removed, locked, or dehydrated to a cloud placeholder between the stat and the
    // open. Headers are already sent here, so the response can only be destroyed, not
    // turned into a 500.
    const body = createReadStream(filePath);
    body.on("error", () => response.destroy());
    body.pipe(response);
  } catch {
    response.writeHead(404, TEXT).end("Not found");
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(port, "127.0.0.1", () => {
    console.log(`Verify is running at http://127.0.0.1:${port}`);
  });
}
