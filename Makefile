.PHONY: mac build clean clean-native ci-clean ci-bootstrap ci-release ci-release-mac dev

# Build the macOS .dmg — output lands in release/
mac: build
	npx electron-builder --mac

# Compile renderer (Vite) + main process (TypeScript) only
build:
	npm run build

# Remove renderer/package build artefacts
clean:
	rm -rf dist release

# Remove staged native binaries and native daemon build outputs
clean-native:
	rm -rf assets/native native/daemon/build

# Remove everything a fresh CI runner would not have cached
ci-clean: clean clean-native
	rm -rf node_modules

# Recreate the checkout state a GitHub Actions runner would start from
ci-bootstrap:
	git submodule sync --recursive
	git submodule update --init --recursive
	npm ci

# Simulate the macOS GitHub Actions release build locally without publishing
ci-release: ci-release-mac

ci-release-mac: ci-clean
	$(MAKE) ci-bootstrap
	CI=true CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac -- --publish never

# Incremental dev: Vite watch + TypeScript watch, then launch Electron
dev:
	npm run dev
