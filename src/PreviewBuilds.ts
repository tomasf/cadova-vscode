import * as vscode from "vscode";
import { ModelBuilder, type BuildRequest, type BuildResult } from "./ModelBuilder";
import { PreviewEditorProvider } from "./PreviewEditorProvider";
import { SwiftPackage } from "./SwiftPackage";

/**
 * Connects builds to the previews that show them: opens what a build wrote, and rebuilds the models
 * that are being previewed, on request or whenever a Swift file in their package is saved.
 */
export class PreviewBuilds implements vscode.Disposable {
    // How each previewed model file was last built, so it can be built the same way again
    private readonly sources = new Map<string, BuildRequest>();
    private readonly disposables: vscode.Disposable[] = [];
    private saveTimer: NodeJS.Timeout | undefined;
    private readonly savedFiles = new Set<string>();
    // The build each previewed model file is waiting on, while one runs
    private readonly running = new Map<string, Promise<BuildResult>>();

    constructor(private readonly builder: ModelBuilder, private readonly previews: PreviewEditorProvider) {
        this.disposables.push(vscode.workspace.onDidSaveTextDocument((document) => this.documentSaved(document)));
    }

    /** Builds the request, then shows every model file it wrote, each in a tab of its own. */
    async buildAndPreview(request: BuildRequest) {
        const result = await this.build(request);
        if (result.outcome !== "succeeded") return;
        const models = result.written.filter((file) => file.toLowerCase().endsWith(".3mf"));
        if (models.length) await this.previews.showAll(models.map((file) => vscode.Uri.file(file)));
    }

    /**
     * Builds the request, remembering how each file it wrote was made. Previews of the models it
     * builds show how it's going, and load the new models when it's done.
     */
    async build(request: BuildRequest, previewedFiles?: string[]): Promise<BuildResult> {
        const files = previewedFiles ?? await this.previewedFiles(request);
        for (const file of files) this.previews.setStatus(file, "building");
        const build = this.builder.build(request, (phase) => {
            for (const file of files) this.previews.setStatus(file, phase);
        });
        for (const file of files) this.running.set(file, build);
        const result = await build;
        for (const file of files) {
            if (this.running.get(file) === build) this.running.delete(file);
        }

        switch (result.outcome) {
            case "succeeded":
                for (const file of result.written) {
                    // A file from a build of several models is rebuilt on its own
                    const filterName = (await SwiftPackage.containing(file))?.filterName(file);
                    const single = request.filterNames?.length === 1 ? request.filterNames : undefined;
                    this.sources.set(file, { file: request.file, filterNames: single ?? (filterName ? [filterName] : undefined) });
                }
                for (const file of files) {
                    if (result.written.includes(file)) this.previews.reload(file);
                    else this.previews.setStatus(file, "idle");
                }
                break;
            case "failed":
                for (const file of files) this.previews.setStatus(file, "failed");
                break;
            case "replaced":
                // The build that replaced it shows its own progress
                break;
        }
        return result;
    }

    /** Waits until no build started here is writing the model file, including any that replace one. */
    async settled(file: string) {
        while (this.running.has(file)) await this.running.get(file);
    }

    /** Rebuilds the model shown in the active preview. */
    async rebuildActive() {
        const file = this.previews.activeModelFile;
        if (file) await this.rebuild([file]);
    }

    /**
     * Rebuilds the model files, a build per package. Models previewed without being built here are
     * found by where they were written, or else the whole package is built.
     */
    private async rebuild(modelFiles: string[]) {
        const byPackage = new Map<string, { swiftPackage: SwiftPackage; files: string[] }>();
        for (const file of modelFiles) {
            const swiftPackage = await SwiftPackage.containing(file);
            if (!swiftPackage) continue;
            const entry = byPackage.get(swiftPackage.root) ?? { swiftPackage, files: [] };
            entry.files.push(file);
            byPackage.set(swiftPackage.root, entry);
        }

        await Promise.all([...byPackage.values()].map(async ({ swiftPackage, files }) => {
            const requests = files.map((file) => this.source(file, swiftPackage));
            // One model of unknown name means building them all
            const filterNames = requests.some((request) => !request.filterNames?.length)
                ? undefined
                : [...new Set(requests.flatMap((request) => request.filterNames!))];
            await this.build({ file: requests[0].file, filterNames }, files);
        }));
    }

    /** How a model file was built, or else how it would be, judging by where it was written. */
    private source(file: string, swiftPackage: SwiftPackage): BuildRequest {
        const filterName = swiftPackage.filterName(file);
        return this.sources.get(file) ?? { file: vscode.Uri.file(file), filterNames: filterName ? [filterName] : undefined };
    }

    /** The previewed model files that a build of the request can write. */
    private async previewedFiles(request: BuildRequest): Promise<string[]> {
        const swiftPackage = await SwiftPackage.containing(request.file.fsPath);
        if (!swiftPackage) return [];
        return this.previews.openModelFiles.filter((file) => {
            if (!swiftPackage.contains(file)) return false;
            if (!request.filterNames) return true;
            const names = this.source(file, swiftPackage).filterNames;
            return !names || names.some((name) => request.filterNames!.includes(name));
        });
    }

    // Saving several files at once, such as with Save All, rebuilds once
    private documentSaved(document: vscode.TextDocument) {
        if (document.languageId !== "swift" || this.builder.isSavingDocuments) return;
        if (!vscode.workspace.getConfiguration("cadova", document).get("rebuildOnSave", true)) return;
        this.savedFiles.add(document.uri.fsPath);
        clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => this.rebuildForSavedFiles(), 200);
    }

    private async rebuildForSavedFiles() {
        const saved = [...this.savedFiles];
        this.savedFiles.clear();
        const packages = new Map<string, SwiftPackage>();
        for (const file of saved) {
            const swiftPackage = await SwiftPackage.containing(file);
            if (swiftPackage) packages.set(swiftPackage.root, swiftPackage);
        }
        const previewed = this.previews.openModelFiles.filter((file) =>
            [...packages.values()].some((swiftPackage) => swiftPackage.contains(file)));
        if (previewed.length) await this.rebuild(previewed);
    }

    dispose() {
        clearTimeout(this.saveTimer);
        this.disposables.forEach((disposable) => disposable.dispose());
    }
}
