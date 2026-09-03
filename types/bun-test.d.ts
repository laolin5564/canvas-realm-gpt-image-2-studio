declare module "bun:test" {
  interface Matchers {
    toBe(expected: unknown): void;
    toBeGreaterThan(expected: number): void;
    toBeLessThan(expected: number): void;
    toContain(expected: unknown): void;
  }

  export function describe(name: string, callback: () => void): void;
  export function expect(actual: unknown): Matchers;
  export function test(name: string, callback: () => void | Promise<void>): void;
  export function beforeAll(callback: () => void | Promise<void>): void;
  export function afterAll(callback: () => void | Promise<void>): void;
}
