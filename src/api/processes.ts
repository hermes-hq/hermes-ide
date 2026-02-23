import { invoke } from "@tauri-apps/api/core";
import type { ProcessInfo, ProcessSnapshot } from "../types/process";

export function listProcesses(): Promise<ProcessSnapshot> {
  return invoke<ProcessSnapshot>("list_processes");
}

export function killProcess(pid: number, signal: string): Promise<void> {
  return invoke("kill_process", { pid, signal });
}

export function killProcessTree(pid: number, signal: string): Promise<void> {
  return invoke("kill_process_tree", { pid, signal });
}

export function getProcessDetail(pid: number): Promise<ProcessInfo> {
  return invoke<ProcessInfo>("get_process_detail", { pid });
}

export function revealProcessInFinder(path: string): Promise<void> {
  return invoke("reveal_process_in_finder", { path });
}
