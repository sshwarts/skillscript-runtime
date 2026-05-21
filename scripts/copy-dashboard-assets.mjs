#!/usr/bin/env node
// Copies dashboard SPA assets (index.html, app.js, styles.css) from
// src/dashboard/spa/ to dist/dashboard/spa/ so the compiled runtime
// can serve them. The TypeScript compiler only handles .ts files;
// static SPA assets need a separate copy step.

import { mkdir, readdir, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SRC = join(ROOT, "src", "dashboard", "spa");
const DST = join(ROOT, "dist", "dashboard", "spa");

await mkdir(DST, { recursive: true });
const entries = await readdir(SRC);
for (const entry of entries) {
  await copyFile(join(SRC, entry), join(DST, entry));
}
console.log(`copied ${entries.length} dashboard asset(s) to ${DST}`);
