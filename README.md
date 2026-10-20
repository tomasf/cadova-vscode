# Cadova for VS Code

Build and preview [Cadova](https://github.com/tomasf/Cadova) models without leaving VS Code.

- **Build and Preview** actions appear above every `Model` and `Project` in Swift files that import Cadova. A model's action builds just that model, using Cadova's `--model` filter.
- 3MF files open in a 3D preview that reloads whenever the file changes, so it follows rebuilds from anywhere: the actions above, the terminal or another editor.
- The preview's toolbar has Cadova Viewer's basics: perspective or orthographic projection, zoom, the standard views (isometric, front, back, left, right, top, bottom), smooth shading, and edges (none, sharp or all). New previews start with the options you chose last.
- Saving a Swift file rebuilds the models open in previews from the same package. The preview's Rebuild button (⌥⌘R) does it on demand.

The preview works on every platform VS Code runs on. On macOS, [Cadova Viewer](https://github.com/tomasf/CadovaViewer) offers cross-sections, measurements and more, and keeps updating alongside this extension.

## Settings

- `cadova.swiftPath`: the `swift` executable to build with, if it isn't on the `PATH` VS Code sees.
- `cadova.buildConfiguration`: `debug` (default) or `release`.
- `cadova.rebuildOnSave`: turns rebuilding on save off.
- `cadova.codeLens`: turns the build actions off.

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
