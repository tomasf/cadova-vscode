# Contributing

## Building

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
