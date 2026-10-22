import { CameraRig, type Projection, type ViewPreset } from "./CameraRig";
import type { EdgeVisibility } from "./EdgeOverlay";

/** How the model is shown, kept across rebuilds and remembered for new previews. */
export interface ViewOptions {
    projection: Projection;
    smoothShading: boolean;
    edges: EdgeVisibility;
    showGrid: boolean;
    showOrigin: boolean;
    showAxisDirections: boolean;
    showInfo: boolean;
}

export interface ToolbarActions {
    zoom(direction: 1 | -1): void;
    showPreset(preset: ViewPreset): void;
    setOptions(options: ViewOptions): void;
    /** Opens the menu of what's shown, under a button. */
    showMenu(button: HTMLElement): void;
    /** Whether measure mode is on, and turning it on or off. */
    readonly measuring: boolean;
    setMeasuring(on: boolean): void;
}

// Cadova Viewer's icons for the standard views: a cube with the face you'd see filled in. The cube turns
// so that face is one of those in sight, and the back is seen through the front.
const presetIcons: Record<ViewPreset, string> = {
    isometric: `<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z M4 7.5l8 4.5 8-4.5 M12 12v9"/>`,
    // Seen from the top left
    front: `<path d="M7 7h13v13H7z" fill="currentColor"/><path d="M3 3h13l4 4H7z M3 3l4 4v13l-4-4z"/>`,
    back: `<path d="M3 3h13v13H3z" fill="currentColor" fill-opacity=".45" stroke="none"/><path d="M7 7h13v13H7z M3 3h13l4 4H7z M3 3l4 4v13l-4-4z"/>`,
    left: `<path d="M3 3l4 4v13l-4-4z" fill="currentColor"/><path d="M7 7h13v13H7z M3 3h13l4 4H7z"/>`,
    top: `<path d="M3 3h13l4 4H7z" fill="currentColor"/><path d="M7 7h13v13H7z M3 3l4 4v13l-4-4z"/>`,
    // Seen from the top right
    right: `<path d="M17 7l4-4v13l-4 4z" fill="currentColor"/><path d="M4 7h13v13H4z M8 3h13l-4 4H4z"/>`,
    // Seen from the bottom left
    bottom: `<path d="M3 21l4-4h13l-4 4z" fill="currentColor"/><path d="M7 4h13v13H7z M3 8l4-4v13l-4 4z"/>`,
};

const icons = {
    perspective: `<path d="M8 5h8l4 14H4z M6 12h12 M10 5l-2 14 M14 5l2 14"/>`,
    orthographic: `<path d="M5 5h14v14H5z M5 12h14 M12 5v14"/>`,
    zoomIn: `<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5 M10.5 8v5 M8 10.5h5"/>`,
    zoomOut: `<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5 M8 10.5h5"/>`,
    info: `<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5"/><circle cx="12" cy="7.75" r=".6" fill="currentColor"/>`,
    measure: `<path d="M3.5 15.5l12-12 5 5-12 12z M7 12l1.5 1.5 M9.5 9.5l2 2 M12 7l1.5 1.5"/>`,
    show: `<path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>`,
};

/** The row of view controls above the model, after Cadova Viewer's toolbar and View menu. */
export class Toolbar {
    private readonly element = document.getElementById("toolbar")!;
    private readonly updates: (() => void)[] = [];

    constructor(private options: ViewOptions, private readonly actions: ToolbarActions) {
        // Moving the camera on the left
        this.group([
            this.button("Zoom Out", icons.zoomOut, () => actions.zoom(-1)),
            this.button("Zoom In", icons.zoomIn, () => actions.zoom(1)),
        ]);
        this.group((Object.keys(presetIcons) as ViewPreset[]).map((preset) =>
            this.button(`${CameraRig.presets[preset].title} View`, presetIcons[preset], () => actions.showPreset(preset))));
        // One projection is always chosen, so the chosen one is marked quietly
        this.group([
            this.choice("Perspective", icons.perspective, () => this.options.projection === "perspective",
                () => this.set({ projection: "perspective" })),
            this.choice("Orthographic", icons.orthographic, () => this.options.projection === "orthographic",
                () => this.set({ projection: "orthographic" })),
        ]).classList.add("picker");
        // What's shown and the tools on the right. Things changed less often, such as the grid, shading
        // and edges, are in a menu.
        const show = this.button("Show", icons.show, () => actions.showMenu(show));
        show.setAttribute("aria-haspopup", "menu");
        this.group([show]).classList.add("trailing");
        this.group([this.choice("Measure", icons.measure, () => actions.measuring, () => actions.setMeasuring(!actions.measuring))]);
        // Cadova Viewer's info sheet, as a panel that stays open
        this.group([this.choice("Info", icons.info, () => this.options.showInfo,
            () => this.set({ showInfo: !this.options.showInfo }))]);
        this.refresh();
    }

    /** Shows options set from elsewhere, such as the remembered ones arriving. */
    update(options: ViewOptions) {
        this.options = { ...options };
        this.refresh();
    }

    /** Shows state kept elsewhere, such as whether measure mode is on. */
    refresh() {
        for (const update of this.updates) update();
    }

    set(change: Partial<ViewOptions>) {
        this.options = { ...this.options, ...change };
        this.refresh();
        this.actions.setOptions({ ...this.options });
    }

    private group(buttons: HTMLButtonElement[]): HTMLElement {
        const group = document.createElement("div");
        group.className = "toolbar-group";
        group.setAttribute("role", "group");
        group.append(...buttons);
        this.element.append(group);
        return group;
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
