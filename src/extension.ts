import * as vscode from "vscode";
import * as path from "node:path";
import { ModelBuilder, type BuildRequest } from "./ModelBuilder";
import { PreviewBuilds } from "./PreviewBuilds";
import { ModelCodeLensProvider } from "./ModelCodeLensProvider";
import { PreviewEditorProvider } from "./PreviewEditorProvider";
import { PartsView } from "./PartsView";
import { SwiftPackage } from "./SwiftPackage";

export function activate(context: vscode.ExtensionContext) {
    const output = vscode.window.createOutputChannel("Cadova");
    const builder = new ModelBuilder(output);
    const preview = PreviewEditorProvider.register(context);
    const previewBuilds = new PreviewBuilds(builder, preview);
    const codeLenses = new ModelCodeLensProvider();

    const manifestWatcher = vscode.workspace.createFileSystemWatcher("**/Package.swift");
    const forgetManifest = (uri: vscode.Uri) => SwiftPackage.forgetDescription(path.dirname(uri.fsPath));

    context.subscriptions.push(
        output,
        builder,
        previewBuilds,
        new PartsView(context.extensionUri, context.globalState, preview),
        manifestWatcher,
        manifestWatcher.onDidChange(forgetManifest),
        manifestWatcher.onDidCreate(forgetManifest),
        manifestWatcher.onDidDelete(forgetManifest),
        vscode.languages.registerCodeLensProvider({ language: "swift", scheme: "file" }, codeLenses),
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration("cadova.codeLens")) codeLenses.refresh();
        }),

        vscode.commands.registerCommand("cadova.buildModel", (request: BuildRequest) => previewBuilds.build(request)),
        vscode.commands.registerCommand("cadova.buildAndPreviewModel", (request: BuildRequest) => previewBuilds.buildAndPreview(request)),
        vscode.commands.registerCommand("cadova.rebuildPreview", () => previewBuilds.rebuildActive()),
    );
}

export function deactivate() {}
