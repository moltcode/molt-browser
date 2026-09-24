NAME    := molt-browser
VERSION := $(shell jq -r .version package.json)
EXT_VERSION := $(shell jq -r .version extension/manifest.json)

PLATFORMS := darwin-arm64 darwin-x64 linux-x64 linux-arm64

.PHONY: build dist check clean

build:
	@for p in $(PLATFORMS); do \
		os=$${p%%-*}; arch=$${p##*-}; \
		case $$arch in x64) goarch=amd64;; *) goarch=$$arch;; esac; \
		echo "building dist/$$p/$(NAME)"; \
		mkdir -p dist/$$p; \
		CGO_ENABLED=0 GOOS=$$os GOARCH=$$goarch go build -trimpath \
			-ldflags "-s -w -X main.version=$(VERSION)" -o dist/$$p/$(NAME) . || exit 1; \
	done

check:
	go vet ./...
	go test ./...
	@for f in extension/*.js; do node --check $$f || exit 1; done
	@test "$(VERSION)" = "$(EXT_VERSION)" || (echo "package.json $(VERSION) != extension $(EXT_VERSION)"; exit 1)

# out/: the npm-layout plugin tarball (package/ root), the extension zip for
# the Chrome Web Store (manifest `key` stripped, the store assigns the id),
# and artifacts.json for the Molt catalog.
dist: check build
	rm -rf build out
	mkdir -p build/package out
	cp package.json README.md icon.png build/package/
	cp -R dist extension skills build/package/
	tar -czf out/$(NAME)-$(VERSION).tgz -C build package
	mkdir -p build/webstore
	cp -R extension/. build/webstore/
	jq 'del(.key)' extension/manifest.json > build/webstore/manifest.json
	cd build/webstore && zip -qr ../../out/$(NAME)-extension-$(EXT_VERSION).zip .
	@sha=$$(shasum -a 256 out/$(NAME)-$(VERSION).tgz | awk '{print $$1}'); \
	size=$$(wc -c < out/$(NAME)-$(VERSION).tgz | tr -d ' '); \
	printf '{"url": "https://github.com/moltcode/%s/releases/download/v%s/%s-%s.tgz", "sha256": "%s", "size": %s}\n' \
		$(NAME) $(VERSION) $(NAME) $(VERSION) $$sha $$size > out/artifacts.json; \
	cat out/artifacts.json

clean:
	rm -rf dist build out
