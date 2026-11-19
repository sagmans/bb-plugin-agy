/**
 * Exercises live GUI-PATH quota probing, parser edge cases, portable subprocess
 * failure kinds (`not-installed`, fast signed-out exit, timeout, external
 * `SIGTERM`, and output cap), plus dialect, server `UsageSource`, compaction,
 * and SVG parity scenarios so regressions fail the check gate deterministically.
 */

import { AGY_COMMAND, USER_RELATIVE_BIN_DIRS } from "../src/constants.ts";
import {
  buildPortableCliEnv,
  parseAgyUsage,
  readAgyUsage,
} from "../src/usage.ts";
import { runComponentSmokeScenarios } from "./smoke-scenarios.ts";

const CLI_ARG_INDEX = 2 as const;
const JSON_INDENT = 2 as const;
const MINIMAL_GUI_PATH = "/usr/bin:/bin" as const;
const MISSING_BINARY_NAME = "agy-missing-binary-smoke-probe" as const;
const FAST_SIGNED_OUT_LIMIT_MS = 2_500 as const;
const SHORT_TIMEOUT_MS = 120 as const;
const SUBPROCESS_DEADLINE_MS = 5_000 as const;
const SMALL_MAX_BUFFER_BYTES = 256 as const;
const SIGNED_OUT_FIXTURE =
  "Authentication required. Please visit the URL to log in:\n  https://example.invalid\n" as const;
const GARBAGE_FIXTURE = "not json" as const;
const FAILED_STATUS_FIXTURE = JSON.stringify({
  status: "FAILURE",
  command: { data: { groups: [] } },
});

/** Mirrors the real `agy -p /usage --output-format json` shape across both model groups. */
const SUCCESS_FIXTURE = JSON.stringify({
  status: "SUCCESS",
  command: {
    data: {
      groups: [
        {
          name: "Gemini Models",
          buckets: [
            {
              id: "g5",
              name: "5h",
              window: "5h",
              remaining_fraction: 0.95,
              reset_time: "2030-01-01T05:00:00Z",
            },
            {
              id: "gw",
              name: "weekly",
              window: "weekly",
              remaining_fraction: 0.99,
              reset_time: "2030-01-07T00:00:00Z",
            },
          ],
        },
        {
          name: "Claude and GPT models",
          buckets: [
            {
              id: "c5",
              name: "5h",
              window: "5h",
              remaining_fraction: 0,
              reset_time: "2030-01-01T05:00:00Z",
            },
            {
              id: "cw",
              name: "weekly",
              window: "weekly",
              remaining_fraction: 1,
              reset_time: "2030-01-07T00:00:00Z",
            },
          ],
        },
      ],
    },
  },
});

const EXPECTED_SUCCESS_WINDOWS = [
  { label: "Weekly · Gemini", usedPercent: 1 },
  { label: "5 hours · Gemini", usedPercent: 5 },
  { label: "Weekly · Claude/GPT", usedPercent: 0 },
  { label: "5 hours · Claude/GPT", usedPercent: 100 },
] as const;

const failures: string[] = [];

/** Records a failed expectation so the smoke suite exits non-zero at completion. */
function expect(name: string, passed: boolean, detail: unknown): void {
  console.log(JSON.stringify({ case: name, passed, detail }));
  if (!passed) {
    failures.push(name);
  }
}

/** Exercises real child-process failure classifications via portable spawning. */
async function runSubprocessScenarios(
  minimalGuiEnv: NodeJS.ProcessEnv,
): Promise<void> {
  const missingResult = await readAgyUsage(MISSING_BINARY_NAME, minimalGuiEnv);
  expect(
    "subprocess-not-installed",
    missingResult.supported && missingResult.usage.status === "not_installed",
    missingResult,
  );

  const authStartedAt = Date.now();
  const signedOutSubprocess = await readAgyUsage(
    process.execPath,
    process.env,
    {
      args: [
        "-e",
        "process.stdout.write('Authentication required. Visit https://example.invalid\\n'); setTimeout(() => {}, 30000);",
      ],
      timeoutMs: SUBPROCESS_DEADLINE_MS,
    },
  );
  const authElapsedMs = Date.now() - authStartedAt;
  expect(
    "subprocess-signed-out-early-exit",
    signedOutSubprocess.supported &&
      signedOutSubprocess.usage.status === "unauthenticated" &&
      authElapsedMs < FAST_SIGNED_OUT_LIMIT_MS,
    { result: signedOutSubprocess, elapsedMs: authElapsedMs },
  );

  const timedOutResult = await readAgyUsage(process.execPath, process.env, {
    args: ["-e", "setTimeout(() => {}, 10000);"],
    timeoutMs: SHORT_TIMEOUT_MS,
  });
  expect(
    "subprocess-timeout",
    timedOutResult.supported &&
      timedOutResult.usage.status === "error" &&
      timedOutResult.usage.message.includes("did not answer in time"),
    timedOutResult,
  );

  const externalSignalResult = await readAgyUsage(
    process.execPath,
    process.env,
    {
      args: ["-e", "process.kill(process.pid, 'SIGTERM');"],
      timeoutMs: SUBPROCESS_DEADLINE_MS,
    },
  );
  expect(
    "subprocess-external-sigterm",
    externalSignalResult.supported &&
      externalSignalResult.usage.status === "error" &&
      externalSignalResult.usage.message ===
        "agy could not report usage on this machine.",
    externalSignalResult,
  );

  const oversizedResult = await readAgyUsage(process.execPath, process.env, {
    args: ["-e", "process.stdout.write('x'.repeat(1024));"],
    maxBufferBytes: SMALL_MAX_BUFFER_BYTES,
    timeoutMs: SUBPROCESS_DEADLINE_MS,
  });
  expect(
    "subprocess-max-buffer",
    oversizedResult.supported &&
      oversizedResult.usage.status === "error" &&
      oversizedResult.usage.message ===
        "agy returned more usage output than bb accepts.",
    oversizedResult,
  );
}

const command = process.argv[CLI_ARG_INDEX] ?? AGY_COMMAND;
const minimalGuiEnv: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: MINIMAL_GUI_PATH,
};
const [firstUserBinDir] = USER_RELATIVE_BIN_DIRS;
const liveStartedAt = Date.now();
const liveResult = await readAgyUsage(command, minimalGuiEnv);
console.log(
  JSON.stringify(
    {
      case: "live-minimal-gui-path",
      resolvedPathContainsUserBin: (
        buildPortableCliEnv(minimalGuiEnv).PATH ?? ""
      ).includes(firstUserBinDir ?? ""),
      elapsedMs: Date.now() - liveStartedAt,
      result: liveResult,
    },
    null,
    JSON_INDENT,
  ),
);

for (const { name, fixture, expectedStatus } of [
  {
    name: "signed-out",
    fixture: SIGNED_OUT_FIXTURE,
    expectedStatus: "unauthenticated",
  },
  { name: "garbage", fixture: GARBAGE_FIXTURE, expectedStatus: "error" },
  {
    name: "failed-status",
    fixture: FAILED_STATUS_FIXTURE,
    expectedStatus: "error",
  },
  { name: "success", fixture: SUCCESS_FIXTURE, expectedStatus: "ok" },
] as const) {
  const result = parseAgyUsage(fixture);
  const status = result.supported ? result.usage.status : "unsupported";
  expect(name, status === expectedStatus, result);
}

const success = parseAgyUsage(SUCCESS_FIXTURE);
const windows =
  success.supported && success.usage.status === "ok"
    ? success.usage.windows.map(({ label, usedPercent }) => ({
        label,
        usedPercent,
      }))
    : [];
expect(
  "success-windows",
  JSON.stringify(windows) === JSON.stringify(EXPECTED_SUCCESS_WINDOWS),
  windows,
);

await runSubprocessScenarios(minimalGuiEnv);
await runComponentSmokeScenarios(expect);

if (failures.length > 0) {
  console.error(`smoke-usage: failed cases: ${failures.join(", ")}`);
  process.exitCode = 1;
}
