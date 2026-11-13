// Starts quarto. On Windows quarto can be a batch launcher (quarto.cmd in a dev
// build). Node refuses to spawn .cmd/.bat files without a shell (EINVAL, since
// the CVE-2024-27980 fix), so those run through cmd.exe, with the command line
// quoted here: Node doesn't quote arguments for a shell.
"use strict";

const cp = require("child_process");
const path = require("path");

const BATCH = /\.(cmd|bat)$/i;
const SAFE = /^[\w\-.=:/\\+@]+$/;
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

// Quotes an argument the way the program's own parser (MSVC rules) splits it,
// then escapes everything cmd.exe would act on, quotes included, with ^. The
// batch file gets the quoted argument back, so its %* keeps it in one piece.
// A "!" still breaks in quarto.cmd: it expands %* with delayed expansion on.
function quoteArg(arg) {
  if (/["\r\n\0]/.test(arg)) {
    throw new Error(`Can't pass ${JSON.stringify(arg)} to a batch launcher intact.`);
  }
  if (SAFE.test(arg)) return arg;
  const quoted = `"${arg.replace(/(\\+)$/, "$1$1")}"`;
  return quoted.replace(CMD_META, "^$1");
}

function launchQuarto(quarto, args, options) {
  if (process.platform !== "win32" || !BATCH.test(quarto)) {
    return cp.spawn(quarto, args, options);
  }
  const line = [path.normalize(quarto).replace(CMD_META, "^$1"), ...args.map(quoteArg)].join(" ");
  return cp.spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
    ...options,
    windowsVerbatimArguments: true,
  });
}

module.exports = { launchQuarto };
