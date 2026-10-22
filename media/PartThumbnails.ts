import * as THREE from "three";
import { PlainMaterials } from "./PlainMaterials";

// Big enough for Cadova Viewer's large sidebar icons, 32 points, on a 2× display
const size = 64;

/**
 * Renders a small picture of each part, as Cadova Viewer does for its parts list and menus: the part
 * alone, from the isometric direction, lit by a headlight, on a transparent background.
 *
 * Parts are drawn one at a time between frames, with the preview's own renderer, so the view stays
 * responsive while a model with many parts gets its pictures.
 */
export class PartThumbnails {
    private readonly target = new THREE.WebGLRenderTarget(size, size, { samples: 4 });
    private readonly scene = new THREE.Scene();
    private readonly camera = new THREE.PerspectiveCamera(30, 1, 0.1, 1000);
    private readonly pixels = new Uint8Array(size * size * 4);
    private readonly canvas = Object.assign(document.createElement("canvas"), { width: size, height: size });
    private readonly urls = new Map<string, string>();
    private queue: { id: string; part: THREE.Object3D }[] = [];
    private timer: ReturnType<typeof setTimeout> | undefined;

    /** Called with pictures as they're done, by part ID, as PNG data URLs. */
    onRender: (urls: Record<string, string>) => void = () => {};

    constructor(private readonly renderer: THREE.WebGLRenderer) {
        this.target.texture.colorSpace = THREE.SRGBColorSpace;
        // Cadova Viewer's thumbnail lighting: a little ambient light and a headlight
        this.scene.add(new THREE.AmbientLight(0xffffff, Math.PI * 0.03));
        const headlight = new THREE.DirectionalLight(0xffffff, Math.PI * 0.8);
        headlight.position.set(0, 0, 1);
        this.camera.add(headlight, headlight.target);
        this.scene.add(this.camera);
    }

    /** The picture of a part, if it's been drawn. */
    url(id: string): string | undefined {
        return this.urls.get(id);
    }

    /** Starts drawing a new model's parts, forgetting the last model's. */
    render(parts: { id: string; part: THREE.Object3D }[]) {
        clearTimeout(this.timer);
        this.urls.clear();
        this.queue = [...parts];
        // After the model itself is on screen
        this.timer = setTimeout(() => this.next(), 50);
    }

    private next() {
        // A few parts per turn, sent together, then a break for the view to draw
        const batch: Record<string, string> = {};
        const deadline = performance.now() + 12;
        while (this.queue.length > 0 && performance.now() < deadline) {
            const { id, part } = this.queue.shift()!;
            const url = this.draw(part);
            if (url) {
                this.urls.set(id, url);
                batch[id] = url;
            }
        }
        if (Object.keys(batch).length > 0) this.onRender(batch);
        if (this.queue.length > 0) this.timer = setTimeout(() => this.next(), 16);
    }

    private draw(part: THREE.Object3D): string | null {
        part.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(part, true);
        if (box.isEmpty()) return null;

        // The part as it is, but shown, and without its edges, which would fight with its faces at
        // this size
        const copy = part.clone(true);
        copy.visible = true;
        const lines: THREE.Object3D[] = [];
        copy.traverse((child) => {
            if (child instanceof THREE.LineSegments) lines.push(child);
        });
        lines.forEach((line) => line.removeFromParent());
        copy.matrixAutoUpdate = false;
        copy.matrix.copy(part.parent?.matrixWorld ?? new THREE.Matrix4()).multiply(part.matrix);
        this.scene.add(copy);

        // Cadova Viewer's framing: from the isometric direction, far enough back that the box would
        // fit seen along any axis
        const extent = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const tan = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
        const distance = Math.max(
            Math.max(extent.y, extent.z), Math.max(extent.x, extent.z), Math.max(extent.x, extent.y),
        ) / 2 / tan;
        const angle = THREE.MathUtils.degToRad(35.264);
        this.camera.position.set(
            center.x - distance * Math.cos(angle), center.y - distance * Math.cos(angle), center.z + distance * Math.sin(angle),
        );
        this.camera.up.set(0, 0, 1);
        this.camera.lookAt(center);
        const radius = extent.length() / 2;
        this.camera.near = Math.max(distance - radius * 2, distance / 1000);
        this.camera.far = distance + radius * 2;
        this.camera.updateProjectionMatrix();

        const renderer = this.renderer;
        const clearColor = renderer.getClearColor(new THREE.Color());
        const clearAlpha = renderer.getClearAlpha();
        // The whole part, whatever cross-sections cut the view
        const clipping = renderer.localClippingEnabled;
        renderer.localClippingEnabled = false;
        renderer.setClearColor(0x000000, 0);
        renderer.setRenderTarget(this.target);
        renderer.clear();
        // In the part's own colors, even while the view shows it plain
        PlainMaterials.withOwnMaterials(copy, () => renderer.render(this.scene, this.camera));
        renderer.localClippingEnabled = clipping;
        renderer.readRenderTargetPixels(this.target, 0, 0, size, size, this.pixels);
        renderer.setRenderTarget(null);
        renderer.setClearColor(clearColor, clearAlpha);
        this.scene.remove(copy);

        // Rows come from the GPU bottom up, and antialiased edges come blended with the transparent
        // black they were cleared to, which a picture's pixels aren't
        const image = new ImageData(size, size);
        for (let row = 0; row < size; row++) {
            image.data.set(this.pixels.subarray((size - 1 - row) * size * 4, (size - row) * size * 4), row * size * 4);
        }
        const data = image.data;
        for (let i = 0; i < data.length; i += 4) {
            const alpha = data[i + 3];
            if (alpha === 0 || alpha === 255) continue;
            for (let channel = 0; channel < 3; channel++) data[i + channel] = Math.min(255, data[i + channel] * 255 / alpha);
        }
        this.canvas.getContext("2d")!.putImageData(image, 0, 0);
        return this.canvas.toDataURL("image/png");
    }
}
