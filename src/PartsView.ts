import * as vscode from "vscode";
import * as path from "node:path";
import type { ModelPart, PreviewEditorProvider } from "./PreviewEditorProvider";

/**
 * The Model Parts view in the sidebar: the parts of the model in the active preview, each with a
 * checkbox that shows or hides it, as in Cadova Viewer's sidebar. Clicking a part outlines it.
 */
export class PartsView implements vscode.TreeDataProvider<ModelPart>, vscode.Disposable {
    static readonly viewID = "cadova.parts";

    private readonly treeChange = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.treeChange.event;
    private readonly view: vscode.TreeView<ModelPart>;
    private readonly disposables: vscode.Disposable[];

    constructor(private readonly preview: PreviewEditorProvider) {
        this.view = vscode.window.createTreeView(PartsView.viewID, {
            treeDataProvider: this, manageCheckboxStateManually: true, showCollapseAll: false,
        });
        this.disposables = [
            this.view,
            this.treeChange,
            preview.onDidChangeActiveParts(() => this.refresh()),
            this.view.onDidChangeCheckboxState(({ items }) => {
                const hidden = new Set(this.hidden);
                for (const [part, state] of items) {
                    if (state === vscode.TreeItemCheckboxState.Checked) hidden.delete(part.id);
                    else hidden.add(part.id);
                }
                preview.setHiddenParts([...hidden]);
            }),
            vscode.commands.registerCommand("cadova.highlightPart", (part: ModelPart) => preview.highlightPart(part.id)),
            vscode.commands.registerCommand("cadova.showOnlyPart", (part: ModelPart) => {
                preview.setHiddenParts(this.parts.map((other) => other.id).filter((id) => id !== part.id));
            }),
            vscode.commands.registerCommand("cadova.showAllParts", () => preview.setHiddenParts([])),
            vscode.commands.registerCommand("cadova.hideAllParts", () => preview.setHiddenParts(this.parts.map((part) => part.id))),
        ];
        this.refresh();
    }

    getChildren(element?: ModelPart): ModelPart[] {
        return element ? [] : this.parts;
    }

    getTreeItem(part: ModelPart): vscode.TreeItem {
        const item = new vscode.TreeItem(part.name, vscode.TreeItemCollapsibleState.None);
        item.id = part.id;
        item.checkboxState = this.hidden.includes(part.id)
            ? vscode.TreeItemCheckboxState.Unchecked : vscode.TreeItemCheckboxState.Checked;
        // Parts that aren't printed, such as context, say so
        if (part.semantic !== "solid") item.description = part.semantic;
        item.tooltip = part.name === part.id ? part.name : `${part.name} (${part.id})`;
        item.command = { command: "cadova.highlightPart", title: "Highlight Part", arguments: [part] };
        item.contextValue = "part";
        return item;
    }

    dispose() {
        this.disposables.forEach((disposable) => disposable.dispose());
    }

    private get parts(): ModelPart[] {
        return this.preview.activeParts?.parts ?? [];
    }

    private get hidden(): string[] {
        return this.preview.activeParts?.hidden ?? [];
    }

    private refresh() {
        const file = this.preview.activeParts?.file;
        this.view.description = file ? path.basename(file.fsPath, path.extname(file.fsPath)) : undefined;
        vscode.commands.executeCommand("setContext", "cadova.hasHiddenParts", this.hidden.length > 0);
        this.treeChange.fire();
    }
}
