"""R1.11 local web security hardening contracts."""
import hashlib,json,pathlib,re,unittest
ROOT=pathlib.Path(__file__).resolve().parent.parent
AUTH=ROOT/"artifacts/rebuild/r1.11/local-web-security-hardening.json"
class R111LocalWebSecurityContracts(unittest.TestCase):
 def test_single_local_security_authority(self):
  t=(ROOT/"backend/src/security/localWebSecurity.ts").read_text();h=(ROOT/"backend/src/http/handler.ts").read_text()
  for x in ("LOOPBACK_HOSTS","sec-fetch-site","origin","applyLocalSecurityHeaders","redactSensitive"):self.assertIn(x,t)
  for x in ("assertLocalMutationRequest(request)","applyLocalSecurityHeaders","redactSensitive(error.details)"):self.assertIn(x,h)
 def test_login_and_session_hardening(self):
  throttle=(ROOT/"backend/src/auth/loginThrottle.ts").read_text();store=(ROOT/"backend/src/auth/store.ts").read_text();provision=(ROOT/"backend/src/auth/provision.mjs").read_text()
  self.assertIn('createHash("sha256")',throttle);self.assertNotIn("password",throttle.lower())
  self.assertIn('DELETE FROM sessions WHERE user_id = ?',store);self.assertIn("withImmediateTransaction",store)
  self.assertIn('DELETE FROM sessions WHERE user_id = ?',provision)
 def test_loopback_permissions_and_no_scope_expansion(self):
  launcher=(ROOT/"scripts/fdbtrade").read_text();sqlite=(ROOT/"backend/src/db/sqlite.mjs").read_text()
  self.assertIn("127.0.0.1",launcher);self.assertIn("0o700",sqlite);self.assertIn("0o600",sqlite)
  combined="\n".join((ROOT/p).read_text() for p in ("backend/src/security/localWebSecurity.ts","backend/src/auth/loginThrottle.ts"))
  for x in ("OAuth","provider credential","fetch(","M48"):self.assertNotIn(x,combined)
 def test_progression_migrations_and_m48(self):
  nxt=(ROOT/"docs/rebuild/NEXT.md").read_text();self.assertIn("Current completed unit: **R1.15",nxt);self.assertIn("Next planned unit: **R1.16",nxt);self.assertIn("not authorized",nxt)
  migrations=[p for p in sorted((ROOT/"backend/db/sqlite-migrations").glob("*.sql")) if re.fullmatch(r"\d{4}_[a-z0-9_]+\.sql",p.name)];self.assertEqual(len(migrations),12)
  preservation=json.loads((ROOT/"artifacts/rebuild/r0.1/preservation.json").read_text())
  for item in preservation["quarantinedWork"]["files"]:
   data=(ROOT/item["path"]).read_bytes();self.assertEqual(len(data),item["bytes"]);self.assertEqual(hashlib.sha256(data).hexdigest(),item["sha256"])
 def test_authority_evidence(self):
  a=json.loads(AUTH.read_text());self.assertEqual(a["repository"]["baselineCommit"],"2fc328f605bd46c0bec6182520537c7eb8152f2c");self.assertEqual(a["finalGate"]["summary"],{"total":15,"pass":15,"fail":0,"timeout":0,"environmentBlocked":0,"skipped":0,"planned":0});self.assertTrue(all(v is False for v in a["safety"].values()))
if __name__=="__main__":unittest.main()
