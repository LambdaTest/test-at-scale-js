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
    TestDependencies,
    TestResult,
    TestsDependenciesMap,
    TestSuiteResult,
    TestStatus,
    TestSuite,
    InputConfig,
    TestExecutionMode,
    LocatorSet
} from './model';
import {
    DEFAULT_API_TIMEOUT,
    LocatorSeparator,
    SMART_INPUT_FILE,
    SMART_OUT_FILE,
    TASLocatorSeparator
} from './constants';
const exec = util.promisify(child_process.exec);

export class Util {
    static REPO_ROOT = process.cwd();

    static smartSelectAvailable?: boolean;

    private static blocklistMap: { [key: string]: { source: string, locator: string }[]; } = {};
    private static blocklistMapInitialized = false;

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
     * Loads blocklisted tests by reading a file at path specified by env var BLOCKLISTED_TESTS_FILE.
     * This works on the assumption that the format of JSON stored in file is in the following format:
     * {
     *     "<filename>": {
     *         "source": "api",
     *         "locator": "<filename>##<test-suite-name>##<test-case-name>"
     *     },
     *     "<filename2>": {
     *         "source": "yml",
     *         "locator": "<filename2>##<test-suite-name-2>##<test-case-name-2>"
     *     }
     * }
     */
    private static loadBlocklistedTests() {
        const blockListedFilePath = process.env.BLOCKLISTED_TESTS_FILE as string;
        if (!this.blocklistMapInitialized) {
            if (!!blockListedFilePath && fs.existsSync(blockListedFilePath)) {
                const data = JSON.parse(fs.readFileSync(blockListedFilePath).toString());
                for (const k in data) {
                    const relativeFilePath = path.relative(this.REPO_ROOT, k);
                    this.blocklistMap[relativeFilePath] = [];
                    for (const blocklist of data[k]) {
                        if (blocklist.locator) {
                            const locator_parts = blocklist.locator.split(LocatorSeparator);
                            locator_parts[0] = relativeFilePath;
                            this.blocklistMap[relativeFilePath].push({
                                source: blocklist.source || 'yml',
                                locator: locator_parts.join(LocatorSeparator),
                            });
                        }
                    }
                }
            }
            this.blocklistMapInitialized = true;
        }
        return this.blocklistMap;
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

    static getTestStatus(status: string): TestStatus{
        switch (status){
            case TestStatus.Passed:
                return TestStatus.Passed
            case TestStatus.Failed:
                return TestStatus.Failed
            case TestStatus.BlockListed:
                return TestStatus.BlockListed
            default:
                return TestStatus.Skipped
        }
    }  

    // TODO: Fix blocklist.json generated in nucleus so that the following works recursively instead of string
    static getBlocklistedSource(locator: Locator): string | null {
        const locatorStr = locator.toString();
        const blocklistLocators = this.loadBlocklistedTests()[locatorStr.split(LocatorSeparator)[0]];
        if (!blocklistLocators) {
            return null;
        }
        const matches = blocklistLocators.filter((item) => locatorStr.startsWith(item.locator));
        if (matches.length === 0) {
            return null;
        }
        return matches[0]['source'];
    }

    static getBlocklistedLocatorsForFile(relFilePath: string): { source: string, locator: string }[] {
        const blocklistLocators = this.loadBlocklistedTests()[relFilePath];
        if (!blocklistLocators) {
            return [];
        }
        return blocklistLocators;
    }

    static isBlocklistedLocator(locator: Locator): boolean {
        // outermost locator is the relative filepath
        const relFilePath = locator.current;
        const blocklistedLocators = this.getBlocklistedLocatorsForFile(relFilePath);
        return !!blocklistedLocators.find((item) => { return Locator.from(item.locator)?.liesCompletelyIn(locator); });
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
            console.log(data);
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

    static findImpactedTests(
        testsDepsMap: TestsDependenciesMap | null,
        tests: Test[],
        changedFilesSet: Set<string>
    ): ID[] {
        const impactedTests = new Set<ID>();
        // skip if not diff exists or testFiles do not have testDeps
        if (changedFilesSet.size === 0 || testsDepsMap === null) {
            return [];
        }
        for (const test of tests) {
            if (changedFilesSet.has(test.filepath)) {
                impactedTests.add(test.testID);
                // no need to check dependencies if test file changed.
                continue;
            }
            const testDeps = testsDepsMap.get(path.resolve(test.filepath)) ?? new Set();
            for (const changedFile of changedFilesSet) {
                if (testDeps.has(changedFile)) {
                    impactedTests.add(test.testID);
                }
            }
        }

        return Array.from(impactedTests);
    }

    static getLocatorsFromFile(filePath: string): Array<string> {
        const locators = fs.readFileSync(filePath).toString().split(TASLocatorSeparator)
        return locators
    }


    static getLocatorsConfigFromFile(filePath: string): InputConfig {
        const config = JSON.parse(fs.readFileSync(filePath).toString());             
        return config
    }

    static createLocatorSet(config: InputConfig): LocatorSet[] {
        const locatorSet: LocatorSet[] = []
        const locatorMap: Map<number, string[]> = new  Map<number, string[]>() 
        switch(config.mode) {
        case TestExecutionMode.Individual:
            for (const locator of config.locators) {
                locatorSet.push(new LocatorSet(locator.n, [locator.locator]))
            }
            break;
        case TestExecutionMode.Combined:    
            for (const locator of config.locators) {
                let record = locatorMap.get(locator.n) ?? [];
                record.push(locator.locator)
                locatorMap.set(locator.n,record)    
            }
            for(const [n, locators] of locatorMap){
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
        blocklistLocators: Set<string>): TestResult[] {
        const filteredTestResults = [];
        for (const result of testResults) {
            if (locators.has(result.locator.toString()) || blocklistLocators.has(result.locator.toString())) {
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

    static async listDependency(
        testFile: string,
        rootDir: string,
        includeSelf = false,
        config?: unknown,
    ): Promise<TestDependencies | null> {
        return await this.execSmartMode({
            "function": "listDependency",
            "testFile": testFile,
            "rootDir": rootDir,
            "includeSelf": includeSelf,
            "config": config
        });
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
        if (!this.isSmartSelectAvailable()) {
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

    private static async isSmartSelectAvailable(): Promise<boolean> {
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
