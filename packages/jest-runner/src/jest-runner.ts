#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-explicit-any */

import glob from "fast-glob";
import path from "path";
import fs from "fs";
import parser from "yargs-parser";
import semver from "semver";
import type { Config } from '@jest/types';
import { runCLI, getVersion } from "jest";
import { readConfigs } from "jest-config";
import { hideBin } from "yargs/helpers";
import {
    DiscoveryResult,
    ExecutionResult,
    ID,
    JSONStream,
    LocatorSeparator,
    RunnerException,
    TAS_DIRECTORY,
    Test,
    TestRunner,
    TestsDependenciesMap,
    TestSuite,
    Util,
    Validations
} from "@lambdatest/test-at-scale-core";
import {
    DISCOVERY_RESULT_FILE,
    MATCH_NOTHING_REGEX,
    REPORT_FILE,
    SETUP_AFTER_ENV_FILE,
    TESTS_DEPENDENCIES_MAP_FILE
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
        const parallelism = isNaN(Number(process.env.TAS_PARALLELISM)) ? 0 : Number(process.env.TAS_PARALLELISM);
        const postTestListEndpoint = process.env.ENDPOINT_POST_TEST_LIST as string || "";
        const branch = process.env.BRANCH_NAME as string;
        const cleanup = (argv.cleanup as boolean) ? argv.cleanup : true;
        const testFilesGlob = argv.pattern as string
        const testFiles = glob.sync(testFilesGlob).map(file => path.resolve(file));
        if (testFiles.length === 0) {
            return new DiscoveryResult([], [], [], repoID, commitID, buildID, taskID, orgID, branch);
        }
        const changedFiles = argv.diff as Array<string> | string[];
        const changedFilesSet = new Set(changedFiles);
        await this.runJest(testFiles, MATCH_NOTHING_REGEX, [require.resolve("./jest-discover-reporter")]);

        const result = (await JSONStream.parse(fs.createReadStream(DISCOVERY_RESULT_FILE))) ?? {};
        const tests: Test[] = (result.tests ?? []).map((test: any) => Test.fromJSON(test));
        const testSuites: TestSuite[] = (result.testSuites ?? []).map(TestSuite.fromJSON);
        Util.handleDuplicateTests(tests);

        const testsDeps = await JSONStream.parse(fs.createReadStream(TESTS_DEPENDENCIES_MAP_FILE));
        let testsDepsMap: TestsDependenciesMap | null = null;
        if (testsDeps !== null) {
            testsDepsMap = new Map<string, Set<string>>();
            for (const [k, v] of Object.entries(testsDeps)) {
                testsDepsMap.set(k, new Set<string>(v as string[]));
            }
        }
        const impactedTests = Util.findImpactedTests(testsDepsMap, tests, changedFilesSet);

        const discoveryResult = new DiscoveryResult(tests,
            testSuites,
            impactedTests,
            repoID, commitID, buildID, taskID, orgID, branch, !!argv.diff, parallelism);
        if (cleanup) {
            await fs.promises.rm(TAS_DIRECTORY, { recursive: true });
        }
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

    async executeTests(argv: parser.Arguments): Promise<ExecutionResult[]> {
        Validations.validateExecutionEnv(argv);
        const n = argv.n as number || 1
        const skipTestStats = argv.skipteststats as boolean || false;
        const postTestResultsEndpoint = (skipTestStats) ? "" : (process.env.ENDPOINT_POST_TEST_RESULTS as string || "");
        const taskID = process.env.TASK_ID as ID;
        const buildID = process.env.BUILD_ID as ID;
        const orgID = process.env.ORG_ID as ID;
        const repoID = process.env.REPO_ID as ID;
        const commitID = process.env.COMMIT_ID as ID;
        const testFilesGlob = argv.pattern as string | string[];
        const cleanup = (argv.cleanup as boolean) ? argv.cleanup : true;
        const locatorFile = argv.locatorFile as string;
        let locators
        if (locatorFile) {
            locators = Util.getLocatorsFromFile(locatorFile)
        } else {
            locators = argv.locator as Array<string> ? argv.locator : Array<string>();
        }
        const testLocators = new Set<string>(locators);

        let testFilesToProcess: Set<string> = new Set();

        if (testLocators.size == 0) {
            const testFiles = glob.sync(testFilesGlob).map(file => path.resolve(file));
            testFilesToProcess = new Set(testFiles);
        } else {
            testFilesToProcess = Util.getFilesFromTestLocators(testLocators)
        }


        const executionResults: ExecutionResult[] = []
        const testFilesToProcessList = Array.from(testFilesToProcess);
        if (testFilesToProcessList.length == 0) {
            executionResults.push(new ExecutionResult(taskID, buildID, repoID, commitID, orgID));
            return executionResults
        }

        const [regex, blockListedLocators] = this.getBlockListedTestAndTestRegex(testFilesToProcessList, testLocators)
        for (let i=1; i<=n; i++) {       
            await this.runJest(
                testFilesToProcessList,
                regex,
                [require.resolve("./jest-reporter")],
                true
            );
            const executionResult = ExecutionResult.fromJSON(await JSONStream.parse(fs.createReadStream(REPORT_FILE)));

            if (cleanup) {
                await fs.promises.rm(TAS_DIRECTORY, { recursive: true });
            }
            Util.handleDuplicateTests(executionResult.testResults);
            if (locators.length > 0) {
                executionResult.testResults = Util.filterTestResultsByTestLocator(executionResult.testResults,
                    testLocators, blockListedLocators)
                if (executionResult.testSuiteResults.length > 0) {
                    executionResult.testSuiteResults = Util.filterTestSuiteResults(executionResult.testResults,
                        executionResult.testSuiteResults)
                }
            }
            if (postTestResultsEndpoint) {
                await Util.makeApiRequestPost(postTestResultsEndpoint, executionResult);

            }
            executionResults.push(executionResult)
        }
        const testfilepath = process.env.TEST_RESULT_FILE_PATH as string;
        fs.writeFileSync(testfilepath, JSON.stringify(executionResults));
        return executionResults;
    }

    private async runJest(
        testFilesToProcessList: string[],
        testNamePattern: string,
        reporters: string[],
        inExecutionPhase = false
    ) {
        const projectRoots = [Util.REPO_ROOT];
        const argv = parser(hideBin(process.argv));
        const jestArgv: Config.Argv = {
            $0: "jest-runner",
            _: testFilesToProcessList,
            ci: true,
            runInBand: true,
            testNamePattern: testNamePattern,
            useStderr: true,
            silent: true,
            config: argv.config,
            reporters: reporters,
            collectCoverage: inExecutionPhase && !!process.env.TAS_COLLECT_COVERAGE
        };
        if (inExecutionPhase) {
            if (semver.lt(getVersion(), "24.0.0")) {
                jestArgv.setupTestFrameworkScriptFile = SETUP_AFTER_ENV_FILE;
            } else {
                const { configs } = await readConfigs(jestArgv, projectRoots);
                const config = configs[0];
                jestArgv.setupFilesAfterEnv = [SETUP_AFTER_ENV_FILE].concat(config.setupFilesAfterEnv);
            }
        }
        await runCLI(jestArgv, projectRoots);
    }

    private getBlockListedTestAndTestRegex(testFiles: string[], testLocators: Set<string>): [string, Set<string>] {
        const blocklistedTestsRegexes: string[] = [];
        const filteredTestsRegexes: string[] = [];
        const blockListedTestLocators = new Set<string>()
        for (const testFile of testFiles) {
            const relFilePath = path.relative(Util.REPO_ROOT, testFile);
            const blocklistedLocators = Util.getBlocklistedLocatorsForFile(relFilePath).map((item) => item.locator);
            for (const blocklistedLocator of blocklistedLocators) {
                let parts = blocklistedLocator.split(LocatorSeparator);
                // parts = [file.js, testSuite1, testSuite2, testName]
                parts = parts.filter((part) => part.length > 0);
                parts.shift();
                if (parts.length > 0) {
                    const testFullName = parts.join(" ");
                    // testRegex = (?!(^testSuite1 testSuite2 testName$)
                    const testRegex = "^(" + Util.escapeRegExp(testFullName) + "$)";
                    blocklistedTestsRegexes.push(testRegex);
                }
                blockListedTestLocators.add(blocklistedLocator)
                if (testLocators.size > 0) {
                    // delete block listed tests from testLocators, so that they are excluded
                    testLocators.delete(blocklistedLocator)
                }
            }
        }
        // if only blocklisted tests exist, then return blocklist regex
        if (blocklistedTestsRegexes.length > 0 && testLocators.size == 0) {
            // ^(?!(^testSuite1 testSuite2 testName)|(^testSuite3 testSuite4 testName2)).*$
            return ["^(?!" + blocklistedTestsRegexes.join("|") + ").*$", blockListedTestLocators];
        }

        for (const locator of testLocators) {
            let parts = locator.split(LocatorSeparator);
            // parts = [file.js, testSuite1, testSuite2, testName]
            parts = parts.filter((part) => part.length > 0);
            parts.shift();
            if (parts.length > 0) {
                const testFullName = parts.join(" ");
                // testRegex = (^(testSuite1 testSuite2 testName$)
                const testRegex = "^(" + Util.escapeRegExp(testFullName) + "$)";
                filteredTestsRegexes.push(testRegex);
            }
        }

        if (filteredTestsRegexes.length > 0) {
            // ^((^testSuite1 testSuite2 testName$)|(^testSuite3 testSuite4 testName2$)).*$
            return ["^(" + filteredTestsRegexes.join("|") + ").*$", blockListedTestLocators];
        }

        return ["", blockListedTestLocators];
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
    console.log("done");
    process.exit(0);
})();
