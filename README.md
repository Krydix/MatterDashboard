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