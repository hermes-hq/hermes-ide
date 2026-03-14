import { invoke } from "@tauri-apps/api/core";

export interface SshSavedHost {
  id: string;
  label: string;
  host: string;
  port: number;
  user: string;
  identity_file: string | null;
  jump_host: string | null;
  port_forwards: string;
  created_at: string;
  updated_at: string;
}

export function listSshSavedHosts(): Promise<SshSavedHost[]> {
  return invoke<SshSavedHost[]>("list_ssh_saved_hosts");
}

export function upsertSshSavedHost(host: SshSavedHost): Promise<void> {
  return invoke("upsert_ssh_saved_host", { host });
}

export function deleteSshSavedHost(id: string): Promise<void> {
  return invoke("delete_ssh_saved_host", { id });
}
