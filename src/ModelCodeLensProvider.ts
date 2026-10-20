import * as vscode from "vscode";
import { SwiftModelScanner } from "./SwiftModelScanner";
import type { BuildRequest } from "./ModelBuilder";

/** Shows build actions above each model and project in Swift files that import Cadova. */
export class ModelCodeLensProvider implements vscode.CodeLensProvider {
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeCodeLenses = this.changeEmitter.event;

    refresh() {
        this.changeEmitter.fire();
    }

    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        if (!vscode.workspace.getConfiguration("cadova", document).get("codeLens", true)) return [];
        const text = document.getText();
        if (!/^\s*(@[\w()]+\s+)*import\s+Cadova\b/m.test(text)) return [];

        return SwiftModelScanner.scan(text).flatMap((declaration) => {
            const position = document.positionAt(declaration.offset);
            const range = new vscode.Range(position, position);
            const request: BuildRequest = {
                file: document.uri, filterNames: declaration.filterName ? [declaration.filterName] : undefined,
            };
            const what = declaration.kind === "project" ? "All" : "";
            return [
                new vscode.CodeLens(range, {
                    title: `$(play) Build ${what}`.trimEnd(),
                    tooltip: declaration.filterName ? `Build ${declaration.filterName}` : "Build every model in the project",
                    command: "cadova.buildModel",
                    arguments: [request],
                }),
                new vscode.CodeLens(range, {
                    title: `$(eye) Preview ${what}`.trimEnd(),
                    tooltip: "Build, then show the result beside the code",
                    command: "cadova.buildAndPreviewModel",
                    arguments: [request],
                }),
            ];
        });
    }
}
