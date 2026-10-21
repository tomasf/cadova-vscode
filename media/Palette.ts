/** Cadova Viewer's colors for measurements and cross-sections, which take the next one in turn. */
export class Palette {
    static readonly colors = [
        "#ffcc00", // amber
        "#33c7f2", // cyan
        "#ff6666", // coral
        "#80e673", // green
        "#cc8cff", // purple
        "#ff9933", // orange
        "#73b3ff", // blue
        "#ff80cc", // pink
    ];

    static css(index: number): string {
        return Palette.colors[index % Palette.colors.length];
    }
}
