import {
    DiscoveryResult,
    ExecutionResults,
} from "./model";
import parser from "yargs-parser";

declare global {
    // eslint-disable-next-line no-var
    var __coverage__: Record<string, unknown>;
}
export interface TestRunner {
    discoverTests(argv: parser.Arguments): Promise<DiscoveryResult>;
    executeTests(argv: parser.Arguments): Promise<ExecutionResults>;
}
