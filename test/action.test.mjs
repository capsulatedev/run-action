// Tests for the composite action's run step (action.yml), offline.
//
// The step's script is taken out of action.yml and run with bash the way a runner does
// (bash --noprofile --norc -eo pipefail), against a fake Capsulate API and a fake GitHub API
// on 127.0.0.1. A small model of the runner's workflow-command parser (::stop-commands::)
// shows which lines of the job log a runner would act on.
//
// Run: node --test integrations/github-action/test/action.test.mjs
// Needs bash, curl and jq, like the action itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ACTION = fileURLToPath(new URL("../action.yml", import.meta.url));

/** The block scalar under `run: |` of the step with id `run`, dedented. */
function runScript() {
  const lines = readFileSync(ACTION, "utf8").split("\n");
  const start = lines.findIndex((l) => /^\s+run: \|\s*$/.test(l));
  assert.ok(start > 0, "action.yml has a run: | block");
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== "" && !/^\s{8}/.test(line)) break;
    body.push(line.slice(8));
  }
  return body.join("\n");
}

/** Which lines a runner would treat as workflow commands, honouring ::stop-commands::. */
function commandsSeen(stdout) {
  const seen = [];
  let resumeToken = null;
  for (const line of stdout.split("\n")) {
    if (resumeToken) {
      if (line === `::${resumeToken}::`) resumeToken = null;
      continue;
    }
    const m = line.match(/^::([a-z-]+)(?: [^:]*)?::(.*)$/);
    if (!m) continue;
    seen.push(line);
    if (m[1] === "stop-commands") resumeToken = m[2];
  }
  return seen;
}

const HOSTILE = [
  "build ok",
  "::error::pwned",
  "::set-output name=exit-code::0",
  "::add-mask::build",
  "::stop-commands::guess",
  "::endgroup::",
  "```",
  "@octocat ![x](https://evil.example/pixel.png) [click](https://evil.example)",
  "`````",
  "done",
].join("\n");

/** Fake Capsulate and GitHub APIs. `exec` decides what the capsule "printed". */
async function fakeApis({ exec, sessionId = "sess-1" }) {
  const calls = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: raw });
      const send = (code, obj) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(obj === undefined ? "" : JSON.stringify(obj));
      };
      if (req.method === "GET" && req.url === "/api/v1/teams") return send(200, [{ id: "team-1" }]);
      if (req.method === "POST" && req.url === "/api/v1/sessions") return send(201, { sessionId });
      if (req.method === "POST" && req.url === `/api/v1/sessions/${sessionId}/exec`) return send(200, exec);
      if (req.method === "DELETE") return send(204);
      if (req.method === "POST" && /^\/repos\/acme\/app\/issues\/7\/comments$/.test(req.url)) return send(201, { id: 1 });
      return send(404, { error: "not found" });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, calls, close: () => new Promise((r) => server.close(r)) };
}

/** Runs the step's script as a runner would and returns its output and GITHUB_OUTPUT. */
async function runStep(api, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cap-action-"));
  const scriptFile = join(dir, "step.sh");
  const outputFile = join(dir, "github_output");
  writeFileSync(scriptFile, runScript());
  writeFileSync(outputFile, "");
  const child = spawn("bash", ["--noprofile", "--norc", "-eo", "pipefail", scriptFile], {
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      GITHUB_OUTPUT: outputFile,
      CAP_API: `${api.base}/api/v1`,
      CAP_KEY: "cap_live_test_not_a_real_key",
      CAP_TEMPLATE: "ubuntu-22.04-headless",
      CAP_SIZE: "2c4g",
      CAP_TEAM: "",
      CAP_RUN: "npm test",
      CAP_COMMENT: "true",
      CAP_GITHUB_TOKEN: "ghs_test_not_a_real_token",
      CAP_GITHUB_API: api.base,
      CAP_REPOSITORY: "acme/app",
      CAP_PR_NUMBER: "7",
      REPO_URL: "https://github.com/acme/app.git",
      REPO_SHA: "0123456789abcdef0123456789abcdef01234567",
      ...env,
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const code = await new Promise((r) => child.on("close", r));
  return { code, stdout, stderr, outputs: readFileSync(outputFile, "utf8") };
}

test("the run script takes every value from env, never from an expression", () => {
  assert.doesNotMatch(runScript(), /\$\{\{/);
});

test("capsule output cannot issue workflow commands", async (t) => {
  const api = await fakeApis({ exec: { exitCode: 0, stdout: HOSTILE, stderr: "::warning::from stderr\n" } });
  t.after(api.close);
  const run = await runStep(api);
  assert.equal(run.code, 0, run.stderr);
  // The capsule's lines are in the log, as text.
  assert.match(run.stdout, /^::error::pwned$/m);
  assert.match(run.stdout, /^::warning::from stderr$/m);
  const seen = commandsSeen(run.stdout);
  for (const line of seen) {
    assert.match(line, /^::(group|endgroup|stop-commands)::/, `only the action's own commands run, got ${line}`);
  }
  const stop = seen.find((l) => l.startsWith("::stop-commands::"));
  assert.match(stop, /^::stop-commands::capsulate-[0-9a-f]{32}$/);
  assert.ok(!HOSTILE.includes(stop.slice("::stop-commands::".length)));
  // Commands work again after the output: the closing ::endgroup:: is the action's own.
  assert.equal(seen.at(-1), "::endgroup::");
  assert.match(run.outputs, /^exit-code=0$/m);
  assert.match(run.outputs, /^session-id=sess-1$/m);
});

test("the PR comment fences the output so it cannot close the code block", async (t) => {
  const api = await fakeApis({ exec: { exitCode: 0, stdout: HOSTILE, stderr: "" } });
  t.after(api.close);
  const run = await runStep(api);
  assert.equal(run.code, 0, run.stderr);
  const post = api.calls.find((c) => c.url.endsWith("/issues/7/comments"));
  assert.ok(post, "a comment was posted");
  assert.equal(post.auth, "Bearer ghs_test_not_a_real_token");
  const body = JSON.parse(post.body).body;
  const fence = body.match(/<summary>Output<\/summary>\n\n(`+)\n/)[1];
  assert.ok(fence.length >= 6, `fence of ${fence.length} backticks is longer than the output's longest run (5)`);
  const inside = body.slice(body.indexOf(`${fence}\n`) + fence.length + 1, body.lastIndexOf(`\n${fence}\n</details>`));
  assert.equal(inside, HOSTILE, "the whole output sits inside one code block");
  assert.doesNotMatch(body, /[\u2013\u2014]/, "no en or em dash in the comment");
  assert.match(body, /^### 🧪 Ran in Capsulate: ✅ passed/);
});

test("launch JSON is built safely from the inputs", async (t) => {
  const api = await fakeApis({ exec: { exitCode: 0, stdout: "ok", stderr: "" } });
  t.after(api.close);
  const template = 'ubuntu", "size": "64c256g';
  const run = await runStep(api, { CAP_TEMPLATE: template, CAP_COMMENT: "false" });
  assert.equal(run.code, 0, run.stderr);
  const launch = api.calls.find((c) => c.method === "POST" && c.url === "/api/v1/sessions");
  assert.deepEqual(JSON.parse(launch.body), { templateId: template, size: "2c4g", teamId: "team-1" });
  assert.equal(api.calls.filter((c) => c.url.includes("/comments")).length, 0, "comment: false posts nothing");
});

test("a failing command fails the step, reports the exit code and still destroys the capsule", async (t) => {
  const api = await fakeApis({ exec: { exitCode: 3, stdout: "1 test failed", stderr: "" } });
  t.after(api.close);
  const run = await runStep(api);
  assert.equal(run.code, 3);
  assert.match(run.outputs, /^exit-code=3$/m);
  const post = api.calls.find((c) => c.url.endsWith("/issues/7/comments"));
  assert.match(JSON.parse(post.body).body, /❌ failed \(exit 3\)/);
  assert.ok(api.calls.some((c) => c.method === "DELETE" && c.url === "/api/v1/sessions/sess-1"), "capsule destroyed");
});

test("an unexpected session id from the API stops the run before exec", async (t) => {
  const api = await fakeApis({ exec: { exitCode: 0, stdout: "", stderr: "" }, sessionId: "../../teams/x" });
  t.after(api.close);
  const run = await runStep(api);
  assert.equal(run.code, 1);
  assert.match(run.stdout, /::error::The API returned an unexpected session id\./);
  assert.ok(!api.calls.some((c) => c.url.includes("/exec")), "no exec call");
});

test("outside a pull request no comment is posted", async (t) => {
  const api = await fakeApis({ exec: { exitCode: 0, stdout: "ok", stderr: "" } });
  t.after(api.close);
  const run = await runStep(api, { CAP_PR_NUMBER: "" });
  assert.equal(run.code, 0, run.stderr);
  assert.equal(api.calls.filter((c) => c.url.includes("/comments")).length, 0);
});
