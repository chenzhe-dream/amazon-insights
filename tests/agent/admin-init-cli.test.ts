import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import test from "node:test";

import {
  parseAdminInitArgv,
  promptHiddenConfirmedPassword,
  runAdminInit,
  runAdminInitCli,
} from "../../server/cli/init-admin";
import { openSqliteAgentRepository } from "../../server/db/sqlite-repository";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "20000000-0000-4000-8000-000000000001";
const SECRET_PASSWORD = "admin-cli-password-sentinel";
const SECRET_HASH = "admin-cli-hash-sentinel";
const ENTITY_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

class FakeTtyInput extends EventEmitter {
  isTTY = true;
  isRaw = false;
  rawModeCalls: boolean[] = [];

  setRawMode(enabled: boolean) {
    this.isRaw = enabled;
    this.rawModeCalls.push(enabled);
    return this;
  }

  resume() {
    return this;
  }

  pause() {
    return this;
  }

  send(text: string) {
    this.emit("data", Buffer.from(text, "utf8"));
  }
}

function writableCapture() {
  let output = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  return {
    stream: stream as NodeJS.WriteStream,
    text: () => output,
  };
}

function asReadStream(input: FakeTtyInput): NodeJS.ReadStream {
  return input as unknown as NodeJS.ReadStream;
}

test("hidden password prompt rejects non-interactive input without writing secrets", async () => {
  const input = new FakeTtyInput();
  input.isTTY = false;
  const output = writableCapture();

  await assert.rejects(
    promptHiddenConfirmedPassword(asReadStream(input), output.stream),
    /interactive TTY/i,
  );
  assert.equal(output.text(), "");
});

test("hidden password prompt handles backspace, confirmation, and restores raw mode/listeners", async () => {
  const input = new FakeTtyInput();
  const output = writableCapture();
  let leaked = "";
  const existingListener = (chunk: Buffer) => {
    leaked += chunk.toString("utf8");
  };
  input.on("data", existingListener);

  const passwordPromise = promptHiddenConfirmedPassword(
    asReadStream(input),
    output.stream,
  );
  input.send("admin-cli-password-sentinelX\u007f\r");
  await Promise.resolve();
  input.send(`${SECRET_PASSWORD}\r`);

  assert.equal(await passwordPromise, SECRET_PASSWORD);
  assert.equal(input.isRaw, false);
  assert.deepEqual(input.rawModeCalls, [true, false, true, false]);
  assert.deepEqual(input.listeners("data"), [existingListener]);
  assert.equal(leaked, "");
  assert.doesNotMatch(output.text(), /admin-cli-password-sentinel/);
});

test("hidden password prompt rejects mismatches and restores raw mode", async () => {
  const input = new FakeTtyInput();
  const output = writableCapture();

  const passwordPromise = promptHiddenConfirmedPassword(
    asReadStream(input),
    output.stream,
  );
  input.send(`${SECRET_PASSWORD}\r`);
  await Promise.resolve();
  input.send("different-confirmation-sentinel\r");

  await assert.rejects(passwordPromise, /confirmation/i);
  assert.equal(input.isRaw, false);
  assert.doesNotMatch(
    output.text(),
    /admin-cli-password-sentinel|different-confirmation-sentinel/,
  );
});

test("hidden password prompt restores raw mode and listeners after input errors", async () => {
  const input = new FakeTtyInput();
  const output = writableCapture();
  const existingListener = () => undefined;
  input.on("data", existingListener);

  const passwordPromise = promptHiddenConfirmedPassword(
    asReadStream(input),
    output.stream,
  );
  input.emit("error", new Error(`${SECRET_PASSWORD} tty failure`));

  await assert.rejects(passwordPromise, /Password prompt failed/);
  assert.equal(input.isRaw, false);
  assert.deepEqual(input.listeners("data"), [existingListener]);
});

test("admin init parser accepts only non-secret options", () => {
  assert.deepEqual(
    parseAdminInitArgv([
      "--email",
      " Admin@Example.COM ",
      "--display-name",
      " First Admin ",
      "--organization-id",
      ORGANIZATION_ID,
    ]),
    {
      email: "Admin@Example.COM",
      displayName: "First Admin",
      organizationId: ORGANIZATION_ID,
    },
  );

  assert.throws(
    () =>
      parseAdminInitArgv([
        "--email",
        "admin@example.com",
        "--display-name",
        "Admin",
        "--organization-id",
        ORGANIZATION_ID,
        "--password",
        SECRET_PASSWORD,
      ]),
    /Password arguments are not allowed/,
  );
  assert.throws(
    () => parseAdminInitArgv(["--unknown", SECRET_PASSWORD]),
    /Unknown argument/,
  );
});

test("runAdminInit normalizes email and closes an owned repository", async () => {
  let closeCalls = 0;
  const seenInputs: unknown[] = [];
  const result = await runAdminInit(
    {
      email: " Admin@Example.COM ",
      displayName: " First Admin ",
      organizationId: ORGANIZATION_ID,
    },
    {
      promptPassword: async () => SECRET_PASSWORD,
      hash: async (password) => {
        assert.equal(password, SECRET_PASSWORD);
        return SECRET_HASH;
      },
      openRepository: () =>
        ({
          async createInitialAdmin(input: unknown) {
            seenInputs.push(input);
            return {
              id: USER_ID,
              organizationId: ORGANIZATION_ID,
              email: "admin@example.com",
              displayName: "First Admin",
              role: "admin",
              status: "active",
              createdAt: "2026-08-18T00:00:00.000Z",
              updatedAt: "2026-08-18T00:00:00.000Z",
            };
          },
          close() {
            closeCalls += 1;
          },
        }) as ReturnType<typeof openSqliteAgentRepository>,
    },
  );

  assert.deepEqual(result, { userId: USER_ID, email: "admin@example.com" });
  assert.equal(closeCalls, 1);
  assert.equal((seenInputs[0] as { email: string }).email, "admin@example.com");
  assert.equal(
    (seenInputs[0] as { displayName: string }).displayName,
    "First Admin",
  );
  assert.equal(
    JSON.stringify({ result, seenInputs }).includes(SECRET_PASSWORD),
    false,
  );
});

test("runAdminInit applies password policy before creating a user", async () => {
  let createCalls = 0;

  await assert.rejects(
    runAdminInit(
      {
        email: "admin@example.com",
        displayName: "First Admin",
        organizationId: ORGANIZATION_ID,
      },
      {
        promptPassword: async () => "short",
        openRepository: () =>
          ({
            async createInitialAdmin() {
              createCalls += 1;
              return null;
            },
            close() {
              throw new Error("repository should not open");
            },
          }) as ReturnType<typeof openSqliteAgentRepository>,
      },
    ),
    /Password length is invalid/,
  );
  assert.equal(createCalls, 0);
});

test("runAdminInit refuses atomically when any user already exists without leaking secrets", async () => {
  await assert.rejects(
    runAdminInit(
      {
        email: "admin@example.com",
        displayName: "First Admin",
        organizationId: ORGANIZATION_ID,
      },
      {
        promptPassword: async () => SECRET_PASSWORD,
        hash: async () => SECRET_HASH,
        openRepository: () =>
          ({
            async createInitialAdmin() {
              return null;
            },
            close() {
              return undefined;
            },
          }) as ReturnType<typeof openSqliteAgentRepository>,
      },
    ),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /already exists/i);
      assert.doesNotMatch(error.message, /admin-cli-password-sentinel/);
      assert.doesNotMatch(error.message, /admin-cli-hash-sentinel/);
      return true;
    },
  );
});

test("runAdminInitCli prints only ready status, userId, and normalized email", async () => {
  const stdout = writableCapture();
  const stderr = writableCapture();

  await runAdminInitCli(
    [
      "--email",
      "Admin@Example.COM",
      "--display-name",
      "First Admin",
      "--organization-id",
      ORGANIZATION_ID,
    ],
    {
      input: asReadStream(new FakeTtyInput()),
      stdout: stdout.stream,
      stderr: stderr.stream,
    },
    {
      promptPassword: async () => SECRET_PASSWORD,
      hash: async () => SECRET_HASH,
      openRepository: () =>
        ({
          async createInitialAdmin() {
            return {
              id: USER_ID,
              organizationId: ORGANIZATION_ID,
              email: "admin@example.com",
              displayName: "First Admin",
              role: "admin",
              status: "active",
              createdAt: "2026-08-18T00:00:00.000Z",
              updatedAt: "2026-08-18T00:00:00.000Z",
            };
          },
          close() {
            return undefined;
          },
        }) as ReturnType<typeof openSqliteAgentRepository>,
    },
  );

  assert.equal(stderr.text(), "");
  assert.deepEqual(JSON.parse(stdout.text()), {
    status: "ready",
    userId: USER_ID,
    email: "admin@example.com",
  });
  assert.deepEqual(Object.keys(JSON.parse(stdout.text())).sort(), [
    "email",
    "status",
    "userId",
  ]);
  assert.doesNotMatch(
    `${stdout.text()}\n${stderr.text()}`,
    /admin-cli-password-sentinel|admin-cli-hash-sentinel|First Admin/,
  );
});

test("real SQLite command path creates one normalized first admin and rejects the second", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "agent-admin-init-cli-"));
  const path = join(dir, "agent.sqlite");
  const previousSqlitePath = process.env.AGENT_SQLITE_PATH;
  process.env.AGENT_SQLITE_PATH = path;
  t.after(async () => {
    if (previousSqlitePath === undefined) {
      delete process.env.AGENT_SQLITE_PATH;
    } else {
      process.env.AGENT_SQLITE_PATH = previousSqlitePath;
    }
    await rm(dir, { recursive: true, force: true });
  });

  const options = {
    email: " ADMIN@Example.COM ",
    displayName: " First Admin ",
    organizationId: ORGANIZATION_ID,
  };
  const first = await runAdminInit(options, {
    promptPassword: async () => SECRET_PASSWORD,
    openRepository: (config) => openSqliteAgentRepository(config),
  });
  assert.match(first.userId, ENTITY_ID_PATTERN);
  assert.equal(first.email, "admin@example.com");

  await assert.rejects(
    runAdminInit(
      {
        email: "second@example.com",
        displayName: "Second Admin",
        organizationId: ORGANIZATION_ID,
      },
      {
        promptPassword: async () => SECRET_PASSWORD,
        openRepository: (config) =>
          openSqliteAgentRepository({ ...config, path }),
      },
    ),
    /already exists/i,
  );

  const repository = openSqliteAgentRepository({
    path,
    busyTimeoutMs: 5_000,
  });
  try {
    const found = await repository.findAuthenticationUserByEmail(
      "ADMIN@example.com",
    );
    assert.equal(found?.user.email, "admin@example.com");
    assert.doesNotMatch(
      found?.passwordHash ?? "",
      /admin-cli-password-sentinel/,
    );
  } finally {
    repository.close();
  }
});
