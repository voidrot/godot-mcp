export interface Diag {
  severity: "error" | "warning";
  // The Godot prefix, e.g. "ERROR" or "SCRIPT ERROR".
  kind: string;
  message: string;
  file?: string;
  line?: number;
  column?: number;
  code?: string;
  stack?: string[];
}

export const MAX_DIAGNOSTICS = 200;

const HEADER =
  /^(USER SCRIPT ERROR|USER ERROR|USER WARNING|SCRIPT ERROR|SCRIPT WARNING|ERROR|WARNING): (.*)$/;
const LOCATION = /^\s+at: .+? \((.+):(\d+)\)\s*$/;
const BACKTRACE_HEADER =
  /^\s+GDScript backtrace \(most recent call first\):\s*$/;
const BACKTRACE_FRAME = /^\s+\[\d+\] (.+?) \((.+):(\d+)\)\s*$/;
const DOTNET_FRAME = /^\s+at (\S.*\(.*)$/;

// Parses Godot stderr as it arrives. Counts every diagnostic, but keeps only
// the first MAX_DIAGNOSTICS, so a flood of output can't hide a failure.
export class GodotOutputParser {
  readonly diagnostics: Diag[] = [];
  errorCount = 0;
  warningCount = 0;
  private pending = "";
  private current: Diag | undefined;
  private inBacktrace = false;

  get droppedDiagnostics(): boolean {
    return this.errorCount + this.warningCount > this.diagnostics.length;
  }

  // Chunks may split a line anywhere.
  push(chunk: string): void {
    const lines = (this.pending + chunk).split("\n");
    this.pending = lines.pop() ?? "";
    for (const line of lines) this.line(line.replace(/\r$/, ""));
  }

  // Flushes a final line that had no newline.
  end(): void {
    if (this.pending !== "") this.line(this.pending.replace(/\r$/, ""));
    this.pending = "";
    this.current = undefined;
  }

  private line(line: string): void {
    const header = HEADER.exec(line);
    if (header) {
      this.start(header[1] ?? "", header[2] ?? "");
      return;
    }

    const diag = this.current;
    if (diag === undefined) return;

    if (BACKTRACE_HEADER.test(line)) {
      this.inBacktrace = true;
      return;
    }
    const frame = this.inBacktrace ? BACKTRACE_FRAME.exec(line) : null;
    if (frame) {
      diag.stack = [
        ...(diag.stack ?? []),
        `${frame[1]} (${frame[2]}:${frame[3]})`,
      ];
      // The first frame is the script location; the `at:` line of push_error
      // only names the engine's C++ source.
      if (diag.stack.length === 1) {
        diag.file = frame[2];
        diag.line = Number(frame[3]);
      }
      return;
    }
    const location = LOCATION.exec(line);
    if (location) {
      diag.file = location[1];
      diag.line = Number(location[2]);
      return;
    }
    const dotnet = DOTNET_FRAME.exec(line);
    if (dotnet) {
      diag.stack = [...(diag.stack ?? []), (dotnet[1] ?? "").trim()];
      return;
    }
    // Anything else is ordinary output and ends the diagnostic.
    this.current = undefined;
    this.inBacktrace = false;
  }

  private start(kind: string, message: string): void {
    const severity = kind.endsWith("WARNING") ? "warning" : "error";
    if (severity === "error") this.errorCount++;
    else this.warningCount++;
    const diag: Diag = { severity, kind, message };
    if (this.diagnostics.length < MAX_DIAGNOSTICS) this.diagnostics.push(diag);
    this.current = diag;
    this.inBacktrace = false;
  }
}
