"""移した通知分類の代替経路と秘密値保護を、外部通信なしで確認する。"""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("classifier", Path(__file__).resolve().parents[1] / "classify.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ClassifierTests(unittest.TestCase):
    def test_backend_selection_is_independent_of_agent_name(self):
        with patch.object(module, "read_key", return_value="synthetic-only"), \
                patch.object(module, "api_request") as api, \
                patch.object(module, "structured_cli", return_value={"state": "completed"}) as cli:
            result = module.classify("another-agent", "確認を完了しました。", {"classifierBackends": ["codex"]})
            self.assertEqual(result["classifier"], "codex")
            api.assert_not_called()
            self.assertEqual(cli.call_args.args[0], "codex")

    def test_jev_fallback_order_and_total_failure(self):
        for answers, expected in (
            ([{"state": "completed"}], "gemini"),
            ([RuntimeError(), {"state": "waiting"}], "codex"),
            ([RuntimeError(), RuntimeError()], "none"),
        ):
            with self.subTest(expected=expected), patch.object(module, "read_key", return_value="synthetic-only"), \
                    patch.object(module, "api_request", side_effect=TimeoutError()), \
                    patch.object(module, "structured_cli", side_effect=answers) as cli:
                result = module.classify("codex", "担当の結果を待ち、届いたら再開します。")
                self.assertEqual(result["classifier"], expected)
                self.assertEqual([call.args[0] for call in cli.call_args_list],
                                 ["gemini"] if expected == "gemini" else ["gemini", "codex"])

    def test_secrets_are_not_sent_to_any_provider(self):
        with patch.object(module, "read_key", return_value="synthetic-only"), \
                patch.object(module, "api_request") as api, patch.object(module, "structured_cli") as cli:
            result = module.classify("claude", "api_key=synthetic-private-value")
            self.assertEqual(result["classifier"], "skipped-secret")
            api.assert_not_called()
            cli.assert_not_called()

    def test_jev_success_needs_no_fallback(self):
        answer = {"answers": {"state": {"type": "choice", "choice": "needs_user", "confidence": 0.9,
                  "probabilities": {"completed": 0.0, "needs_user": 1.0, "waiting": 0.0}}}}
        with patch.object(module, "read_key", return_value="synthetic-only"), \
                patch.object(module, "api_request", return_value=answer), patch.object(module, "structured_cli") as cli:
            result = module.classify("claude", "どちらを選びますか。")
            self.assertEqual(result["state"], "needs_user")
            self.assertEqual(result["classifier"], "jev")
            cli.assert_not_called()


if __name__ == "__main__":
    unittest.main()
