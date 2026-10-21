import * as THREE from "three";
import { SectionGeometry, type Axis, type CrossSection } from "./CrossSection";
import { CrossSectionView } from "./CrossSectionView";
import { Palette } from "./Palette";
import { PopupMenu } from "./PopupMenu";
import { SectionGizmo, type GizmoSpace, type Handle } from "./SectionGizmo";

/** What the editor needs from the view it's in. */
export interface SectionHost {
    readonly camera: THREE.Camera;
    readonly canvas: HTMLCanvasElement;
    readonly modelBox: THREE.Box3;
    readonly hiddenParts: Set<string>;
    worldPerPixel(point: THREE.Vector3): number;
    /** Called when the sections change, to remember them. */
    sectionsChanged(sections: CrossSection[]): void;
}

interface Drag {
    handle: Handle;
    start: CrossSection;
    grab: number;
    pivot: THREE.Vector3;
    space: GizmoSpace;
    pointer: number;
}

const maxSections = 8;
const icons = {
    checked: `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="currentColor"/><path d="M5.2 8.2l1.9 1.9 3.8-4.1" fill="none" stroke="var(--chip-check)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    unchecked: `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>`,
    scissors: `<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="4.5" cy="11.5" r="2"/><circle cx="11.5" cy="11.5" r="2"/><path d="M5.9 10.1L12 2.5 M10.1 10.1L4 2.5"/></svg>`,
    add: `<svg viewBox="0 0 20 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="4.5" cy="11.5" r="2"/><circle cx="11.5" cy="11.5" r="2"/><path d="M5.9 10.1L12 2.5 M10.1 10.1L4 2.5 M17 3v4 M15 5h4"/></svg>`,
    trash: `<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5h10 M6.5 4.5V3h3v1.5 M4.5 4.5l.7 8.5h5.6l.7-8.5"/></svg>`,
};

/**
 * Cross-sections, as in Cadova Viewer: a chip for each in the view's corner, one selected at a time
 * for editing with the gizmo and a bar of controls along the bottom, and up to eight at once.
 */
export class CrossSectionEditor {
    readonly view = new CrossSectionView();
    readonly gizmo = new SectionGizmo();
    private sections: CrossSection[];
    private selected: string | null = null;
    private hovered: string | null = null;
    private drag: Drag | null = null;
    // Where a press off the gizmo began while a section is selected, as it might be a click
    private press: { x: number; y: number } | null = null;
    private shiftHeld = false;
    private readonly chips = document.getElementById("sections")!;
    private readonly bar = document.getElementById("section-bar")!;
    // What the chips and the bar last showed, so they're only rebuilt when that changes
    private chipsShown = "";
    private barShown = "";

    constructor(private readonly host: SectionHost, sections: CrossSection[]) {
        this.sections = sections;
        // A pointer on a handle drags it, ahead of the view's own navigation
        host.canvas.addEventListener("pointerdown", (event) => this.pointerDown(event), { capture: true });
        host.canvas.addEventListener("pointermove", (event) => this.pointerMove(event));
        host.canvas.addEventListener("pointerup", (event) => this.pointerUp(event));
        host.canvas.addEventListener("pointercancel", (event) => this.pointerUp(event));
        for (const type of ["keydown", "keyup"] as const) {
            window.addEventListener(type, (event) => {
                if (event.key === "Shift" && this.shiftHeld !== (type === "keydown")) {
                    this.shiftHeld = type === "keydown";
                    this.refresh();
                }
                if (type === "keydown" && this.selected && !PopupMenu.isOpen && (event.key === "Escape" || event.key === "Enter")) {
                    this.select(null);
                }
            });
        }
        this.refresh();
    }

    /** The enabled sections, which hide what's past them from measurements as well as from view. */
    get enabled(): CrossSection[] {
        return this.view.enabledSections;
    }

    get isDragging(): boolean {
        return this.drag !== null;
    }



    /** Runs each frame: keeps the gizmo in place and the cut faces up to date. */
    render(time: number) {
        this.gizmo.follow(this.host.camera, (point) => this.host.worldPerPixel(point), this.isDragging);
        this.view.render(time, this.host.modelBox);
    }

    private get current(): CrossSection | undefined {
        return this.sections.find((section) => section.id === this.selected);
    }

    private setSections(sections: CrossSection[]) {
        this.sections = sections;
        this.host.sectionsChanged(sections);
        this.refresh();
    }

    private update(id: string, change: (section: CrossSection) => CrossSection) {
        this.setSections(this.sections.map((section) => section.id === id ? change(section) : section));
    }

    private select(id: string | null) {
        this.selected = id;
        this.refresh();
    }

    // Through the model's middle, flat along Z, in the next color, and ready to edit
    private add() {
        if (this.sections.length >= maxSections) return;
        const center = this.host.modelBox.isEmpty() ? new THREE.Vector3() : this.host.modelBox.getCenter(new THREE.Vector3());
        const used = new Set(this.sections.map((section) => section.colorIndex));
        let colorIndex = 0;
        while (used.has(colorIndex) && colorIndex < Palette.colors.length) colorIndex++;
        const section = SectionGeometry.aligned({
            id: crypto.randomUUID(), origin: [center.x, center.y, center.z], orientation: [0, 0, 0, 1], enabled: true, colorIndex,
        }, "z");
        this.selected = section.id;
        this.setSections([...this.sections, section]);
        this.view.showGhost(true);
    }

    private remove(id: string) {
        if (this.selected === id) this.selected = null;
        this.setSections(this.sections.filter((section) => section.id !== id));
    }

    private reshape(change: (section: CrossSection) => CrossSection) {
        const section = this.current;
        if (!section?.enabled) return;
        this.update(section.id, change);
        this.view.showGhost(true);
    }

    /** Updates the drawing, the gizmo and the controls, such as for a new model or hidden parts. */
    refresh() {
        const section = this.current;
        this.view.update({
            sections: this.sections, hiddenParts: this.host.hiddenParts,
            focused: this.hovered ?? this.selected, planeShown: this.selected ?? this.hovered,
        });
        if (section && !this.host.modelBox.isEmpty()) {
            this.gizmo.show(section, this.anchor(section), this.shiftHeld ? "world" : "plane", section.enabled);
        } else {
            this.gizmo.hide();
        }
        this.renderChips();
        this.renderBar();
    }

    // MARK: Gizmo dragging

    private pointerDown(event: PointerEvent) {
        this.press = null;
        if (event.button !== 0 || event.ctrlKey || !this.current) return;
        const handle = this.current.enabled ? this.gizmo.handleAt(this.raycaster(event)) : null;
        if (!handle) {
            this.press = { x: event.clientX, y: event.clientY };
            return;
        }
        // The view's navigation doesn't see this press
        event.stopImmediatePropagation();
        event.preventDefault();
        this.host.canvas.setPointerCapture(event.pointerId);
        const section = this.current;
        const pivot = this.anchor(section);
        const space = this.gizmo.space;
        const axis = this.axis(handle, section, space);
        const ray = this.raycaster(event).ray;
        const grab = handle.kind === "translate"
            ? CrossSectionEditor.axisParameter(pivot, axis, ray)
            : CrossSectionEditor.angle(pivot, axis, ray) ?? 0;
        this.drag = { handle, start: section, grab, pivot, space, pointer: event.pointerId };
        this.gizmo.setActive(handle);
        this.view.showGhost();
    }

    private pointerMove(event: PointerEvent) {
        const drag = this.drag;
        if (!drag) {
            if (event.buttons === 0 && this.current?.enabled) this.gizmo.setHovered(this.gizmo.handleAt(this.raycaster(event)));
            return;
        }
        if (event.pointerId !== drag.pointer) return;
        const ray = this.raycaster(event).ray;
        const axis = this.axis(drag.handle, drag.start, drag.space);
        let section = drag.start;
        if (drag.handle.kind === "translate") {
            const now = CrossSectionEditor.axisParameter(drag.pivot, axis, ray);
            section = SectionGeometry.withOrigin(section, drag.pivot.clone().addScaledVector(axis, now - drag.grab));
        } else {
            const now = CrossSectionEditor.angle(drag.pivot, axis, ray);
            if (now === null) return;
            let delta = now - drag.grab;
            // Option turns in steps of 22.5°
            if (event.altKey) delta = Math.round(delta / (Math.PI / 8)) * (Math.PI / 8);
            const turn = new THREE.Quaternion().setFromAxisAngle(axis, delta);
            section = SectionGeometry.withOrigin(
                SectionGeometry.withOrientation(section, turn.multiply(SectionGeometry.quaternion(drag.start))), drag.pivot,
            );
        }
        this.update(section.id, () => section);
    }

    private pointerUp(event: PointerEvent) {
        // As in Cadova Viewer, a click off the gizmo is done editing, rather than placing a measurement
        const press = this.press;
        this.press = null;
        if (press && event.button === 0 && this.selected && Math.hypot(event.clientX - press.x, event.clientY - press.y) <= 4) {
            event.stopImmediatePropagation();
            this.select(null);
            return;
        }
        if (!this.drag || event.pointerId !== this.drag.pointer) return;
        this.drag = null;
        this.gizmo.setActive(null);
        this.view.hideGhost();
        this.refresh();
    }

    private raycaster(event: PointerEvent): THREE.Raycaster {
        const rect = this.host.canvas.getBoundingClientRect();
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(new THREE.Vector2(
            (event.clientX - rect.left) / rect.width * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1,
        ), this.host.camera);
        return raycaster;
    }

    // A handle's axis in the world: the world's own, or the section's turned ones in plane space
    private axis(handle: Handle, section: CrossSection, space: GizmoSpace): THREE.Vector3 {
        const axis = SectionGeometry.axes[handle.axis].clone();
        return space === "world" ? axis : axis.applyQuaternion(SectionGeometry.quaternion(section)).normalize();
    }

    /**
     * A point on the section's plane near the middle of the view, which drags turn and slide around,
     * so they act where you're looking. Seen nearly edge-on, the plane's nearest point to the model's
     * middle instead.
     */
    private anchor(section: CrossSection): THREE.Vector3 {
        const normal = SectionGeometry.normal(section);
        const distance = normal.dot(SectionGeometry.origin(section));
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(new THREE.Vector2(0, 0), this.host.camera);
        const { origin, direction } = raycaster.ray;
        const facing = direction.dot(normal);
        if (Math.abs(facing) > 0.08) {
            const t = (distance - origin.dot(normal)) / facing;
            if (t > 0) return origin.clone().addScaledVector(direction, t);
        }
        const center = this.host.modelBox.isEmpty() ? SectionGeometry.origin(section) : this.host.modelBox.getCenter(new THREE.Vector3());
        return center.addScaledVector(normal, distance - center.dot(normal));
    }

    // Where along an axis through a point a ray passes closest
    private static axisParameter(point: THREE.Vector3, axis: THREE.Vector3, ray: THREE.Ray): number {
        const toPoint = point.clone().sub(ray.origin);
        const b = axis.dot(ray.direction);
        const denominator = 1 - b * b;
        if (Math.abs(denominator) < 1e-9) return 0;
        return (b * ray.direction.dot(toPoint) - axis.dot(toPoint)) / denominator;
    }

    // The angle around an axis through a point where a ray meets the plane across the axis
    private static angle(origin: THREE.Vector3, axis: THREE.Vector3, ray: THREE.Ray): number | null {
        const facing = ray.direction.dot(axis);
        if (Math.abs(facing) < 1e-9) return null;
        const t = origin.clone().sub(ray.origin).dot(axis) / facing;
        const hit = ray.origin.clone().addScaledVector(ray.direction, t).sub(origin);
        const reference = Math.abs(axis.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
        const e1 = new THREE.Vector3().crossVectors(reference, axis).normalize();
        const e2 = new THREE.Vector3().crossVectors(axis, e1);
        return Math.atan2(hit.dot(e2), hit.dot(e1));
    }

    // MARK: Controls

    // A chip for each section: its checkbox enables it, its scissors select it for editing
    private renderChips() {
        const shown = JSON.stringify([this.sections.map((section) => [section.id, section.enabled, section.colorIndex]), this.selected, this.host.modelBox.isEmpty()]);
        if (shown === this.chipsShown) return;
        this.chipsShown = shown;
        const chips: HTMLElement[] = this.sections.map((section) => {
            const selected = section.id === this.selected;
            const chip = document.createElement("div");
            chip.className = "section-chip";
            chip.classList.toggle("selected", selected);
            chip.classList.toggle("disabled", !section.enabled);
            chip.style.setProperty("--section", Palette.css(section.colorIndex));

            const toggle = this.button(section.enabled ? "Disable" : "Enable", section.enabled ? icons.checked : icons.unchecked,
                () => this.update(section.id, (current) => ({ ...current, enabled: !current.enabled })));
            const edit = this.button(selected ? "Done Editing" : "Edit Cross-Section", icons.scissors, () => this.select(selected ? null : section.id));
            edit.classList.add("scissors");
            chip.append(toggle, edit);
            chip.addEventListener("pointerenter", () => { this.hovered = section.id; this.refresh(); });
            chip.addEventListener("pointerleave", () => { if (this.hovered === section.id) { this.hovered = null; this.refresh(); } });
            chip.addEventListener("contextmenu", (event) => {
                event.preventDefault();
                PopupMenu.show([
                    { label: "Enabled", checked: section.enabled, action: () => this.update(section.id, (current) => ({ ...current, enabled: !current.enabled })) },
                    "separator",
                    { label: "Delete", action: () => this.remove(section.id), alternate: { action: () => { this.selected = null; this.setSections([]); } } },
                ], event.clientX, event.clientY);
            });
            return chip;
        });
        if (this.sections.length < maxSections) {
            const add = this.button("Add Cross-Section", icons.add, () => this.add());
            add.className = "section-add";
            chips.push(add);
        }
        this.chips.replaceChildren(...chips);
        this.chips.hidden = this.host.modelBox.isEmpty();
    }

    // Cadova Viewer's editing bar for the selected section
    private renderBar() {
        const section = this.current;
        const shown = JSON.stringify(section ?? null);
        if (shown === this.barShown) return;
        this.barShown = shown;
        this.bar.hidden = !section;
        if (!section) { this.bar.replaceChildren(); return; }
        const control = (label: string, ...content: HTMLElement[]) => {
            const group = document.createElement("div");
            group.className = "bar-control";
            const row = document.createElement("div");
            row.className = "bar-row";
            row.append(...content);
            group.append(row, Object.assign(document.createElement("span"), { className: "bar-label", textContent: label }));
            return group;
        };
        const text = (title: string, action: () => void, disabled = false) => {
            const button = Object.assign(document.createElement("button"), { type: "button", textContent: title, disabled });
            button.addEventListener("click", action);
            return button;
        };

        const enabled = document.createElement("input");
        enabled.type = "checkbox";
        enabled.className = "switch";
        enabled.checked = section.enabled;
        enabled.addEventListener("change", () => {
            this.update(section.id, (current) => ({ ...current, enabled: enabled.checked }));
            if (enabled.checked) this.view.showGhost(true);
        });

        const reshape = !section.enabled;
        const axes = (["x", "y", "z"] as Axis[]).map((axis) => text(axis.toUpperCase(),
            () => this.reshape((current) => SectionGeometry.aligned(current, axis)), reshape || SectionGeometry.isAligned(section, axis)));
        const nearest = text("Nearest", () => this.reshape((current) => SectionGeometry.snappedToNearestAxis(current)),
            reshape || SectionGeometry.isAxisAligned(section));
        const remove = this.button("Delete Cross-Section", icons.trash, () => this.remove(section.id));
        remove.className = "bar-delete";
        const done = text("Done", () => this.select(null));
        done.className = "primary";

        const title = Object.assign(document.createElement("div"), { className: "bar-title", textContent: "Cross-Section" });
        const controls = document.createElement("div");
        controls.className = "bar-controls";
        controls.append(
            control("Enabled", enabled),
            control("Direction", text("Flip", () => this.reshape((current) => SectionGeometry.flipped(current)), reshape)),
            control("Align to axis", ...axes, nearest),
            control("", remove, done),
        );
        this.bar.replaceChildren(title, controls);
    }

    private button(title: string, icon: string, action: () => void): HTMLButtonElement {
        const button = document.createElement("button");
        button.type = "button";
        button.title = title;
        button.setAttribute("aria-label", title);
        button.innerHTML = icon;
        button.addEventListener("click", action);
        return button;
    }
}
