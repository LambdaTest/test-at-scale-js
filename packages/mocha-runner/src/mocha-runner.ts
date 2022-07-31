#!/usr/bin/env node

import fs from "fs";
import glob from "fast-glob";
import path from "path";
import crypto from "crypto";
import parser from "yargs-parser";
import { hideBin } from "yargs/helpers";
import Mocha from "mocha";

import {
    DiscoveryResult,
    ExecutionResult,
    ExecutionResults,
    ID,
    RunnerException,
    Task,
    Test,
    TestResult,
    TestRunner,
    TestSuite,
    TestSuiteResult,
    Util,
    Validations,
} from "@lambdatest/test-at-scale-core";
import { CustomRunner, MochaHelper } from "./helper";

const originalRun = Mocha.Runner.prototype.run;
class MochaRunner implements TestRunner {

    private _blockTests: TestResult[] = [];
    private _blockTestLocators: Set<string> = new Set<string>();
    private _blockedSuites: TestSuiteResult[] = [];
    private _testlocator: Set<string> = new Set<string>();

    createMochaInstance(): Mocha {
        const argv = parser(hideBin(process.argv), { array: ['diff', "locator"] });
        const mocha = new Mocha(MochaHelper.getFilteredConfigs(argv));
        if (mocha.options.require !== undefined) {
            const cwd = process.cwd();
            module.paths.push(cwd, path.join(cwd, 'node_modules'));
            if (!(mocha.options.require instanceof Array)) {
                mocha.options.require = [mocha.options.require];
            }
            for (let mod of mocha.options.require) {
                const abs = fs.existsSync(mod) || fs.existsSync(mod + '.js');
                if (abs) {
                    mod = path.resolve(mod);
                }
                require(mod);
            }
        }
        return mocha;
    }
    async discoverTests(argv: parser.Arguments): Promise<DiscoveryResult> {
        const mocha = this.createMochaInstance()
        const tests: Test[] = [];
        const testSuites: TestSuite[] = [];

        Validations.validateDiscoveryEnv(argv);
        const repoID = process.env.REPO_ID as ID;
        const buildID = process.env.BUILD_ID as ID;
        const taskID = process.env.TASK_ID as ID;
        const orgID = process.env.ORG_ID as ID;
        const commitID = process.env.COMMIT_ID as ID;
        const branch = process.env.BRANCH_NAME as string;
        const testFilesGlob = argv.pattern as string | string[];
        const testFiles = glob.sync(testFilesGlob).map(file => path.resolve(file));
        if (testFiles.length === 0) {
            return new DiscoveryResult([], [], [], repoID, commitID, buildID, taskID, orgID, branch);
        }
        const changedFilesSet = argv.diff === undefined ? undefined : new Set(argv.diff as string | string[]);

        for (const filename of testFiles) {
            mocha.addFile(filename);
        }
        try {
            await mocha.loadFilesAsync();
        } catch (err) {
            mocha['loadFiles']();
        }

        // pass root suite
        this.listTestsAndTestSuites(mocha.suite, tests, testSuites);
        Util.handleDuplicateTests(tests);
        const [impactedTests, executeAllTests] = await Util.findImpactedTests(tests, changedFilesSet, testFiles);

        const result = new DiscoveryResult(tests, testSuites, impactedTests,
            repoID, commitID, buildID, taskID, orgID, branch, executeAllTests);
        Util.fillTotalTests(result);
        return result;
    }

    async execute(testFilesGlob: string | string[], shuffleTest: boolean, locators: string [] = []): Promise<ExecutionResult> {
        const mocha = this.createMochaInstance()
        const testRunTask = new Task<void>();

        this._testlocator = new Set<string>(locators);

        this.extendNativeRunner(shuffleTest);
        mocha.reporter(require.resolve("./mocha-reporter"));

        let testFilesToProcess: Set<string> = new Set();

        if (this._testlocator.size == 0) {
            const testFiles = glob.sync(testFilesGlob).map(file => path.resolve(file));
            testFilesToProcess = new Set(testFiles);
        } else {
            testFilesToProcess = Util.getFilesFromTestLocators(this._testlocator)
        }
        const testFilesToProcessList = Array.from(testFilesToProcess);

        for (const filename of testFilesToProcessList) {
            mocha.addFile(filename);
        }
        const runnerWithResults: CustomRunner = mocha.run(() => {
            testRunTask.resolve();
        });
        await testRunTask.promise;
        const results = new ExecutionResult(
            runnerWithResults.testResults ?? [],
            runnerWithResults.testSuiteResults ?? []
        );
        results.testResults = results.testResults.concat(this._blockTests);
        results.testSuiteResults = results.testSuiteResults.concat(this._blockedSuites);
        Util.handleDuplicateTests(results.testResults);
        if (this._testlocator.size > 0) {
            results.testResults = Util.filterTestResultsByTestLocator(results.testResults,
                this._testlocator, this._blockTestLocators);
        }
        // clearing blockTests and suites for next run
        this._blockTests = [];
        this._blockedSuites = [];
        return results;
    }

    async executeTests(argv: parser.Arguments): Promise<ExecutionResults> {
        const taskID = process.env.TASK_ID as ID;
        const buildID = process.env.BUILD_ID as ID;
        const orgID = process.env.ORG_ID as ID;
        const repoID = process.env.REPO_ID as ID;
        const commitID = process.env.COMMIT_ID as ID;
        const shuffleTest = JSON.parse(process.env.SHUFFLE_TEST as string) as boolean;
        Validations.validateExecutionEnv(argv);
        const testFilesGlob = argv.pattern as string | string[];
        const locatorFile = argv.locatorFile as string;
        const executionResults = new ExecutionResults(
            taskID,
            buildID,
            repoID,
            commitID,
            orgID,
        );

        if (locatorFile) {
            const locators = Util.getLocatorsFromFile(locatorFile);
            const result = await this.execute(testFilesGlob, shuffleTest, locators);
            executionResults.push(result);
        } else {
            // run all tests if locator file is not present
            const result = await this.execute(testFilesGlob, shuffleTest)
            executionResults.push(result)
        }
        return executionResults;
    }

    private listTestsAndTestSuites(
        currentSuite: Mocha.Suite,
        tests: Test[],
        testSuites: TestSuite[],
        ancestorTitles: string[] = []
    ) {
        const repoID = process.env.REPO_ID as ID;

        for (const childSuite of currentSuite.suites) {
            const filename = childSuite.file ?? "";
            ancestorTitles.push(childSuite.title);
            const suiteIdentifier = Util.getIdentifier(filename, childSuite.title);
            const suiteIdentifiers = ancestorTitles.map((suiteName) => Util.getIdentifier(filename, suiteName));
            const parentSuiteIdentifiers = suiteIdentifiers.slice(0, -1);
            const testSuite = new TestSuite(
                crypto
                    .createHash("md5")
                    .update(repoID + "\n" + suiteIdentifiers.join("\n"))
                    .digest("hex"),
                suiteIdentifier,
                parentSuiteIdentifiers.length > 0
                    ? crypto
                        .createHash("md5")
                        .update(repoID + "\n" + parentSuiteIdentifiers.join("\n"))
                        .digest("hex")
                    : null
            )
            testSuites.push(testSuite);
            this.listTestsAndTestSuites(childSuite, tests, testSuites, ancestorTitles);
            ancestorTitles.pop();
        }

        for (const mochaTest of currentSuite.tests) {
            const filename = mochaTest.file ?? "";
            const testIdentifier = Util.getIdentifier(filename, mochaTest.title);
            const suiteIdentifiers = ancestorTitles.map((suiteName) => Util.getIdentifier(filename, suiteName));
            const test = new Test(
                crypto
                    .createHash("md5")
                    .update(repoID + "\n" + suiteIdentifiers.join("\n") + "\n" + testIdentifier)
                    .digest("hex"),
                testIdentifier,
                mochaTest.title,
                suiteIdentifiers.length > 0
                    ? crypto
                        .createHash("md5")
                        .update(repoID + "\n" + suiteIdentifiers.join("\n"))
                        .digest("hex")
                    : null,
                path.relative(Util.REPO_ROOT, filename),
                Util.getLocator(filename, ancestorTitles, mochaTest.title)
            );
            tests.push(test);
        }
    }

    private extendNativeRunner(shuffleTest: boolean) {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const _self = this;
        // This is the hook point where we can randomizee, specify order
        // or do any sort of stuffs with suites and tests
        Mocha.Runner.prototype.run = function (fn: ((failures: number) => void)) {
            _self.filterSpecsAndDetermineOrder(this.suite, shuffleTest);
            return originalRun.call(this, fn);
        };
    }

    private filterSpecsAndDetermineOrder(suite: Mocha.Suite, shuffleTest:boolean) {
        if (suite.tests) {
            if(shuffleTest){
                suite.tests = Util.shuffle(suite.tests) as Mocha.Test[];
            }
            const filteredTests: Mocha.Test[] = [];
            for (const test of suite.tests) {
                const filename = test.file ?? "";
                const parentSuites: string[] = [];
                MochaHelper.getParentSuites(test, parentSuites);
                parentSuites.reverse();
                const locator = Util.getLocator(filename, parentSuites, test.title ?? "");
                const blockTest = Util.getBlockTestLocatorProperties(locator);
                if (this._testlocator.size > 0) {
                    // if locators exist and not blocked then only add in filter tests.
                    if (this._testlocator.has(locator.toString())) {
                        if (!blockTest.isBlocked) {
                            filteredTests.push(test);
                        } else {
                            const testResult = MochaHelper.transformMochaTestAsTestResult(
                                test,
                                new Date(),
                                Util.getTestStatus(blockTest.status)
                            );
                            this._blockTestLocators.add(testResult.locator.toString());
                            this._blockTests.push(testResult);
                        }
                    }
                } else {
                    // if no test locators specified, then we will execute all 
                    // and filter out blocked ones
                    if (blockTest.isBlocked) {
                        const testResult = MochaHelper.transformMochaTestAsTestResult(
                            test,
                            new Date(),
                            Util.getTestStatus(blockTest.status)
                        );
                        this._blockTestLocators.add(testResult.locator.toString());
                        this._blockTests.push(testResult);
                    } else {
                        filteredTests.push(test);
                    }
                }
            }
            suite.tests = filteredTests;         
        }
        if (suite.suites) {
            if (shuffleTest){
                suite.suites = Util.shuffle(suite.suites) as Mocha.Suite[];
            }
            for (const childSuite of suite.suites) {
                const filename = childSuite.file ?? "";
                const parentSuites: string[] = [];
                MochaHelper.getParentSuites(childSuite, parentSuites);
                parentSuites.reverse();
                const locator = Util.getLocator(filename, parentSuites, childSuite.title ?? "");
                const blockTest = Util.getBlockTestLocatorProperties(locator)
                if (blockTest.isBlocked) {
                    const suiteResult = MochaHelper.transformMochaSuiteAsSuiteResult(
                        childSuite,
                        new Date(),
                        Util.getTestStatus(blockTest.status)
                    );
                    this._blockedSuites.push(suiteResult);
                }
                this.filterSpecsAndDetermineOrder(childSuite, shuffleTest);
            }
        }
    }
}

(async () => {
    const runner = new MochaRunner();
    try {
        const argv = parser(hideBin(process.argv), {
            array: ['diff', "locator"],
            configuration: { 'strip-dashed': true },
        });

        if (!argv.command) {
            throw Error("Command not provided.");
        }
        let result: DiscoveryResult | ExecutionResults;
        let endpoint: string;

        if (argv.command === "discover") {
            result = await runner.discoverTests(argv);
            endpoint = process.env.ENDPOINT_POST_TEST_LIST as string || "";
        } else if (argv.command === "execute") {
            result = await runner.executeTests(argv);
            endpoint = process.env.ENDPOINT_POST_TEST_RESULTS as string || "";
        } else {
            throw Error("Unknown/Not implemented command")
        }
        if (endpoint) {
            try {
                await Util.makeApiRequestPost(endpoint, result);
            } catch (err: any) {
                throw new RunnerException(err.stack);
            }
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
        console.error(e.stack);
        process.exit(-1);
    }
    process.exit(0);
})();

