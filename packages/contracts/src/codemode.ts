export const CODEMODE_SOURCE_LIMIT_BYTES = 32 * 1024;
export const CODEMODE_PARAMETER_LIMIT_BYTES = 32 * 1024;
export const CODEMODE_OUTPUT_LIMIT_BYTES = 32 * 1024;
export const CODEMODE_RESULT_LIMIT_BYTES = 128 * 1024;
export const CODEMODE_MEMORY_LIMIT_BYTES = 16 * 1024 * 1024;
export const CODEMODE_INTERRUPT_BUDGET = 10_000;
export const CODEMODE_MAX_CALLS = 16;
export const CODEMODE_MAX_IN_FLIGHT = 2;
export const CODEMODE_MAX_HELPER_CALLS = 16;
export const CODEMODE_DEADLINE_MS = 30_000;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface CodemodeEffects {
  completedWrites: number;
  unknownWrites: number;
}

export type CodemodeToolResult =
  | { ok: true; value?: JsonValue; output: string[]; effects: CodemodeEffects }
  | { ok: false; error: { code: string; message: string }; output: string[]; effects: CodemodeEffects };
