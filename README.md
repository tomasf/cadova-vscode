# Cadova for VS Code

Generate and preview [Cadova](https://github.com/tomasf/Cadova) models without leaving VS Code. The preview works much like [Cadova Viewer](https://github.com/tomasf/CadovaViewer), on every platform VS Code runs on.

![A Cadova model's code beside its 3D preview, with a cross-section and the list of parts](images/screenshot.webp)

## Requirements

- A Swift toolchain, with `swift` on the `PATH` VS Code sees, or set in `cadova.swiftPath`.
- A Swift package whose executable builds models with Cadova.

## Installation

In VS Code, open the Extensions view, search for **Cadova** and choose **Install**, or install it from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=tomasf.cadova).

## Features

- **Generate and Preview** actions appear above every `Model`, `Group` and `Project` in your code. Generate writes just those models; Preview also opens them beside the code.
- **Live preview:** 3MF files open in a 3D preview that updates whenever the file changes, whether you regenerate from VS Code, a terminal or anywhere else. Saving a Swift file regenerates the models you're previewing.
- **View controls:** orbit, pan and zoom, perspective or orthographic projection, and the standard views. Show or hide materials, edges, the grid and the axes.
- **Parts:** the sidebar lists the model's parts with thumbnails, for showing, hiding and finding them.
- **Measuring:** measure distances on the model, snapping to corners and along axes.
- **Cross-sections:** cut through the model with up to eight sections you can move and tilt.
- **Info:** the model's size, volume, surface area and other details.
- **Slice:** open the model in your slicer, such as PrusaSlicer, Bambu Studio or OrcaSlicer.

## Settings

- `cadova.swiftPath`: the `swift` executable to use, if it isn't on the `PATH` VS Code sees.
- `cadova.buildConfiguration`: `debug` (default) or `release`.
- `cadova.slicer`: the slicer Slice opens models in.
- `cadova.lockPointer`: turn this off if dragging doesn't move the view, as can happen in some virtual machines.
- `cadova.rebuildOnSave`: turns regenerating on save off.
- `cadova.codeLens`: turns the Generate and Preview actions off.
