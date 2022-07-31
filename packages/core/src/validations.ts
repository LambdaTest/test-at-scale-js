import parser from "yargs-parser";

export class Validations {
    static validateDiscoveryEnv(argv: parser.Arguments): void {
        if (argv.pattern === undefined) {
            throw new ValidationException("Missing '--pattern' argument.")
        }
        if (process.env.REPO_ID === undefined) {
            throw new ValidationException("'REPO_ID' is not set in environment variables.")
        }
        if (process.env.ORG_ID === undefined) {
            throw new ValidationException("'ORG_ID' is not set in environment variables.")
        }
        if (process.env.COMMIT_ID === undefined) {
            throw new ValidationException("'COMMIT_ID' is not set in environment variables.")
        }
        if (process.env.BUILD_ID === undefined) {
            throw new ValidationException("'BUILD_ID' is not set in environment variables.")
        }
        if (process.env.BRANCH_NAME === undefined) {
            throw new ValidationException("'BRANCH_NAME' is not set in environment variables.")
        }
    }

    static validateExecutionEnv(argv: parser.Arguments): void {
        if (argv.pattern === undefined) {
            throw new ValidationException("Missing '--pattern' argument.")
        }
        if (process.env.REPO_ID === undefined) {
            throw new ValidationException("'REPO_ID' is not set in environment variables.")
        }
        if (process.env.COMMIT_ID === undefined) {
            throw new ValidationException("'COMMIT_ID' is not set in environment variables.")
        }
        if (process.env.TASK_ID === undefined) {
            throw new ValidationException("'TASK_ID' is not set in environment variables.")
        }
        if (process.env.BUILD_ID === undefined) {
            throw new ValidationException("'BUILD_ID' is not set in environment variables.")
        }
        if (process.env.SHUFFLE_TEST === undefined) {
            throw new ValidationException("'SHUFFLE_TEST' is not set in environment variables.")
        }
    }
}

export class ValidationException extends Error {
    constructor(msg: string | undefined) {
        if (msg) {
            super(msg);
        }
    }
}
