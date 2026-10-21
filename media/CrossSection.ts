import * as THREE from "three";

export type Axis = "x" | "y" | "z";

/**
 * A cutting plane that hides everything on one side of it, as in Cadova Viewer. The plane passes
 * through `origin` with the normal that `orientation` turns +Z into; what's past the plane along the
 * normal is cut away. Plain numbers, so a preview can keep its sections in its saved state.
 */
export interface CrossSection {
    id: string;
    origin: [number, number, number];
    /** A quaternion, as x, y, z, w. */
    orientation: [number, number, number, number];
    enabled: boolean;
    colorIndex: number;
}

/** Cadova Viewer's cross-section geometry: the plane, flipping and aligning it, and its hatch. */
export class SectionGeometry {
    static readonly axes: Record<Axis, THREE.Vector3> = {
        x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1),
    };

    static quaternion(section: CrossSection): THREE.Quaternion {
        return new THREE.Quaternion(...section.orientation);
    }

    static origin(section: CrossSection): THREE.Vector3 {
        return new THREE.Vector3(...section.origin);
    }

    /** The plane's unit normal, pointing toward the side that's cut away. */
    static normal(section: CrossSection): THREE.Vector3 {
        return new THREE.Vector3(0, 0, 1).applyQuaternion(SectionGeometry.quaternion(section)).normalize();
    }

    /** The plane as three.js clips with it: what it keeps is on its positive side. */
    static clippingPlane(section: CrossSection, target = new THREE.Plane()): THREE.Plane {
        const normal = SectionGeometry.normal(section);
        return target.set(normal.clone().negate(), normal.dot(SectionGeometry.origin(section)));
    }

    /** Whether a point is cut away by the section, past its plane by more than a tolerance. */
    static hides(section: CrossSection, point: THREE.Vector3, tolerance = 1e-4): boolean {
        const normal = SectionGeometry.normal(section);
        return point.dot(normal) > normal.dot(SectionGeometry.origin(section)) + tolerance;
    }

    static withOrientation(section: CrossSection, quaternion: THREE.Quaternion): CrossSection {
        return { ...section, orientation: [quaternion.x, quaternion.y, quaternion.z, quaternion.w] };
    }

    static withOrigin(section: CrossSection, origin: THREE.Vector3): CrossSection {
        return { ...section, origin: [origin.x, origin.y, origin.z] };
    }

    /** Keeps the other half: a half turn about an axis in the plane. */
    static flipped(section: CrossSection): CrossSection {
        const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
        return SectionGeometry.withOrientation(section, SectionGeometry.quaternion(section).multiply(turn));
    }

    /** The orientation that turns +Z into a direction, also for the exact opposite of +Z. */
    static orientation(toward: THREE.Vector3): THREE.Quaternion {
        const z = new THREE.Vector3(0, 0, 1);
        const direction = toward.clone().normalize();
        if (direction.dot(z) < -0.5) {
            const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
            return new THREE.Quaternion().setFromUnitVectors(z.clone().negate(), direction).multiply(turn);
        }
        return new THREE.Quaternion().setFromUnitVectors(z, direction);
    }

    static aligned(section: CrossSection, axis: Axis): CrossSection {
        return SectionGeometry.withOrientation(section, SectionGeometry.orientation(SectionGeometry.axes[axis]));
    }

    static isAligned(section: CrossSection, axis: Axis): boolean {
        return SectionGeometry.normal(section).dot(SectionGeometry.axes[axis]) > 0.9999;
    }

    static isAxisAligned(section: CrossSection): boolean {
        const normal = SectionGeometry.normal(section);
        return Object.values(SectionGeometry.axes).some((axis) => Math.abs(normal.dot(axis)) > 0.9999);
    }

    /** Turns the normal to the nearest signed axis, keeping the origin and the half that's kept. */
    static snappedToNearestAxis(section: CrossSection): CrossSection {
        const normal = SectionGeometry.normal(section);
        let best = new THREE.Vector3(0, 0, 1), bestDot = -Infinity;
        for (const axis of Object.values(SectionGeometry.axes)) {
            for (const sign of [1, -1]) {
                const direction = axis.clone().multiplyScalar(sign);
                if (direction.dot(normal) > bestDot) { bestDot = direction.dot(normal); best = direction; }
            }
        }
        return SectionGeometry.withOrientation(section, SectionGeometry.orientation(best));
    }

    /** A diagonal direction in the plane, for the hatch on its cut faces. */
    static hatchDirection(section: CrossSection): THREE.Vector3 {
        const normal = SectionGeometry.normal(section);
        const reference = Math.abs(normal.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
        const u = new THREE.Vector3().crossVectors(reference, normal).normalize();
        const v = new THREE.Vector3().crossVectors(normal, u);
        return u.add(v).normalize();
    }

    /** The hatch's stripe spacing for a model of a size, so it reads the same on any model. */
    static hatchSpacing(modelSize: THREE.Vector3): number {
        return Math.max(Math.max(modelSize.x, modelSize.y, modelSize.z) / 90, 0.3);
    }
}
