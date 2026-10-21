# Cadova for VS Code

Generate and preview [Cadova](https://github.com/tomasf/Cadova) models without leaving VS Code.

- **Generate and Preview** actions appear above every `Model` and `Project` in Swift files that import Cadova. They compile the package if needed, then run it to write the model files; a model's actions generate just that model, using Cadova's `--model` filter.
- 3MF files open in a 3D preview that reloads whenever the file changes, so it follows new versions from anywhere: the actions above, the terminal or another editor.
- The preview's toolbar has Cadova Viewer's basics: perspective or orthographic projection, zoom, the standard views (isometric, front, back, left, right, top, bottom), smooth shading, and edges (none, sharp or all). New previews start with the options you chose last.
- The toolbar's Show menu turns the grid, origin lines and axis directions on and off. For a model with several parts, right-clicking the model lists the parts under the pointer, as in Cadova Viewer. Option-click (Alt-click) a part to show only that part; hovering one outlines it, and shows it faintly if it's hidden. Each preview remembers its hidden parts when the model is regenerated.
- The Info button shows a panel with what Cadova Viewer's info sheet has: the file's size, the model's dimensions, volume, surface area and part, vertex and triangle counts, and the 3MF file's metadata.
- The Model view in the Explorer sidebar lists the parts of the model in the active preview with thumbnails, like Cadova Viewer's parts list. Click a part's checkmark to show or hide it (Option-click to show only that part), hover it to outline it in the preview, and double-click it to center the view on it. Select several with Command-click or Shift-click, press Space to show or hide them, and right-click for Center View, Show Only and Copy Part Names. The view's menu switches between small and large icons. Below the parts, it lists the preview's measurements with their coordinates and lengths; right-click one to copy or delete it.
- The Measure button measures the model, as in Cadova Viewer: click a point, then another, to measure the length between them. Hold Command (Control) to snap to the nearest corner, Shift to keep the line along an axis, or Option (Alt) to center it on the first point. Escape cancels.
- The scissors button in the view's top left corner adds a cross-section, up to eight. Drag the gizmo's arrow to move the cut and its rings to tilt it (hold Shift for world axes, Option to turn in 22.5° steps), or use the bar along the bottom to flip it or align it to an axis. Each section's chip turns it on and off or selects it for editing. Cut faces are filled in the part's color, and measurements can land on them.
- Saving a Swift file regenerates the models open in previews from the same package. The preview's Regenerate button (⌥⌘R) does it on demand.

The preview works on every platform VS Code runs on. On macOS, [Cadova Viewer](https://github.com/tomasf/CadovaViewer) also sends models to a slicer, works with a SpaceMouse and shows models live from Cadova LiveLink.

## Settings

- `cadova.swiftPath`: the `swift` executable to compile and run with, if it isn't on the `PATH` VS Code sees.
- `cadova.buildConfiguration`: `debug` (default) or `release`.
- `cadova.rebuildOnSave`: turns regenerating on save off.
- `cadova.codeLens`: turns the Generate and Preview actions off.

## Development

```sh
npm install
npm run build      # or: npm run watch
```

Open the folder in VS Code and press F5 to start a window with the extension loaded.

The preview is built from the web customizer's viewer modules (in `media/customizer`), copied from Cadova so the two look and navigate the same. After the customizer's viewer changes, copy them again:

```sh
npm run sync-viewer                 # from ../Cadova
npm run sync-viewer -- path/to/Cadova
```
