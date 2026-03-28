declare module 'better-sqlite3' {
  export type Statement = {
    all: (...args: unknown[]) => unknown[];
    get: (...args: unknown[]) => unknown;
    run: (...args: unknown[]) => unknown;
  };

  export default class Database {
    constructor(filename: string);
    exec(sql: string): void;
    pragma(sql: string): void;
    prepare(sql: string): Statement;
  }
}

declare module 'picomatch' {
  type Matcher = (input: string) => boolean;
  export default function picomatch(pattern: string, options?: Record<string, unknown>): Matcher;
}
