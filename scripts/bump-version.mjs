#!/usr/bin/env node
// Keep the app version in sync across the three sources of truth that Tauri and
// the release workflow read: package.json, src-tauri/tauri.conf.json, and
// src-tauri/Cargo.toml. Run before tagging a release:
//
//   node scripts/bump-version.mjs 0.1.1
//   git commit -am "chore: release v0.1.1" && git tag v0.1.1 && git push --follow-tags
//
// The pushed `v*` tag triggers .github/workflows/release-desktop.yml.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const raw = process.argv[2];
if (!raw) {
  console.error("Usage: node scripts/bump-version.mjs <version>  (e.g. 0.1.1)");
  process.exit(1);
}

const version = raw.replace(/^v/, "");
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Invalid version "${raw}". Expected semver like 0.1.1`);
  process.exit(1);
}

function bumpJson(relPath, apply) {
  const path = join(root, relPath);
  const json = JSON.parse(readFileSync(path, "utf8"));
  apply(json);
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
  console.log(`  ${relPath} -> ${version}`);
}

bumpJson("package.json", (j) => (j.version = version));
bumpJson("src-tauri/tauri.conf.json", (j) => (j.version = version));

// Cargo.toml: replace only the first `version = "..."` (the [package] one),
// never the pinned dependency versions further down.
const cargoPath = join(root, "src-tauri/Cargo.toml");
const cargo = readFileSync(cargoPath, "utf8");
const bumpedCargo = cargo.replace(/^version = ".*"$/m, `version = "${version}"`);
if (bumpedCargo === cargo) {
  console.error("Could not find a version line in src-tauri/Cargo.toml");
  process.exit(1);
}
writeFileSync(cargoPath, bumpedCargo);
console.log(`  src-tauri/Cargo.toml -> ${version}`);

console.log(`\nVersion set to ${version} in all three files.`);
