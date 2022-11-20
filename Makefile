node_modules: package-lock.json
	npm install --no-save
	@touch node_modules

.PHONY: deps
deps: node_modules

.PHONY: test
test: lint

.PHONY: lint
lint: node_modules
	npx eslint --color .

.PHONY: publish
publish: node_modules
	git push -u --tags origin master
	npm publish

.PHONY: update
update: node_modules
	npx updates -cu
	rm package-lock.json
	npm install
	@touch node_modules

.PHONY: path
patch: node_modules lint
	npx versions patch package.json package-lock.json
	@$(MAKE) --no-print-directory publish

.PHONY: minor
minor: node_modules lint
	npx versions minor package.json package-lock.json
	@$(MAKE) --no-print-directory publish

.PHONY: major
major: node_modules lint
	npx versions major package.json package-lock.json
	@$(MAKE) --no-print-directory publish
