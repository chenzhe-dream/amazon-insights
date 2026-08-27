from pathlib import Path
import shutil
import subprocess


def main(run=subprocess.run, which=shutil.which):
    root = Path(__file__).resolve().parents[1]
    manager = root / "scripts" / "manage-formal-stack.ps1"
    powershell = which("pwsh") or which("powershell")
    if not powershell:
        print("未找到 PowerShell，无法启动正式系统。")
        return 1

    result = run(
        [
            powershell,
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(manager),
        ],
        cwd=root,
        check=False,
    )
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
