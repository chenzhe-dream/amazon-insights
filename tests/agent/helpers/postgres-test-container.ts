import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import { Pool, type PoolConfig } from "pg";

const execFileAsync = promisify(execFile);
const POSTGRES_IMAGE = "postgres:16-alpine";
const POSTGRES_TEST_CONTAINER_LABEL = "com.amazon-insights.test-postgres=true";
const CONTAINER_ID_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]*$/;
const STARTUP_TIMEOUT_MS = 30_000;

let imagePreparation: Promise<void> | undefined;

export interface PostgresTestContainer {
  readonly pool: Pool;
  createPool(options?: Readonly<{ searchPath?: string }>): Pool;
  close(): Promise<void>;
}

async function runDocker(args: string[]): Promise<string> {
  const result = await execFileAsync("docker", args, {
    encoding: "utf8",
    windowsHide: true,
  });
  return result.stdout.trim();
}

async function prepareImage(): Promise<void> {
  if (!imagePreparation) {
    imagePreparation = (async () => {
      try {
        await runDocker(["version", "--format", "{{.Server.Version}}"]);
      } catch {
        throw new Error(
          "Docker is required for PostgreSQL integration tests, but the Docker service is unavailable",
        );
      }

      try {
        await runDocker(["image", "inspect", POSTGRES_IMAGE, "--format", "{{.Id}}"]);
      } catch {
        try {
          await runDocker(["pull", POSTGRES_IMAGE]);
        } catch {
          throw new Error(
            `Required PostgreSQL test image ${POSTGRES_IMAGE} could not be pulled`,
          );
        }
      }
    })();
  }
  return imagePreparation;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function postgresTestContainerRunArgs(input: Readonly<{
  containerName: string;
  database: string;
}>): string[] {
  return [
    "run",
    "--detach",
    "--rm",
    "--label",
    POSTGRES_TEST_CONTAINER_LABEL,
    "--name",
    input.containerName,
    "--publish",
    "127.0.0.1::5432",
    "--env",
    "POSTGRES_HOST_AUTH_METHOD=trust",
    "--env",
    "POSTGRES_USER=postgres",
    "--env",
    `POSTGRES_DB=${input.database}`,
    POSTGRES_IMAGE,
  ];
}

export function postgresTestContainerRemoveArgs(containerId: string): string[] {
  if (!CONTAINER_ID_PATTERN.test(containerId)) {
    throw new Error("PostgreSQL test container ID is invalid");
  }
  return ["rm", "--force", "--volumes", containerId];
}

export async function startPostgresTestContainer(): Promise<PostgresTestContainer> {
  await prepareImage();

  const suffix = randomUUID().replaceAll("-", "");
  const containerName = `agent_pg_test_${suffix}`;
  const database = `agent_test_${suffix}`;
  let containerId: string | undefined;
  let primaryPool: Pool | undefined;
  const pools = new Set<Pool>();

  try {
    containerId = await runDocker(postgresTestContainerRunArgs({ containerName, database }));
    if (!CONTAINER_ID_PATTERN.test(containerId)) {
      throw new Error("Docker did not return an exact PostgreSQL container ID");
    }

    const publishedPort = await runDocker(["port", containerId, "5432/tcp"]);
    const portMatch = /^127\.0\.0\.1:(\d+)$/.exec(publishedPort);
    if (!portMatch) {
      throw new Error("PostgreSQL test container was not bound to a loopback port");
    }

    const connection: PoolConfig = Object.freeze({
      host: "127.0.0.1",
      port: Number(portMatch[1]),
      user: "postgres",
      database,
      connectionTimeoutMillis: 1_000,
      max: 10,
    });
    let acceptingPools = true;
    const createPool = (options?: Readonly<{ searchPath?: string }>): Pool => {
      if (!acceptingPools) {
        throw new Error("PostgreSQL test container is closing or closed");
      }
      const searchPath = options?.searchPath;
      if (searchPath && !SAFE_IDENTIFIER_PATTERN.test(searchPath)) {
        throw new Error("PostgreSQL test search path is invalid");
      }
      const pool = new Pool({
        ...connection,
        ...(searchPath ? { options: `-c search_path=${searchPath}` } : {}),
      });
      pools.add(pool);
      return pool;
    };

    primaryPool = createPool();
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (true) {
      try {
        await primaryPool.query("SELECT 1");
        break;
      } catch {
        if (Date.now() >= deadline) {
          throw new Error("PostgreSQL test container did not become ready in time");
        }
        await delay(250);
      }
    }

    let closePromise: Promise<void> | undefined;
    return Object.freeze({
      pool: primaryPool,
      createPool,
      close(): Promise<void> {
        acceptingPools = false;
        closePromise ??= (async () => {
          await Promise.allSettled([...pools].map((pool) => pool.end()));
          await runDocker(postgresTestContainerRemoveArgs(containerId!));
        })();
        return closePromise;
      },
    });
  } catch (error) {
    if (primaryPool) await primaryPool.end().catch(() => undefined);
    if (containerId && CONTAINER_ID_PATTERN.test(containerId)) {
      await runDocker(postgresTestContainerRemoveArgs(containerId)).catch(() => undefined);
    }
    throw error;
  }
}
