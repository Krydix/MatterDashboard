.PHONY: mac build clean dev

# Build the macOS .dmg — output lands in release/
mac: build
	npx electron-builder --mac

# Compile renderer (Vite) + main process (TypeScript) only
build:
	npm run build

# Remove all build artefacts
clean:
	rm -rf dist release

# Incremental dev: Vite watch + TypeScript watch, then launch Electron
dev:
	npm run dev
