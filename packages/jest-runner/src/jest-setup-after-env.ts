import fs from "fs";
import path from "path";
import { TIMINGS_FILE } from "./constants";
import { TASDate as Date } from "@lambdatest/test-at-scale-core";

const timings: string[] = [];

beforeEach(() => {
  timings.push(new Date().toISOString());
});

afterAll(() => {
  // Ensure output path exists
  fs.mkdirSync(path.dirname(TIMINGS_FILE), { recursive: true });
  // Write data to file
  fs.writeFileSync(TIMINGS_FILE, JSON.stringify(timings));
});
