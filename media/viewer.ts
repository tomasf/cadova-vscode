import * as THREE from "three";
import { toCreasedNormals } from "three/addons/utils/BufferGeometryUtils.js";
import { ViewportControls } from "./customizer/navigation.js";
import { read3MF } from "./customizer/threemf.js";
import { ViewportGrid } from "./customizer/grid.js";
import { OriginAxes, AxisIndicator } from "./customizer/axes.js";
import { ViewportRenderer } from "./customizer/rendering.js";
import { setupLighting } from "./customizer/lighting.js";
import { CameraRig, type SavedCamera, type ViewPreset } from "./CameraRig";
import { EdgeOverlay } from "./EdgeOverlay";
import { Toolbar, type ViewOptions } from "./Toolbar";
import { PopupMenu, type MenuEntry, type MenuItem } from "./PopupMenu";
import { PartHighlight } from "./PartHighlight";
import { InfoPanel } from "./InfoPanel";
import { PartThumbnails } from "./PartThumbnails";
import { PartSolid } from "./PartSolid";
import { CrossSectionEditor } from "./CrossSectionEditor";
import type { CrossSection } from "./CrossSection";
import { SurfacePicker } from "./SurfacePicker";
import { MeasurementTool, type Measurement } from "./MeasurementTool";

/** What a preview remembers of its own: its view options, the parts hidden in it, by ID, and where its camera is. */
interface PanelState {
    options?: ViewOptions;
    hiddenParts?: string[];
    measurements?: Measurement[];
    sections?: CrossSection[];
    camera?: SavedCamera;
}

declare function acquireVsCodeApi(): {
    postMessage(message: unknown): void;
    getState(): PanelState | undefined;
    setState(state: PanelState): void;
};

type ModelData = Uint8Array | ArrayBuffer | { type: "Buffer"; data: number[] };

/** A part as the sidebar's parts list shows it. */
interface PartSummary {
    id: string;
    name: string;
    semantic: string;
}

/** What the view tells the extension about. */
interface ViewerEvents {
    optionsChanged(options: ViewOptions): void;
    /** The model's parts when a new model is shown, and later when which are hidden changes. */
    partsChanged(parts: PartSummary[], hiddenParts: Set<string>, newModel: boolean): void;
    /** Pictures of parts as they're drawn, by part ID. */
    thumbnailsRendered(urls: Record<string, string>): void;
    /** The measurements, with the point under the pointer while measuring. */
    measurementsChanged(measurements: Measurement[]): void;
    sectionsChanged(sections: CrossSection[]): void;
    /** The camera moved, once the model has been framed. */
    cameraChanged(camera: SavedCamera): void;
}

type HostMessage =
    | { type: "model"; name: string; data: ModelData }
    | { type: "error"; message: string }
    | { type: "options"; options: Partial<ViewOptions> }
    | { type: "status"; status: Status }
    | { type: "hiddenParts"; hidden: string[] }
    | { type: "highlightPart"; id: string | null }
    | { type: "frameParts"; ids: string[] }
    | { type: "highlightMeasurement"; id: string | null }
    | { type: "deleteMeasurement"; id: string }
    | { type: "deleteAllMeasurements" };

type Status = "building" | "generating" | "loading" | "failed" | "idle";

/** The pill at the bottom of the view that says what's happening to the model. */
class StatusPill {
    private static readonly labels: Record<Status, string> = {
        building: "Compiling…", generating: "Generating…", loading: "Loading…", failed: "Generating failed", idle: "",
    };
    private readonly element = document.getElementById("status")!;
    private clearTimer: ReturnType<typeof setTimeout> | undefined;

    set(status: Status) {
        // Going idle, the text fades out before it's removed, giving the toolbar its room back
        clearTimeout(this.clearTimer);
        if (status === "idle") this.clearTimer = setTimeout(() => { this.element.textContent = ""; }, 200);
        else this.element.textContent = StatusPill.labels[status];
        this.element.classList.toggle("failed", status === "failed");
        this.element.classList.toggle("busy", status !== "failed" && status !== "idle");
        this.element.classList.toggle("visible", status !== "idle");
    }
}

/**
 * The view's navigation, turning and zooming around the nearest surface you can see under the
 * pointer, as in Cadova Viewer: not a hidden part or what a cross-section cuts away, and a cut face.
 */
class SectionAwareControls extends ViewportControls {
    picker: SurfacePicker | null = null;

    pivot(point: THREE.Vector2): THREE.Vector3 {
        const surface = this.picker?.surfacePoint(point.x, point.y);
        if (surface) return surface;
        // Off the model, the customizer's own fallback, without its plain hit on the model
        const meshes = this.meshes;
        this.meshes = [];
        try {
            return super.pivot(point);
        } finally {
            this.meshes = meshes;
        }
    }
}

/**
 * The 3D view of one model file. It's put together from the web customizer's own viewer modules, the
 * way the customizer's page does it, so the two look and navigate the same, with view options from
 * Cadova Viewer on top.
 */
class ModelViewer {
    private readonly root = document.documentElement;
    private readonly container = document.getElementById("viewer")!;
    private readonly overlay = document.getElementById("overlay")!;
    private readonly info = new InfoPanel();

    private readonly renderer = new THREE.WebGLRenderer({ alpha: true });
    private readonly viewportRenderer: ViewportRenderer;
    private readonly scene = new THREE.Scene();
    private readonly rig = new CameraRig();
    private readonly controls: SectionAwareControls;
    private readonly grid: ViewportGrid;
    // The grid hides itself when it's seen edge-on, so showing it is up to a group around it
    private readonly gridHolder = new THREE.Group();
    private readonly origin = new OriginAxes();
    private readonly axisIndicator: AxisIndicator;
    private readonly highlight: PartHighlight;
    private readonly thumbnails: PartThumbnails;
    private readonly sections: CrossSectionEditor;
    readonly measurements: MeasurementTool;
    readonly toolbar: Toolbar;
    private modelBox = new THREE.Box3();

    private current: THREE.Object3D | null = null;
    private readonly picker: SurfacePicker;
    private edges: EdgeOverlay | null = null;
    private framed = false;
    // Where the camera was when the preview was last open, to go back to rather than framing the model
    private savedCamera: SavedCamera | null;
    private hasModel = false;

    // The view is drawn only when the camera moves, or for a while after anything else that could
    // change it, which outlasts the cross-section ghost's fade. Without a GPU, as in a virtual
    // machine, drawing every frame keeps the processor busy even when nothing changes.
    private static readonly redrawGrace = 1000;
    private redrawUntil = 0;
    private readonly drawnView = new THREE.Matrix4();
    private readonly drawnProjection = new THREE.Matrix4();

    constructor(
        private options: ViewOptions,
        private hiddenParts: Set<string>,
        private readonly events: ViewerEvents,
        saved: { measurements: Measurement[]; sections: CrossSection[]; camera?: SavedCamera },
    ) {
        this.savedCamera = saved.camera ?? null;
        this.renderer.setPixelRatio(window.devicePixelRatio);
        // Cross-sections clip the model's materials, and only those
        this.renderer.localClippingEnabled = true;
        this.viewportRenderer = new ViewportRenderer(this.renderer);
        this.highlight = new PartHighlight(this.renderer);
        this.thumbnails = new PartThumbnails(this.renderer);
        this.thumbnails.onRender = (urls) => events.thumbnailsRendered(urls);
        this.container.append(this.renderer.domElement);

        this.scene.background = new THREE.Color(this.cssValue("--viewer"));
        this.controls = new SectionAwareControls(this.rig.camera, this.renderer.domElement);
        setupLighting(this.scene, this.rig.camera, this.renderer);

        // The headlight rides on the camera, so it moves to whichever camera is in use
        this.rig.onCameraChange = (from, to) => {
            to.add(...from.children);
            this.scene.remove(from);
            this.scene.add(to);
            this.controls.reset();
            this.controls.camera = to;
        };
        // Grabbing the view stops a flight to a standard view
        for (const type of ["pointerdown", "wheel"]) {
            this.renderer.domElement.addEventListener(type, () => this.rig.cancelFlight(), { capture: true, passive: true });
        }

        this.grid = new ViewportGrid(this.cssValue("--grid"));
        this.gridHolder.add(this.grid);
        this.scene.add(this.gridHolder);
        this.scene.add(this.origin);
        this.axisIndicator = new AxisIndicator(this.container);

        const canvas = this.renderer.domElement;
        const viewer = this;
        this.sections = new CrossSectionEditor({
            get camera() { return viewer.rig.camera; },
            canvas,
            get modelBox() { return viewer.modelBox; },
            get hiddenParts() { return viewer.hiddenParts; },
            worldPerPixel: (point) => this.worldPerPixel(point),
            sectionsChanged: (sections) => events.sectionsChanged(sections),
        }, saved.sections);
        const picker = new SurfacePicker({
            get camera() { return viewer.rig.camera; },
            canvas,
            get model() { return viewer.current; },
            caps: this.sections.view.capObjects,
            get sections() { return viewer.sections.enabled; },
        });
        this.measurements = new MeasurementTool(canvas, picker, {
            measurementsChanged: (measurements) => events.measurementsChanged(measurements),
            activeChanged: () => this.toolbar.refresh(),
        }, saved.measurements);
        this.scene.add(this.sections.view.group, this.measurements.group, this.sections.gizmo.root);
        this.picker = picker;
        this.controls.picker = picker;

        // VS Code changes its theme by changing the body's classes
        new MutationObserver(() => this.updateColors()).observe(document.body, {
            attributes: true, attributeFilter: ["class"],
        });

        this.toolbar = new Toolbar(options, {
            zoom: (direction) => {
                this.rig.cancelFlight();
                this.controls.animateZoom(direction * Math.log(1.5), this.viewCenter());
            },
            showPreset: (preset) => this.showPreset(preset),
            setOptions: (next) => {
                this.apply(next);
                events.optionsChanged(next);
            },
            showMenu: (button) => {
                const rect = button.getBoundingClientRect();
                PopupMenu.show(this.showMenuEntries(), rect.left, rect.bottom + 4);
            },
            get measuring() { return viewer.measurements.isActive; },
            setMeasuring: (on) => this.measurements.setActive(on),
        });
        this.listenForContextMenu();
        this.renderer.domElement.addEventListener("pointerdown", () => this.highlightPart(null));
        this.apply(options);

        new ResizeObserver(() => this.resize()).observe(this.container);
        this.resize();

        // VS Code makes a preview the active editor when its page takes focus, but the navigation
        // cancels presses on the view, which would keep it from doing that, so the view takes it
        canvas.tabIndex = -1;
        canvas.addEventListener("pointerdown", () => canvas.focus({ preventScroll: true }), { capture: true });

        // Anything the pointer or keyboard does could change what's shown, in the view or a menu over it
        for (const type of ["pointerdown", "pointermove", "pointerup", "wheel", "keydown", "keyup"]) {
            window.addEventListener(type, () => this.invalidate(), { capture: true, passive: true });
        }
        document.addEventListener("visibilitychange", () => this.invalidate());

        this.renderer.setAnimationLoop((time) => {
            this.rig.update(time);
            this.controls.update(time);
            const camera = this.rig.camera;
            camera.updateMatrixWorld();
            // Flights, glides and animated zooms all move the camera, so they draw as long as they last
            const moved = !camera.matrixWorld.equals(this.drawnView) || !camera.projectionMatrix.equals(this.drawnProjection);
            if (!moved && time > this.redrawUntil) return;
            this.drawnView.copy(camera.matrixWorld);
            this.drawnProjection.copy(camera.projectionMatrix);
            // Before the model is framed, the camera is nowhere worth remembering
            if (moved && this.framed) events.cameraChanged(this.rig.saved);
            this.grid.updateScale(camera, this.container.clientWidth, this.container.clientHeight);
            this.axisIndicator.update(camera);
            this.sections.render(time);
            this.measurements.render((point) => this.worldPerPixel(point));
            this.viewportRenderer.render(this.scene, camera);
            this.highlight.render(camera);
        });
    }

    /** Shows a model, framing it the first time; later models keep the view, so rebuilds can be compared. */
    show(name: string, data: ModelData) {
        let object: THREE.Object3D;
        const buffer = ModelViewer.arrayBuffer(data);
        try {
            // Parts without a color of their own get the page's model color
            object = read3MF(buffer, this.cssValue("--model"));
        } catch (error) {
            this.showMessage(`Couldn't read ${name}: ${(error as Error).message}`);
            return;
        }
        // The edges, the counts and the cross-sections' cut faces need the meshes as read, before
        // smoothing unshares their vertices
        const edges = new EdgeOverlay(object);
        const solids = object.children.map((part) => ({ id: ModelViewer.partID(part), part, solid: new PartSolid(part) }));
        this.info.show({
            name: name.replace(/\.3mf$/i, ""), fileSize: buffer.byteLength,
            stats: InfoPanel.measure(object), metadata: object.userData.metadata ?? [],
        });
        object.traverse((child) => {
            if (child instanceof THREE.Mesh) child.geometry = toCreasedNormals(child.geometry, THREE.MathUtils.degToRad(30));
        });

        this.highlight.show(null, false, this.options.edges);
        if (this.current) {
            this.scene.remove(this.current);
            this.edges?.dispose();
            this.current.traverse((child) => {
                if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
                    child.geometry.dispose();
                    (Array.isArray(child.material) ? child.material : [child.material]).forEach((material) => material.dispose());
                }
            });
        }
        this.current = object;
        this.edges = edges;
        this.scene.add(object);
        this.sections.view.setModel(object, solids);
        this.showParts();
        this.reportParts(true);
        this.thumbnails.render(this.parts.map((part) => ({ id: ModelViewer.partID(part), part })));

        const box = new THREE.Box3().setFromObject(object);
        this.modelBox = box;
        this.picker.modelChanged();
        this.sections.refresh();
        this.controls.setModel(object, box);
        this.rig.setModelBox(box);
        this.grid.updateBounds(box);
        this.hasModel = !box.isEmpty();
        this.axisIndicator.show();
        this.apply(this.options);

        if (box.isEmpty()) {
            this.showMessage("The model is empty.");
        } else {
            this.overlay.hidden = true;
            if (!this.framed) {
                this.controls.reset();
                if (this.savedCamera) this.rig.restore(this.savedCamera);
                else this.rig.show("isometric", false);
                this.framed = true;
            }
        }
        this.invalidate();
    }

    /** Draws the view over the next while, for a change that doesn't move the camera. */
    invalidate() {
        this.redrawUntil = performance.now() + ModelViewer.redrawGrace;
    }

    showMessage(text: string) {
        this.overlay.textContent = text;
        this.overlay.hidden = false;
    }

    showPreset(preset: ViewPreset) {
        this.controls.reset();
        this.rig.show(preset, true);
    }

    /** Applies view options, such as ones remembered from before or chosen in the toolbar. */
    apply(options: ViewOptions) {
        this.options = { ...options };
        this.toolbar?.update(options);
        this.rig.setProjection(options.projection);
        this.edges?.show(options.edges);
        this.gridHolder.visible = options.showGrid;
        this.origin.visible = options.showOrigin && this.hasModel;
        this.axisIndicator.element.style.visibility = options.showAxisDirections ? "" : "hidden";
        this.info.visible = options.showInfo && this.hasModel;
        this.current?.traverse((child) => {
            if (!(child instanceof THREE.Mesh)) return;
            for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
                if (material.flatShading === !options.smoothShading) continue;
                material.flatShading = !options.smoothShading;
                material.needsUpdate = true;
            }
        });
        this.invalidate();
    }

    // Parts

    /** The model's parts, its 3MF build items, as in Cadova Viewer. */
    private get parts(): THREE.Object3D[] {
        return this.current?.children ?? [];
    }

    // A part keeps its ID across rebuilds: its part number, which Cadova sets from the part's name
    private static partID(part: THREE.Object3D): string {
        return part.userData.partNumber ?? part.name;
    }

    setHiddenParts(hiddenParts: Set<string>) {
        this.hiddenParts = hiddenParts;
        this.showParts();
        this.reportParts();
    }

    /** Outlines a part, such as one hovered in the sidebar, or none. */
    highlightPart(id: string | null) {
        const part = this.parts.find((part) => ModelViewer.partID(part) === id) ?? null;
        this.highlight.show(part, id !== null && this.hiddenParts.has(id), this.options.edges);
    }

    /** Centers the view on some parts, keeping the direction it looks from, as Cadova Viewer does. */
    frameParts(ids: string[]) {
        const box = new THREE.Box3();
        for (const part of this.parts) {
            if (ids.includes(ModelViewer.partID(part))) box.expandByObject(part);
        }
        if (box.isEmpty()) return;
        this.controls.reset();
        this.rig.frame(box);
    }

    private reportParts(newModel = false) {
        this.events.partsChanged(this.parts.map((part) => ({
            id: ModelViewer.partID(part), name: part.name, semantic: part.userData.semantic ?? "solid",
        })), this.hiddenParts, newModel);
    }

    private showParts() {
        for (const part of this.parts) part.visible = !this.hiddenParts.has(ModelViewer.partID(part));
        // Hidden parts have no cut faces
        this.sections.refresh();
    }

    // The one part shown, if only one is
    private get onlyVisiblePart(): string | null {
        const visible = this.parts.map(ModelViewer.partID).filter((id) => !this.hiddenParts.has(id));
        return visible.length === 1 ? visible[0] : null;
    }

    /** Menu items that show or hide parts; with Option held, they show only that part. */
    private partItems(parts: THREE.Object3D[]): MenuItem[] {
        const allIDs = this.parts.map(ModelViewer.partID);
        return parts.map((part) => {
            const id = ModelViewer.partID(part);
            return {
                label: part.name,
                icon: this.thumbnails.url(id) ?? "",
                checked: !this.hiddenParts.has(id),
                action: () => {
                    const hidden = new Set(this.hiddenParts);
                    if (!hidden.delete(id)) hidden.add(id);
                    this.setHiddenParts(hidden);
                },
                alternate: {
                    checked: this.onlyVisiblePart === id,
                    action: () => this.setHiddenParts(this.onlyVisiblePart === id
                        ? new Set() : new Set(allIDs.filter((other) => other !== id))),
                },
                // Hovering a part outlines it, and shows it faintly if it's hidden
                onHover: (hovered) => this.highlight.show(hovered ? part : null, this.hiddenParts.has(id), this.options.edges),
            };
        });
    }

    private showOrHideAllItem(): MenuItem {
        return this.hiddenParts.size === 0
            ? { label: "Hide All", action: () => this.setHiddenParts(new Set(this.parts.map(ModelViewer.partID))) }
            : { label: "Show All", action: () => this.setHiddenParts(new Set()) };
    }

    // The toggles for what's shown besides the model, named as in Cadova Viewer's View menu
    private viewToggleItems(): MenuItem[] {
        const toggle = (label: string, key: "showGrid" | "showOrigin" | "showAxisDirections"): MenuItem => ({
            label, checked: this.options[key], action: () => this.toolbar.set({ [key]: !this.options[key] }),
        });
        return [toggle("Grid", "showGrid"), toggle("Origin", "showOrigin"), toggle("Axis Directions", "showAxisDirections")];
    }

    // The toolbar's Show menu, which is also the context menu's: what's shown besides the model, then
    // how the model is drawn, in Cadova Viewer's order
    private showMenuEntries(): MenuEntry[] {
        const edges = (label: string, edges: ViewOptions["edges"]): MenuItem => ({
            label, checked: this.options.edges === edges, action: () => this.toolbar.set({ edges }),
        });
        const smoothShading: MenuItem = {
            label: "Smooth Shading", checked: this.options.smoothShading,
            action: () => this.toolbar.set({ smoothShading: !this.options.smoothShading }),
        };
        return [
            ...this.viewToggleItems(), "separator", smoothShading, "separator",
            edges("No Edges", "none"), edges("Sharp Edges", "sharp"), edges("All Edges", "all"),
        ];
    }

    // Cadova Viewer's context menu: the parts under the pointer, then what's shown
    private contextMenuEntries(x: number, y: number): MenuEntry[] {
        const entries: MenuEntry[] = [];
        if (this.parts.length > 1) {
            const under = this.partsUnder(x, y);
            if (under.length > 0) {
                entries.push({ header: "Parts", alternateHeader: "Show Only" }, ...this.partItems(under));
            }
            entries.push(this.showOrHideAllItem(), "separator");
        }
        entries.push({ label: "Show", submenu: this.showMenuEntries() });
        return entries;
    }

    /**
     * The parts under a point in the window, nearest first, hidden ones included. As in Cadova Viewer,
     * rays over a small circle around the point find small parts that a single ray would miss, and
     * they pass through what cross-sections cut away, but land on a part's cut faces.
     */
    private partsUnder(x: number, y: number): THREE.Object3D[] {
        const rect = this.renderer.domElement.getBoundingClientRect();
        const raycaster = new THREE.Raycaster();
        const distances = new Map<THREE.Object3D, number>();
        const radius = 5;
        const points = [[x, y], ...Array.from({ length: 8 }, (_, step) => {
            const angle = step / 8 * Math.PI * 2;
            return [x + Math.cos(angle) * radius, y + Math.sin(angle) * radius];
        })];
        const caps = this.sections.view.capObjects.children;
        const targets = new Map(this.parts.map((part) => {
            const id = ModelViewer.partID(part);
            return [part, [part, ...caps.filter((cap) => cap.userData.partID === id)]];
        }));
        for (const [px, py] of points) {
            raycaster.setFromCamera(new THREE.Vector2((px - rect.left) / rect.width * 2 - 1, -((py - rect.top) / rect.height) * 2 + 1), this.rig.camera);
            for (const [part, objects] of targets) {
                // Three.js tests hidden objects too, but its lines' hits are too wide to count
                const hit = raycaster.intersectObjects(objects, true)
                    .find((hit) => hit.object instanceof THREE.Mesh && !this.picker.isCutAway(hit));
                if (hit && hit.distance < (distances.get(part) ?? Infinity)) distances.set(part, hit.distance);
            }
        }
        return [...distances].sort((a, b) => a[1] - b[1]).map(([part]) => part);
    }

    // A right click opens the context menu, but a right drag pans, so the menu waits for the release.
    // A Control-click is a right click on a Mac.
    private listenForContextMenu() {
        const canvas = this.renderer.domElement;
        let press: { x: number; y: number } | null = null;
        canvas.addEventListener("pointerdown", (event) => {
            const secondary = event.button === 2 || (event.button === 0 && event.ctrlKey);
            press = secondary && event.pointerType === "mouse" && !PopupMenu.isOpen ? { x: event.clientX, y: event.clientY } : null;
        });
        canvas.addEventListener("pointerup", (event) => {
            if (!press) return;
            const moved = Math.hypot(event.clientX - press.x, event.clientY - press.y) > 4;
            press = null;
            if (!moved) PopupMenu.show(this.contextMenuEntries(event.clientX, event.clientY), event.clientX, event.clientY);
        });
    }

    private worldPerPixel(point: THREE.Vector3): number {
        return this.rig.worldPerPixel(point, this.container.clientHeight);
    }

    private viewCenter(): THREE.Vector2 {
        const rect = this.renderer.domElement.getBoundingClientRect();
        return new THREE.Vector2(rect.left + rect.width / 2, rect.top + rect.height / 2);
    }

    private updateColors() {
        (this.grid.material as THREE.ShaderMaterial).uniforms.color.value.set(this.cssValue("--grid"));
        (this.scene.background as THREE.Color).set(this.cssValue("--viewer"));
        this.invalidate();
    }

    private cssValue(name: string): string {
        return getComputedStyle(this.root).getPropertyValue(name).trim();
    }

    private resize() {
        const { clientWidth: width, clientHeight: height } = this.container;
        if (width === 0 || height === 0) return;
        this.viewportRenderer.setSize(width, height);
        this.rig.setAspect(width / height);
        // Resizing clears the canvas
        this.invalidate();
    }

    // Bytes can arrive as a typed array, an ArrayBuffer, or a serialized Node Buffer
    private static arrayBuffer(data: ModelData): ArrayBuffer {
        if (data instanceof ArrayBuffer) return data;
        if (ArrayBuffer.isView(data)) {
            return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
        }
        return Uint8Array.from(data.data).buffer;
    }
}

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);
const vscode = acquireVsCodeApi();
const status = new StatusPill();

// Each preview keeps its own options, and starts from the last ones chosen in any preview
const defaultOptions: ViewOptions = {
    projection: "perspective", smoothShading: true, edges: "sharp",
    showGrid: true, showOrigin: true, showAxisDirections: true, showInfo: false,
};
const state: PanelState = vscode.getState() ?? {};
const ownOptions = state.options;
let viewer: ModelViewer | null = null;
try {
    // The list in the sidebar follows the point under the pointer, but needn't on every move
    let measurementsTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingMeasurements: Measurement[] = [];
    let cameraTimer: ReturnType<typeof setTimeout> | undefined;
    viewer = new ModelViewer({ ...defaultOptions, ...ownOptions }, new Set(state.hiddenParts), {
        optionsChanged(options) {
            state.options = options;
            vscode.setState(state);
            vscode.postMessage({ type: "options", options });
        },
        partsChanged(parts, hiddenParts, newModel) {
            state.hiddenParts = [...hiddenParts];
            vscode.setState(state);
            vscode.postMessage({ type: "parts", parts, hidden: state.hiddenParts, newModel });
        },
        thumbnailsRendered(urls) {
            vscode.postMessage({ type: "thumbnails", thumbnails: urls });
        },
        measurementsChanged(measurements) {
            const complete = measurements.filter((measurement) => measurement.phase === "complete");
            if (JSON.stringify(complete) !== JSON.stringify(state.measurements ?? [])) {
                state.measurements = complete;
                vscode.setState(state);
            }
            pendingMeasurements = measurements;
            measurementsTimer ??= setTimeout(() => {
                measurementsTimer = undefined;
                vscode.postMessage({ type: "measurements", measurements: pendingMeasurements });
            }, 80);
        },
        sectionsChanged(sections) {
            state.sections = sections;
            vscode.setState(state);
        },
        // The camera moves every frame of a drag, but only needs remembering where it stops
        cameraChanged(camera) {
            state.camera = camera;
            clearTimeout(cameraTimer);
            cameraTimer = setTimeout(() => vscode.setState(state), 300);
        },
    }, { measurements: state.measurements ?? [], sections: state.sections ?? [], camera: state.camera });
    // Measurements from before, for the list
    vscode.postMessage({ type: "measurements", measurements: state.measurements ?? [] });
} catch (error) {
    const overlay = document.getElementById("overlay")!;
    overlay.textContent = `The 3D preview isn't available: ${(error as Error).message}`;
}

window.addEventListener("message", ({ data }: MessageEvent<HostMessage>) => {
    viewer?.invalidate();
    switch (data.type) {
        case "model":
            // Reading a big model blocks the page, so the status gets to show before it starts
            status.set("loading");
            requestAnimationFrame(() => setTimeout(() => {
                viewer?.show(data.name, data.data);
                status.set("idle");
            }));
            break;
        case "options":
            if (!ownOptions) viewer?.apply({ ...defaultOptions, ...data.options });
            break;
        case "error":
            viewer?.showMessage(data.message);
            break;
        case "hiddenParts":
            viewer?.setHiddenParts(new Set(data.hidden));
            break;
        case "highlightPart":
            viewer?.highlightPart(data.id);
            break;
        case "frameParts":
            viewer?.frameParts(data.ids);
            break;
        case "highlightMeasurement":
            viewer?.measurements.highlight(data.id);
            break;
        case "deleteMeasurement":
            viewer?.measurements.delete(data.id);
            break;
        case "deleteAllMeasurements":
            viewer?.measurements.deleteAll();
            break;
        case "status":
            status.set(data.status);
            break;
    }
});
vscode.postMessage({ type: "ready" });
