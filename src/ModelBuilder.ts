import * as vscode from "vscode";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { SwiftPackage } from "./SwiftPackage";

export interface BuildRequest {
    /** The Swift file the model or project is declared in. */
    file: vscode.Uri;
    /** The models to build, by their filter names, or undefined to build everything the executable builds. */
    filterNames?: string[];
}

/** What a build is doing: compiling the package, or running it to generate the models. */
export type BuildPhase = "building" | "generating";

export type BuildResult =
    | { outcome: "succeeded"; written: string[] }
    | { outcome: "failed" }
    /** Stopped for a newer build of the same package. */
    | { outcome: "replaced" };

/** Builds models by running the package's executable, and reports the files it wrote. */
export class ModelBuilder implements vscode.Disposable {
    // One build per package at a time; starting another stops the one before
    private readonly running = new Map<string, ChildProcess>();
    // Saving before a build shouldn't count as the user saving, which can start a build of its own
    private savingDepth = 0;

    get isSavingDocuments(): boolean {
        return this.savingDepth > 0;
    }

    constructor(private readonly output: vscode.OutputChannel) {}

    /** Builds the request, telling `onPhase` when it moves from compiling to generating. */
    async build(request: BuildRequest, onPhase?: (phase: BuildPhase) => void): Promise<BuildResult> {
        const configuration = vscode.workspace.getConfiguration("cadova", request.file);
        const swiftPath = configuration.get<string>("swiftPath", "swift");
        const buildConfiguration = configuration.get<string>("buildConfiguration", "debug");
        const label = request.filterNames?.join(", ") ?? path.basename(request.file.fsPath);

        const swiftPackage = await SwiftPackage.containing(request.file.fsPath);
        if (!swiftPackage) {
            vscode.window.showErrorMessage(`${path.basename(request.file.fsPath)} isn't part of a Swift package.`);
            return { outcome: "failed" };
        }
        await this.saveDocuments(swiftPackage);

        return vscode.window.withProgress({
            location: vscode.ProgressLocation.Window,
            title: `$(loading~spin) Building ${label}`,
        }, async () => {
            let product: string;
            try {
                product = await swiftPackage.executableProduct(request.file.fsPath, swiftPath);
            } catch (error) {
                vscode.window.showErrorMessage(`Cadova: ${(error as Error).message}`);
                return { outcome: "failed" } as const;
            }
            const args = ["run", "-c", buildConfiguration, product];
            for (const name of request.filterNames ?? []) args.push("--model", name);
            return this.run(swiftPath, args, swiftPackage.root, label, onPhase);
        });
    }

    private run(
        swiftPath: string, args: string[], root: string, label: string, onPhase?: (phase: BuildPhase) => void,
    ): Promise<BuildResult> {
        this.running.get(root)?.kill();
        this.output.appendLine(`\n> ${swiftPath} ${args.join(" ")}    (in ${root})`);

        const child = spawn(swiftPath, args, {
            cwd: root,
            env: { CADOVA_LOG_LEVEL: "info", ...process.env },
        });
        this.running.set(root, child);

        const written: string[] = [];
        let generating = false;
        const handle = (stream: NodeJS.ReadableStream) => {
            let buffered = "";
            stream.setEncoding("utf8");
            stream.on("data", (chunk: string) => {
                buffered += chunk;
                const lines = buffered.split("\n");
                buffered = lines.pop() ?? "";
                for (const line of lines) {
                    this.output.appendLine(line);
                    // Cadova logs this as each model starts, once the package is compiled and running
                    if (!generating && line.endsWith(" Generating...")) {
                        generating = true;
                        onPhase?.("generating");
                    }
                    const match = /Wrote model to (.+)$/.exec(line);
                    if (match) written.push(match[1].trim());
                }
            });
            stream.on("end", () => { if (buffered) this.output.appendLine(buffered); });
        };
        handle(child.stdout);
        handle(child.stderr);

        return new Promise((resolve) => {
            child.on("error", (error) => {
                this.output.appendLine(String(error));
                this.reportFailure(`Couldn't run ${swiftPath}: ${error.message}`);
                resolve({ outcome: "failed" });
            });
            child.on("close", (code, signal) => {
                const replaced = this.running.get(root) !== child;
                if (!replaced) this.running.delete(root);
                if (replaced) {
                    resolve({ outcome: "replaced" });
                } else if (code !== 0 || signal) {
                    this.reportFailure(`Building ${label} failed.`);
                    resolve({ outcome: "failed" });
                } else {
                    if (written.length === 0) vscode.window.showWarningMessage(`Building ${label} wrote no model files.`);
                    resolve({ outcome: "succeeded", written });
                }
            });
        });
    }

    // The build runs what's on disk, so unsaved edits to the package's Swift files are saved first
    private async saveDocuments(swiftPackage: SwiftPackage) {
        this.savingDepth++;
        try {
            await Promise.all(vscode.workspace.textDocuments
                .filter((document) => document.isDirty && document.languageId === "swift"
                    && swiftPackage.contains(document.uri.fsPath))
                .map((document) => document.save()));
        } finally {
            this.savingDepth--;
        }
    }

    private async reportFailure(message: string) {
        const choice = await vscode.window.showErrorMessage(message, "Show Output");
        if (choice) this.output.show(true);
    }

    dispose() {
        for (const child of this.running.values()) child.kill();
        this.running.clear();
    }
}
