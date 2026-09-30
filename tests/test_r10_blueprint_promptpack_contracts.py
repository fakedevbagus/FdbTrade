"""R1.0 blueprint, prompt-pack, safety and handoff contracts."""

from __future__ import annotations

import hashlib
import json
import pathlib
import re
import unittest


ROOT = pathlib.Path(__file__).resolve().parent.parent
PROMPT_PACK = ROOT / "docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md"
AUTHORITY = ROOT / "artifacts/rebuild/r1.0/blueprint-authority.json"
CHECKPOINT = ROOT / "docs/rebuild/checkpoints/R1.0_BLUEPRINT_AUTHORITY_AND_PROMPT_PACK.md"
ADR = ROOT / "docs/adr/ADR-0046-r1-roadmap-and-promptpack-governance.md"
NEXT = ROOT / "docs/rebuild/NEXT.md"
PRESERVATION = ROOT / "artifacts/rebuild/r0.1/preservation.json"


class R10BlueprintPromptPackContracts(unittest.TestCase):
    def test_authority_files_exist_and_point_to_one_canonical_prompt_pack(self):
        for path in (PROMPT_PACK, AUTHORITY, CHECKPOINT, ADR, NEXT):
            self.assertTrue(path.is_file(), path)
        authority = json.loads(AUTHORITY.read_text(encoding="utf-8"))
        self.assertEqual(authority["workUnit"], "R1.0")
        self.assertEqual(
            authority["authority"]["promptPack"],
            PROMPT_PACK.relative_to(ROOT).as_posix(),
        )
        self.assertFalse(authority["authority"]["standingImplementationAuthorization"])
        self.assertEqual(authority["authority"]["implementationUnitCount"], 24)

    def test_every_planned_unit_has_one_copy_ready_prompt_in_dependency_order(self):
        text = PROMPT_PACK.read_text(encoding="utf-8")
        prompt_units = re.findall(r"^### Prompt (R1\.\d+) - ", text, flags=re.MULTILINE)
        self.assertEqual(prompt_units, [f"R1.{number}" for number in range(1, 25)])
        for unit in prompt_units:
            self.assertIn(f"HANYA {unit}", text)
        self.assertEqual(
            text.count(
                "Repository: /media/fakedevbagus/WD BLUE/BACKUP LINUX/PROJECTS/FdbTrade"
            ),
            24,
        )
        self.assertIn("one bounded work unit per chat", text)
        self.assertIn("exactly one atomic commit", text)

    def test_product_and_safety_boundaries_are_explicit(self):
        text = PROMPT_PACK.read_text(encoding="utf-8")
        for marker in (
            "SQLite is the only mutable durable metadata authority",
            "EURUSD, GBPUSD, USDJPY, USDCHF, AUDUSD",
            "15m, 1h and 4h",
            "Live execution is OFF",
            "provider-order transport",
            "Paper execution always requires an explicit operator action",
            "ML is challenger-only",
            "M48 remains quarantined and non-authoritative",
            "SHA-256 is integrity evidence, not authenticity",
            "Remote access, LAN deployment, mobile clients",
        ):
            self.assertIn(marker, text)

    def test_decision_gates_do_not_preselect_external_sources(self):
        text = PROMPT_PACK.read_text(encoding="utf-8")
        self.assertIn("Provider Selection Dossier", text)
        self.assertIn("Macro Source Selection Dossier", text)
        self.assertIn("<NAMA_PROVIDER_YANG_SUDAH_DISETUJUI>", text)
        self.assertIn("Do not create credentials, call provider APIs", text)
        authority = json.loads(AUTHORITY.read_text(encoding="utf-8"))
        self.assertFalse(authority["safety"]["credentialedProviderSelected"])
        self.assertFalse(authority["safety"]["macroProviderSelected"])
        self.assertFalse(authority["safety"]["externalProviderNetworkCallsEnabled"])

    def test_next_names_one_unit_and_requires_separate_authorization(self):
        text = NEXT.read_text(encoding="utf-8")
        match = re.search(r"Next planned unit: \*\*(R1\.(\d+))", text)
        self.assertIsNotNone(match)
        unit = match.group(1)
        following = f"R1.{int(match.group(2)) + 1}"
        self.assertIn("Authorization state: **not authorized**", text)
        self.assertRegex(text, rf"Otorisasi (?:implementasi|audit) HANYA {re.escape(unit)}")
        self.assertIn(f"Do not infer {following}", text)

    def test_m48_preservation_bytes_still_match(self):
        manifest = json.loads(PRESERVATION.read_text(encoding="utf-8"))
        files = manifest["quarantinedWork"]["files"]
        self.assertEqual(len(files), 10)
        for item in files:
            path = ROOT / item["path"]
            data = path.read_bytes()
            self.assertEqual(len(data), item["bytes"], path)
            self.assertEqual(hashlib.sha256(data).hexdigest(), item["sha256"], path)


if __name__ == "__main__":
    unittest.main()
