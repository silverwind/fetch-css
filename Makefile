node_modules: yarn.lock
	@yarn -s --pure-lockfile
	@touch node_modules

deps: node_modules

lint: node_modules
	yarn -s run eslint --color .

test: node_modules lint

publish: node_modules
	git push -u --tags origin master
	npm publish

update: node_modules
	yarn -s run updates -cu
	@touch yarn.lock
	@$(MAKE) --no-print-directory deps

patch: node_modules test
	yarn -s run versions -Cc 'make build' patch
	@$(MAKE) --no-print-directory publish

minor: node_modules test
	yarn -s run versions -Cc 'make build' minor
	@$(MAKE) --no-print-directory publish

major: node_modules test
	yarn -s run versions -Cc 'make build' major
	@$(MAKE) --no-print-directory publish

.PHONY: lint test unittest publish deps update patch minor major
