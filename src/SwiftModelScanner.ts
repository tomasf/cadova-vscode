/** A `Model`, `Group` or `Project` found in Swift source, which can be built on its own. */
export interface ModelDeclaration {
    kind: "model" | "group" | "project";
    /** Where the declaration's keyword starts, as an offset into the source. */
    offset: number;
    /**
     * The name Cadova's `--model` filter knows the model by: its own name, after the names of any
     * groups it's in. Absent for a project, which builds all of its models.
     */
    filterName?: string;
    /** A group's own name, if it has one. */
    name?: string;
    /**
     * The filter names of the models in a group, which build it: Cadova's filter takes model names,
     * not group names.
     */
    filterNames?: string[];
}

interface GroupScope {
    name: string | null;
    braceDepth: number;
    // The group's own declaration, unless its name is only known when it runs
    declaration: ModelDeclaration | null;
}

/**
 * Finds `Model`s, `Group`s and `Project`s in Swift source without parsing it, by skipping comments and
 * string literals and following braces, so that a model inside `Group("name") { … }` gets the group's
 * name too. A model whose name isn't a plain string literal is left out, since its name is only known
 * when it runs, and so is a group with such a model in it, which its models' names can't build whole.
 */
export class SwiftModelScanner {
    private index = 0;
    private braceDepth = 0;
    private parenDepth = 0;
    private groups: GroupScope[] = [];
    // A group whose body is the next brace opened at this paren depth
    private pendingGroup: { name: string | null; offset: number; parenDepth: number } | null = null;
    private declarations: ModelDeclaration[] = [];
    // Groups that can't be built by their models' names, for a model in them whose name isn't known
    private readonly unbuildableGroups = new Set<ModelDeclaration>();

    private constructor(private readonly source: string) {}

    static scan(source: string): ModelDeclaration[] {
        const scanner = new SwiftModelScanner(source);
        scanner.scanCode(null);
        return scanner.declarations.filter((declaration) => declaration.kind !== "group"
            || (!scanner.unbuildableGroups.has(declaration) && declaration.filterNames!.length > 0));
    }

    /** Scans code until the given character closes it at this level, or until the end of the source. */
    private scanCode(terminator: string | null) {
        const source = this.source;
        let nesting = 0;
        while (this.index < source.length) {
            const char = source[this.index];
            const next = source[this.index + 1];

            if (char === "/" && next === "/") {
                const end = source.indexOf("\n", this.index);
                this.index = end < 0 ? source.length : end + 1;
            } else if (char === "/" && next === "*") {
                this.skipBlockComment();
            } else if (char === '"' || (char === "#" && /[#"]/.test(next ?? ""))) {
                this.readStringLiteral();
            } else if (char === "(") {
                nesting++;
                this.parenDepth++;
                this.index++;
            } else if (char === ")") {
                if (terminator === ")" && nesting === 0) {
                    this.index++;
                    return;
                }
                nesting--;
                this.parenDepth--;
                this.index++;
            } else if (char === "{") {
                this.openBrace();
                this.index++;
            } else if (char === "}") {
                this.closeBrace();
                this.index++;
            } else if (/[A-Za-z_]/.test(char)) {
                this.readIdentifier();
            } else {
                this.index++;
            }
        }
    }

    private openBrace() {
        if (this.pendingGroup && this.pendingGroup.parenDepth === this.parenDepth) {
            const { name, offset } = this.pendingGroup;
            const declaration: ModelDeclaration | null = name === "\0" ? null
                : { kind: "group", offset, name: name ?? undefined, filterNames: [] };
            if (declaration) this.declarations.push(declaration);
            this.groups.push({ name, braceDepth: this.braceDepth, declaration });
            this.pendingGroup = null;
        }
        this.braceDepth++;
    }

    private closeBrace() {
        this.braceDepth = Math.max(0, this.braceDepth - 1);
        const innermost = this.groups.at(-1);
        if (innermost && innermost.braceDepth === this.braceDepth) this.groups.pop();
    }

    private skipBlockComment() {
        let depth = 0;
        const source = this.source;
        while (this.index < source.length) {
            if (source.startsWith("/*", this.index)) {
                depth++;
                this.index += 2;
            } else if (source.startsWith("*/", this.index)) {
                depth--;
                this.index += 2;
                if (depth === 0) return;
            } else {
                this.index++;
            }
        }
    }

    private readIdentifier() {
        const source = this.source;
        const start = this.index;
        while (this.index < source.length && /[A-Za-z0-9_]/.test(source[this.index])) this.index++;
        const identifier = source.slice(start, this.index);
        if (identifier !== "Model" && identifier !== "Group" && identifier !== "Project") return;

        // Only a call of the type itself, not a member or a longer name
        const before = source.slice(0, start).trimEnd().at(-1);
        if (before === "." || before === "@") return;
        const afterName = this.skipWhitespace(this.index);
        const opener = source[afterName];
        if (opener !== "(" && !(identifier !== "Model" && opener === "{")) return;

        const firstArgument = opener === "(" ? this.peekStringLiteral(this.skipWhitespace(afterName + 1)) : undefined;
        const groupPath = this.groups.flatMap((group) => (group.name ? [group.name] : []));

        switch (identifier) {
            case "Model":
                if (typeof firstArgument === "string" && !groupPath.includes("\0")) {
                    const filterName = [...groupPath, firstArgument].join("/");
                    this.declarations.push({ kind: "model", offset: start, filterName });
                    for (const group of this.groups) group.declaration?.filterNames!.push(filterName);
                } else {
                    for (const group of this.groups) if (group.declaration) this.unbuildableGroups.add(group.declaration);
                }
                break;
            case "Project":
                this.declarations.push({ kind: "project", offset: start });
                break;
            case "Group":
                // A group whose name is only known at runtime makes the names of the models in it unknown too,
                // so it's recorded under a name no model filter can match
                this.pendingGroup = {
                    name: firstArgument === undefined ? null : firstArgument ?? "\0",
                    offset: start,
                    parenDepth: this.parenDepth,
                };
                break;
        }
    }

    private skipWhitespace(index: number): number {
        while (index < this.source.length && /\s/.test(this.source[index])) index++;
        return index;
    }

    /**
     * The value of the string literal at the index, without moving past it: a string for a plain literal,
     * null for one with interpolations, or undefined when there's no literal there.
     */
    private peekStringLiteral(index: number): string | null | undefined {
        const char = this.source[index];
        if (char !== '"' && char !== "#") return undefined;
        const saved = this.index;
        this.index = index;
        const value = this.readStringLiteral();
        this.index = saved;
        return value;
    }

    /** Reads past the string literal at the current index, returning its value, or null if it's interpolated. */
    private readStringLiteral(): string | null {
        const source = this.source;
        let hashes = 0;
        while (source[this.index] === "#") {
            hashes++;
            this.index++;
        }
        if (source[this.index] !== '"') return null;

        const multiline = source.startsWith('"""', this.index);
        const delimiter = (multiline ? '"""' : '"') + "#".repeat(hashes);
        const escape = "\\" + "#".repeat(hashes);
        this.index += multiline ? 3 : 1;

        let value = "";
        let interpolated = false;
        while (this.index < source.length) {
            if (source.startsWith(delimiter, this.index)) {
                this.index += delimiter.length;
                return interpolated || multiline ? null : value;
            }
            if (!multiline && source[this.index] === "\n") return null;
            if (source.startsWith(escape, this.index)) {
                this.index += escape.length;
                const escaped = source[this.index];
                if (escaped === "(") {
                    interpolated = true;
                    this.index++;
                    this.scanInterpolation();
                } else {
                    value += ({ n: "\n", t: "\t", "0": "\0", r: "\r" } as Record<string, string>)[escaped] ?? escaped;
                    this.index++;
                }
                continue;
            }
            value += source[this.index];
            this.index++;
        }
        return null;
    }

    // An interpolation is code, but its braces and parens don't belong to the code around the string
    private scanInterpolation() {
        const { braceDepth, parenDepth, groups, pendingGroup, declarations } = this;
        this.groups = [];
        this.declarations = [];
        this.scanCode(")");
        Object.assign(this, { braceDepth, parenDepth, groups, pendingGroup, declarations });
    }
}
