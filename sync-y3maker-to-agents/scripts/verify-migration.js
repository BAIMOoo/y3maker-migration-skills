#!/usr/bin/env node

const path = require("path");

const { emitJson, parseCommonCliOptions } = require("./lib/cli-args");
const { assertSafeWorkspace } = require("./lib/fs-utils");
const { verifyWorkspace } = require("./lib/verifier");

function main() {
  try {
    const options = parseCommonCliOptions(process.argv.slice(2), { allowDryRun: false });
    const workspace = path.resolve(options.workspace);
    assertSafeWorkspace(workspace, options);
    const payload = verifyWorkspace(workspace, options);
    emitJson(payload, options.pretty);
    process.exitCode = payload.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`ERROR: ${error.message}\n`);
    process.exitCode = 1;
  }
}

main();
