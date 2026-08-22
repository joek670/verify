import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVerifyServer, resolveTrialLog, server } from "../server.js";

let origin;
let logOrigin;
let logPath;
let logDirectory;
let loggingServer;

before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;

  logDirectory = await mkdtemp(join(tmpdir(), "verify-trials-"));
  logPath = join(logDirectory, "trials.jsonl");
  loggingServer = createVerifyServer({ logPath });
  await new Promise((resolve) => loggingServer.listen(0, "127.0.0.1", resolve));
  logOrigin = `http://127.0.0.1:${loggingServer.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await new Promise((resolve, reject) => loggingServer.close((error) => (error ? reject(error) : resolve())));
  await rm(logDirectory, { force: true, recursive: true });
});

const get = (path) => fetch(`${origin}${path}`, { redirect: "manual" });

const postTrial = (target, body, headers = {}) =>
  fetch(`${target}/trials`, {
    body,
    headers: { "Content-Type": "application/json", Origin: target, ...headers },
    method: "POST",
  });

test("serves the app locally with restrictive security headers", async () => {
  const response = await get("/");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.match(response.headers.get("content-security-policy"), /default-src 'self'/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(await response.text(), /Media Risk Gate/);
});

test("does not expose files outside the public directory", async () => {
  for (const path of [
    "/..%2fpackage.json",
    "/../server.js",
    "/%2e%2e/server.js",
    "/./../../.git/config",
    "/public/../../server.js",
  ]) {
    const response = await get(path);
    assert.notEqual(response.status, 200, `${path} must not be served`);
  }
});

test("does not read a request target as a protocol-relative URL", async () => {
  // `//server.js` used to parse as host "server.js" with an empty path, which
  // silently fell through to the index page with a 200.
  for (const path of ["//server.js", "//example.com/server.js", "///package.json"]) {
    const response = await get(path);
    assert.equal(response.status, 404, `${path} must not resolve to a page`);
    assert.doesNotMatch(await response.text(), /Media Risk Gate/);
  }
});

test("sends security headers on error responses too", async () => {
  const response = await get("/does-not-exist.js");
  assert.equal(response.status, 404);
  assert.match(response.headers.get("content-security-policy"), /default-src 'self'/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.match(response.headers.get("content-type"), /text\/plain/);
});

test("does not accept trial records unless logging is switched on", async () => {
  // The default server keeps no state and has no write path, which is what lets the
  // README claim that nothing leaves the browser without a qualification.
  const response = await postTrial(origin, JSON.stringify({ label: "genuine" }));
  assert.equal(response.status, 404);
  assert.match(response.headers.get("content-security-policy"), /default-src 'self'/);
});

test("appends a labeled trial as one JSON line when logging is switched on", async () => {
  const first = await postTrial(logOrigin, JSON.stringify({ action: "review", label: "genuine", responseSeconds: 11.4 }));
  const second = await postTrial(logOrigin, JSON.stringify({ action: "review", label: "synthetic", responseSeconds: 9.1 }));
  assert.equal(first.status, 204);
  assert.equal(second.status, 204);

  const lines = (await readFile(logPath, "utf8")).trim().split("\n");
  assert.equal(lines.length, 2, "one line per trial");
  const records = lines.map((line) => JSON.parse(line));
  assert.deepEqual(records.map(({ label }) => label), ["genuine", "synthetic"]);
  assert.equal(records[0].responseSeconds, 11.4);
  assert.match(records[0].loggedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("refuses a trial record posted from another origin", async () => {
  // A page the user has open elsewhere can POST to loopback. Requiring Origin to match
  // the host the request arrived on is what stops it writing into the log.
  const response = await postTrial(logOrigin, JSON.stringify({ label: "genuine" }), { Origin: "http://evil.example" });
  assert.equal(response.status, 403);
});

test("refuses a trial record that is oversized or not a JSON object", async () => {
  const oversized = await postTrial(logOrigin, JSON.stringify({ label: "genuine", pad: "x".repeat(9000) }));
  assert.equal(oversized.status, 413);
  assert.equal((await postTrial(logOrigin, "not json")).status, 400);
  assert.equal((await postTrial(logOrigin, JSON.stringify(["genuine"]))).status, 400);
  assert.equal((await postTrial(logOrigin, JSON.stringify(null))).status, 400);
});

test("refuses a trial log inside the served directory", () => {
  // Otherwise the log is readable over the same loopback origin that wrote it.
  assert.throws(() => resolveTrialLog("public/trials.jsonl"), /must not point inside/);
  assert.equal(resolveTrialLog(""), null);
  assert.equal(resolveTrialLog(undefined), null);
});

test("refuses a trial record whose host is a rebindable name", async () => {
  // Matching Origin against Host is not enough on its own: a name the attacker controls
  // can be rebound to 127.0.0.1, and then the two headers agree with each other. Only a
  // loopback literal is accepted.
  const status = await new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        headers: { "Content-Type": "application/json", Host: "attacker.example", Origin: "http://attacker.example" },
        host: "127.0.0.1",
        method: "POST",
        path: "/trials",
        port: loggingServer.address().port,
      },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    request.on("error", reject);
    request.end(JSON.stringify({ label: "genuine" }));
  });
  assert.equal(status, 403);
});

test("keeps a trial record on one line even when a value contains a newline", async () => {
  const response = await postTrial(logOrigin, JSON.stringify({ label: "genuine", note: "one\ntwo" }));
  assert.equal(response.status, 204);
  const lines = (await readFile(logPath, "utf8")).trim().split("\n");
  assert.equal(JSON.parse(lines.at(-1)).note, "one\ntwo", "the newline survives as data, not as a record boundary");
});
