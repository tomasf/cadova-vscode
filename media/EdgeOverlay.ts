import * as THREE from "three";
import { seeThroughRenderOrder } from "./customizer/meshes.js";

export type EdgeVisibility = "none" | "sharp" | "all";

interface PartSource {
    owner: THREE.Mesh;
    position: THREE.BufferAttribute;
    pieces: { index: ArrayLike<number>; dark: boolean }[];
    seeThrough: boolean;
}

/**
 * Cadova Viewer's edge modes. Sharp edges are the customizer's own outlines; all edges, every edge of
 * every triangle, are built here the first time they're shown, from the meshes as they were read.
 */
export class EdgeOverlay {
    private readonly parts: PartSource[] = [];
    private readonly sharp: THREE.Object3D[] = [];
    private all: THREE.LineSegments[] | null = null;

    /**
     * Records a model's meshes. Call it before their normals are smoothed, which unshares their
     * vertices: a part's meshes, one per material, still share one position attribute here.
     */
    constructor(object: THREE.Object3D) {
        const byPosition = new Map<THREE.BufferAttribute, PartSource>();
        object.traverse((child) => {
            if (child.name === "sharp-edges") this.sharp.push(child);
            if (!(child instanceof THREE.Mesh) || !child.geometry.index) return;
            const position = child.geometry.attributes.position as THREE.BufferAttribute;
            const part: PartSource = byPosition.get(position) ?? { owner: child, position, pieces: [], seeThrough: false };
            part.seeThrough ||= (child.material as THREE.Material).transparent;
            const color = (child.material as THREE.MeshStandardMaterial).color;
            part.pieces.push({
                index: child.geometry.index.array.slice(),
                dark: color ? color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722 < 0.05 : false,
            });
            if (!byPosition.has(position)) {
                byPosition.set(position, part);
                this.parts.push(part);
            }
        });
    }

    show(visibility: EdgeVisibility) {
        for (const lines of this.sharp) lines.visible = visibility === "sharp";
        if (visibility === "all") this.all ??= this.parts.map((part) => EdgeOverlay.allEdges(part));
        for (const lines of this.all ?? []) lines.visible = visibility === "all";
    }

    dispose() {
        for (const lines of this.all ?? []) {
            lines.removeFromParent();
            lines.geometry.dispose();
            (lines.material as THREE.Material).dispose();
        }
    }

    // Each edge once, light where it borders a dark face so it shows, as the sharp outlines do
    private static allEdges(part: PartSource): THREE.LineSegments {
        const seen = new Set<number | string>();
        const vertexCount = part.position.count;
        const numericKeys = Number.isSafeInteger(vertexCount * vertexCount);
        const vertices: number[] = [];
        const colors: number[] = [];
        const light = new THREE.Color("#8c8c8c");
        for (const { index, dark } of part.pieces) {
            for (let i = 0; i < index.length; i += 3) {
                for (let corner = 0; corner < 3; corner++) {
                    const a = Math.min(index[i + corner], index[i + (corner + 1) % 3]);
                    const b = Math.max(index[i + corner], index[i + (corner + 1) % 3]);
                    const key = numericKeys ? a * vertexCount + b : `${a}:${b}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    vertices.push(part.position.getX(a), part.position.getY(a), part.position.getZ(a),
                        part.position.getX(b), part.position.getY(b), part.position.getZ(b));
                    const color = dark ? light : new THREE.Color(0, 0, 0);
                    colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
                }
            }
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
        geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
        const material = new THREE.LineBasicMaterial({
            vertexColors: true, transparent: true, opacity: 0.6, depthWrite: false, toneMapped: false,
        });
        // The same nudge toward the camera as the sharp outlines, so lines on the surface don't z-fight
        material.onBeforeCompile = (shader) => {
            shader.vertexShader = shader.vertexShader.replace("#include <project_vertex>", `
                #include <project_vertex>
                mvPosition.z += min(max(-mvPosition.z, 0.0), 1000.0) * 0.001;
                gl_Position = projectionMatrix * mvPosition;
            `);
        };
        const lines = new THREE.LineSegments(geometry, material);
        lines.name = "all-edges";
        // Like the sharp outlines, a see-through part's edges are drawn after its faces
        lines.renderOrder = part.seeThrough ? seeThroughRenderOrder.edges : 1;
        part.owner.add(lines);
        return lines;
    }
}
