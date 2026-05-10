export function getDashboardTargetId(argv: string[]): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dashboard-target-id") {
      return argv[index + 1] ?? null;
    }

    if (arg.startsWith("--dashboard-target-id=")) {
      return arg.slice("--dashboard-target-id=".length);
    }
  }

  return null;
}