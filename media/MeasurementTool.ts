import * as THREE from "three";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { Palette } from "./Palette";
import type { SurfacePicker } from "./SurfacePicker";

type Point = [number, number, number];

/** A measurement, as Cadova Viewer has them: a point, or a length between two. */
export interface Measurement {
    id: string;
    colorIndex: number;
    start: Point;
    end?: Point;
    /** A single point under the pointer; a length whose end follows the pointer; or a finished one. */
    phase: "coordinate" | "inProgress" | "complete";
}

/** What the tool tells the view about. */
export interface MeasurementEvents {
    /** The measurements, with the point under the pointer last while measuring. */
    measurementsChanged(measurements: Measurement[]): void;
    activeChanged(active: boolean): void;
}

// Cadova Viewer's sizes on screen, in pixels: the dots' and the line's radius
const dotRadius = 4.5;
const lineRadius = 1.6;

/**
 * Measuring, as in Cadova Viewer. In measure mode a dot follows the model under the pointer; a click
 * starts a length and a second click finishes it, which goes back to viewing. Command snaps to the
 * nearest visible corner, Shift keeps the length along an axis, and Option centers it on its first
 * point. Measurements are drawn at a constant size on screen, faintly dashed where the model hides
 * them.
 */
export class MeasurementTool {
    readonly group = new THREE.Group();
    private measurements: Measurement[];
    private hover: Measurement | null = null;
    private anchor: THREE.Vector3 | null = null;
    private nextColor: number;
    private active = false;
    private highlighted: string | null = null;
    private pointer: { x: number; y: number; command: boolean; shift: boolean; option: boolean } | null = null;
    private press: { x: number; y: number } | null = null;
    private readonly visuals = new Map<string, MeasurementVisual>();
    private readonly readout = document.getElementById("measure-readout")!;

    constructor(
        private readonly canvas: HTMLCanvasElement,
        private readonly picker: SurfacePicker,
        private readonly events: MeasurementEvents,
        saved: Measurement[],
    ) {
        this.measurements = saved.filter((measurement) => measurement.phase === "complete");
        this.nextColor = this.measurements.reduce((next, measurement) => Math.max(next, measurement.colorIndex + 1), 0);
        canvas.addEventListener("pointermove", (event) => this.pointerMove(event));
        canvas.addEventListener("pointerleave", () => { this.pointer = null; this.track(); });
        canvas.addEventListener("pointerdown", (event) => {
            this.press = this.active && event.button === 0 && !event.ctrlKey ? { x: event.clientX, y: event.clientY } : null;
        });
        canvas.addEventListener("pointerup", (event) => this.pointerUp(event));
        for (const type of ["keydown", "keyup"] as const) {
            window.addEventListener(type, (event) => {
                if (type === "keydown" && event.key === "Escape" && this.active) this.escape();
                if (["Meta", "Control", "Shift", "Alt"].includes(event.key) && this.pointer) {
                    this.pointer = { ...this.pointer, command: event.metaKey || event.ctrlKey, shift: event.shiftKey, option: event.altKey };
                    this.track();
                }
            });
        }
        this.reconcile();
    }

    get isActive(): boolean {
        return this.active;
    }

    /** Turns measure mode on or off. Leaving it drops a length that isn't finished. */
    setActive(active: boolean) {
        if (active === this.active) return;
        this.active = active;
        this.canvas.classList.toggle("measuring", active);
        if (!active) this.cancel();
        else this.track();
        this.events.activeChanged(active);
    }

    /** Emphasizes a measurement, such as one hovered in the list, so it shows even behind the model. */
    highlight(id: string | null) {
        this.highlighted = id;
        for (const [key, visual] of this.visuals) visual.setHighlighted(key === id);
    }

    delete(id: string) {
        this.measurements = this.measurements.filter((measurement) => measurement.id !== id);
        if (!this.measurements.some((measurement) => measurement.phase === "inProgress")) this.anchor = null;
        this.changed();
    }

    deleteAll() {
        this.measurements = [];
        this.anchor = null;
        this.nextColor = 0;
        this.changed();
    }

    /** Keeps dots and lines the same size on screen. */
    render(worldPerPixel: (point: THREE.Vector3) => number) {
        for (const visual of this.visuals.values()) visual.resize(worldPerPixel);
    }

    private pointerMove(event: PointerEvent) {
        this.pointer = { x: event.clientX, y: event.clientY, command: event.metaKey || (event.ctrlKey && event.buttons === 0), shift: event.shiftKey, option: event.altKey };
        // While a drag orbits the view, the point under the pointer isn't what's being aimed at
        if (event.buttons === 0) this.track();
    }

    private pointerUp(event: PointerEvent) {
        const press = this.press;
        this.press = null;
        if (!press || !this.active || event.button !== 0) return;
        if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 4) return;
        const point = this.pick();
        if (point) this.commit(point);
    }

    private escape() {
        if (this.measurements.some((measurement) => measurement.phase === "inProgress")) this.cancel();
        else this.setActive(false);
    }

    // The point the pointer is aiming at, by the modifiers held
    private pick(): THREE.Vector3 | null {
        const pointer = this.pointer;
        if (!pointer) return null;
        if (pointer.command) return this.picker.nearestCorner(pointer.x, pointer.y);
        if (pointer.shift && this.anchor) return this.picker.axisPoint(pointer.x, pointer.y, this.anchor);
        return this.picker.surfacePoint(pointer.x, pointer.y);
    }

    // Moves the dot under the pointer, or the end of the length being measured
    private track() {
        if (!this.active) return;
        const point = this.pick();
        const inProgress = this.measurements.find((measurement) => measurement.phase === "inProgress");
        if (inProgress && this.anchor) {
            this.place(inProgress, point);
        } else if (point) {
            this.hover = { id: "hover", colorIndex: this.nextColor, start: MeasurementTool.tuple(point), phase: "coordinate" };
        } else {
            this.hover = null;
        }
        this.changed();
    }

    // The moving end at a point; with Option, the start mirrored through the first point
    private place(measurement: Measurement, end: THREE.Vector3 | null) {
        const anchor = this.anchor!;
        measurement.end = end ? MeasurementTool.tuple(end) : undefined;
        measurement.start = MeasurementTool.tuple(end && this.pointer?.option ? anchor.clone().multiplyScalar(2).sub(end) : anchor);
    }

    private commit(point: THREE.Vector3) {
        const inProgress = this.measurements.find((measurement) => measurement.phase === "inProgress");
        if (inProgress) {
            this.place(inProgress, point);
            inProgress.phase = "complete";
            this.anchor = null;
            // A finished measurement goes back to viewing, so the pointer orbits again
            this.changed();
            this.setActive(false);
            return;
        }
        this.hover = null;
        this.measurements.push({ id: crypto.randomUUID(), colorIndex: this.nextColor++, start: MeasurementTool.tuple(point), phase: "inProgress" });
        this.anchor = point.clone();
        this.changed();
    }

    private cancel() {
        this.measurements = this.measurements.filter((measurement) => measurement.phase !== "inProgress");
        this.anchor = null;
        this.hover = null;
        this.changed();
    }

    private changed() {
        this.reconcile();
        this.updateReadout();
        this.events.measurementsChanged([...this.measurements, ...this.hover ? [this.hover] : []].map((measurement) => ({ ...measurement })));
    }

    // The length being measured, next to the pointer, for when the list isn't in sight
    private updateReadout() {
        const inProgress = this.measurements.find((measurement) => measurement.phase === "inProgress");
        const pointer = this.pointer;
        if (!inProgress?.end || !pointer) {
            this.readout.hidden = true;
            return;
        }
        const length = new THREE.Vector3(...inProgress.end).distanceTo(new THREE.Vector3(...inProgress.start));
        this.readout.textContent = `${length.toLocaleString(undefined, { minimumFractionDigits: 3, maximumFractionDigits: 3 })} mm`;
        const rect = this.canvas.getBoundingClientRect();
        this.readout.style.left = `${pointer.x - rect.left + 14}px`;
        this.readout.style.top = `${pointer.y - rect.top + 14}px`;
        this.readout.hidden = false;
    }

    // Brings the drawn measurements in line with the list
    private reconcile() {
        const shown = [...this.measurements, ...this.hover ? [this.hover] : []];
        const ids = new Set(shown.map((measurement) => measurement.id));
        for (const [id, visual] of this.visuals) {
            if (ids.has(id)) continue;
            visual.dispose();
            this.visuals.delete(id);
        }
        for (const measurement of shown) {
            let visual = this.visuals.get(measurement.id);
            if (!visual || visual.colorIndex !== measurement.colorIndex) {
                visual?.dispose();
                visual = new MeasurementVisual(measurement.colorIndex);
                this.group.add(visual.group);
                this.visuals.set(measurement.id, visual);
            }
            visual.set(measurement);
            visual.setHighlighted(measurement.id === this.highlighted);
        }
    }

    private static tuple(point: THREE.Vector3): Point {
        return [point.x, point.y, point.z];
    }
}

/** One measurement's dots and line, with the faint dashes where the model is in front of the line. */
class MeasurementVisual {
    readonly group = new THREE.Group();
    private readonly start: THREE.Mesh;
    private readonly end: THREE.Mesh;
    private readonly line: LineSegments2;
    private readonly dashes: LineSegments2;
    private readonly materials: THREE.Material[];
    private emphasis = 1;

    constructor(readonly colorIndex: number) {
        const color = new THREE.Color(Palette.css(colorIndex));
        // Just short of opaque, so they're drawn after the dashes and over them where the line shows
        const dotMaterial = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.99, toneMapped: false });
        const sphere = new THREE.SphereGeometry(1, 16, 12);
        this.start = new THREE.Mesh(sphere, dotMaterial);
        this.end = new THREE.Mesh(sphere, dotMaterial);
        const lineMaterial = new LineMaterial({ color: color.getHex(), linewidth: lineRadius * 2, transparent: true, opacity: 0.99, toneMapped: false });
        this.line = new LineSegments2(new LineSegmentsGeometry(), lineMaterial);
        const dashMaterial = new LineMaterial({
            color: color.getHex(), linewidth: 1.5, transparent: true, opacity: 0.5, dashed: true,
            depthTest: false, depthWrite: false, toneMapped: false,
        });
        this.dashes = new LineSegments2(new LineSegmentsGeometry(), dashMaterial);
        this.dashes.renderOrder = 1;
        this.line.renderOrder = 2;
        this.start.renderOrder = this.end.renderOrder = 3;
        this.materials = [dotMaterial, lineMaterial, dashMaterial];
        this.group.add(this.dashes, this.line, this.start, this.end);
    }

    set(measurement: Measurement) {
        this.start.position.set(...measurement.start);
        const end = measurement.end;
        this.end.visible = this.line.visible = this.dashes.visible = !!end;
        if (!end) return;
        this.end.position.set(...end);
        const positions = [...measurement.start, ...end];
        this.line.geometry.setPositions(positions);
        this.dashes.geometry.setPositions(positions);
        this.dashes.computeLineDistances();
    }

    // The highlighted one is bigger and shows through the model
    setHighlighted(highlighted: boolean) {
        this.emphasis = highlighted ? 1.7 : 1;
        for (const material of this.materials.slice(0, 2)) {
            material.depthTest = !highlighted;
            material.depthWrite = !highlighted;
        }
        (this.line.material as LineMaterial).linewidth = lineRadius * 2 * this.emphasis;
    }

    resize(worldPerPixel: (point: THREE.Vector3) => number) {
        for (const dot of [this.start, this.end]) dot.scale.setScalar(dotRadius * this.emphasis * worldPerPixel(dot.position));
        if (this.dashes.visible) {
            // Dashes 5 pixels long with 4 between, at the line's middle
            const middle = this.start.position.clone().add(this.end.position).multiplyScalar(0.5);
            const unit = worldPerPixel(middle);
            const material = this.dashes.material as LineMaterial;
            material.dashSize = 5 * unit;
            material.gapSize = 4 * unit;
        }
    }

    dispose() {
        this.group.removeFromParent();
        this.start.geometry.dispose();
        this.line.geometry.dispose();
        this.dashes.geometry.dispose();
        for (const material of this.materials) material.dispose();
    }
}
