
![LAMBDATEST Logo](http://labs.lambdatest.com/images/fills-copy.svg)

# Test At Scale

![N|Solid](https://www.lambdatest.com/resources/images/TAS_banner.png)

<p align="center">
  <b>Test Smarter, Release Faster with test-at-scale.</b>
</p>

<p align="center">
  <a href="https://github.com/LambdaTest/test-at-scale/tree/master/licenses"><img src="https://img.shields.io/badge/license-PolyForm--Shield--1.0.0-lightgrey"></img></a> <a href="https://discord.gg/Wyf8srhf6K"><img src="https://img.shields.io/badge/Discord-5865F2"></img></a>

</p>

## [Try It!!](https://github.com/LambdaTest/test-at-scale#table-of-contents)

# test-at-scale-js

Custom runners written on top of javascript testing frameworks. For running [Test-at-scale](https://www.lambdatest.com/test-at-scale) locally, follow [this](https://github.com/LambdaTest/test-at-scale).

This runner supports Mocha, Jest and jasmine. To request support for additional frameworks, raise an issue in this repository.

## Project Structure

Monorepo consisting of separate packages for each javascript testing framework managed using lerna.

- `test-at-scale-core` - Common package containing utilities and models being used
- `test-at-scale-jasmine-runner` - Custom jasmine runner
- `test-at-scale-jest-runner` - Custom jest runner
- `test-at-scale-mocha-runner` - Custom mocha runner

## Contributing

- Clone this monorepo.
- `yarn bootstrap`

### Building a subpackage

- `yarn build:mocha`

### Build all

- `yarn build`

### Adding a dependency in a sub-package

Use `lerna` [commands](https://github.com/lerna/lerna/tree/main/commands/add#lernaadd).

### Building it locally with test-at-scale's nucleus image
In order to use it (or test it) locally with [test-at-scale's](https://github.com/LambdaTest/test-at-scale) nucleus image, create an npm package zip using command `npm pack` at root of this repo and make the following changes in `nucleus/Dockerfile` (of test-at-scale repo):

Replace
```
RUN npm i --global-style --legacy-peer-deps \
    @lambdatest/test-at-scale-jasmine-runner@~0.1.0 \
    @lambdatest/test-at-scale-mocha-runner@~0.1.0 \
    @lambdatest/test-at-scale-jest-runner@~0.1.0
```
with
```
COPY <dir_containing_zip>/lambdatest-1.0.0.tgz .
RUN npm i --global-style --legacy-peer-deps lambdatest-1.0.0.tgz
```

## Used By

This project is used by:

- LambdaTest [TAS](https://tas.lambdatest.com/)
