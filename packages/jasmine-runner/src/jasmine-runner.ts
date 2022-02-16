#!/usr/bin/env node
//* eslint-disable @typescript-eslint/no-empty-function */

import glob from "fast-glob";
import path from "path";
import crypto from "crypto";
import parser from "yargs-parser";
import { hideBin } from "yargs/helpers";
import fs from "fs";

import {
    DiscoveryResult,
    ExecutionResult,
    ID,
    RunnerException,
    Test,
    TestRunner,
    TestSuite,
    Util,
    Validations,
    Task
} from "@lambdatest/test-at-scale-core";
import Jasmine from "jasmine";
import { CustomReporter } from "./jasmine-reporter";

class JasmineRunner implements TestRunner {

    async discoverTests(argv: parser.Arguments): Promise<DiscoveryResult> {
        const tests: Test[] = [];
        const testSuites: TestSuite[] = [];
        const entityIdFilenameMap = new Map<number, string>();

        Validations.validateDiscoveryEnv(argv);
        const repoID = process.env.REPO_ID as ID;
        const parallelism = isNaN(Number(process.env.TAS_PARALLELISM)) ? 0 : Number(process.env.TAS_PARALLELISM);
        const orgID = process.env.ORG_ID as ID;
        const buildID = process.env.BUILD_ID as ID;
        const taskID = process.env.TASK_ID as ID;
        const commitID = process.env.COMMIT_ID as ID;
        const postTestListEndpoint = process.env.ENDPOINT_POST_TEST_LIST as string || "";
        const branch = process.env.BRANCH_NAME as string;
        const testFilesGlob = argv.pattern as string | string[];
        const changedFiles = argv.diff as Array<string>;
        const changedFilesSet = new Set(changedFiles);

        try {
            const testFiles = glob.sync(testFilesGlob).map(file => path.resolve(file));
            const testsDepsMap = await Util.listDependencies(testFiles);
            const jasmineObj = await this.createJasmineRunner(argv.config);
            await this.loadSpecs(jasmineObj, testFiles, entityIdFilenameMap);
            const rootSuite = jasmineObj.env.topSuite();
            this.listTestsAndTestSuites(rootSuite, tests, testSuites, entityIdFilenameMap);
            Util.handleDuplicateTests(tests);
            const impactedTests = Util.findImpactedTests(testsDepsMap, tests, changedFilesSet);

            const result = new DiscoveryResult(tests, testSuites, impactedTests,
                repoID, commitID, buildID, taskID, orgID, branch, !!argv.diff, parallelism);
            Util.fillTotalTests(result);
            if (postTestListEndpoint) {
                await Util.makeApiRequestPost(postTestListEndpoint, result);
            }
            return result;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (err: any) {
            throw new RunnerException(err.stack);
        }
    }

    async executeTests(argv: parser.Arguments): Promise<ExecutionResult[]> {
        const runTask = new Task<ExecutionResult>();
        const entityIdFilenameMap = new Map<number, string>();

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
        const locatorFile = argv.locatorFile as string;
        let locators;
        if (locatorFile) {
            locators = Util.getLocatorsFromFile(locatorFile);
        } else {
            locators = argv.locator as Array<string> ? argv.locator : Array<string>();
        }
        const testLocators = new Set<string>(locators)
        const blockListedLocators = new Set<string>()
        try {
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

            if (!testFilesToProcessList) {
                executionResults.push(new ExecutionResult(taskID, buildID, repoID, commitID, orgID));
                return executionResults
            }

            for (let i=1; i<=n; i++) {    
                const jasmineObj = await this.createJasmineRunner(argv.config);
                await this.loadSpecs(jasmineObj, testFilesToProcessList, entityIdFilenameMap);
                const specIdsToRun: number[] = [];
                this.fetchSpecIdsToRun(jasmine.getEnv().topSuite(), specIdsToRun, entityIdFilenameMap,
                    testLocators, blockListedLocators);
                if (specIdsToRun.length == 0) {
                    // pushing an invalid specID because if we pass empty array, it runs all specs
                    specIdsToRun.push(-1);
                }
                const reporter = new CustomReporter(runTask, entityIdFilenameMap);
                jasmineObj.env.addReporter(reporter);
                await jasmine.getEnv().execute(specIdsToRun as unknown as jasmine.Suite[]);
                const executionResult = await runTask.promise;
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
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (err: any) {
            throw new RunnerException(err.stack);
        }
    }

    private async createJasmineRunner(jasmineConfigFile: string | undefined): Promise<Jasmine> {
        const projectBaseDir = Util.REPO_ROOT;
        const jasmineObj = new Jasmine({ projectBaseDir: projectBaseDir });
        // Load config file (usually spec/support/jasmine.json) if provided
        if (jasmineConfigFile !== undefined) {
            const absoluteConfigFilePath = path.resolve(projectBaseDir, jasmineConfigFile);
            const config = (await import(absoluteConfigFilePath)).default as jasmine.JasmineConfig;

            // override following configs of provided configFile
            config.failSpecWithNoExpectations = false;
            config.random = false;
            config.stopOnSpecFailure = false;
            config.stopSpecOnExpectationFailure = false;
            config.spec_files = undefined;

            jasmineObj.loadConfig(config);
            await jasmineObj.loadHelpers();
        }

        jasmineObj.env.clearReporters();
        jasmineObj.randomizeTests(false);
        return jasmineObj;
    }

    private async loadSpecs(jasmineObj: Jasmine, testFiles: string[], entityIdFilenameMap: Map<number, string>) {
        let topSuiteIdx = 0;
        for (const filename of testFiles) {
            jasmineObj.addSpecFile(filename);
            await jasmineObj.loadSpecs();
            const topSuite = jasmineObj.env.topSuite();
            for (let idx = topSuiteIdx; idx < topSuite.children.length; idx++) {
                this.mapSpecOrSuiteIdsToFiles(topSuite.children[idx], filename, entityIdFilenameMap);
            }
            topSuiteIdx = topSuite.children.length;
        }
    }

    private mapSpecOrSuiteIdsToFiles(
        entity: jasmine.Spec | jasmine.Suite,
        filename: string,
        entityFilenameMap: Map<number, string>
    ) {
        const entityAsSuite = entity as jasmine.Suite;
        if (entityAsSuite.children !== undefined) {
            // entity is a TestSuite
            entityFilenameMap.set(entity.id, filename);
            entityAsSuite.children.map((child) => this.mapSpecOrSuiteIdsToFiles(child, filename, entityFilenameMap));
        } else {
            // entity is a Test
            entityFilenameMap.set(entity.id, filename);
        }
    }

    private listTestsAndTestSuites(
        currentSuite: jasmine.Suite,
        tests: Test[],
        testSuites: TestSuite[],
        entityFilenameMap: Map<number, string>,
        ancestorTitles: string[] = []
    ) {
        const repoID = process.env.REPO_ID as ID;
        const commitID = process.env.COMMIT_ID as ID;

        for (const child of currentSuite.children) {
            if ((child as jasmine.Suite).children !== undefined) {
                // child is a TestSuite
                const filename = entityFilenameMap.get(child.id) ?? "";
                const childSuite = child as jasmine.Suite;
                ancestorTitles.push(child.description);
                const suiteIdentifier = Util.getIdentifier(filename, child.description);
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
                this.listTestsAndTestSuites(childSuite, tests, testSuites, entityFilenameMap, ancestorTitles);
                ancestorTitles.pop();
            } else {
                // child is a Spec
                const filename = entityFilenameMap.get(child.id) ?? "";
                const testIdentifier = Util.getIdentifier(filename, child.description);
                const suiteIdentifiers = ancestorTitles.map((suiteName) => Util.getIdentifier(filename, suiteName));
                const test = new Test(
                    crypto
                        .createHash("md5")
                        .update(repoID + "\n" + suiteIdentifiers.join("\n") + "\n" + testIdentifier)
                        .digest("hex"),
                    testIdentifier,
                    child.description,
                    suiteIdentifiers.length > 0
                        ? crypto
                            .createHash("md5")
                            .update(repoID + "\n" + suiteIdentifiers.join("\n"))
                            .digest("hex")
                        : null,
                    commitID,
                    path.relative(Util.REPO_ROOT, filename),
                    Util.getLocator(filename, ancestorTitles, child.description)
                );
                tests.push(test);
            }
        }
    }

    private fetchSpecIdsToRun(
        currentSuite: jasmine.Suite,
        specIdsToRun: number[],
        entityIdFilenameMap: Map<number, string>,
        testLocators: Set<string>,
        blockListedTestLocators: Set<string>,
        ancestorTitles: string[] = [],
    ) {
        for (const child of currentSuite.children) {
            if ((child as jasmine.Suite).children !== undefined) {
                // child is a TestSuite
                const childSuite = child as jasmine.Suite;
                ancestorTitles.push(child.description);
                this.fetchSpecIdsToRun(childSuite, specIdsToRun, entityIdFilenameMap,
                    testLocators, blockListedTestLocators, ancestorTitles);
                ancestorTitles.pop();
            } else {
                // child is a Spec
                const filename = entityIdFilenameMap.get(child.id) ?? "";
                const locator = Util.getLocator(filename, ancestorTitles, child.description);
                const blockListed = Util.isBlocklistedLocator(locator)
                if (testLocators.size > 0) {
                    if (testLocators.has(locator.toString()) && !blockListed) {
                        specIdsToRun.push(child.id);
                    } else if (blockListed) {
                        // keep list of blacklisted locators, so as to not filter in final results
                        blockListedTestLocators.add(locator.toString());
                    }
                } else if (!blockListed) {
                    specIdsToRun.push(child.id);
                }

            }
        }
    }
}

(async () => {
    const runner = new JasmineRunner();
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
        console.error(e.stack);
        process.exit(-1);
    }
    console.log("done");
    process.exit(0);
})();
