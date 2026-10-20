import { CameraRig, type Projection, type ViewPreset } from "./CameraRig";
import type { EdgeVisibility } from "./EdgeOverlay";

/** How the model is shown, kept across rebuilds and remembered for new previews. */
export interface ViewOptions {
    projection: Projection;
    smoothShading: boolean;
    edges: EdgeVisibility;
}

export interface ToolbarActions {
    zoom(direction: 1 | -1): void;
    showPreset(preset: ViewPreset): void;
    setOptions(options: ViewOptions): void;
}

// Cadova Viewer's short titles for the standard views. Icons for them are too alike to tell apart at
// toolbar size: only the shaded face differs, and half the faces are hidden behind the others.
const presetLabels: Record<ViewPreset, string> = {
    isometric: "Iso", front: "Front", back: "Back", left: "Left", right: "Right", top: "Top", bottom: "Bottom",
};

const icons = {
    perspective: `<path d="M8 5h8l4 14H4z M6 12h12 M10 5l-2 14 M14 5l2 14"/>`,
    orthographic: `<path d="M5 5h14v14H5z M5 12h14 M12 5v14"/>`,
    zoomIn: `<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5 M10.5 8v5 M8 10.5h5"/>`,
    zoomOut: `<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5 M8 10.5h5"/>`,
    smooth: `<circle cx="12" cy="12" r="8"/><path d="M8.5 9a4.5 4.5 0 0 1 3.5-2.5" />`,
    edgesNone: `<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" fill="currentColor" fill-opacity=".35" stroke="none"/>`,
    edgesSharp: `<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z M4 7.5l8 4.5 8-4.5 M12 12v9" fill="currentColor" fill-opacity=".2"/>`,
    edgesAll: `<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z M4 7.5l8 4.5 8-4.5 M12 12v9 M4 7.5l8 13.5 M12 3v9 M20 7.5l-8 13.5 M4 16.5l16-9 M20 16.5l-16-9" stroke-width="1.1" fill="currentColor" fill-opacity=".2"/>`,
};

/** The row of view controls over the model, after Cadova Viewer's toolbar and View menu. */
export class Toolbar {
    private readonly element = document.getElementById("toolbar")!;
    private readonly updates: (() => void)[] = [];

    constructor(private options: ViewOptions, private readonly actions: ToolbarActions) {
        this.group([
            this.choice("Perspective", icons.perspective, () => this.options.projection === "perspective",
                () => this.set({ projection: "perspective" })),
            this.choice("Orthographic", icons.orthographic, () => this.options.projection === "orthographic",
                () => this.set({ projection: "orthographic" })),
        ]);
        this.group([
            this.button("Zoom Out", icons.zoomOut, () => actions.zoom(-1)),
            this.button("Zoom In", icons.zoomIn, () => actions.zoom(1)),
        ]);
        this.group((Object.keys(presetLabels) as ViewPreset[]).map((preset) => {
            const button = this.button(`${CameraRig.presets[preset].title} View`, "", () => actions.showPreset(preset));
            button.className = "text";
            button.textContent = presetLabels[preset];
            return button;
        }));
        this.group([
            this.choice("Smooth Shading", icons.smooth, () => this.options.smoothShading,
                () => this.set({ smoothShading: !this.options.smoothShading })),
        ]);
        this.group([
            this.choice("No Edges", icons.edgesNone, () => this.options.edges === "none", () => this.set({ edges: "none" })),
            this.choice("Sharp Edges", icons.edgesSharp, () => this.options.edges === "sharp", () => this.set({ edges: "sharp" })),
            this.choice("All Edges", icons.edgesAll, () => this.options.edges === "all", () => this.set({ edges: "all" })),
        ]);
        this.refresh();
    }

    /** Shows options set from elsewhere, such as the remembered ones arriving. */
    update(options: ViewOptions) {
        this.options = { ...options };
        this.refresh();
    }

    set hidden(hidden: boolean) {
        this.element.hidden = hidden;
    }

    private set(change: Partial<ViewOptions>) {
        this.options = { ...this.options, ...change };
        this.refresh();
        this.actions.setOptions({ ...this.options });
    }

    private refresh() {
        for (const update of this.updates) update();
    }

    private group(buttons: HTMLButtonElement[]) {
        const group = document.createElement("div");
        group.className = "toolbar-group";
        group.setAttribute("role", "group");
        group.append(...buttons);
        this.element.append(group);
    }

    private button(title: string, icon: string, action: () => void): HTMLButtonElement {
        const button = document.createElement("button");
        button.type = "button";
        button.title = title;
        button.setAttribute("aria-label", title);
        button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg>`;
        button.addEventListener("click", action);
        return button;
    }

    // A button that shows whether its option is on
    private choice(title: string, icon: string, isOn: () => boolean, action: () => void): HTMLButtonElement {
        const button = this.button(title, icon, action);
        this.updates.push(() => button.setAttribute("aria-pressed", String(isOn())));
        return button;
    }
}
