#!/usr/bin/env node
/** R0.11 crash-consistent local SQLite + immutable-artifact recovery CLI. */
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { backup as sqliteBackup } from "node:sqlite";

import {
  computeChecksum,
  openDatabase,
  planUpMigrations,
  resolveDataRoot,
  runMigrate,
  SQLITE_FILE_NAME,
  SQLITE_MIGRATIONS_DIR,
  utcNowIso,
  withImmediateTransaction,
} from "../backend/src/db/sqlite.mjs";

const MANIFEST_VERSION = 2;
const MANIFEST_WORK_UNIT = "R0.11";
const INTEGRITY_CLAIM = "sha256-integrity-evidence-not-cryptographic-authenticity";
const DIGEST = /^[a-f0-9]{64}$/u;
const FAULT_STAGES = new Set([
  "snapshot",
  "artifact-copy",
  "manifest",
  "verification",
  "pre-rename",
  "post-rename-pre-event",
  "restore-publication",
]);
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

function trace(step) {
  const file = process.env.FDB_OPERATIONAL_TRACE_FILE;
  if (file) appendFileSync(file, `${step}\n`, "utf8");
}

function injectFault(stage) {
  const configured = process.env.FDB_OPERATIONAL_FAULT_STAGE;
  if (configured && !FAULT_STAGES.has(configured)) fail(`unknown operational fault stage: ${configured}`);
  if (configured === stage) fail(`injected operational fault: ${stage}`);
}

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) fail(`unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`missing value for ${token}`);
    if (Object.hasOwn(options, key)) fail(`duplicate option: ${token}`);
    options[key] = value;
    index += 1;
  }
  return options;
}

function absolute(value, label) {
  if (!value || !path.isAbsolute(value)) fail(`${label} must be an absolute path`);
  return path.resolve(value);
}

function assertNoSymlinkComponents(target, label, allowMissing = false) {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  const parts = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let missing = false;
  for (const part of parts) {
    current = path.join(current, part);
    if (missing) {
      missing = true;
      continue;
    }
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      missing = true;
      continue;
    }
    if (stat.isSymbolicLink()) fail(`${label} contains a symbolic-link component`);
  }
  if (missing && !allowMissing) fail(`${label} does not exist`);
  return resolved;
}

function ensureRealDirectory(directory) {
  assertNoSymlinkComponents(directory, directory, true);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertNoSymlinkComponents(directory, directory);
  const stat = lstatSync(directory);
  if (!stat.isDirectory()) fail(`${directory} must be a real directory`);
  chmodSync(directory, 0o700);
}

function assertRealDirectory(directory, label) {
  assertNoSymlinkComponents(directory, label);
  if (!lstatSync(directory).isDirectory()) fail(`${label} must be a real directory`);
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

function assertRegularFile(file, label) {
  assertNoSymlinkComponents(file, label);
  const stat = lstatSync(file);
  if (!stat.isFile()) fail(`${label} must be a regular file`);
  return stat;
}

function sha256File(file, label = file) {
  assertRegularFile(file, label);
  return sha256Bytes(readFileSync(file));
}

function assertInside(root, relative, label) {
  if (typeof relative !== "string" || relative.length === 0 || path.isAbsolute(relative)) {
    fail(`${label} path must be non-empty and relative`);
  }
  if (relative.includes("\\") || path.normalize(relative) !== relative || relative.split(path.sep).includes("..")) {
    fail(`${label} path is not canonical`);
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  if (resolved === resolvedRoot || !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    fail(`${label} path escapes its root`);
  }
  return resolved;
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) fail(`${label} has unsupported fields`);
}

function expectedMigrationLedger() {
  return planUpMigrations(readdirSync(SQLITE_MIGRATIONS_DIR)).map(({ id, file }) => ({
    id,
    checksum: computeChecksum(readFileSync(path.join(SQLITE_MIGRATIONS_DIR, file), "utf8")),
  }));
}

function databaseChecks(database) {
  const integrity = database.prepare("PRAGMA integrity_check").get();
  if (!integrity || !Object.values(integrity).includes("ok")) fail("SQLite integrity check failed");
  const foreignKeys = database.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeys.length > 0) fail("SQLite foreign-key check failed");
  const migrations = database.prepare("SELECT id, checksum FROM schema_migrations ORDER BY id").all()
    .map((row) => ({ id: String(row.id), checksum: String(row.checksum) }));
  if (canonicalJson(migrations) !== canonicalJson(expectedMigrationLedger())) {
    fail("database migration ledger does not exactly match the active migration set");
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
      const stat = assertRegularFile(file, `referenced ${source.authority} artifact`);
      const digest = sha256File(file);
      const byteCount = stat.size;
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
      eventId, sequenceNo, eventType, artifactDigest, detailsJson,
      eventDigest, occurredAtUtc, occurredAtUtc,
    );
    return { eventId, sequenceNo, eventDigest };
  });
}

function validateManifest(manifest) {
  const isLegacy = manifest?.schemaVersion === 1 && manifest?.workUnit === "R0.10";
  const isCurrent = manifest?.schemaVersion === MANIFEST_VERSION && manifest?.workUnit === MANIFEST_WORK_UNIT;
  if (!isLegacy && !isCurrent) fail("unsupported backup manifest");
  exactKeys(
    manifest,
    isCurrent
      ? ["schemaVersion", "workUnit", "backupId", "createdAtUtc", "database", "artifacts", "safety", "integrityClaim", "backupDigest"]
      : ["schemaVersion", "workUnit", "backupId", "createdAtUtc", "database", "artifacts", "safety", "backupDigest"],
    "backup manifest",
  );
  if (isCurrent && manifest.integrityClaim !== INTEGRITY_CLAIM) fail("unsupported manifest integrity claim");
  if (typeof manifest.backupId !== "string" || !/^r01(?:0|1)-[a-zA-Z0-9-]+$/u.test(manifest.backupId)) {
    fail("invalid backup id");
  }
  if (typeof manifest.createdAtUtc !== "string" || new Date(manifest.createdAtUtc).toISOString() !== manifest.createdAtUtc) {
    fail("invalid backup creation time");
  }
  exactKeys(manifest.database, ["file", "sha256", "byteCount", "migrations"], "manifest database");
  if (manifest.database.file !== SQLITE_FILE_NAME || !DIGEST.test(manifest.database.sha256) ||
      !Number.isSafeInteger(manifest.database.byteCount) || manifest.database.byteCount <= 0 ||
      !Array.isArray(manifest.database.migrations)) fail("invalid manifest database evidence");
  for (const migration of manifest.database.migrations) {
    exactKeys(migration, ["id", "checksum"], "manifest migration");
    if (typeof migration.id !== "string" || !DIGEST.test(migration.checksum)) fail("invalid manifest migration");
  }
  if (!Array.isArray(manifest.artifacts)) fail("manifest artifacts must be an array");
  const seen = new Set();
  for (const artifact of manifest.artifacts) {
    exactKeys(artifact, ["authority", "digest", "relativePath", "byteCount"], "manifest artifact");
    const source = ARTIFACT_AUTHORITIES.find((candidate) => candidate.authority === artifact.authority);
    if (!source || !DIGEST.test(artifact.digest) || !Number.isSafeInteger(artifact.byteCount) || artifact.byteCount <= 0) {
      fail("invalid manifest artifact evidence");
    }
    if (typeof artifact.relativePath !== "string" || !artifact.relativePath.startsWith(`${source.base}${path.sep}`)) {
      fail("manifest artifact path is invalid or duplicated");
    }
    assertInside(source.base, artifact.relativePath.slice(source.base.length + 1), "manifest artifact");
    if (seen.has(artifact.relativePath)) fail("manifest artifact path is invalid or duplicated");
    seen.add(artifact.relativePath);
  }
  exactKeys(
    manifest.safety,
    ["liveExecutionEnabled", "providerOrderTransportEnabled", "credentialedProviderSelected"],
    "manifest safety",
  );
  if (manifest.safety.liveExecutionEnabled !== false ||
      manifest.safety.providerOrderTransportEnabled !== false ||
      manifest.safety.credentialedProviderSelected !== false) {
    fail("backup safety flags must be literal false");
  }
  if (!DIGEST.test(manifest.backupDigest)) fail("invalid backup content digest");
  return manifest;
}

function evidenceEntries(root, directory = root) {
  const entries = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) fail("backup contains a symbolic link");
    if (entry.isDirectory()) {
      entries.push(`d:${path.relative(root, absolutePath)}`);
      entries.push(...evidenceEntries(root, absolutePath));
    } else if (entry.isFile()) {
      entries.push(`f:${path.relative(root, absolutePath)}`);
    } else {
      fail("backup contains a non-regular filesystem entry");
    }
  }
  return entries.sort();
}

function verifyEvidenceFileSet(root, manifest, includeManifest) {
  const files = [SQLITE_FILE_NAME, ...manifest.artifacts.map((artifact) => artifact.relativePath)];
  if (includeManifest) files.push("manifest.json");
  const expected = new Set(files.map((file) => `f:${file}`));
  for (const file of files) {
    let directory = path.dirname(file);
    while (directory !== ".") {
      expected.add(`d:${directory}`);
      directory = path.dirname(directory);
    }
  }
  const actual = evidenceEntries(root);
  const required = [...expected].sort();
  const legacySidecars = new Set([
    `f:${SQLITE_FILE_NAME}-shm`,
    `f:${SQLITE_FILE_NAME}-wal`,
  ]);
  const legacyCompatible = manifest.schemaVersion === 1 && manifest.workUnit === "R0.10" &&
    required.every((entry) => actual.includes(entry)) &&
    actual.every((entry) => expected.has(entry) || legacySidecars.has(entry));
  if (canonicalJson(actual) !== canonicalJson(required) && !legacyCompatible) {
    fail("backup filesystem does not exactly match the manifest");
  }
}

function verifyBackup(backupDirectory) {
  assertRealDirectory(backupDirectory, "backup directory");
  const manifestFile = path.join(backupDirectory, "manifest.json");
  assertRegularFile(manifestFile, "backup manifest");
  let manifest;
  try {
    manifest = validateManifest(JSON.parse(readFileSync(manifestFile, "utf8")));
  } catch (error) {
    if (error instanceof SyntaxError) fail("backup manifest is malformed JSON");
    throw error;
  }
  verifyEvidenceFileSet(backupDirectory, manifest, true);
  const databaseFile = path.join(backupDirectory, SQLITE_FILE_NAME);
  const databaseStat = assertRegularFile(databaseFile, "backup database");
  if (sha256File(databaseFile) !== manifest.database.sha256 || databaseStat.size !== manifest.database.byteCount) {
    fail("backup database digest or size mismatch");
  }
  const verificationRoot = mkdtempSync(path.join(os.tmpdir(), "fdbtrade-r011-verify-"));
  const verificationDatabase = path.join(verificationRoot, SQLITE_FILE_NAME);
  copyFileSync(databaseFile, verificationDatabase);
  let database;
  try {
    database = openDatabase({ databasePath: verificationDatabase, readOnly: true, mustExist: true });
    const migrations = databaseChecks(database);
    if (canonicalJson(migrations) !== canonicalJson(manifest.database.migrations)) {
      fail("backup migration ledger mismatch");
    }
    const referenced = referencedArtifacts(database, backupDirectory);
    if (canonicalJson(referenced) !== canonicalJson(manifest.artifacts)) {
      fail("backup artifact manifest does not match SQLite authority");
    }
  } finally {
    database?.close();
    rmSync(verificationRoot, { recursive: true, force: true });
  }
  for (const artifact of manifest.artifacts) {
    const file = assertInside(backupDirectory, artifact.relativePath, "backup artifact");
    const stat = assertRegularFile(file, "backup artifact");
    if (sha256File(file) !== artifact.digest || stat.size !== artifact.byteCount) {
      fail(`backup artifact digest or size mismatch: ${artifact.relativePath}`);
    }
  }
  const digestInput = { database: manifest.database, artifacts: manifest.artifacts, safety: manifest.safety };
  const expectedDigest = sha256Bytes(canonicalJson(digestInput));
  if (expectedDigest !== manifest.backupDigest) fail("backup content digest mismatch");
  return manifest;
}

function fsyncFile(file, traceName) {
  assertRegularFile(file, traceName);
  const descriptor = openSync(file, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  trace(`file-fsynced:${traceName}`);
}

function fsyncDirectory(directory, traceName) {
  assertRealDirectory(directory, traceName);
  const descriptor = openSync(directory, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  trace(`directory-fsynced:${traceName}`);
}

function artifactDirectories(root, artifacts) {
  const directories = new Set([root]);
  for (const artifact of artifacts) {
    let directory = path.dirname(assertInside(root, artifact.relativePath, "artifact"));
    while (directory !== root) {
      directories.add(directory);
      directory = path.dirname(directory);
    }
  }
  return [...directories].sort((left, right) => right.length - left.length);
}

function fsyncEvidenceTree(root, databaseFile, artifacts, includeManifest) {
  fsyncFile(databaseFile, SQLITE_FILE_NAME);
  for (const artifact of artifacts) {
    fsyncFile(assertInside(root, artifact.relativePath, "artifact"), artifact.relativePath);
  }
  if (includeManifest) fsyncFile(path.join(root, "manifest.json"), "manifest.json");
  for (const directory of artifactDirectories(root, artifacts)) {
    fsyncDirectory(directory, path.relative(root, directory) || ".");
  }
}

async function createBackup(dataRoot, outputRoot) {
  assertRealDirectory(dataRoot, "source data root");
  const databasePath = path.join(dataRoot, SQLITE_FILE_NAME);
  assertRegularFile(databasePath, "source SQLite database");
  if (outputRoot === dataRoot || outputRoot.startsWith(`${dataRoot}${path.sep}`)) {
    fail("backup output root must be outside the data root");
  }
  ensureRealDirectory(outputRoot);
  const source = openDatabase({ databasePath, mustExist: true });
  let staging;
  try {
    databaseChecks(source);
    staging = mkdtempSync(path.join(outputRoot, ".r011-backup-staging-"));
    chmodSync(staging, 0o700);
    const snapshot = path.join(staging, SQLITE_FILE_NAME);
    await sqliteBackup(source, snapshot);
    chmodSync(snapshot, 0o600);
    trace("snapshot-created");
    injectFault("snapshot");
    const snapshotDatabase = openDatabase({ databasePath: snapshot, mustExist: true });
    let migrations;
    let artifacts;
    try {
      migrations = databaseChecks(snapshotDatabase);
      artifacts = referencedArtifacts(snapshotDatabase, dataRoot);
      snapshotDatabase.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      snapshotDatabase.exec("PRAGMA journal_mode = DELETE");
    } finally {
      snapshotDatabase.close();
    }
    for (const artifact of artifacts) {
      const sourceFile = assertInside(dataRoot, artifact.relativePath, "source artifact");
      assertRegularFile(sourceFile, "source artifact");
      const targetFile = assertInside(staging, artifact.relativePath, "backup artifact");
      ensureRealDirectory(path.dirname(targetFile));
      copyFileSync(sourceFile, targetFile);
      chmodSync(targetFile, 0o600);
      trace(`artifact-copied:${artifact.authority}`);
    }
    injectFault("artifact-copy");
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
    const backupId = `r011-${createdAtUtc.replaceAll(/[-:.TZ]/gu, "").slice(0, 17)}-${backupDigest.slice(0, 12)}`;
    const manifest = {
      schemaVersion: MANIFEST_VERSION,
      workUnit: MANIFEST_WORK_UNIT,
      backupId,
      createdAtUtc,
      database: databaseEvidence,
      artifacts,
      safety,
      integrityClaim: INTEGRITY_CLAIM,
      backupDigest,
    };
    writeFileSync(path.join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    trace("manifest-written");
    injectFault("manifest");
    injectFault("verification");
    verifyBackup(staging);
    trace("staging-verified");
    fsyncEvidenceTree(staging, snapshot, artifacts, true);
    fsyncDirectory(outputRoot, "output-parent-before-rename");
    injectFault("pre-rename");
    const destination = path.join(outputRoot, backupId);
    assertNoSymlinkComponents(destination, "backup destination", true);
    if (existsSync(destination)) fail("backup destination already exists");
    renameSync(staging, destination);
    staging = undefined;
    trace("backup-renamed");
    fsyncDirectory(outputRoot, "output-parent-after-rename");
    injectFault("post-rename-pre-event");
    appendOperationalEvent(source, "backup_created", backupDigest, {
      backupId,
      databaseSha256: databaseEvidence.sha256,
      artifactCount: artifacts.length,
    }, createdAtUtc);
    trace("backup-event-recorded");
    return { backupId, backupDirectory: destination, backupDigest, artifactCount: artifacts.length };
  } finally {
    source.close();
    if (staging) rmSync(staging, { recursive: true, force: true });
  }
}

function inspectRestoreTarget(targetRoot) {
  if (targetRoot === path.parse(targetRoot).root) fail("restore target cannot be a filesystem root");
  assertNoSymlinkComponents(targetRoot, "restore target", true);
  if (!existsSync(targetRoot)) return false;
  const stat = lstatSync(targetRoot);
  if (!stat.isDirectory()) fail("restore target must be a real directory");
  if (readdirSync(targetRoot).length !== 0) fail("restore target must be empty");
  return true;
}

function restoreBackup(backupDirectory, targetRoot) {
  const manifest = verifyBackup(backupDirectory);
  trace("restore-backup-verified");
  const targetExisted = inspectRestoreTarget(targetRoot);
  const targetParent = path.dirname(targetRoot);
  ensureRealDirectory(targetParent);
  let staging = mkdtempSync(path.join(targetParent, `.${path.basename(targetRoot)}.r011-restore-staging-`));
  chmodSync(staging, 0o700);
  let removedEmptyTarget = false;
  try {
    const targetDatabase = path.join(staging, SQLITE_FILE_NAME);
    copyFileSync(path.join(backupDirectory, SQLITE_FILE_NAME), targetDatabase);
    chmodSync(targetDatabase, 0o600);
    for (const artifact of manifest.artifacts) {
      const sourceFile = assertInside(backupDirectory, artifact.relativePath, "backup artifact");
      assertRegularFile(sourceFile, "backup artifact");
      const targetFile = assertInside(staging, artifact.relativePath, "restored artifact");
      ensureRealDirectory(path.dirname(targetFile));
      copyFileSync(sourceFile, targetFile);
      chmodSync(targetFile, 0o600);
    }
    const restored = openDatabase({ databasePath: targetDatabase, mustExist: true });
    let event;
    try {
      const migrations = databaseChecks(restored);
      if (canonicalJson(migrations) !== canonicalJson(manifest.database.migrations)) {
        fail("restored migration ledger mismatch");
      }
      const artifacts = referencedArtifacts(restored, staging);
      if (canonicalJson(artifacts) !== canonicalJson(manifest.artifacts)) {
        fail("restored artifact set mismatch");
      }
      event = appendOperationalEvent(restored, "restore_verified", manifest.backupDigest, {
        backupId: manifest.backupId,
        databaseSha256: manifest.database.sha256,
        artifactCount: manifest.artifacts.length,
      });
      restored.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      restored.exec("PRAGMA journal_mode = DELETE");
    } finally {
      restored.close();
    }
    const reopened = openDatabase({ databasePath: targetDatabase, readOnly: true, mustExist: true });
    try {
      databaseChecks(reopened);
      referencedArtifacts(reopened, staging);
      const row = reopened.prepare("SELECT event_id FROM operational_events WHERE event_id = ?").get(event.eventId);
      if (!row) fail("restore evidence was not durably appended");
    } finally {
      reopened.close();
    }
    verifyEvidenceFileSet(staging, manifest, false);
    trace("restore-staging-verified");
    fsyncEvidenceTree(staging, targetDatabase, manifest.artifacts, false);
    fsyncDirectory(targetParent, "restore-parent-before-rename");
    injectFault("restore-publication");
    inspectRestoreTarget(targetRoot);
    if (targetExisted) {
      rmdirSync(targetRoot);
      removedEmptyTarget = true;
    }
    renameSync(staging, targetRoot);
    staging = undefined;
    trace("restore-renamed");
    fsyncDirectory(targetParent, "restore-parent-after-rename");
    return { backupId: manifest.backupId, backupDigest: manifest.backupDigest, event };
  } catch (error) {
    if (removedEmptyTarget && !existsSync(targetRoot)) mkdirSync(targetRoot, { mode: 0o700 });
    throw error;
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true });
  }
}

async function deploymentDrill(dataRoot) {
  const drillRoot = mkdtempSync(path.join(os.tmpdir(), "fdbtrade-r011-drill-"));
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
