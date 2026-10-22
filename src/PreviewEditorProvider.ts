import * as vscode from "vscode";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

class PreviewDocument implements vscode.CustomDocument {
    constructor(readonly uri: vscode.Uri) {}
    dispose() {}
}

export type BuildStatus = "building" | "generating" | "failed" | "idle";

/** A part of a model, one of its 3MF build items. */
export interface ModelPart {
    id: string;
    name: string;
    semantic: string;
}

/** A measurement in a preview: a point, or a length between two, with its color by number. */
export interface Measurement {
    id: string;
    colorIndex: number;
    start: [number, number, number];
    end?: [number, number, number];
    phase: "coordinate" | "inProgress" | "complete";
}

/** The parts of the model in a preview, which of them it hides, and the pictures of them drawn so far. */
export interface PreviewParts {
    file: vscode.Uri;
    parts: ModelPart[];
    hidden: string[];
    thumbnails: Record<string, string>;
}

/** Shows 3MF files in a 3D preview that reloads whenever the file changes on disk. */
export class PreviewEditorProvider implements vscode.CustomReadonlyEditorProvider<PreviewDocument> {
    static readonly viewType = "cadova.preview";

    private readonly panels = new Map<string, Set<vscode.WebviewPanel>>();
    // The modification time of the file each panel last loaded, so a file is only loaded once per change
    private readonly loadedTimes = new WeakMap<vscode.WebviewPanel, number>();
    private activePanel: vscode.WebviewPanel | undefined;
    private readonly partsByPanel = new WeakMap<vscode.WebviewPanel, PreviewParts>();
    private readonly activePartsChange = new vscode.EventEmitter<void>();
    /** Fires when the active preview changes, or the parts in it, or which of them are hidden. */
    readonly onDidChangeActiveParts = this.activePartsChange.event;
    private readonly activeThumbnailsChange = new vscode.EventEmitter<Record<string, string>>();
    /** Fires with new pictures of the active preview's parts, by part ID, as they're drawn. */
    readonly onDidRenderActiveThumbnails = this.activeThumbnailsChange.event;
    private readonly measurementsByPanel = new WeakMap<vscode.WebviewPanel, Measurement[]>();
    private readonly activeMeasurementsChange = new vscode.EventEmitter<void>();
    /** Fires when the active preview's measurements change, including the point under the pointer. */
    readonly onDidChangeActiveMeasurements = this.activeMeasurementsChange.event;

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

    /**
     * The parts of the model in the active preview, or the last one active while another editor is.
     * The preview decides which parts are hidden; these are as it last reported them.
     */
    get activeParts(): PreviewParts | undefined {
        return this.activePanel && this.partsByPanel.get(this.activePanel);
    }

    /** Hides these parts in the active preview, and shows the rest. */
    setHiddenParts(hidden: string[]) {
        this.activePanel?.webview.postMessage({ type: "hiddenParts", hidden });
    }

    /** Outlines a part in the active preview, or none. */
    highlightPart(id: string | null) {
        this.activePanel?.webview.postMessage({ type: "highlightPart", id });
    }

    /** The active preview's measurements, with the point under the pointer last while measuring. */
    get activeMeasurements(): Measurement[] {
        return (this.activePanel && this.measurementsByPanel.get(this.activePanel)) ?? [];
    }

    /** Emphasizes a measurement in the active preview, or none. */
    highlightMeasurement(id: string | null) {
        this.activePanel?.webview.postMessage({ type: "highlightMeasurement", id });
    }

    deleteMeasurement(id: string) {
        this.activePanel?.webview.postMessage({ type: "deleteMeasurement", id });
    }

    deleteAllMeasurements() {
        this.activePanel?.webview.postMessage({ type: "deleteAllMeasurements" });
    }

    /** Centers the active preview's view on some parts. */
    frameParts(ids: string[]) {
        this.activePanel?.webview.postMessage({ type: "frameParts", ids });
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

        if (panel.active) this.setActivePanel(panel);
        this.updateContext();
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
                if (message.type === "parts") {
                    // A new model's parts get new pictures; the old ones stay while only visibility changes
                    const thumbnails = message.newModel ? {} : this.partsByPanel.get(panel)?.thumbnails ?? {};
                    this.partsByPanel.set(panel, { file: document.uri, parts: message.parts, hidden: message.hidden, thumbnails });
                    if (panel === this.activePanel) this.activePartsChange.fire();
                }
                if (message.type === "measurements") {
                    this.measurementsByPanel.set(panel, message.measurements);
                    if (panel === this.activePanel) this.activeMeasurementsChange.fire();
                }
                if (message.type === "thumbnails") {
                    const parts = this.partsByPanel.get(panel);
                    if (parts) Object.assign(parts.thumbnails, message.thumbnails);
                    if (panel === this.activePanel) this.activeThumbnailsChange.fire(message.thumbnails);
                }
            }),
            panel.onDidChangeViewState(() => {
                if (panel.active) this.setActivePanel(panel);
            }),
        ];
        panel.onDidDispose(() => {
            clearTimeout(reloadTimer);
            disposables.forEach((disposable) => disposable.dispose());
            panels.delete(panel);
            if (panels.size === 0) this.panels.delete(key);
            if (this.activePanel === panel) this.setActivePanel(undefined);
            this.updateContext();
        });
    }

    private setActivePanel(panel: vscode.WebviewPanel | undefined) {
        if (panel === this.activePanel) return;
        this.activePanel = panel;
        this.activePartsChange.fire();
        this.activeMeasurementsChange.fire();
    }

    // Views about previews, such as the parts list, show while one is open
    private updateContext() {
        vscode.commands.executeCommand("setContext", "cadova.hasPreview", this.panels.size > 0);
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
    /* The web customizer's model view, which is dark in both themes like Cadova Viewer; the toolbar
       above it and the menus follow VS Code's theme */
    :root {
        --viewer: #0d0d0d; --grid: #ffffff; --model: #ffffff;
        --axis-x: #ff453a; --axis-y: #30d158; --axis-z: #0a84ff;
    }
    body { --panel: #ffffff; --text: #1d1d1b; --line: #e3e1db; --accent: #c2410c; --accent-soft: #fbe9df; }
    body.vscode-dark, body.vscode-high-contrast:not(.vscode-high-contrast-light) {
        --panel: #1f1f1d; --text: #ecebe7; --line: #33322f; --accent: #f08a4b; --accent-soft: #3a2519;
    }
    /* VS Code's default webview styles pad the body at the sides */
    html, body { height: 100%; margin: 0; padding: 0; overflow: hidden; }
    body {
        display: flex; flex-direction: column; background: var(--viewer); color: #ffffff;
        font: 15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    #stage { position: relative; flex: 1; min-height: 0; }
    #viewer { position: absolute; inset: 0; overflow: hidden; }
    #viewer canvas { display: block; width: 100%; height: 100%; touch-action: none; outline: none; }
    /* View options in a row of their own above the view, styled like VS Code's toolbars */
    #topbar {
        display: flex; align-items: center; gap: 8px; padding: 4px 8px;
        background: var(--vscode-editor-background, var(--panel));
        border-bottom: 1px solid var(--vscode-editorGroup-border, var(--vscode-panel-border, var(--line)));
        color: var(--vscode-foreground, var(--text));
        font-family: var(--vscode-font-family, system-ui, -apple-system, "Segoe UI", sans-serif);
        font-size: 12px; line-height: 1; user-select: none;
    }
    #toolbar { flex: 1; display: flex; flex-wrap: wrap; align-items: center; row-gap: 4px; min-width: 0; }
    .toolbar-group { display: flex; align-items: center; gap: 2px; }
    .toolbar-group[hidden] { display: none; }
    /* The groups from this one on sit at the right end, apart from the others */
    .toolbar-group.trailing { margin-left: auto; }
    .toolbar-group.trailing::before { display: none; }
    /* A thin divider between groups, like the separators in VS Code's editor actions */
    .toolbar-group:not(:first-child)::before {
        content: ""; width: 1px; height: 16px; margin: 0 6px;
        background: var(--vscode-menu-separatorBackground, var(--vscode-widget-border, var(--line)));
    }
    .toolbar-group button {
        min-width: 24px; height: 24px; padding: 0 4px; border: 1px solid transparent; border-radius: 5px;
        background: transparent; color: var(--vscode-icon-foreground, var(--text)); cursor: pointer;
        display: grid; place-items: center; font: inherit;
    }
    .toolbar-group button:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, .2)); }
    .toolbar-group button:active { background: var(--vscode-toolbar-activeBackground, rgba(128, 128, 128, .3)); }
    /* An option that's on looks like the toggles in VS Code's find widget */
    .toolbar-group button[aria-pressed="true"] {
        background: var(--vscode-inputOption-activeBackground, var(--accent-soft));
        border-color: var(--vscode-inputOption-activeBorder, transparent);
        color: var(--vscode-inputOption-activeForeground, var(--accent));
    }
    /* In a group where one is always chosen, the chosen one is only shaded, like a pressed button */
    .toolbar-group.picker button[aria-pressed="true"] {
        background: var(--vscode-toolbar-activeBackground, rgba(128, 128, 128, .25));
        border-color: transparent; color: var(--vscode-icon-foreground, var(--text));
    }
    .toolbar-group button:focus-visible { outline: 1px solid var(--vscode-focusBorder, var(--accent)); outline-offset: -1px; }
    .toolbar-group svg {
        width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.5;
        stroke-linecap: round; stroke-linejoin: round;
    }
    /* The model's info, like Cadova Viewer's info sheet, as a widget over the view's corner */
    #info {
        position: absolute; top: 8px; right: 8px; max-width: calc(100% - 32px); max-height: calc(100% - 16px);
        overflow: auto; box-sizing: border-box; padding: 2px 12px;
        background: var(--vscode-editorWidget-background, var(--panel));
        color: var(--vscode-editorWidget-foreground, var(--vscode-foreground, var(--text)));
        border: 1px solid var(--vscode-editorWidget-border, var(--vscode-widget-border, var(--line)));
        border-radius: 6px; box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0, 0, 0, .36));
        font-family: var(--vscode-font-family, system-ui, -apple-system, "Segoe UI", sans-serif); font-size: 12px;
    }
    #info[hidden] { display: none; }
    #info dl { display: grid; grid-template-columns: auto auto; gap: 4px 16px; margin: 0; padding: 8px 0; }
    #info dl + dl { border-top: 1px solid var(--vscode-editorWidget-border, var(--vscode-widget-border, var(--line))); }
    #info dt { color: var(--vscode-descriptionForeground, #9c9a94); }
    #info dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; white-space: pre-line; overflow-wrap: anywhere; }
    /* Cross-sections: a chip for each in the view's top left corner, after Cadova Viewer's */
    #sections { position: absolute; top: 8px; left: 8px; right: 8px; display: flex; flex-wrap: wrap; gap: 6px; pointer-events: none; }
    #sections[hidden] { display: none; }
    #sections > * { pointer-events: auto; }
    .section-chip {
        --chip-check: #000; display: flex; height: 28px; border-radius: 8px; overflow: hidden;
        background: color-mix(in srgb, var(--vscode-editorWidget-background, var(--panel)) 80%, transparent);
        backdrop-filter: blur(12px); color: var(--section);
    }
    .section-chip button {
        border: none; background: none; color: inherit; cursor: pointer; display: grid; place-items: center;
        height: 100%; padding: 0 4px 0 7px;
    }
    .section-chip button.scissors { padding: 0 7px 0 4px; }
    .section-chip svg { width: 15px; height: 15px; }
    .section-chip.disabled button.scissors { opacity: .6; }
    .section-chip.selected { background: var(--section); color: #000; --chip-check: var(--section); }
    .section-add {
        height: 28px; padding: 0 7px; margin-left: 4px; border-radius: 8px; cursor: pointer; display: grid; place-items: center;
        border: 1px dashed var(--vscode-descriptionForeground, #9c9a94); color: var(--vscode-descriptionForeground, #9c9a94);
        background: color-mix(in srgb, var(--vscode-editorWidget-background, var(--panel)) 40%, transparent);
    }
    .section-add svg { width: 19px; height: 15px; }
    /* The selected section's controls, along the bottom like Cadova Viewer's editing bar */
    #section-bar {
        position: absolute; left: 50%; bottom: 16px; transform: translateX(-50%); max-width: calc(100% - 32px);
        display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 10px 14px; border-radius: 12px;
        background: color-mix(in srgb, var(--vscode-editorWidget-background, var(--panel)) 85%, transparent);
        backdrop-filter: blur(12px); border: 1px solid var(--vscode-editorWidget-border, var(--vscode-widget-border, var(--line)));
        color: var(--vscode-editorWidget-foreground, var(--vscode-foreground, var(--text)));
        font-family: var(--vscode-font-family, system-ui, -apple-system, "Segoe UI", sans-serif); font-size: 12px;
    }
    #section-bar[hidden] { display: none; }
    #section-bar ~ #status { bottom: 16px; }
    #section-bar:not([hidden]) ~ #status { bottom: 132px; }
    .bar-title { font-size: 13px; }
    .bar-controls { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px 22px; }
    .bar-control { display: flex; flex-direction: column; align-items: center; gap: 4px; }
    .bar-row { display: flex; align-items: center; gap: 6px; height: 24px; }
    .bar-label { font-size: 10.5px; color: var(--vscode-descriptionForeground, #9c9a94); min-height: 13px; }
    #section-bar button {
        height: 24px; min-width: 24px; padding: 0 9px; border-radius: 4px; cursor: pointer; font: inherit;
        color: var(--vscode-button-secondaryForeground, var(--text)); background: var(--vscode-button-secondaryBackground, rgba(128, 128, 128, .25));
        border: 1px solid var(--vscode-button-border, transparent);
    }
    #section-bar button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground, rgba(128, 128, 128, .35)); }
    #section-bar button:disabled { opacity: .4; cursor: default; }
    #section-bar button.primary { color: var(--vscode-button-foreground, #fff); background: var(--vscode-button-background, #0078d4); }
    #section-bar button.primary:hover { background: var(--vscode-button-hoverBackground, #026ec1); }
    #section-bar button.bar-delete { padding: 0 5px; display: grid; place-items: center; }
    #section-bar button.bar-delete svg { width: 15px; height: 15px; }
    #section-bar .switch {
        appearance: none; width: 30px; height: 17px; margin: 0; border-radius: 9px; cursor: pointer; position: relative;
        background: rgba(128, 128, 128, .45); transition: background .15s;
    }
    #section-bar .switch::after {
        content: ""; position: absolute; top: 2px; left: 2px; width: 13px; height: 13px; border-radius: 50%; background: #fff; transition: left .15s;
    }
    #section-bar .switch:checked { background: var(--vscode-button-background, #0078d4); }
    #section-bar .switch:checked::after { left: 15px; }
    /* Measuring: a crosshair, and the length being measured next to it */
    #viewer canvas.measuring { cursor: crosshair; }
    #measure-readout {
        position: absolute; pointer-events: none; padding: 2px 7px; border-radius: 4px; white-space: nowrap;
        background: color-mix(in srgb, var(--vscode-editorWidget-background, var(--panel)) 88%, transparent);
        color: var(--vscode-editorWidget-foreground, var(--vscode-foreground, var(--text)));
        border: 1px solid var(--vscode-editorWidget-border, var(--vscode-widget-border, var(--line)));
        font-family: var(--vscode-font-family, system-ui, -apple-system, "Segoe UI", sans-serif); font-size: 12px;
        font-variant-numeric: tabular-nums;
    }
    #measure-readout[hidden] { display: none; }
    #axis-indicator {
        position: absolute; right: 16px; bottom: 14px; width: 110px; height: 110px;
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
    /* What's happening to the model, in a pill at the bottom of the view, like Cadova Viewer's */
    #status {
        position: absolute; left: 50%; bottom: 16px; transform: translateX(-50%);
        display: flex; align-items: center; gap: 8px; padding: 8px 14px 8px 12px; white-space: nowrap;
        background: color-mix(in srgb, var(--vscode-editorWidget-background, var(--panel)) 85%, transparent);
        backdrop-filter: blur(12px); color: var(--vscode-editorWidget-foreground, var(--vscode-foreground, var(--text)));
        border: 1px solid rgba(255, 255, 255, .15); border-radius: 999px; box-shadow: 0 1px 4px rgba(0, 0, 0, .2);
        font-family: var(--vscode-font-family, system-ui, -apple-system, "Segoe UI", sans-serif); font-size: 13px;
        opacity: 0; transition: opacity .15s; pointer-events: none;
    }
    #status.visible { opacity: 1; }
    #status.busy::before {
        content: ""; width: 12px; height: 12px; border-radius: 50%;
        border: 2px solid currentColor; border-right-color: transparent; opacity: .8; animation: spin .8s linear infinite;
    }
    #status.failed { color: var(--vscode-errorForeground, #f97066); }
    @keyframes spin { to { transform: rotate(360deg); } }
    /* Menus look like VS Code's own */
    .menu {
        position: fixed; z-index: 10; min-width: 160px; padding: 4px; border-radius: 6px;
        box-sizing: border-box; max-height: calc(100vh - 8px); overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain;
        background: var(--vscode-menu-background, var(--panel)); color: var(--vscode-menu-foreground, var(--text));
        border: 1px solid var(--vscode-menu-border, var(--line)); box-shadow: 0 4px 16px rgba(0, 0, 0, .35);
        font: 13px system-ui, -apple-system, "Segoe UI", sans-serif; user-select: none;
    }
    .menu-item {
        display: grid; grid-template-columns: 18px 1fr 14px; align-items: center; gap: 2px;
        padding: 3px 8px 3px 4px; border-radius: 4px; cursor: default; white-space: nowrap;
    }
    .menu-item:hover {
        background: var(--vscode-menu-selectionBackground, var(--accent));
        color: var(--vscode-menu-selectionForeground, #ffffff);
    }
    .menu-item[aria-disabled="true"] { opacity: .45; }
    .menu-item[aria-disabled="true"]:hover { background: none; color: inherit; }
    .menu-item .check { text-align: center; }
    .menu-item .label { display: flex; align-items: center; gap: 6px; }
    .menu-item .icon { width: 24px; height: 24px; flex: none; }
    .menu-item .arrow { text-align: right; }
    .menu-header { padding: 4px 8px 2px; font-size: 11.5px; opacity: .65; }
    .menu-separator { height: 1px; margin: 4px 6px; background: var(--vscode-menu-separatorBackground, var(--line)); }
    .menu .alternate, .menu.alternate .normal { display: none; }
    .menu.alternate .alternate { display: inline; }
</style>
</head>
<body>
<div id="topbar">
    <div id="toolbar" role="toolbar" aria-label="View"></div>
</div>
<div id="stage">
    <div id="viewer"></div>
    <div id="sections" hidden></div>
    <div id="info" hidden></div>
    <div id="measure-readout" hidden></div>
    <div id="overlay">Loading…</div>
    <div id="section-bar" hidden></div>
    <div id="status" role="status"></div>
</div>
<script nonce="${nonce}" src="${webview.asWebviewUri(script)}"></script>
</body>
</html>`;
    }
}
