import * as vscode from "vscode";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

class PreviewDocument implements vscode.CustomDocument {
    constructor(readonly uri: vscode.Uri) {}
    dispose() {}
}

export type BuildStatus = "building" | "generating" | "failed" | "idle";

/** Shows 3MF files in a 3D preview that reloads whenever the file changes on disk. */
export class PreviewEditorProvider implements vscode.CustomReadonlyEditorProvider<PreviewDocument> {
    static readonly viewType = "cadova.preview";

    private readonly panels = new Map<string, Set<vscode.WebviewPanel>>();
    // The modification time of the file each panel last loaded, so a file is only loaded once per change
    private readonly loadedTimes = new WeakMap<vscode.WebviewPanel, number>();
    private activePanel: vscode.WebviewPanel | undefined;

    private static readonly optionsKey = "cadova.previewOptions";

    constructor(private readonly extensionUri: vscode.Uri, private readonly state: vscode.Memento) {}

    static register(context: vscode.ExtensionContext): PreviewEditorProvider {
        const provider = new PreviewEditorProvider(context.extensionUri, context.globalState);
        context.subscriptions.push(vscode.window.registerCustomEditorProvider(PreviewEditorProvider.viewType, provider, {
            webviewOptions: { retainContextWhenHidden: true },
            supportsMultipleEditorsPerDocument: true,
        }));
        return provider;
    }

    /** Shows the file beside the active editor, or brings its preview forward if it's already open. */
    async show(file: vscode.Uri) {
        const existing = this.panels.get(file.toString())?.values().next().value;
        if (existing) {
            existing.reveal(existing.viewColumn, true);
            await this.load(file, existing, true);
        } else {
            await vscode.commands.executeCommand("vscode.openWith", file, PreviewEditorProvider.viewType, {
                viewColumn: vscode.ViewColumn.Beside, preserveFocus: true,
            });
        }
    }

    fitActive() {
        this.activePanel?.webview.postMessage({ type: "fit" });
    }

    /** The model file shown in the active preview. */
    get activeModelFile(): string | undefined {
        for (const [key, panels] of this.panels) {
            if (this.activePanel && panels.has(this.activePanel)) return vscode.Uri.parse(key).fsPath;
        }
        return undefined;
    }

    /** Every model file shown in a preview. */
    get openModelFiles(): string[] {
        return [...this.panels.keys()].map((key) => vscode.Uri.parse(key).fsPath);
    }

    /** Loads the file into its previews if it changed since they last loaded it. */
    reload(file: string) {
        for (const panel of this.panels.get(vscode.Uri.file(file).toString()) ?? []) {
            this.load(vscode.Uri.file(file), panel);
        }
    }

    /** Shows how a rebuild of the model in the file's previews is going. */
    setStatus(file: string, status: BuildStatus) {
        for (const panel of this.panels.get(vscode.Uri.file(file).toString()) ?? []) {
            panel.webview.postMessage({ type: "status", status });
        }
    }

    openCustomDocument(uri: vscode.Uri): PreviewDocument {
        return new PreviewDocument(uri);
    }

    resolveCustomEditor(document: PreviewDocument, panel: vscode.WebviewPanel) {
        const key = document.uri.toString();
        const panels = this.panels.get(key) ?? new Set();
        panels.add(panel);
        this.panels.set(key, panels);

        const dist = vscode.Uri.joinPath(this.extensionUri, "dist");
        panel.webview.options = { enableScripts: true, localResourceRoots: [dist] };
        panel.webview.html = this.html(panel.webview, vscode.Uri.joinPath(dist, "viewer.js"));

        // A model build replaces the file, so a change or a creation both mean a new model
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(
            vscode.Uri.file(path.dirname(document.uri.fsPath)), path.basename(document.uri.fsPath),
        ));
        let reloadTimer: NodeJS.Timeout | undefined;
        const reload = () => {
            clearTimeout(reloadTimer);
            reloadTimer = setTimeout(() => this.load(document.uri, panel), 100);
        };

        if (panel.active) this.activePanel = panel;
        const disposables = [
            watcher,
            watcher.onDidChange(reload),
            watcher.onDidCreate(reload),
            panel.webview.onDidReceiveMessage((message) => {
                // A new preview starts with the view options last chosen in any preview
                if (message.type === "ready") {
                    panel.webview.postMessage({ type: "options", options: this.state.get(PreviewEditorProvider.optionsKey, {}) });
                    this.load(document.uri, panel, true);
                }
                if (message.type === "options") this.state.update(PreviewEditorProvider.optionsKey, message.options);
            }),
            panel.onDidChangeViewState(() => {
                if (panel.active) this.activePanel = panel;
            }),
        ];
        panel.onDidDispose(() => {
            clearTimeout(reloadTimer);
            disposables.forEach((disposable) => disposable.dispose());
            panels.delete(panel);
            if (panels.size === 0) this.panels.delete(key);
            if (this.activePanel === panel) this.activePanel = undefined;
        });
    }

    private async load(file: vscode.Uri, panel: vscode.WebviewPanel, always = false) {
        try {
            const { mtime } = await vscode.workspace.fs.stat(file);
            if (!always && this.loadedTimes.get(panel) === mtime) return;
            this.loadedTimes.set(panel, mtime);
            // A Node Buffer would arrive as JSON; a plain Uint8Array is transferred as binary
            const data = new Uint8Array(await vscode.workspace.fs.readFile(file));
            await panel.webview.postMessage({ type: "model", name: path.basename(file.fsPath), data });
        } catch (error) {
            await panel.webview.postMessage({ type: "error", message: `Couldn't read the model: ${(error as Error).message}` });
        }
    }

    private html(webview: vscode.Webview, script: vscode.Uri): string {
        const nonce = randomBytes(16).toString("base64");
        return /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data: blob:;">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
    /* The web customizer's model view, which is dark in both themes like Cadova Viewer; only the
       buttons over it follow the theme */
    :root {
        --viewer: #0d0d0d; --grid: #ffffff; --model: #ffffff;
        --axis-x: #ff453a; --axis-y: #30d158; --axis-z: #0a84ff;
    }
    body { --panel: #ffffff; --text: #1d1d1b; --line: #e3e1db; --accent: #c2410c; --accent-soft: #fbe9df; }
    body.vscode-dark, body.vscode-high-contrast:not(.vscode-high-contrast-light) {
        --panel: #1f1f1d; --text: #ecebe7; --line: #33322f; --accent: #f08a4b; --accent-soft: #3a2519;
    }
    html, body { height: 100%; margin: 0; overflow: hidden; }
    body { background: var(--viewer); color: #ffffff; font: 15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
    #viewer { position: absolute; inset: 0; overflow: hidden; }
    #viewer canvas { display: block; width: 100%; height: 100%; touch-action: none; outline: none; }
    /* View options in a row over the top of the view, after Cadova Viewer's toolbar */
    #toolbar {
        position: absolute; top: 12px; left: 12px; right: 120px; display: flex; flex-wrap: wrap; gap: 6px;
        pointer-events: none;
    }
    #toolbar[hidden] { display: none; }
    .toolbar-group {
        display: flex; pointer-events: auto; border-radius: 8px; overflow: hidden;
        background: color-mix(in srgb, var(--panel) 82%, transparent); backdrop-filter: blur(8px);
        border: 1px solid var(--line);
    }
    .toolbar-group button {
        width: 30px; height: 28px; padding: 0; border: none; background: transparent; cursor: pointer;
        display: grid; place-items: center; color: var(--text);
    }
    .toolbar-group button + button { border-left: 1px solid var(--line); }
    .toolbar-group button.text { width: auto; padding: 0 8px; font: 500 12px system-ui, -apple-system, "Segoe UI", sans-serif; }
    .toolbar-group button:hover { background: var(--panel); }
    .toolbar-group button[aria-pressed="true"] { background: var(--accent-soft); color: var(--accent); }
    .toolbar-group button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
    .toolbar-group svg {
        width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.6;
        stroke-linecap: round; stroke-linejoin: round;
    }
    .model-size {
        position: absolute; left: 16px; bottom: 14px; pointer-events: none;
        font-size: 12px; color: #9c9a94; font-variant-numeric: tabular-nums; white-space: nowrap;
    }
    .model-size[hidden] { display: none; }
    #axis-indicator {
        position: absolute; left: 16px; bottom: 34px; width: 110px; height: 110px;
        pointer-events: none; filter: drop-shadow(0 0 2px black);
    }
    #axis-indicator line { stroke-width: 1; }
    #axis-indicator line[data-axis="x"] { stroke: var(--axis-x); }
    #axis-indicator line[data-axis="y"] { stroke: var(--axis-y); }
    #axis-indicator line[data-axis="z"] { stroke: var(--axis-z); }
    #axis-indicator text { fill: currentColor; font-size: 10px; text-anchor: middle; dominant-baseline: central; }
    #overlay {
        position: absolute; inset: 0; display: grid; place-content: center; text-align: center;
        padding: 16px; color: #9c9a94; pointer-events: none;
    }
    #overlay[hidden] { display: none; }
    #status {
        position: absolute; top: 14px; right: 14px; font-size: 12.5px; color: var(--text);
        background: color-mix(in srgb, var(--panel) 82%, transparent); backdrop-filter: blur(8px);
        border: 1px solid var(--line); border-radius: 999px; padding: 4px 10px;
        opacity: 0; transition: opacity .15s; pointer-events: none;
    }
    #status.visible { opacity: 1; }
    #status.failed { color: var(--vscode-errorForeground, #f97066); }
</style>
</head>
<body>
<div id="viewer"></div>
<div class="model-size" id="model-size" hidden></div>
<div id="toolbar" role="toolbar" aria-label="View" hidden></div>
<div id="overlay">Loading…</div>
<div id="status"></div>
<script nonce="${nonce}" src="${webview.asWebviewUri(script)}"></script>
</body>
</html>`;
    }
}
