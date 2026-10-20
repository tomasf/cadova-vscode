import * as path from "node:path";
import * as fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

interface PackageDescription {
    products: { name: string; type: Record<string, unknown>; targets: string[] }[];
    targets: { name: string; path: string; type: string }[];
}

/** A Swift package on disk, and the executables Cadova models are built by. */
export class SwiftPackage {
    // Descriptions are slow to get, so they're kept until the manifest changes
    private static descriptions = new Map<string, Promise<PackageDescription>>();

    private constructor(readonly root: string) {}

    /** The innermost package that contains the file, if any. */
    static async containing(filePath: string): Promise<SwiftPackage | undefined> {
        let directory = path.dirname(filePath);
        while (true) {
            try {
                await fs.access(path.join(directory, "Package.swift"));
                return new SwiftPackage(directory);
            } catch {
                const parent = path.dirname(directory);
                if (parent === directory) return undefined;
                directory = parent;
            }
        }
    }

    contains(filePath: string): boolean {
        const relative = path.relative(this.root, filePath);
        return !relative.startsWith("..") && !path.isAbsolute(relative);
    }

    /**
     * The name a model's `--model` filter knows it by, from where its file was written: its path under
     * the package's `Models` directory, without the extension. Undefined for a file somewhere else.
     */
    filterName(modelFilePath: string): string | undefined {
        const relative = path.relative(path.join(this.root, "Models"), modelFilePath);
        if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
        return relative.slice(0, relative.length - path.extname(relative).length).split(path.sep).join("/");
    }

    static forgetDescription(root: string) {
        SwiftPackage.descriptions.delete(root);
    }

    /**
     * The executable product that builds the file: the one its target belongs to, or the package's only
     * executable if the file isn't in an executable target.
     */
    async executableProduct(filePath: string, swiftPath: string): Promise<string> {
        const description = await this.description(swiftPath);
        const executables = description.products.filter((product) => "executable" in product.type);
        const target = description.targets.find((target) => {
            const relative = path.relative(path.join(this.root, target.path), filePath);
            return !relative.startsWith("..") && !path.isAbsolute(relative);
        });
        // A file outside every target, such as a model file, is built by the package's only executable
        const product = target
            ? executables.find((product) => product.targets.includes(target.name))
            : executables.length === 1 ? executables[0] : undefined;
        if (!product) {
            throw new Error(executables.length === 0
                ? "The package has no executable product to build models with."
                : `Couldn't tell which executable builds ${path.basename(filePath)}.`);
        }
        return product.name;
    }

    private description(swiftPath: string): Promise<PackageDescription> {
        let description = SwiftPackage.descriptions.get(this.root);
        if (!description) {
            description = promisify(execFile)(swiftPath, ["package", "describe", "--type", "json"], {
                cwd: this.root, maxBuffer: 64 * 1024 * 1024,
            }).then(({ stdout }) => JSON.parse(stdout.slice(stdout.indexOf("{"))) as PackageDescription);
            description.catch(() => SwiftPackage.descriptions.delete(this.root));
            SwiftPackage.descriptions.set(this.root, description);
        }
        return description;
    }
}
