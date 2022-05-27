import Mocha from "mocha";
import fs from "fs";
import crypto from "crypto";
import parser from "yargs-parser";
import { ID, TestResult, TASDate as Date, TestStatus, TestSuiteResult, Util } from "@lambdatest/test-at-scale-core";

const shortHandOptsMap = new Map<string, string>(
    [
        ["-A", "--async-only"],
        ["-c", "--colors"],
        ["-C", "--no-colors"],
        ["-G", "--growl"],
        ["-O", "--reporter-options"],
        ["-R", "--reporter"],
        ["-S", "--sort"],
        ["-b", "--bail"],
        ["-d", "--debug"],
        ["-g", "--grep"],
        ["-f", "--fgrep"],
        ["-gc", "--expose-gc"],
        ["-i", "--invert"],
        ["-r", "--require"],
        ["-s", "--slow"],
        ["-t", "--timeout"],
        ["-u", "--ui"],
        ["-w", "--watch"]
    ]
);

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
        state: TestStatus,
        failureMessage?: string,
    ): TestResult {
        const repoID = process.env.REPO_ID as ID;
        const filename = test.file || "";

        const parentSuites: string[] = [];
        MochaHelper.getParentSuites(test, parentSuites);
        parentSuites.reverse()
        const suiteIdentifiers = parentSuites.map((suiteName) => Util.getIdentifier(filename, suiteName));

        const testIdentifier = Util.getIdentifier(filename, test.title);
        const locator = Util.getLocator(filename, parentSuites, test.title);
        const blockTest = Util.getBlockTestLocatorProperties(locator);
        let duration = 0;
        if (state === TestStatus.Passed || state === TestStatus.Failed) {
            duration = test.duration ?? ((new Date()).getTime() - specStartTime.getTime());
        }
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
            locator,
            duration,
            state,
            blockTest.isBlocked,
            blockTest.source,
            specStartTime,
            failureMessage ? failureMessage: null,
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
        const blocktest = Util.getBlockTestLocatorProperties(locator);
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
            blocktest.isBlocked,
            blocktest.source,
            suiteStartTime
        );
    }

    static getFilteredConfigs(argv: parser.Arguments): Mocha.MochaOptions {
        const args = [];
        if (argv.config !== undefined) {
            args.push("--config", argv.config);
        }
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const loadOptions = require('mocha/lib/cli/options').loadOptions;
            const opts = loadOptions(args) as Mocha.MochaOptions;
            opts.parallel = false;
            return opts;
        } catch (err) {
            // implies user is using mocha version < 6
            console.warn("Using mocha < 6");
            const optsFilePath = argv.config ?? "./test/mocha.opts";
            if (fs.existsSync(optsFilePath)) {
                // Following code translates mocha opts file to longhand opts array
                const opts = fs
                    .readFileSync(optsFilePath, 'utf8')
                    .replace(/^#.*$/gm, '')
                    .replace(/\\\s/g, '%20')
                    .split(/\s/)
                    .filter(Boolean)
                    .map(value => value.replace(/%20/g, ' '))
                    .map(value => shortHandOptsMap.get(value) ?? value);
                return parser(opts) as Mocha.MochaOptions;
            }
            return {};
        }
    }
}

export class CustomRunner extends Mocha.Runner {
    testResults?: TestResult[] = [];
    testSuiteResults?: TestSuiteResult[] = [];
}
