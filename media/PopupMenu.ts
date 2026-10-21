/** A choice in a menu. Holding Option (Alt) swaps in its alternate, as macOS menus do. */
export interface MenuItem {
    label: string;
    /** A picture before the label, such as a part's thumbnail, as an image URL; empty keeps its place. */
    icon?: string;
    checked?: boolean;
    action?: () => void;
    submenu?: MenuEntry[];
    alternate?: { checked?: boolean; action: () => void };
    /** Called when the pointer moves onto the item, and off it, including by the menu closing. */
    onHover?: (hovered: boolean) => void;
}

export type MenuEntry = MenuItem | { header: string; alternateHeader?: string } | "separator";

/**
 * A menu over the view, like a native context menu: it closes on a choice, a click elsewhere or
 * Escape, and submenus open on hover. Only one is open at a time.
 */
export class PopupMenu {
    private static open: PopupMenu | null = null;
    private readonly elements: HTMLElement[] = [];
    private readonly listeners: [EventTarget, string, EventListener][] = [];
    private hovered: MenuItem | null = null;

    private constructor(entries: MenuEntry[], x: number, y: number, private readonly onClose: () => void) {
        this.elements.push(this.list(entries, x, y));
        // Listening from the next event on, so the click that opened the menu doesn't close it
        setTimeout(() => {
            this.listen(window, "pointerdown", (event) => {
                if (this.elements.some((element) => element.contains(event.target as Node))) return;
                // Like a native menu, a click elsewhere only closes it: the view doesn't start a drag,
                // and a button, such as the one that opened the menu, isn't clicked
                event.stopPropagation();
                this.close();
                const swallow = (click: Event) => click.stopPropagation();
                window.addEventListener("click", swallow, true);
                window.addEventListener("pointerup", () => setTimeout(() => window.removeEventListener("click", swallow, true)),
                    { capture: true, once: true });
            });
            // Only the window losing focus, not an element in it, which a capturing listener also hears
            this.listen(window, "blur", (event) => {
                if (event.target === window) this.close();
            });
            // Scrolling a menu that's too tall for the window scrolls it; scrolling elsewhere closes it
            this.listen(window, "wheel", (event) => {
                if (!this.elements.some((element) => element.contains(event.target as Node))) this.close();
            });
        });
        this.listen(window, "keydown", (event) => {
            const key = (event as KeyboardEvent).key;
            if (key === "Escape") this.close();
            if (key === "Alt") this.setAlternate(true);
        });
        this.listen(window, "keyup", (event) => {
            if ((event as KeyboardEvent).key === "Alt") this.setAlternate(false);
        });
    }

    /** Opens a menu with its top left corner at a point, moved in to fit the window. */
    static show(entries: MenuEntry[], x: number, y: number, { onClose = () => {} } = {}): PopupMenu {
        PopupMenu.open?.close();
        PopupMenu.open = new PopupMenu(entries, x, y, onClose);
        return PopupMenu.open;
    }

    static get isOpen(): boolean {
        return PopupMenu.open !== null;
    }

    close() {
        if (PopupMenu.open !== this) return;
        PopupMenu.open = null;
        for (const element of this.elements) element.remove();
        for (const [target, type, listener] of this.listeners) target.removeEventListener(type, listener, true);
        this.setHovered(null);
        this.onClose();
    }

    private listen(target: EventTarget, type: string, listener: EventListener) {
        target.addEventListener(type, listener, true);
        this.listeners.push([target, type, listener]);
    }

    private setHovered(item: MenuItem | null) {
        if (item === this.hovered) return;
        this.hovered?.onHover?.(false);
        this.hovered = item;
        item?.onHover?.(true);
    }

    private setAlternate(on: boolean) {
        for (const element of this.elements) element.classList.toggle("alternate", on);
    }

    private list(entries: MenuEntry[], x: number, y: number, parentRow?: HTMLElement): HTMLElement {
        const list = document.createElement("div");
        list.className = "menu";
        list.setAttribute("role", "menu");
        let openSubmenu: HTMLElement | null = null;

        for (const entry of entries) {
            if (entry === "separator") {
                list.append(Object.assign(document.createElement("div"), { className: "menu-separator" }));
                continue;
            }
            if ("header" in entry) {
                const header = document.createElement("div");
                header.className = "menu-header";
                header.append(PopupMenu.span("normal", entry.header), PopupMenu.span("alternate", entry.alternateHeader ?? entry.header));
                list.append(header);
                continue;
            }

            const row = document.createElement("div");
            row.className = "menu-item";
            row.setAttribute("role", entry.checked === undefined ? "menuitem" : "menuitemcheckbox");
            row.append(
                PopupMenu.span("check normal", entry.checked ? "✓" : ""),
                PopupMenu.span("check alternate", (entry.alternate ? entry.alternate.checked : entry.checked) ? "✓" : ""),
                PopupMenu.label(entry),
                PopupMenu.span("arrow", entry.submenu ? "›" : ""),
            );
            row.addEventListener("pointerenter", () => {
                this.setHovered(entry);
                openSubmenu?.remove();
                openSubmenu = null;
                if (!entry.submenu) return;
                const rect = row.getBoundingClientRect();
                openSubmenu = this.list(entry.submenu, rect.right - 2, rect.top - 5, row);
                this.elements.push(openSubmenu);
            });
            row.addEventListener("pointerleave", () => {
                if (this.hovered === entry) this.setHovered(null);
            });
            row.addEventListener("click", (event) => {
                if (entry.submenu) return;
                this.close();
                if (event.altKey && entry.alternate) entry.alternate.action();
                else entry.action?.();
            });
            list.append(row);
        }

        document.body.append(list);
        list.classList.toggle("alternate", this.elements[0]?.classList.contains("alternate") ?? false);
        // Fit in the window: a submenu flips to its parent's left side, a menu moves in
        const { width, height } = list.getBoundingClientRect();
        if (x + width > window.innerWidth - 4) {
            x = parentRow ? parentRow.getBoundingClientRect().left - width + 2 : window.innerWidth - width - 4;
        }
        list.style.left = `${Math.max(4, x)}px`;
        list.style.top = `${Math.max(4, Math.min(y, window.innerHeight - height - 4))}px`;
        return list;
    }

    private static label(item: MenuItem): HTMLSpanElement {
        const label = PopupMenu.span("label", item.label);
        if (item.icon) label.prepend(Object.assign(document.createElement("img"), { className: "icon", src: item.icon, alt: "" }));
        else if (item.icon === "") label.prepend(PopupMenu.span("icon", ""));
        return label;
    }

    private static span(className: string, text: string): HTMLSpanElement {
        return Object.assign(document.createElement("span"), { className, textContent: text });
    }
}
