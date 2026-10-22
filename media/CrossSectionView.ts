import * as THREE from "three";
import { SectionGeometry, type CrossSection } from "./CrossSection";
import { HatchMaterial } from "./HatchMaterial";
import { Palette } from "./Palette";
import { PartSolid } from "./PartSolid";

// How a cut-away part shows while a section is being moved: Cadova Viewer's ghost opacities
const ghostFillOpacity = 0.1;
const ghostEdgeOpacity = 0.4;

/** What the cross-sections are drawn for: the model, its parts, and which section is focused. */
export interface SectionScene {
    sections: CrossSection[];
    hiddenParts: Set<string>;
    /** The section being edited, or hovered in the list, whose cut faces get a bolder hatch. */
    focused: string | null;
    /** The section whose plane is shown. */
    planeShown: string | null;
}

/**
 * Draws a model's cross-sections, as Cadova Viewer does: the model clipped by every enabled section,
 * each cut part's face filled in its color with the section's hatch, a translucent plane where a
 * section is being edited, and while it moves, a faint ghost of what it cuts away.
 */
export class CrossSectionView {
    readonly group = new THREE.Group();
    /** The clipping planes the model's materials share, updated in place. */
    readonly planes: THREE.Plane[] = [];
    private model: THREE.Object3D | null = null;
    private parts: { id: string; part: THREE.Object3D; solid: PartSolid; color: THREE.Color }[] = [];
    private readonly caps = new Map<string, THREE.Mesh<THREE.BufferGeometry, HatchMaterial>>();
    private readonly capGroup = new THREE.Group();
    // Cadova Viewer's plane is a 5% fill with a hatch at 0.32, but SceneKit draws it far fainter than
    // that, about as if its alpha counted twice, so these are what it looks like rather than its numbers
    private readonly locator = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new HatchMaterial({
        color: 0xe6e6e6, transparent: true, opacity: 0.0025, depthWrite: false,
    }));
    private ghost: THREE.Object3D | null = null;
    private readonly ghostPlanes: THREE.Plane[] = [];
    private ghostFade: { start: number; hold: number } | null = null;
    private scene: SectionScene = { sections: [], hiddenParts: new Set(), focused: null, planeShown: null };
    private dirty = false;
    // With materials off, cut faces are white with a grey hatch, as in Cadova Viewer
    private plain = false;
    private static readonly plainFill = new THREE.Color(1, 1, 1);
    private static readonly plainHatch = new THREE.Color(0.6, 0.6, 0.6);

    constructor() {
        this.capGroup.name = "cross-section caps";
        this.locator.material.hatch.hatchAlpha.value = 0.055;
        this.locator.material.hatch.hatchStrength.value = 0.32;
        this.locator.renderOrder = 5;
        this.locator.visible = false;
        this.group.add(this.capGroup, this.locator);
    }

    /** The cut faces, which measurements can land on. */
    get capObjects(): THREE.Object3D {
        return this.capGroup;
    }

    get enabledSections(): CrossSection[] {
        return this.scene.sections.filter((section) => section.enabled);
    }

    /**
     * Takes a new model. `solids` are its parts' surfaces, recorded before smoothing; the model's
     * materials start clipping with the shared planes.
     */
    setModel(model: THREE.Object3D, parts: { id: string; part: THREE.Object3D; solid: PartSolid }[]) {
        this.model = model;
        this.parts = parts.map((entry) => ({ ...entry, color: PartColor.of(entry.part) }));
        for (const cap of this.caps.values()) CrossSectionView.dispose(cap);
        this.caps.clear();
        this.removeGhost();
        model.traverse((child) => {
            if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
                for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
                    material.clippingPlanes = this.planes;
                }
            }
        });
        this.dirty = true;
    }

    update(scene: SectionScene) {
        this.scene = scene;
        this.dirty = true;
    }

    /** Shows cut faces plain, for when the model's materials are off, or in their parts' colors. */
    setPlain(plain: boolean) {
        if (plain === this.plain) return;
        this.plain = plain;
        this.dirty = true;
    }

    /** Brings the clipping, cut faces and plane up to date, at most once a frame. */
    render(time: number, modelBox: THREE.Box3) {
        if (this.ghostFade) this.fadeGhost(time);
        if (!this.dirty || !this.model) return;
        this.dirty = false;
        const enabled = this.enabledSections.slice(0, 8);

        this.planes.length = enabled.length;
        enabled.forEach((section, index) => {
            this.planes[index] = SectionGeometry.clippingPlane(section, this.planes[index] ?? new THREE.Plane());
        });
        // A cut model shows its insides, where the cut faces don't cover them
        const side = enabled.length > 0 ? THREE.DoubleSide : THREE.FrontSide;
        this.model.traverse((child) => {
            if (!(child instanceof THREE.Mesh)) return;
            for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
                if (material.side !== side) { material.side = side; material.needsUpdate = true; }
            }
        });

        this.updateCaps(enabled, modelBox);
        this.updateLocator(modelBox);
        this.updateGhostPlanes(enabled);
    }

    /**
     * Shows what the enabled sections cut away as a faint ghost, while a section is dragged, or
     * briefly with `flash`, after a section is added, flipped or aligned.
     */
    showGhost(flash = false) {
        if (!this.model) return;
        this.ghost ??= this.buildGhost(this.model);
        this.ghost.visible = true;
        this.setGhostOpacity(1);
        this.ghostFade = flash ? { start: performance.now(), hold: 450 } : null;
        this.dirty = true;
    }

    hideGhost() {
        if (this.ghost?.visible) this.ghostFade = { start: performance.now(), hold: 0 };
    }

    private updateCaps(enabled: CrossSection[], modelBox: THREE.Box3) {
        const present = new Set<string>();
        const spacing = SectionGeometry.hatchSpacing(modelBox.getSize(new THREE.Vector3()));
        enabled.forEach((section, index) => {
            const normal = SectionGeometry.normal(section);
            const origin = SectionGeometry.origin(section);
            const others = this.planes.filter((_, other) => other !== index);
            const strength = section.id === this.scene.focused ? 0.75 : 0.2;
            for (const { id, part, solid, color } of this.parts) {
                if (this.scene.hiddenParts.has(id) || !part.visible) continue;
                const key = `${section.id}|${id}`;
                // Slicing is the slow part, so a cut face is only sliced again when its plane moves
                const plane = [...section.origin, ...section.orientation].join(",");
                let cap = this.caps.get(key);
                if (cap?.userData.plane !== plane) {
                    const triangles = solid.section(normal, origin);
                    if (!triangles) continue;
                    if (!cap) {
                        cap = new THREE.Mesh(new THREE.BufferGeometry(), new HatchMaterial({ color }));
                        cap.userData.partID = id;
                        cap.userData.sectionID = section.id;
                        this.caps.set(key, cap);
                        this.capGroup.add(cap);
                    }
                    cap.geometry.dispose();
                    cap.geometry = new THREE.BufferGeometry();
                    cap.geometry.setAttribute("position", new THREE.BufferAttribute(triangles, 3));
                    cap.geometry.computeBoundingSphere();
                    cap.geometry.computeBoundingBox();
                    cap.userData.plane = plane;
                }
                present.add(key);
                // Each cut face is trimmed by the other sections, not its own
                cap.material.clippingPlanes = others;
                cap.material.color.copy(this.plain ? CrossSectionView.plainFill : color);
                cap.material.hatch.hatchColor.value.copy(this.plain ? CrossSectionView.plainHatch : new THREE.Color(Palette.css(section.colorIndex)));
                cap.material.hatch.hatchDirection.value.copy(SectionGeometry.hatchDirection(section));
                cap.material.hatch.hatchSpacing.value = spacing;
                cap.material.hatch.hatchStrength.value = strength;
                cap.visible = true;
            }
        });
        for (const [key, cap] of this.caps) {
            if (present.has(key)) continue;
            CrossSectionView.dispose(cap);
            this.caps.delete(key);
        }
    }

    // A square across the model, in the plane, nudged to the kept side so the cut faces show over it
    private updateLocator(modelBox: THREE.Box3) {
        const section = this.scene.sections.find((section) => section.id === this.scene.planeShown);
        this.locator.visible = !!section && !modelBox.isEmpty();
        if (!section || modelBox.isEmpty()) return;
        const diagonal = modelBox.getSize(new THREE.Vector3()).length();
        const normal = SectionGeometry.normal(section);
        const center = modelBox.getCenter(new THREE.Vector3());
        const distance = normal.dot(SectionGeometry.origin(section));
        const anchor = center.addScaledVector(normal, distance - center.dot(normal) - diagonal * 0.001);
        this.locator.position.copy(anchor);
        this.locator.quaternion.copy(SectionGeometry.quaternion(section));
        this.locator.scale.set(diagonal, diagonal, 1);
        const material = this.locator.material;
        material.hatch.hatchDirection.value.copy(SectionGeometry.hatchDirection(section));
        material.hatch.hatchSpacing.value = SectionGeometry.hatchSpacing(modelBox.getSize(new THREE.Vector3()));
    }

    // The ghost shows only what's past a plane: each plane flipped, and a point drawn if any keeps it
    private updateGhostPlanes(enabled: CrossSection[]) {
        this.ghostPlanes.length = enabled.length;
        enabled.forEach((section, index) => {
            this.ghostPlanes[index] = SectionGeometry.clippingPlane(section, this.ghostPlanes[index] ?? new THREE.Plane()).negate();
        });
        this.ghost?.traverse((child) => {
            if (child.userData.ghostPart) child.visible = !this.scene.hiddenParts.has(child.userData.ghostPart);
        });
    }

    private buildGhost(model: THREE.Object3D): THREE.Object3D {
        const ghost = new THREE.Group();
        ghost.name = "cross-section ghost";
        for (const part of model.children) {
            const copy = part.clone(true);
            copy.userData.ghostPart = part.userData.partNumber ?? part.name;
            copy.traverse((child) => {
                child.renderOrder = 90;
                if (child instanceof THREE.LineSegments) {
                    child.material = new THREE.LineBasicMaterial({
                        color: 0xffffff, transparent: true, opacity: ghostEdgeOpacity, depthWrite: false, toneMapped: false,
                        clippingPlanes: this.ghostPlanes, clipIntersection: true,
                    });
                } else if (child instanceof THREE.Mesh) {
                    child.material = new THREE.MeshBasicMaterial({
                        color: 0xffffff, transparent: true, opacity: ghostFillOpacity, depthWrite: false, side: THREE.DoubleSide,
                        toneMapped: false, clippingPlanes: this.ghostPlanes, clipIntersection: true,
                    });
                }
            });
            ghost.add(copy);
        }
        this.group.add(ghost);
        return ghost;
    }

    // Holds, then fades over 300 ms, like Cadova Viewer's
    private fadeGhost(time: number) {
        const fade = this.ghostFade!;
        const elapsed = time - fade.start - fade.hold;
        if (elapsed < 0) return;
        const opacity = Math.max(0, 1 - elapsed / 300);
        this.setGhostOpacity(opacity);
        if (opacity === 0) {
            this.ghostFade = null;
            if (this.ghost) this.ghost.visible = false;
        }
    }

    private setGhostOpacity(factor: number) {
        this.ghost?.traverse((child) => {
            if (child instanceof THREE.LineSegments) (child.material as THREE.Material).opacity = ghostEdgeOpacity * factor;
            else if (child instanceof THREE.Mesh) (child.material as THREE.Material).opacity = ghostFillOpacity * factor;
        });
    }

    private removeGhost() {
        if (!this.ghost) return;
        this.ghost.removeFromParent();
        this.ghost.traverse((child) => {
            if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) (child.material as THREE.Material).dispose();
        });
        this.ghost = null;
        this.ghostFade = null;
    }

    private static dispose(cap: THREE.Mesh<THREE.BufferGeometry, HatchMaterial>) {
        cap.removeFromParent();
        cap.geometry.dispose();
        cap.material.dispose();
    }
}

/** A part's color for its cut faces: its first material's, as Cadova Viewer uses its main color. */
class PartColor {
    static of(part: THREE.Object3D): THREE.Color {
        let color: THREE.Color | null = null;
        part.traverse((child) => {
            if (!color && child instanceof THREE.Mesh) {
                const material = (Array.isArray(child.material) ? child.material[0] : child.material) as THREE.MeshStandardMaterial;
                color = material.color?.clone() ?? null;
            }
        });
        return color ?? new THREE.Color(0xb3b3b3);
    }
}
