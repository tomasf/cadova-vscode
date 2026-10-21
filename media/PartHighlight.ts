import * as THREE from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import type { EdgeVisibility } from "./EdgeOverlay";

// Cadova Viewer's outline: its color, as written straight to the screen, and its thickness in points
const outlineColor = new THREE.Vector3(0.066, 0.208, 0.804);
const outlineRadius = 5;
// How a hidden part shows while it's highlighted, as in Cadova Viewer
const ghostFillOpacity = 0.1;
const ghostEdgeOpacity = 0.4;

const quadVertexShader = `
    varying vec2 uv0;
    void main() {
        uv0 = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
    }
`;

/**
 * Cadova Viewer's highlight for a part hovered in a parts list: an outline around its whole
 * silhouette, drawn over everything, and for a hidden part a faint ghost of it to outline.
 *
 * The outline is a port of Viewer's post-process: the part is drawn as a silhouette mask, the mask
 * is dilated by the outline's thickness, and the band between the two is drawn over the view.
 */
export class PartHighlight {
    // Multisampled, so thin features don't break the outline into dots
    private readonly mask = new THREE.WebGLRenderTarget(1, 1, { samples: 4 });
    private readonly dilatedH = new THREE.WebGLRenderTarget(1, 1);
    private readonly dilated = new THREE.WebGLRenderTarget(1, 1);
    private readonly maskScene = new THREE.Scene();
    private readonly maskMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
    private readonly dilateH: FullScreenQuad;
    private readonly dilateV: FullScreenQuad;
    private readonly outline: FullScreenQuad;
    private readonly size = new THREE.Vector2();
    private ghost: THREE.Object3D | null = null;

    constructor(private readonly renderer: THREE.WebGLRenderer) {
        const dilate = (direction: string) => new FullScreenQuad(new THREE.ShaderMaterial({
            uniforms: { mask: { value: null }, texel: { value: new THREE.Vector2() }, radius: { value: 1 } },
            vertexShader: quadVertexShader,
            // A separable max filter: across, then down, grows the silhouette in every direction
            fragmentShader: `
                uniform sampler2D mask;
                uniform vec2 texel;
                uniform float radius;
                varying vec2 uv0;
                void main() {
                    float m = 0.0;
                    for (int i = -64; i <= 64; i++) {
                        if (abs(float(i)) > radius) continue;
                        m = max(m, texture2D(mask, uv0 + ${direction} * float(i) * texel).g);
                    }
                    gl_FragColor = vec4(m, m, m, 1.0);
                }
            `,
            depthTest: false, depthWrite: false,
        }));
        this.dilateH = dilate("vec2(1.0, 0.0)");
        this.dilateV = dilate("vec2(0.0, 1.0)");
        this.outline = new FullScreenQuad(new THREE.ShaderMaterial({
            uniforms: {
                mask: { value: this.mask.texture }, dilated: { value: this.dilated.texture },
                texel: { value: new THREE.Vector2() }, color: { value: outlineColor },
            },
            vertexShader: quadVertexShader,
            // The band is the dilated silhouette minus the silhouette. Each mask is blurred, then cut
            // back to a step about a pixel wide, so the band's edges are smooth rather than stepped.
            fragmentShader: `
                uniform sampler2D mask;
                uniform sampler2D dilated;
                uniform vec2 texel;
                uniform vec3 color;
                varying vec2 uv0;
                float blurred(sampler2D tex) {
                    float sum = 0.0;
                    for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
                        sum += texture2D(tex, uv0 + vec2(float(x), float(y)) * texel).g;
                    }
                    return sum / 9.0;
                }
                float step1px(float v) {
                    return clamp((v - 0.5) / max(fwidth(v), 1e-5) + 0.5, 0.0, 1.0);
                }
                void main() {
                    float edge = clamp(step1px(blurred(dilated)) - step1px(blurred(mask)), 0.0, 1.0);
                    gl_FragColor = vec4(color, edge);
                }
            `,
            transparent: true, depthTest: false, depthWrite: false,
        }));
        for (const target of [this.mask, this.dilatedH, this.dilated]) target.texture.minFilter = THREE.LinearFilter;
    }

    /**
     * Highlights a part, or nothing. A hidden part gets a ghost with the edges that are shown,
     * added beside it; the outline traces the part either way.
     */
    show(part: THREE.Object3D | null, hidden: boolean, edges: EdgeVisibility) {
        this.clear();
        if (!part) return;
        part.updateMatrixWorld(true);
        part.traverse((child) => {
            if (!(child instanceof THREE.Mesh)) return;
            const silhouette = new THREE.Mesh(child.geometry, this.maskMaterial);
            silhouette.matrixAutoUpdate = false;
            silhouette.matrix.copy(child.matrixWorld);
            this.maskScene.add(silhouette);
        });
        if (hidden) this.ghost = PartHighlight.ghost(part, edges);
    }

    get isActive(): boolean {
        return this.maskScene.children.length > 0;
    }

    /** Draws the outline over what's on screen. */
    render(camera: THREE.Camera) {
        if (!this.isActive) return;
        const renderer = this.renderer;
        renderer.getDrawingBufferSize(this.size);
        for (const target of [this.mask, this.dilatedH, this.dilated]) {
            if (target.width !== this.size.x || target.height !== this.size.y) target.setSize(this.size.x, this.size.y);
        }
        const texel = new THREE.Vector2(1 / this.size.x, 1 / this.size.y);
        const radius = outlineRadius * renderer.getPixelRatio();
        const clearColor = renderer.getClearColor(new THREE.Color());
        const clearAlpha = renderer.getClearAlpha();
        const autoClear = renderer.autoClear;

        renderer.setClearColor(0x000000, 0);
        renderer.autoClear = true;
        renderer.setRenderTarget(this.mask);
        renderer.render(this.maskScene, camera);
        for (const [quad, input, output] of [
            [this.dilateH, this.mask, this.dilatedH], [this.dilateV, this.dilatedH, this.dilated],
        ] as const) {
            const uniforms = (quad.material as THREE.ShaderMaterial).uniforms;
            uniforms.mask.value = input.texture;
            uniforms.texel.value.copy(texel);
            uniforms.radius.value = radius;
            renderer.setRenderTarget(output);
            quad.render(renderer);
        }
        renderer.setRenderTarget(null);
        renderer.autoClear = false;
        (this.outline.material as THREE.ShaderMaterial).uniforms.texel.value.copy(texel);
        this.outline.render(renderer);

        renderer.autoClear = autoClear;
        renderer.setClearColor(clearColor, clearAlpha);
    }

    private clear() {
        for (const silhouette of [...this.maskScene.children]) this.maskScene.remove(silhouette);
        if (this.ghost) {
            this.ghost.removeFromParent();
            this.ghost.traverse((child) => {
                if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) (child.material as THREE.Material).dispose();
            });
            this.ghost = null;
        }
    }

    // A see-through copy of a part, sharing its geometry, with only the edges that are shown
    private static ghost(part: THREE.Object3D, edges: EdgeVisibility): THREE.Object3D {
        const ghost = part.clone(true);
        ghost.visible = true;
        const shownLines = edges === "sharp" ? "sharp-edges" : edges === "all" ? "all-edges" : null;
        const removed: THREE.Object3D[] = [];
        ghost.traverse((child) => {
            child.renderOrder = 100;
            if (child instanceof THREE.LineSegments) {
                if (child.name !== shownLines) return removed.push(child);
                child.visible = true;
                child.material = new THREE.LineBasicMaterial({
                    color: 0xffffff, transparent: true, opacity: ghostEdgeOpacity, depthWrite: false, toneMapped: false,
                });
            } else if (child instanceof THREE.Mesh) {
                child.material = new THREE.MeshBasicMaterial({
                    color: 0xffffff, transparent: true, opacity: ghostFillOpacity, depthWrite: false,
                    side: THREE.DoubleSide, toneMapped: false,
                });
            }
        });
        for (const child of removed) child.removeFromParent();
        part.parent?.add(ghost);
        return ghost;
    }
}
