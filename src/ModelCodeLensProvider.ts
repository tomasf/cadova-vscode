import * as vscode from "vscode";
import { SwiftModelScanner } from "./SwiftModelScanner";
import type { BuildRequest } from "./ModelBuilder";

/** Shows Generate and Preview actions above each model, group and project in Swift files that import Cadova. */
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
            // A model by its name, a group by its models' names, and a project with no filter at all
            const request: BuildRequest = {
                file: document.uri,
                filterNames: declaration.filterNames ?? (declaration.filterName ? [declaration.filterName] : undefined),
            };
            const what = { model: "", group: "Group", project: "All" }[declaration.kind];
            const generateTooltip = {
                model: `Generate ${declaration.filterName}`,
                group: `Generate the ${declaration.filterNames?.length === 1 ? "model" : `${declaration.filterNames?.length} models`} in ${declaration.name ?? "this group"}`,
                project: "Generate every model in the project",
            }[declaration.kind];
            // Code lenses are drawn as web text, where spaces in a row collapse into one, so a wider
            // gap after the icon needs a non-breaking space
            const gap = "\u00A0";
            return [
                new vscode.CodeLens(range, {
                    title: `$(play)${gap}Generate ${what}`.trimEnd(),
                    tooltip: `${generateTooltip}, compiling the package first`,
                    command: "cadova.buildModel",
                    arguments: [request],
                }),
                new vscode.CodeLens(range, {
                    title: `$(eye)${gap}Preview ${what}`.trimEnd(),
                    tooltip: "Generate, then show the result beside the code",
                    command: "cadova.buildAndPreviewModel",
                    arguments: [request],
                }),
            ];
        });
    }
}
