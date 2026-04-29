#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const rootDir = path.resolve(__dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
const buildDir = path.join(rootDir, "build", "extension");
const distDir = path.join(rootDir, "dist");
const zipPath = path.join(distDir, `openadviser-extension-${packageJson.version}.zip`);

fs.rmSync(buildDir, { recursive: true, force: true });
fs.mkdirSync(buildDir, { recursive: true });
fs.mkdirSync(distDir, { recursive: true });

copyFile("manifest.json");
copyDir("src", "src");

fs.rmSync(zipPath, { force: true });

if (process.platform === "win32") {
  run("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    `Compress-Archive -Path '${escapePowerShellPath(path.join(buildDir, "*"))}' -DestinationPath '${escapePowerShellPath(zipPath)}' -Force`
  ]);
} else {
  run("zip", ["-qr", zipPath, "."], buildDir);
}

console.log(`Wrote ${zipPath}`);

function copyFile(relativePath) {
  fs.copyFileSync(path.join(rootDir, relativePath), path.join(buildDir, relativePath));
}

function copyDir(from, to) {
  fs.cpSync(path.join(rootDir, from), path.join(buildDir, to), {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}debug-shots${path.sep}`)
  });
}

function run(command, args, cwd = rootDir) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    windowsHide: true
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}`);
  }
}

function escapePowerShellPath(value) {
  return String(value).replace(/'/g, "''");
}
