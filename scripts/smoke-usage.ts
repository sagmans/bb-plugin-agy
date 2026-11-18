/**
 * Exercises the usage parser and the manifest id wiring outside bb, so parser
 * or id regressions fail the pre-push gate without a running host daemon.
 * Offline cases are asserted; the live `agy` read is informational because
 * contributors may not have a signed-in account.
 */

import { readFile } from "node:fs/promises";
import {
  AGY_COMMAND,
  ICON_NAME,
  PROVIDER_ID,
  USER_RELATIVE_BIN_DIRS,
} from "../src/constants.ts";
import {
  buildPortableCliEnv,
  parseAgyUsage,
  readAgyUsage,
} from "../src/usage.ts";

const CLI_ARG_INDEX = 2 as const;
const JSON_INDENT = 2 as const;
const MINIMAL_GUI_PATH = "/usr/bin:/bin" as const;
const PACKAGE_JSON_URL = new URL("../package.json", import.meta.url);
const PACKAGE_NAME_PREFIX = "bb-plugin-" as const;
const SIGNED_OUT_FIXTURE =
  "Authentication required. Please visit the URL to log in:\n  https://example.invalid\n" as const;
const GARBAGE_FIXTURE = "not json" as const;
/** Mirrors the real `agy -p /usage --output-format json` shape, buckets out of order. */
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
      ],
    },
  },
});
const EXPECTED_SUCCESS_WINDOWS = [
  { label: "Weekly · Gemini", usedPercent: 1 },
  { label: "5 hours · Gemini", usedPercent: 5 },
] as const;

const failures: string[] = [];

/** Records a failed expectation; the script exits non-zero at the end. */
function expect(name: string, passed: boolean, detail: unknown): void {
  console.log(JSON.stringify({ case: name, passed, detail }));
  if (!passed) failures.push(name);
}

const command = process.argv[CLI_ARG_INDEX] ?? AGY_COMMAND;
const minimalGuiEnv: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: MINIMAL_GUI_PATH,
};
const [firstUserBinDir] = USER_RELATIVE_BIN_DIRS;
console.log(
  JSON.stringify(
    {
      case: "live-minimal-gui-path",
      resolvedPathContainsUserBin: (
        buildPortableCliEnv(minimalGuiEnv).PATH ?? ""
      ).includes(firstUserBinDir ?? ""),
      result: await readAgyUsage(command, minimalGuiEnv),
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

// bb derives the plugin id from the package name and namespaces icons by it,
// so the manifest must agree with PROVIDER_ID and ICON_NAME.
const manifest = JSON.parse(await readFile(PACKAGE_JSON_URL, "utf8")) as {
  name: string;
  bb: {
    experimental_providers: { id: string }[];
    branding: { experimental_icons: Record<string, string> };
  };
};
expect(
  "manifest-ids",
  manifest.name === `${PACKAGE_NAME_PREFIX}${PROVIDER_ID}` &&
    manifest.bb.experimental_providers.some((p) => p.id === PROVIDER_ID) &&
    ICON_NAME in manifest.bb.branding.experimental_icons,
  {
    name: manifest.name,
    providers: manifest.bb.experimental_providers.map((p) => p.id),
    icons: Object.keys(manifest.bb.branding.experimental_icons),
  },
);

if (failures.length > 0) {
  console.error(`smoke-usage: failed cases: ${failures.join(", ")}`);
  process.exitCode = 1;
}
