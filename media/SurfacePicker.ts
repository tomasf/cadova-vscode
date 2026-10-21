import * as THREE from "three";
import { acceleratedRaycast, computeBoundsTree } from "three-mesh-bvh";
import { SectionGeometry, type CrossSection } from "./CrossSection";

// Raycasts against a spatial index of each mesh, built the first time it's needed, rather than
// testing every triangle: models can have hundreds of thousands, and picking follows the pointer
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

/** What the picker looks into. */
export interface PickTarget {
    readonly camera: THREE.Camera;
    readonly canvas: HTMLCanvasElement;
    readonly model: THREE.Object3D | null;
    /** The cross-sections' cut faces. */
    readonly caps: THREE.Object3D;
    readonly sections: CrossSection[];
}

interface Corner {
    point: THREE.Vector3;
    part: THREE.Object3D;
}

/**
 * Finds points on the model under the pointer for measuring, as Cadova Viewer does: the nearest
 * surface you can see (not hidden, not cut away, or a cut face), the nearest visible corner, or a
 * point along an axis through another point.
 */
export class SurfacePicker {
    private corners: Corner[] = [];
    private projected: { key: string; screen: Float32Array } | null = null;

    constructor(private readonly target: PickTarget) {}

    /** Indexes a new model's meshes and gathers its corners: the ends of its sharp edges. */
    modelChanged() {
        this.projected = null;
        const model = this.target.model;
        this.corners = [];
        if (!model) return;
        model.updateMatrixWorld(true);
        const seen = new Set<string>();
        for (const part of model.children) {
            part.traverse((child) => {
                if (!(child instanceof THREE.LineSegments) || child.name !== "sharp-edges") return;
                const position = child.geometry.attributes.position as THREE.BufferAttribute;
                for (let i = 0; i < position.count; i++) {
                    const point = new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(child.matrixWorld);
                    const key = `${point.x.toFixed(4)},${point.y.toFixed(4)},${point.z.toFixed(4)}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    this.corners.push({ point, part });
                }
            });
        }
    }

    /** The nearest visible surface point at a point in the window, or null if there's none. */
    surfacePoint(x: number, y: number): THREE.Vector3 | null {
        return this.nearestHit(this.raycaster(x, y))?.point ?? null;
    }

    /**
     * The visible corner nearest a point in the window, at any distance: while snapping, a
     * measurement only takes corners, so the pointer just has to say which one.
     */
    nearestCorner(x: number, y: number): THREE.Vector3 | null {
        const screen = this.screenCorners();
        const rect = this.target.canvas.getBoundingClientRect();
        const px = x - rect.left, py = y - rect.top;
        const order: { index: number; distance: number }[] = [];
        for (let i = 0; i < this.corners.length; i++) {
            if (Number.isNaN(screen[i * 2])) continue;
            order.push({ index: i, distance: Math.hypot(screen[i * 2] - px, screen[i * 2 + 1] - py) });
        }
        order.sort((a, b) => a.distance - b.distance);
        // The nearest ones, until one isn't behind the model
        const camera = this.target.camera.getWorldPosition(new THREE.Vector3());
        for (const { index } of order.slice(0, 64)) {
            const { point } = this.corners[index];
            const hit = this.nearestHit(this.raycaster(screen[index * 2] + rect.left, screen[index * 2 + 1] + rect.top));
            if (!hit || hit.point.distanceTo(camera) >= point.distanceTo(camera) * 0.98) return point.clone();
        }
        return null;
    }

    /**
     * A point on an axis through `start`, along whichever axis runs most like the pointer's
     * direction from it on screen: the axis's closest point to the ray through the pointer.
     */
    axisPoint(x: number, y: number, start: THREE.Vector3): THREE.Vector3 | null {
        const startScreen = this.toScreen(start);
        const rect = this.target.canvas.getBoundingClientRect();
        const delta = new THREE.Vector2(x - rect.left - startScreen.x, y - rect.top - startScreen.y);
        if (delta.length() < 1e-3) return start.clone();
        delta.normalize();
        let best = new THREE.Vector3(1, 0, 0), bestScore = -1;
        for (const axis of [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)]) {
            const tip = this.toScreen(start.clone().add(axis)).sub(startScreen);
            if (tip.length() < 1e-6) continue;
            const score = Math.abs(delta.dot(tip.normalize()));
            if (score > bestScore) { bestScore = score; best = axis; }
        }
        const ray = this.raycaster(x, y).ray;
        const offset = start.clone().sub(ray.origin);
        const b = best.dot(ray.direction);
        const c = ray.direction.dot(ray.direction);
        const denominator = c - b * b;
        if (Math.abs(denominator) < 1e-9) return null;
        const t = (b * ray.direction.dot(offset) - c * best.dot(offset)) / denominator;
        return start.clone().addScaledVector(best, t);
    }

    private nearestHit(raycaster: THREE.Raycaster): THREE.Intersection | null {
        const model = this.target.model;
        if (!model) return null;
        this.index(model);
        const hits = raycaster.intersectObjects([model, this.target.caps], true);
        return hits.find((hit) => hit.object instanceof THREE.Mesh && SurfacePicker.shown(hit.object) && !this.cutAway(hit)) ?? null;
    }

    // A cut face lies on its own section's plane, so only the others can hide it
    private cutAway(hit: THREE.Intersection): boolean {
        const own = hit.object.userData.sectionID;
        return this.target.sections.some((section) => section.id !== own && SectionGeometry.hides(section, hit.point, 1e-4));
    }

    private index(model: THREE.Object3D) {
        model.traverse((child) => {
            if (child instanceof THREE.Mesh && !child.geometry.boundsTree) child.geometry.computeBoundsTree();
        });
    }

    // Whether an object and everything it's in are shown
    private static shown(object: THREE.Object3D): boolean {
        for (let current: THREE.Object3D | null = object; current; current = current.parent) {
            if (!current.visible) return false;
        }
        return true;
    }

    // The corners' places on screen, or NaN for those that can't be seen, kept while nothing changes
    private screenCorners(): Float32Array {
        const camera = this.target.camera;
        const rect = this.target.canvas.getBoundingClientRect();
        const key = [...camera.matrixWorld.elements, ...camera.projectionMatrix.elements, rect.width, rect.height,
            JSON.stringify(this.target.sections), this.target.model?.children.map((part) => part.visible ? 1 : 0).join("")].join(",");
        if (this.projected?.key === key) return this.projected.screen;
        const screen = new Float32Array(this.corners.length * 2);
        this.corners.forEach(({ point, part }, i) => {
            const hidden = !SurfacePicker.shown(part) || this.target.sections.some((section) => SectionGeometry.hides(section, point));
            const projected = point.clone().project(camera);
            const offScreen = Math.abs(projected.x) > 1.05 || Math.abs(projected.y) > 1.05 || projected.z > 1 || projected.z < -1;
            screen[i * 2] = hidden || offScreen ? NaN : (projected.x + 1) / 2 * rect.width;
            screen[i * 2 + 1] = (1 - projected.y) / 2 * rect.height;
        });
        this.projected = { key, screen };
        return screen;
    }

    private toScreen(point: THREE.Vector3): THREE.Vector2 {
        const rect = this.target.canvas.getBoundingClientRect();
        const projected = point.clone().project(this.target.camera);
        return new THREE.Vector2((projected.x + 1) / 2 * rect.width, (1 - projected.y) / 2 * rect.height);
    }

    private raycaster(x: number, y: number): THREE.Raycaster {
        const rect = this.target.canvas.getBoundingClientRect();
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(new THREE.Vector2((x - rect.left) / rect.width * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1), this.target.camera);
        return raycaster;
    }
}
