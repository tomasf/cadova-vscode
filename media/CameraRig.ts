import * as THREE from "three";

export type Projection = "perspective" | "orthographic";
export type ViewPreset = "isometric" | "front" | "back" | "left" | "right" | "top" | "bottom";

/** Where a camera is and how much it shows: for an orthographic camera, half the height in view. */
interface Pose {
    position: THREE.Vector3;
    quaternion: THREE.Quaternion;
    halfHeight: number;
}

/** Where the camera is, as a preview remembers it: a pose in plain numbers. */
export interface SavedCamera {
    position: [number, number, number];
    quaternion: [number, number, number, number];
    halfHeight: number;
}

interface Flight {
    from: Pose;
    to: Pose;
    pivot: THREE.Vector3;
    start: number | null;
    duration: number;
}

const worldUp = new THREE.Vector3(0, 0, 1);
const fieldOfView = 30;
const tanHalfFieldOfView = Math.tan(THREE.MathUtils.degToRad(fieldOfView) / 2);

/**
 * A perspective and an orthographic camera, one of them in use, with Cadova Viewer's standard views:
 * the same directions, the same framing, and moving to them by orbiting around the model.
 */
export class CameraRig {
    static readonly presets: Record<ViewPreset, { title: string; axis: THREE.Vector3; up: THREE.Vector3 }> = {
        // Cadova Viewer's isometric axis, about 26.57° above the horizontal
        isometric: {
            title: "Isometric",
            axis: new THREE.Vector3(-Math.cos(THREE.MathUtils.degToRad(35.264)), -Math.cos(THREE.MathUtils.degToRad(35.264)),
                Math.sin(THREE.MathUtils.degToRad(35.264))).normalize(),
            up: worldUp,
        },
        front: { title: "Front", axis: new THREE.Vector3(0, -1, 0), up: worldUp },
        back: { title: "Back", axis: new THREE.Vector3(0, 1, 0), up: worldUp },
        left: { title: "Left", axis: new THREE.Vector3(-1, 0, 0), up: worldUp },
        right: { title: "Right", axis: new THREE.Vector3(1, 0, 0), up: worldUp },
        // Looking straight down or up, the screen's up is where the front view's camera was facing,
        // as if it had tilted to get there
        top: { title: "Top", axis: new THREE.Vector3(0, 0, 1), up: new THREE.Vector3(0, 1, 0) },
        bottom: { title: "Bottom", axis: new THREE.Vector3(0, 0, -1), up: new THREE.Vector3(0, -1, 0) },
    };

    readonly perspective = new THREE.PerspectiveCamera(fieldOfView, 1, 0.1, 10000);
    readonly orthographic = new THREE.OrthographicCamera(-1, 1, 1, -1, -1e5, 1e5);
    private current: THREE.PerspectiveCamera | THREE.OrthographicCamera = this.perspective;
    private aspect = 1;
    private box = new THREE.Box3();
    private flight: Flight | null = null;

    /** Called when the camera in use changes, with the old one and the new one. */
    onCameraChange: (from: THREE.Camera, to: THREE.Camera) => void = () => {};

    get camera(): THREE.PerspectiveCamera | THREE.OrthographicCamera {
        return this.current;
    }

    get projection(): Projection {
        return this.current === this.orthographic ? "orthographic" : "perspective";
    }

    setModelBox(box: THREE.Box3) {
        this.box = box.clone();
        this.updateDepthRange();
    }

    setAspect(aspect: number) {
        this.aspect = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
        this.perspective.aspect = this.aspect;
        this.perspective.updateProjectionMatrix();
        this.setOrthographicHalfHeight(this.orthographic.top);
    }

    /**
     * Switches projection, keeping the model's apparent size: the orthographic view shows as much as
     * the perspective one does at the model's center, as in Cadova Viewer.
     */
    setProjection(projection: Projection) {
        if (projection === this.projection) return;
        this.flight = null;
        const from = this.current;
        const to = projection === "orthographic" ? this.orthographic : this.perspective;
        to.position.copy(from.position);
        to.quaternion.copy(from.quaternion);

        const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(from.quaternion);
        const depth = this.box.isEmpty() ? 1 : this.box.getCenter(new THREE.Vector3()).sub(from.position).dot(forward);
        if (projection === "orthographic") {
            this.orthographic.zoom = 1;
            this.setOrthographicHalfHeight(Math.max(Math.abs(depth), 1e-3) * tanHalfFieldOfView);
        } else {
            const halfHeight = this.orthographic.top / this.orthographic.zoom;
            to.position.addScaledVector(forward, depth - halfHeight / tanHalfFieldOfView);
        }
        this.current = to;
        this.updateDepthRange();
        this.onCameraChange(from, to);
    }

    /** Shows the model from a standard direction, flying there or jumping. */
    show(preset: ViewPreset, animated: boolean) {
        if (this.box.isEmpty()) return;
        const { axis, up } = CameraRig.presets[preset];
        this.fly(this.pose(this.box, axis, up), this.box, animated);
    }

    /**
     * Runs something, such as drawing a picture of a standard view, with the camera in that view as
     * it would frame the model in a picture of the given shape, then puts the camera back. The
     * headlight rides on the camera, so the picture is lit as the view would be.
     */
    withPresetView<T>(preset: ViewPreset, aspect: number, body: (camera: THREE.Camera) => T): T | undefined {
        if (this.box.isEmpty()) return undefined;
        const saved = { pose: this.currentPose(), aspect: this.aspect };
        this.setAspect(aspect);
        const { axis, up } = CameraRig.presets[preset];
        this.apply(this.pose(this.box, axis, up));
        try {
            return body(this.current);
        } finally {
            this.setAspect(saved.aspect);
            this.apply(saved.pose);
        }
    }

    /** Flies to frame a box, such as some of the model's parts, from the direction the view has now. */
    frame(box: THREE.Box3) {
        if (box.isEmpty()) return;
        const axis = new THREE.Vector3(0, 0, 1).applyQuaternion(this.current.quaternion);
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.current.quaternion);
        this.fly(this.pose(box, axis, up), box, true);
    }

    private fly(target: Pose, around: THREE.Box3, animated: boolean) {
        if (!animated) {
            this.flight = null;
            this.apply(target);
            return;
        }
        this.flight = {
            from: this.currentPose(), to: target, pivot: around.getCenter(new THREE.Vector3()),
            start: null, duration: 500,
        };
    }

    /** How much of the world a pixel spans at a point, for drawing things a constant size on screen. */
    worldPerPixel(point: THREE.Vector3, viewHeight: number): number {
        const height = Math.max(viewHeight, 1);
        if (this.current === this.orthographic) {
            return (this.orthographic.top - this.orthographic.bottom) / this.orthographic.zoom / height;
        }
        const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.perspective.quaternion);
        const depth = Math.abs(point.clone().sub(this.perspective.position).dot(forward));
        return 2 * depth * tanHalfFieldOfView / height;
    }

    /** Where the camera is now, to be put back with `restore`. */
    get saved(): SavedCamera {
        const { position, quaternion, halfHeight } = this.currentPose();
        return { position: position.toArray(), quaternion: quaternion.toArray() as SavedCamera["quaternion"], halfHeight };
    }

    /** Puts the camera where it was saved, in whichever projection is in use. */
    restore(saved: SavedCamera) {
        this.flight = null;
        this.apply({
            position: new THREE.Vector3().fromArray(saved.position),
            quaternion: new THREE.Quaternion().fromArray(saved.quaternion).normalize(),
            halfHeight: saved.halfHeight > 0 ? saved.halfHeight : this.orthographic.top,
        });
    }

    /** Stops a flight where it is, such as when the view is grabbed. */
    cancelFlight() {
        this.flight = null;
    }

    update(time: number) {
        const flight = this.flight;
        if (!flight) return;
        flight.start ??= time;
        const t = THREE.MathUtils.clamp((time - flight.start) / flight.duration, 0, 1);
        const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

        // Orbit around the model: the camera's offset from the pivot, in its own frame, blends between
        // the two poses while its orientation turns, rather than moving in a straight line
        const offset = (pose: Pose) => pose.position.clone().sub(flight.pivot)
            .applyQuaternion(pose.quaternion.clone().invert());
        const quaternion = flight.from.quaternion.clone().slerp(flight.to.quaternion, eased);
        const position = offset(flight.from).lerp(offset(flight.to), eased).applyQuaternion(quaternion).add(flight.pivot);
        const halfHeight = Math.exp(THREE.MathUtils.lerp(Math.log(flight.from.halfHeight), Math.log(flight.to.halfHeight), eased));
        this.apply({ position, quaternion, halfHeight });
        if (t >= 1) this.flight = null;
    }

    private currentPose(): Pose {
        const camera = this.current;
        return {
            position: camera.position.clone(),
            quaternion: camera.quaternion.clone(),
            halfHeight: this.orthographic.top / this.orthographic.zoom,
        };
    }

    private apply(pose: Pose) {
        this.current.position.copy(pose.position);
        this.current.quaternion.copy(pose.quaternion);
        if (this.current === this.orthographic) {
            this.orthographic.zoom = 1;
            this.setOrthographicHalfHeight(pose.halfHeight);
        }
        this.current.updateMatrixWorld();
        this.updateDepthRange();
    }

    /**
     * Frames a box looking along an axis, the way Cadova Viewer's `frameBoundingBox` does: the box's
     * corners, projected onto the view, fit with 50% headroom.
     */
    private pose(box: THREE.Box3, axis: THREE.Vector3, viewUp: THREE.Vector3): Pose {
        const margin = 1.5;
        const center = box.getCenter(new THREE.Vector3());
        const right = new THREE.Vector3().crossVectors(viewUp, axis).normalize();
        const up = new THREE.Vector3().crossVectors(axis, right).normalize();
        const quaternion = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, axis));

        let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity, perspectiveDistance = 0;
        const { min, max } = box;
        for (const x of [min.x, max.x]) for (const y of [min.y, max.y]) for (const z of [min.z, max.z]) {
            const offset = new THREE.Vector3(x, y, z).sub(center);
            const u = offset.dot(right), v = offset.dot(up);
            minU = Math.min(minU, u); maxU = Math.max(maxU, u);
            minV = Math.min(minV, v); maxV = Math.max(maxV, v);
            // A perspective camera sees a corner nearer than the center as larger, so it backs off until
            // every corner fits
            const required = Math.max(Math.abs(v), Math.abs(u) / this.aspect) * margin / tanHalfFieldOfView;
            perspectiveDistance = Math.max(perspectiveDistance, offset.dot(axis) + required);
        }

        let width = maxU - minU, height = maxV - minV;
        if (!(width > 0) || !(height > 0)) {
            const size = box.getSize(new THREE.Vector3());
            width = height = Math.max(size.x, size.y, size.z) || 1;
        }
        const halfHeight = Math.max(width / 2 / this.aspect, height / 2) * margin || 1;
        const orthographicDistance = halfHeight / tanHalfFieldOfView;
        const distance = this.current === this.orthographic ? orthographicDistance : perspectiveDistance || orthographicDistance;
        return { position: center.clone().addScaledVector(axis, distance), quaternion, halfHeight };
    }

    private setOrthographicHalfHeight(halfHeight: number) {
        this.orthographic.top = halfHeight;
        this.orthographic.bottom = -halfHeight;
        this.orthographic.left = -halfHeight * this.aspect;
        this.orthographic.right = halfHeight * this.aspect;
        this.orthographic.updateProjectionMatrix();
    }

    // Perspective uses the customizer's range around the model; orthographic one wide enough that
    // nothing is clipped, as in Cadova Viewer
    private updateDepthRange() {
        if (this.box.isEmpty()) return;
        const size = this.box.getSize(new THREE.Vector3()).length();
        const distance = this.perspective.position.distanceTo(this.box.getCenter(new THREE.Vector3()));
        this.perspective.near = Math.max(size / 100, 0.001);
        this.perspective.far = Math.max(size * 100, distance * 2);
        this.perspective.updateProjectionMatrix();
        const extent = Math.max(1e5, distance + size * 2);
        this.orthographic.near = -extent;
        this.orthographic.far = extent;
        this.orthographic.updateProjectionMatrix();
    }
}
