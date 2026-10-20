import * as esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const shared = {
    bundle: true,
    minify: production,
    sourcemap: !production,
    logLevel: "info",
};

const contexts = await Promise.all([
    // The extension itself, running in VS Code's Node host
    esbuild.context({
        ...shared,
        entryPoints: ["src/extension.ts"],
        outfile: "dist/extension.js",
        platform: "node",
        format: "cjs",
        external: ["vscode"],
    }),
    // The preview, running in a webview
    esbuild.context({
        ...shared,
        entryPoints: ["media/viewer.ts"],
        outfile: "dist/viewer.js",
        platform: "browser",
        format: "iife",
    }),
]);

if (watch) {
    await Promise.all(contexts.map((context) => context.watch()));
} else {
    await Promise.all(contexts.map((context) => context.rebuild()));
    await Promise.all(contexts.map((context) => context.dispose()));
}
