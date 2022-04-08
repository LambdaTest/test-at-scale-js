import crypto from "crypto";
import fs from "fs";
import path from "path";
import type { Config } from '@jest/types';
import { Test, TestResult } from "@jest/test-result";
import {
    DiscoveryResult,
    ID,
    JSONStream,
    Test as TASTest,
    TestsDependenciesMap as TASTestsDependenciesMap,
    TestSuite as TASTestSuite,
    Util
} from "@lambdatest/test-at-scale-core";
import { DISCOVERY_RESULT_FILE, TESTS_DEPENDENCIES_MAP_FILE } from "./constants";

class JestDiscoverReporter {

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    private _globalConfig: Config.GlobalConfig;
    private tests: TASTest[];
    private testSuites: Map<ID, TASTestSuite>;
    private testsDependenciesMap: TASTestsDependenciesMap | null;
    private hasErrors = false;

    constructor(globalConfig: Config.GlobalConfig) {
        this._globalConfig = globalConfig
        this.tests = [];
        this.testSuites = new Map<ID, TASTestSuite>();
        this.testsDependenciesMap = null;
    }

    async onTestResult(test: Test, testResult: TestResult): Promise<void> {
        const repoID = process.env.REPO_ID as ID;
        const commitID = process.env.COMMIT_ID as ID;
        const testDeps = await Util.listDependency(test.path, Util.REPO_ROOT, false, test.context.config);
        if (testDeps !== null) {
            if (this.testsDependenciesMap === null) {
                this.testsDependenciesMap = new Map<string, Set<string>>();
            }
            this.testsDependenciesMap.set(testDeps.testFile, new Set(testDeps.dependsOn));
        }

        testResult.testResults.forEach((jestTest) => {
            const filename = test.path;
            const testIdentifier = Util.getIdentifier(filename, jestTest.title);
            const ancestorTitles = jestTest.ancestorTitles;
            const suiteIdentifiers = ancestorTitles.map((suiteName) => Util.getIdentifier(filename, suiteName));
            const tasTest = new TASTest(
                crypto
                    .createHash("md5")
                    .update(repoID + "\n" + suiteIdentifiers.join("\n") + "\n" + testIdentifier)
                    .digest("hex"),
                testIdentifier,
                jestTest.title,
                suiteIdentifiers.length > 0
                    ? crypto
                        .createHash("md5")
                        .update(repoID + "\n" + suiteIdentifiers.join("\n"))
                        .digest("hex")
                    : null,
                commitID,
                path.relative(Util.REPO_ROOT, filename),
                Util.getLocator(filename, ancestorTitles, jestTest.title)
            );
            this.tests.push(tasTest);

            for (let i = 0; i < ancestorTitles.length; i++) {
                const suiteTitle = ancestorTitles[i];
                const thisSuiteIdentifiers = suiteIdentifiers.slice(0, i + 1);
                const parentSuiteIdentifiers = thisSuiteIdentifiers.slice(0, -1);
                const suiteIdentifier = Util.getIdentifier(filename, suiteTitle);
                const testSuite = new TASTestSuite(
                    crypto.createHash("md5").update(repoID + "\n" + thisSuiteIdentifiers.join("\n")).digest("hex"),
                    suiteIdentifier,
                    parentSuiteIdentifiers.length > 0
                        ? crypto
                            .createHash("md5")
                            .update(repoID + "\n" + parentSuiteIdentifiers.join("\n"))
                            .digest("hex")
                        : null
                )
                this.testSuites.set(testSuite.suiteID, testSuite);
            }
        });
        
        if (testResult && testResult.failureMessage) {
            this.hasErrors = true;
            process.stderr.write(testResult.failureMessage);
        }
    }

    async onRunComplete(): Promise<void> {
        const repoID = process.env.REPO_ID as ID;
        const buildID = process.env.BUILD_ID as ID;
        const taskID = process.env.TASK_ID as ID;
        const orgID = process.env.ORG_ID as ID;
        const branch = process.env.BRANCH_NAME as string;
        const commitID = process.env.COMMIT_ID  as string;
        const discoveryResult = new DiscoveryResult(
            this.tests,
            Array.from(this.testSuites.values()),
            [], // impacted tests empty for now
            repoID,
            commitID,
            buildID,
            taskID,
            orgID,
            branch,
        );
        // Ensure output path exists
        fs.mkdirSync(path.dirname(DISCOVERY_RESULT_FILE), { recursive: true });
        // Write data to file
        await JSONStream.stringify(discoveryResult, fs.createWriteStream(DISCOVERY_RESULT_FILE));

        fs.mkdirSync(path.dirname(TESTS_DEPENDENCIES_MAP_FILE), { recursive: true });
        await JSONStream.stringify(
            this.testsDependenciesMap,
            fs.createWriteStream(TESTS_DEPENDENCIES_MAP_FILE),
            JSONStream.replacer
        );

        const code = !this.hasErrors ? 0 : this._globalConfig.testFailureExitCode;
        process.on('exit', () => {
            if (typeof code === 'number' && code !== 0) {
                process.exitCode = code;
            }
        });
    }
}

export = JestDiscoverReporter;
