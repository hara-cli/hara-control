/**
 * Production-only provider credential lifecycle.
 *
 * - bootstrap-deepseek-env imports the one-time .env value without echoing it, then atomically
 *   removes that value from the owner-only env file.
 * - run-deepseek loads the current encrypted revision and supervises the provider process with the
 *   credential only in that child process's environment. The database records a non-secret Secret
 *   revision, never a key fingerprint.
 */
import { PrismaClient } from "@prisma/client";
import { spawn } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { assertProductionRuntime } from "../config/runtime-security";
import { PrismaService } from "../prisma/prisma.service";
import { createKms } from "../security/kms";
import { SecretsService } from "../security/secrets.service";

export const DEEPSEEK_SECRET_NAME = "provider.deepseek.api_key";

function privateFileStat(path: string) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${path} must be a regular, non-symlink file`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`${path} must be owner-only (chmod 600)`);
  }
  if (typeof process.geteuid === "function" && stat.uid !== process.geteuid()) {
    throw new Error(`${path} must be owned by the deployment user`);
  }
  return stat;
}

/** Remove the bootstrap credential with an inode-bound, owner-only atomic replacement. */
export function scrubBootstrapKeyFromEnvFile(inputPath: string): boolean {
  const path = resolve(inputPath);
  const before = privateFileStat(path);
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const sourceFd = openSync(path, constants.O_RDONLY | noFollow);
  let contents: string;
  try {
    const opened = fstatSync(sourceFd);
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(".env changed while it was being opened");
    }
    contents = readFileSync(sourceFd, "utf8");
  } finally {
    closeSync(sourceFd);
  }

  const line = /^UPSTREAM_API_KEY=.*$/m;
  if (!line.test(contents) || /^UPSTREAM_API_KEY=\s*$/m.test(contents)) return false;
  const next = contents.replace(line, "UPSTREAM_API_KEY=");
  const tmp = `${path}.scrub-${process.pid}-${randomUUID()}.tmp`;
  let tmpCreated = false;
  try {
    const fd = openSync(
      tmp,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
      0o600,
    );
    tmpCreated = true;
    try {
      fchmodSync(fd, 0o600);
      writeFileSync(fd, next, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    const current = privateFileStat(path);
    if (current.dev !== before.dev || current.ino !== before.ino) {
      throw new Error(".env changed during credential scrubbing");
    }
    renameSync(tmp, path);
    tmpCreated = false;
    try {
      const dirFd = openSync(dirname(path), constants.O_RDONLY);
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch {
      // Some filesystems do not support directory fsync. The file itself was fsynced before rename.
    }
    return true;
  } finally {
    if (tmpCreated) {
      try {
        unlinkSync(tmp);
      } catch {
        // Best-effort cleanup of a newly-created owner-only staging file.
      }
    }
  }
}

async function bootstrapDeepSeekEnv(
  prisma: PrismaClient,
  scrubEnvFile?: string,
): Promise<"imported" | "already-stored"> {
  const secrets = new SecretsService(
    prisma as unknown as PrismaService,
    createKms(process.env),
  );
  const existing = await secrets.getVersioned(null, DEEPSEEK_SECRET_NAME);
  const raw = process.env.UPSTREAM_API_KEY;
  if (!existing && !raw) {
    throw new Error(
      "no encrypted DeepSeek credential exists; set UPSTREAM_API_KEY once for bootstrap",
    );
  }

  if (existing) {
    try {
      if (raw) {
        const incoming = Buffer.from(raw, "utf8");
        try {
          const same =
            incoming.length === existing.value.length &&
            timingSafeEqual(incoming, existing.value);
          if (!same) {
            throw new Error(
              "UPSTREAM_API_KEY differs from the encrypted source; refusing to overwrite it",
            );
          }
        } finally {
          incoming.fill(0);
        }
      }
    } finally {
      existing.value.fill(0);
    }
    if (raw && scrubEnvFile) scrubBootstrapKeyFromEnvFile(scrubEnvFile);
    delete process.env.UPSTREAM_API_KEY;
    return "already-stored";
  }

  const plaintext = Buffer.from(raw!, "utf8");
  try {
    await secrets.putWithSystemAudit(null, DEEPSEEK_SECRET_NAME, plaintext, {
      action: "provider.credential.import",
      actorType: "deployment",
      actorId: "provider-secret-cli",
      payload: { provider: "deepseek", source: "bootstrap-environment" },
    });
  } finally {
    plaintext.fill(0);
  }
  if (scrubEnvFile) scrubBootstrapKeyFromEnvFile(scrubEnvFile);
  delete process.env.UPSTREAM_API_KEY;
  return "imported";
}

async function waitForSpawn(child: ReturnType<typeof spawn>): Promise<void> {
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    child.once("spawn", resolveSpawn);
    child.once("error", rejectSpawn);
  });
}

async function runDeepSeek(
  prisma: PrismaClient,
  command: string,
  commandArgs: string[],
): Promise<number> {
  if (!command) throw new Error("run-deepseek requires a command after --");
  const litellmDatabaseUrl = process.env.LITELLM_DATABASE_URL;
  if (!litellmDatabaseUrl) {
    throw new Error("LITELLM_DATABASE_URL is required for the isolated LiteLLM schema");
  }
  const secrets = new SecretsService(
    prisma as unknown as PrismaService,
    createKms(process.env),
  );
  const loaded = await secrets.getVersioned(null, DEEPSEEK_SECRET_NAME);
  if (!loaded) throw new Error("no encrypted DeepSeek credential is stored");

  const runtimeId = randomUUID();
  let credentialText = loaded.value.toString("utf8");
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: litellmDatabaseUrl,
    UPSTREAM_API_KEY: credentialText,
  };
  // LiteLLM needs its own database URL, master key and provider key—not control-plane auth or KMS.
  for (const name of [
    "HARA_CONTROL_ADMIN_KEY",
    "HARA_JWT_SECRET",
    "HARA_KMS_MASTER_KEY",
    "HARA_KMS_KEYFILE",
    "LITELLM_DATABASE_URL",
  ]) {
    delete childEnv[name];
  }

  const child = spawn(command, commandArgs, {
    env: childEnv,
    stdio: "inherit",
    shell: false,
  });
  // Register before awaiting startup/DB work so an immediately-exiting child cannot be missed.
  const exitPromise = new Promise<number>((resolveExit) => {
    child.once("exit", (exitCode) => resolveExit(exitCode ?? 1));
  });
  try {
    await waitForSpawn(child);
    childEnv.UPSTREAM_API_KEY = "";
    credentialText = "";
    loaded.value.fill(0);
    await prisma.$transaction([
      prisma.providerActivation.upsert({
        where: { provider: "deepseek" },
        create: {
          provider: "deepseek",
          secretName: DEEPSEEK_SECRET_NAME,
          secretVersion: loaded.version,
          runtimeId,
        },
        update: {
          secretName: DEEPSEEK_SECRET_NAME,
          secretVersion: loaded.version,
          runtimeId,
          activatedAt: new Date(),
        },
      }),
      prisma.systemAuditLog.create({
        data: {
          action: "provider.credential.activate",
          actorType: "deployment",
          actorId: "provider-runtime",
          payload: {
            provider: "deepseek",
            secretVersion: loaded.version,
            runtime: "supervised-process",
          },
        },
      }),
    ]);
  } catch (error) {
    loaded.value.fill(0);
    child.kill("SIGTERM");
    throw error;
  }

  const forward = (signal: NodeJS.Signals) => {
    if (!child.killed) child.kill(signal);
  };
  const onSigInt = () => forward("SIGINT");
  const onSigTerm = () => forward("SIGTERM");
  process.on("SIGINT", onSigInt);
  process.on("SIGTERM", onSigTerm);

  let code = 1;
  try {
    code = await exitPromise;
  } finally {
    process.off("SIGINT", onSigInt);
    process.off("SIGTERM", onSigTerm);
    await prisma.providerActivation.deleteMany({
      where: { provider: "deepseek", runtimeId },
    });
  }
  return code;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  assertProductionRuntime();
  const prisma = new PrismaClient();
  try {
    await prisma.$connect();
    const command = argv[0];
    if (command === "bootstrap-deepseek-env") {
      const scrubIndex = argv.indexOf("--scrub-env-file");
      const scrubFile =
        scrubIndex >= 0 && argv[scrubIndex + 1]
          ? argv[scrubIndex + 1]
          : undefined;
      const result = await bootstrapDeepSeekEnv(prisma, scrubFile);
      process.stdout.write(
        result === "imported"
          ? "encrypted DeepSeek credential imported (value not displayed)\n"
          : "encrypted DeepSeek credential ready (value not displayed)\n",
      );
      return 0;
    }
    if (command === "run-deepseek") {
      const separator = argv.indexOf("--");
      if (separator < 0 || !argv[separator + 1]) {
        throw new Error("usage: provider-secret run-deepseek -- <command> [args...]");
      }
      return await runDeepSeek(prisma, argv[separator + 1], argv.slice(separator + 2));
    }
    throw new Error(
      "usage: provider-secret bootstrap-deepseek-env [--scrub-env-file .env] | run-deepseek -- <command> [args...]",
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(
        `provider credential operation failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
      );
      process.exitCode = 1;
    });
}
