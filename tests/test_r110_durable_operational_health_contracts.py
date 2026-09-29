"""R1.10 durable operational health contracts."""
import hashlib,json,pathlib,re,unittest
ROOT=pathlib.Path(__file__).resolve().parent.parent
PROJ=ROOT/"backend/src/obs/durableHealthProjection.ts";SERVICE=ROOT/"backend/src/obs/healthService.ts";TEST=ROOT/"backend/src/obs/__tests__/healthService.test.ts";PAGE=ROOT/"frontend/src/app/(app)/admin/health/page.tsx";AUTH=ROOT/"artifacts/rebuild/r1.10/durable-operational-health.json"
class R110DurableOperationalHealthContracts(unittest.TestCase):
 def test_projection_reads_durable_evidence_only(self):
  t=PROJ.read_text()
  for x in ("market_data_datasets","market_data_ingestion_jobs","signal_evaluation_runs","research_backtest_runs","risk_paper_runs","operational_events","audit_events","market_data_artifacts","statfsSync","sha256"):self.assertIn(x,t)
  for x in ("INSERT INTO","UPDATE ","DELETE FROM"):self.assertNotIn(x,t)
 def test_unknown_corrupt_backlog_and_restart_covered(self):
  t=TEST.read_text()
  for x in ("absent data","queue backlog","corrupt artifact","low disk budget","file-backed database"):self.assertIn(x,t)
 def test_ui_propagates_durable_metrics(self):
  t=PAGE.read_text();self.assertIn("Durable SQLite",t);self.assertIn("artifact verification",t);self.assertIn("disk budget",t);self.assertIn("durable failures/audit",t)
 def test_progression_preservation_and_gate(self):
  nxt=(ROOT/"docs/rebuild/NEXT.md").read_text();self.assertIn("Current completed unit: **R1.11",nxt);self.assertIn("Next planned unit: **R1.12",nxt);self.assertIn("not authorized",nxt)
  migrations=[p for p in sorted((ROOT/"backend/db/sqlite-migrations").glob("*.sql")) if re.fullmatch(r"\d{4}_[a-z0-9_]+\.sql",p.name)];self.assertEqual(len(migrations),12)
  p=json.loads((ROOT/"artifacts/rebuild/r0.1/preservation.json").read_text())
  for x in p["quarantinedWork"]["files"]:
   d=(ROOT/x["path"]).read_bytes();self.assertEqual(len(d),x["bytes"]);self.assertEqual(hashlib.sha256(d).hexdigest(),x["sha256"])
  a=json.loads(AUTH.read_text());self.assertEqual(a["repository"]["baselineCommit"],"99746bb2244a389a3ec69abc43549e2fb564759e");self.assertEqual(a["finalGate"]["summary"],{"total":15,"pass":15,"fail":0,"timeout":0,"environmentBlocked":0,"skipped":0,"planned":0});self.assertTrue(all(v is False for v in a["safety"].values()))
if __name__=="__main__":unittest.main()
