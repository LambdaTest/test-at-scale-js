#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-explicit-any */

import glob from "fast-glob";
import path from "path";
import fs from "fs";
import parser from "yargs-parser";
import semver from "semver";
import type { Config } from '@jest/types';
import { runCLI, getVersion } from "jest";
import { readConfig } from "jest-config";
import { hideBin } from "yargs/helpers";
import {
    DiscoveryResult,
    ExecutionResult,
    ExecutionResults,
    ID,
    JSONStream,
    LocatorSeparator,
    RunnerException,
    Test,
    TestRunner,
    Locator,
    TestSuite,
    Util,
    Validations,
} from "@lambdatest/test-at-scale-core";
import {
    DISCOVERY_RESULT_FILE,
    JEST_CACHE_DIR,
    MATCH_NOTHING_REGEX,
    REPORT_FILE,
    SETUP_AFTER_ENV_FILE
} from "./constants";

class JestRunner implements TestRunner {

    private setEnv() {
        // Jest CLI will set process.env.NODE_ENV to 'test' when it's null, do the same here
        // https://github.com/facebook/jest/blob/master/packages/jest-cli/bin/jest.js#L12-L14
        if (!process.env.NODE_ENV) {
            process.env.NODE_ENV = 'test';
        }
    }
    constructor() {
        this.setEnv()
    }
    async discoverTests(argv: parser.Arguments): Promise<DiscoveryResult> {
        Validations.validateDiscoveryEnv(argv);
        const repoID = process.env.REPO_ID as ID;
        const buildID = process.env.BUILD_ID as ID;
        const taskID = process.env.TASK_ID as ID;
        const orgID = process.env.ORG_ID as ID;
        const commitID = process.env.COMMIT_ID as ID;
        const postTestListEndpoint = process.env.ENDPOINT_POST_TEST_LIST as string || "";
        const branch = process.env.BRANCH_NAME as string;
        const testFilesGlob = argv.pattern as string
        const testFiles = glob.sync(testFilesGlob).map(file => path.resolve(file));
        if (testFiles.length === 0) {
            return new DiscoveryResult([], [], [], repoID, commitID, buildID, taskID, orgID, branch);
        }
        const changedFiles = argv.diff as Array<string> | string[];
        const changedFilesSet = new Set(changedFiles);
        const testsDepsMap = await Util.listDependencies(testFiles);

        const st = new Date();
        await this.runJest(testFiles, MATCH_NOTHING_REGEX, [require.resolve("./jest-discover-reporter")]);

        console.log("Dry run took:", (new Date()).getTime() - st.getTime(), "ms");

        const result = (await JSONStream.parse(fs.createReadStream(DISCOVERY_RESULT_FILE))) ?? {};
        const tests: Test[] = (result.tests ?? []).map((test: any) => Test.fromJSON(test));
        const testSuites: TestSuite[] = (result.testSuites ?? []).map(TestSuite.fromJSON);
        Util.handleDuplicateTests(tests);
        const [impactedTests, executeAllTests] = await Util.findImpactedTests(testsDepsMap, tests, changedFilesSet);

        const discoveryResult = new DiscoveryResult(tests,
            testSuites,
            impactedTests,
            repoID, commitID, buildID, taskID, orgID, branch, executeAllTests);
        Util.fillTotalTests(discoveryResult);
        if (postTestListEndpoint) {
            try {
                await Util.makeApiRequestPost(postTestListEndpoint, discoveryResult);
            } catch (err: any) {
                throw new RunnerException(err.stack);
            }
        }
        return discoveryResult;
    }

    async execute(testFilesGlob: string | string[], locators: string[] = []): Promise<ExecutionResult> {
        const testLocators = new Set<string>(locators);

        let testFilesToProcess: Set<string> = new Set();

        if (testLocators.size == 0) {
            const testFiles = glob.sync(testFilesGlob).map(file => path.resolve(file));
            testFilesToProcess = new Set(testFiles);
        } else {
            testFilesToProcess = Util.getFilesFromTestLocators(testLocators)
        }


        const testFilesToProcessList = Array.from(testFilesToProcess);
        if (testFilesToProcessList.length == 0) {
            return new ExecutionResult();
        }
        const [regex, blockTestLocators] = this.getBlockTestAndTestRegex(testFilesToProcessList, testLocators)

        await this.runJest(
            testFilesToProcessList,
            regex,
            [require.resolve("./jest-reporter")],
            true
        );
        const executionResult = ExecutionResult.fromJSON(await JSONStream.parse(fs.createReadStream(REPORT_FILE)));

        Util.handleDuplicateTests(executionResult.testResults);
        if (locators.length > 0) {
            executionResult.testResults = Util.filterTestResultsByTestLocator(executionResult.testResults,
                testLocators, blockTestLocators)
            if (executionResult.testSuiteResults.length > 0) {
                executionResult.testSuiteResults = Util.filterTestSuiteResults(executionResult.testResults,
                    executionResult.testSuiteResults)
            }
        }
        return executionResult;
    }
    async executeTests(argv: parser.Arguments): Promise<ExecutionResults> {
        const taskID = process.env.TASK_ID as ID;
        const buildID = process.env.BUILD_ID as ID;
        const orgID = process.env.ORG_ID as ID;
        const repoID = process.env.REPO_ID as ID;
        const commitID = process.env.COMMIT_ID as ID;
        Validations.validateExecutionEnv(argv);
        const postTestResultsEndpoint = process.env.ENDPOINT_POST_TEST_RESULTS as string || "";
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
            const result = await this.execute(testFilesGlob, locators);
            executionResults.push(result);
        }
        else {
            // run all tests if locator file is not present
            const result = await this.execute(testFilesGlob)
            executionResults.push(result)
        }
        if (postTestResultsEndpoint) {
            await Util.makeApiRequestPost(postTestResultsEndpoint, executionResults);
        }
        return executionResults;
    }

    private async runJest(
        testFilesToProcessList: string[],
        testNamePattern: string,
        reporters: (string | Config.ReporterConfig)[],
        inExecutionPhase = false
    ) {
        const argv = parser(hideBin(process.argv));
        const jestArgv: Config.Argv = {
            $0: "jest-runner",
            _: testFilesToProcessList,
            testNamePattern: testNamePattern,
            config: argv.config,
            collectCoverage: inExecutionPhase && !!process.env.TAS_COLLECT_COVERAGE,
            cacheDirectory: JEST_CACHE_DIR
        };
        if (inExecutionPhase) {
            const { globalConfig, projectConfig } = await readConfig(jestArgv, Util.REPO_ROOT);
            if (semver.lt(getVersion(), "24.0.0")) {
                jestArgv.setupTestFrameworkScriptFile = SETUP_AFTER_ENV_FILE;
            } else {
                jestArgv.setupFilesAfterEnv = [SETUP_AFTER_ENV_FILE].concat(projectConfig.setupFilesAfterEnv);
            }
            if (!globalConfig.reporters) {
                reporters = reporters.concat(["default"]);
            } else {
                reporters = reporters.concat(globalConfig.reporters);
            }
            jestArgv.runInBand = true;
        } else {
            jestArgv.silent = true;
        }
        jestArgv.reporters = reporters as unknown as string[];
        await runCLI(jestArgv, [Util.REPO_ROOT]);
    }

    private getBlockTestAndTestRegex(testFiles: string[], testLocators: Set<string>): [string, Set<string>] {
        const filteredTestsRegexes: string[] = [];
        const blockTestLocators = new Set<string>()

        if (testLocators.size > 0) {
            for (const locator of testLocators) {
                const loc = Locator.from(locator)
                if (!loc) {
                    continue;
                }
                const blockTest = Util.getBlockTestLocatorProperties(loc)
                let parts = loc.child ? loc.child.toString().split(LocatorSeparator) : [];
                // parts = [file.js, testSuite1, testSuite2, testName]
                parts = parts.filter((part) => part.length > 0);
                if (parts.length > 0) {
                    const testFullName = parts.join(" ");
                    // testRegex = (^testSuite1 testSuite2 testName$)
                    const testRegex = "(^" + Util.escapeRegExp(testFullName) + "$)";
                    if (!blockTest.isBlocked) {
                        filteredTestsRegexes.push(testRegex);
                    } else {
                        blockTestLocators.add(loc.toString());
                    }
                }
            }
            // if all tests in the locators were blocked then we will execute nothing
            if (filteredTestsRegexes.length == 0) {
                return [MATCH_NOTHING_REGEX, blockTestLocators];
            }
            // (^testSuite1 testSuite2 testName$)|(^testSuite3 testSuite4 testName2$)
            return [filteredTestsRegexes.join("|"), blockTestLocators];
        }
        // in case no test locators specified we will execute all tests 
        // but first filter out blocktest ones
        const blockTestsRegexes: string[] = [];
        for (const testFile of testFiles) {
            const relFilePath = path.relative(Util.REPO_ROOT, testFile);
            const blockTestLocators = Util.getBlockTestLocatorsForFile(relFilePath).map((item) => item.locator);
            for (const blockTestLocator of blockTestLocators) {
                let parts = blockTestLocator.split(LocatorSeparator);
                // parts = [file.js, testSuite1, testSuite2, testName]
                parts = parts.filter((part) => part.length > 0);
                parts.shift();
                if (parts.length > 0) {
                    const testFullName = parts.join(" ");
                    // testRegex = (^testSuite1 testSuite2 testName)
                    const testRegex = "(^" + Util.escapeRegExp(testFullName) + ")";
                    blockTestsRegexes.push(testRegex);
                }
            }
        }
        // if only blocked tests exist, then return block tests regex
        if (blockTestsRegexes.length > 0) {
            // ^(?!(^testSuite1 testSuite2 testName)|(^testSuite3 testSuite4 testName2)).*$
            return ["^(?!" + blockTestsRegexes.join("|") + ").*$", blockTestLocators];
        }

        return ["", blockTestLocators];
    }
}

(async () => {
    const runner = new JestRunner();
    try {
        const argv = parser(hideBin(process.argv), {
            array: ['diff', "locator"],
            configuration: { 'strip-dashed': true },
        });
        if (!argv.command) {
            throw Error("Command not provided.");
        }
        if (argv.command === "discover") {
            await runner.discoverTests(argv);
        } else if (argv.command === "execute") {
            await runner.executeTests(argv);
        } else {
            throw Error("Unknown/Not implemented command")
        }
    } catch (e: any) {
        console.error(e.stack);
        process.exit(-1);
    }
    process.exit(0);
})();
