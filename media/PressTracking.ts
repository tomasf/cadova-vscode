/**
 * Gives buttons, switches and menu items a pressed look that behaves like a native control's: it
 * shows while the pointer is held down on one, goes away when the pointer is dragged off it, and
 * comes back when it returns. Releasing off it doesn't click it. CSS's `:active` stays on however far the pointer
 * goes, and VS Code's themes make it look much like hovering, so a `pressed` class is set instead.
 */
export class PressTracking {
    private static readonly pressable = "button:not(:disabled), input[type='checkbox']:not(:disabled), .menu-item:not([aria-disabled='true'])";
    private pressed: { element: Element; pointer: number } | null = null;

    constructor() {
        window.addEventListener("pointerdown", (event) => {
            this.release();
            if (event.button !== 0) return;
            const element = (event.target as Element | null)?.closest?.(PressTracking.pressable);
            if (!element) return;
            this.pressed = { element, pointer: event.pointerId };
            element.classList.add("pressed");
        }, { capture: true });
        window.addEventListener("pointermove", (event) => {
            const pressed = this.pressed;
            if (!pressed || event.pointerId !== pressed.pointer) return;
            pressed.element.classList.toggle("pressed", pressed.element.contains(event.target as Node));
        }, { capture: true });
        for (const type of ["pointerup", "pointercancel"]) {
            window.addEventListener(type, (event) => {
                if ((event as PointerEvent).pointerId === this.pressed?.pointer) this.release();
            }, { capture: true });
        }
        window.addEventListener("blur", () => this.release());
    }

    private release() {
        this.pressed?.element.classList.remove("pressed");
        this.pressed = null;
    }
}
