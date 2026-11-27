# Contributing

Thanks for helping improve the card.

## Setup

There is nothing to install. The card is one dependency-free file, `motioneye-camera-card.js`, and the tests use Node's built-in test runner (Node 20 or newer).

```bash
node --check motioneye-camera-card.js
node --test
```

## Trying changes in Home Assistant

1. Copy `motioneye-camera-card.js` to `/config/www/`
2. Add the resource `/local/motioneye-camera-card.js` (type *JavaScript module*)
3. After each edit, bump the URL (`?v=2`, `?v=3`, ...) and hard-refresh to bypass the browser cache

## Guidelines

- Keep the card to a single file with no runtime dependencies
- Put logic that doesn't need the DOM in the pure helpers near the top of the file, and add a test for it in `tests/helpers.test.js`
- Keep the live stream cheap: streams must close when the card isn't visible
- Update `README.md` when you add or change an option, and add a line to `CHANGELOG.md`

## Reporting problems

Please include your Home Assistant version, your browser or app, your card YAML (with entity names if you like), and any error text shown in the card or in the browser console.

## Releases

Tag a version (for example `v1.0.1`). The release workflow creates a GitHub release and attaches `motioneye-camera-card.js`, which is what the Marketplace installs.
