# MatterDashboard

MatterDashboard currently hosts the MatterKiosk app: a small Electron utility that exposes saved dashboard URLs as Matter on/off devices.

## What It Does

- Add one or more dashboard URLs.
- Expose each enabled dashboard as a Matter endpoint.
- Pair the bridge with Apple Home, Google Home, Home Assistant, or another Matter controller.
- Open a dashboard fullscreen when its Matter device is triggered.

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