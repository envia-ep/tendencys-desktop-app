//! Helpers for spawning subprocesses from the GUI app.

use std::process::{Command, Output};

/// Like [`Command::output`], but never flashes a console window on Windows.
///
/// GUI apps (Tauri / Win32 subsystem) still show a terminal when spawning
/// `powershell`, `cmd`, `reg`, etc. unless `CREATE_NO_WINDOW` is set.
pub fn output_hidden(mut cmd: Command) -> std::io::Result<Output> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.output()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_hidden_runs_trivial_command() {
        #[cfg(target_os = "windows")]
        let cmd = {
            let mut c = Command::new("cmd");
            c.args(["/C", "echo ok"]);
            c
        };
        #[cfg(not(target_os = "windows"))]
        let cmd = Command::new("true");

        let out = output_hidden(cmd).expect("spawn");
        assert!(out.status.success());
    }
}
