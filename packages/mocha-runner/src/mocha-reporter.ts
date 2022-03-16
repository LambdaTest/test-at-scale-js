import fs from "fs";
import path from "path";
import Mocha from "mocha";
import { TestResult, TestStatus, TestSuiteResult, TASDate as Date } from "@lambdatest/test-at-scale-core";
import { CustomRunner, MochaHelper } from "./helper";

const {
    EVENT_SUITE_BEGIN,
    EVENT_SUITE_END,
    EVENT_TEST_BEGIN,
    EVENT_TEST_PASS,
    EVENT_TEST_PENDING,
    EVENT_TEST_FAIL,
    EVENT_RUN_END
} = Mocha.Runner.constants ?? {
    EVENT_HOOK_BEGIN: 'hook',
    EVENT_HOOK_END: 'hook end',
    EVENT_RUN_BEGIN: 'start',
    EVENT_DELAY_BEGIN: 'waiting',
    EVENT_DELAY_END: 'ready',
    EVENT_RUN_END: 'end',
    EVENT_SUITE_BEGIN: 'suite',
    EVENT_SUITE_END: 'suite end',
    EVENT_TEST_BEGIN: 'test',
    EVENT_TEST_END: 'test end',
    EVENT_TEST_FAIL: 'fail',
    EVENT_TEST_PASS: 'pass',
    EVENT_TEST_PENDING: 'pending',
    EVENT_TEST_RETRY: 'retry',
    STATE_IDLE: 'idle',
    STATE_RUNNING: 'running',
    STATE_STOPPED: 'stopped'
};

export class MochaReporter extends Mocha.reporters.Base {
    private static RUNNER_ERROR = "Mocha Runner Error";

    private _testResults: TestResult[] = [];
    private _suiteResults: TestSuiteResult[] = [];
    private _specStartTime = new Date();
    private _suiteStartTime = new Date();
    private _coverageMap: Map<string, typeof global.__coverage__> = new Map<string, typeof global.__coverage__>();

    constructor(runner: CustomRunner, options: Mocha.MochaOptions) {

        super(runner, options);
        this.hookUsersReporter(runner, options);

        runner.on(EVENT_SUITE_BEGIN, () => {
            try {
                this._suiteStartTime = new Date();
            } catch (err) {
                console.error(MochaReporter.RUNNER_ERROR, err);
            }
        });

        runner.on(EVENT_SUITE_END, (suite: Mocha.Suite) => {
            try {
                if (!suite.root) {
                    const underlyingTestStates: string[] = [];
                    suite.eachTest((test) => {
                        underlyingTestStates.push(test.state as string);
                    });
                    let suiteState = TestStatus.Passed;
                    if (underlyingTestStates.find((item) => item === TestStatus.Failed)) {
                        suiteState = TestStatus.Failed;
                    }
                    this._suiteResults.push(
                        MochaHelper.transformMochaSuiteAsSuiteResult(suite, this._suiteStartTime, suiteState));
                }
                if (suite.file && global.__coverage__) {
                    this._coverageMap.set(suite.file, global.__coverage__);
                }
            } catch (err) {
                console.error(MochaReporter.RUNNER_ERROR, err);
            }
        });

        runner.on(EVENT_TEST_BEGIN, () => {
            try {
                this._specStartTime = new Date();
            } catch (err) {
                console.error(MochaReporter.RUNNER_ERROR, err);
            }
        });

        runner.on(EVENT_TEST_PASS, (test: Mocha.Test) => {
            try {
                this._testResults.push(
                    MochaHelper.transformMochaTestAsTestResult(test, this._specStartTime, TestStatus.Passed));
            } catch (err) {
                console.error(MochaReporter.RUNNER_ERROR, err);
            }
        });

        /**
         * Event emitted when a test doesn't define a body or it is marked as skipped ie it.skip()
         */
        runner.on(EVENT_TEST_PENDING, (test: Mocha.Test) => {
            try {
                this._testResults.push(
                    MochaHelper.transformMochaTestAsTestResult(test, this._specStartTime, TestStatus.Skipped));
            } catch (err) {
                console.error(MochaReporter.RUNNER_ERROR, err);
            }
        });

        runner.on(EVENT_TEST_FAIL, (test: Mocha.Test, err: Error) => {
            try {
                const failureMessage = (err.message || err.stack) ?? 'unknown error';
                this._testResults.push(
                    MochaHelper.transformMochaTestAsTestResult(test, this._specStartTime, 
                        TestStatus.Failed, failureMessage));
            } catch (err) {
                console.error(MochaReporter.RUNNER_ERROR, err);
            }
        });

        runner.once(EVENT_RUN_END, () => {
            const CODE_COVERAGE_DIR = process.env.CODE_COVERAGE_DIR as string;
            runner.testResults = this._testResults;
            runner.testSuiteResults = this._suiteResults;
            if (CODE_COVERAGE_DIR) {
                for (const [filename, coverage] of this._coverageMap) {
                    const coverageFileName = `${CODE_COVERAGE_DIR}/${filename.replace(/\//g, '')}/coverage-final.json`;
                    // Ensure output path exists
                    fs.mkdirSync(path.dirname(coverageFileName), { recursive: true });
                    // Write data to file
                    fs.writeFileSync(coverageFileName, JSON.stringify(coverage));
                }
            }
        });
    }

    private hookUsersReporter(runner: Mocha.Runner, options: Mocha.MochaOptions) {
        let reporter: string | Mocha.ReporterConstructor | undefined;
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const reporters = require("mocha/lib/reporters");

        if (typeof options.reporter === 'function') {
            reporter = options.reporter;
        } else {
            options.reporter = options.reporter || 'spec';

            if (reporters[options.reporter]) {
                reporter = reporters[options.reporter];
            }
            // Try to load reporters from process.cwd() and node_modules
            if (!reporter) {
                let foundReporter: string | undefined;
                try {
                    foundReporter = require.resolve(options.reporter);
                    reporter = require(foundReporter);
                } catch (err) {
                    if (foundReporter) {
                        throw err;
                    }
                    // Try to load reporters from a cwd-relative path
                    reporter = require(path.resolve(options.reporter));
                }
            }

            if (typeof reporter === 'function') {
                new reporter(runner, options);
            }
        }
    }
}

module.exports = MochaReporter;
