#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Windows spend caps start a copy of Hermes as a one-shot helper that
    // interrupts a session's console; it exits here, before the app starts.
    if let Some(code) = hermes_ide_lib::run_console_interrupt_helper() {
        std::process::exit(code);
    }
    hermes_ide_lib::run()
}
