import fs from "fs";
import path from "path";
import crypto from "crypto";
import {
    ExecutionResult,
    ID,
    TASDate as Date,
    Task,
    TestResult,
    TestStatus,
    TestSuiteResult,
    Util
} from "@lambdatest/test-at-scale-core";

export class CustomReporter implements jasmine.CustomReporter {
    private ancestorTitles: string[] = [];
    private specStartTime = new Date();
    private suiteStartTime = new Date();
    private _coverageMap: Map<string, typeof global.__coverage__> = new Map<string, typeof global.__coverage__>();

    private _runTask: Task<ExecutionResult>
    // Need to keep this as of 2 types because jasmine typings have inconsistencies
    // in type of `id` for jasmine.Spec (number) vs for jasmine.SpecResult (string).
    // So, for reporters string is typed whereas for topSuite it is of type number.
    private _entityIdFilenameMap: Map<number | string, string>

    private repoID = process.env.REPO_ID as ID;
    private commitID = process.env.COMMIT_ID as ID;
    private executionResults = new ExecutionResult();

    constructor(runTask: Task<ExecutionResult>, entityIdFilenameMap: Map<number | string, string>) {
        this._runTask = runTask;
        this._entityIdFilenameMap = entityIdFilenameMap;
    }

    suiteStarted(result: jasmine.SuiteResult): void {
        this.suiteStartTime = new Date();
        this.ancestorTitles.push(result.description);
    }

    suiteDone(result: jasmine.SuiteResult): void {
        // instead of "passed", suite returns "finished"
        if (result.status === "finished") {
            result.status = TestStatus.Passed;
        }
        // @types/jasmine has a bug where `id` in Reporters are string vs `id` in topSuite
        const filename = this._entityIdFilenameMap.get(result.id) ?? "";
        const suiteIdentifier = Util.getIdentifier(filename, result.description);
        const suiteIdentifiers = this.ancestorTitles
            .map((suiteName) => Util.getIdentifier(filename, suiteName));
        const parentSuiteIdentifiers = suiteIdentifiers.slice(0, -1);
        const duration: number = result.duration ?? ((new Date()).getTime() - this.suiteStartTime.getTime())
        const locator = Util.getLocator(filename, this.ancestorTitles, result.description);
        const blocklistSource = Util.getBlocklistedSource(locator);
        if (blocklistSource) {
            result.status = TestStatus.BlockListed;
        }
        const testSuite = new TestSuiteResult(
            crypto
                .createHash("md5")
                .update(this.repoID + "\n" + suiteIdentifiers.join("\n"))
                .digest("hex"),
            suiteIdentifier,
            parentSuiteIdentifiers.length > 0
                ? crypto
                    .createHash("md5")
                    .update(this.repoID + "\n" + parentSuiteIdentifiers.join("\n"))
                    .digest("hex")
                : null,
            duration,
            result.status as TestStatus,
            !!blocklistSource,
            blocklistSource,
            this.suiteStartTime
        )
        this.executionResults.testSuiteResults.push(testSuite);
        this.ancestorTitles.pop();

        if (filename && global.__coverage__) {
            this._coverageMap.set(filename, global.__coverage__);
        }
    }

    specStarted(): void {
        this.specStartTime = new Date();
    }

    specDone(result: jasmine.SpecResult): void {
        const filename = this._entityIdFilenameMap.get(result.id) ?? "";
        const suiteIdentifiers = this.ancestorTitles
            .map((suiteName) => Util.getIdentifier(filename, suiteName));
        const testIdentifier = Util.getIdentifier(filename, result.description);
        const locator = Util.getLocator(filename, this.ancestorTitles, result.description);
        const blocklistSource = Util.getBlocklistedSource(locator);
        // if blocklisted change status
        if (blocklistSource) {
            result.status = TestStatus.BlockListed;
        }
        // get test status
        result.status = Util.getTestStatus(result.status)
        let failureMessage: string | null = null;
        if (result.status === TestStatus.Failed) {
            failureMessage = result.failedExpectations.map((failedExpectation) => failedExpectation.message).join(', ')
        }
        const duration: number = result.duration ?? ((new Date()).getTime() - this.specStartTime.getTime())
        const test = new TestResult(
            crypto
                .createHash("md5")
                .update(this.repoID + "\n" + suiteIdentifiers.join("\n") + "\n" + testIdentifier)
                .digest("hex"),
            testIdentifier,
            result.description,
            suiteIdentifiers.length > 0
                ? crypto
                    .createHash("md5")
                    .update(this.repoID + "\n" + suiteIdentifiers.join("\n"))
                    .digest("hex")
                : null,
            this.commitID,
            locator,
            duration,
            result.status as TestStatus,
            !!blocklistSource,
            blocklistSource,
            this.specStartTime,
            failureMessage
        );
        this.executionResults.testResults.push(test);
    }

    jasmineDone(doneInfo: jasmine.JasmineDoneInfo): void {
        const CODE_COVERAGE_DIR = process.env.CODE_COVERAGE_DIR as string;
        console.log(doneInfo);
        if (CODE_COVERAGE_DIR) {
            for (const [filename, coverage] of this._coverageMap) {
                const coverageFileName = `${CODE_COVERAGE_DIR}/${filename.replace(/\//g, '')}/coverage-final.json`;
                // Ensure output path exists
                fs.mkdirSync(path.dirname(coverageFileName), { recursive: true });
                // Write data to file
                fs.writeFileSync(coverageFileName, JSON.stringify(coverage));
            }
        }
        this._runTask.resolve(this.executionResults);
    }
}
