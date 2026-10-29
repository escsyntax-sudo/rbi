import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { run } from "../src/cli.js";
import { startFakeGitHub } from "./fake-github.js";

let fake;

before(async () => {
  fake = await startFakeGitHub();
});

after(async () => {
  await fake.close();
});

function capture() {
  let text = "";
  return {
    write(chunk) {
      text += String(chunk);
      return true;
    },
    get text() {
      return text;
    },
  };
}

async function cli(argv, { env = {} } = {}) {
  const stdout = capture();
  const stderr = capture();
  const code = await run(argv, {
    stdout,
    stderr,
    env: { GITHUB_TOKEN: "test-token", ...env },
  });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

test("help and version", async () => {
  const help = await cli(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage:/);
  assert.match(help.stdout, /rbi scan --org NAME/);

  const version = await cli(["--version"]);
  assert.equal(version.code, 0);
  assert.equal(version.stdout.trim(), "rbi 0.1.0");
});

test("missing and unknown commands", async () => {
  const missing = await cli([]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /missing command/);

  const unknown = await cli(["nope"]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /unknown command/);

  const extra = await cli(["scan", "--org", "acme", "extra"]);
  assert.equal(extra.code, 1);
  assert.match(extra.stderr, /unexpected argument/);
});

test("unknown options are reported", async () => {
  const result = await cli(["scan", "--org", "acme", "--wat"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--wat/);
});

test("usage validation", async () => {
  const noTarget = await cli(["scan"]);
  assert.equal(noTarget.code, 1);
  assert.match(noTarget.stderr, /--org NAME or at least one --repo/);

  const both = await cli(["scan", "--org", "acme", "--repo", "acme/api"]);
  assert.equal(both.code, 1);
  assert.match(both.stderr, /not both/);

  const badRepo = await cli(["scan", "--repo", "acme"]);
  assert.equal(badRepo.code, 1);
  assert.match(badRepo.stderr, /OWNER\/NAME/);

  const badSla = await cli(["scan", "--org", "acme", "--branch-sla", "0"]);
  assert.equal(badSla.code, 1);
  assert.match(badSla.stderr, /--branch-sla/);

  const badType = await cli(["scan", "--org", "acme", "--owner-type", "team"]);
  assert.equal(badType.code, 1);
  assert.match(badType.stderr, /--owner-type/);

  const badFormat = await cli(["scan", "--org", "acme", "--format", "html"]);
  assert.equal(badFormat.code, 1);
  assert.match(badFormat.stderr, /--format/);
});

test("scan one repository as JSON", async () => {
  const result = await cli([
    "scan",
    "--repo",
    "acme/api",
    "--api-url",
    fake.url,
    "--format",
    "json",
    "--quiet",
  ]);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ownerType, "repos");
  assert.equal(payload.totals.staleBranches, 1);
  assert.equal(payload.totals.stalePulls, 1);
  assert.equal(payload.repos[0].fullName, "acme/api");
  assert.equal(result.stderr, "");
});

test("scan an organisation as Markdown", async () => {
  const result = await cli([
    "scan",
    "--org",
    "acme",
    "--api-url",
    fake.url,
    "--exclude-forks",
    "--quiet",
  ]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^# Repository debt report/);
  assert.match(result.stdout, /Owner: acme \(org\)/);
  assert.match(result.stdout, /### \[acme\/api\]/);
  assert.match(result.stdout, /Skipped repositories/);
  assert.equal(/^-{3,}$/m.test(result.stdout), false);
});

test("progress and summary go to stderr", async () => {
  const result = await cli([
    "scan",
    "--org",
    "acme",
    "--api-url",
    fake.url,
    "--exclude-forks",
  ]);
  assert.equal(result.code, 0);
  assert.match(result.stderr, /rbi: scanning acme/);
  assert.match(result.stderr, /rbi: 1\/1 api/);
  assert.match(result.stderr, /stale branch/);
  assert.match(result.stdout, /Repository debt report/);
});

test("a custom token is used", async () => {
  const start = fake.state.requests.length;
  await cli([
    "scan",
    "--repo",
    "acme/api",
    "--api-url",
    fake.url,
    "--token",
    "cli-token",
    "--format",
    "json",
    "--quiet",
  ]);
  const requests = fake.state.requests.slice(start);
  assert.equal(requests.every((request) => request.authorization === "Bearer cli-token"), true);
});

test("--fail exits with 2 when findings exist", async () => {
  const result = await cli([
    "scan",
    "--repo",
    "acme/api",
    "--api-url",
    fake.url,
    "--format",
    "json",
    "--quiet",
    "--fail",
  ]);
  assert.equal(result.code, 2);
});

test("--fail exits with 0 without findings", async () => {
  const result = await cli([
    "scan",
    "--repo",
    "acme/api",
    "--api-url",
    fake.url,
    "--branch-sla",
    "3650",
    "--pr-sla",
    "3650",
    "--format",
    "json",
    "--quiet",
    "--fail",
  ]);
  assert.equal(result.code, 0);
});

test("--out writes the report and keeps stdout empty", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rbi-"));
  try {
    const path = join(directory, "report.md");
    const result = await cli([
      "scan",
      "--repo",
      "acme/api",
      "--api-url",
      fake.url,
      "--out",
      path,
      "--quiet",
    ]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    const written = await readFile(path, "utf8");
    assert.match(written, /# Repository debt report/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a broken repository still produces a report", async () => {
  const result = await cli([
    "scan",
    "--repo",
    "acme/missing",
    "--api-url",
    fake.url,
    "--format",
    "json",
    "--quiet",
  ]);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.totals.repoErrors, 1);
});

test("verbose mode reports the authenticated user", async () => {
  const result = await cli([
    "scan",
    "--repo",
    "acme/api",
    "--api-url",
    fake.url,
    "--format",
    "json",
    "--quiet",
    "--verbose",
  ]);
  assert.match(result.stderr, /authenticated as tester/);
});

test("api errors exit with 1", async () => {
  const result = await cli([
    "scan",
    "--org",
    "acme",
    "--api-url",
    "http://127.0.0.1:1",
    "--quiet",
  ]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /rbi:/);
});
