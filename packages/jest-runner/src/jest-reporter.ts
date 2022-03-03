import crypto from "crypto";
import fs from "fs";
import path from "path";
import type { Config } from '@jest/types';
import { AssertionResult, Test, TestResult } from "@jest/test-result";
import {
    ExecutionResult,
    ID,
    TASDate as Date,
    TestResult as TASTestResult,
    TestStatus as TASTestStatus,
    TestSuiteResult as TASTestSuiteResult,
    Util
} from "@lambdatest/test-at-scale-core";
import { REPORT_FILE, TIMINGS_FILE } from "./constants";

class JestReporter {

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    private _globalConfig: Config.GlobalConfig;
    private filename: string;
    private testResults: TASTestResult[];
    private testSuiteResults = new Map<ID, TASTestSuiteResult>();
    private timings: Date[];
    private tIndex: number;

    constructor(globalConfig: Config.GlobalConfig) {
        this._globalConfig = globalConfig
        this.testResults = [];
        this.filename = "";
        this.timings = [];
        this.tIndex = 0;
    }
    
    onTestStart(test: Test): void {
        this.filename = test.path;
        this.tIndex = 0;
    }

    onTestResult(test: Test, testResult: TestResult): void {
        const CODE_COVERAGE_DIR = process.env.CODE_COVERAGE_DIR as string;
        try {
            this.timings = (JSON.parse(fs.readFileSync(TIMINGS_FILE, {encoding: "utf-8"})) as string[])
                .map((dateStr) => new Date(dateStr));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (err: any) {
            this.timings = [];
        }

        const filename = test.path;
        // append blocklisted testResults
        testResult.testResults.forEach((jestTestResult) => {
            const locator = Util.getLocator(filename, jestTestResult.ancestorTitles, jestTestResult.title);
            if (Util.isBlocklistedLocator(locator)) {
                this.testResults.push(this.toTASTestResult(jestTestResult, TASTestStatus.BlockListed));
            } else {
                this.testResults.push(this.toTASTestResult(jestTestResult, Util.getTestStatus(jestTestResult.status)));
            }
        });

        if (CODE_COVERAGE_DIR && testResult.coverage) {
            const coverageFileName = CODE_COVERAGE_DIR + "/" + filename.replace(/\//g, '') + "/coverage-final.json"
            // Ensure output path exists
            fs.mkdirSync(path.dirname(coverageFileName), { recursive: true });
            // Write data to file
            fs.writeFileSync(coverageFileName, JSON.stringify(testResult.coverage));
        }

        this.filename = "";
    }

    onRunComplete(): void {
        const repoID = process.env.REPO_ID as ID;
        const orgID = process.env.ORG_ID as ID;
        const buildID = process.env.BUILD_ID as ID;
        const taskID = process.env.TASK_ID as ID;
        const commitID = process.env.COMMIT_ID as ID;
        const executionResult = new ExecutionResult(
            taskID,
            buildID,
            repoID,
            commitID,
            orgID,
            this.testResults,
            Array.from(this.testSuiteResults.values())
        );
        // Ensure output path exists
        fs.mkdirSync(path.dirname(REPORT_FILE), { recursive: true });
        // Write data to file
        fs.writeFileSync(REPORT_FILE, JSON.stringify(executionResult));
    }

    private toTASTestResult(testCaseResult: AssertionResult, status: TASTestStatus): TASTestResult {
        let specStartTime: Date | null = null;
        if ((status === TASTestStatus.Passed || status === TASTestStatus.Failed) && this.tIndex < this.timings.length) {
            // test-case ran (not skipped or blocklisted). Hence, will have an ordered entry in timings file
            specStartTime = this.timings[this.tIndex++];
        }
        const duration: number = testCaseResult.duration ?? 0;

        const ancestorTitles: string[] = testCaseResult.ancestorTitles;
        const repoID = process.env.REPO_ID as ID;
        const commitID = process.env.COMMIT_ID as ID;
        const filename = this.filename;
        const testIdentifier = Util.getIdentifier(filename, testCaseResult.title);
        const locator = Util.getLocator(filename, ancestorTitles, testCaseResult.title);
        const suiteIdentifiers = ancestorTitles.map((suiteName) => Util.getIdentifier(filename, suiteName));
        const blocklistSource = Util.getBlocklistedSource(locator);

        const testResult = new TASTestResult(
            crypto
                .createHash("md5")
                .update(repoID + "\n" + suiteIdentifiers.join("\n") + "\n" + testIdentifier)
                .digest("hex"),
            testIdentifier,
            testCaseResult.title,
            suiteIdentifiers.length > 0
                ? crypto
                    .createHash("md5")
                    .update(repoID + "\n" + suiteIdentifiers.join("\n"))
                    .digest("hex")
                : null,
            commitID,
            locator,
            duration,
            status,
            !!blocklistSource,
            blocklistSource,
            specStartTime
        );

        for (let i = 0; i < ancestorTitles.length; i++) {
            const suiteTitle = ancestorTitles[i];
            const thisSuiteIdentifiers = suiteIdentifiers.slice(0, i + 1);
            const parentSuiteIdentifiers = thisSuiteIdentifiers.slice(0, -1);
            const suiteIdentifier = Util.getIdentifier(filename, suiteTitle);
            const suiteLocator = Util.getLocator(filename, ancestorTitles.slice(0, i), suiteTitle);
            const suiteBlocklistSource = Util.getBlocklistedSource(suiteLocator);
            const suiteID = crypto
                .createHash("md5")
                .update(repoID + "\n" + thisSuiteIdentifiers.join("\n"))
                .digest("hex");
            const suiteParams = this.getSuiteParams(suiteID, duration, status, specStartTime);
            if (suiteBlocklistSource) {
                suiteParams.status = TASTestStatus.BlockListed;
            }
            const testSuite = new TASTestSuiteResult(
                suiteID,
                suiteIdentifier,
                parentSuiteIdentifiers.length > 0
                    ? crypto
                        .createHash("md5")
                        .update(repoID + "\n" + parentSuiteIdentifiers.join("\n"))
                        .digest("hex")
                    : null,
                suiteParams.duration,
                suiteParams.status,
                !!suiteBlocklistSource,
                suiteBlocklistSource,
                suiteParams.startTime
            )
            this.testSuiteResults.set(testSuite.suiteID, testSuite);
        }

        return testResult;
    }

    private getSuiteParams(suiteID: ID, testDuration: number, testStatus: TASTestStatus, testStartTime: Date | null) {
        const existing = this.testSuiteResults.get(suiteID);
        if (!existing) {
            return {
                duration: testDuration,
                status: this.winnerSuiteStatus(TASTestStatus.Passed, testStatus),
                startTime: testStartTime
            };
        }
        let suiteStartTime: Date | null = null;
        if (existing.start_time && testStartTime) {
            suiteStartTime = new Date(existing.start_time) < testStartTime
                ? new Date(existing.start_time)
                : testStartTime;
        } else if (existing.start_time) {
            suiteStartTime = new Date(existing.start_time);
        } else if (testStartTime) {
            suiteStartTime = new Date(testStartTime);
        }
        
        return {
            duration: existing.duration + testDuration,
            status: this.winnerSuiteStatus(existing.status, testStatus),
            startTime: suiteStartTime
        };
    }

    private winnerSuiteStatus(suiteStatus: TASTestStatus, testStatus: TASTestStatus): TASTestStatus {
        if (suiteStatus === TASTestStatus.BlockListed) {
            return TASTestStatus.BlockListed;
        }
        if (suiteStatus === TASTestStatus.Failed || testStatus === TASTestStatus.Failed) {
            return TASTestStatus.Failed;
        }
        if (suiteStatus === TASTestStatus.Skipped && testStatus === TASTestStatus.Skipped) {
            return TASTestStatus.Skipped;
        }
        return TASTestStatus.Passed;
    }
}

export = JestReporter;
