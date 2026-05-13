import { AppConfig, MatterStatus } from "./types";

export type DaemonRequest =
  | { type: "ping" }
  | { type: "get-status" }
  | { type: "sync-config"; config: AppConfig }
  | { type: "list-targets" }
  | { type: "trigger-target"; targetId: string }
  | { type: "stop-target"; targetId: string }
  | { type: "reset" }
  | { type: "shutdown" };

export type DaemonResponse<T = unknown> = {
  ok: boolean;
  result?: T;
  error?: string;
};