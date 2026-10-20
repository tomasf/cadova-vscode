// Copies the web customizer's viewer modules from a Cadova checkout, so the preview looks and
// navigates exactly like the customizer. Run it again whenever the customizer's viewer changes:
//
//     npm run sync-viewer [-- path/to/Cadova]     (defaults to ../Cadova)

import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

const cadova = resolve(process.argv[2] ?? "../Cadova");
const template = join(cadova, "Plugins/GenerateCustomizer/Template");
const destination = resolve("media/customizer");
const modules = [
    "axes.js", "camera.js", "edges.js", "grid.js", "lighting.js",
    "meshes.js", "navigation.js", "rendering.js", "threemf.js",
];

mkdirSync(destination, { recursive: true });
for (const module of modules) copyFileSync(join(template, module), join(destination, module));

const commit = execFileSync("git", ["-C", cadova, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const dirty = execFileSync("git", ["-C", cadova, "status", "--porcelain", "--", template], { encoding: "utf8" }).trim();
writeFileSync(join(destination, "SOURCE.md"), `\
These modules are copied unchanged from Cadova's web customizer template
(\`Plugins/GenerateCustomizer/Template\`) by \`npm run sync-viewer\`. Don't edit them here;
change them in Cadova and sync again.

Synced from Cadova ${commit}${dirty ? " with uncommitted changes" : ""}.
`);
console.log(`Copied ${modules.length} viewer modules from Cadova ${commit.slice(0, 8)}${dirty ? " (uncommitted changes)" : ""}.`);
