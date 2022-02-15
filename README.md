
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
- `npm run bootstrap`

### Building a subpackage
- `npm run build:mocha`

### Build all
- `npm run build`

### Adding a dependency in a sub-package
Use `lerna` [commands](https://github.com/lerna/lerna/tree/main/commands/add#lernaadd).

## Used By

This project is used by:

- LambdaTest [TAS](https://tas.lambdatest.com/)
