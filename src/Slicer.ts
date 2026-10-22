import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";

/** A slicer found installed, by the name it's known by and what opens it. */
interface FoundSlicer {
    name: string;
    path: string;
}

/** Where a slicer is usually installed on each platform. */
interface KnownSlicer {
    name: string;
    /** App bundles, in /Applications or ~/Applications. */
    mac: string[];
    /** Executables under Program Files or the user's programs, where a `*` stands for a version in a folder's name. */
    windows: string[];
    /** Commands on the PATH, and Flatpak app IDs, whose launchers Flatpak puts in its exports. */
    linux: { commands: string[]; flatpaks: string[] };
}

/**
 * Opens models in the user's slicer, as Cadova Viewer's Slice does. The slicer is chosen once, from
 * the ones found in their usual places or by browsing for one, and remembered in the `cadova.slicer`
 * setting. Where they're installed is a best guess per platform; browsing covers the rest.
 */
export class Slicer {
    private static readonly known: KnownSlicer[] = [
        {
            name: "PrusaSlicer", mac: ["PrusaSlicer.app"], windows: ["Prusa3D/PrusaSlicer/prusa-slicer.exe"],
            linux: { commands: ["prusa-slicer", "PrusaSlicer"], flatpaks: ["com.prusa3d.PrusaSlicer"] },
        },
        {
            name: "Bambu Studio", mac: ["BambuStudio.app", "Bambu Studio.app"], windows: ["Bambu Studio/bambu-studio.exe"],
            linux: { commands: ["bambu-studio"], flatpaks: ["com.bambulab.BambuStudio"] },
        },
        {
            name: "OrcaSlicer", mac: ["OrcaSlicer.app"], windows: ["OrcaSlicer/orca-slicer.exe"],
            linux: { commands: ["orca-slicer"], flatpaks: ["io.github.softfever.OrcaSlicer"] },
        },
        {
            name: "UltiMaker Cura", mac: ["UltiMaker Cura.app", "Ultimaker Cura.app"],
            windows: ["UltiMaker Cura */UltiMaker-Cura.exe", "Ultimaker Cura */Ultimaker-Cura.exe"],
            linux: { commands: ["cura", "UltiMaker-Cura"], flatpaks: ["com.ultimaker.cura"] },
        },
        {
            name: "SuperSlicer", mac: ["SuperSlicer.app"], windows: ["SuperSlicer/superslicer.exe"],
            linux: { commands: ["superslicer"], flatpaks: ["com.superslicer.SuperSlicer"] },
        },
    ];

    /**
     * Opens a model file in the chosen slicer, asking for one first if none is. In a remote window the
     * extension runs where the file is, away from the slicer, so it says so instead.
     */
    static async open(file: string) {
        if (vscode.env.remoteName) {
            vscode.window.showInformationMessage(
                "Slicing isn't available in remote windows yet, since the slicer is on your own computer and the model isn't.");
            return;
        }
        const slicer = Slicer.configured() ?? await Slicer.choose();
        if (!slicer) return;
        try {
            await Slicer.launch(slicer, file);
        } catch (error) {
            const choice = await vscode.window.showErrorMessage(
                `Couldn't open ${path.basename(slicer)}: ${(error as Error).message}`, "Choose Slicer…");
            if (choice) await Slicer.choose();
        }
    }

    /** Asks which slicer to use, from those found and by browsing, and remembers it. */
    static async choose(): Promise<string | undefined> {
        const found = await Slicer.detect();
        const browse = { label: "$(folder-opened) Browse…", path: undefined };
        const pick = await vscode.window.showQuickPick(
            [...found.map((slicer) => ({ label: slicer.name, description: slicer.path, path: slicer.path as string | undefined })), browse],
            { title: "Choose a Slicer", placeHolder: found.length ? "Slicers found on this computer" : "No slicers found in the usual places" },
        );
        if (!pick) return undefined;
        const chosen = pick.path ?? await Slicer.browse();
        if (!chosen) return undefined;
        await vscode.workspace.getConfiguration("cadova").update("slicer", chosen, vscode.ConfigurationTarget.Global);
        return chosen;
    }

    private static configured(): string | undefined {
        return vscode.workspace.getConfiguration("cadova").get<string>("slicer")?.trim() || undefined;
    }

    private static async browse(): Promise<string | undefined> {
        const mac = process.platform === "darwin";
        const picked = await vscode.window.showOpenDialog({
            title: "Choose a Slicer",
            openLabel: "Choose",
            defaultUri: vscode.Uri.file(mac ? "/Applications" : process.platform === "win32" ? process.env.ProgramFiles ?? os.homedir() : "/usr/bin"),
            // An app on a Mac is a folder
            canSelectFiles: true, canSelectFolders: mac, canSelectMany: false,
            filters: process.platform === "win32" ? { Programs: ["exe"] } : undefined,
        });
        return picked?.[0]?.fsPath;
    }

    /** The known slicers installed in their usual places on this computer. */
    private static async detect(): Promise<FoundSlicer[]> {
        const found: FoundSlicer[] = [];
        for (const slicer of Slicer.known) {
            const location = await Slicer.locate(slicer);
            if (location) found.push({ name: slicer.name, path: location });
        }
        return found;
    }

    private static async locate(slicer: KnownSlicer): Promise<string | undefined> {
        switch (process.platform) {
            case "darwin":
                return Slicer.firstExisting(["/Applications", path.join(os.homedir(), "Applications")]
                    .flatMap((folder) => slicer.mac.map((app) => path.join(folder, app))));
            case "win32": {
                const roots = [process.env.ProgramW6432, process.env.ProgramFiles, process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs")]
                    .filter((root): root is string => !!root);
                for (const pattern of slicer.windows) {
                    for (const root of new Set(roots)) {
                        const match = await Slicer.expand(root, pattern);
                        if (match) return match;
                    }
                }
                return undefined;
            }
            default: {
                const folders = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
                const exports = ["/var/lib/flatpak/exports/bin", path.join(os.homedir(), ".local/share/flatpak/exports/bin")];
                return Slicer.firstExisting([
                    ...slicer.linux.commands.flatMap((command) => folders.map((folder) => path.join(folder, command))),
                    ...slicer.linux.flatpaks.flatMap((id) => exports.map((folder) => path.join(folder, id))),
                ]);
            }
        }
    }

    // A path under a root, where a `*` in a folder's name matches any version of it, newest name last
    private static async expand(root: string, pattern: string): Promise<string | undefined> {
        let candidates = [root];
        for (const component of pattern.split("/")) {
            const next: string[] = [];
            for (const folder of candidates) {
                if (!component.includes("*")) {
                    next.push(path.join(folder, component));
                    continue;
                }
                const [prefix, suffix] = component.split("*");
                const names = await fs.readdir(folder).catch(() => [] as string[]);
                next.push(...names.filter((name) => name.startsWith(prefix) && name.endsWith(suffix)).sort().map((name) => path.join(folder, name)));
            }
            candidates = next;
        }
        return Slicer.firstExisting(candidates.reverse());
    }

    private static async firstExisting(paths: string[]): Promise<string | undefined> {
        for (const candidate of paths) {
            if (await fs.access(candidate).then(() => true, () => false)) return candidate;
        }
        return undefined;
    }

    /**
     * Starts the slicer with the file, on its own so it outlives VS Code. A Mac app is opened the way
     * Finder would, which hands the file to it if it's already running.
     */
    private static launch(slicer: string, file: string): Promise<void> {
        const app = process.platform === "darwin" && slicer.replace(/\/+$/, "").endsWith(".app");
        const child = app
            ? spawn("open", ["-a", slicer, file], { stdio: ["ignore", "ignore", "pipe"] })
            : spawn(slicer, [file], { detached: true, stdio: "ignore" });
        return new Promise((resolve, reject) => {
            child.once("error", reject);
            if (app) {
                // `open` returns once the app has the file, and says why when it can't
                let message = "";
                child.stderr?.on("data", (data) => { message += data; });
                child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(message.trim() || `open exited with ${code}`)));
            } else {
                child.once("spawn", () => {
                    child.unref();
                    resolve();
                });
            }
        });
    }
}
