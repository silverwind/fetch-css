test:
	npx eslint .

publish:
	git push -u --tags origin master
	npm publish

deps:
	rm -rf node_modules
	yarn

update:
	node updates.js -cu
	$(MAKE) deps

patch: test
	npx versions -C patch
	$(MAKE) publish

minor: test
	npx versions -C minor
	$(MAKE) publish

major: test
	npx versions -C major
	$(MAKE) publish

.PHONY: test publish deps update patch minor major
