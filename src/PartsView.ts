import * as vscode from "vscode";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import type { Measurement, PreviewEditorProvider } from "./PreviewEditorProvider";

type IconSize = "small" | "large";

/** What a part row's right-click menu knows about the row, from its `data-vscode-context`. */
interface RowContext {
    partId: string;
}

/** What a measurement's right-click menu knows about it. */
interface MeasurementContext {
    measurementId: string;
}

/**
 * The Model view in the sidebar, after Cadova Viewer's: the parts of the model in the active preview,
 * each with its thumbnail and a checkmark that shows or hides it, and its measurements. Hovering a
 * part outlines it in the preview; double-clicking one centers the view on it.
 *
 * The list itself is a webview (media/parts.ts), since a tree view can't show the thumbnails or tell
 * when a row is hovered. Its right-click menu is VS Code's own, with the commands registered here.
 */
export class PartsView implements vscode.WebviewViewProvider, vscode.Disposable {
    static readonly viewID = "cadova.parts";
    private static readonly iconSizeKey = "cadova.partsIconSize";

    private view: vscode.WebviewView | undefined;
    private selection: string[] = [];
    private readonly disposables: vscode.Disposable[];

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly state: vscode.Memento,
        private readonly preview: PreviewEditorProvider,
    ) {
        this.disposables = [
            vscode.window.registerWebviewViewProvider(PartsView.viewID, this),
            preview.onDidChangeActiveParts(() => this.update()),
            preview.onDidRenderActiveThumbnails((thumbnails) => this.view?.webview.postMessage({ type: "thumbnails", thumbnails })),
            preview.onDidChangeActiveMeasurements(() => this.view?.webview.postMessage({ type: "measurements", measurements: preview.activeMeasurements })),
            vscode.commands.registerCommand("cadova.copyMeasurement", (row: MeasurementContext) => {
                const measurement = preview.activeMeasurements.find((measurement) => measurement.id === row.measurementId);
                if (measurement) vscode.env.clipboard.writeText(PartsView.measurementText(measurement));
            }),
            vscode.commands.registerCommand("cadova.deleteMeasurement", (row: MeasurementContext) => preview.deleteMeasurement(row.measurementId)),
            vscode.commands.registerCommand("cadova.deleteAllMeasurements", () => preview.deleteAllMeasurements()),
            vscode.commands.registerCommand("cadova.centerOnParts", (row: RowContext) => preview.frameParts(this.targets(row))),
            vscode.commands.registerCommand("cadova.showOnlyParts", (row: RowContext) => this.showOnly(this.targets(row))),
            vscode.commands.registerCommand("cadova.copyPartNames", (row: RowContext) => {
                const ids = this.targets(row);
                const names = this.parts.filter((part) => ids.includes(part.id)).map((part) => part.name);
                vscode.env.clipboard.writeText(names.join("\n"));
            }),
            vscode.commands.registerCommand("cadova.showAllParts", () => preview.setHiddenParts([])),
            vscode.commands.registerCommand("cadova.hideAllParts", () => preview.setHiddenParts(this.parts.map((part) => part.id))),
            vscode.commands.registerCommand("cadova.partsSmallIcons", () => this.setIconSize("small")),
            vscode.commands.registerCommand("cadova.partsLargeIcons", () => this.setIconSize("large")),
        ];
        vscode.commands.executeCommand("setContext", PartsView.iconSizeKey, this.iconSize);
        this.update();
    }

    resolveWebviewView(view: vscode.WebviewView) {
        this.view = view;
        const dist = vscode.Uri.joinPath(this.extensionUri, "dist");
        view.webview.options = { enableScripts: true, localResourceRoots: [dist] };
        view.webview.html = this.html(view.webview, vscode.Uri.joinPath(dist, "parts.js"));
        view.webview.onDidReceiveMessage((message) => {
            switch (message.type) {
                case "ready":
                    this.update();
                    break;
                case "setHidden":
                    this.preview.setHiddenParts(message.hidden);
                    break;
                case "hover":
                    this.preview.highlightPart(message.id);
                    break;
                case "frame":
                    this.preview.frameParts(message.ids);
                    break;
                case "selection":
                    this.selection = message.ids;
                    break;
                case "hoverMeasurement":
                    this.preview.highlightMeasurement(message.id);
                    break;
                case "deleteMeasurement":
                    if (message.all) this.preview.deleteAllMeasurements();
                    else this.preview.deleteMeasurement(message.id);
                    break;
            }
        });
        view.onDidDispose(() => {
            if (this.view === view) this.view = undefined;
        });
    }

    dispose() {
        this.disposables.forEach((disposable) => disposable.dispose());
    }

    private get parts() {
        return this.preview.activeParts?.parts ?? [];
    }

    private get iconSize(): IconSize {
        return this.state.get<IconSize>(PartsView.iconSizeKey, "large");
    }

    private setIconSize(size: IconSize) {
        this.state.update(PartsView.iconSizeKey, size);
        vscode.commands.executeCommand("setContext", PartsView.iconSizeKey, size);
        this.view?.webview.postMessage({ type: "iconSize", size });
    }

    // A right-clicked part that's selected acts with the rest of the selection; otherwise it acts alone
    private targets(row: RowContext): string[] {
        return this.selection.includes(row.partId) ? this.selection : [row.partId];
    }

    // As in Cadova Viewer, showing only what's already all that's shown shows everything again
    private showOnly(ids: string[]) {
        const hidden = this.preview.activeParts?.hidden ?? [];
        const visible = this.parts.map((part) => part.id).filter((id) => !hidden.includes(id));
        const already = visible.length === ids.length && ids.every((id) => visible.includes(id));
        this.preview.setHiddenParts(already ? [] : this.parts.map((part) => part.id).filter((id) => !ids.includes(id)));
    }

    // Sends the list what it shows. New thumbnails also arrive on their own as they're drawn.
    private update() {
        const active = this.preview.activeParts;
        const hidden = active?.hidden ?? [];
        vscode.commands.executeCommand("setContext", "cadova.hasHiddenParts", hidden.length > 0);
        if (!this.view) return;
        this.view.description = active ? path.basename(active.file.fsPath, path.extname(active.file.fsPath)) : undefined;
        this.view.webview.postMessage({
            type: "state", file: active?.file.toString(), parts: active?.parts ?? [], hidden,
            iconSize: this.iconSize, thumbnails: active?.thumbnails ?? {},
        });
        this.view.webview.postMessage({ type: "measurements", measurements: this.preview.activeMeasurements });
    }

    // Cadova Viewer's copied text: each point's coordinates, the difference and the length, in mm
    private static measurementText(measurement: Measurement): string {
        const value = (number: number) => `${number.toFixed(2)} mm`;
        const point = (title: string, [x, y, z]: number[]) => `${title}\nX: ${value(x)}\nY: ${value(y)}\nZ: ${value(z)}`;
        const sections = [point("Point A", measurement.start)];
        const end = measurement.end;
        if (end) {
            const delta = end.map((coordinate, axis) => coordinate - measurement.start[axis]);
            sections.push(point("Point B", end), point("Delta", delta), `Length: ${value(Math.hypot(...delta))}`);
        }
        return sections.join("\n\n");
    }

    private html(webview: vscode.Webview, script: vscode.Uri): string {
        const nonce = randomBytes(16).toString("base64");
        return /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data:;">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
    /* Rows like a VS Code list, with Cadova Viewer's thumbnail, name and checkmark */
    html, body { height: 100%; margin: 0; padding: 0; }
    body { color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
    #list { outline: none; padding: 2px 0; box-sizing: border-box; user-select: none; }
    [hidden] { display: none !important; }
    .row {
        display: flex; align-items: center; gap: 8px; padding: 0 8px 0 12px; height: var(--row-height);
        cursor: default; border: 1px solid transparent;
    }
    body.small { --row-height: 28px; --thumbnail: 24px; }
    body.large { --row-height: 38px; --thumbnail: 32px; }
    .row:hover { background: var(--vscode-list-hoverBackground); }
    .row.selected { background: var(--vscode-list-inactiveSelectionBackground); color: var(--vscode-list-inactiveSelectionForeground, inherit); }
    #list:focus .row.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground, inherit); }
    #list:focus .row.focused { border-color: var(--vscode-list-focusOutline, var(--vscode-focusBorder)); }
    .thumbnail { width: var(--thumbnail); height: var(--thumbnail); flex: none; display: grid; place-items: center; }
    .thumbnail img { width: 100%; height: 100%; }
    .thumbnail svg { width: 60%; height: 60%; fill: none; stroke: currentColor; stroke-width: 1.5; opacity: .35; }
    .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .name.other { font-style: italic; }
    .row.hidden .thumbnail, .row.hidden .name { opacity: .45; }
    .check {
        flex: none; width: 18px; height: 18px; padding: 0; border: none; background: none; cursor: pointer;
        color: var(--vscode-descriptionForeground); display: grid; place-items: center;
    }
    .check svg { width: 16px; height: 16px; }
    .row:not(.hidden) .check { color: var(--vscode-button-background, var(--vscode-focusBorder)); }
    .empty { padding: 8px 12px; color: var(--vscode-descriptionForeground); }
    /* Sections, like Cadova Viewer's sidebar: parts, then measurements */
    .heading {
        padding: 10px 12px 4px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em;
        color: var(--vscode-descriptionForeground);
    }
    #measurements { padding: 0 8px 8px; display: flex; flex-direction: column; gap: 6px; }
    #measurements[hidden] { display: none; }
    .measurement {
        position: relative; padding: 8px 10px; border-radius: 8px; border: 2px solid var(--measurement);
        background: var(--vscode-editorWidget-background, rgba(128, 128, 128, .1));
        font-variant-numeric: tabular-nums; display: grid; grid-template-columns: 16px repeat(3, 1fr); gap: 4px 2px;
        align-items: center; text-align: center;
    }
    .measurement .label { color: var(--vscode-descriptionForeground); text-align: left; font-weight: 600; }
    .measurement .axis { color: var(--vscode-descriptionForeground); font-size: 10.5px; }
    .measurement .value { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; user-select: text; }
    .measurement .rule { grid-column: 1 / -1; height: 1px; background: var(--vscode-widget-border, rgba(128, 128, 128, .3)); margin: 2px 0; }
    .measurement .length { grid-column: 1 / -1; }
    .measurement .length span:first-child { color: var(--vscode-descriptionForeground); margin-right: 6px; }
    .measurement .delete {
        position: absolute; top: 2px; right: 2px; width: 22px; height: 22px; padding: 0; border: none; background: none;
        color: var(--vscode-descriptionForeground); cursor: pointer; display: grid; place-items: center; border-radius: 4px;
    }
    .measurement .delete:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
    /* Held down, like a native control, darker in a light theme and lighter in a dark one */
    .measurement .delete.pressed {
        background-color: var(--vscode-toolbar-hoverBackground);
        background-image: linear-gradient(color-mix(in srgb, currentColor 18%, transparent), color-mix(in srgb, currentColor 18%, transparent));
    }
</style>
</head>
<body class="${this.iconSize}">
<div class="heading" id="parts-heading">Parts</div>
<div id="list" tabindex="0" role="listbox" aria-multiselectable="true" aria-label="Parts"></div>
<div class="heading" id="measurements-heading" hidden>Measurements</div>
<div id="measurements" hidden></div>
<script nonce="${nonce}" src="${webview.asWebviewUri(script)}"></script>
</body>
</html>`;
    }
}
