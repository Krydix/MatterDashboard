# MatterDashboard

MatterDashboard currently hosts the MatterKiosk app: a small Electron utility that exposes saved dashboards as Matter on/off devices.

## What It Does

- Add one or more dashboard URLs.
- Build native TRMNL-style dashboards from Liquid templates and JSON data.
- Import TRMNL recipes by recipe URL, recipe ID, or archive URL.
- Cache the TRMNL framework assets locally so imported dashboards can keep rendering without a permanent dependency on trmnl.com.
- Poll TRMNL recipe exchanges locally and rewrite the dashboard runtime on the configured interval.
- Execute supported TRMNL `transform.js` scripts in an on-demand sandbox only while the dashboard is active.
- Expose each enabled dashboard as a Matter endpoint.
- Pair the bridge with Apple Home, Google Home, Home Assistant, or another Matter controller.
- Open a dashboard fullscreen when its Matter device is triggered.

## Native TRMNL Dashboards

TRMNL targets can now be authored manually or imported from the public TRMNL recipe ecosystem.

- Use the Dashboards page to switch a target to Native TRMNL Runtime or click Import TRMNL Recipe.
- Imported recipes pull the recipe archive, transform the Liquid template to MatterKiosk's local runtime, preserve field defaults, and configure any polling exchanges they declare.
- Recipes that include `transform.js` now run that code inside a short-lived sandboxed renderer worker with no Node.js access. The sandbox only exists while the dashboard is active and is torn down again when the kiosk window closes.
- The runtime caches framework CSS and JavaScript under MatterKiosk's application runtime directory and refreshes exchange-driven dashboards locally on the imported interval.

## Development

Install dependencies:

```bash
npm install
```

Run in development:

```bash
make dev
```

Build the app:

```bash
make build
```

Build a macOS package:

```bash
make mac
```

Simulate the clean macOS GitHub Actions release build locally:

```bash
make ci-release
```

That target wipes local build outputs, re-initializes git submodules, runs `npm ci`, and builds the macOS release artifacts into `release/` without attempting to publish them.

## Releases

GitHub Actions builds the macOS release bundle on every pull request and every push to `main`.
Pushes to `main` do not create a GitHub Release; they only validate that the app still builds and upload the generated artifacts as workflow artifacts.

Official releases are created only from version tags that match `package.json`.

Release flow:

```bash
npm version patch
git push origin main
git push origin --tags
```

That creates a `vX.Y.Z` git tag from the `package.json` version bump. The release workflow only publishes when the pushed tag matches the version in `package.json`.