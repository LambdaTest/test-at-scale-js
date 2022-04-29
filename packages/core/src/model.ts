/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { TASDate as Date } from './time';
import { LocatorSeparator } from "./constants";

export type ID = string;
export type RelativeFilePath = string;

export class Locator {
    current: string;
    child: Locator | null;

    constructor(current: string, child: Locator | null) {
        this.current = current;
        this.child = child;
    }

    static from(locatorStr: string): Locator | null {
        const parts = locatorStr.split(LocatorSeparator);
        if (parts.length === 0) {
            return null;
        }
        const rootLocator: Locator = new Locator(parts[0], null);
        let current = rootLocator;
        for (let i = 1; i < parts.length; i++) {
            if (parts[i]) {
                current.child = new Locator(parts[i], null);
                current = current.child;
            }
        }
        return rootLocator;
    }

    toString(): string {
        let str = this.current + LocatorSeparator;
        if (this.child instanceof Locator) {
            str = str + this.child.toString()
        }
        return str
    }

    toJSON(): string {
        return this.toString();
    }

    liesCompletelyIn(that: Locator): boolean {
        return that.toString().startsWith(this.toString());
    }
}

export class Test {
    testID: ID;
    _detail: string;
    title: string;
    filepath: string;
    suiteID: ID | null;
    locator: Locator;

    constructor(
        testID: ID,
        _detail: string,
        title: string,
        suiteID: ID | null,
        filepath: string,
        locator: Locator
    ) {
        this.testID = testID;
        this._detail = _detail;
        this.title = title;
        this.suiteID = suiteID;
        this.filepath = filepath;
        this.locator = locator;
    }

    static fromJSON(jsonTest: any): Test {
        return new Test(
            jsonTest.testID,
            jsonTest._detail,
            jsonTest.title,
            jsonTest.suiteID,
            jsonTest.filepath,
            Locator.from(jsonTest.locator) as Locator
        );
    }
}

export class TestSuite {
    suiteID: ID;
    suiteName: string;
    parentSuiteID: ID | null;
    totalTests?: number;

    constructor(suiteID: ID, suiteName: string, parentSuiteID: ID | null) {
        this.suiteID = suiteID;
        this.suiteName = suiteName;
        this.parentSuiteID = parentSuiteID;
    }

    static fromJSON(jsonTest: any): TestSuite {
        return new TestSuite(
            jsonTest.suiteID,
            jsonTest.suiteName,
            jsonTest.parentSuiteID
        );
    }
}

export class DiscoveryResult {
    tests: Test[];
    testSuites: TestSuite[];
    impactedTests: ID[];
    repoID: ID;
    commitID: ID;
    buildID: ID;
    taskID: ID;
    orgID: ID;
    branch: string;
    executeAllTests: boolean;
    constructor(tests: Test[],
        testSuites: TestSuite[],
        impactedTests: ID[],
        repoID: ID,
        commitID: ID,
        buildID: ID,
        taskID: ID,
        orgID: ID,
        branch: string,
        executeAllTests?: boolean) {
        this.tests = tests;
        this.testSuites = testSuites;
        this.repoID = repoID;
        this.commitID = commitID;
        this.buildID = buildID;
        this.taskID = taskID;
        this.orgID = orgID;
        this.branch = branch
        this.impactedTests = impactedTests
        this.executeAllTests = executeAllTests ? executeAllTests : false;
    }
}

export class Task<T = void> {
    protected _promise: Promise<T>;
    private resolveFn!: (value: PromiseLike<T> | T) => void;
    private rejectFn!: (reason: any) => void;
    private _isCompleted = false;

    constructor() {
        this._promise = new Promise<T>((resolve, reject) => {
            this.resolveFn = resolve;
            this.rejectFn = reject;
        });
    }

    public get promise(): Promise<T> {
        return this._promise;
    }

    public get isCompleted(): boolean {
        return this._isCompleted;
    }

    public resolve = (result: PromiseLike<T> | T): void => {
        this._isCompleted = true;
        this.resolveFn(result);
    };

    public reject: (reason: any) => void = (reason: any): void => {
        this._isCompleted = true;
        this.rejectFn(reason);
    };
}

export class TestResult extends Test {
    duration: number;
    status: TestStatus;
    blocked: boolean;
    blockTestSource: string | null;
    start_time: string | null;
    end_time: string | null;
    failureMessage: string | null;

    constructor(
        id: ID,
        _detail: string,
        title: string,
        suiteID: ID | null,
        locator: Locator,
        duration: number,
        status: TestStatus,
        blocked: boolean,
        blockTestSource: string | null,
        startTime: Date | null,
        failureMessage: string | null,
    ) {
        super(id, _detail, title, suiteID, "", locator);
        this.duration = duration;
        this.status = status;
        this.blocked = blocked;
        this.blockTestSource = blockTestSource;
        if (this.status !== TestStatus.Failed && this.status !== TestStatus.Passed) {
            // skip metrics allocation by setting startTime to null
            startTime = null;
        }
        this.failureMessage = failureMessage;
        this.start_time = startTime ? startTime.toISOString() : null;
        this.end_time = startTime ? (new Date(startTime.getTime() + duration)).toISOString() : null;
    }

    static fromJSON(jsonResult: any): TestResult {
        return new TestResult(
            jsonResult.testID,
            jsonResult._detail,
            jsonResult.title,
            jsonResult.suiteID,
            Locator.from(jsonResult.locator) as Locator,
            jsonResult.duration,
            jsonResult.status,
            jsonResult.blocked,
            jsonResult.blockTestSource,
            jsonResult.start_time ? new Date(jsonResult.start_time) : null,
            jsonResult.failureMessage,
        );
    }
}

export enum TestStatus {
    Passed = 'passed',
    Failed = 'failed',
    Skipped = 'skipped',
    BlockListed = 'blocklisted',
    Quarantined = 'quarantined'
}


export class TestSuiteResult extends TestSuite {
    duration: number;
    status: TestStatus;
    blocked: boolean;
    blockTestSource: string | null;
    start_time: string | null;
    end_time: string | null;

    constructor(
        id: ID,
        suiteName: string,
        parentSuiteID: ID | null,
        duration: number,
        status: TestStatus,
        blocked: boolean,
        blockTestSource: string | null,
        startTime: Date | null
    ) {
        super(id, suiteName, parentSuiteID);
        this.duration = duration;
        this.status = status;
        this.blocked = blocked;
        this.blockTestSource = blockTestSource;
        this.start_time = startTime ? startTime.toISOString() : null;
        this.end_time = startTime ? (new Date(startTime.getTime() + duration)).toISOString() : null;
    }

    static fromJSON(jsonResult: any): TestSuiteResult {
        return new TestSuiteResult(
            jsonResult.suiteID,
            jsonResult.suiteName,
            jsonResult.parentSuiteID,
            jsonResult.duration,
            jsonResult.status,
            jsonResult.blocked,
            jsonResult.blockTestSource,
            jsonResult.start_time ? new Date(jsonResult.start_time) : null
        );
    }
}

export class ExecutionResult {
    testResults: TestResult[];
    testSuiteResults: TestSuiteResult[];

    constructor(
        testResults: TestResult[] = [],
        testSuiteResults: TestSuiteResult[] = []
    ) {
        this.testResults = testResults;
        this.testSuiteResults = testSuiteResults;
    }

    static fromJSON(jsonResult: any): ExecutionResult {
        const testResults = (jsonResult.testResults ?? []).map(TestResult.fromJSON);
        const testSuiteResults = (jsonResult.testSuiteResults ?? []).map(TestSuiteResult.fromJSON);
        return new ExecutionResult(
            testResults,
            testSuiteResults
        );
    }
}

export class CoverageResult { }

export enum ChildProcMessageType {
    Error = 'error',
    Result = 'result',
    Started = 'started'
}
export class ChildProcMessage {
    type: ChildProcMessageType;
    msg?: any;
    constructor(type: ChildProcMessageType, msg?: any) {
        this.type = type;
        this.msg = msg;
    }
}

export type TestsDependenciesMap = Map<string, Set<string>>;
export class TestDependencies {
    testFile: string;
    dependsOn: string[];
    constructor(testFile: string, dependsOn: string[]) {
        this.testFile = testFile;
        this.dependsOn = dependsOn;
    }
}

export class RunnerException extends Error {
    constructor(msg: string | undefined) {
        if (msg) {
            super(msg);
        }
    }
}

export class ExecutionResults {
    taskID: ID;
    buildID: ID;
    repoID: ID;
    commitID: ID;
    orgID: ID;
    results: ExecutionResult[];
    constructor(taskID: ID,
        buildID: ID,
        repoID: ID,
        commitID: ID,
        orgID: ID,
        results: ExecutionResult[] = [],
        ) {
        this.taskID = taskID;
        this.buildID = buildID;
        this.repoID = repoID;
        this.orgID = orgID;
        this.commitID = commitID;
        this.results = results;
    }
    push(executionResult: ExecutionResult) {
        this.results.push(executionResult)
    }
    pop() {
        this.results.pop()
    }
}


export type LocatorProperties = {
    source: string | null
    status: string
    isBlocked: boolean
}
