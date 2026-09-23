#!/usr/bin/env node
/** R0.10 hermetic SQLite + immutable-artifact backup, restore and drill CLI. */
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { backup as sqliteBackup } from "node:sqlite";

import {
  openDatabase,
  resolveDataRoot,
  runMigrate,
  SQLITE_FILE_NAME,
  utcNowIso,
  withImmediateTransaction,
} from "../backend/src/db/sqlite.mjs";

const ARTIFACT_AUTHORITIES = [
  {
    authority: "market-data",
    base: path.join("artifacts", "market-data"),
    query: "SELECT digest, relative_path, byte_count FROM market_data_artifacts ORDER BY digest",
  },
  {
    authority: "research-backtest",
    base: path.join("artifacts", "research-backtests"),
    query: "SELECT digest, relative_path, byte_count FROM research_backtest_artifacts ORDER BY digest",
  },
];

function fail(message) {
  throw new Error(message);
}

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) fail(`unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`missing value for ${token}`);
    options[key] = value;
    index += 1;
  }
  return options;
}

function absolute(value, label) {
  if (!value || !path.isAbsolute(value)) fail(`${label} must be an absolute path`);
  return path.resolve(value);
}

function ensureRealDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${directory} must be a real directory`);
  chmodSync(directory, 0o700);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonical(value));
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(file) {
  return sha256Bytes(readFileSync(file));
}

function assertInside(root, relative, label) {
  if (path.isAbsolute(relative)) fail(`${label} path must be relative`);
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    fail(`${label} path escapes its root`);
  }
  return resolved;
}

function databaseChecks(database) {
  const integrity = database.prepare("PRAGMA integrity_check").get();
  if (!integrity || !Object.values(integrity).includes("ok")) fail("SQLite integrity check failed");
  const foreignKeys = database.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeys.length > 0) fail("SQLite foreign-key check failed");
  const migrations = database.prepare("SELECT id, checksum FROM schema_migrations ORDER BY id").all()
    .map((row) => ({ id: String(row.id), checksum: String(row.checksum) }));
  if (migrations.at(-1)?.id !== "0009_operational_hardening") {
    fail("database is not migrated through R0.10");
  }
  return migrations;
}

function referencedArtifacts(database, dataRoot) {
  const artifacts = [];
  for (const source of ARTIFACT_AUTHORITIES) {
    for (const row of database.prepare(source.query).all()) {
      const relativePath = String(row.relative_path);
      const root = path.join(dataRoot, source.base);
      const file = assertInside(root, relativePath, source.authority);
      if (!existsSync(file) || lstatSync(file).isSymbolicLink() || !statSync(file).isFile()) {
        fail(`referenced ${source.authority} artifact is missing or unsafe: ${relativePath}`);
      }
      const digest = sha256File(file);
      const byteCount = statSync(file).size;
      if (digest !== String(row.digest) || byteCount !== Number(row.byte_count)) {
        fail(`referenced ${source.authority} artifact failed integrity: ${relativePath}`);
      }
      artifacts.push({
        authority: source.authority,
        digest,
        relativePath: path.join(source.base, relativePath),
        byteCount,
      });
    }
  }
  return artifacts;
}

function appendOperationalEvent(database, eventType, artifactDigest, details, occurredAtUtc = utcNowIso()) {
  return withImmediateTransaction(database, () => {
    const current = database.prepare("SELECT COALESCE(MAX(sequence_no), 0) AS sequence_no FROM operational_events").get();
    const sequenceNo = Number(current.sequence_no) + 1;
    const detailsJson = canonicalJson(details);
    const eventContent = {
      sequenceNo,
      eventType,
      status: "passed",
      artifactDigest,
      details: JSON.parse(detailsJson),
      occurredAtUtc,
    };
    const eventDigest = sha256Bytes(canonicalJson(eventContent));
    const eventId = `ope_${eventDigest.slice(0, 32)}`;
    database.prepare(`
      INSERT INTO operational_events (
        event_id, sequence_no, event_type, status, artifact_digest,
        details_json, event_digest, occurred_at_utc, created_at_utc
      ) VALUES (?, ?, ?, 'passed', ?, ?, ?, ?, ?)
    `).run(
      eventId,
      sequenceNo,
      eventType,
      artifactDigest,
      detailsJson,
      eventDigest,
      occurredAtUtc,
      occurredAtUtc,
    );
    return { eventId, sequenceNo, eventDigest };
  });
}

function verifyBackup(backupDirectory) {
  const manifestFile = path.join(backupDirectory, "manifest.json");
  if (!existsSync(manifestFile) || lstatSync(manifestFile).isSymbolicLink()) {
    fail("backup manifest is missing or unsafe");
  }
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.workUnit !== "R0.10") fail("unsupported backup manifest");
  const databaseFile = path.join(backupDirectory, SQLITE_FILE_NAME);
  if (sha256File(databaseFile) !== manifest.database.sha256 || statSync(databaseFile).size !== manifest.database.byteCount) {
    fail("backup database digest or size mismatch");
  }
  const database = openDatabase({ databasePath: databaseFile, readOnly: true, mustExist: true });
  try {
    const migrations = databaseChecks(database);
    if (canonicalJson(migrations) !== canonicalJson(manifest.database.migrations)) {
      fail("backup migration ledger mismatch");
    }
    const referenced = referencedArtifacts(database, backupDirectory);
    if (canonicalJson(referenced) !== canonicalJson(manifest.artifacts)) {
      fail("backup artifact manifest does not match SQLite authority");
    }
  } finally {
    database.close();
  }
  for (const artifact of manifest.artifacts) {
    const file = assertInside(backupDirectory, artifact.relativePath, "backup artifact");
    if (sha256File(file) !== artifact.digest || statSync(file).size !== artifact.byteCount) {
      fail(`backup artifact digest or size mismatch: ${artifact.relativePath}`);
    }
  }
  const expectedDigest = sha256Bytes(canonicalJson({
    database: manifest.database,
    artifacts: manifest.artifacts,
    safety: manifest.safety,
  }));
  if (expectedDigest !== manifest.backupDigest) fail("backup content digest mismatch");
  return manifest;
}

async function createBackup(dataRoot, outputRoot) {
  const databasePath = path.join(dataRoot, SQLITE_FILE_NAME);
  if (!existsSync(databasePath)) fail("source SQLite database does not exist");
  if (outputRoot === dataRoot || outputRoot.startsWith(`${dataRoot}${path.sep}`)) {
    fail("backup output root must be outside the data root");
  }
  ensureRealDirectory(outputRoot);
  const source = openDatabase({ databasePath, mustExist: true });
  let staging;
  try {
    databaseChecks(source);
    staging = mkdtempSync(path.join(outputRoot, ".r010-backup-"));
    chmodSync(staging, 0o700);
    const snapshot = path.join(staging, SQLITE_FILE_NAME);
    await sqliteBackup(source, snapshot);
    chmodSync(snapshot, 0o600);
    const snapshotDatabase = openDatabase({ databasePath: snapshot, readOnly: true, mustExist: true });
    let migrations;
    let artifacts;
    try {
      migrations = databaseChecks(snapshotDatabase);
      // The artifact set must come from the completed SQLite snapshot. R0.6
      // publishes immutable bytes before committing metadata, so every row in
      // this snapshot already has a stable source blob.
      artifacts = referencedArtifacts(snapshotDatabase, dataRoot);
    } finally {
      snapshotDatabase.close();
    }
    for (const artifact of artifacts) {
      const sourceFile = assertInside(dataRoot, artifact.relativePath, "source artifact");
      const targetFile = assertInside(staging, artifact.relativePath, "backup artifact");
      ensureRealDirectory(path.dirname(targetFile));
      copyFileSync(sourceFile, targetFile);
      chmodSync(targetFile, 0o600);
    }
    const createdAtUtc = utcNowIso();
    const databaseEvidence = {
      file: SQLITE_FILE_NAME,
      sha256: sha256File(snapshot),
      byteCount: statSync(snapshot).size,
      migrations,
    };
    const safety = {
      liveExecutionEnabled: false,
      providerOrderTransportEnabled: false,
      credentialedProviderSelected: false,
    };
    const backupDigest = sha256Bytes(canonicalJson({ database: databaseEvidence, artifacts, safety }));
    const backupId = `r010-${createdAtUtc.replaceAll(/[-:.TZ]/gu, "").slice(0, 17)}-${backupDigest.slice(0, 12)}`;
    const manifest = {
      schemaVersion: 1,
      workUnit: "R0.10",
      backupId,
      createdAtUtc,
      database: databaseEvidence,
      artifacts,
      safety,
      backupDigest,
    };
    writeFileSync(path.join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    const destination = path.join(outputRoot, backupId);
    if (existsSync(destination)) fail("backup destination already exists");
    renameSync(staging, destination);
    staging = undefined;
    verifyBackup(destination);
    appendOperationalEvent(source, "backup_created", backupDigest, {
      backupId,
      databaseSha256: databaseEvidence.sha256,
      artifactCount: artifacts.length,
    }, createdAtUtc);
    return { backupId, backupDirectory: destination, backupDigest, artifactCount: artifacts.length };
  } finally {
    source.close();
    if (staging) rmSync(staging, { recursive: true, force: true });
  }
}

function assertEmptyRestoreTarget(targetRoot) {
  if (existsSync(targetRoot)) {
    const stat = lstatSync(targetRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("restore target must be a real directory");
    if (readdirSync(targetRoot).length !== 0) fail("restore target must be empty");
  }
  ensureRealDirectory(targetRoot);
}

function restoreBackup(backupDirectory, targetRoot) {
  const manifest = verifyBackup(backupDirectory);
  assertEmptyRestoreTarget(targetRoot);
  try {
    const targetDatabase = path.join(targetRoot, SQLITE_FILE_NAME);
    copyFileSync(path.join(backupDirectory, SQLITE_FILE_NAME), targetDatabase);
    chmodSync(targetDatabase, 0o600);
    for (const artifact of manifest.artifacts) {
      const sourceFile = assertInside(backupDirectory, artifact.relativePath, "backup artifact");
      const targetFile = assertInside(targetRoot, artifact.relativePath, "restored artifact");
      ensureRealDirectory(path.dirname(targetFile));
      copyFileSync(sourceFile, targetFile);
      chmodSync(targetFile, 0o600);
    }
    const restored = openDatabase({ databasePath: targetDatabase, mustExist: true });
    let event;
    try {
      databaseChecks(restored);
      referencedArtifacts(restored, targetRoot);
      event = appendOperationalEvent(restored, "restore_verified", manifest.backupDigest, {
        backupId: manifest.backupId,
        databaseSha256: manifest.database.sha256,
        artifactCount: manifest.artifacts.length,
      });
    } finally {
      restored.close();
    }
    return { backupId: manifest.backupId, backupDigest: manifest.backupDigest, event };
  } catch (error) {
    rmSync(targetRoot, { recursive: true, force: true });
    throw error;
  }
}

async function deploymentDrill(dataRoot) {
  const drillRoot = mkdtempSync(path.join(os.tmpdir(), "fdbtrade-r010-drill-"));
  try {
    const backupRoot = path.join(drillRoot, "backups");
    const restoredRoot = path.join(drillRoot, "restored");
    const backupResult = await createBackup(dataRoot, backupRoot);
    const restoreResult = restoreBackup(backupResult.backupDirectory, restoredRoot);
    const restoredDatabase = openDatabase({
      databasePath: path.join(restoredRoot, SQLITE_FILE_NAME),
      readOnly: true,
      mustExist: true,
    });
    try {
      databaseChecks(restoredDatabase);
      referencedArtifacts(restoredDatabase, restoredRoot);
    } finally {
      restoredDatabase.close();
    }
    const source = openDatabase({ databasePath: path.join(dataRoot, SQLITE_FILE_NAME), mustExist: true });
    let event;
    try {
      event = appendOperationalEvent(source, "deployment_drill_verified", backupResult.backupDigest, {
        backupId: backupResult.backupId,
        restoredDatabaseVerified: true,
        restoredArtifactCount: backupResult.artifactCount,
        externalNetworkUsed: false,
      });
    } finally {
      source.close();
    }
    return { status: "passed", backupId: restoreResult.backupId, event };
  } finally {
    rmSync(drillRoot, { recursive: true, force: true });
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const options = parseOptions(rest);
  if (command === "backup") {
    const dataRoot = options["data-root"] ? absolute(options["data-root"], "--data-root") : resolveDataRoot();
    const outputRoot = absolute(options["output-root"], "--output-root");
    console.log(JSON.stringify(await createBackup(dataRoot, outputRoot)));
    return;
  }
  if (command === "restore") {
    const backupDirectory = absolute(options.backup, "--backup");
    const targetRoot = absolute(options["target-data-root"], "--target-data-root");
    console.log(JSON.stringify(restoreBackup(backupDirectory, targetRoot)));
    return;
  }
  if (command === "drill") {
    const dataRoot = options["data-root"] ? absolute(options["data-root"], "--data-root") : resolveDataRoot();
    console.log(JSON.stringify(await deploymentDrill(dataRoot)));
    return;
  }
  if (command === "init-drill-fixture") {
    const dataRoot = absolute(options["data-root"], "--data-root");
    ensureRealDirectory(dataRoot);
    runMigrate({ databasePath: path.join(dataRoot, SQLITE_FILE_NAME), log: () => {} });
    console.log(JSON.stringify({ status: "initialized", dataRoot }));
    return;
  }
  fail("usage: operational-data.mjs backup|restore|drill [options]");
}

main().catch((error) => {
  console.error(`[operational-data] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
