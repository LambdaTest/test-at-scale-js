export const TAS_DIRECTORY = process.env.REPO_CACHE_DIR ?? (process.cwd() + "/__tas");
export const SMART_INPUT_FILE = TAS_DIRECTORY + "/input.json";
export const SMART_OUT_FILE = TAS_DIRECTORY + "/out.json";
export const LocatorSeparator = "##";
export const DEFAULT_API_TIMEOUT = 30000;
