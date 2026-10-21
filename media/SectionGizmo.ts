import * as THREE from "three";
import { SectionGeometry, type Axis, type CrossSection } from "./CrossSection";

export type Handle = { kind: "translate" | "rotate"; axis: Axis };

/** Whether the handles follow the section's plane, or the world's axes (with Shift held). */
export type GizmoSpace = "plane" | "world";

// Cadova Viewer's axis colors
const axisColors: Record<Axis, number> = { x: 0xff453a, y: 0x30d158, z: 0x0a84ff };

/**
 * The handles for moving the section being edited, after Cadova Viewer's: by default two rings that
 * tilt the plane and an arrow that slides it along its normal; with Shift, arrows and rings for all
 * three world axes. It's drawn over everything, at a constant size on screen, in the middle of the
 * view at about the model's depth.
 */
export class SectionGizmo {
    readonly root = new THREE.Group();
    private readonly sets: Record<GizmoSpace, THREE.Group> = { plane: new THREE.Group(), world: new THREE.Group() };
    private readonly handles: { handle: Handle; space: GizmoSpace; top: THREE.Object3D; materials: THREE.MeshBasicMaterial[]; thicken: (on: boolean) => void }[] = [];
    private hovered: Handle | null = null;
    private active: Handle | null = null;
    private depthAnchor = new THREE.Vector3();
    space: GizmoSpace = "plane";

    // The gizmo's size on screen, in pixels from its center to its rings
    static readonly screenRadius = 140;

    constructor() {
        this.root.name = "cross-section gizmo";
        this.root.visible = false;
        // Plane space: rings about the plane's own X and Y aim its normal, the arrow along Z moves it
        this.sets.plane.add(this.ring("x", "plane"), this.ring("y", "plane"), this.arrow("z", "plane"), this.cube({ kind: "translate", axis: "z" }, "plane"));
        for (const axis of ["x", "y", "z"] as Axis[]) this.sets.world.add(this.ring(axis, "world"), this.arrow(axis, "world"));
        this.sets.world.add(this.cube(null, "world"));
        this.root.add(this.sets.plane, this.sets.world);
    }

    /** Shows the gizmo for a section, oriented to it, or to the world in world space. */
    show(section: CrossSection, depthAnchor: THREE.Vector3, space: GizmoSpace, interactive: boolean) {
        this.space = space;
        this.root.quaternion.copy(space === "world" ? new THREE.Quaternion() : SectionGeometry.quaternion(section));
        this.sets.plane.visible = space === "plane";
        this.sets.world.visible = space === "world";
        this.depthAnchor.copy(depthAnchor);
        this.root.visible = true;
        const opacity = interactive ? 1 : 0.35;
        for (const entry of this.handles) for (const material of entry.materials) material.opacity = opacity * this.handleOpacity(entry.handle);
    }

    hide() {
        this.root.visible = false;
        this.setHovered(null);
    }

    /**
     * Keeps the gizmo in the middle of the view, at the depth of a point near the model, and the same
     * size on screen. During a drag it stays where the drag started.
     */
    follow(camera: THREE.Camera, worldPerPixel: (point: THREE.Vector3) => number, dragging: boolean) {
        if (!this.root.visible) return;
        if (!dragging) {
            const origin = camera.getWorldPosition(new THREE.Vector3());
            const forward = camera.getWorldDirection(new THREE.Vector3());
            this.root.position.copy(origin).addScaledVector(forward, Math.max(origin.distanceTo(this.depthAnchor), 0.01));
        }
        this.root.scale.setScalar(SectionGizmo.screenRadius * worldPerPixel(this.root.position));
    }

    /**
     * The handle under a ray. Exactly drawn handles win over the wider invisible targets around
     * thin ones, so a handle inside another's target can still be grabbed.
     */
    handleAt(raycaster: THREE.Raycaster): Handle | null {
        if (!this.root.visible) return null;
        this.root.updateMatrixWorld(true);
        const set = this.sets[this.space];
        for (const target of ["visible", "proxy"]) {
            const hits = raycaster.intersectObject(set, true).filter((hit) => hit.object.userData.hitTarget === target);
            if (hits.length > 0) return hits[0].object.userData.handle ?? null;
        }
        return null;
    }

    /** Brightens and thickens the handle under the pointer. */
    setHovered(handle: Handle | null) {
        if (SectionGizmo.same(handle, this.hovered)) return;
        this.hovered = handle;
        for (const entry of this.handles) {
            const on = entry.space === this.space && SectionGizmo.same(entry.handle, handle);
            entry.thicken(on);
            for (const material of entry.materials) {
                material.color.set(material.userData.baseColor);
                if (on) material.color.lerp(new THREE.Color(0xffffff), 0.35);
            }
        }
    }

    /** Dims the handles other than the one being dragged, or none. */
    setActive(handle: Handle | null) {
        this.active = handle;
        for (const entry of this.handles) {
            for (const material of entry.materials) material.opacity = this.handleOpacity(entry.handle);
        }
    }

    private handleOpacity(handle: Handle): number {
        return !this.active || SectionGizmo.same(handle, this.active) ? 1 : 0.1;
    }

    private static same(a: Handle | null, b: Handle | null): boolean {
        return a?.kind === b?.kind && a?.axis === b?.axis;
    }

    private material(color: number): THREE.MeshBasicMaterial {
        const material = new THREE.MeshBasicMaterial({
            color, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
        });
        material.userData.baseColor = color;
        return material;
    }

    private target(geometry: THREE.BufferGeometry, handle: Handle | null): THREE.Mesh {
        const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ visible: false }));
        mesh.userData = { hitTarget: "proxy", handle };
        return mesh;
    }

    private drawn(mesh: THREE.Mesh, handle: Handle | null, order = 100): THREE.Mesh {
        mesh.userData = { hitTarget: "visible", handle };
        mesh.renderOrder = order;
        return mesh;
    }

    // Turns geometry built around +Z (rings) or along +Y (arrows) to an axis
    private static turn(axis: Axis, from: THREE.Vector3): THREE.Quaternion {
        return new THREE.Quaternion().setFromUnitVectors(from, SectionGeometry.axes[axis]);
    }

    private ring(axis: Axis, space: GizmoSpace): THREE.Object3D {
        const handle: Handle = { kind: "rotate", axis };
        const material = this.material(axisColors[axis]);
        const ring = this.drawn(new THREE.Mesh(new THREE.TorusGeometry(0.58, 0.011, 8, 96), material), handle);
        const node = new THREE.Group();
        node.quaternion.copy(SectionGizmo.turn(axis, new THREE.Vector3(0, 0, 1)));
        node.add(ring, this.target(new THREE.TorusGeometry(0.58, 0.15, 6, 48), handle));
        this.handles.push({
            handle, space, top: node, materials: [material],
            thicken: (on) => { ring.geometry.dispose(); ring.geometry = new THREE.TorusGeometry(0.58, on ? 0.02 : 0.011, 8, 96); },
        });
        return node;
    }

    private arrow(axis: Axis, space: GizmoSpace): THREE.Object3D {
        const handle: Handle = { kind: "translate", axis };
        const material = this.material(axisColors[axis]);
        const shaft = this.drawn(new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.72, 12), material), handle);
        shaft.position.y = 0.36;
        const tip = this.drawn(new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.18, 24), material), handle);
        tip.position.y = 0.81;
        const target = this.target(new THREE.CylinderGeometry(0.18, 0.18, 1.05, 12), handle);
        target.position.y = 0.45;
        const node = new THREE.Group();
        node.quaternion.copy(SectionGizmo.turn(axis, new THREE.Vector3(0, 1, 0)));
        node.add(shaft, tip, target);
        this.handles.push({
            handle, space, top: node, materials: [material],
            thicken: (on) => {
                shaft.geometry.dispose();
                shaft.geometry = new THREE.CylinderGeometry(on ? 0.019 : 0.011, on ? 0.019 : 0.011, 0.72, 12);
                tip.geometry.dispose();
                tip.geometry = new THREE.ConeGeometry(on ? 0.066 : 0.05, 0.18, 24);
            },
        });
        return node;
    }

    // The center cube: the plane's arrow handle too in plane space, just a marker in world space
    private cube(handle: Handle | null, space: GizmoSpace): THREE.Object3D {
        const material = this.material(0xd9d9d9);
        const cube = this.drawn(new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.13, 0.13), material), handle, 101);
        if (handle) {
            cube.add(this.target(new THREE.BoxGeometry(0.34, 0.34, 0.34), handle));
            this.handles.push({ handle, space, top: cube, materials: [material], thicken: (on) => cube.scale.setScalar(on ? 1.27 : 1) });
        }
        return cube;
    }
}
