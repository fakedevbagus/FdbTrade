"""R1.9 legacy production-surface retirement contracts."""
import hashlib, json, pathlib, re, unittest
ROOT=pathlib.Path(__file__).resolve().parent.parent
ROUTES=[ROOT/p for p in ("backend/src/app/api/dashboard/route.ts","backend/src/app/api/signals/scanner/route.ts","backend/src/app/api/signals/[id]/route.ts","backend/src/app/api/signals/[id]/chart/route.ts","backend/src/app/api/backtest/runs/route.ts","backend/src/app/api/backtest/runs/[runId]/route.ts")]
PAGES=[ROOT/p for p in ("frontend/src/app/(app)/dashboard/page.tsx","frontend/src/app/(app)/scanner/page.tsx","frontend/src/app/(app)/signals/[id]/page.tsx")]
AUTH=ROOT/"artifacts/rebuild/r1.9/legacy-surface-retirement.json"
class R19LegacySurfaceRetirementContracts(unittest.TestCase):
 def test_routes_are_terminal_and_not_legacy_wired(self):
  for p in ROUTES:
   t=p.read_text();self.assertIn("rejectRetiredSurface",t,p)
   for x in ("buildDashboardSnapshot","buildScannerView","buildSignalDetail","buildSignalChart","executeAndStoreRun","RUN_STORE_DIR"):self.assertNotIn(x,t,p)
  h=(ROOT/"backend/src/http/retiredSurface.ts").read_text();self.assertIn("requireSession(request)",h);self.assertIn("legacyResultsAvailable: false",h)
 def test_pages_are_truthful_retirement_notices(self):
  t="\n".join(p.read_text() for p in PAGES)
  for x in ("Legacy dashboard retired","Legacy scanner retired","Legacy signal detail retired","/signals/workbench"):self.assertIn(x,t)
  for x in ("fetchLatestDashboardSnapshot","fetchScannerView","fetchSignalDetail","fetchSignalChart","DashboardContent"):self.assertNotIn(x,t)
 def test_exact_public_scope(self):
  for rel in ("backend/src/app/api/historical/preview/route.ts","backend/src/app/api/historical/datasets/route.ts"):
   t=(ROOT/rel).read_text();self.assertIn("APPROVED_MARKET_INSTRUMENTS",t);self.assertIn("APPROVED_MARKET_TIMEFRAMES",t);self.assertNotIn('z.enum(["5m"',t)
 def test_progression_migrations_and_m48(self):
  nxt=(ROOT/"docs/rebuild/NEXT.md").read_text();self.assertIn("Current completed unit: **R1.14",nxt);self.assertIn("Next planned unit: **R1.15",nxt);self.assertIn("not authorized",nxt)
  migrations=[p for p in sorted((ROOT/"backend/db/sqlite-migrations").glob("*.sql")) if re.fullmatch(r"\d{4}_[a-z0-9_]+\.sql",p.name)];self.assertEqual(len(migrations),12)
  preservation=json.loads((ROOT/"artifacts/rebuild/r0.1/preservation.json").read_text())
  for item in preservation["quarantinedWork"]["files"]:
   data=(ROOT/item["path"]).read_bytes();self.assertEqual(len(data),item["bytes"]);self.assertEqual(hashlib.sha256(data).hexdigest(),item["sha256"])
 def test_authority_evidence(self):
  a=json.loads(AUTH.read_text());self.assertEqual(a["repository"]["baselineCommit"],"334276edf7c1b9dda13c4dc7cdca203adfc5e456");self.assertEqual(a["finalGate"]["summary"],{"total":15,"pass":15,"fail":0,"timeout":0,"environmentBlocked":0,"skipped":0,"planned":0});self.assertTrue(all(v is False for v in a["safety"].values()))
if __name__=="__main__":unittest.main()
