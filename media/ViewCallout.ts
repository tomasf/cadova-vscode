import * as THREE from "three";
import { CameraRig, type ViewPreset } from "./CameraRig";

// The picture's size on screen, in CSS pixels
const width = 200;
const height = 140;

/**
 * A small picture of the model from a standard view, below that view's toolbar button while it's
 * hovered, so you can see a view before choosing it without the view itself moving. It's drawn from
 * the view's own scene, so it shows what the view would: the same parts, materials, sections and grid.
 */
export class ViewCallout {
    private readonly element = document.getElementById("view-callout")!;
    private readonly canvas = this.element.querySelector("canvas")!;
    private readonly label = this.element.querySelector("span")!;
    private target: THREE.WebGLRenderTarget | null = null;
    private pixels = new Uint8Array(0);

    constructor(
        private readonly renderer: THREE.WebGLRenderer,
        private readonly scene: THREE.Scene,
        private readonly rig: CameraRig,
        /** Things drawn in the view that don't belong in a picture of it, such as the section gizmo. */
        private readonly hidden: () => THREE.Object3D[],
    ) {
        this.canvas.style.width = `${width}px`;
        this.canvas.style.height = `${height}px`;
    }

    /** Shows a standard view below its button. */
    show(preset: ViewPreset, button: HTMLElement) {
        if (!this.draw(preset)) {
            this.hide();
            return;
        }
        this.label.textContent = CameraRig.presets[preset].title;
        this.element.hidden = false;
        const rect = button.getBoundingClientRect();
        const left = rect.left + rect.width / 2 - this.element.offsetWidth / 2;
        this.element.style.left = `${Math.max(4, Math.min(left, window.innerWidth - this.element.offsetWidth - 4))}px`;
        this.element.style.top = `${rect.bottom + 6}px`;
    }

    hide() {
        this.element.hidden = true;
    }

    private draw(preset: ViewPreset): boolean {
        const scale = window.devicePixelRatio;
        const pixelWidth = Math.round(width * scale), pixelHeight = Math.round(height * scale);
        if (this.target?.width !== pixelWidth || this.target.height !== pixelHeight) {
            this.target?.dispose();
            this.target = new THREE.WebGLRenderTarget(pixelWidth, pixelHeight, { samples: 4 });
            this.target.texture.colorSpace = THREE.SRGBColorSpace;
            this.pixels = new Uint8Array(pixelWidth * pixelHeight * 4);
            this.canvas.width = pixelWidth;
            this.canvas.height = pixelHeight;
        }
        const target = this.target;

        const hidden = this.hidden().filter((object) => object.visible);
        hidden.forEach((object) => { object.visible = false; });
        const drawn = this.rig.withPresetView(preset, width / height, (camera) => {
            this.renderer.setRenderTarget(target);
            this.renderer.render(this.scene, camera);
            this.renderer.readRenderTargetPixels(target, 0, 0, pixelWidth, pixelHeight, this.pixels);
            this.renderer.setRenderTarget(null);
            return true;
        }) ?? false;
        hidden.forEach((object) => { object.visible = true; });
        if (!drawn) return false;

        // Rows come from the GPU bottom up
        const image = new ImageData(pixelWidth, pixelHeight);
        const row = pixelWidth * 4;
        for (let y = 0; y < pixelHeight; y++) {
            image.data.set(this.pixels.subarray((pixelHeight - 1 - y) * row, (pixelHeight - y) * row), y * row);
        }
        this.canvas.getContext("2d")!.putImageData(image, 0, 0);
        return true;
    }
}
