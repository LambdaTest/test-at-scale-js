import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import util from 'util';
import child_process from 'child_process';
import axios, { AxiosError } from 'axios';
import { JSONStream } from './json-utils';
import {
    DiscoveryResult,
    ExecutionResults,
    ID,
    Locator,
    Test,
    TestResult,
    TestsDependenciesMap,
    TestSuiteResult,
    TestStatus,
    TestSuite,
    InputConfig,
    TestExecutionMode,
    LocatorSet,
    LocatorProperties
} from './model';
import {
    DEFAULT_API_TIMEOUT,
    LocatorSeparator,
    SMART_INPUT_FILE,
    SMART_OUT_FILE,
} from './constants';
const exec = util.promisify(child_process.exec);

export class Util {
    static REPO_ROOT = process.cwd();

    static smartSelectAvailable?: boolean;

    private static blockTestMap: { [key: string]: { source: string, locator: string, status: string }[]; } = {};
    private static blockTestMapInitialized = false;

    static noOp = (): void => { return };
    
    static getIdentifier(fileName: string, testName: string): string {
        const relFilePath = path.relative(this.REPO_ROOT, fileName);
        return testName + ' (' + relFilePath + ')';
    }

    // FIXME: This is a bad hack. DO NOT USE this.
    // This will break if absolute path of test filename contains '(' character.
    // HOW TO: Remove this usage and add `filename` property in model.Test and model.TestSuite
    static getFilenameFromIdentifier(identifier: string): string {
        return identifier.substring(identifier.lastIndexOf("(") + 1, identifier.length - 1);
    }

    static getLocator(currentFullPath: string, testSuites: string[], testName: string): Locator {
        let locator = new Locator(testName, null);
        for (let i = testSuites.length - 1; i >= 0; i--) {
            locator = new Locator(testSuites[i], locator);
        }
        const currentRelativePath = path.relative(this.REPO_ROOT, currentFullPath);
        locator = new Locator(currentRelativePath, locator);
        return locator;
    }

    /**
     * Loads blocked tests by reading a file at path specified by env var BLOCK_TESTS_FILE.
     * This works on the assumption that the format of JSON stored in file is in the following format:
     * {
     *     "<filename>": {
     *         "source": "api",
     *         "locator": "<filename>##<test-suite-name>##<test-case-name>"
     *         "status": "blocklisted"
     *     },
     *     "<filename2>": {
     *         "source": "yml",
     *         "locator": "<filename2>##<test-suite-name-2>##<test-case-name-2>"
     *         "status": "quarantined"
     *     }
     * }
     */
    private static loadBlockTests() {
        const blockTestFilePath = process.env.BLOCK_TESTS_FILE as string;
        if (!this.blockTestMapInitialized) {
            if (!!blockTestFilePath && fs.existsSync(blockTestFilePath)) {
                const data = JSON.parse(fs.readFileSync(blockTestFilePath).toString());
                for (const k in data) {
                    const relativeFilePath = path.relative(this.REPO_ROOT, k);
                    this.blockTestMap[relativeFilePath] = [];
                    for (const blocktest of data[k]) {
                        if (blocktest.locator) {
                            const locator_parts = blocktest.locator.split(LocatorSeparator);
                            locator_parts[0] = relativeFilePath;
                            this.blockTestMap[relativeFilePath].push({
                                source: blocktest.source || 'yml',
                                locator: locator_parts.join(LocatorSeparator),
                                status:blocktest.status
                            });
                        }
                    }
                }
            }
            this.blockTestMapInitialized = true;
        }
        return this.blockTestMap;
    }

    static getFilesFromTestLocators(locators: Set<string>): Set<string> {
        const files = new Set<string>();
        for (const locator of locators) {
            if (locator) {
                const file = path.resolve(locator.split(LocatorSeparator)[0])
                files.add(file)
            }
        }
        return files
    }

    static getTestStatus(status: string): TestStatus {
        switch (status) {
            case TestStatus.Passed:
                return TestStatus.Passed
            case TestStatus.Failed:
                return TestStatus.Failed
            case TestStatus.BlockListed:
                return TestStatus.BlockListed
            case TestStatus.Quarantined:
                 return TestStatus.Quarantined    
            default:
                return TestStatus.Skipped
        }
    }

    static getBlockTestLocatorsForFile(relFilePath: string): 
    { source: string, locator: string, status: string }[] {
        const blockTestLocators = this.loadBlockTests()[relFilePath];
        if (!blockTestLocators) {
            return [];
        }
        return blockTestLocators;
    }

    static getBlockTestLocatorProperties(locator: Locator): LocatorProperties {
        // outermost locator is the relative filepath
        const relFilePath = locator.current;
        const blockTestLocators = this.getBlockTestLocatorsForFile(relFilePath);
        const blockTestLocator = blockTestLocators.find((item) => {
            return Locator.from(item.locator)?.liesCompletelyIn(locator); });
        return {isBlocked:!!blockTestLocator, 
            status:blockTestLocator?.status ?? "",
            source:blockTestLocator?.source ?? null}
    }

    static async makeApiRequestPost(url: string, data: DiscoveryResult | ExecutionResults): Promise<void> {
        try {
            await axios.post(url, data, {
                timeout: DEFAULT_API_TIMEOUT,
                headers: {
                    'Content-Type': 'application/json'
                },
                maxBodyLength: Infinity,
                maxContentLength: Infinity
            });
        } catch (err) {
            if (axios.isAxiosError(err)) {
                const e = err as AxiosError;
                console.error('status code: ' + e.response?.status, 'data:', e.response?.data);
            }
            throw err;
        }
    }

    //https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_Expressions#escaping
    //https://stackoverflow.com/questions/3561493/is-there-a-regexp-escape-function-in-javascript/3561711#answer-3561711
    static escapeRegExp(str: string): string {
        return str.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'); // $& means the whole matched string
    }
    static async findImpactedTests(
        testsDepsMap: TestsDependenciesMap | null, 
        tests: Test[],
        changedFilesSet: Set<string>
    ): Promise<[ID[], boolean]>  {
        // 
        let executeAllTests = false;
        // skip listing of dependencies if no changed files or smart mode not available
        if (changedFilesSet.size === 0 || !await this.isSmartSelectAvailable()) {
            executeAllTests = true;
            return [[], executeAllTests];
        }
        const impactedTests = new Set<ID>();
        for (const test of tests) {
            if (changedFilesSet.has(test.filepath)) {
                impactedTests.add(test.testID);
                // no need to check dependencies if test file changed.
                continue;
            }
            if (testsDepsMap) {
                const testDeps = testsDepsMap.get(path.resolve(test.filepath)) ?? new Set();
                for (const changedFile of changedFilesSet) {
                    if (testDeps.has(changedFile)) {
                        impactedTests.add(test.testID);
                    }
                }
            }
        }

        return [Array.from(impactedTests), executeAllTests];
    }


    static validateLocatorConfig(inputConfig: InputConfig): void {
        if (inputConfig.mode != TestExecutionMode.Combined &&
            inputConfig.mode != TestExecutionMode.Individual) {
            throw Error("Invalid mode value in locator config file")
        }
        for (const locator of inputConfig.locators) {
            if (locator == undefined || locator.locator.length == 0) {
                throw Error("missing locator in config file")
            }
            if (locator.numberofexecutions == undefined) {
                throw Error("missing numberofexecutions in config file")
            }
            if (isNaN(locator.numberofexecutions)) {
                throw Error("Invalid numberofexecutions")
            }
        }
    }
  
    static getLocatorsConfigFromFile(filePath: string): InputConfig {
        const inputConfig = JSON.parse(fs.readFileSync(filePath).toString());
        this.validateLocatorConfig(inputConfig)
        return inputConfig
    }

    static createLocatorSet(config: InputConfig): LocatorSet[] {
        const locatorSet: LocatorSet[] = []
        const locatorMap: Map<number, string[]> = new Map<number, string[]>()
        switch (config.mode) {
            case TestExecutionMode.Individual:
                for (const locator of config.locators) {
                    locatorSet.push(new LocatorSet(locator.numberofexecutions, [locator.locator]))
                }
                break;
            case TestExecutionMode.Combined:
                for (const locator of config.locators) {
                    const record = locatorMap.get(locator.numberofexecutions) ?? [];
                    record.push(locator.locator)
                    locatorMap.set(locator.numberofexecutions, record)
                }
                for (const [n, locators] of locatorMap) {
                    locatorSet.push(new LocatorSet(n, locators))
                }
                break;
        }
        return locatorSet
    }

    static handleDuplicateTests(tests: Test[]): void {
        const testIdsCollisionMap: Map<string, number> = new Map<string, number>();
        tests.forEach(test => {
            const testID = test.testID;
            const existingCount = testIdsCollisionMap.get(testID) ?? 0;
            if (existingCount) {
                test.testID = crypto.createHash("md5").update(`${testID}-${existingCount}`).digest("hex");
            }

            testIdsCollisionMap.set(testID, existingCount + 1);
        });
    }
    static filterTestResultsByTestLocator(testResults: TestResult[],
        locators: Set<string>,
        blocktestLocators: Set<string>): TestResult[] {
        const filteredTestResults = [];
        for (const result of testResults) {
            if (locators.has(result.locator.toString()) || blocktestLocators.has(result.locator.toString())) {
                filteredTestResults.push(result)
            }
        }
        return filteredTestResults
    }

    static filterTestSuiteResults(testResults: TestResult[], testSuites: TestSuiteResult[]): TestSuiteResult[] {
        const suiteIDs = new Set<string>()
        const filteredTestSuites = [];
        for (const test of testResults) {
            if (test.suiteID) {
                this.addSuite(testSuites, suiteIDs, test.suiteID)
            }
        }
        for (const suite of testSuites) {
            if (suiteIDs.has(suite.suiteID)) {
                filteredTestSuites.push(suite)
            }
        }
        return filteredTestSuites
    }

    private static addSuite(suites: TestSuite[], suiteIDs: Set<string>, suiteID: string): void {
        for (const suite of suites) {
            if (suite.suiteID == suiteID && !suiteIDs.has(suiteID)) {
                suiteIDs.add(suiteID);
                if (suite.parentSuiteID) {
                    this.addSuite(suites, suiteIDs, suite.parentSuiteID)
                }
            }
        }
    }

    static fillTotalTests(discoveryResult: DiscoveryResult): void {
        const suiteIdTestCountMap = new Map<ID, number>();
        for (const test of discoveryResult.tests) {
            if (test.suiteID) {
                suiteIdTestCountMap.set(test.suiteID, (suiteIdTestCountMap.get(test.suiteID) ?? 0) + 1);
            }
        }

        // Adjacency list of suite -> immediate children
        const suiteRelations = new Map<ID, TestSuite[]>();
        for (const suite of discoveryResult.testSuites) {
            if (suite.parentSuiteID) {
                const existing = suiteRelations.get(suite.parentSuiteID) ?? [];
                existing.push(suite);
                suiteRelations.set(suite.parentSuiteID, existing);
            }
        }

        // Aggregate testCount of all childSuites
        const explored = new Set<ID>();
        function fun(suiteIdToExplore: ID) {
            if (explored.has(suiteIdToExplore)) {
                return;
            }
            let totalTests = suiteIdTestCountMap.get(suiteIdToExplore) ?? 0;
            for (const childSuite of (suiteRelations.get(suiteIdToExplore) ?? [])) {
                fun(childSuite.suiteID);
                totalTests += suiteIdTestCountMap.get(childSuite.suiteID) ?? 0;
            }
            suiteIdTestCountMap.set(suiteIdToExplore, totalTests);
            explored.add(suiteIdToExplore);
        }
        for (const suiteID of suiteRelations.keys()) {
            fun(suiteID);
        }

        for (const suite of discoveryResult.testSuites) {
            suite.totalTests = suiteIdTestCountMap.get(suite.suiteID) ?? 0;
        }
    }

    static async listDependencies(testFiles: string[]): Promise<TestsDependenciesMap | null> {
        const testsDeps = await this.execSmartMode({
            "function": "listDependencies",
            "testFiles": testFiles
        });
        let testsDepsMap: TestsDependenciesMap | null = null;
        if (testsDeps !== null) {
            testsDepsMap = new Map<string, Set<string>>();
            for (const [k, v] of Object.entries(testsDeps)) {
                testsDepsMap.set(k, new Set<string>(v as string[]));
            }
        }
        return testsDepsMap;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private static async execSmartMode(input: any): Promise<any> {
        const command = process.env.SMART_BINARY as string;
        if (!await this.isSmartSelectAvailable()) {
            return null;
        }
        try {
            fs.mkdirSync(path.dirname(SMART_INPUT_FILE), { recursive: true })
            await JSONStream.stringify(input, fs.createWriteStream(SMART_INPUT_FILE), JSONStream.replacer);
            await exec(command + ' --inputFile=' + SMART_INPUT_FILE);
            return await JSONStream.parse(fs.createReadStream(SMART_OUT_FILE));
            // eslint-disable-next-line no-empty
        } catch (err) {
            console.error('error while running smart selection mode', err)
        }
        return null;
    }

    static async isSmartSelectAvailable(): Promise<boolean> {
        const command = process.env.SMART_BINARY as string;
        if (!command) {
            this.smartSelectAvailable = false;
            return this.smartSelectAvailable;
        }
        if (this.smartSelectAvailable === undefined) {
            const { stdout } = await exec(command + ' --ping');
            if (stdout.indexOf("pong") === -1) {
                this.smartSelectAvailable = false;
                return this.smartSelectAvailable;
            }
            this.smartSelectAvailable = true;
        }
        return this.smartSelectAvailable;
    }
}
