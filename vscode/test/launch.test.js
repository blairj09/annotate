"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { launchQuarto } = require("../launch");

const windowsOnly = { skip: process.platform !== "win32" && "batch launchers are Windows-only" };

// Prints its arguments as JSON, then "stdin closed" once stdin ends, like the
// notes server does with --watch-stdin.
const PRINT_ARGS = `process.stdout.write(JSON.stringify(process.argv.slice(2)) + "\\n");
process.stdin.on("end", () => process.stdout.write("stdin closed\\n"));
process.stdin.resume();
`;

// Forwards its arguments with %*, as Quarto's launchers do.
const PLAIN_CMD = `@echo off\r\n"${process.execPath}" "%~dp0print-args.js" %*\r\n`;

// Same, with delayed expansion on, as in the dev build's quarto.cmd.
const DELAYED_CMD = `@echo off\r
SETLOCAL ENABLEDELAYEDEXPANSION\r
SET "SCRIPT_PATH=%~dp0"\r
"${process.execPath}" "!SCRIPT_PATH!print-args.js" %*\r
`;

function fixture(dirName, launcherName, launcher) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "annotate-launch-"));
  const dir = path.join(base, dirName);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "print-args.js"), PRINT_ARGS);
  const file = path.join(dir, launcherName);
  if (launcher !== undefined) fs.writeFileSync(file, launcher);
  return { dir, file };
}

// Runs the launcher, closes stdin once the arguments are printed, and resolves
// with the arguments the program received and its full output.
function run(quarto, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = launchQuarto(quarto, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d;
      if (out.includes("\n")) child.stdin.end();
    });
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("exit", (code) => {
      const first = out.split(/\r?\n/)[0];
      resolve({ code, out, err, args: first ? JSON.parse(first) : null });
    });
  });
}

// Server path, workspace path with spaces, cmd metacharacters and a trailing
// backslash (a drive root), plus the fixed flags the extension passes.
function serverArgs(dir) {
  return [
    "run",
    path.join(dir, "my ext (1)", "server.ts"),
    path.join(dir, "R&D 100% (draft); a,b") + path.sep,
    "--port",
    "4851",
    "--watch-stdin",
  ];
}

test("runs a .cmd launcher from a path with spaces and keeps every argument", windowsOnly, async () => {
  const { dir, file } = fixture("quarto dev & (x) %PATH% 50%", "quarto.cmd", PLAIN_CMD);
  const args = serverArgs(dir);
  const r = await run(file, args, dir);
  assert.deepStrictEqual(r.args, args, r.err);
  assert.match(r.out, /stdin closed/);
  assert.strictEqual(r.code, 0);
});

test("passes cmd metacharacters through without running them", windowsOnly, async () => {
  const { dir, file } = fixture("plain", "quarto.cmd", PLAIN_CMD);
  const args = ["a & echo INJECTED", "b | echo INJECTED", "%PATH%", "!PATH!", "c^d", "x<y>z", "", "--flag=1"];
  const r = await run(file, args, dir);
  assert.deepStrictEqual(r.args, args, r.err);
  assert.doesNotMatch(r.out, /^INJECTED/m);
});

test("works with a launcher that enables delayed expansion, like quarto.cmd", windowsOnly, async () => {
  const { dir, file } = fixture("dev build & (x) 50%", "QUARTO.BAT", DELAYED_CMD);
  const args = serverArgs(dir);
  const r = await run(file, args, dir);
  assert.deepStrictEqual(r.args, args, r.err);
  assert.strictEqual(r.code, 0);
});

test("refuses arguments a batch launcher can't receive intact", windowsOnly, () => {
  const { dir, file } = fixture("plain", "quarto.cmd", PLAIN_CMD);
  assert.throws(() => launchQuarto(file, ['x" & echo INJECTED & "'], { cwd: dir }), /batch/);
  assert.throws(() => launchQuarto(file, ["a\nb"], { cwd: dir }), /batch/);
});

test("runs an executable directly, with arguments unchanged", async () => {
  const { dir } = fixture("exe dir", "unused", undefined);
  const args = [path.join(dir, "print-args.js"), ...serverArgs(dir)];
  const child = launchQuarto(process.execPath, args, { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
  assert.strictEqual(child.spawnfile, process.execPath);
  child.stdout.once("data", () => child.stdin.end());
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  const code = await new Promise((r) => child.on("exit", r));
  assert.deepStrictEqual(JSON.parse(out.split(/\r?\n/)[0]), serverArgs(dir));
  assert.strictEqual(code, 0);
});
