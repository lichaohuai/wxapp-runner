export type Diagnostic = {
  code: string;
  phase: "package" | "baselib" | "logic" | "view" | "bridge";
  message: string;
  hint: string;
  file?: string;
  route?: string;
};
export class RunnerError extends Error {
  constructor(
    public diagnostic: Diagnostic,
    cause?: unknown,
  ) {
    super(
      `[${diagnostic.code}] ${diagnostic.message}${diagnostic.route ? ` (page: ${diagnostic.route})` : ""}${diagnostic.file ? ` (file: ${diagnostic.file})` : ""}\n${diagnostic.hint}`,
    );
    this.name = "RunnerError";
    if (cause !== undefined) {
      this.cause = cause;
      // Cross-realm errors are not instanceof the host's Error. Preserve the
      // original script location in serialized stack-only debug responses.
      const stack =
        cause && typeof (cause as any).stack === "string"
          ? (cause as any).stack
          : String(cause);
      // vm errors can prefix stack frames with an entire minified bundle and
      // its caret line. Keep the message/frames, not megabytes of source text.
      this.stack +=
        "\nCaused by: " +
        stack
          .split("\n")
          .filter(
            (line: string) => line.length <= 2000 && !/^\s*\^*\s*$/.test(line),
          )
          .slice(-80)
          .join("\n");
    }
  }
}
export function diagnostic(
  code: string,
  phase: Diagnostic["phase"],
  message: string,
  hint: string,
  context: Partial<Diagnostic> = {},
): Diagnostic {
  return { code, phase, message, hint, ...context };
}
