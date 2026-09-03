import importlib.util
import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "launcher" / "main.py"


class LauncherMainTest(unittest.TestCase):
    def test_main_invokes_the_existing_formal_stack_manager(self):
        spec = importlib.util.spec_from_file_location("formal_launcher", MODULE_PATH)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        calls = []

        class Result:
            returncode = 0

        def run(command, **options):
            calls.append((command, options))
            return Result()

        which = lambda name: "C:/PowerShell/pwsh.exe" if name == "pwsh" else None
        self.assertEqual(module.main(run=run, which=which), 0)
        self.assertEqual(len(calls), 1)
        command, options = calls[0]
        self.assertEqual(command[:4], ["C:/PowerShell/pwsh.exe", "-NoProfile", "-ExecutionPolicy", "Bypass"])
        self.assertEqual(command[4], "-File")
        self.assertEqual(pathlib.Path(command[5]), ROOT / "scripts" / "manage-formal-stack.ps1")
        self.assertEqual(pathlib.Path(options["cwd"]), ROOT)
        self.assertFalse(options["check"])

    def test_main_falls_back_to_windows_powershell(self):
        spec = importlib.util.spec_from_file_location("formal_launcher_fallback", MODULE_PATH)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        calls = []

        class Result:
            returncode = 0

        def run(command, **options):
            calls.append((command, options))
            return Result()

        which = lambda name: "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe" if name == "powershell" else None
        self.assertEqual(module.main(run=run, which=which), 0)
        self.assertEqual(calls[0][0][0], "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe")


if __name__ == "__main__":
    unittest.main()
