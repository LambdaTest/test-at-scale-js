import { TAS_DIRECTORY } from "@lambdatest/test-at-scale-core";

export const REPORT_FILE = TAS_DIRECTORY + "/report.json";
export const DISCOVERY_RESULT_FILE = TAS_DIRECTORY + "/discovery.json";
export const TESTS_DEPENDENCIES_MAP_FILE = TAS_DIRECTORY + "/test_deps_map.json";
export const TIMINGS_FILE = TAS_DIRECTORY + "/timings.json";
export const MATCH_NOTHING_REGEX = "a^";
export const SETUP_AFTER_ENV_FILE = __dirname + "/jest-setup-after-env";
