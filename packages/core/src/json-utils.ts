/* eslint-disable @typescript-eslint/no-explicit-any */
import {stringifyStream, parseChunked} from "@discoveryjs/json-ext";
import { Readable } from "stream";

export class JSONStream {
    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    static async stringify(value: any, dest: any, replacer?: any, space?: string | number): Promise<string> {
        return new Promise((resolve, reject) => {
            stringifyStream(value, replacer, space)
                .on('error', reject)
                .pipe(dest)
                .on('error', reject)
                .on('finish', resolve);
        });
    }

    static async parse(input: Readable): Promise<any> {
        return parseChunked(input);
    }

    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    static replacer = (_: string, value: any): any => {
        if (value instanceof Map) {
            return Object.fromEntries(value);
        }
        if (value instanceof Set) {
            return Array.from(value);
        }
        return value;
    };
}
