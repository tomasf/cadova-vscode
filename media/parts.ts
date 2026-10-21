// The Model view in the sidebar, after Cadova Viewer's: a row for each part with its thumbnail, its
// name and a checkmark that shows or hides it, selecting like a VS Code list, and the measurements.

import { Palette } from "./Palette";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

interface Part {
    id: string;
    name: string;
    semantic: string;
}

interface Measurement {
    id: string;
    colorIndex: number;
    start: [number, number, number];
    end?: [number, number, number];
    phase: "coordinate" | "inProgress" | "complete";
}

type HostMessage =
    | { type: "state"; file?: string; parts: Part[]; hidden: string[]; iconSize: string; thumbnails: Record<string, string> }
    | { type: "thumbnails"; thumbnails: Record<string, string> }
    | { type: "iconSize"; size: string }
    | { type: "measurements"; measurements: Measurement[] };

const checkedIcon = `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M4.8 8.2l2.1 2.1 4.3-4.6" fill="none" stroke="var(--vscode-button-foreground, white)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const uncheckedIcon = `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>`;
const deleteIcon = `<svg viewBox="0 0 16 16" aria-hidden="true" width="14" height="14"><circle cx="8" cy="8" r="6.5" fill="currentColor"/><path d="M5.8 5.8l4.4 4.4 M10.2 5.8l-4.4 4.4" stroke="var(--vscode-editorWidget-background, #252526)" stroke-width="1.5" stroke-linecap="round"/></svg>`;
const placeholderIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z M4 7.5l8 4.5 8-4.5 M12 12v9"/></svg>`;

const vscode = acquireVsCodeApi();

class PartsList {
    private readonly vscode = vscode;
    private readonly element = document.getElementById("list")!;
    private file: string | undefined;
    private parts: Part[] = [];
    private hidden = new Set<string>();
    private thumbnails = new Map<string, string>();
    private selection = new Set<string>();
    // The row the keyboard is on, and the one a Shift-selection extends from
    private focused = -1;
    private anchor = -1;

    constructor() {
        window.addEventListener("message", ({ data }: MessageEvent<HostMessage>) => this.receive(data));
        this.element.addEventListener("keydown", (event) => this.key(event));
        this.element.addEventListener("pointerleave", () => this.vscode.postMessage({ type: "hover", id: null }));
        // A click on empty space below the rows clears the selection
        this.element.addEventListener("click", (event) => {
            if (event.target === this.element) this.select([]);
        });
        this.vscode.postMessage({ type: "ready" });
    }

    private receive(message: HostMessage) {
        switch (message.type) {
            case "state":
                // Another model, or the same one from another preview, starts with nothing selected
                if (message.file !== this.file) this.selection.clear();
                this.file = message.file;
                this.parts = message.parts;
                this.hidden = new Set(message.hidden);
                this.thumbnails = new Map(Object.entries(message.thumbnails));
                const ids = new Set(this.parts.map((part) => part.id));
                this.selection = new Set([...this.selection].filter((id) => ids.has(id)));
                this.focused = Math.min(this.focused, this.parts.length - 1);
                this.setIconSize(message.iconSize);
                this.render();
                this.reportSelection();
                break;
            case "thumbnails":
                for (const [id, url] of Object.entries(message.thumbnails)) {
                    this.thumbnails.set(id, url);
                    const holder = this.element.querySelector(`.row[data-id="${CSS.escape(id)}"] .thumbnail`);
                    if (holder) holder.innerHTML = `<img src="${url}" alt="">`;
                }
                break;
            case "iconSize":
                this.setIconSize(message.size);
                break;
        }
    }

    private setIconSize(size: string) {
        document.body.className = size === "small" ? "small" : "large";
    }

    private render() {
        if (this.parts.length === 0) {
            this.element.innerHTML = `<div class="empty">The model has no parts.</div>`;
            return;
        }
        this.element.replaceChildren(...this.parts.map((part, index) => this.row(part, index)));
    }

    private row(part: Part, index: number): HTMLElement {
        const visible = !this.hidden.has(part.id);
        const row = document.createElement("div");
        row.className = "row";
        row.classList.toggle("hidden", !visible);
        row.classList.toggle("selected", this.selection.has(part.id));
        row.classList.toggle("focused", index === this.focused);
        row.dataset.id = part.id;
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", String(this.selection.has(part.id)));
        // For VS Code's own right-click menu, whose commands act on this part or the selection
        row.dataset.vscodeContext = JSON.stringify({ webviewSection: "part", partId: part.id, preventDefaultContextMenuItems: true });
        row.title = part.semantic === "solid" ? part.name : `${part.name} (${part.semantic})`;

        const thumbnail = document.createElement("span");
        thumbnail.className = "thumbnail";
        const url = this.thumbnails.get(part.id);
        thumbnail.innerHTML = url ? `<img src="${url}" alt="">` : placeholderIcon;

        // Parts that aren't printed, such as context, are in italics, as in Cadova Viewer
        const name = Object.assign(document.createElement("span"), { className: "name", textContent: part.name });
        name.classList.toggle("other", part.semantic !== "solid");

        const check = document.createElement("button");
        check.className = "check";
        check.type = "button";
        check.tabIndex = -1;
        check.title = visible ? "Hide Part" : "Show Part";
        check.innerHTML = visible ? checkedIcon : uncheckedIcon;
        check.addEventListener("click", (event) => {
            event.stopPropagation();
            this.toggle(part.id, event.altKey);
        });
        check.addEventListener("dblclick", (event) => event.stopPropagation());

        row.append(thumbnail, name, check);
        row.addEventListener("pointerenter", () => this.vscode.postMessage({ type: "hover", id: part.id }));
        row.addEventListener("click", (event) => this.click(index, event));
        row.addEventListener("dblclick", () => this.frame(this.selection.has(part.id) ? [...this.selection] : [part.id]));
        row.addEventListener("contextmenu", () => {
            // Like a list in VS Code, right-clicking outside the selection selects that row
            if (!this.selection.has(part.id)) this.selectRange(index, index);
        });
        return row;
    }

    // Click selects a row, Command- or Control-click adds or removes one, Shift-click a range
    private click(index: number, event: MouseEvent) {
        this.element.focus();
        const id = this.parts[index].id;
        if (event.shiftKey && this.anchor >= 0) {
            this.focused = index;
            this.select(this.range(this.anchor, index));
        } else if (event.metaKey || event.ctrlKey) {
            const selection = new Set(this.selection);
            if (!selection.delete(id)) selection.add(id);
            this.anchor = this.focused = index;
            this.select([...selection]);
        } else {
            this.selectRange(index, index);
        }
    }

    private key(event: KeyboardEvent) {
        const count = this.parts.length;
        if (count === 0) return;
        const move = (index: number) => {
            index = Math.max(0, Math.min(count - 1, index));
            if (event.shiftKey && this.anchor >= 0) {
                this.focused = index;
                this.select(this.range(this.anchor, index));
            } else {
                this.selectRange(index, index);
            }
            this.element.querySelectorAll(".row")[index]?.scrollIntoView({ block: "nearest" });
        };
        const page = Math.max(1, Math.floor(this.element.clientHeight / (this.element.querySelector(".row")?.clientHeight ?? 1)) - 1);
        switch (event.key) {
            case "ArrowDown": move(this.focused + 1); break;
            case "ArrowUp": move(this.focused < 0 ? count - 1 : this.focused - 1); break;
            case "PageDown": move(this.focused + page); break;
            case "PageUp": move(this.focused - page); break;
            case "Home": move(0); break;
            case "End": move(count - 1); break;
            case " ": this.toggleSelected(); break;
            case "Enter": this.frame([...this.selection]); break;
            case "Escape": this.select([]); break;
            case "a":
                if (!(event.metaKey || event.ctrlKey)) return;
                this.select(this.parts.map((part) => part.id));
                break;
            default: return;
        }
        event.preventDefault();
    }

    private range(from: number, to: number): string[] {
        return this.parts.slice(Math.min(from, to), Math.max(from, to) + 1).map((part) => part.id);
    }

    private selectRange(from: number, to: number) {
        this.anchor = from;
        this.focused = to;
        this.select(this.range(from, to));
    }

    // Rows only change their look, so a double-click's second click lands on the same row as its first
    private select(ids: string[]) {
        this.selection = new Set(ids);
        this.element.querySelectorAll<HTMLElement>(".row").forEach((row, index) => {
            const selected = this.selection.has(row.dataset.id!);
            row.classList.toggle("selected", selected);
            row.classList.toggle("focused", index === this.focused);
            row.setAttribute("aria-selected", String(selected));
        });
        this.reportSelection();
    }

    private reportSelection() {
        this.vscode.postMessage({ type: "selection", ids: [...this.selection] });
    }

    private frame(ids: string[]) {
        if (ids.length > 0) this.vscode.postMessage({ type: "frame", ids });
    }

    /**
     * Shows or hides a part. With Option (Alt), as in Cadova Viewer, it shows only that part, or if it
     * already is the only one shown, shows all the others instead.
     */
    private toggle(id: string, exclusive: boolean) {
        const all = this.parts.map((part) => part.id);
        const visible = all.filter((other) => !this.hidden.has(other));
        let hidden: string[];
        if (exclusive) {
            hidden = visible.length === 1 && visible[0] === id ? [id] : all.filter((other) => other !== id);
        } else {
            hidden = this.hidden.has(id) ? [...this.hidden].filter((other) => other !== id) : [...this.hidden, id];
        }
        this.setHidden(hidden);
    }

    // Space shows or hides the selected parts: all of them shown if they're all hidden, else hidden
    private toggleSelected() {
        if (this.selection.size === 0) return;
        if (this.selection.size === 1) return this.toggle([...this.selection][0], false);
        const allHidden = [...this.selection].every((id) => this.hidden.has(id));
        const hidden = new Set(this.hidden);
        for (const id of this.selection) {
            if (allHidden) hidden.delete(id);
            else hidden.add(id);
        }
        this.setHidden([...hidden]);
    }

    // The preview decides; the list shows the change when the preview reports it back
    private setHidden(hidden: string[]) {
        this.vscode.postMessage({ type: "setHidden", hidden });
    }
}

/**
 * The measurements, after Cadova Viewer's sidebar: a card for each in its color with the coordinates
 * of its points, the difference between them and its length. Hovering one emphasizes it in the view.
 */
class MeasurementsList {
    private readonly element = document.getElementById("measurements")!;
    private readonly heading = document.getElementById("measurements-heading")!;
    private shown = "";
    // The count and the last one, and whether it has its end yet, to tell when one is added or finished
    private latest = "";

    constructor() {
        window.addEventListener("message", ({ data }: MessageEvent<HostMessage>) => {
            if (data.type === "measurements") this.render(data.measurements);
        });
        this.element.addEventListener("pointerleave", () => vscode.postMessage({ type: "hoverMeasurement", id: null }));
    }

    private render(measurements: Measurement[]) {
        const shown = JSON.stringify(measurements);
        if (shown === this.shown) return;
        this.shown = shown;
        this.element.hidden = this.heading.hidden = measurements.length === 0;
        this.element.replaceChildren(...measurements.map((measurement) => this.card(measurement)));

        // As in Cadova Viewer, the list scrolls to a measurement that's new, or that just got its end
        const last = measurements.at(-1);
        const latest = JSON.stringify([measurements.length, last?.id, !!last?.end]);
        if (latest !== this.latest && last) this.element.lastElementChild?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        this.latest = latest;
    }

    private card(measurement: Measurement): HTMLElement {
        const card = document.createElement("div");
        card.className = "measurement";
        card.style.setProperty("--measurement", Palette.css(measurement.colorIndex));
        card.dataset.vscodeContext = JSON.stringify({
            webviewSection: measurement.phase === "coordinate" ? "coordinate" : "measurement",
            measurementId: measurement.id, preventDefaultContextMenuItems: true,
        });
        const cell = (className: string, text: string) => Object.assign(document.createElement("span"), { className, textContent: text });
        const row = (label: string, point: number[]) => [cell("label", label), ...point.map((value) => cell("value", MeasurementsList.format(value)))];

        card.append(cell("label", ""), ...["X", "Y", "Z"].map((axis) => cell("axis", axis)), ...row("A", measurement.start));
        const end = measurement.end;
        if (end) {
            const delta = end.map((value, axis) => value - measurement.start[axis]);
            card.append(...row("B", end), cell("rule", ""), ...row("Δ", delta));
            const length = document.createElement("div");
            length.className = "length";
            length.append(cell("", "Length"), cell("value", MeasurementsList.format(Math.hypot(...delta))));
            card.append(length);
        }
        // The point under the pointer can't be deleted; it's only where the pointer is
        if (measurement.phase !== "coordinate") {
            const remove = document.createElement("button");
            remove.className = "delete";
            remove.title = "Delete Measurement (Option-click to delete all)";
            remove.innerHTML = deleteIcon;
            remove.addEventListener("click", (event) => {
                vscode.postMessage({ type: "deleteMeasurement", id: measurement.id, all: event.altKey });
            });
            card.append(remove);
        }
        card.addEventListener("pointerenter", () => vscode.postMessage({ type: "hoverMeasurement", id: measurement.id }));
        return card;
    }

    private static format(value: number): string {
        return value.toLocaleString(undefined, { minimumFractionDigits: 3, maximumFractionDigits: 3 });
    }
}

new PartsList();
new MeasurementsList();
