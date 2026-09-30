"""R1.12 bounded local upgrade and rollback safety behavior."""
import hashlib,json,pathlib,re,sqlite3,subprocess,tempfile,unittest
ROOT=pathlib.Path(__file__).resolve().parent.parent
CLI=ROOT/"scripts/operational-data.mjs"
def run(*args,timeout=240): return subprocess.run(args,cwd=ROOT,text=True,capture_output=True,timeout=timeout,check=False)
class R112UpgradeRollbackSafety(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(prefix="fdbtrade-r112-");self.root=pathlib.Path(self.temp.name);self.source=self.root/"source"
  result=run("node",str(CLI),"init-drill-fixture","--data-root",str(self.source));self.assertEqual(result.returncode,0,result.stdout+result.stderr)
 def tearDown(self): self.temp.cleanup()
 def test_preflight_upgrade_failure_isolation_restore_migrate_and_restart(self):
  result=run("node",str(CLI),"upgrade-preflight","--data-root",str(self.source));self.assertEqual(result.returncode,0,result.stdout+result.stderr)
  pre=json.loads(result.stdout.strip().splitlines()[-1]);self.assertEqual(pre["status"],"passed");self.assertEqual(pre["migrationCount"],12);self.assertGreaterEqual(pre["freeBytes"],pre["minimumFreeBytes"]);self.assertEqual(pre["manifestCompatibility"]["unknownOrFuture"],"rejected")
  drill=run("node",str(CLI),"upgrade-drill","--data-root",str(self.source));self.assertEqual(drill.returncode,0,drill.stdout+drill.stderr)
  body=json.loads(drill.stdout.strip().splitlines()[-1]);self.assertEqual(body["status"],"passed");self.assertEqual(body["failureIsolation"],"passed");self.assertEqual(body["restartReopen"],"passed");self.assertEqual(body["migrationResult"],{"applied":0,"skipped":12});self.assertFalse(body["externalNetworkUsed"]);self.assertEqual(body["rollbackPolicy"],"verified_restore_or_compensating_migration_never_reset")
  with sqlite3.connect(self.source/"fdbtrade.sqlite3") as db:
   self.assertEqual(db.execute("PRAGMA integrity_check").fetchone()[0],"ok");self.assertIn("backup_created",[r[0] for r in db.execute("SELECT event_type FROM operational_events")])
 def test_nonempty_target_and_future_manifest_are_rejected_without_overwrite(self):
  backups=self.root/"backups";backup=run("node",str(CLI),"backup","--data-root",str(self.source),"--output-root",str(backups));self.assertEqual(backup.returncode,0,backup.stdout+backup.stderr)
  directory=pathlib.Path(json.loads(backup.stdout.strip().splitlines()[-1])["backupDirectory"])
  target=self.root/"nonempty";target.mkdir();marker=target/"keep.txt";marker.write_text("preserve")
  rejected=run("node",str(CLI),"restore","--backup",str(directory),"--target-data-root",str(target));self.assertNotEqual(rejected.returncode,0);self.assertIn("restore target must be empty",rejected.stderr);self.assertEqual(marker.read_text(),"preserve")
  manifest=json.loads((directory/"manifest.json").read_text());manifest["schemaVersion"]=99;(directory/"manifest.json").write_text(json.dumps(manifest))
  future=run("node",str(CLI),"restore","--backup",str(directory),"--target-data-root",str(self.root/"future"));self.assertNotEqual(future.returncode,0);self.assertIn("unsupported backup manifest",future.stderr);self.assertFalse((self.root/"future").exists())
class R112AuthorityContracts(unittest.TestCase):
 def test_policy_progression_preservation_and_gate(self):
  source=(ROOT/"scripts/operational-data.mjs").read_text();self.assertIn("upgradePreflight",source);self.assertIn("upgradeDrill",source);self.assertIn("restore-publication",source);self.assertIn("verified_restore_or_compensating_migration_never_reset",source);self.assertNotIn("git reset",source.lower())
  nxt=(ROOT/"docs/rebuild/NEXT.md").read_text();self.assertIn("Current completed unit: **R1.16",nxt);self.assertIn("Next planned unit: **R1.17",nxt);self.assertIn("not authorized",nxt)
  migrations=[p for p in sorted((ROOT/"backend/db/sqlite-migrations").glob("*.sql")) if re.fullmatch(r"\d{4}_[a-z0-9_]+\.sql",p.name)];self.assertEqual(len(migrations),12)
  preservation=json.loads((ROOT/"artifacts/rebuild/r0.1/preservation.json").read_text())
  for item in preservation["quarantinedWork"]["files"]:
   data=(ROOT/item["path"]).read_bytes();self.assertEqual(len(data),item["bytes"]);self.assertEqual(hashlib.sha256(data).hexdigest(),item["sha256"])
  a=json.loads((ROOT/"artifacts/rebuild/r1.12/upgrade-and-rollback-safety.json").read_text());self.assertEqual(a["repository"]["baselineCommit"],"6257189ae0db6641ba7053f121e91a530b9cb3d4");self.assertEqual(a["finalGate"]["summary"],{"total":15,"pass":15,"fail":0,"timeout":0,"environmentBlocked":0,"skipped":0,"planned":0});self.assertTrue(all(v is False for v in a["safety"].values()))
if __name__=="__main__":unittest.main()
