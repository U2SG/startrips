"""Regression tests for bounded handoff transport."""
import sys
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "lib"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import test_control_plane as fixture
import action_plan as plan
import evidence_capture as capture
import delivery_issues as issues


class HandoffTransportCases(fixture.SyntheticOne):
    def setUp(self):
        super().setUp()
        self.write(fixture.feature(status="in_progress", phase="P1-globe",
                                   pr_links=["https://github.com/synthetic/project/pull/1"]),
                   fixture.feature("ST-002"))

    def snapshot(self):
        doc = fixture.store.load_document(self.path)
        return {
            "feature": "ST-001",
            "row_token": plan.unit_token(doc, "ST-001"),
            "action": "HANDOFF_REVIEW",
            "pr": 1,
            "source_sha": fixture.A,
            "final_sha": fixture.B,
            "pr_head_ref": "feature",
            "sealed": True,
            "source_review_clear": True,
            "source_review_verdict": "CLEAR",
            "ci_state": "success",
            "source_green": True,
            "final_green": True,
            "ci_run": 101,
            "ci_attempt": 1,
            "ci_url": "https://example.invalid/run/101",
            "ci_jobs": [{"id": 7, "name": "control-plane", "status": "completed",
                         "conclusion": "success"}],
            "review": {"head_sha": fixture.B, "unresolved": 0, "changes_requested": 0},
        }

    def test_snapshot_capture_performs_no_github_reread(self):
        snapshot = self.snapshot()
        worktree = self.root / "worktree"
        worktree.mkdir()

        def fake_git(path, *args):
            if args == ("rev-parse", "HEAD"):
                return fixture.B
            if args == ("branch", "--show-current"):
                return "feature"
            if args == ("status", "--porcelain"):
                return ""
            raise AssertionError(args)

        with mock.patch.object(capture, "git", side_effect=fake_git),              mock.patch.object(capture, "api", side_effect=AssertionError("GitHub reread")),              mock.patch.object(capture, "source_relation", side_effect=AssertionError("Source reread")),              mock.patch.object(capture, "latest_ci", side_effect=AssertionError("CI reread")):
            result = capture.capture(self.root, worktree, "ST-001", 1, "synthetic/project",
                                     snapshot=snapshot)

        self.assertEqual((0, "final", fixture.B, fixture.A),
                         (result["exit"], result["kind"], result["head"], result["source_sha"]))

    def test_delivery_issue_updated_at_only_does_not_invalidate_content(self):
        stored = {"issue": 333, "body_sha256": "same", "comments": {},
                  "updated_at": "2026-09-20T00:00:00Z", "comment_count": 0}
        observed = {"ST-108": {**stored, "updated_at": "2026-10-01T00:00:00Z"}}
        with mock.patch.object(issues, "rows",
                               return_value={"ST-108": {"delivery_issue_observation": stored}}),              mock.patch.object(issues, "members", return_value=["ST-108"]):
            issues.assert_current({}, "ST-108", observed)

    def test_delivery_issue_content_change_still_fails_closed(self):
        stored = {"issue": 333, "body_sha256": "old", "comments": {},
                  "updated_at": "2026-09-20T00:00:00Z", "comment_count": 0}
        observed = {"ST-108": {**stored, "body_sha256": "new",
                                "updated_at": "2026-10-01T00:00:00Z"}}
        with mock.patch.object(issues, "rows",
                               return_value={"ST-108": {"delivery_issue_observation": stored}}),              mock.patch.object(issues, "members", return_value=["ST-108"]):
            with self.assertRaises(issues.EvidenceUnknown):
                issues.assert_current({}, "ST-108", observed)

    def test_handoff_plans_once_and_passes_snapshot_to_capture(self):
        observed = self.snapshot()
        captured = {"path": ".agent-artifacts/st-001/final.log", "exit": 0,
                    "kind": "final", "head": fixture.B, "source_sha": fixture.A,
                    "ci_run": 101, "ci_attempt": 1}
        with mock.patch.object(plan, "plan", return_value=observed) as planner,              mock.patch.object(plan, "feature_lane", return_value="experience"),              mock.patch("runtime_preflight.preflight",
                        return_value={"worktree": str(self.root / "worktree")}),              mock.patch("evidence_capture.capture", return_value=captured) as capture_call,              mock.patch.object(plan, "confirm_handoff_identity", return_value=True):
            result = plan.handoff(self.path, "ST-001", "synthetic/project")

        self.assertEqual(1, planner.call_count)
        self.assertIs(capture_call.call_args.kwargs["snapshot"], observed)
        self.assertEqual("HANDOFF_REVIEW", result["action"])
        self.assertEqual("ready_for_eval",
                         fixture.store.load_document(self.path)["features"][0]["status"])


if __name__ == "__main__":
    import unittest
    unittest.main()
