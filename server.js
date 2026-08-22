import { createReadStream, statSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./public/", import.meta.url));
const port = Number(process.env.PORT) || 4173;
const TRIAL_ROUTE = "/trials";
// A trial record is a decision and its measurements, never media. Anything larger than
// this is not one, and the body is refused before it is buffered.
const MAX_TRIAL_BYTES = 8 * 1024;
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

// Trial logging is opt-in. With VERIFY_LOG unset the route does not exist and the
// server keeps no state, so the claim that nothing leaves the browser holds exactly as
// written for a default run. Setting it narrows that claim to "nothing leaves this
// machine", which is a different promise and is documented as one.
export function resolveTrialLog(value) {
  if (!value) return null;
  const path = resolvePath(value);
  // A log written inside public/ would be served straight back over the same loopback
  // origin that wrote it, turning a local record into a readable endpoint.
  if (path.startsWith(root)) throw new Error(`VERIFY_LOG must not point inside ${root}`);
  return path;
}

// Bounds the buffer rather than trusting Content-Length: a chunked body does not send
// one, and a header that claims a small body is not a limit on the bytes that follow.
function readTrialBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_TRIAL_BYTES) {
        // Stop buffering, but leave the socket alone. Destroying the request here means
        // the client sees a closed connection instead of the reason it was refused.
        request.pause();
        rejectBody(new RangeError("Trial record too large"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    request.on("error", rejectBody);
  });
}

async function appendTrial(request, response, logPath) {
  if (!logPath) {
    response.writeHead(404, TEXT).end("Not found");
    return;
  }
  // A browser attaches Origin to every cross-site POST, so requiring it to match the
  // host this request arrived on stops another page the user has open from writing
  // records into a loopback log. Matching alone is not enough: a name the attacker
  // controls can be rebound to 127.0.0.1, and then their Origin and Host agree with
  // each other. The host must also be the loopback literal the server was reached on.
  const { host, origin } = request.headers;
  if (origin !== `http://${host}` || !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host ?? "")) {
    response.writeHead(403, TEXT).end("Forbidden");
    return;
  }

  let record;
  try {
    record = JSON.parse(await readTrialBody(request));
  } catch (error) {
    // The rest of an oversized body is never read, so the connection cannot be reused
    // and is closed once the reason has been written.
    if (error instanceof RangeError) response.writeHead(413, { ...TEXT, Connection: "close" }).end("Trial record too large");
    else response.writeHead(400, TEXT).end("Bad request");
    return;
  }
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    response.writeHead(400, TEXT).end("Bad request");
    return;
  }

  try {
    // One JSON object per line. The server's own clock is recorded alongside the
    // client's so a series stays ordered even where the browser's clock is wrong.
    await appendFile(logPath, `${JSON.stringify({ ...record, loggedAt: new Date().toISOString() })}\n`, "utf8");
  } catch {
    response.writeHead(500, TEXT).end("Could not append to the trial log");
    return;
  }
  response.writeHead(204, securityHeaders).end();
}

export function createVerifyServer({ logPath = resolveTrialLog(process.env.VERIFY_LOG) } = {}) {
  return createServer((request, response) => {
    const pathname = requestPathname(request.url ?? "/");
    if (pathname === null) {
      response.writeHead(400, TEXT).end("Bad request");
      return;
    }

    if (request.method === "POST" && pathname === TRIAL_ROUTE) {
      // An unhandled rejection here would take the process down exactly the way an
      // unlistened read stream would, so the last resort is to drop the connection.
      appendTrial(request, response, logPath).catch(() => response.destroy());
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
}

export const server = createVerifyServer();

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const trialLog = resolveTrialLog(process.env.VERIFY_LOG);
  server.listen(port, "127.0.0.1", () => {
    console.log(`Verify is running at http://127.0.0.1:${port}`);
    console.log(trialLog
      ? `Trial logging is on. Labeled decisions append to ${trialLog}`
      : "Trial logging is off. Set VERIFY_LOG=<path> to append labeled decisions to a file on this machine.");
  });
}
