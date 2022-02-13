import Mocha from "mocha";
import crypto from "crypto";
import { ID, TestResult, TASDate as Date, TestStatus, TestSuiteResult, Util } from "@lambdatest/test-at-scale-core";

export class MochaHelper {

    // This gives parentSuite in reverse order i.e. innermost parent will be at 0th index
    static getParentSuites(entity: Mocha.Test | Mocha.Suite, parentSuites: string[]): void {
        const parentSuite = entity.parent;
        if (parentSuite instanceof Mocha.Suite && !parentSuite.root) {
            parentSuites.push(parentSuite.title);
            MochaHelper.getParentSuites(parentSuite, parentSuites);
        }
    }

    static transformMochaTestAsTestResult(
        test: Mocha.Test,
        specStartTime: Date,
        state: TestStatus
    ): TestResult {
        const repoID = process.env.REPO_ID as ID;
        const commitID = process.env.COMMIT_ID as ID;
        const filename = test.file || "";

        const parentSuites: string[] = [];
        MochaHelper.getParentSuites(test, parentSuites);
        parentSuites.reverse()
        const suiteIdentifiers = parentSuites.map((suiteName) => Util.getIdentifier(filename, suiteName));

        const testIdentifier = Util.getIdentifier(filename, test.title);
        const locator = Util.getLocator(filename, parentSuites, test.title);
        const blocklistSource = Util.getBlocklistedSource(locator);
        const duration: number = test.duration ?? (new Date()).getTime() - specStartTime.getTime();
        return new TestResult(
            crypto
                .createHash("md5")
                .update(repoID + "\n" + suiteIdentifiers.join("\n") + "\n" + testIdentifier)
                .digest("hex"),
            testIdentifier,
            test.title,
            suiteIdentifiers.length > 0
                ? crypto
                    .createHash("md5")
                    .update(repoID + "\n" + suiteIdentifiers.join("\n"))
                    .digest("hex")
                : null,
            commitID,
            locator,
            duration,
            state,
            !!blocklistSource,
            blocklistSource,
            specStartTime
        );
    }

    static transformMochaSuiteAsSuiteResult(
        suite: Mocha.Suite,
        suiteStartTime: Date,
        state: TestStatus
    ): TestSuiteResult {
        const repoID = process.env.REPO_ID as ID;
        const filename = suite.file || "";

        const parentSuites: string[] = [];
        MochaHelper.getParentSuites(suite, parentSuites);
        parentSuites.reverse()
        const parentSuiteIdentifiers = parentSuites.map((suiteName) => Util.getIdentifier(filename, suiteName));
        const suiteIdentifier = Util.getIdentifier(filename, suite.title);
        const suiteIdentifiers = parentSuiteIdentifiers.concat(suiteIdentifier);
        const locator = Util.getLocator(filename, parentSuites, suite.title);
        const blocklistSource = Util.getBlocklistedSource(locator);
        const duration: number = (new Date()).getTime() - suiteStartTime.getTime();
        return new TestSuiteResult(
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
                : null,
            duration,
            state,
            !!blocklistSource,
            blocklistSource,
            suiteStartTime
        );
    }
}

export class CustomRunner extends Mocha.Runner {
    testResults?: TestResult[] = [];
    testSuiteResults?: TestSuiteResult[] = [];
}
