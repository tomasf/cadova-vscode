import * as THREE from "three";
import { toCreasedNormals } from "three/addons/utils/BufferGeometryUtils.js";
import { ViewportControls } from "./customizer/navigation.js";
import { read3MF } from "./customizer/threemf.js";
import { ViewportGrid } from "./customizer/grid.js";
import { OriginAxes, AxisIndicator } from "./customizer/axes.js";
import { ViewportRenderer } from "./customizer/rendering.js";
import { setupLighting } from "./customizer/lighting.js";
import { CameraRig, type ViewPreset } from "./CameraRig";
import { EdgeOverlay } from "./EdgeOverlay";
import { Toolbar, type ViewOptions } from "./Toolbar";

declare function acquireVsCodeApi(): {
    postMessage(message: unknown): void;
    getState(): { options?: ViewOptions } | undefined;
    setState(state: { options?: ViewOptions }): void;
};

type ModelData = Uint8Array | ArrayBuffer | { type: "Buffer"; data: number[] };

type HostMessage =
    | { type: "model"; name: string; data: ModelData }
    | { type: "error"; message: string }
    | { type: "fit" }
    | { type: "options"; options: Partial<ViewOptions> }
    | { type: "status"; status: Status };

type Status = "building" | "generating" | "loading" | "failed" | "idle";

/** The pill over the view's corner that says what's happening to the model. */
class StatusPill {
    private static readonly labels: Record<Status, string> = {
        building: "Building…", generating: "Generating…", loading: "Loading…", failed: "Build failed", idle: "",
    };
    private readonly element = document.getElementById("status")!;

    set(status: Status) {
        // An idle pill keeps its text while it fades out
        if (status !== "idle") this.element.textContent = StatusPill.labels[status];
        this.element.classList.toggle("failed", status === "failed");
        this.element.classList.toggle("visible", status !== "idle");
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
    private readonly modelSize = document.getElementById("model-size")!;

    private readonly renderer = new THREE.WebGLRenderer({ alpha: true });
    private readonly viewportRenderer: ViewportRenderer;
    private readonly scene = new THREE.Scene();
    private readonly rig = new CameraRig();
    private readonly controls: ViewportControls;
    private readonly grid: ViewportGrid;
    private readonly origin = new OriginAxes();
    private readonly axisIndicator: AxisIndicator;
    readonly toolbar: Toolbar;

    private current: THREE.Object3D | null = null;
    private edges: EdgeOverlay | null = null;
    private framed = false;

    constructor(private options: ViewOptions, onOptionsChange: (options: ViewOptions) => void) {
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.viewportRenderer = new ViewportRenderer(this.renderer);
        this.container.append(this.renderer.domElement);

        this.scene.background = new THREE.Color(this.cssValue("--viewer"));
        this.controls = new ViewportControls(this.rig.camera, this.renderer.domElement);
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
        this.scene.add(this.grid);
        this.scene.add(this.origin);
        this.axisIndicator = new AxisIndicator(this.container);

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
                onOptionsChange(next);
            },
        });
        this.apply(options);

        new ResizeObserver(() => this.resize()).observe(this.container);
        this.resize();

        this.renderer.setAnimationLoop((time) => {
            this.rig.update(time);
            this.controls.update(time);
            const camera = this.rig.camera;
            camera.updateMatrixWorld();
            this.grid.updateScale(camera, this.container.clientWidth, this.container.clientHeight);
            this.axisIndicator.update(camera);
            this.viewportRenderer.render(this.scene, camera);
        });
    }

    /** Shows a model, framing it the first time; later models keep the view, so rebuilds can be compared. */
    show(name: string, data: ModelData) {
        let object: THREE.Object3D;
        try {
            // Parts without a color of their own get the page's model color
            object = read3MF(ModelViewer.arrayBuffer(data), this.cssValue("--model"));
        } catch (error) {
            this.showMessage(`Couldn't read ${name}: ${(error as Error).message}`);
            return;
        }
        // The edges need the meshes as read, before smoothing unshares their vertices
        const edges = new EdgeOverlay(object);
        object.traverse((child) => {
            if (child instanceof THREE.Mesh) child.geometry = toCreasedNormals(child.geometry, THREE.MathUtils.degToRad(30));
        });

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
        this.apply(this.options);

        const box = new THREE.Box3().setFromObject(object);
        this.modelSize.textContent = ModelViewer.sizeText(box);
        this.modelSize.hidden = box.isEmpty();
        this.controls.setModel(object, box);
        this.rig.setModelBox(box);
        this.toolbar.hidden = false;
        this.grid.updateBounds(box);
        this.origin.visible = !box.isEmpty();
        this.axisIndicator.show();

        if (box.isEmpty()) {
            this.showMessage("The model is empty.");
        } else {
            this.overlay.hidden = true;
            if (!this.framed) {
                this.controls.reset();
                this.rig.show("isometric", false);
                this.framed = true;
            }
        }
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
        this.current?.traverse((child) => {
            if (!(child instanceof THREE.Mesh)) return;
            for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
                if (material.flatShading === !options.smoothShading) continue;
                material.flatShading = !options.smoothShading;
                material.needsUpdate = true;
            }
        });
    }

    private viewCenter(): THREE.Vector2 {
        const rect = this.renderer.domElement.getBoundingClientRect();
        return new THREE.Vector2(rect.left + rect.width / 2, rect.top + rect.height / 2);
    }

    private updateColors() {
        (this.grid.material as THREE.ShaderMaterial).uniforms.color.value.set(this.cssValue("--grid"));
        (this.scene.background as THREE.Color).set(this.cssValue("--viewer"));
    }

    private cssValue(name: string): string {
        return getComputedStyle(this.root).getPropertyValue(name).trim();
    }

    private resize() {
        const { clientWidth: width, clientHeight: height } = this.container;
        if (width === 0 || height === 0) return;
        this.viewportRenderer.setSize(width, height);
        this.rig.setAspect(width / height);
    }

    // The model's size, such as "112 × 84 × 40 mm", in the model's units, which are millimeters by
    // convention. A 2D model, built as a very thin solid, only has its width and depth.
    private static sizeText(box: THREE.Box3): string {
        const size = box.getSize(new THREE.Vector3());
        const dimensions = size.z < 0.01 ? [size.x, size.y] : [size.x, size.y, size.z];
        return `${dimensions.map((value) => String(Math.round(value * 10) / 10)).join(" × ")} mm`;
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
const defaultOptions: ViewOptions = { projection: "perspective", smoothShading: true, edges: "sharp" };
const ownOptions = vscode.getState()?.options;
let viewer: ModelViewer | null = null;
try {
    viewer = new ModelViewer({ ...defaultOptions, ...ownOptions }, (options) => {
        vscode.setState({ options });
        vscode.postMessage({ type: "options", options });
    });
} catch (error) {
    const overlay = document.getElementById("overlay")!;
    overlay.textContent = `The 3D preview isn't available: ${(error as Error).message}`;
}

window.addEventListener("message", ({ data }: MessageEvent<HostMessage>) => {
    switch (data.type) {
        case "model":
            // Reading a big model blocks the page, so the pill gets to show before it starts
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
        case "fit":
            viewer?.showPreset("isometric");
            break;
        case "status":
            status.set(data.status);
            break;
    }
});
vscode.postMessage({ type: "ready" });
