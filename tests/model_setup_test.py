"""Download setup tests use only the standard library; no weights or GPU needed."""
import contextlib
import importlib.util
import io
import os
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("floatfall_muscriptor", Path(__file__).resolve().parents[1] / "models" / "muscriptor_transcribe.py")
wrapper = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = wrapper
spec.loader.exec_module(wrapper)


class ModelSetupTests(unittest.TestCase):
    def hub(self):
        hub = types.ModuleType("huggingface_hub")
        hub.hf_hub_download = Mock()
        hub.login = Mock()
        errors = types.ModuleType("huggingface_hub.errors")
        errors.GatedRepoError = type("GatedRepoError", (Exception,), {})
        errors.HfHubHTTPError = type("HfHubHTTPError", (Exception,), {})
        return hub, errors

    def test_download_only_needs_no_audio_or_torch_and_reuses_the_inference_cache(self):
        hub, errors = self.hub()
        with patch.dict(sys.modules, {"huggingface_hub": hub, "huggingface_hub.errors": errors, "torch": None}), patch.dict(os.environ, {"FLOATFALL_HF_TOKEN": ""}), contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(wrapper.main(["--download-only", "--model", "small"]), 0)
        self.assertEqual(hub.hf_hub_download.call_args_list[0].kwargs, {"repo_id": "MuScriptor/muscriptor-small", "filename": "config.json", "token": ""})
        self.assertEqual(hub.hf_hub_download.call_args_list[1].kwargs["filename"], "model.safetensors")
        hub.login.assert_not_called()

    def test_explicit_token_uses_hugging_face_credentials_and_is_not_logged(self):
        hub, errors = self.hub()
        output = io.StringIO()
        with patch.dict(sys.modules, {"huggingface_hub": hub, "huggingface_hub.errors": errors}), patch.dict(os.environ, {"FLOATFALL_HF_TOKEN": "hf_private_test"}), contextlib.redirect_stderr(output), contextlib.redirect_stdout(output):
            self.assertEqual(wrapper.main(["--download-only", "--model", "medium"]), 0)
        hub.login.assert_called_once_with(token="hf_private_test", add_to_git_credential=False)
        self.assertNotIn("hf_private_test", output.getvalue())

    def test_gated_repo_reports_the_selected_license_page(self):
        hub, errors = self.hub()
        hub.hf_hub_download.side_effect = errors.GatedRepoError("access denied")
        output = io.StringIO()
        with patch.dict(sys.modules, {"huggingface_hub": hub, "huggingface_hub.errors": errors}), patch.dict(os.environ, {"FLOATFALL_HF_TOKEN": ""}), contextlib.redirect_stderr(output):
            self.assertEqual(wrapper.main(["--download-only", "--model", "medium"]), wrapper.EXIT_AUTH)
        self.assertIn("[auth-required]", output.getvalue())
        self.assertIn("https://huggingface.co/MuScriptor/muscriptor-medium", output.getvalue())

    def test_transcription_still_requires_input_and_output(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
            wrapper.parse_args([])
        self.assertEqual(error.exception.code, wrapper.EXIT_USAGE)


if __name__ == "__main__":
    unittest.main()
