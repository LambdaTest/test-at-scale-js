#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-empty-function */
import glob from "fast-glob";
import path from "path";
import crypto from "crypto";
import parser from "yargs-parser";
import { hideBin } from "yargs/helpers";

import {
    DiscoveryResult,
    ExecutionResult,
    ExecutionResults,
    ID,
    RunnerException,
    Test,
    TestRunner,
    TestSuite,
    Util,
    Validations,
    Task,
    InputConfig,
} from "@lambdatest/test-at-scale-core";
import Jasmine from "jasmine";
import { CustomReporter } from "./jasmine-reporter"

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

    async execute(testFilesGlob: string|string[], config: string, locators: string[]=[]): Promise<ExecutionResult>   {
        const testLocators = new Set<string>(locators)
        const blockTestLocators = new Set<string>()
        const entityIdFilenameMap = new Map<number, string>();
        const runTask = new Task<ExecutionResult>();

        try {
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

            if (!testFilesToProcessList) {
                return new ExecutionResult();
            }
           
            const jasmineObj = await this.createJasmineRunner(config);

            await this.loadSpecs(jasmineObj, testFilesToProcessList, entityIdFilenameMap);
            const rootSuite = jasmineObj.env.topSuite();
            const specIdsToRun: number[] = [];
          
            this.fetchSpecIdsToRun(rootSuite, specIdsToRun, entityIdFilenameMap,
                testLocators, blockTestLocators);
            
                if (specIdsToRun.length == 0) {
                // pushing an invalid specID because if we pass empty array, it runs all specs
                specIdsToRun.push(-1);
            }
            const reporter = new CustomReporter(runTask, entityIdFilenameMap);
            jasmine.getEnv().addReporter(reporter);
            await jasmine.getEnv().execute(specIdsToRun as unknown as jasmine.Suite[]);
            const executionResult = await runTask.promise;
            Util.handleDuplicateTests(executionResult.testResults);
            if (locators.length > 0) {
                executionResult.testResults = Util.filterTestResultsByTestLocator(executionResult.testResults,
                    testLocators, blockTestLocators)
                if (executionResult.testSuiteResults.length > 0) {
                    executionResult.testSuiteResults = Util.filterTestSuiteResults(executionResult.testResults,
                        executionResult.testSuiteResults)
                }
            }

            // removing spec from cache to reload specs when new jasmine instance is created
            for (const spec of testFilesToProcessList) {
                delete require.cache[spec];
            }
            return executionResult;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (err: any) {
            throw new RunnerException(err.stack);
        }
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
        let locators: InputConfig = new InputConfig();
        const executionResults = new ExecutionResults(
            taskID,
            buildID,
            repoID,
            commitID,
            orgID,
            []
        );
        if (locatorFile) {
            locators = Util.getLocatorsConfigFromFile(locatorFile)
            const locatorSet = Util.createLocatorSet(locators)
            for (const set of locatorSet) {
                for (let i=1; i<=set.numberofexecutions; i++) {
                    const result = await this.execute(testFilesGlob, argv.config, set.locators)
                    executionResults.push(result)
                }
            }
        }  else {
            // run all tests if locator file is not present
            const result = await this.execute(testFilesGlob, argv.config)
            executionResults.push(result)
        }
        
        if (postTestResultsEndpoint) {
            await Util.makeApiRequestPost(postTestResultsEndpoint, executionResults);
        }
        return executionResults;   
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
        blockTestLocators: Set<string>,
        ancestorTitles: string[] = [],
    ) {
        for (const child of currentSuite.children) {
            if ((child as jasmine.Suite).children !== undefined) {
                // child is a TestSuite
                const childSuite = child as jasmine.Suite;
                ancestorTitles.push(child.description);
                this.fetchSpecIdsToRun(childSuite, specIdsToRun, entityIdFilenameMap,
                    testLocators, blockTestLocators, ancestorTitles);
                ancestorTitles.pop();
            } else {
                // child is a Spec
                const filename = entityIdFilenameMap.get(child.id) ?? "";
                const locator = Util.getLocator(filename, ancestorTitles, child.description);
                const blockTest = Util.getBlockTestLocatorProperties(locator)
                if (testLocators.size > 0) {
                    if (testLocators.has(locator.toString())) {
                        if (!blockTest.isBlocked) {
                            specIdsToRun.push(child.id);
                        } else {
                            // keep list of block test locators, so as to not filter in final results
                            blockTestLocators.add(locator.toString());
                        }
                    }
                } else if (!blockTest.isBlocked) {
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
