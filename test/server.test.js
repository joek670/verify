import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { server } from "../server.js";

let origin;

before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));

const get = (path) => fetch(`${origin}${path}`, { redirect: "manual" });

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
